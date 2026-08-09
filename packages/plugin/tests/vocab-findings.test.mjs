/**
 * vocab-findings.test.mjs — noteVocabFindings (kernel/vocab/findings.ts): the
 * pure conformance findings over one note's vocabulary use. NOT a tool — per
 * the Conformance README, capabilities arrive as rule packs, never as new
 * surface; the rail mounts this later.
 *
 * Aligned with the rail's existing checks: unregistered_tag matches
 * drift_audit's check H semantics (prefix-permissive, report-only); the
 * undefined_property / unknown_type checks are the registration gap the rail
 * does not cover today (its check G only validates naming self-consistency).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { blueprintProvider } from "../src/kernel/vocab/blueprint.ts";
import { noteVocabFindings } from "../src/kernel/vocab/findings.ts";

const REGISTRY = [
  { path: "Reg/meta.tag/meta.tag.md" },
  { path: "Reg/meta.tag/type.tag.md" },
  { path: "Reg/title.property.md" },
  { path: "Reg/tags.property.md" },
  { path: "Reg/uid.property.md" },
  { path: "Reg/Default.fileclass", body: "---\n---\n" },
  {
    path: "Reg/Legacy.fileclass",
    body: "---\nextends: \"[[Default.fileclass]]\"\nretired: true\n---\n",
  },
];

const providers = () => [blueprintProvider({ root: "Reg" }, REGISTRY)];

function findings(frontmatter) {
  return noteVocabFindings({ path: "Notes/N.md", frontmatter }, providers());
}

describe("noteVocabFindings", () => {
  test("a fully registered note is clean", () => {
    assert.deepEqual(
      findings({ title: "N", uid: "u", tags: ["meta/type", "meta/anything-nested"] }),
      []
    );
  });

  test("an unregistered tag is a finding carrying the note path", () => {
    const f = findings({ title: "N", tags: ["rogue"] });
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "unregistered_tag");
    assert.equal(f[0].token, "rogue");
    assert.equal(f[0].path, "Notes/N.md");
  });

  test("an unregistered frontmatter key is an undefined_property finding", () => {
    const f = findings({ title: "N", sprocket: 1 });
    assert.deepEqual(
      f.map((x) => [x.code, x.token]),
      [["undefined_property", "sprocket"]]
    );
  });

  test("fileClass wikilinks are checked as types, basename-resolved", () => {
    const clean = findings({ title: "N", fileClass: ["[[Anywhere/Default.fileclass]]"] });
    assert.equal(clean.filter((x) => x.code === "unknown_type").length, 0);
    const f = findings({ title: "N", fileClass: ["[[gone/Widget.fileclass]]"] });
    assert.deepEqual(
      f.map((x) => [x.code, x.token]),
      [["unknown_type", "Widget"]]
    );
  });

  test("a retired type in use is a deprecated finding", () => {
    const f = findings({ title: "N", fileClass: ["[[Reg/Legacy.fileclass]]"] });
    assert.deepEqual(
      f.map((x) => [x.code, x.token]),
      [["deprecated", "Legacy"]]
    );
  });

  test("a whitespace tag is malformed, not merely unregistered", () => {
    const f = findings({ title: "N", tags: ["not a tag"] });
    assert.equal(f[0].code, "malformed_token");
  });

  test("fileClass is not double-counted as an undefined property when a type serves it", () => {
    // `fileClass` itself is not in the property registry above, but it IS the
    // type-bearing key — flagging it as undefined_property beside the type
    // check would be noise. It is exempt, like nothing else is.
    const f = findings({ title: "N", fileClass: ["[[Reg/Default.fileclass]]"] });
    assert.deepEqual(f, []);
  });

  test("no providers serving a kind means no findings for that kind", () => {
    const none = noteVocabFindings({ path: "Notes/N.md", frontmatter: { anything: 1, tags: ["x"] } }, []);
    assert.deepEqual(none, []);
  });

  test("a null frontmatter is clean", () => {
    assert.deepEqual(noteVocabFindings({ path: "Notes/N.md", frontmatter: null }, providers()), []);
  });
});
