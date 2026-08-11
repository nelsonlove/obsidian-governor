// Ported from obsidian-stewardship/tests/auto-accept-detectors.test.mjs (#83, cycle 1) —
// per-class CONSERVATIVE detectors, now at src/kernel/governance/auto-accept/detectors.ts.
// For EACH class: a genuine positive AND a battery of "almost-mechanical-but-not" cases that
// MUST return false (→ the change stays PENDING). A detector that ever returns true for a case
// with ANY residual content change is a critical defect.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectUidStamp,
  detectTimestamp,
  detectCanonicalOrder,
  detectLinkHeal,
  isValidUuidV7,
  isValidTimestamp,
} from "../src/kernel/governance/auto-accept/detectors.ts";

const UID = "019fea8c-2093-758a-8da2-e8dbcddda6b4"; // valid UUIDv7 (version nibble 7, variant 8)

// ---------------------------------------------------------------------------
// value validators
// ---------------------------------------------------------------------------
test("isValidUuidV7 accepts a real v7 and rejects v4 / garbage / content", () => {
  assert.equal(isValidUuidV7(UID), true);
  assert.equal(isValidUuidV7('"' + UID + '"'), true); // quoted
  assert.equal(isValidUuidV7("550e8400-e29b-41d4-a716-446655440000"), false); // v4 (version 4)
  assert.equal(isValidUuidV7("not-a-uuid"), false);
  assert.equal(isValidUuidV7(UID + " and evil text"), false);
  assert.equal(isValidUuidV7(""), false);
});

test("isValidTimestamp accepts ISO date/datetime, rejects arbitrary text", () => {
  assert.equal(isValidTimestamp("2026-08-10"), true);
  assert.equal(isValidTimestamp("2026-08-10T12:34:56Z"), true);
  assert.equal(isValidTimestamp("2026-08-10T12:34:56.789+02:00"), true);
  assert.equal(isValidTimestamp("today"), false);
  assert.equal(isValidTimestamp("2026-08-10 rm -rf /"), false);
  assert.equal(isValidTimestamp("<script>alert(1)</script>"), false);
});

// ---------------------------------------------------------------------------
// uid-stamp
// ---------------------------------------------------------------------------
test("uid-stamp POSITIVE: only a valid uid added, body byte-identical", () => {
  const base = `---\ntitle: Note\n---\nbody text\n`;
  const cur = `---\ntitle: Note\nuid: ${UID}\n---\nbody text\n`;
  assert.equal(detectUidStamp(base, cur), true);
});

test("uid-stamp POSITIVE: adds a fresh frontmatter block on a note that had none", () => {
  const base = `# Note\nbody text\n`;
  const cur = `---\nuid: ${UID}\n---\n# Note\nbody text\n`;
  assert.equal(detectUidStamp(base, cur), true);
});

