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
  extractSections,
  reinsertSections,
} from "../src/kernel/provenance/index.ts";
import {
  registerProvenanceTools,
  guardProvenanceWrite,
} from "../src/mcp/tools-provenance.ts";
import { mountModules, builtinModules } from "../src/mcp/modules-mount.ts";
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
    const r = await reconcile(vault());
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
    const r = await reconcile(src);
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
    const ap = auditPath();
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
    const out = await regenerateAudit(src, "2036-01-01T00:00:00");
    assert.match(out, /aaa/); // unnoted plugin surfaced
    assert.match(out, /KEEP THIS/); // human section preserved
    assert.match(out, /derivation-mode: snapshot/);
    assert.match(out, /generator: obsidian-plugin-audit/);
  });

  test("auditPath derives the note name from the notes-dir basename", () => {
    assert.equal(auditPath(), "08.10 Obsidian plugins/08.10 Obsidian plugins.md");
    assert.equal(auditPath("Meta/Plugins"), "Meta/Plugins/Plugins.md");
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
    const res = await tools(backend).tools.get("provenance_reconcile").handler({});
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
    const res = await tools(backend).tools.get("provenance_regen").handler({});
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
    const res = await tools(backend).tools.get("provenance_regen").handler({ write: true });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.written, auditPath());
    assert.equal(backend._written.length, 1);
    assert.equal(backend._written[0].path, auditPath());
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

  test("collect() renders a provenance config tab: summary, one config field, three-tool directory", () => {
    const hosted = collect(builtinModules(deps({})), {}, {});
    const prov = hosted.find((h) => h.id === "provenance");
    assert.ok(prov, "provenance module not rendered");
    assert.ok(prov.summary.length > 0);
    assert.equal(prov.fields.length, 1);
    assert.equal(prov.fields.find((f) => f.key === "notesDir").value, "08.10 Obsidian plugins");
    assert.deepEqual(prov.directory.tools.map((t) => t.name).sort(), [...PROVENANCE_TOOLS].sort());
    for (const t of prov.directory.tools) {
      assert.equal(t.readOnly, READ_TOOLS.includes(t.name), `${t.name} readOnly flag`);
    }
  });
});
