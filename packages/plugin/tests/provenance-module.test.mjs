/**
 * provenance-module.test.mjs — the obsidian-provenance CLI folded into vault-mcp.
 * What this proves:
 *
 *   1. the PURE core (kernel/provenance/*, Obsidian-free over an injected
 *      ProvenanceSource) reproduces the Python CLI's behavior — freshness
 *      (fresh vs stale), reconcile (installed/enabled/noted/unnoted/stale
 *      version), regen (dry-run text + human-section preservation);
 *   2. the write guard: `provenance_regen --write` runs the shared
 *      accept-forbidden transition guard, so a rendered audit that would
 *      introduce/change an accepted-family field is REFUSED and nothing is
 *      written, while an existing (human-granted) accepted value is preserved;
 *   3. the three tools register through the module host — regen mutating
 *      (readOnlyHint:false), check/reconcile read-only — and the module
 *      contributes NO accept/approve tool.
 *
 * Headless: tools-provenance.ts imports nothing from `obsidian`; the vault
 * arrives as a fake ProvenanceBackend and the accept guard runs over plain text.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  checkFreshness,
  reconcile,
  regenerateAudit,
  auditPath,
  resolveSource,
  resolveEntries,
  extractSections,
  reinsertSections,
  auditDerivedFrom,
  notesGlob,
  DEFAULT_NOTES_DIR,
  DEFAULT_NOTES_SOURCE,
  DEFAULT_AUDIT_NOTE,
  provenanceConfigOf,
  validateProvenanceConfig,
  globMatchesPath,
  renderAudit,
  globSegmentRe,
} from "../src/kernel/provenance/index.ts";
import {
  registerProvenanceTools,
  guardProvenanceWrite,
} from "../src/mcp/tools-provenance.ts";
import { mountModules, builtinModules } from "../src/mcp/modules-mount.ts";

// The pre-#257 shipped default. `jd-slots` is now the default layout, so every
// pre-existing case below states `"flat"` EXPLICITLY: this is the same flat
// coverage as before, re-anchored to the mode it was always testing, not
// coverage traded away for the new one.
const FLAT_DIR = "08.10 Obsidian plugins";
const FLAT = "flat";
import { collect, forbiddenToolName } from "../src/kernel/modules/index.ts";
import { AcceptForbiddenError } from "@vault-mcp/core";

const PROVENANCE_TOOLS = ["provenance_check", "provenance_reconcile", "provenance_regen"];
const READ_TOOLS = ["provenance_check", "provenance_reconcile"];
const WRITE_TOOLS = ["provenance_regen"];

/** An in-memory ProvenanceBackend. `notes` → parsed frontmatter, `files` → raw
 * text (JSON manifests / community-plugins / the audit note), `stats` → file
 * kind + mtime, `globs` → pattern → paths. Records writes on `_written` and
 * folds each write's text back into `files`. */
function fakeBackend({ notes = {}, files = {}, stats = {}, globs = {} } = {}) {
  const written = [];
  return {
    _written: written,
    noteFrontmatter: (p) => notes[p] ?? null,
    read: async (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
    stat: async (p) => stats[p] ?? null,
    glob: async (pat) => globs[pat] ?? [],
    writeNote: async (p, t) => {
      written.push({ path: p, text: t });
      files[p] = t;
    },
  };
}

// ── 1a. freshness ────────────────────────────────────────────────────────────

describe("checkFreshness: fresh vs stale (port of test_freshness.py)", () => {
  const GEN_2020 = "2020-01-01T00:00:00";
  const GEN_2035 = "2035-01-01T00:00:00";
  const MS_2030 = Date.parse("2030-01-01T00:00:00Z");
  const MS_2001 = Date.parse("2001-01-01T00:00:00Z");

  test("STALE when a source is newer than `generated`", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["src.md"], generated: GEN_2020 } },
      stats: { "src.md": { type: "file", mtime: MS_2030 } },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, false);
    assert.deepEqual(v.changed, ["src.md"]);
    assert.deepEqual(v.sources, ["src.md"]);
  });

  test("FRESH when `generated` is after every source", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["src.md"], generated: GEN_2035 } },
      stats: { "src.md": { type: "file", mtime: MS_2001 } },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, true);
    assert.deepEqual(v.changed, []);
  });

  test("a note with no derived-from is an error", async () => {
    const src = fakeBackend({ notes: { "x.md": { generated: GEN_2020 } } });
    await assert.rejects(() => checkFreshness(src, "x.md"), /no derived-from/);
  });

  test("a lone-string derived-from and a Date-typed generated both parse", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": "src.md", generated: new Date(Date.parse("2035-01-01T00:00:00Z")) } },
      stats: { "src.md": { type: "file", mtime: MS_2001 } },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, true);
  });

  test("REGRESSION: an untouched note still reads FRESH — the new rules add no false positive", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["a.md", "b.md"], generated: GEN_2035 } },
      stats: { "a.md": { type: "file", mtime: MS_2001 }, "b.md": { type: "file", mtime: MS_2001 } },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, true);
    assert.deepEqual(v.changed, []);
    assert.deepEqual(v.missing, []);
    assert.equal(v.sourcesRemoved, undefined);
  });

  test("REGRESSION: the pre-existing fields keep their names and meaning", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["a.md", "b.md"], generated: GEN_2020 } },
      stats: { "a.md": { type: "file", mtime: MS_2030 }, "b.md": { type: "file", mtime: MS_2001 } },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, false);
    assert.deepEqual(v.changed, ["a.md"]);
    assert.deepEqual(v.sources, ["a.md", "b.md"]);
    assert.equal(v.generatedMs, Date.parse(GEN_2020));
    // …and the note has no glob entry, so nothing is undetectable about it.
    assert.equal(v.globDeletionsUndetectable, false);
    assert.deepEqual(v.missing, []);
  });
});

// ── 1a′. the deleted-source blind spot: tier 1 (plain paths) + tier 2 (witness)

describe("checkFreshness: deleted sources (tier 1 — missing plain-path entries)", () => {
  const GEN_2035 = "2035-01-01T00:00:00";
  const MS_2001 = Date.parse("2001-01-01T00:00:00Z");
  const MS_2040 = Date.parse("2040-01-01T00:00:00Z");

  test("a NON-GLOB entry resolving to nothing is STALE and NAMED in `missing`", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["kept.md", "gone.md"], generated: GEN_2035 } },
      stats: { "kept.md": { type: "file", mtime: MS_2001 } }, // gone.md absent
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, false, "a deleted plain-path source must not read FRESH");
    assert.deepEqual(v.missing, ["gone.md"]);
    assert.deepEqual(v.changed, [], "nothing was modified — only removed");
    assert.deepEqual(v.sources, ["kept.md"]);
  });

  test("a plain entry pointing at a FOLDER counts as missing (it names no file)", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["dir"], generated: GEN_2035 } },
      stats: { dir: { type: "folder", mtime: MS_2001 } },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, false);
    assert.deepEqual(v.missing, ["dir"]);
  });

  test("an EMPTY GLOB is NOT reported as missing (an empty source set can be legitimate)", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["src/*.md"], generated: GEN_2035 } },
      globs: { "src/*.md": [] },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.deepEqual(v.missing, [], "a glob matching nothing is not a missing entry");
    assert.equal(v.fresh, true, "…and is not staleness by itself, with no witness to say otherwise");
    assert.equal(v.globDeletionsUndetectable, true, "but the caller must be told it could not be checked");
  });

  test("an intact source set is FRESH with no false positive", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["one.md", "src/*.md"], generated: GEN_2035 } },
      stats: {
        "one.md": { type: "file", mtime: MS_2001 },
        "src/a.md": { type: "file", mtime: MS_2001 },
        "src/b.md": { type: "file", mtime: MS_2001 },
      },
      globs: { "src/*.md": ["src/a.md", "src/b.md"] },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, true);
    assert.deepEqual(v.changed, []);
    assert.deepEqual(v.missing, []);
    assert.equal(v.sourcesRemoved, undefined);
  });

  test("a modified source still trips the mtime rule beside the new fields", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["src/*.md"], generated: GEN_2035 } },
      stats: { "src/a.md": { type: "file", mtime: MS_2040 } },
      globs: { "src/*.md": ["src/a.md"] },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, false);
    assert.deepEqual(v.changed, ["src/a.md"]);
    assert.deepEqual(v.missing, []);
  });
});

