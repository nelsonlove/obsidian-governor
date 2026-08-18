// Genuine-user-gesture guard (the security gate) + adopt confirmation flow. Ported from
// obsidian-stewardship/tests/gesture.test.mjs (#83, cycle 2).
//
// isRealGesture must accept ONLY a genuine Event whose isTrusted is true. Two forgery classes are
// rejected: (a) a forged plain object `{isTrusted:true}` — fails `instanceof Event`; (b) a
// synthesized real Event — the DOM forces isTrusted false ([LegacyUnforgeable]). These pure
// functions back the pane's accept/revert/adopt handlers so the gate is headless-testable
// (pane.ts imports the Obsidian runtime and cannot be instantiated in the test env).
//
// Node's `Event` implements isTrusted as a shadowable prototype getter (not [LegacyUnforgeable]),
// so we use an `Event` subclass whose getter returns true to STAND IN for a real user gesture in
// the legit-path test. In the browser that subclass would still read isTrusted false (the own
// unforgeable property beats the subclass getter), so isTrusted === true is reachable only from a
// physical click at runtime — documented reasoning; the attack paths are proven dead by the LIVE
// reachability check that gates merge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRealGesture, runGuardedAdopt } from "../src/kernel/governance/gesture.ts";

// A test-only stand-in for a genuine user gesture: a real Event whose isTrusted reads true.
class RealGestureEvent extends Event {
  get isTrusted() { return true; }
}

test("isRealGesture REJECTS a forged plain object {isTrusted:true} (not an Event)", () => {
  assert.equal(isRealGesture({ isTrusted: true }), false);
});

test("isRealGesture rejects other non-Event args (null / undefined / prop-less / functions)", () => {
  assert.equal(isRealGesture(undefined), false);
  assert.equal(isRealGesture(null), false);
  assert.equal(isRealGesture({}), false);
  assert.equal(isRealGesture(() => {}), false);
  assert.equal(isRealGesture({ isTrusted: true, type: "click", preventDefault() {} }), false);
});

test("isRealGesture REQUIRES an Event instance — a real but untrusted Event fails", () => {
  const synthetic = new Event("click"); // real Event, isTrusted forced false
  assert.ok(synthetic instanceof Event);
  assert.equal(isRealGesture(synthetic), false);
});

test("isRealGesture is true only for a genuine gesture (real Event AND isTrusted true)", () => {
  const real = new RealGestureEvent("click");
  assert.ok(real instanceof Event, "the legit gesture is a real Event instance");
  assert.equal(isRealGesture(real), true);
});

test("adopt handler is INERT on a forged plain-object arg — never confirms, never acts", async () => {
  let confirmed = 0;
  let acted = 0;
  const outcome = await runGuardedAdopt(
    { isTrusted: true }, // forged: renderer-JS passes a plain object to a forge-called handler
    async () => { confirmed++; return true; },
    async () => { acted++; },
  );
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(confirmed, 0, "must not even open the confirm modal for a forged arg");
  assert.equal(acted, 0, "the mass-silence action must not run");
});

test("adopt handler is INERT on a synthesized (untrusted) Event", async () => {
  let acted = 0;
  const outcome = await runGuardedAdopt(
    new Event("click"),
    async () => true,
    async () => { acted++; },
  );
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(acted, 0, "a synthesized dispatchEvent must not run the mass-silence action");
});

test("adopt handler on a real gesture but human DECLINES → cancelled, no action", async () => {
  let acted = 0;
  const outcome = await runGuardedAdopt(
    new RealGestureEvent("click"),
    async () => false, // human clicked Cancel / hit Escape
    async () => { acted++; },
  );
  assert.equal(outcome, "cancelled");
  assert.equal(acted, 0, "declining the modal must not run the action");
});

test("adopt proceeds ONLY on a real gesture AND human confirm", async () => {
  let acted = 0;
  const outcome = await runGuardedAdopt(
    new RealGestureEvent("click"), // stands in for a physical click (real Event + isTrusted)
    async () => true, // human clicked Continue
    async () => { acted++; },
  );
  assert.equal(outcome, "done");
  assert.equal(acted, 1, "adopt runs exactly once on a confirmed real gesture");
});

// ── #101: the ONE shared gesture gate for every state-mutating human disposition ──
//
// runGuardedDisposition is the authority-class mechanism the descriptor set (#221) names: the
// confirm-gated form IS runGuardedAdopt (kept as a named entry point), and the confirm-less form
// backs the request-changes / withdraw pane handlers. These tests are the headless
// forged-gesture-refusal proof for the two NEW human dispositions: the same two forgery classes
// rejected for adopt are rejected here, before any confirm/action runs.

