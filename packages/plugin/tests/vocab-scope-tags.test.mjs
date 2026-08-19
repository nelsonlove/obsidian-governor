/**
 * vocab-scope-tags.test.mjs — the scope-tags VocabularyProvider (#251):
 * per-scope tag whitelists with chain inheritance.
 *
 *   • existence — a tag exists iff a registry note (`fileClass: Meta/Tag`,
 *     `tag` field) declares it; exact-match, not prefix-permissive
 *   • placement — union of `allowedTags` walking the folder chain
 *     (band ← category ← area ← system root), subtree semantics
 *   • the five-finding rule pack (NOT a tool): tag_unregistered,
 *     tag_out_of_scope, allowedTags_unregistered, registry_entry_untagged,
 *     registry_duplicate
 *   • registry-existence gate: an unseeded registry is a reportable state —
 *     no per-tag findings are forced (seeding deferred, Nelson 2026-08-19)
 *   • provider validation through VocabRegistry (good/bad config), and
 *     allowlist filtering through the tool layer
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scopeTagsProvider,
  scopeTagsFindings,
  validateScopeTagsConfig,
  DEFAULT_SCOPE_TAGS_CONFIG,
} from "../src/kernel/vocab/scope-tags.ts";
import { noteVocabFindings } from "../src/kernel/vocab/findings.ts";
import { VocabAmbiguousError } from "../src/kernel/vocab/provider.ts";
import { VocabRegistry } from "../src/kernel/vocab/registry.ts";
import { registerVocabTools } from "../src/mcp/tools-vocab.ts";

// ── fixture: mirrors the live vault's shapes (2026-08-19) ────────────────────
// Root scope note at the vault root; Scope/Area, Scope/Category, Scope/Band
// folder notes down one branch; Meta/Tag registry notes in a registries slot.

const REG = "00-09 System/00 System management/00.05 Registries for the system";

/** A registry note (live shape: `fileClass: Meta/Tag`, `tag` field). */
const tagNote = (path, tag, extra = {}) => ({
  path,
  frontmatter: { fileClass: "Meta/Tag", tag, ...extra },
});

function fixture({ rootAllowed = ["system"], seeded = true } = {}) {
  const notes = [
    // the scope chain — system root → area → category → band
    {
      path: "The system.md",
      frontmatter: { fileClass: "Scope/Root", ...(rootAllowed === null ? {} : { allowedTags: rootAllowed }) },
    },
    {
      path: "00-09 System/00-09 System.md",
      frontmatter: { fileClass: "Scope/Area", allowedTags: ["agent"] },
    },
    {
      path: "00-09 System/00 System management/00 System management.md",
      frontmatter: { fileClass: "Scope/Category", allowedTags: ["note"] },
    },
    {
      path: "00-09 System/00 System management/00.20 Band/00.20 Band.md",
      frontmatter: { fileClass: "Scope/Band", allowedTags: ["meta/tag"] },
    },
  ];
  if (seeded) {
    notes.push(
      tagNote(`${REG}/system.md`, "system"),
      tagNote(`${REG}/agent.md`, "agent"),
      tagNote(`${REG}/note.md`, "note"),
      tagNote(`${REG}/note task.md`, "note/task", { description: "Actionable work." }),
      tagNote(`${REG}/meta tag.md`, "meta/tag"),
      tagNote(`${REG}/archived.md`, "archived", { retired: true })
    );
  }
  return notes;
}

const provider = (extraNotes = [], opts = {}) =>
  scopeTagsProvider(DEFAULT_SCOPE_TAGS_CONFIG, [...fixture(opts), ...extraNotes]);

// ── config validation ────────────────────────────────────────────────────────

describe("validateScopeTagsConfig", () => {
  test("undefined and empty configs are valid", () => {
    assert.deepEqual(validateScopeTagsConfig(undefined), []);
    assert.deepEqual(validateScopeTagsConfig({}), []);
  });

  test("a full valid override is valid; unknown keys are ignored", () => {
    assert.deepEqual(
      validateScopeTagsConfig({
        registryClass: "Meta/Etikett",
        tagKey: "token",
        allowedTagsKey: "admits",
        rootNote: "Root.md",
        futureKnob: 7,
      }),
      []
    );
  });

  test("non-object, wrong-typed, and empty-string values are problems", () => {
    assert.match(validateScopeTagsConfig("x")[0], /object/);
    assert.match(validateScopeTagsConfig([])[0], /object/);
    assert.match(validateScopeTagsConfig({ tagKey: 42 })[0], /tagKey/);
    assert.match(validateScopeTagsConfig({ registryClass: " " })[0], /registryClass/);
    assert.match(validateScopeTagsConfig({ rootNote: 3 })[0], /rootNote/);
  });

  test('rootNote "" is valid — it means "no root scope note"', () => {
    assert.deepEqual(validateScopeTagsConfig({ rootNote: "" }), []);
  });
});