describe("checkFreshness: deleted sources (tier 2 — the derived-source-count witness)", () => {
  const GEN_2035 = "2035-01-01T00:00:00";
  const MS_2001 = Date.parse("2001-01-01T00:00:00Z");
  const MS_2040 = Date.parse("2040-01-01T00:00:00Z");

  /** A glob-sourced derived note over `files`, optionally stamping the witness. */
  function globNote(files, witness, mtime = MS_2001) {
    const fm = { "derived-from": ["src/*.md"], generated: GEN_2035 };
    if (witness !== undefined) fm["derived-source-count"] = witness;
    return fakeBackend({
      notes: { "audit.md": fm },
      globs: { "src/*.md": files },
      stats: Object.fromEntries(files.map((f) => [f, { type: "file", mtime }])),
    });
  }

  test("witness says 3, only 2 resolve now ⇒ STALE with the count reason", async () => {
    const v = await checkFreshness(globNote(["src/a.md", "src/b.md"], 3), "audit.md");
    assert.equal(v.fresh, false, "a glob that lost a file must not read FRESH");
    assert.deepEqual(v.sourcesRemoved, { expected: 3, actual: 2 });
    assert.deepEqual(v.changed, [], "the reason is removal, not modification");
    assert.deepEqual(v.missing, [], "globs never populate `missing`");
    assert.equal(v.expectedSourceCount, 3);
    assert.equal(v.globDeletionsUndetectable, false, "with a witness, the class WAS checked");
  });

  test("witness matches the current count ⇒ FRESH, and the check is reported as done", async () => {
    const v = await checkFreshness(globNote(["src/a.md", "src/b.md"], 2), "audit.md");
    assert.equal(v.fresh, true);
    assert.equal(v.sourcesRemoved, undefined);
    assert.equal(v.globDeletionsUndetectable, false);
  });

  test("MORE files than the witness is NOT stale by count alone", async () => {
    const v = await checkFreshness(globNote(["src/a.md", "src/b.md", "src/c.md"], 2), "audit.md");
    assert.equal(v.sourcesRemoved, undefined, "a grown source set is not a removal");
    assert.equal(v.fresh, true, "…and every file predates `generated`, so nothing is stale");
  });

  test("MORE files whose mtime is fresh IS stale — by mtime, the rule that already covered additions", async () => {
    const v = await checkFreshness(globNote(["src/a.md", "src/b.md", "src/c.md"], 2, MS_2040), "audit.md");
    assert.equal(v.fresh, false);
    assert.equal(v.sourcesRemoved, undefined);
    assert.equal(v.changed.length, 3);
  });

  test("NO witness ⇒ exactly the pre-witness behavior, plus the undetectable flag", async () => {
    const v = await checkFreshness(globNote(["src/a.md", "src/b.md"], undefined), "audit.md");
    assert.equal(v.fresh, true, "a glob that silently lost files still reads FRESH without a witness");
    assert.equal(v.sourcesRemoved, undefined);
    assert.equal(v.expectedSourceCount, undefined);
    assert.equal(v.globDeletionsUndetectable, true, "…but the caller can tell it was not checked");
  });

  test("a witness stamped as a numeric STRING is honored; a malformed one degrades to absent", async () => {
    const asString = await checkFreshness(globNote(["src/a.md"], "3"), "audit.md");
    assert.deepEqual(asString.sourcesRemoved, { expected: 3, actual: 1 });

    for (const bad of ["many", -1, 2.5, true, null]) {
      const v = await checkFreshness(globNote(["src/a.md"], bad), "audit.md");
      assert.equal(v.expectedSourceCount, undefined, `witness ${JSON.stringify(bad)} must not be trusted`);
      assert.equal(v.sourcesRemoved, undefined);
      assert.equal(v.globDeletionsUndetectable, true, "an unusable witness is no witness");
    }
  });

  test("the witness also covers plain paths — and a deletion is reported by BOTH tiers", async () => {
    const src = fakeBackend({
      notes: { "audit.md": { "derived-from": ["a.md", "b.md"], generated: GEN_2035, "derived-source-count": 2 } },
      stats: { "a.md": { type: "file", mtime: MS_2001 } },
    });
    const v = await checkFreshness(src, "audit.md");
    assert.equal(v.fresh, false);
    assert.deepEqual(v.missing, ["b.md"]);
    assert.deepEqual(v.sourcesRemoved, { expected: 2, actual: 1 });
    assert.equal(v.globDeletionsUndetectable, false, "no glob entry ⇒ nothing undetectable");
  });
});

// ── 1b. sources: glob vs literal (port of test_sources.py) ──────────────────

describe("resolveSource: glob defers to source.glob; literal keeps only a file", () => {
  test("a glob entry resolves through source.glob", async () => {
    const src = fakeBackend({ globs: { "*.md": ["a.md", "b.md"] } });
    assert.deepEqual(await resolveSource(src, "*.md"), ["a.md", "b.md"]);
  });

  test("a literal file resolves to itself", async () => {
    const src = fakeBackend({ stats: { "note.md": { type: "file", mtime: 1 } } });
    assert.deepEqual(await resolveSource(src, "note.md"), ["note.md"]);
  });

  test("a literal FOLDER (or absent path) resolves to nothing", async () => {
    const src = fakeBackend({ stats: { dir: { type: "folder", mtime: 1 } } });
    assert.deepEqual(await resolveSource(src, "dir"), []);
    assert.deepEqual(await resolveSource(src, "gone.md"), []);
  });

  test("resolveEntries separates unresolved PLAIN entries from empty globs", async () => {
    const src = fakeBackend({
      stats: { "note.md": { type: "file", mtime: 1 } },
      globs: { "empty/*.md": [], "src/*.md": ["src/a.md"] },
    });
    const r = await resolveEntries(src, ["note.md", "gone.md", "empty/*.md", "src/*.md"]);
    assert.deepEqual(r.files, ["note.md", "src/a.md"]);
    assert.deepEqual(r.missing, ["gone.md"], "only the plain path counts as missing");
    assert.equal(r.hasGlob, true);
  });

  test("resolveEntries KEEPS duplicates when two entries name the same file", async () => {
    // Load-bearing: the witness counts the length of THIS list, so de-duplicating
    // here would silently under-count overlapping entries and read stale forever.
    const src = fakeBackend({
      stats: { "a.md": { type: "file", mtime: 1 } },
      globs: { "*.md": ["a.md"] },
    });
    const r = await resolveEntries(src, ["a.md", "*.md"]);
    assert.deepEqual(r.files, ["a.md", "a.md"]);
  });

  test("resolveEntries over plain paths only reports hasGlob false", async () => {
    const src = fakeBackend({ stats: { "note.md": { type: "file", mtime: 1 } } });
    const r = await resolveEntries(src, ["note.md"]);
    assert.equal(r.hasGlob, false);
    assert.deepEqual(r.missing, []);
  });
});