test("runGuardedDisposition (no confirm) is INERT on a forged plain object", async () => {
  const { runGuardedDisposition } = await import("../src/kernel/governance/gesture.ts");
  let acted = 0;
  const outcome = await runGuardedDisposition({ isTrusted: true }, null, async () => { acted++; });
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(acted, 0, "a forged plain object must not run a disposition");
});

test("runGuardedDisposition (no confirm) is INERT on a synthesized (untrusted) Event", async () => {
  const { runGuardedDisposition } = await import("../src/kernel/governance/gesture.ts");
  let acted = 0;
  const outcome = await runGuardedDisposition(new Event("click"), null, async () => { acted++; });
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(acted, 0, "a synthesized dispatchEvent must not run a disposition");
});

test("runGuardedDisposition (no confirm) runs exactly once on a real gesture", async () => {
  const { runGuardedDisposition } = await import("../src/kernel/governance/gesture.ts");
  let acted = 0;
  const outcome = await runGuardedDisposition(new RealGestureEvent("click"), null, async () => { acted++; });
  assert.equal(outcome, "done");
  assert.equal(acted, 1);
});

test("runGuardedDisposition with a confirm gate: forged arg never even opens the confirm", async () => {
  const { runGuardedDisposition } = await import("../src/kernel/governance/gesture.ts");
  let confirmed = 0;
  let acted = 0;
  const outcome = await runGuardedDisposition(
    { isTrusted: true },
    async () => { confirmed++; return true; },
    async () => { acted++; },
  );
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(confirmed, 0);
  assert.equal(acted, 0);
});

// ── #221/#164: the CONVERGED accept behind the gate now also WRITES (the stamp) ──
//
// Since the acceptance convergence, a gesture-gated Accept on a `proposed` note stamps the
// accepted family into the note's frontmatter as well as advancing the baseline. The gate is
// the same isRealGesture perimeter — so a forged/synthesized gesture must produce NO stamp
// AND NO baseline advance. Modeled exactly as the pane handler is wired: the accept action
// (stamp + advance, the acceptNote shape) runs only behind the gesture check.

test("converged accept: a FORGED plain-object gesture produces no stamp and no baseline advance", async () => {
  let stamps = 0;
  let advances = 0;
  const outcome = await runGuardedDispositionShim({ isTrusted: true }, async () => { stamps++; advances++; });
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(stamps, 0, "a forged gesture must never stamp the accepted family");
  assert.equal(advances, 0, "a forged gesture must never advance a baseline");
});

test("converged accept: a SYNTHESIZED (untrusted) Event produces no stamp and no baseline advance", async () => {
  let stamps = 0;
  let advances = 0;
  const outcome = await runGuardedDispositionShim(new Event("click"), async () => { stamps++; advances++; });
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(stamps, 0);
  assert.equal(advances, 0);
});

test("converged accept: a genuine gesture runs the stamp+advance action exactly once", async () => {
  let stamps = 0;
  let advances = 0;
  const outcome = await runGuardedDispositionShim(new RealGestureEvent("click"), async () => { stamps++; advances++; });
  assert.equal(outcome, "done");
  assert.equal(stamps, 1);
  assert.equal(advances, 1);
});

// The pane's accept handlers gate directly on isRealGesture then run the action — the
// confirm-less runGuardedDisposition shape. Kept as a shim so these tests exercise the SAME
// shared gate mechanism the descriptor set names.
async function runGuardedDispositionShim(evt, action) {
  const { runGuardedDisposition } = await import("../src/kernel/governance/gesture.ts");
  return runGuardedDisposition(evt, null, action);
}

test("runGuardedAdopt IS the confirm-gated instantiation of the shared gate (one mechanism)", async () => {
  const { runGuardedAdopt: adopt, runGuardedDisposition } = await import("../src/kernel/governance/gesture.ts");
  // Behavioral identity on all three outcomes.
  for (const [evt, confirm, expected] of [
    [{ isTrusted: true }, async () => true, "blocked-untrusted"],
    [new RealGestureEvent("click"), async () => false, "cancelled"],
    [new RealGestureEvent("click"), async () => true, "done"],
  ]) {
    assert.equal(await adopt(evt, confirm, async () => {}), expected);
    assert.equal(await runGuardedDisposition(evt, confirm, async () => {}), expected);
  }
});
