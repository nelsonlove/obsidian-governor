/**
 * vocab-tools.test.mjs — the vocabulary read surface (mcp/tools-vocab.ts):
 * four read-only, allowlist-filtered tools over the vocab registry.
 *
 *   • obsidian_vocabularies    — enumerate configured vocab sources
 *   • obsidian_resolve_term    — token → entry; path → its terms; parse mode
 *   • obsidian_validate_terms  — one note's frontmatter → findings
 *   • obsidian_list_vocabulary — entries of a kind, optionally scoped
 *
 * The allowlist rule is the uid tools' rule: the LISTING is filtered before
 * any provider sees it, so a vocabulary entry declared outside the allowlist
 * neither resolves nor appears in lists/examples — no path oracle. findings.ts
 * is NOT registered (rule pack, not surface).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerVocabTools } from "../src/mcp/tools-vocab.ts";

const REG_ROOT = "System/Registries";

/** A hand-driven VocabSource over a synthetic vault. */
function fakeSource() {
  const files = {
    [`${REG_ROOT}/Meta registry/meta.tag/meta.tag.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/meta.tag/type.tag.md`]: {
      frontmatter: { description: "Registry-machinery tag namespace." },
    },
    [`${REG_ROOT}/Meta registry/note.tag/definition.tag.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/title.property.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/tags.property.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/Default.fileclass`]: { body: "---\n---\n" },
    [`${REG_ROOT}/Hidden registry/secret.tag.md`]: { frontmatter: {} },
    "Glossary/Canonical.md": {
      frontmatter: {
        title: "Canonical",
        description: "Holding authority for one specific claim.",
        tags: ["note/definition"],
      },
    },
    "Assent/4. The kernel.md": {
      body: "## Terms\n\n- **drift** — disagreement between projection and source\n",
    },
    "Notes/Tagged.md": { frontmatter: { title: "T", tags: ["meta/type", "rogue"] } },
  };
  return {
    paths: () => Object.keys(files),
    frontmatter: (p) => files[p]?.frontmatter ?? null,
    body: async (p) => files[p]?.body ?? null,
  };
}

const VOCABS = [
  { id: "reg", provider: "blueprint", root: REG_ROOT },
  { id: "gloss", provider: "glossary", root: "", config: { termsRoot: "Assent" } },
];

function vocabServer({ allowlist = [], vocabularies = VOCABS } = {}) {
  const calls = new Map();
  registerVocabTools(
    { registerTool: (name, def, handler) => calls.set(name, { def, handler }) },
    fakeSource(),
    {
      getSettings: () => ({ readOnly: false, allowlist }),
      getVocabularies: () => vocabularies,
    }
  );
  return {
    calls,
    call: (name, args = {}) => calls.get(name).handler(args, {}),
  };
}

describe("registration", () => {
  test("exactly the four read-only tools, and no accept/approve/grant vocabulary", () => {
    const { calls } = vocabServer();
    assert.deepEqual(
      [...calls.keys()].sort(),
      ["obsidian_list_vocabulary", "obsidian_resolve_term", "obsidian_validate_terms", "obsidian_vocabularies"]
    );
    for (const [name, { def }] of calls) {
      assert.equal(def.annotations.readOnlyHint, true, name);
      const text = `${name} ${def.title} ${def.description}`.toLowerCase();
      for (const banned of ["grant", "approve", "accept "]) {
        assert.equal(text.includes(banned), false, `${name}: ${banned}`);
      }
    }
  });
});