describe("VocabRegistry wiring", () => {
  test("a scope-tags row with good config builds an instance", () => {
    const reg = new VocabRegistry([{ id: "st", provider: "scope-tags", root: "" }]);
    const [inst] = reg.build(fixture());
    assert.equal(inst.providerName, "scope-tags");
    assert.equal(inst.provider.resolve("note/task", "tag").canonical, "note/task");
    assert.deepEqual(reg.problems, []);
  });

  test("a scope-tags row with bad config is skipped and reported, never thrown", () => {
    const reg = new VocabRegistry([
      { id: "bad", provider: "scope-tags", root: "", config: { tagKey: 42 } },
      { id: "st", provider: "scope-tags", root: "" },
    ]);
    assert.equal(reg.build(fixture()).length, 1);
    assert.equal(reg.problems.length, 1);
    assert.match(reg.problems[0], /bad/);
    assert.match(reg.problems[0], /tagKey/);
    assert.match(reg.problems[0], /skipped/);
  });

  test("config overrides flow through: a custom registry class and tag key", () => {
    const reg = new VocabRegistry([
      { id: "st", provider: "scope-tags", root: "", config: { registryClass: "Meta/Etikett", tagKey: "token" } },
    ]);
    const [inst] = reg.build([{ path: "R/x.md", frontmatter: { fileClass: "Meta/Etikett", token: "meta" } }]);
    assert.equal(inst.provider.resolve("meta", "tag").canonical, "meta");
  });

  test("the root confines the instance's listing", () => {
    const reg = new VocabRegistry([{ id: "st", provider: "scope-tags", root: REG }]);
    const [inst] = reg.build(fixture());
    // registry notes are under REG — visible; scope notes are outside it
    assert.equal(inst.provider.resolve("note", "tag").canonical, "note");
  });
});

// ── existence: registry entries, resolution ──────────────────────────────────

describe("registry existence", () => {
  test("a declared tag resolves to its entry with gloss and hierarchy", () => {
    const e = provider().resolve("note/task", "tag");
    assert.equal(e.canonical, "note/task");
    assert.equal(e.path, `${REG}/note task.md`);
    assert.equal(e.definition, "Actionable work.");
    assert.equal(e.parent, "note");
    assert.equal(e.deprecated, false);
  });

  test("existence is exact — a child of a registered tag does not exist by prefix", () => {
    const p = provider();
    assert.equal(p.resolve("note/clipping", "tag"), null);
    assert.equal(p.validateToken("note/clipping", "tag")[0].code, "tag_unregistered");
  });

  test("normalization strips # and whitespace", () => {
    const p = provider();
    assert.equal(p.resolve(" #note/task ", "tag").canonical, "note/task");
    assert.deepEqual(p.validateToken("#note", "tag"), []);
  });

  test("a retired registry entry validates as deprecated, not unregistered", () => {
    const f = provider().validateToken("archived", "tag");
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "deprecated");
  });

  test("two registry notes claiming one token refuse resolution — ambiguity", () => {
    const p = provider([tagNote(`${REG}/note dupe.md`, "note")]);
    assert.throws(() => p.resolve("note", "tag"), VocabAmbiguousError);
  });

  test("a wikilinked fileClass value still marks a registry note", () => {
    const p = scopeTagsProvider(DEFAULT_SCOPE_TAGS_CONFIG, [
      { path: "R/x.md", frontmatter: { fileClass: "[[00.10 Fileclasses/Meta/Tag.md|Tag]]", tag: "meta" } },
    ]);
    assert.equal(p.resolve("meta", "tag").canonical, "meta");
  });

  test("list is sorted and scope-filterable by declaring path", () => {
    const p = provider();
    const all = p.list("tag").map((e) => e.canonical);
    assert.deepEqual(all, [...all].sort());
    assert.ok(all.includes("note/task"));
    assert.deepEqual(p.list("tag", "Nowhere"), []);
    assert.equal(p.list("tag", REG).length, 6);
  });

  test("only kind 'tag' is served", () => {
    const p = provider();
    assert.deepEqual(p.kinds, ["tag"]);
    assert.deepEqual(p.validateToken("anything", "property"), []);
    assert.equal(p.resolve("note", "type"), null);
    assert.deepEqual(p.list("term"), []);
  });
});