// ── 1c. reconcile (port of test_plugins.py) ─────────────────────────────────

describe("reconcile: installed / enabled / noted / unnoted / stale version", () => {
  function vault() {
    return fakeBackend({
      globs: {
        ".obsidian/plugins/*/manifest.json": [
          ".obsidian/plugins/aaa/manifest.json",
          ".obsidian/plugins/bbb/manifest.json",
        ],
        "08.10 Obsidian plugins/*.md": ["08.10 Obsidian plugins/AAA (Obsidian plugin).md"],
      },
      files: {
        ".obsidian/plugins/aaa/manifest.json": JSON.stringify({ id: "aaa", name: "aaa", version: "1.0.0" }),
        ".obsidian/plugins/bbb/manifest.json": JSON.stringify({ id: "bbb", name: "bbb", version: "2.0.0" }),
        ".obsidian/community-plugins.json": JSON.stringify(["aaa"]),
      },
      notes: {
        "08.10 Obsidian plugins/AAA (Obsidian plugin).md": { plugin: { id: "aaa", version: "0.9.0" } },
      },
    });
  }

  test("finds unnoted and stale (aaa noted at 0.9.0, installed 1.0.0; bbb unnoted)", async () => {
    const r = await reconcile(vault(), FLAT_DIR, FLAT);
    assert.deepEqual(Object.keys(r.installed).sort(), ["aaa", "bbb"]);
    assert.deepEqual(r.enabled, ["aaa"]);
    assert.deepEqual(Object.keys(r.noted), ["aaa"]);
    assert.deepEqual(r.unnoted, ["bbb"]);
    assert.deepEqual(r.staleVersion, [["aaa", "0.9.0", "1.0.0"]]);
  });

  test("no community-plugins.json ⇒ enabled empty; a malformed manifest is skipped", async () => {
    const src = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/x/manifest.json", ".obsidian/plugins/bad/manifest.json"] },
      files: {
        ".obsidian/plugins/x/manifest.json": JSON.stringify({ id: "x", version: "1.0.0" }),
        ".obsidian/plugins/bad/manifest.json": "{ not json",
      },
    });
    const r = await reconcile(src, FLAT_DIR, FLAT);
    assert.deepEqual(r.enabled, []);
    assert.deepEqual(Object.keys(r.installed), ["x"]);
  });
});

// ── 1d. render / regen (port of test_render.py + test_regen.py) ─────────────

describe("render: extract + reinsert human sections roundtrip", () => {
  test("a hand-written section is extracted and re-inserted", () => {
    const old = "## Notes\n<!-- human:start notes -->\nmy hand-written note\n<!-- human:end -->\n";
    const preserved = extractSections(old);
    assert.equal(preserved.notes.trim(), "my hand-written note");
    const fresh = "## Notes\n<!-- human:start notes -->\n<!-- human:end -->\n";
    assert.match(reinsertSections(fresh, preserved), /my hand-written note/);
  });
});

