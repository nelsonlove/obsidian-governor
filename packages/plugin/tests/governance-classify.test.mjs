// Ported from obsidian-stewardship/tests/classify.test.mjs (#83, cycle 1) — the
// human-vs-agent modify classifier, now at src/kernel/governance/classify.ts. Pure
// logic; the silent-advance ACTION it gates on folds in with the accept path in cycle 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyModify, shouldAdvanceBaselineSilently } from "../src/kernel/governance/classify.ts";

test("recent agent journal write → agent (regardless of human-input signal)", () => {
  assert.equal(classifyModify({ recentAgentWrite: true, recentGenuineHumanInput: false }), "agent");
  assert.equal(classifyModify({ recentAgentWrite: true, recentGenuineHumanInput: true }), "agent");
});

test("no agent write + genuine human input on this path → human (silent advance)", () => {
  assert.equal(classifyModify({ recentAgentWrite: false, recentGenuineHumanInput: true }), "human");
  assert.equal(shouldAdvanceBaselineSilently(classifyModify({ recentAgentWrite: false, recentGenuineHumanInput: true })), true);
});

test("no agent write + NO genuine human input → ambiguous, NOT human (stays queued, fail safe)", () => {
  // This is the residual fix: absence of a journal record is NOT evidence of a human. Without a
  // real input event the change must never be attributed to a human / silently advanced — even
  // if the file happened to be the active editor (that fact is no longer consulted).
  const cls = classifyModify({ recentAgentWrite: false, recentGenuineHumanInput: false });
  assert.equal(cls, "ambiguous");
  assert.notEqual(cls, "human");
  assert.equal(shouldAdvanceBaselineSilently(cls), false);
});

test("ONLY human advances the baseline silently (err toward review otherwise)", () => {
  assert.equal(shouldAdvanceBaselineSilently("human"), true);
  assert.equal(shouldAdvanceBaselineSilently("agent"), false);
  assert.equal(shouldAdvanceBaselineSilently("ambiguous"), false);
});