test("uid-stamp NEGATIVE: uid add PLUS one body word changed → pending", () => {
  const base = `---\ntitle: Note\n---\nthe quick brown fox\n`;
  const cur = `---\ntitle: Note\nuid: ${UID}\n---\nthe quick RED fox\n`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("uid-stamp NEGATIVE: uid add PLUS another frontmatter field changed → pending", () => {
  const base = `---\ntitle: Note\nstatus: draft\n---\nbody\n`;
  const cur = `---\ntitle: Note\nstatus: final\nuid: ${UID}\n---\nbody\n`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("uid-stamp NEGATIVE: uid CHANGE (already present) is never mechanical → pending", () => {
  const base = `---\nuid: ${UID}\n---\nbody\n`;
  const cur = `---\nuid: 019fffff-2093-758a-8da2-e8dbcddda6b4\n---\nbody\n`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("uid-stamp NEGATIVE: syntactically INVALID uid (v4) → pending", () => {
  const base = `---\ntitle: Note\n---\nbody\n`;
  const cur = `---\ntitle: Note\nuid: 550e8400-e29b-41d4-a716-446655440000\n---\nbody\n`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("uid-stamp NEGATIVE: uid value carries extra smuggled text → pending", () => {
  const base = `---\ntitle: Note\n---\nbody\n`;
  const cur = `---\ntitle: Note\nuid: ${UID} EXTRA\n---\nbody\n`;
  assert.equal(detectUidStamp(base, cur), false);
});

// ---------------------------------------------------------------------------
// timestamp
// ---------------------------------------------------------------------------
test("timestamp POSITIVE: modified value updated only", () => {
  const base = `---\ntitle: N\nmodified: 2026-01-01\n---\nbody\n`;
  const cur = `---\ntitle: N\nmodified: 2026-08-10\n---\nbody\n`;
  assert.equal(detectTimestamp(base, cur), true);
});

test("timestamp POSITIVE: created added-when-absent (+ modified updated)", () => {
  const base = `---\ntitle: N\nmodified: 2026-01-01\n---\nbody\n`;
  const cur = `---\ntitle: N\nmodified: 2026-08-10\ncreated: 2026-08-10\n---\nbody\n`;
  assert.equal(detectTimestamp(base, cur), true);
});

test("timestamp NEGATIVE: modified update PLUS a body edit → pending", () => {
  const base = `---\nmodified: 2026-01-01\n---\nline one\n`;
  const cur = `---\nmodified: 2026-08-10\n---\nline one changed\n`;
  assert.equal(detectTimestamp(base, cur), false);
});

test("timestamp NEGATIVE: modified update PLUS another field value changed → pending", () => {
  const base = `---\nstatus: draft\nmodified: 2026-01-01\n---\nbody\n`;
  const cur = `---\nstatus: final\nmodified: 2026-08-10\n---\nbody\n`;
  assert.equal(detectTimestamp(base, cur), false);
});

test("timestamp NEGATIVE: `modified` set to arbitrary (non-timestamp) text → pending", () => {
  const base = `---\nmodified: 2026-01-01\n---\nbody\n`;
  const cur = `---\nmodified: see the other note for details\n---\nbody\n`;
  assert.equal(detectTimestamp(base, cur), false);
});

// ---------------------------------------------------------------------------
// canonical-order
// ---------------------------------------------------------------------------
test("canonical-order POSITIVE: same set + values, only order differs, body identical", () => {
  const base = `---\nalpha: 1\nbeta: 2\ngamma: 3\n---\nbody\n`;
  const cur = `---\ngamma: 3\nalpha: 1\nbeta: 2\n---\nbody\n`;
  assert.equal(detectCanonicalOrder(base, cur), true);
});

test("canonical-order NEGATIVE: reorder that ALSO changes a value → pending", () => {
  const base = `---\nalpha: 1\nbeta: 2\n---\nbody\n`;
  const cur = `---\nbeta: 2\nalpha: 99\n---\nbody\n`;
  assert.equal(detectCanonicalOrder(base, cur), false);
});

test("canonical-order NEGATIVE: reorder that ALSO adds a field → pending (not pure order)", () => {
  const base = `---\nalpha: 1\nbeta: 2\n---\nbody\n`;
  const cur = `---\nbeta: 2\nalpha: 1\ngamma: 3\n---\nbody\n`;
  // gamma is an added non-timestamp/non-uid field → residual → not pure canonical-order.
  assert.equal(detectCanonicalOrder(base, cur), false);
});

test("canonical-order NEGATIVE: reorder that ALSO changes the body → pending", () => {
  const base = `---\nalpha: 1\nbeta: 2\n---\nbody one\n`;
  const cur = `---\nbeta: 2\nalpha: 1\n---\nbody two\n`;
  assert.equal(detectCanonicalOrder(base, cur), false);
});

// ---------------------------------------------------------------------------
// link-heal
// ---------------------------------------------------------------------------
const CONFIRM_OLD_NEW = { confirms: (from, to) => from === "Old" && to === "New" };

test("link-heal POSITIVE: [[Old]] → [[New]] with a CONFIRMED rename, rest identical", () => {
  const base = `---\ntitle: N\n---\nSee [[Old]] for context.\n`;
  const cur = `---\ntitle: N\n---\nSee [[New]] for context.\n`;
  assert.equal(detectLinkHeal(base, cur, CONFIRM_OLD_NEW), true);
});

test("link-heal POSITIVE: [[Old|alias]] → [[New]] (alias dropped) confirmed", () => {
  const base = `See [[Old|the old note]] here.\n`;
  const cur = `See [[New]] here.\n`;
  assert.equal(detectLinkHeal(base, cur, CONFIRM_OLD_NEW), true);
});

test("link-heal NEGATIVE: rewrite to an UNCONFIRMED target → pending", () => {
  const base = `See [[Old]] here.\n`;
  const cur = `See [[Somewhere]] here.\n`;
  assert.equal(detectLinkHeal(base, cur, CONFIRM_OLD_NEW), false);
});

test("link-heal NEGATIVE: MISSING rename index → pending (fail safe)", () => {
  const base = `See [[Old]] here.\n`;
  const cur = `See [[New]] here.\n`;
  assert.equal(detectLinkHeal(base, cur, null), false);
});

test("link-heal NEGATIVE: index throws → treated as not-confirmed → pending", () => {
  const base = `See [[Old]] here.\n`;
  const cur = `See [[New]] here.\n`;
  const throwing = { confirms: () => { throw new Error("boom"); } };
  assert.equal(detectLinkHeal(base, cur, throwing), false);
});

test("link-heal NEGATIVE: confirmed link rewrite PLUS surrounding prose changed → pending", () => {
  const base = `See [[Old]] for context.\n`;
  const cur = `Please see [[New]] for context now.\n`;
  assert.equal(detectLinkHeal(base, cur, CONFIRM_OLD_NEW), false);
});

test("link-heal NEGATIVE: confirmed rewrite PLUS a frontmatter change → pending", () => {
  const base = `---\ntitle: N\n---\nSee [[Old]].\n`;
  const cur = `---\ntitle: CHANGED\n---\nSee [[New]].\n`;
  assert.equal(detectLinkHeal(base, cur, CONFIRM_OLD_NEW), false);
});

test("link-heal NEGATIVE: adds a NEW link (structure change), not a rewrite → pending", () => {
  const base = `See [[Old]].\n`;
  const cur = `See [[New]] and also [[Another]].\n`;
  assert.equal(detectLinkHeal(base, cur, CONFIRM_OLD_NEW), false);
});

// ---------------------------------------------------------------------------
// CONTENT-SMUGGLE regression — a line the frontmatter parser cannot losslessly
// round-trip (a leading/bare pre-key line, a comment, stray content) MUST be
// treated as residual → stay PENDING, even alongside a valid mechanical stamp.
// ---------------------------------------------------------------------------
test("SMUGGLE regression: leading bare line + valid uid stamp → PENDING", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\nSMUGGLED EVIL CONTENT\ntitle: X\nuid: ${UID}\n---\nbody`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("SMUGGLE regression: MULTIPLE junk lines + valid uid stamp → PENDING", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\njunk one\njunk two\njunk three\ntitle: X\nuid: ${UID}\n---\nbody`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("SMUGGLE regression: leading bare line + timestamp stamp → PENDING", () => {
  const base = `---\nmodified: 2026-01-01\n---\nbody`;
  const cur = `---\nSMUGGLED\nmodified: 2026-08-10\n---\nbody`;
  assert.equal(detectTimestamp(base, cur), false);
});

test("SMUGGLE regression: uid stamp with NO prior frontmatter but a leading junk line → PENDING", () => {
  const base = `# Note\nbody`;
  const cur = `---\nSMUGGLED\nuid: ${UID}\n---\n# Note\nbody`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("SMUGGLE regression: a comment-like (non-YAML) leading line + uid → PENDING", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\n# this is a sneaky comment line\ntitle: X\nuid: ${UID}\n---\nbody`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("SMUGGLE regression: a blank/whitespace pre-key line present ONLY in current + uid → PENDING", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\n   \ntitle: X\nuid: ${UID}\n---\nbody`;
  assert.equal(detectUidStamp(base, cur), false);
});

test("BENIGN: a leading blank line present in BOTH baseline and current is fine (still a uid stamp)", () => {
  // A pre-key line that already existed in the accepted baseline is not smuggled content — it is
  // preserved identically on both sides, so it does NOT block a genuine mechanical stamp.
  const base = `---\n\ntitle: X\n---\nbody`;
  const cur = `---\n\ntitle: X\nuid: ${UID}\n---\nbody`;
  assert.equal(detectUidStamp(base, cur), true);
});

test("no-change is never any class", () => {
  const same = `---\nuid: ${UID}\n---\nbody\n`;
  assert.equal(detectUidStamp(same, same), false);
  assert.equal(detectTimestamp(same, same), false);
  assert.equal(detectCanonicalOrder(same, same), false);
  assert.equal(detectLinkHeal(same, same, CONFIRM_OLD_NEW), false);
});