describe("regenerateAudit: reports unnoted and preserves the human section", () => {
  test("aaa surfaces as unnoted, KEEP THIS is preserved, derivation-mode stamped", async () => {
    const ap = auditPath(FLAT_DIR);
    const src = fakeBackend({
      globs: {
        ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/aaa/manifest.json"],
        "08.10 Obsidian plugins/*.md": [],
      },
      files: {
        ".obsidian/plugins/aaa/manifest.json": JSON.stringify({ id: "aaa", name: "AAA", version: "1.0.0" }),
        ".obsidian/community-plugins.json": JSON.stringify(["aaa"]),
        [ap]:
          "---\nderived-from: []\ngenerated: 2020-01-01T00:00:00\n---\n" +
          "<!-- human:start notes -->\nKEEP THIS\n<!-- human:end -->\n",
      },
    });
    const out = await regenerateAudit(src, "2036-01-01T00:00:00", FLAT_DIR, FLAT, auditPath(FLAT_DIR));
    assert.match(out, /aaa/); // unnoted plugin surfaced
    assert.match(out, /KEEP THIS/); // human section preserved
    assert.match(out, /derivation-mode: snapshot/);
    assert.match(out, /generator: obsidian-plugin-audit/);
  });

  test("the regenerated audit STAMPS the derived-source-count witness over its own sources", async () => {
    // 2 plugin notes (one of them the audit itself) + 1 manifest +
    // community-plugins.json = 4 resolved sources.
    const src = fakeBackend({
      globs: {
        ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/aaa/manifest.json"],
        "08.10 Obsidian plugins/*.md": ["08.10 Obsidian plugins/A.md", auditPath(FLAT_DIR)],
      },
      // `.obsidian/community-plugins.json` is a plain path — resolved via stat.
      stats: { ".obsidian/community-plugins.json": { type: "file", mtime: 1 } },
      files: {
        ".obsidian/plugins/aaa/manifest.json": JSON.stringify({ id: "aaa", version: "1.0.0" }),
        ".obsidian/community-plugins.json": JSON.stringify(["aaa"]),
      },
    });
    const out = await regenerateAudit(src, "2036-01-01T00:00:00", FLAT_DIR, FLAT, auditPath(FLAT_DIR));
    assert.match(out, /^derived-source-count: 4$/m);
    // The stamped list and the counted list are the SAME definition.
    assert.deepEqual(auditDerivedFrom(FLAT_DIR, FLAT), [
      "08.10 Obsidian plugins/*.md",
      ".obsidian/plugins/*/manifest.json",
      ".obsidian/community-plugins.json",
    ]);
    for (const entry of auditDerivedFrom(FLAT_DIR, FLAT)) assert.ok(out.includes(`  - "${entry}"`), `missing entry ${entry}`);
  });

  test("a FIRST regen (the audit note does not exist yet) counts itself in — it is inside its own glob", async () => {
    const src = fakeBackend({
      globs: {
        ".obsidian/plugins/*/manifest.json": [],
        "08.10 Obsidian plugins/*.md": ["08.10 Obsidian plugins/A.md"], // no audit note yet
      },
      stats: { ".obsidian/community-plugins.json": { type: "file", mtime: 1 } },
      files: { ".obsidian/community-plugins.json": JSON.stringify([]) },
    });
    // Resolves to 2 files now; 3 the instant the write lands. Witness the LATER
    // number, or the first deletion after a first-ever regen would be masked.
    assert.match(await regenerateAudit(src, "2036-01-01T00:00:00", FLAT_DIR, FLAT, auditPath(FLAT_DIR)), /^derived-source-count: 3$/m);
  });

  test("a regenerated audit SELF-CHECKS: it reads FRESH, and STALE once a source is deleted", async () => {
    const files = {
      ".obsidian/plugins/aaa/manifest.json": JSON.stringify({ id: "aaa", version: "1.0.0" }),
      ".obsidian/community-plugins.json": JSON.stringify(["aaa"]),
    };
    const OLD = Date.parse("2001-01-01T00:00:00Z");
    const notePaths = ["08.10 Obsidian plugins/A.md", auditPath(FLAT_DIR)];
    const globs = {
      ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/aaa/manifest.json"],
      "08.10 Obsidian plugins/*.md": [...notePaths],
    };
    const stats = {
      ".obsidian/community-plugins.json": { type: "file", mtime: OLD },
      ".obsidian/plugins/aaa/manifest.json": { type: "file", mtime: OLD },
      ...Object.fromEntries(notePaths.map((n) => [n, { type: "file", mtime: OLD }])),
    };
    const src = fakeBackend({ files, globs, stats });
    const text = await regenerateAudit(src, "2035-01-01T00:00:00", FLAT_DIR, FLAT, auditPath(FLAT_DIR));
    assert.match(text, /^derived-source-count: 4$/m);

    // Re-check the audit as a derived note: parse the witness back out of the
    // rendered text (the frontmatter Obsidian would hand back).
    const witness = Number(/^derived-source-count: (\d+)$/m.exec(text)[1]);
    const auditFm = {
      "derived-from": auditDerivedFrom(FLAT_DIR, FLAT),
      generated: "2035-01-01T00:00:00",
      "derived-source-count": witness,
    };
    const checkSrc = fakeBackend({ files, globs, stats, notes: { [auditPath(FLAT_DIR)]: auditFm } });
    assert.equal((await checkFreshness(checkSrc, auditPath(FLAT_DIR))).fresh, true);

    // Now DELETE one plugin note — no mtime anywhere moves.
    globs["08.10 Obsidian plugins/*.md"] = [auditPath(FLAT_DIR)];
    const after = await checkFreshness(checkSrc, auditPath(FLAT_DIR));
    assert.equal(after.fresh, false, "a deleted source must make the audit STALE");
    assert.deepEqual(after.sourcesRemoved, { expected: 4, actual: 3 });
    assert.deepEqual(after.changed, [], "nothing was modified — this is the blind spot the witness closes");
  });

  test("the witness is correct under a non-default notesDir — trailing slash included", async () => {
    for (const notesDir of ["Meta/Plugins", "Meta/Plugins/"]) {
      const src = fakeBackend({
        globs: {
          ".obsidian/plugins/*/manifest.json": [],
          "Meta/Plugins/*.md": ["Meta/Plugins/A.md", "Meta/Plugins/Plugins.md"], // audit note present
        },
        stats: { ".obsidian/community-plugins.json": { type: "file", mtime: 1 } },
        files: { ".obsidian/community-plugins.json": JSON.stringify([]) },
      });
      const out = await regenerateAudit(src, "2036-01-01T00:00:00", notesDir, FLAT, auditPath(notesDir));
      // 2 notes (one is the audit itself) + community-plugins.json = 3; the audit
      // already resolves, so nothing is added for it.
      assert.match(out, /^derived-source-count: 3$/m, `notesDir ${JSON.stringify(notesDir)}`);
      assert.equal(auditPath(notesDir), "Meta/Plugins/Plugins.md");
      assert.deepEqual(auditDerivedFrom(notesDir, FLAT)[0], "Meta/Plugins/*.md");
    }
  });

  test("auditPath derives the note name from the notes-dir basename", () => {
    assert.equal(auditPath(FLAT_DIR), "08.10 Obsidian plugins/08.10 Obsidian plugins.md");
    assert.equal(auditPath("Meta/Plugins"), "Meta/Plugins/Plugins.md");
  });

  test("regen uses the normalized (trailing-slash-stripped) audit path via the tool config", async () => {
    // A `Meta/Plugins/` config value must not double-slash the audit path — the
    // handler resolves notesDir through provenanceConfigOf, which strips it.
    const backend = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [], "Meta/Plugins/*.md": [] },
      files: { ".obsidian/community-plugins.json": JSON.stringify([]) },
    });
    const res = await tools(backend, { notesDir: "Meta/Plugins/", notesSource: FLAT, auditNote: "Meta/Plugins/Plugins.md" }).tools.get("provenance_regen").handler({ write: true });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.written, "Meta/Plugins/Plugins.md");
    assert.equal(backend._written[0].path, "Meta/Plugins/Plugins.md");
  });
});

// ── 2. the accept-forbidden write guard (load-bearing) ──────────────────────

describe("guardProvenanceWrite: a regen can never introduce an acceptance assertion", () => {
  const CLEAN =
    "---\nderived-from:\n  - \"x/*.md\"\ngenerated: 2026-01-01T00:00:00\ngenerator: obsidian-plugin-audit\n" +
    "derivation-mode: snapshot\n---\n# audit\n";

  test("a clean audit (derivation metadata only) is allowed", () => {
    assert.doesNotThrow(() => guardProvenanceWrite(null, CLEAN));
  });

  test("rendered frontmatter asserting acceptance is REFUSED", () => {
    const accepted = "---\nacceptance-status: accepted\n---\nbody\n";
    assert.throws(() => guardProvenanceWrite(null, accepted), AcceptForbiddenError);
  });

  test("an accepted-family KEY introduced by the write is REFUSED", () => {
    const acceptedKey = "---\naccepted-by: someone\n---\nbody\n";
    assert.throws(() => guardProvenanceWrite(null, acceptedKey), AcceptForbiddenError);
  });

  test("preserving an existing (human-granted) accepted value forward is ALLOWED", () => {
    const before = { "acceptance-status": "accepted" };
    const after = "---\nacceptance-status: accepted\ngenerator: obsidian-plugin-audit\n---\nbody\n";
    assert.doesNotThrow(() => guardProvenanceWrite(before, after));
  });
});

// ── 3a. tool handlers ────────────────────────────────────────────────────────

function tools(backend, config = {}) {
  const server = fakeServer();
  registerProvenanceTools(server, backend, { config, getSettings: () => ({}) });
  return server;
}