describe("obsidian_vocabularies", () => {
  test("enumerates instances with capabilities, counts and examples", async () => {
    const res = await vocabServer().call("obsidian_vocabularies");
    assert.equal(res.isError, undefined);
    const [reg, gloss] = res.structuredContent.vocabularies;
    assert.equal(reg.id, "reg");
    assert.equal(reg.provider, "blueprint");
    assert.equal(reg.capabilities.hierarchical, true);
    assert.equal(reg.counts.tag, 4); // meta, meta/type, note/definition, secret
    assert.equal(reg.counts.property, 2);
    assert.equal(reg.counts.type, 1);
    assert.ok(reg.examples.tag.includes("meta/type"));
    assert.equal(gloss.id, "gloss");
    assert.equal(gloss.counts.term, 2); // Canonical + drift
  });

  test("a settings problem is reported, not thrown", async () => {
    const res = await vocabServer({
      vocabularies: [...VOCABS, { id: "x", provider: "sparkle", root: "" }],
    }).call("obsidian_vocabularies");
    assert.equal(res.structuredContent.problems.length, 1);
  });
});

describe("obsidian_resolve_term", () => {
  test("token + kind resolves to the entry, naming its vocabulary", async () => {
    const res = await vocabServer().call("obsidian_resolve_term", { token: "meta/type", kind: "tag" });
    const sc = res.structuredContent;
    assert.equal(sc.found, true);
    assert.equal(sc.entry.canonical, "meta/type");
    assert.equal(sc.entry.definition, "Registry-machinery tag namespace.");
    assert.equal(sc.vocabulary, "reg");
  });

  test("kind omitted searches every kind and still resolves a unique token", async () => {
    const res = await vocabServer().call("obsidian_resolve_term", { token: "drift" });
    assert.equal(res.structuredContent.entry.kind, "term");
  });

  test("an unknown token is found:false, not an error", async () => {
    const res = await vocabServer().call("obsidian_resolve_term", { token: "sprocket", kind: "tag" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.found, false);
  });

  test("parse mode validates without resolving", async () => {
    const res = await vocabServer().call("obsidian_resolve_term", {
      token: "rogue",
      kind: "tag",
      parse: true,
    });
    const sc = res.structuredContent;
    assert.equal(sc.valid, false);
    assert.equal(sc.findings[0].code, "unregistered_tag");
    assert.equal(sc.entry, undefined);
  });

  test("path mode reports the note's own vocabulary, resolved", async () => {
    const res = await vocabServer().call("obsidian_resolve_term", { path: "Notes/Tagged.md" });
    const terms = res.structuredContent.terms;
    const tagTokens = terms.filter((t) => t.kind === "tag").map((t) => t.token);
    assert.deepEqual(tagTokens.sort(), ["meta/type", "rogue"]);
    assert.equal(terms.find((t) => t.token === "meta/type").found, true);
    assert.equal(terms.find((t) => t.token === "rogue").found, false);
  });

  test("token and path together refuse", async () => {
    const res = await vocabServer().call("obsidian_resolve_term", { token: "x", path: "Notes/Tagged.md" });
    assert.equal(res.isError, true);
  });

  test("an ambiguous token is a coded refusal naming the candidates", async () => {
    const vocabularies = [
      ...VOCABS,
      { id: "reg2", provider: "blueprint", root: `${REG_ROOT}/Meta registry` },
    ];
    const res = await vocabServer({ vocabularies }).call("obsidian_resolve_term", {
      token: "meta/type",
      kind: "tag",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[vocab_ambiguous\]/);
  });
});

describe("obsidian_validate_terms", () => {
  test("a note's frontmatter yields findings anchored to the note", async () => {
    const res = await vocabServer().call("obsidian_validate_terms", { path: "Notes/Tagged.md" });
    const sc = res.structuredContent;
    assert.equal(sc.path, "Notes/Tagged.md");
    const codes = sc.findings.map((f) => f.code);
    assert.ok(codes.includes("unregistered_tag")); // rogue
    assert.equal(sc.findings.find((f) => f.code === "unregistered_tag").path, "Notes/Tagged.md");
  });

  test("a registered tag raises no tag finding; unregistered keys still do", async () => {
    const res = await vocabServer().call("obsidian_validate_terms", {
      path: "Glossary/Canonical.md",
    });
    const findings = res.structuredContent.findings;
    // `note/definition` is registered (note.tag/definition.tag.md) — clean.
    assert.equal(findings.some((f) => f.code === "unregistered_tag"), false);
    // `description` is not in the fixture's property registry — flagged.
    assert.ok(findings.some((f) => f.code === "undefined_property" && f.token === "description"));
  });
});

describe("allowlist", () => {
  test("a vocabulary entry outside the allowlist neither resolves nor lists", async () => {
    const allowlist = [`${REG_ROOT}/Meta registry`, "Glossary", "Assent", "Notes"];
    const s = vocabServer({ allowlist });
    const res = await s.call("obsidian_resolve_term", { token: "secret", kind: "tag" });
    assert.equal(res.structuredContent.found, false);
    const list = await s.call("obsidian_list_vocabulary", { kind: "tag" });
    const tags = list.structuredContent.entries.map((e) => e.canonical);
    assert.equal(tags.includes("secret"), false);
    assert.ok(tags.includes("meta/type"));
  });

  test("counts and examples are visible-filtered too", async () => {
    const allowlist = [`${REG_ROOT}/Meta registry`];
    const res = await vocabServer({ allowlist }).call("obsidian_vocabularies");
    assert.equal(res.structuredContent.vocabularies[0].counts.tag, 3); // secret gone
  });

  test("validating a hidden note refuses, coded", async () => {
    const res = await vocabServer({ allowlist: ["Glossary"] }).call("obsidian_validate_terms", {
      path: "Notes/Tagged.md",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
  });
});

describe("obsidian_list_vocabulary", () => {
  test("lists a kind sorted, with the declaring vocabulary named", async () => {
    const res = await vocabServer().call("obsidian_list_vocabulary", { kind: "term" });
    const entries = res.structuredContent.entries;
    assert.deepEqual(entries.map((e) => e.canonical), ["Canonical", "drift"]);
    assert.equal(entries[0].vocabulary, "gloss");
  });

  test("scope confines the listing by declaring path", async () => {
    const res = await vocabServer().call("obsidian_list_vocabulary", {
      kind: "term",
      scope: "Assent",
    });
    assert.deepEqual(res.structuredContent.entries.map((e) => e.canonical), ["drift"]);
  });

  test("vocabulary narrows to one instance", async () => {
    const res = await vocabServer().call("obsidian_list_vocabulary", {
      kind: "tag",
      vocabulary: "gloss",
    });
    assert.deepEqual(res.structuredContent.entries, []);
  });
});

describe("review fixes — pinned", () => {
  test("parse mode with no vocabulary serving the kind is vacuously valid, not silently invalid", async () => {
    const only = [{ id: "reg", provider: "blueprint", root: REG_ROOT }];
    const res = await vocabServer({ vocabularies: only }).call("obsidian_resolve_term", {
      token: "drift",
      kind: "term",
      parse: true,
    });
    assert.equal(res.structuredContent.valid, true);
    assert.deepEqual(res.structuredContent.findings, []);
  });

  test("path mode reports string-form tags frontmatter like its sibling tools", async () => {
    const calls = new Map();
    const files = {
      [`${REG_ROOT}/Meta registry/meta.tag/meta.tag.md`]: { frontmatter: {} },
      "Notes/S.md": { frontmatter: { tags: "meta" } },
    };
    registerVocabTools(
      { registerTool: (name, def, handler) => calls.set(name, { def, handler }) },
      {
        paths: () => Object.keys(files),
        frontmatter: (p) => files[p]?.frontmatter ?? null,
        body: async () => null,
      },
      { getVocabularies: () => [{ id: "reg", provider: "blueprint", root: REG_ROOT }] }
    );
    const res = await calls.get("obsidian_resolve_term").handler({ path: "Notes/S.md" }, {});
    const tagTerms = res.structuredContent.terms.filter((t) => t.kind === "tag");
    assert.deepEqual(tagTerms.map((t) => [t.token, t.found]), [["meta", true]]);
  });
});