// ── placement: chain union across the four levels, subtree edges ─────────────

const noteAt = (path, tags) => ({ path, frontmatter: { tags } });

/** Placement findings for one note against the fixture provider. */
const placement = (path, tags, extraNotes = [], opts = {}) =>
  provider(extraNotes, opts)
    .noteFindings(noteAt(path, tags))
    .filter((f) => f.code === "tag_out_of_scope");

describe("chain-union placement", () => {
  const BAND = "00-09 System/00 System management/00.20 Band/deep.md";

  test("a band-level note unions band + category + area + root", () => {
    // meta/tag (band), note (category), agent (area), system (root) all admit
    assert.deepEqual(placement(BAND, ["meta/tag", "note", "agent", "system"]), []);
  });

  test("a category-level note does not inherit the band's allowance", () => {
    const path = "00-09 System/00 System management/cat.md";
    const out = placement(path, ["meta/tag"]);
    assert.equal(out.length, 1);
    assert.equal(out[0].code, "tag_out_of_scope");
    assert.equal(out[0].token, "meta/tag");
    assert.equal(out[0].path, path);
  });

  test("an area-level note gets area + root, not category", () => {
    assert.deepEqual(placement("00-09 System/area.md", ["agent", "system"]), []);
    assert.equal(placement("00-09 System/area.md", ["note"]).length, 1);
  });

  test("a vault-root note gets the root note's set only", () => {
    assert.deepEqual(placement("loose.md", ["system"]), []);
    assert.equal(placement("loose.md", ["agent"]).length, 1);
  });

  test("subtree semantics — allowing `note` admits `note/task`, not `notebook`", () => {
    const cat = "00-09 System/00 System management/cat.md";
    assert.deepEqual(placement(cat, ["note/task"]), []);
    // `notebook` is unregistered, so it is existence's finding, not placement's
    const p = provider([tagNote(`${REG}/notebook.md`, "notebook")]);
    const out = p.noteFindings(noteAt(cat, ["notebook"]));
    assert.equal(out.length, 1);
    assert.equal(out[0].code, "tag_out_of_scope");
  });

  test("an exact allowed tag admits itself", () => {
    const band = "00-09 System/00 System management/00.20 Band/x.md";
    assert.deepEqual(placement(band, ["meta/tag"]), []);
  });

  test("a scope note validates against its own declaration too", () => {
    // the category folder-note itself may carry what it (or its chain) allows
    const catNote = "00-09 System/00 System management/00 System management.md";
    assert.deepEqual(placement(catNote, ["note/task", "agent"]), []);
  });

  test("an unregistered tag never fires placement — existence owns it", () => {
    assert.deepEqual(placement("loose.md", ["sprocket"]), []);
  });

  test("an undeclared chain leaves placement un-engaged — no findings", () => {
    // Elsewhere/ has no scope notes, and the root note declares nothing
    assert.deepEqual(placement("Elsewhere/deep/note.md", ["note/task"], [], { rootAllowed: null }), []);
  });

  test("a declared-but-empty chain admits nothing — registered tags are out of scope", () => {
    const out = placement("Elsewhere/note.md", ["note"], [{ path: "Elsewhere/Elsewhere.md", frontmatter: { allowedTags: [] } }], { rootAllowed: null });
    assert.equal(out.length, 1);
    assert.match(out[0].detail, /admits no tags/);
  });

  test("allowedTags on a NON-folder-note is not a scope declaration", () => {
    const stray = [{ path: "Elsewhere/stray.md", frontmatter: { allowedTags: ["note"] } }];
    // contributes nothing to the chain…
    assert.deepEqual(placement("Elsewhere/x.md", ["note"], stray, { rootAllowed: null }), []);
  });
});

// ── the five findings — fires and does-not-fire ──────────────────────────────

