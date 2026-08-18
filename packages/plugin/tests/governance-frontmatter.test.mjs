// Ported from obsidian-stewardship/tests/frontmatter.test.mjs (#83, cycle 1).
// The acceptance convergence (#221/#164) removed the string-rewriting stampAcceptance
// helper (production stamping is wiring.ts's processFrontMatter-based
// stampAcceptedFrontmatter); this file now also pins the two READ-ONLY lifecycle helpers
// the context-aware Accept decides with: acceptanceStatusOf (which lifecycle branch) and
// missingRequiredKeys (the conformance gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNote,
  frontmatterKeys,
  acceptanceStatusOf,
  missingRequiredKeys,
} from "../src/kernel/governance/frontmatter.ts";

test("parseNote splits frontmatter and body", () => {
  const n = parseNote("---\ntitle: A\ntags: [x]\n---\nbody line 1\nbody line 2");
  assert.equal(n.hasFrontmatter, true);
  assert.match(n.frontmatterText, /title: A/);
  assert.equal(n.body, "body line 1\nbody line 2");
});

test("parseNote handles no frontmatter", () => {
  const n = parseNote("just a body\nmore");
  assert.equal(n.hasFrontmatter, false);
  assert.equal(n.body, "just a body\nmore");
});

test("frontmatterKeys captures top-level keys including multi-line list values", () => {
  const keys = frontmatterKeys("author:\n  - a\n  - b\nname: X");
  assert.equal(keys.get("name"), "X");
  assert.match(keys.get("author"), /- a/);
  assert.match(keys.get("author"), /- b/);
});

// ── acceptanceStatusOf — the context-aware Accept's branch decision (#221/#164) ──

test("acceptanceStatusOf reads the scalar status value (trimmed, unquoted)", () => {
  assert.equal(acceptanceStatusOf("---\nacceptance-status: proposed\n---\nbody"), "proposed");
  assert.equal(acceptanceStatusOf("---\nacceptance-status: revising\n---\nbody"), "revising");
  assert.equal(acceptanceStatusOf('---\nacceptance-status: "proposed"\n---\nbody'), "proposed");
  assert.equal(acceptanceStatusOf("---\nacceptance-status:  proposed  \n---\nbody"), "proposed");
});

test("acceptanceStatusOf is null with no frontmatter or no acceptance-status key", () => {
  assert.equal(acceptanceStatusOf("plain body"), null);
  assert.equal(acceptanceStatusOf("---\ntitle: T\n---\nbody"), null);
});

// ── missingRequiredKeys — the conformance gate (#221/#164) ──

test("missingRequiredKeys: empty key list gates nothing", () => {
  assert.deepEqual(missingRequiredKeys("plain body", []), []);
});

test("missingRequiredKeys: present + non-empty keys pass; absent keys are named", () => {
  const note = "---\nuid: 0198a2b3\ntitle: A note\n---\nbody";
  assert.deepEqual(missingRequiredKeys(note, ["uid", "title"]), []);
  assert.deepEqual(missingRequiredKeys(note, ["uid", "description"]), ["description"]);
});

test("missingRequiredKeys: blank / quoted-empty / null-ish values count as missing", () => {
  for (const v of ["", '""', "''", "null", "~", "[]", "{}"]) {
    const note = `---\nuid: ${v}\n---\nbody`;
    assert.deepEqual(missingRequiredKeys(note, ["uid"]), ["uid"], `value ${JSON.stringify(v)} must count as empty`);
  }
});

test("missingRequiredKeys: a note with no frontmatter is missing every required key", () => {
  assert.deepEqual(missingRequiredKeys("plain body", ["uid", "title"]), ["uid", "title"]);
});
