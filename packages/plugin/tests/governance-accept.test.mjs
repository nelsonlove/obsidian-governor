// The accept/revert primitives (#83, cycle 2). Ported from obsidian-stewardship/tests/accept.test.mjs.
// These are the pure functions the pane's gesture-gated Accept/Revert buttons call — headless-
// testable because accept.ts imports nothing from Obsidian. The gesture GATE itself (a synthetic
// event does NOT reach these) is proven in governance-gesture.test.mjs (runGuardedAdopt /
// isRealGesture) and structurally in governance-module.test.mjs (the buttons are addEventListener-
// wired and gate on isRealGesture).

import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptNote, revertNote, silentAdvanceRecord } from "../src/kernel/governance/accept.ts";
import { makeFakeWorld } from "./governance-helpers.mjs";

test("accept advances the baseline to current and logs", async () => {
  const w = makeFakeWorld({ "A.md": "current agent content" });
  w.seedBaseline("A.md", "old baseline");
  const res = await acceptNote(w.deps, "A.md");
  assert.equal(res.stamped, false);
  assert.equal(w.baselines.get("A.md").content, "current agent content");
  assert.equal(w.baselines.get("A.md").acceptedBy, "test-human");
  assert.equal(w.log.length, 1);
  assert.equal(w.log[0].action, "accept");
  assert.equal(w.log[0].by, "test-human");
});

test("accept stamps acceptance-status ONLY when the note carries the field", async () => {
  const withKey = "---\nacceptance-status: proposed\n---\nbody";
  const w = makeFakeWorld({ "A.md": withKey });
  w.seedBaseline("A.md", "---\nacceptance-status: proposed\n---\nold");
  const res = await acceptNote(w.deps, "A.md");
  assert.equal(res.stamped, true);
  // The note on disk was rewritten with accepted + provenance.
  assert.match(w.notes.get("A.md"), /acceptance-status: accepted/);
  assert.match(w.notes.get("A.md"), /accepted-by: test-human/);
  assert.match(w.notes.get("A.md"), /accepted-on: 2026-08-09/);
  // Baseline captured the STAMPED content (so it won't re-queue).
  assert.match(w.baselines.get("A.md").content, /acceptance-status: accepted/);
});

test("accept does NOT stamp (or rewrite) a note without acceptance-status", async () => {
  const w = makeFakeWorld({ "A.md": "plain body no frontmatter" });
  w.seedBaseline("A.md", "old");
  const res = await acceptNote(w.deps, "A.md");
  assert.equal(res.stamped, false);
  assert.equal(w.notes.get("A.md"), "plain body no frontmatter"); // untouched
});

test("revert restores baseline content and quarantines the rejected version — never deletes", async () => {
  const w = makeFakeWorld({ "A.md": "rejected agent content" });
  w.seedBaseline("A.md", "the good baseline");
  const res = await revertNote(w.deps, "A.md");
  // Note restored to baseline.
  assert.equal(w.notes.get("A.md"), "the good baseline");
  // Rejected content preserved in quarantine (existence, not deletion).
  assert.equal(w.quarantines.size, 1);
  assert.equal([...w.quarantines.values()][0], "rejected agent content");
  assert.equal(res.quarantine, [...w.quarantines.keys()][0]);
  assert.equal(w.log[0].action, "revert");
  assert.equal(w.log[0].quarantine, res.quarantine);
});

test("revert throws (does nothing destructive) when there is no baseline", async () => {
  const w = makeFakeWorld({ "A.md": "content" });
  await assert.rejects(() => revertNote(w.deps, "A.md"), /no baseline/);
  assert.equal(w.quarantines.size, 0);
  assert.equal(w.notes.get("A.md"), "content"); // untouched
});

// D2 — silent baseline advances (the human-edit reconcile path) must be auditable.
test("silentAdvanceRecord builds the audit record for a silent baseline advance", () => {
  const rec = silentAdvanceRecord({
    ts: "2026-08-09T12:00:00.000Z",
    path: "Notes/A.md",
    reason: "human-edit",
    fromHash: "oldhash",
    toHash: "newhash",
  });
  assert.deepEqual(rec, {
    event: "silent-advance",
    ts: "2026-08-09T12:00:00.000Z",
    path: "Notes/A.md",
    reason: "human-edit",
    fromHash: "oldhash",
    toHash: "newhash",
  });
});

test("silentAdvanceRecord records fromHash=null when there was no prior baseline", () => {
  const rec = silentAdvanceRecord({
    ts: "2026-08-09T12:00:00.000Z",
    path: "New.md",
    reason: "human-edit",
    fromHash: null,
    toHash: "h1",
  });
  assert.equal(rec.event, "silent-advance");
  assert.equal(rec.fromHash, null);
  assert.equal(rec.toHash, "h1");
});
