import assert from "node:assert/strict";
import { test } from "node:test";
import { planSection } from "../src/kernel/survey/section.js";

test("planSection inserts a new section when none exists", () => {
  const plan = planSection("# Note\n\nSome prose.", "3 items.", undefined, false);
  assert.equal(plan.kind, "insert");
  assert.match(plan.newBody, /## Contents \(Filesystem\)/);
  assert.match(plan.newBody, /3 items\./);
});

test("planSection replaces an existing unprotected section, leaving the rest of the body alone", () => {
  const body = "# Note\n\nIntro.\n\n## Contents (Filesystem)\n\nOld stuff.\n\n## Next\n\nUnrelated.";
  const plan = planSection(body, "New stuff.", "skeleton", false);
  assert.equal(plan.kind, "replace");
  assert.match(plan.newBody, /Intro\./);
  assert.match(plan.newBody, /New stuff\./);
  assert.doesNotMatch(plan.newBody, /Old stuff\./);
  assert.match(plan.newBody, /## Next/);
  assert.match(plan.newBody, /Unrelated\./);
});

test("planSection refuses to touch a section stamped by claude-code, without force", () => {
  const body = "# Note\n\n## Contents (Filesystem)\n\nWritten by an agent.";
  const plan = planSection(body, "New stuff.", "claude-code", false);
  assert.equal(plan.kind, "protected");
  assert.equal(plan.newBody, null);
  assert.equal(plan.protectedBy, "claude-code");
});

test("planSection refuses to touch a section stamped by a human, without force", () => {
  const body = "# Note\n\n## Contents (Filesystem)\n\nHand-written.";
  const plan = planSection(body, "New stuff.", "human", false);
  assert.equal(plan.kind, "protected");
});

test("planSection overrides protection when force is true", () => {
  const body = "# Note\n\n## Contents (Filesystem)\n\nHand-written.";
  const plan = planSection(body, "New stuff.", "human", true);
  assert.equal(plan.kind, "replace");
  assert.match(plan.newBody, /New stuff\./);
});

test("planSection does not protect a skeleton-stamped section", () => {
  const body = "# Note\n\n## Contents (Filesystem)\n\nOld skeleton.";
  const plan = planSection(body, "New stuff.", "skeleton", false);
  assert.equal(plan.kind, "replace");
});

test("planSection insert on an empty body produces just the section, no leading blank lines", () => {
  const plan = planSection("", "5 items.", undefined, false);
  assert.equal(plan.kind, "insert");
  assert.equal(plan.newBody, "## Contents (Filesystem)\n\n5 items.\n");
});
