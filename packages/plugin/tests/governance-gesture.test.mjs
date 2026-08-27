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
import { isRealGesture, runGuardedAdopt } from "../src/governor/kernel/gesture.ts";

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
  const { runGuardedDisposition } = await import("../src/governor/kernel/gesture.ts");
  let acted = 0;
  const outcome = await runGuardedDisposition({ isTrusted: true }, null, async () => { acted++; });
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(acted, 0, "a forged plain object must not run a disposition");
});

test("runGuardedDisposition (no confirm) is INERT on a synthesized (untrusted) Event", async () => {
  const { runGuardedDisposition } = await import("../src/governor/kernel/gesture.ts");
  let acted = 0;
  const outcome = await runGuardedDisposition(new Event("click"), null, async () => { acted++; });
  assert.equal(outcome, "blocked-untrusted");
  assert.equal(acted, 0, "a synthesized dispatchEvent must not run a disposition");
});

test("runGuardedDisposition (no confirm) runs exactly once on a real gesture", async () => {
  const { runGuardedDisposition } = await import("../src/governor/kernel/gesture.ts");
  let acted = 0;
  const outcome = await runGuardedDisposition(new RealGestureEvent("click"), null, async () => { acted++; });
  assert.equal(outcome, "done");
  assert.equal(acted, 1);
});

test("runGuardedDisposition with a confirm gate: forged arg never even opens the confirm", async () => {
  const { runGuardedDisposition } = await import("../src/governor/kernel/gesture.ts");
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
  const { runGuardedDisposition } = await import("../src/governor/kernel/gesture.ts");
  return runGuardedDisposition(evt, null, action);
}

test("runGuardedAdopt IS the confirm-gated instantiation of the shared gate (one mechanism)", async () => {
  const { runGuardedAdopt: adopt, runGuardedDisposition } = await import("../src/governor/kernel/gesture.ts");
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

// ── Cross-realm (popout) family — the 2026-08-23 live incident ──────────────
//
// A genuinely trusted click in a POPOUT window is an instance of THAT
// window's Event, so the old `evt instanceof Event` gate returned
// blocked-untrusted for a real human gesture — every gesture-gated control
// was silently dead in popouts (a FALSE NEGATIVE; no attacker was ever
// admitted). The realm-safe gate brand-checks via
// Event.prototype.composedPath.call, which validates the platform-object
// internal slot regardless of realm.
//
// Node cannot host a true second DOM realm, so the cross-realm TRUSTED case
// uses the brand-vs-realm separation Node does offer: a REAL Event with its
// prototype cut (instanceof false, brand intact) and an own isTrusted:true
// (Node's isTrusted is a shadowable prototype getter — the file's documented
// Node-vs-browser gap; in browsers isTrusted is unforgeable and reads true
// only on user-agent events). Renderer-realm behavior was verified LIVE in
// the running Obsidian (Chromium): forged plain THROWS, real returns [],
// and — stricter than Node — a Proxy-wrapped Event THROWS the brand check
// while passing instanceof, so in the runtime that matters the new gate
// CLOSES the proxy spelling the old gate admitted at Layer 2 (Layer 1,
// handler unreachability, was and remains the primary wall there). In Node
// the proxy passes the brand (returns []) — a documented test-environment
// divergence, pinned below as Node behavior.
//
// Vacuity discipline (#342's rule): every leg below calls the REAL
// isRealGesture/runGuardedDisposition — no predicate is restated. Both
// failure directions are covered by construction: gut isRealGesture to
// `return true` and the forged/synthesized legs redden; gut it to `return
// false` and the trusted legs redden (mutation-verified in the PR).


function crossRealmTrustedStandIn() {
  const evt = new Event("click");
  Object.setPrototypeOf(evt, null);
  Object.defineProperty(evt, "isTrusted", { value: true });
  return evt;
}

test("cross-realm TRUSTED gesture passes: brand intact, instanceof false — the popout fix", () => {
  const evt = crossRealmTrustedStandIn();
  assert.equal(evt instanceof Event, false, "the stand-in genuinely fails same-realm instanceof — else this test proves nothing");
  assert.equal(isRealGesture(evt), true, "a real platform Event that is trusted passes regardless of realm");
});

test("cross-realm SYNTHESIZED event stays blocked: brand intact, isTrusted false", () => {
  const evt = new Event("click");
  Object.setPrototypeOf(evt, null);
  assert.equal(evt instanceof Event, false);
  assert.equal(isRealGesture(evt), false, "brand alone never admits — isTrusted must be true");
});

test("forged plain object stays blocked — the brand check throws for a non-Event, in any realm", () => {
  assert.equal(isRealGesture({ isTrusted: true }), false);
  assert.equal(isRealGesture({ isTrusted: true, composedPath() { return []; } }), false, "carrying a composedPath function is not the brand — duck-typing would pass this, the brand check must not");
});

test("garbage inputs return false, never throw", () => {
  for (const junk of [null, undefined, 0, 42, "click", Symbol("x"), () => {}, [], Object.create(null)]) {
    assert.equal(isRealGesture(junk), false, String(typeof junk));
  }
});

test("Proxy spelling, per-realm verdict measured through isRealGesture itself: CLOSED in the renderer, OPEN in Node, Layer 1 in both", () => {
  const real = new Event("click");
  const prox = new Proxy(real, {});
  assert.equal(prox instanceof Event, true, "instanceof tunnels proxies — which is why the gate must have NO instanceof fast path (16th instance: a fast path returned before the brand check ever ran for exactly these objects)");
  assert.equal(isRealGesture(prox), false, "an untrapped proxy fails isTrusted (target's false) — this leg alone cannot distinguish brand behavior");
  // THE leg that matters: a get-trapped proxy FORGING isTrusted. Verdict is
  // per-realm, each measured through the real function:
  //   * Renderer (live-verified 2026-08-23, verbatim function body evaluated
  //     in the running Obsidian): Chromium's brand check THROWS for proxied
  //     platform objects, so isRealGesture(forging proxy) === false. CLOSED.
  //   * Node (this assertion): the brand tunnels the proxy — true. OPEN in
  //     the test environment only. Layer 1 (addEventListener handler
  //     unreachability) is the primary wall in both realms.
  // This pin holds the NODE fact so a change to it is a visible decision —
  // and unlike the untrapped leg, this one CAN fail: a Node brand that
  // stopped tunneling proxies would flip it.
  const lying = new Proxy(real, { get: (t, k) => (k === "isTrusted" ? true : Reflect.get(t, k)) });
  assert.equal(isRealGesture(lying), true, "NODE fact: brand tunnels proxies here; the renderer refuses them — verdicts are per-realm, see above");
});

test("a throwing isTrusted getter degrades to refusal, never propagates into a UI handler", () => {
  // Unconstructible on a real browser event (isTrusted is unforgeable); a
  // Node-realm artifact. The gate must answer false, not throw.
  const evt = new Event("click");
  Object.defineProperty(evt, "isTrusted", { get() { throw new Error("boom"); } });
  assert.equal(isRealGesture(evt), false);
});
