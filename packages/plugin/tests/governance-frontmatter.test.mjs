// Ported from obsidian-stewardship/tests/frontmatter.test.mjs (#83, cycle 1).
// Cycle 1 moved ONLY the non-accept frontmatter logic (parseNote/frontmatterKeys)
// into src/kernel/governance/frontmatter.ts; the acceptance-stamping helpers
// (hasAcceptanceStatus / stampAcceptance) were deliberately left in Stewardship for
// cycle 2 with accept.ts, so their tests are NOT ported here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNote, frontmatterKeys } from "../src/kernel/governance/frontmatter.ts";

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
