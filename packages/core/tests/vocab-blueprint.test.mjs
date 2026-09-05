/**
 * vocab-blueprint.test.mjs — the registry-blueprint VocabularyProvider
 * (kernel/vocab/blueprint.ts): the TS port of the vault's registry grammar.
 *
 * The grammar under test is the one the vault's own machinery defines, ported
 * from two sources that must stay in agreement:
 *   - `tag-macros.blueprint` `tag_for()` — tag notes are `<name>.tag.md`;
 *     `.tag`-suffixed parent folders are namespace segments; a folder note
 *     (leaf name == folder name) collapses to the namespace itself.
 *   - `drift_audit.py` `registered_tags()` / `tag_allowed()` — the same walk,
 *     plus prefix-permissive matching: `meta/type` is allowed when `meta` is
 *     registered.
 * Properties are flat `<key>.property.md`; types are `<Name>.fileclass` with
 * `extends` as the parent edge and `retired`/`mixin` flags (the `.type.md`
 * layer collapsed 2026-08-07).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { blueprintProvider } from "../src/vocab/blueprint.ts";
import { VocabAmbiguousError } from "../src/vocab/provider.ts";

const ROOT = "System/Registries";

/** A synthetic registry listing in the vault's real shapes. */
function notes(extra = []) {
  return [
    // tags — namespace folders end .tag; folder note collapses
    { path: `${ROOT}/Meta registry/meta.tag/meta.tag.md` },
    { path: `${ROOT}/Meta registry/meta.tag/type.tag.md` },
    { path: `${ROOT}/Collections/knowledge-base.tag/glossary.tag.md` },
    {
      path: `${ROOT}/Collections/note.tag/definition.tag.md`,
      frontmatter: { description: "A definitional note." },
    },
    // properties — flat
    {
      path: `${ROOT}/Meta registry/Property/acceptance-status.property.md`,
      frontmatter: { description: "Where an assertion stands." },
    },
    { path: `${ROOT}/Meta registry/Property/uid.property.md` },
    // types — .fileclass files; extends is the parent edge
    {
      path: `${ROOT}/Meta registry/Type/Default.fileclass`,
      body: "---\ntagNames: []\n---\n",
    },
    {
      path: `${ROOT}/Meta registry/Type/Task.fileclass`,
      body: '---\nextends: "[[Default.fileclass]]"\ndescription: A task note.\n---\n',
    },
    {
      path: `${ROOT}/Meta registry/Type/Legacy.fileclass`,
      body: "---\nextends: \"[[Default.fileclass]]\"\nretired: true\n---\n",
    },
    ...extra,
  ];
}

const provider = (extra) => blueprintProvider({ root: ROOT }, notes(extra));