describe("provenance tools: handlers answer over the injected backend", () => {
  test("provenance_check reports FRESH/STALE", async () => {
    const backend = fakeBackend({
      notes: { "audit.md": { "derived-from": ["src.md"], generated: "2020-01-01T00:00:00" } },
      stats: { "src.md": { type: "file", mtime: Date.parse("2030-01-01T00:00:00Z") } },
    });
    const res = await tools(backend).tools.get("provenance_check").handler({ path: "audit.md" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.fresh, false);
    assert.deepEqual(res.structuredContent.changed, ["src.md"]);
    // Additive shape: the new keys ride beside the originals.
    assert.deepEqual(res.structuredContent.missing, []);
    assert.equal(res.structuredContent.globDeletionsUndetectable, false);
    assert.ok(!("sourcesRemoved" in res.structuredContent), "sourcesRemoved is omitted when no removal is detected");
    assert.ok(!("expectedSourceCount" in res.structuredContent), "expectedSourceCount is omitted with no witness");
  });

  test("provenance_check surfaces missing entries, the count reason, and the undetectable flag", async () => {
    const missingBackend = fakeBackend({
      notes: { "audit.md": { "derived-from": ["gone.md"], generated: "2035-01-01T00:00:00" } },
    });
    const m = await tools(missingBackend).tools.get("provenance_check").handler({ path: "audit.md" });
    assert.equal(m.structuredContent.fresh, false);
    assert.deepEqual(m.structuredContent.missing, ["gone.md"]);

    const shrunk = fakeBackend({
      notes: {
        "audit.md": { "derived-from": ["src/*.md"], generated: "2035-01-01T00:00:00", "derived-source-count": 5 },
      },
      globs: { "src/*.md": ["src/a.md"] },
      stats: { "src/a.md": { type: "file", mtime: Date.parse("2001-01-01T00:00:00Z") } },
    });
    const s = await tools(shrunk).tools.get("provenance_check").handler({ path: "audit.md" });
    assert.equal(s.structuredContent.fresh, false);
    assert.deepEqual(s.structuredContent.sourcesRemoved, { expected: 5, actual: 1 });
    assert.equal(s.structuredContent.expectedSourceCount, 5);
    assert.equal(s.structuredContent.globDeletionsUndetectable, false);

    const unwitnessed = fakeBackend({
      notes: { "audit.md": { "derived-from": ["src/*.md"], generated: "2035-01-01T00:00:00" } },
      globs: { "src/*.md": ["src/a.md"] },
      stats: { "src/a.md": { type: "file", mtime: Date.parse("2001-01-01T00:00:00Z") } },
    });
    const u = await tools(unwitnessed).tools.get("provenance_check").handler({ path: "audit.md" });
    assert.equal(u.structuredContent.fresh, true);
    assert.equal(u.structuredContent.globDeletionsUndetectable, true);
  });

  test("provenance_reconcile reports counts + unnoted + stale", async () => {
    const backend = fakeBackend({
      globs: {
        ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/aaa/manifest.json", ".obsidian/plugins/bbb/manifest.json"],
        "08.10 Obsidian plugins/*.md": ["08.10 Obsidian plugins/AAA.md"],
      },
      files: {
        ".obsidian/plugins/aaa/manifest.json": JSON.stringify({ id: "aaa", version: "1.0.0" }),
        ".obsidian/plugins/bbb/manifest.json": JSON.stringify({ id: "bbb", version: "2.0.0" }),
        ".obsidian/community-plugins.json": JSON.stringify(["aaa"]),
      },
      notes: { "08.10 Obsidian plugins/AAA.md": { plugin: { id: "aaa", version: "0.9.0" } } },
    });
    const res = await tools(backend, { notesDir: FLAT_DIR, notesSource: FLAT }).tools.get("provenance_reconcile").handler({});
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.counts.installed, 2);
    assert.deepEqual(res.structuredContent.unnoted, ["bbb"]);
    assert.deepEqual(res.structuredContent.staleVersion, [{ id: "aaa", noteVersion: "0.9.0", manifestVersion: "1.0.0" }]);
  });

  test("provenance_regen dry-run returns text WITHOUT writing", async () => {
    const backend = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/aaa/manifest.json"], "08.10 Obsidian plugins/*.md": [] },
      files: {
        ".obsidian/plugins/aaa/manifest.json": JSON.stringify({ id: "aaa", version: "1.0.0" }),
        ".obsidian/community-plugins.json": JSON.stringify(["aaa"]),
      },
    });
    const res = await tools(backend, { notesDir: FLAT_DIR, notesSource: FLAT, auditNote: auditPath(FLAT_DIR) }).tools.get("provenance_regen").handler({});
    assert.equal(res.structuredContent.dryRun, true);
    assert.match(res.structuredContent.text, /aaa/);
    assert.equal(backend._written.length, 0, "dry-run must not write");
  });

  test("provenance_regen write:true persists through the guarded write primitive", async () => {
    const backend = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/aaa/manifest.json"], "08.10 Obsidian plugins/*.md": [] },
      files: {
        ".obsidian/plugins/aaa/manifest.json": JSON.stringify({ id: "aaa", version: "1.0.0" }),
        ".obsidian/community-plugins.json": JSON.stringify(["aaa"]),
      },
    });
    const res = await tools(backend, { notesDir: FLAT_DIR, notesSource: FLAT, auditNote: auditPath(FLAT_DIR) }).tools.get("provenance_regen").handler({ write: true });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.written, auditPath(FLAT_DIR));
    assert.equal(backend._written.length, 1);
    assert.equal(backend._written[0].path, auditPath(FLAT_DIR));
    assert.match(backend._written[0].text, /derivation-mode: snapshot/);
  });
});

// ── 3b. module registration ──────────────────────────────────────────────────

const inertProvenance = {
  noteFrontmatter: () => null,
  read: async () => null,
  stat: async () => null,
  glob: async () => [],
  writeNote: async () => {},
};

function deps(settings = {}) {
  return {
    getSettings: () => settings,
    schemeNotes: () => [],
    vocabSource: { paths: () => [], frontmatter: () => null, body: async () => null },
    skillsSource: {
      notes: async () => [],
      resolveLink: () => null,
      embed: async () => null,
      basePath: () => null,
      frontmatterOf: () => null,
      exists: () => false,
      applyFrontmatter: async () => {},
    },
    provenanceSource: inertProvenance,
  };
}

function mount(settings) {
  const server = fakeServer();
  const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps(settings));
  return { server, registry };
}

describe("provenance module: registration through the module host", () => {
  test("ships DISABLED — contributes nothing by default", () => {
    const { server, registry } = mount({});
    assert.equal(registry.isEnabled("provenance"), false);
    assert.ok(![...server.tools.keys()].some((n) => n.startsWith("provenance_")));
  });

  test("enabled: all three tools register; regen mutating, check/reconcile read-only", () => {
    const { server } = mount({ modules: { provenance: { enabled: true } } });
    const names = [...server.tools.keys()];
    for (const n of PROVENANCE_TOOLS) assert.ok(names.includes(n), `missing ${n}`);
    for (const n of WRITE_TOOLS) assert.equal(server.tools.get(n).def.annotations.readOnlyHint, false, `${n} must be mutating`);
    for (const n of READ_TOOLS) assert.equal(server.tools.get(n).def.annotations.readOnlyHint, true, `${n} must be read-only`);
  });

  test("regen mounts ONLY because the module declares `mutating`", () => {
    const { server, registry } = mount({ modules: { provenance: { enabled: true } } });
    assert.ok(server.tools.has("provenance_regen"));
    assert.deepEqual(registry.problems, []);
  });

  test("contributes NO accept/approve tool", () => {
    for (const n of PROVENANCE_TOOLS) assert.equal(forbiddenToolName(n), false, `${n} unexpectedly reads as accept-shaped`);
    const { server } = mount({ modules: { provenance: { enabled: true } } });
    const provNames = [...server.tools.keys()].filter((n) => n.startsWith("provenance_"));
    assert.equal(provNames.length, 3);
    assert.ok(!provNames.some((n) => forbiddenToolName(n)));
  });

  test("collect() renders a provenance config tab: summary, three config fields, three-tool directory", () => {
    const hosted = collect(builtinModules(deps({})), {}, {});
    const prov = hosted.find((h) => h.id === "provenance");
    assert.ok(prov, "provenance module not rendered");
    assert.ok(prov.summary.length > 0);
    assert.equal(prov.fields.length, 3);
    assert.equal(prov.fields.find((f) => f.key === "notesDir").value, "00-09 System/07 Repositories");
    assert.equal(prov.fields.find((f) => f.key === "notesSource").value, "jd-slots");
    assert.equal(
      prov.fields.find((f) => f.key === "auditNote").value,
      "00-09 System/07 Repositories/Plugin audit.md",
    );
    assert.deepEqual(prov.directory.tools.map((t) => t.name).sort(), [...PROVENANCE_TOOLS].sort());
    for (const t of prov.directory.tools) {
      assert.equal(t.readOnly, READ_TOOLS.includes(t.name), `${t.name} readOnly flag`);
    }
  });
});

// ── 1f. #257 — the jd-slots notes layout ────────────────────────────────────
//
// The pre-#257 audit was enabled but INERT: `notesDir` defaulted to a flat
// folder that no longer exists, so reconcile matched nothing and reported a
// clean vault. This block pins the layout that replaces it, and the two facts
// that scouting the ruled default against the real vault turned up:
//
//   * `07 Repositories` is inside `00-09 System`, not at the vault root — a
//     bare default would have been dead on arrival, the same shape as the bug.
//   * the audit's destination cannot be DERIVED from a JD folder, because
//     "note named after its folder" is the folder-note convention and the
//     derived path lands on the folder note itself.

describe("#257 jd-slots: the audit reads JD repo slots", () => {
  const ROOT = "00-09 System/07 Repositories";
  const slot = (name) => `${ROOT}/${name}/${name}.md`;

  // Two installed plugins whose ids relate to their repo names differently:
  // `automatic-linker` is installed under the un-prefixed id while its repo is
  // `obsidian-automatic-linker`; `governor` matches its repo exactly.
  function slotsVault({ extraNotes = {}, extraSlots = [] } = {}) {
    const notes = {
      [slot("07.20 obsidian-automatic-linker")]: { "github-repo": "nelsonlove/obsidian-automatic-linker" },
      [slot("07.21 obsidian-governor")]: { "github-repo": "nelsonlove/governor" },
      [slot("07.00 Inbox for 07 Repositories")]: { description: "not a repo slot" },
      ...extraNotes,
    };
    return fakeBackend({
      notes,
      globs: {
        ".obsidian/plugins/*/manifest.json": [
          ".obsidian/plugins/automatic-linker/manifest.json",
          ".obsidian/plugins/governor/manifest.json",
        ],
        [`${ROOT}/*/*.md`]: [...Object.keys(notes), ...extraSlots],
      },
      files: {
        ".obsidian/plugins/automatic-linker/manifest.json": JSON.stringify({ id: "automatic-linker", version: "1.0.0" }),
        ".obsidian/plugins/governor/manifest.json": JSON.stringify({ id: "governor", version: "0.18.0" }),
        ".obsidian/community-plugins.json": JSON.stringify(["governor"]),
      },
    });
  }

  test("folder notes match installed plugins through `github-repo:`, prefix difference included", async () => {
    const r = await reconcile(slotsVault(), ROOT, "jd-slots");
    assert.deepEqual(Object.keys(r.noted).sort(), ["automatic-linker", "governor"]);
    assert.equal(r.noted["automatic-linker"], slot("07.20 obsidian-automatic-linker"));
    assert.deepEqual(r.unnoted, [], "both installed plugins are noted");
  });

  test("a slot with no `github-repo:` is not a finding — an inbox is not an unmatched repo", async () => {
    const r = await reconcile(slotsVault(), ROOT, "jd-slots");
    assert.deepEqual(r.unmatchedSlots, [], "the inbox slot is skipped, not reported");
  });

  test("a repo slot matching no installed plugin is REPORTED, never dropped", async () => {
    const orphan = slot("07.30 obsidian-something-uninstalled");
    const v = slotsVault({ extraNotes: { [orphan]: { "github-repo": "nelsonlove/obsidian-something-uninstalled" } } });
    const r = await reconcile(v, ROOT, "jd-slots");
    assert.deepEqual(r.unmatchedSlots, [orphan]);
    // VACUITY: the check can distinguish. Without the orphan it is empty, so a
    // green "no unmatched slots" is a fact about the vault, not about the code.
    assert.deepEqual((await reconcile(slotsVault(), ROOT, "jd-slots")).unmatchedSlots, []);
  });

  test("matching is conservative: a NEAR-MISS repo name does not attach to a plugin", async () => {
    const near = slot("07.31 automatic-linker-extras");
    const v = slotsVault({ extraNotes: { [near]: { "github-repo": "nelsonlove/automatic-linker-extras" } } });
    const r = await reconcile(v, ROOT, "jd-slots");
    assert.equal(r.noted["automatic-linker"], slot("07.20 obsidian-automatic-linker"), "the real slot still owns the id");
    assert.ok(r.unmatchedSlots.includes(near), "the near-miss is reported, not silently bound to a neighbour");
  });

  test("an explicit `plugin.id` wins over the repo name", async () => {
    const odd = slot("07.32 totally-unrelated-repo-name");
    const v = slotsVault({
      extraNotes: { [odd]: { "github-repo": "someone/totally-unrelated-repo-name", plugin: { id: "governor" } } },
    });
    const r = await reconcile(v, ROOT, "jd-slots");
    assert.equal(r.noted["governor"], odd, "the note saying what it is beats inference from a repo name");
  });

  test("only the FOLDER note represents the slot — other notes inside it are ignored", async () => {
    const inner = `${ROOT}/07.20 obsidian-automatic-linker/project-inventory.md`;
    const v = slotsVault({
      extraSlots: [inner],
      extraNotes: { [inner]: { "github-repo": "someone/governor" } },
    });
    const r = await reconcile(v, ROOT, "jd-slots");
    assert.equal(r.noted["governor"], slot("07.21 obsidian-governor"), "the real folder note keeps the id");
    assert.deepEqual(r.unmatchedSlots, [], "a non-folder note is not reported as an unmatched slot either");
  });

  test("the layout drives ONE glob, and the declared derived-from uses the same one", () => {
    assert.equal(notesGlob(ROOT, "jd-slots"), `${ROOT}/*/*.md`);
    assert.equal(notesGlob(ROOT, "flat"), `${ROOT}/*.md`);
    assert.equal(auditDerivedFrom(ROOT, "jd-slots")[0], notesGlob(ROOT, "jd-slots"));
    assert.equal(auditDerivedFrom(ROOT, "flat")[0], notesGlob(ROOT, "flat"));
  });
});