describe("the five-finding rule pack", () => {
  test("tag_unregistered — fires for an undeclared tag, anchored to the note", () => {
    const out = scopeTagsFindings([noteAt("loose.md", ["sprocket"])], provider());
    const f = out.find((x) => x.code === "tag_unregistered");
    assert.equal(f.token, "sprocket");
    assert.equal(f.path, "loose.md");
  });

  test("tag_unregistered — does not fire for a registered tag", () => {
    const out = scopeTagsFindings([noteAt("loose.md", ["system"])], provider());
    assert.equal(out.some((x) => x.code === "tag_unregistered"), false);
  });

  test("tag_out_of_scope — fires for registered-but-unadmitted; not for admitted", () => {
    const notes = [noteAt("00-09 System/a.md", ["meta/tag"]), noteAt("00-09 System/b.md", ["agent"])];
    const out = scopeTagsFindings(notes, provider());
    const codes = out.map((f) => [f.code, f.path]);
    assert.deepEqual(codes, [["tag_out_of_scope", "00-09 System/a.md"]]);
  });

  test("allowedTags_unregistered — fires on a scope note whitelisting an undeclared token", () => {
    const scope = { path: "Elsewhere/Elsewhere.md", frontmatter: { allowedTags: ["ghost", "note"] } };
    const out = scopeTagsFindings([scope], provider([scope]));
    const f = out.filter((x) => x.code === "allowedTags_unregistered");
    assert.equal(f.length, 1);
    assert.equal(f[0].token, "ghost");
    assert.equal(f[0].path, "Elsewhere/Elsewhere.md");
  });

  test("allowedTags_unregistered — does not fire when every whitelisted token is registered, nor on non-scope notes", () => {
    const scope = { path: "Elsewhere/Elsewhere.md", frontmatter: { allowedTags: ["note", "agent"] } };
    const stray = { path: "Elsewhere/stray.md", frontmatter: { allowedTags: ["ghost"] } };
    const out = scopeTagsFindings([scope, stray], provider([scope, stray]));
    assert.equal(out.some((x) => x.code === "allowedTags_unregistered"), false);
  });

  test("registry_entry_untagged — fires for a Meta/Tag note with no tag value; not for a tagged one", () => {
    const empty = { path: `${REG}/empty.md`, frontmatter: { fileClass: "Meta/Tag", tag: "" } };
    const missing = { path: `${REG}/missing.md`, frontmatter: { fileClass: "Meta/Tag" } };
    const out = scopeTagsFindings([], provider([empty, missing]));
    const f = out.filter((x) => x.code === "registry_entry_untagged");
    assert.deepEqual(f.map((x) => x.path).sort(), [`${REG}/empty.md`, `${REG}/missing.md`]);
    assert.equal(scopeTagsFindings([], provider()).some((x) => x.code === "registry_entry_untagged"), false);
  });

  test("registry_duplicate — one finding per duplicated token, naming every claimant", () => {
    const dupe = tagNote(`${REG}/note dupe.md`, "note");
    const out = scopeTagsFindings([], provider([dupe]));
    const f = out.filter((x) => x.code === "registry_duplicate");
    assert.equal(f.length, 1);
    assert.equal(f[0].token, "note");
    assert.match(f[0].detail, /note dupe\.md/);
    assert.match(f[0].detail, /2 registry notes/);
    assert.equal(scopeTagsFindings([], provider()).some((x) => x.code === "registry_duplicate"), false);
  });

  test("the pack emits ONLY the five specced codes", () => {
    const notes = [
      noteAt("loose.md", ["sprocket", "archived", "agent"]), // unregistered + deprecated + out-of-scope
      { path: "Elsewhere/Elsewhere.md", frontmatter: { allowedTags: ["ghost"] } },
    ];
    const p = provider([tagNote(`${REG}/note dupe.md`, "note"), { path: `${REG}/empty.md`, frontmatter: { fileClass: "Meta/Tag" } }, ...notes.slice(1)]);
    const codes = new Set(scopeTagsFindings(notes, p).map((f) => f.code));
    const five = ["tag_unregistered", "tag_out_of_scope", "allowedTags_unregistered", "registry_entry_untagged", "registry_duplicate"];
    for (const c of codes) assert.ok(five.includes(c), c);
    for (const c of five) assert.ok(codes.has(c), `missing ${c}`);
  });
});

// ── registry-existence gate: unseeded is a state, not drift ──────────────────

describe("unseeded registry gate", () => {
  test("with zero registry notes, no per-tag findings are forced", () => {
    const p = provider([], { seeded: false });
    assert.deepEqual(p.validateToken("anything", "tag"), []);
    assert.deepEqual(p.noteFindings(noteAt("loose.md", ["anything"])), []);
    assert.deepEqual(
      scopeTagsFindings([noteAt("loose.md", ["anything"])], p),
      []
    );
    assert.equal(p.list("tag").length, 0); // the reportable state: counts of 0
  });

  test("an untagged registry note still counts as seeded — its finding is the report", () => {
    const p = scopeTagsProvider(DEFAULT_SCOPE_TAGS_CONFIG, [
      { path: `${REG}/empty.md`, frontmatter: { fileClass: "Meta/Tag" } },
    ]);
    assert.equal(p.validateToken("anything", "tag")[0].code, "tag_unregistered");
    assert.equal(p.registryFindings()[0].code, "registry_entry_untagged");
  });
});