describe("blueprint provider: tags", () => {
  test("capabilities: hierarchical, deprecations, definitions; kinds tag/property/type", () => {
    const p = provider();
    assert.deepEqual(p.capabilities, {
      validate: true,
      resolveDefinition: true,
      hierarchical: true,
      deprecations: true,
    });
    assert.deepEqual(p.kinds, ["tag", "property", "type"]);
  });

  test("a nested tag note registers its namespace path", () => {
    const e = provider().resolve("meta/type", "tag");
    assert.equal(e.canonical, "meta/type");
    assert.equal(e.kind, "tag");
    assert.equal(e.path, `${ROOT}/Meta registry/meta.tag/type.tag.md`);
    assert.equal(e.parent, "meta");
  });

  test("a folder note collapses to the namespace itself and is a root", () => {
    const e = provider().resolve("meta", "tag");
    assert.equal(e.canonical, "meta");
    assert.equal(e.path, `${ROOT}/Meta registry/meta.tag/meta.tag.md`);
    assert.equal(e.parent, null);
  });

  test("namespace folders count even without a folder note", () => {
    // knowledge-base.tag has no folder note, but glossary nests under it.
    const e = provider().resolve("knowledge-base/glossary", "tag");
    assert.equal(e.canonical, "knowledge-base/glossary");
    assert.equal(e.parent, "knowledge-base");
  });

  test("normalize strips a leading # and trims", () => {
    const p = provider();
    assert.equal(p.normalize("  #meta/type "), "meta/type");
    assert.equal(p.resolve("#meta/type", "tag").canonical, "meta/type");
  });

  test("validateToken: registered tag is clean", () => {
    assert.deepEqual(provider().validateToken("meta/type", "tag"), []);
  });

  test("validateToken: prefix-permissive — a child of a registered namespace passes", () => {
    // drift_audit tag_allowed(): `meta/anything` is allowed because `meta` is registered.
    assert.deepEqual(provider().validateToken("meta/unheard-of", "tag"), []);
  });

  test("validateToken: an unregistered root tag is a finding", () => {
    const f = provider().validateToken("rogue", "tag");
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "unregistered_tag");
    assert.equal(f[0].token, "rogue");
  });

  test("resolve: unknown tag is null, not a finding", () => {
    assert.equal(provider().resolve("rogue", "tag"), null);
  });

  test("list is sorted and carries the description as definition", () => {
    const tags = provider().list("tag").map((e) => e.canonical);
    assert.deepEqual(tags, ["knowledge-base/glossary", "meta", "meta/type", "note/definition"]);
    const def = provider().list("tag").find((e) => e.canonical === "note/definition");
    assert.equal(def.definition, "A definitional note.");
  });

  test("list with scope filters by declaring path prefix", () => {
    const tags = provider().list("tag", `${ROOT}/Collections`).map((e) => e.canonical);
    assert.deepEqual(tags, ["knowledge-base/glossary", "note/definition"]);
  });
});

describe("blueprint provider: properties", () => {
  test("a property entry registers its key, flat", () => {
    const e = provider().resolve("acceptance-status", "property");
    assert.equal(e.canonical, "acceptance-status");
    assert.equal(e.kind, "property");
    assert.equal(e.parent, null);
    assert.equal(e.definition, "Where an assertion stands.");
  });

  test("validateToken: unknown property is a finding, no prefix-permissiveness", () => {
    const f = provider().validateToken("acceptance", "property");
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "undefined_property");
  });
});

describe("blueprint provider: types", () => {
  test("a fileclass registers its name with extends as parent", () => {
    const e = provider().resolve("Task", "type");
    assert.equal(e.canonical, "Task");
    assert.equal(e.kind, "type");
    assert.equal(e.parent, "Default");
    assert.equal(e.definition, "A task note.");
    assert.equal(e.deprecated, false);
  });

  test("retired: true marks the entry deprecated, and validateToken flags it", () => {
    const e = provider().resolve("Legacy", "type");
    assert.equal(e.deprecated, true);
    const f = provider().validateToken("Legacy", "type");
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "deprecated");
  });

  test("validateToken: unknown type is a finding", () => {
    const f = provider().validateToken("Widget", "type");
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "unknown_type");
  });
});

describe("blueprint provider: edges", () => {
  test("two notes claiming one token: resolve refuses, list keeps both", () => {
    const p = provider([{ path: `${ROOT}/Elsewhere/meta.tag/type.tag.md` }]);
    assert.throws(() => p.resolve("meta/type", "tag"), VocabAmbiguousError);
    assert.equal(p.list("tag").filter((e) => e.canonical === "meta/type").length, 2);
  });

  test("notes outside the root are not vocabulary", () => {
    const p = provider([{ path: "Projects/rogue.tag.md" }]);
    assert.equal(p.resolve("rogue", "tag"), null);
  });

  test("an empty root means the whole listing", () => {
    const p = blueprintProvider({ root: "" }, [{ path: "anywhere/x.tag.md" }]);
    assert.equal(p.resolve("x", "tag").canonical, "x");
  });

  test("resolve of a kind this provider does not serve is null", () => {
    assert.equal(provider().resolve("anything", "term"), null);
  });
});
