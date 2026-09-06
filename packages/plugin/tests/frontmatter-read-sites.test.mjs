/**
 * frontmatter-read-sites.test.mjs — issue #189: the five plugin-side READ
 * sites that parsed raw note text with their own narrow `/^---\n/` frontmatter
 * regexes instead of the shared recognizer in @vault-mcp/core
 * (`leadingFrontmatterBlock` / `stripLeadingFrontmatter`, the #150 pair). A
 * narrow local copy reads a BOM- or CRLF-authored note as having NO
 * frontmatter at all — a silent mis-read, not a bypass.
 *
 * One describe-block PER SITE, so neutering any single site (reverting its
 * regex) fails that site's own block — the per-site non-vacuity the issue's
 * definition-of-done asks for. Each block asserts the same three things:
 *
 *   1. a BOM-prefixed note now parses (the pre-fix narrow behavior is dead),
 *   2. a CRLF note now parses (dead for the sites that were CRLF-blind;
 *      regression-pinned for the two that already handled CRLF),
 *   3. a plain LF note behaves byte-identically to before the fix — for the
 *      conformance packs that is what keeps every already-recognized note's
 *      finding set, and therefore its ratchet keys, unchanged.
 *
 * The sites (issue #189's table):
 *   - src/conformance/packs/drift.ts        `fmBlock`          (BOM+CRLF-blind)
 *   - src/conformance/packs/structure.ts    FM_STRIP + noteInfo (BOM+CRLF-blind)
 *   - @vault-mcp/core src/vocab/blueprint.ts `scanFrontmatter`  (BOM+CRLF-blind)
 *     (was src/kernel/vocab/blueprint.ts until the S7 satellite extraction)
 *   - src/kernel/skills/transclude.ts       `stripFrontmatter` (BOM-blind)
 *     — MOVED OUT: the skills compiler is its own plugin since the suite
 *     split S4; that site is now pinned by
 *     packages/skills/tests/transclude-frontmatter.test.mjs
 *   - src/mcp/tools-complementary.ts        obsidian_read_note_parsed body strip
 *                                                              (BOM-blind)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { driftPack, DEFAULT_REGISTRIES_ROOT } from "../src/conformance/packs/index.ts";
import { noteInfo, emittedH2s } from "../src/conformance/packs/structure.ts";
import { scanFrontmatter } from "@vault-mcp/core";

// U+FEFF by code point, never a literal BOM byte in source (accept-guard.ts's
// own convention — stripLeadingBom compares 0xfeff the same way).
const BOM = String.fromCharCode(0xfeff);

// ── site 1: drift.ts `fmBlock` (exercised through check G on a .tag.md) ───────
//
// G reads a registry note's `title:` via fmBlock. Pre-fix, a BOM/CRLF note's
// frontmatter was invisible, so a CONFORMING tag note drew a spurious
// "title is 'None'" finding. Post-fix its title parses and G stays quiet.

describe("drift.ts fmBlock binds to the shared recognizer (#189)", () => {
  const FBF = DEFAULT_REGISTRIES_ROOT;
  const snap = (sources) => ({
    notes: [],
    paths: [],
    blueprints: [],
    sources,
    files: [],
    dirs: [],
    walkOrder: [],
    obsidianConfig: [{ path: ".obsidian/plugins/quickadd/data.json", text: '{"choices":[]}' }],
  });
  const tagNote = (text) => [{ path: `${FBF}/Tags/foo.tag.md`, text }];
  const gFindings = (text) => driftPack().run(snap(tagNote(text))).filter((f) => f.check === "G");

  const LF_OK = "---\ntitle: foo.tag\n---\n# body\n";

  test("LF note: conforming title draws no G finding (regression — unchanged behavior)", () => {
    assert.deepEqual(gFindings(LF_OK), []);
  });

  test("LF note: mismatched title draws the byte-identical G finding (key stability)", () => {
    const [f] = gFindings("---\ntitle: wrong\n---\n");
    assert.ok(f, "expected a G finding");
    assert.equal(f.target, "foo.tag.md title is 'wrong', the filename says 'foo.tag'");
    assert.equal(f.kind, "");
  });

  test("BOM note: the frontmatter is SEEN — no spurious title-is-None finding", () => {
    assert.deepEqual(gFindings(BOM + LF_OK), []);
  });

  test("BOM note: a real mismatch reads the actual title, not 'None' (narrow behavior is dead)", () => {
    const [f] = gFindings(BOM + "---\ntitle: wrong\n---\n");
    assert.ok(f, "expected a G finding");
    assert.equal(f.target, "foo.tag.md title is 'wrong', the filename says 'foo.tag'");
  });

  test("CRLF note: the frontmatter is SEEN — no spurious finding", () => {
    assert.deepEqual(gFindings("---\r\ntitle: foo.tag\r\n---\r\n# body\r\n"), []);
  });
});

// ── site 2: structure.ts — FM_STRIP (emittedH2s) and noteInfo ─────────────────

describe("structure.ts emittedH2s strips BOM/CRLF frontmatter (#189)", () => {
  // `## Ghost` sits INSIDE the blueprint's frontmatter; only `## Real` is body.
  // Pre-fix, a BOM made the strip miss, so Ghost leaked into the emitted set.
  const bp = (text) => emittedH2s("x.blueprint", new Map([["x.blueprint", text]]));

  test("LF blueprint: frontmatter is dropped (regression)", () => {
    assert.deepEqual([...bp("---\n## Ghost\n---\n## Real\n").heads], ["Real"]);
  });

  test("BOM blueprint: frontmatter is dropped, Ghost does not leak", () => {
    assert.deepEqual([...bp(BOM + "---\n## Ghost\n---\n## Real\n").heads], ["Real"]);
  });

  test("CRLF blueprint: frontmatter is dropped, Ghost does not leak", () => {
    assert.deepEqual([...bp("---\r\n## Ghost\r\n---\r\n## Real\r\n").heads], ["Real"]);
  });

  test("no frontmatter: nothing is stripped (regression)", () => {
    assert.deepEqual([...bp("## Real\n").heads], ["Real"]);
  });
});

describe("structure.ts noteInfo binds both halves to the shared recognizer (#189)", () => {
  const LF = '---\nblueprint: "[[X.blueprint]]"\n---\n## A\n```\n## fenced\n```\n## B\n';

  test("LF note: blueprint + H2s read as before (regression, incl. fence skipping)", () => {
    assert.deepEqual(noteInfo(LF), { bp: "X.blueprint", heads: ["A", "B"] });
  });

  test("BOM note: the blueprint link is SEEN (pre-fix the note read as having no frontmatter)", () => {
    assert.deepEqual(noteInfo(BOM + LF), { bp: "X.blueprint", heads: ["A", "B"] });
  });

  test("CRLF note: the blueprint link is SEEN", () => {
    const crlf = '---\r\nblueprint: "[[X.blueprint]]"\r\n---\r\n## A\r\n## B\r\n';
    assert.deepEqual(noteInfo(crlf), { bp: "X.blueprint", heads: ["A", "B"] });
  });

  test("frontmatter H2s are never counted as body H2s (the halves agree)", () => {
    const tricky = '---\nblueprint: "[[X.blueprint]]"\n## Ghost\n---\n## A\n';
    assert.deepEqual(noteInfo(tricky), { bp: "X.blueprint", heads: ["A"] });
  });

  test("no frontmatter / no blueprint link: skipped, as before (regression)", () => {
    assert.deepEqual(noteInfo("## A\n"), { bp: null, heads: [] });
    assert.deepEqual(noteInfo("---\ntitle: t\n---\n## A\n"), { bp: null, heads: [] });
  });
});

// ── site 3: @vault-mcp/core vocab/blueprint.ts `scanFrontmatter` ─────────────

describe("vocab blueprint.ts scanFrontmatter binds to the shared recognizer (#189)", () => {
  const WANT = { extends: "Base", retired: true, tags: ["a", "b"] };

  test("LF definition parses as before (regression)", () => {
    assert.deepEqual(scanFrontmatter("---\nextends: Base\nretired: true\ntags:\n  - a\n  - b\n---\nbody\n"), WANT);
  });

  test("BOM definition parses (pre-fix it read as having no frontmatter → {})", () => {
    assert.deepEqual(
      scanFrontmatter(BOM + "---\nextends: Base\nretired: true\ntags:\n  - a\n  - b\n---\nbody\n"),
      WANT,
    );
  });

  test("CRLF definition parses, including block lists", () => {
    assert.deepEqual(
      scanFrontmatter("---\r\nextends: Base\r\nretired: true\r\ntags:\r\n  - a\r\n  - b\r\n---\r\nbody\r\n"),
      WANT,
    );
  });

  test("no frontmatter yields {} (regression)", () => {
    assert.deepEqual(scanFrontmatter("just a body\n"), {});
  });
});

// ── site 4 LEFT THIS PACKAGE ─────────────────────────────────────────────────
//
// `stripFrontmatter` was `src/kernel/skills/transclude.ts`, the fourth of #189's
// five sites. The skills compiler became its own plugin at the suite split's S4,
// so the site and its four assertions moved with the code, unchanged, to
// packages/skills/tests/transclude-frontmatter.test.mjs. The per-site
// non-vacuity property this file exists for is preserved — it is just enforced
// in the package that now owns the site. THE OTHER FOUR SITES STAY HERE, and a
// sixth site appearing in this package still belongs in this file.

// ── site 5: mcp/tools-complementary.ts obsidian_read_note_parsed body ─────────

import { installObsidianStub, TFile } from "./obsidian-stub.mjs";
installObsidianStub();
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");

function parsedServer(notes, caches) {
  const files = new Map(Object.keys(notes).map((p) => [p, new TFile(p)]));
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (p) => files.get(p) ?? null,
      async read(f) { return notes[f.path]; },
      async cachedRead(f) { return notes[f.path]; },
      getName: () => "TestVault",
    },
    metadataCache: {
      getFileCache: (f) => caches[f.path] ?? null,
      getTags: () => ({}),
      unresolvedLinks: {},
    },
    workspace: { getActiveFile: () => null, activeEditor: null, getActiveViewOfType: () => null },
    internalPlugins: { getPluginById: () => null },
    plugins: { plugins: {} },
  };
  const tools = new Map();
  const ctx = {
    pluginVersion: "0.0.0",
    socketPath: "/tmp/x.sock",
    vaultName: "TestVault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [] }),
  };
  registerComplementaryTools({ registerTool: (name, def, handler) => tools.set(name, handler) }, app, ctx);
  return (path) => tools.get("obsidian_read_note_parsed")({ path }, {});
}

describe("obsidian_read_note_parsed body strip binds to the shared recognizer (#189)", () => {
  const FM = { kind: "x" };
  const call = (content, cache = { frontmatter: FM }) => {
    const notes = { "N.md": content };
    return parsedServer(notes, { "N.md": cache })("N.md");
  };

  test("LF note: body excludes the frontmatter block, byte-identical to before (regression)", async () => {
    const res = await call("---\nkind: x\n---\n# H\nbody\n");
    assert.equal(res.structuredContent.body, "# H\nbody\n");
  });

  test("CRLF note: body excludes the frontmatter block (the old regex handled CRLF — regression)", async () => {
    const res = await call("---\r\nkind: x\r\n---\r\n# H\r\nbody\r\n");
    assert.equal(res.structuredContent.body, "# H\r\nbody\r\n");
  });

  test("BOM note: body excludes the frontmatter the cache parsed (pre-fix it carried the fence)", async () => {
    const res = await call(BOM + "---\nkind: x\n---\n# H\nbody\n");
    assert.equal(res.structuredContent.body, "# H\nbody\n");
    assert.deepEqual(res.structuredContent.frontmatter, FM);
  });

  test("no cache-recognized frontmatter: content passes through byte-identically (gate preserved)", async () => {
    const res = await call(BOM + "---\nnot: frontmatter per the cache\n---\n", {});
    assert.equal(res.structuredContent.body, BOM + "---\nnot: frontmatter per the cache\n---\n");
  });
});
