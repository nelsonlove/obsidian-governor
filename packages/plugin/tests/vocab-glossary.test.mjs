/**
 * vocab-glossary.test.mjs — the glossary VocabularyProvider
 * (kernel/vocab/glossary.ts), over the vault's TWO live term surfaces:
 *
 *   (a) `note/definition` notes — term = title (fallback: basename), gloss =
 *       `description` frontmatter, aliases = `aliases`; the definitional-note
 *       convention (43 live notes under the 03.06 glossary).
 *   (b) `## Terms` sections — `- **term** — definition` bullets in the Assent
 *       chapters (the current authority per the vault memory).
 *
 * The deleted obsidian-new `defines:`/`Terms.base` scheme is NOT here — the
 * entry shape leaves room for it, but v1 parses what the vault actually has.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { glossaryProvider } from "../src/kernel/vocab/glossary.ts";
import { VocabAmbiguousError } from "../src/kernel/vocab/provider.ts";

function notes(extra = []) {
  return [
    {
      path: "System/Glossary/Canonical.md",
      frontmatter: {
        title: "Canonical",
        description: "Canonical describes the status of holding authority for one specific claim.",
        tags: ["note/definition"],
      },
    },
    {
      path: "System/Glossary/Term.md",
      frontmatter: {
        title: "Term",
        description: "A term is a defined word in the controlled vocabulary of the system.",
        tags: ["note/definition"],
        aliases: ["Terms"],
      },
    },
    // an ordinary note — not a definition, contributes nothing
    { path: "Projects/Notes.md", frontmatter: { tags: ["project"] } },
    // a chapter with a ## Terms section
    {
      path: "Assent/4. The kernel.md",
      body:
        "# The kernel\n\nprose\n\n## Terms\n\n" +
        "- **drift** — disagreement between a projection and its source of record\n" +
        "- **rail** — the cross-entity conformance check\n\n" +
        "## Next section\n\n- **not-a-term** — bullets outside ## Terms don't count\n",
    },
    ...extra,
  ];
}

const provider = (extra) => glossaryProvider({ definitionTag: "note/definition" }, notes(extra));

describe("glossary provider: definition notes", () => {
  test("capabilities: definitions and deprecations, flat; kinds = term", () => {
    const p = provider();
    assert.deepEqual(p.capabilities, {
      validate: true,
      resolveDefinition: true,
      hierarchical: false,
      deprecations: true,
    });
    assert.deepEqual(p.kinds, ["term"]);
  });

  test("a note/definition note is a term entry: title, description, aliases", () => {
    const e = provider().resolve("Term", "term");
    assert.equal(e.canonical, "Term");
    assert.equal(e.kind, "term");
    assert.equal(e.path, "System/Glossary/Term.md");
    assert.equal(e.definition, "A term is a defined word in the controlled vocabulary of the system.");
    assert.deepEqual(e.aliases, ["Terms"]);
  });

  test("resolution is case-insensitive, canonical case is preserved", () => {
    const e = provider().resolve("canonical", "term");
    assert.equal(e.canonical, "Canonical");
  });

  test("an alias resolves to its entry", () => {
    const e = provider().resolve("terms", "term");
    assert.equal(e.canonical, "Term");
  });

  test("a title-less definition note falls back to its basename", () => {
    const p = provider([
      { path: "System/Glossary/Scope.md", frontmatter: { tags: ["note/definition"] } },
    ]);
    assert.equal(p.resolve("Scope", "term").canonical, "Scope");
  });

  test("a [superseded] definition note is deprecated, and validateToken flags it", () => {
    const p = provider([
      {
        path: "System/Glossary/[superseded] Locus.md",
        frontmatter: { title: "Locus", tags: ["note/definition"] },
      },
    ]);
    assert.equal(p.resolve("Locus", "term").deprecated, true);
    assert.equal(p.validateToken("Locus", "term")[0].code, "deprecated");
  });
});

describe("glossary provider: ## Terms sections", () => {
  test("a Terms bullet is a term entry anchored to its chapter", () => {
    const e = provider().resolve("drift", "term");
    assert.equal(e.canonical, "drift");
    assert.equal(e.path, "Assent/4. The kernel.md");
    assert.equal(e.definition, "disagreement between a projection and its source of record");
  });

  test("bullets outside the ## Terms section do not register", () => {
    assert.equal(provider().resolve("not-a-term", "term"), null);
  });

  test("list is sorted case-insensitively across both surfaces", () => {
    const terms = provider().list("term").map((e) => e.canonical);
    assert.deepEqual(terms, ["Canonical", "drift", "rail", "Term"]);
  });
});

describe("glossary provider: validation and ambiguity", () => {
  test("validateToken: a known term is clean, an unknown one is a finding", () => {
    assert.deepEqual(provider().validateToken("drift", "term"), []);
    const f = provider().validateToken("mystery", "term");
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "unknown_term");
  });

  test("two sources with two senses: resolve refuses, list keeps both", () => {
    const p = provider([
      {
        path: "Elsewhere/Chapter.md",
        body: "## Terms\n\n- **drift** — a different sense entirely\n",
      },
    ]);
    assert.throws(() => p.resolve("drift", "term"), VocabAmbiguousError);
    assert.equal(p.list("term").filter((e) => e.canonical === "drift").length, 2);
  });

  test("identical duplicate senses collapse instead of refusing", () => {
    const p = provider([
      {
        path: "Elsewhere/Chapter.md",
        body: "## Terms\n\n- **drift** — disagreement between a projection and its source of record\n",
      },
    ]);
    assert.equal(p.resolve("drift", "term").path, "Assent/4. The kernel.md");
  });

  test("resolve of a kind this provider does not serve is null", () => {
    assert.equal(provider().resolve("meta/type", "tag"), null);
  });
});