describe("#257 the shipped defaults, and why the audit path is not derived", () => {
  test("the notes root is inside 00-09 System — a vault-root path would be dead on arrival", () => {
    assert.equal(DEFAULT_NOTES_DIR, "00-09 System/07 Repositories");
    assert.ok(DEFAULT_NOTES_DIR.startsWith("00-09 System/"), "07 Repositories is an area INSIDE 00-09 System");
    assert.equal(DEFAULT_NOTES_SOURCE, "jd-slots");
  });

  test("REGRESSION: the derived audit path lands on the JD folder note — so the default must not be derived", () => {
    // This is the defect, demonstrated rather than described: deriving the note
    // name from the folder is right for a flat folder and destructive for a JD
    // one, because the folder note already has that exact name.
    assert.equal(auditPath(DEFAULT_NOTES_DIR), `${DEFAULT_NOTES_DIR}/07 Repositories.md`);
    assert.notEqual(
      DEFAULT_AUDIT_NOTE,
      auditPath(DEFAULT_NOTES_DIR),
      "the shipped audit note must NOT be the folder note the derivation produces",
    );
    assert.equal(DEFAULT_AUDIT_NOTE, "00-09 System/07 Repositories/Plugin audit.md");
  });

  test("config coercion: an unknown layout degrades to the default and validate() says so", () => {
    assert.equal(provenanceConfigOf({ notesSource: "jd_slots" }).notesSource, "jd-slots");
    assert.ok(
      validateProvenanceConfig({ notesSource: "jd_slots" }).some((m) => m.includes("notesSource")),
      "a typo'd layout is reported, not silently scanning nothing",
    );
    assert.deepEqual(validateProvenanceConfig({ notesSource: "flat" }), []);
  });

  test("config coercion: a folder-shaped auditNote degrades, and a bare name gains .md", () => {
    assert.equal(provenanceConfigOf({ auditNote: "Some/Folder/" }).auditNote, DEFAULT_AUDIT_NOTE);
    assert.equal(provenanceConfigOf({ auditNote: "Some/Audit" }).auditNote, "Some/Audit.md");
    assert.ok(validateProvenanceConfig({ auditNote: "Some/Folder/" }).some((m) => m.includes("NOTE path")));
  });

  test("regen writes to the CONFIGURED note, not the derived one", async () => {
    const backend = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [], [`${DEFAULT_NOTES_DIR}/*/*.md`]: [] },
      files: { ".obsidian/community-plugins.json": JSON.stringify([]) },
    });
    const res = await tools(backend, {}).tools.get("provenance_regen").handler({ write: true });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.written, DEFAULT_AUDIT_NOTE);
    assert.equal(backend._written[0].path, DEFAULT_AUDIT_NOTE);
    assert.notEqual(backend._written[0].path, auditPath(DEFAULT_NOTES_DIR), "never the folder note");
  });
});

