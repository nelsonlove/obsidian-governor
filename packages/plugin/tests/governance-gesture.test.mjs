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
