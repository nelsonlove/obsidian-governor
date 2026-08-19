/**
 * vocab-registry.test.mjs — VocabRegistry (kernel/vocab/registry.ts):
 * provider instances from settings, mirroring the scope-provider's `schemes`
 * settings shape: `{ id, provider, root, config }[]`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { VocabRegistry, DEFAULT_VOCABULARIES } from "../src/kernel/vocab/registry.ts";

const LISTING = [
  { path: "Reg/meta.tag/meta.tag.md" },
  { path: "Elsewhere/rogue.tag.md" },
  {
    path: "Glossary/Term.md",
    frontmatter: { title: "Term", description: "A defined word.", tags: ["note/definition"] },
  },
];

describe("VocabRegistry", () => {
  test("builds one instance per configured vocabulary, in order", () => {
    const reg = new VocabRegistry([
      { id: "reg", provider: "blueprint", root: "Reg" },
      { id: "gloss", provider: "glossary", root: "" },
    ]);
    const instances = reg.build(LISTING);
    assert.deepEqual(
      instances.map((i) => [i.id, i.providerName]),
      [
        ["reg", "blueprint"],
        ["gloss", "glossary"],
      ]
    );
  });

  test("the root confines an instance's vocabulary", () => {
    const reg = new VocabRegistry([{ id: "reg", provider: "blueprint", root: "Reg" }]);
    const [inst] = reg.build(LISTING);
    assert.equal(inst.provider.resolve("meta", "tag").canonical, "meta");
    assert.equal(inst.provider.resolve("rogue", "tag"), null);
  });

  test("glossary config flows through: a custom definition tag", () => {
    const reg = new VocabRegistry([
      { id: "g", provider: "glossary", root: "", config: { definitionTag: "kb/term" } },
    ]);
    const [inst] = reg.build([
      { path: "A.md", frontmatter: { title: "Alpha", tags: ["kb/term"] } },
      { path: "B.md", frontmatter: { title: "Beta", tags: ["note/definition"] } },
    ]);
    assert.equal(inst.provider.resolve("Alpha", "term").canonical, "Alpha");
    assert.equal(inst.provider.resolve("Beta", "term"), null);
  });

  test("an unknown provider name is skipped and reported, never thrown", () => {
    const reg = new VocabRegistry([
      { id: "x", provider: "sparkle", root: "" },
      { id: "reg", provider: "blueprint", root: "Reg" },
    ]);
    assert.equal(reg.build(LISTING).length, 1);
    assert.equal(reg.problems.length, 1);
    assert.match(reg.problems[0], /sparkle/);
  });

  test("a duplicate id is skipped and reported — first declaration wins", () => {
    const reg = new VocabRegistry([
      { id: "reg", provider: "blueprint", root: "Reg" },
      { id: "reg", provider: "glossary", root: "" },
    ]);
    const instances = reg.build(LISTING);
    assert.deepEqual(instances.map((i) => i.providerName), ["blueprint"]);
    assert.equal(reg.problems.length, 1);
  });

  test("the defaults: the live scope-tags model, one glossary (2026-08-19 correction)", () => {
    assert.deepEqual(
      DEFAULT_VOCABULARIES.map((v) => [v.id, v.provider]),
      [
        ["scope-tags", "scope-tags"],
        ["glossary", "glossary"],
      ]
    );
    // Stale-defaults regression pins: never gen3, never the dead 00.05
    // registries slot (emptied by the 2026-08 reorganizations), never the
    // vault-root Assent tree (refiled to 00.89).
    for (const row of DEFAULT_VOCABULARIES) {
      assert.doesNotMatch(row.root, /gen3/);
      assert.doesNotMatch(row.root, /00\.05 Registries/);
    }
    assert.match(String(DEFAULT_VOCABULARIES[1].config?.termsRoot), /00\.89 Assent/);
  });

  test("the defaults parse a fixture mirroring the live vault shapes", () => {
    // The live model, in miniature: a Meta/Tag registry note, the root scope
    // note + a category folder-note carrying allowedTags, a definition note.
    const reg = new VocabRegistry(DEFAULT_VOCABULARIES);
    assert.deepEqual(reg.problems, []);
    const instances = reg.build([
      { path: "The system.md", frontmatter: { fileClass: "Scope/Root", allowedTags: ["system"] } },
      {
        path: "00-09 System/00 System management/00 System management.md",
        frontmatter: { fileClass: "Scope/Category", allowedTags: [] },
      },
      {
        path: "00-09 System/00 System management/00.01-00.09 Operations/00.05 Registries for the system/note task.md",
        frontmatter: { fileClass: "Meta/Tag", tag: "note/task", description: "Actionable work." },
      },
      {
        path: "00-09 System/01 System architecture/Glossary/Canonical.md",
        frontmatter: { title: "Canonical", description: "Holding authority.", tags: ["note/definition"] },
      },
    ]);
    const tags = instances.find((i) => i.id === "scope-tags");
    assert.equal(tags.provider.resolve("note/task", "tag").canonical, "note/task");
    assert.equal(tags.provider.list("tag").length, 1);
    const gloss = instances.find((i) => i.id === "glossary");
    assert.equal(gloss.provider.resolve("Canonical", "term").definition, "Holding authority.");
  });
});

describe("review fixes — pinned", () => {
  test("an unknown-provider row still reserves its id — later reuse reports as duplicate", () => {
    const reg = new VocabRegistry([
      { id: "reg", provider: "sparkle", root: "" },
      { id: "reg", provider: "blueprint", root: "Reg" },
    ]);
    assert.equal(reg.build(LISTING).length, 0);
    assert.equal(reg.problems.length, 2);
    assert.match(reg.problems[1], /duplicate/);
  });
});