// ── 1g. #257 review round 2 — the six defects an independent review found ────

describe("#257 round 2: the witness, precedence, collisions, and honest emptiness", () => {
  const ROOT = "00-09 System/07 Repositories";
  const slot = (n) => `${ROOT}/${n}/${n}.md`;

  function vault({ notes = {}, extra = [], manifests = {} } = {}) {
    const globs = {
      ".obsidian/plugins/*/manifest.json": Object.keys(manifests).map((id) => `.obsidian/plugins/${id}/manifest.json`),
      [`${ROOT}/*/*.md`]: [...Object.keys(notes), ...extra].sort(),
    };
    const files = { ".obsidian/community-plugins.json": JSON.stringify([]) };
    for (const [id, v] of Object.entries(manifests)) {
      files[`.obsidian/plugins/${id}/manifest.json`] = JSON.stringify({ id, version: v });
    }
    // resolveEntries stats a LITERAL derived-from entry; without this the
    // community-plugins.json source resolves to nothing and the witness is short.
    const stats = Object.fromEntries(
      [...Object.keys(files), ...Object.keys(notes), ...extra].map((f) => [f, { type: "file", mtime: 1 }]),
    );
    return fakeBackend({ notes, globs, files, stats });
  }

  test("WITNESS: the audit sits OUTSIDE its own glob, so it is never counted in", async () => {
    // The bug: `files.includes(self)` conflates "does not exist yet" with
    // "structurally outside the glob", so under the shipped default the +1 was
    // applied on every regen forever and the note read permanently STALE.
    const s = slot("07.21 obsidian-governor");
    const v = vault({ notes: { [s]: { "github-repo": "n/governor" } }, manifests: { governor: "1.0.0" } });
    const out = await regenerateAudit(v, "2036-01-01T00:00:00", ROOT, "jd-slots", DEFAULT_AUDIT_NOTE);
    // 1 slot note + 1 manifest + community-plugins.json = 3. The audit is NOT a
    // fourth: it lives beside the slots, not inside `{root}/<slot>/`.
    assert.match(out, /^derived-source-count: 3$/m);
    assert.equal(globMatchesPath(notesGlob(ROOT, "jd-slots"), DEFAULT_AUDIT_NOTE), false);
  });

  test("WITNESS: a FLAT audit IS inside its own glob and still counts itself in", async () => {
    // The +1 must survive for the case it was written for — a first-ever regen.
    const v = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [], "Meta/Plugins/*.md": ["Meta/Plugins/A.md"] },
      files: { ".obsidian/community-plugins.json": JSON.stringify([]) },
      stats: {
        "Meta/Plugins/A.md": { type: "file", mtime: 1 },
        ".obsidian/community-plugins.json": { type: "file", mtime: 1 },
      },
    });
    const out = await regenerateAudit(v, "2036-01-01T00:00:00", "Meta/Plugins", "flat", "Meta/Plugins/Plugins.md");
    // A.md + community-plugins.json = 2 now, 3 once the audit lands.
    assert.match(out, /^derived-source-count: 3$/m);
    assert.equal(globMatchesPath(notesGlob("Meta/Plugins", "flat"), "Meta/Plugins/Plugins.md"), true);
  });

  test("COLLISION: two notes claiming one plugin — first wins, loser is REPORTED", async () => {
    const a = slot("07.10 foo");
    const b = slot("07.11 obsidian-foo");
    const v = vault({
      notes: { [a]: { "github-repo": "me/foo" }, [b]: { "github-repo": "me/obsidian-foo" } },
      manifests: { "obsidian-foo": "1.0.0" },
    });
    const r = await reconcile(v, ROOT, "jd-slots");
    assert.equal(r.noted["obsidian-foo"], a, "sorted glob order decides, deterministically");
    assert.deepEqual(r.collidingSlots, [["obsidian-foo", b]], "the loser is reported, never silently dropped");
    assert.ok(renderAudit(r, "t", ROOT, undefined, "jd-slots").includes(b), "and it reaches the rendered audit");
  });

  test("PRECEDENCE: an explicit `plugin.id` wins REGARDLESS of glob order", async () => {
    // The original single-pass loop let whichever note sorted last win, so this
    // held only by accident of filename. Assert both orders.
    for (const name of ["07.05 explicit-first", "07.99 explicit-last"]) {
      const ex = slot(name);
      const repo = slot("07.21 obsidian-governor");
      const v = vault({
        notes: { [ex]: { plugin: { id: "governor" } }, [repo]: { "github-repo": "n/governor" } },
        manifests: { governor: "1.0.0" },
      });
      const r = await reconcile(v, ROOT, "jd-slots");
      assert.equal(r.noted["governor"], ex, `explicit id must win with slot named ${name}`);
      assert.deepEqual(r.collidingSlots, [["governor", repo]], "the inferred note is the reported loser");
    }
  });

  test("HONEST EMPTINESS: no note records a version ⇒ the audit says so, not “(none)”", () => {
    const noVersions = {
      installed: {}, enabled: [], noted: { governor: slot("07.21 obsidian-governor") },
      unnoted: [], staleVersion: [], unmatchedSlots: [], collidingSlots: [], notedVersions: {},
    };
    const text = renderAudit(noVersions, "t", ROOT, undefined, "jd-slots");
    assert.match(text, /no version data/, "an uncomputable comparison must not render as a clean one");
    assert.doesNotMatch(text.split("## Version drift")[1].split("##")[0], /\(none\)/);

    const withVersion = { ...noVersions, notedVersions: { governor: "1.0.0" } };
    const text2 = renderAudit(withVersion, "t", ROOT, undefined, "jd-slots");
    // VACUITY: the branch is reachable both ways — otherwise the assertion above
    // would pass against a renderer that always printed the caveat.
    assert.match(text2.split("## Version drift")[1].split("##")[0], /\(none\)/);
  });

  test("NO SILENT IGNORE: a configured auditNote is honoured in FLAT mode too", () => {
    const cfg = provenanceConfigOf({ notesDir: "Meta/Plugins", notesSource: "flat", auditNote: "Meta/My audit.md" });
    assert.equal(cfg.auditNote, "Meta/My audit.md", "a rendered, validated field must not be silently discarded");
    // Unset ⇒ flat still derives, as it always did.
    assert.equal(provenanceConfigOf({ notesDir: "Meta/Plugins", notesSource: "flat" }).auditNote, "Meta/Plugins/Plugins.md");
  });

  test("an existing extension is left alone; only a bare name gains .md", () => {
    assert.equal(provenanceConfigOf({ auditNote: "Some/Audit.markdown" }).auditNote, "Some/Audit.markdown");
    assert.equal(provenanceConfigOf({ auditNote: "Some/Audit" }).auditNote, "Some/Audit.md");
  });
});

