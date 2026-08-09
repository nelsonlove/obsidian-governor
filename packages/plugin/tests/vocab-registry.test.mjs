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

  test("the defaults: one registry over the vault registries slot, one glossary", () => {
    assert.deepEqual(
      DEFAULT_VOCABULARIES.map((v) => [v.id, v.provider]),
      [
        ["registry", "blueprint"],
        ["glossary", "glossary"],
      ]
    );
    // The registry default must NOT point at gen3 — it moved (hard constraint).
    assert.doesNotMatch(DEFAULT_VOCABULARIES[0].root, /gen3/);
  });
});