// ── integration: noteVocabFindings + the four tools ──────────────────────────

describe("noteVocabFindings integration", () => {
  test("placement findings flow through the generic per-note rule pack", () => {
    const findings = noteVocabFindings(noteAt("00-09 System/a.md", ["meta/tag", "sprocket"]), [provider()]);
    const codes = findings.map((f) => f.code).sort();
    assert.deepEqual(codes, ["tag_out_of_scope", "tag_unregistered"]);
    for (const f of findings) assert.equal(f.path, "00-09 System/a.md");
  });
});

describe("tool layer", () => {
  function server({ allowlist = [], notes = fixture() } = {}) {
    const files = Object.fromEntries(notes.map((n) => [n.path, n]));
    const calls = new Map();
    registerVocabTools(
      { registerTool: (name, def, handler) => calls.set(name, { def, handler }) },
      {
        paths: () => Object.keys(files),
        frontmatter: (p) => files[p]?.frontmatter ?? null,
        body: async () => null,
      },
      {
        getSettings: () => ({ readOnly: false, allowlist }),
        getVocabularies: () => [{ id: "scope-tags", provider: "scope-tags", root: "" }],
      }
    );
    return { call: (name, args = {}) => calls.get(name).handler(args, {}) };
  }

  test("obsidian_vocabularies enumerates the instance with counts", async () => {
    const res = await server().call("obsidian_vocabularies");
    const [inst] = res.structuredContent.vocabularies;
    assert.equal(inst.provider, "scope-tags");
    assert.deepEqual(inst.kinds, ["tag"]);
    assert.equal(inst.counts.tag, 6);
    assert.equal(inst.capabilities.hierarchical, true);
  });

  test("obsidian_validate_terms reports existence AND placement for a note", async () => {
    const notes = [...fixture(), noteAt("00-09 System/a.md", ["meta/tag", "sprocket", "agent"])];
    const res = await server({ notes }).call("obsidian_validate_terms", { path: "00-09 System/a.md" });
    const codes = res.structuredContent.findings.map((f) => f.code).sort();
    assert.deepEqual(codes, ["tag_out_of_scope", "tag_unregistered"]);
  });

  test("allowlist — a hidden registry note neither resolves nor counts (no existence oracle)", async () => {
    const allowlist = ["00-09 System/00 System management/00.05 Registries for the system"];
    // hide everything except the registry, then hide ONE registry note
    const hideNote = [
      "00-09 System/00 System management/00.05 Registries for the system/system.md",
      "00-09 System/00 System management/00.05 Registries for the system/agent.md",
      "00-09 System/00 System management/00.05 Registries for the system/note.md",
      "00-09 System/00 System management/00.05 Registries for the system/note task.md",
      "00-09 System/00 System management/00.05 Registries for the system/archived.md",
    ];
    const s = server({ allowlist: hideNote });
    const res = await s.call("obsidian_resolve_term", { token: "meta/tag", kind: "tag" });
    assert.equal(res.structuredContent.found, false);
    const counts = await s.call("obsidian_vocabularies");
    assert.equal(counts.structuredContent.vocabularies[0].counts.tag, 5); // meta/tag gone
    const full = await server({ allowlist }).call("obsidian_vocabularies");
    assert.equal(full.structuredContent.vocabularies[0].counts.tag, 6);
  });

  test("a list tag field repeating one token is a single declaration, not a self-duplicate (review fix)", () => {
    const p = scopeTagsProvider(DEFAULT_SCOPE_TAGS_CONFIG, [
      { path: "R/x.md", frontmatter: { fileClass: "Meta/Tag", tag: ["note", "note"] } },
    ]);
    assert.equal(p.resolve("note", "tag").canonical, "note");
    assert.equal(p.registryFindings().some((f) => f.code === "registry_duplicate"), false);
  });

  test("allowlist — a hidden scope note contributes nothing to the chain", async () => {
    // Band note hidden: a band-level note loses the band's meta/tag allowance
    const allowlist = [
      "The system.md",
      "00-09 System/00-09 System.md",
      "00-09 System/00 System management/00 System management.md",
      "00-09 System/00 System management/00.20 Band/deep.md",
      REG,
    ];
    const notes = [...fixture(), noteAt("00-09 System/00 System management/00.20 Band/deep.md", ["meta/tag"])];
    const res = await server({ allowlist, notes }).call("obsidian_validate_terms", {
      path: "00-09 System/00 System management/00.20 Band/deep.md",
    });
    assert.ok(res.structuredContent.findings.some((f) => f.code === "tag_out_of_scope"));
  });
});