// ── 1h. #257 round 3 — the write path, not just the config value ────────────

describe("#257 round 3: regen writes and READS the same note", () => {
  test("FLAT + configured auditNote: the tool writes THERE, and preserves THAT note's human section", async () => {
    // Round 2 fixed provenanceConfigOf and left the tool deriving, so regen
    // read the human sections from the configured note and wrote them over the
    // derived one — destroying the target's own hand-written text. Strictly
    // worse than the silent-ignore it replaced, and the round-2 test never
    // touched the write path, only the config value.
    const DERIVED = "Meta/Plugins/Plugins.md";
    const CONFIGURED = "Meta/My audit.md";
    const backend = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [], "Meta/Plugins/*.md": [DERIVED] },
      files: {
        ".obsidian/community-plugins.json": JSON.stringify([]),
        [DERIVED]: "---\nderived-from: []\n---\n<!-- human:start notes -->\nDERIVED-OWN-TEXT\n<!-- human:end -->\n",
        [CONFIGURED]: "---\nderived-from: []\n---\n<!-- human:start notes -->\nCONFIGURED-OWN-TEXT\n<!-- human:end -->\n",
      },
      stats: {
        [DERIVED]: { type: "file", mtime: 1 },
        ".obsidian/community-plugins.json": { type: "file", mtime: 1 },
      },
    });
    const res = await tools(backend, {
      notesDir: "Meta/Plugins",
      notesSource: FLAT,
      auditNote: CONFIGURED,
    }).tools.get("provenance_regen").handler({ write: true });

    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.written, CONFIGURED, "the configured note is the destination");
    assert.equal(backend._written[0].path, CONFIGURED);
    assert.match(backend._written[0].text, /CONFIGURED-OWN-TEXT/, "it carries its OWN human section forward");
    assert.doesNotMatch(backend._written[0].text, /DERIVED-OWN-TEXT/, "never another note's text");
    assert.ok(!backend._written.some((w) => w.path === DERIVED), "and the derived note is not touched at all");
  });

  test("the witness is decided about the note actually written", async () => {
    // Same root cause, other consequence: with the write going to the derived
    // path while `self` was the configured one, the +1 was decided about a file
    // that was never written — witnessing 2 for a set that becomes 3, so the
    // NEXT deletion returns the count to 2 and is masked.
    const backend = fakeBackend({
      globs: { ".obsidian/plugins/*/manifest.json": [], "Meta/Plugins/*.md": ["Meta/Plugins/A.md"] },
      files: { ".obsidian/community-plugins.json": JSON.stringify([]) },
      stats: {
        "Meta/Plugins/A.md": { type: "file", mtime: 1 },
        ".obsidian/community-plugins.json": { type: "file", mtime: 1 },
      },
    });
    const res = await tools(backend, { notesDir: "Meta/Plugins", notesSource: FLAT })
      .tools.get("provenance_regen").handler({ write: true });
    // Default flat destination is the derived note, which IS inside the glob:
    // A.md + community-plugins.json = 2 now, 3 once it lands.
    assert.equal(res.structuredContent.written, "Meta/Plugins/Plugins.md");
    assert.match(backend._written[0].text, /^derived-source-count: 3$/m);
  });

  test("ONE glob-segment matcher: an unbalanced `[` is escaped, not a crash", () => {
    // globMatchesPath was a second, weaker copy and threw
    // "Unterminated character class" on a folder name the expander handles.
    assert.doesNotThrow(() => globMatchesPath("Meta/P [wip/*.md", "Meta/P [wip/A.md"));
    assert.equal(globMatchesPath("Meta/P [wip/*.md", "Meta/P [wip/A.md"), true);
    // The kernel matcher and the one the expander uses are now the SAME function.
    assert.equal(globSegmentRe("*.md").test("A.md"), true);
    assert.equal(globSegmentRe("[!x]y").test("zy"), true, "glob negation, not a literal !");
    assert.equal(globSegmentRe("[!x]y").test("xy"), false);
  });

  test("only a markdown extension counts — a JD-numbered name still gets .md", () => {
    assert.equal(provenanceConfigOf({ auditNote: "Meta/Plugin audit 00.18" }).auditNote, "Meta/Plugin audit 00.18.md");
    assert.equal(provenanceConfigOf({ auditNote: "Some/v1.2" }).auditNote, "Some/v1.2.md");
    assert.equal(provenanceConfigOf({ auditNote: "Some/Audit.markdown" }).auditNote, "Some/Audit.markdown");
    assert.equal(provenanceConfigOf({ auditNote: "Some/Audit.MD" }).auditNote, "Some/Audit.MD");
  });

  test("provenance_reconcile surfaces collisions, not only unmatched slots", async () => {
    const ROOT = "00-09 System/07 Repositories";
    const s = (n) => `${ROOT}/${n}/${n}.md`;
    const a = s("07.10 foo"), b = s("07.11 obsidian-foo");
    const backend = fakeBackend({
      notes: { [a]: { "github-repo": "me/foo" }, [b]: { "github-repo": "me/obsidian-foo" } },
      globs: {
        ".obsidian/plugins/*/manifest.json": [".obsidian/plugins/obsidian-foo/manifest.json"],
        [`${ROOT}/*/*.md`]: [a, b],
      },
      files: {
        ".obsidian/plugins/obsidian-foo/manifest.json": JSON.stringify({ id: "obsidian-foo", version: "1.0.0" }),
        ".obsidian/community-plugins.json": JSON.stringify([]),
      },
    });
    const res = await tools(backend, {}).tools.get("provenance_reconcile").handler({});
    assert.deepEqual(res.structuredContent.collidingSlots, [["obsidian-foo", b]]);
  });
});
