// Genuine-user-gesture guard (the security gate on every accept-class UI handler).
//
// Ported verbatim from obsidian-stewardship/src/gesture.ts as part of the governance
// (Acceptance) module fold (#83, cycle 2 — the human-only Accept gesture + review pane).
// Obsidian-free by construction, so it is headless-testable exactly as it was in
// Stewardship.
//
// Every accept-class handler (accept / revert / adopt-baseline / setClassEnabled / modal-confirm)
// must fire ONLY on a real human click. Two independent properties make that true:
//
//   LAYER 1 (in governance/pane.ts + governance/wiring.ts) — handlers are wired with
//   `addEventListener('click', …)`, never `el.onclick = …`. An addEventListener listener is NOT
//   exposed as a reachable property (`el.onclick` stays null; getEventListeners is devtools-only),
//   so renderer-JS (js-engine / execute-code / meta-bind / quickadd all run arbitrary JS this vault
//   loads) cannot grab the handler function to forge-call it directly. This closes the
//   forgeable-onclick hole: `btn.onclick({isTrusted:true})`.
//
//   LAYER 2 (here) — `isRealGesture(evt)` requires a genuine `Event` instance AND isTrusted.
//     * A forged plain object `{isTrusted:true}` fails `evt instanceof Event`.
//     * A renderer-synthesized real Event (`new MouseEvent(...)` + `dispatchEvent`) IS an Event
//       but the DOM forces `isTrusted === false` on it. `isTrusted` is [LegacyUnforgeable] in the
//       DOM spec — installed as a non-configurable own property by the Event constructor, so it
//       cannot be shadowed by a subclass getter or overridden via defineProperty (that throws).
//     * Only a user-agent-dispatched gesture is both an Event AND isTrusted === true.
//
// Note: Node's `Event` implements `isTrusted` as a shadowable prototype getter (not
// [LegacyUnforgeable]), so tests use an `Event` subclass whose getter returns true to stand in for
// a real gesture — the browser's unforgeability is what makes isTrusted === true reachable ONLY
// from a physical click at runtime.

// True only for a genuine, user-agent-dispatched gesture: a real platform Event whose isTrusted
// is true. Rejects forged plain objects (not a platform Event) and synthesized Events (isTrusted
// forced false).
//
// REALM-SAFE since the popout incident (2026-08-23): `evt instanceof Event` compares against
// THIS realm's constructor, so a genuinely trusted click delivered in a POPOUT window (whose
// events are instances of that window's Event) failed instanceof and the gate silently swallowed
// a real human gesture — every gesture-gated control was dead in popouts, indistinguishable from
// the forgery case. The realm-safe form keeps both security properties:
//   * The WebIDL BRAND CHECK: `Event.prototype.composedPath.call(evt)` throws TypeError for
//     anything that is not a REAL platform Event object — brand validation reads the internal
//     slot, which is realm-independent, so a forged plain object `{isTrusted:true}` (from any
//     realm) still cannot pass, while a popout's genuine event does.
//   * `isTrusted` stays [LegacyUnforgeable] on every real platform Event in every realm, so a
//     renderer-synthesized Event (any realm) still reads false.
// There is NO instanceof fast path, deliberately (review finding, sixteenth instance): a fast
// path returning on `evt instanceof Event` short-circuits BEFORE the brand check for exactly
// the objects instanceof gets wrong — it tunnels proxies through their prototype chain, so a
// get-trapped proxy forging isTrusted would be admitted at the fast path and the brand check
// below would never run. The brand check alone decides platform-Event-ness for every input in
// every realm; the in-realm test doubles (an Event subclass with a shadowed isTrusted getter)
// carry the brand and still pass — verified by running, nothing in the suite needs instanceof.
// Per-realm proxy verdict, measured through THIS function (not the primitive): the renderer's
// brand check throws for proxied platform objects, so the forged-proxy spelling is CLOSED in
// Chromium; Node's brand tunnels proxies, so it remains OPEN in the test environment
// (documented in the test); Layer 1 — handler unreachability — is the primary wall in both.
// The whole body is one try: a brand failure OR a throwing isTrusted getter (unconstructible
// on a real browser event, a Node-realm artifact) degrades to refusal, never propagates into
// a UI handler — the gate is total.
export function isRealGesture(evt?: unknown): evt is Event {
  try {
    Event.prototype.composedPath.call(evt as Event);
    return (evt as Event).isTrusted === true;
  } catch {
    return false;
  }
}

export type DispositionOutcome = "blocked-untrusted" | "cancelled" | "done";
export type AdoptOutcome = DispositionOutcome;

import { uuidv7 } from "../uuidv7.js";

// THE ONE SHARED GESTURE GATE for every state-mutating human disposition (#101/#221: gating is
// applied by authority CLASS, not per-button code). `action` runs only when `evt` is a genuine
// trusted gesture AND — when a `confirm` gate is supplied (adopt's confirmation modal) — the human
// confirmed. Returns which gate stopped it (for tests + UX). A forged plain object or a
// synthesized click stops at the first gate: the confirm modal never even opens.
export async function runGuardedDisposition(
  evt: unknown,
  confirm: (() => Promise<boolean>) | null,
  action: (gestureRef: string) => Promise<void>,
): Promise<DispositionOutcome> {
  if (!isRealGesture(evt)) return "blocked-untrusted";
  if (confirm) {
    const confirmed = await confirm();
    if (!confirmed) return "cancelled";
  }
  // The gesture reference is minted HERE — after the trust check, after the
  // confirmation — and handed to the action. It cannot be minted at render
  // time or fabricated by a captured callback, because the only mint is this
  // line and this line is downstream of both gates. "It exists only if a
  // real click happened" is a property of the control flow, not of anyone's
  // care (governor-lead's #330 attack run: a render-time mint kept every
  // test green while corrupting what the authority record MEANS — the fix
  // deletes the possibility rather than pinning the placement).
  await action(mintGestureRefInternal(Date.now()));
  return "done";
}

/** The ONE mint. Module-private on purpose: reachable only through the gate above. */
function mintGestureRefInternal(nowMs: number): string {
  return `gesture-${uuidv7(nowMs)}`;
}

// Adopt-baseline is the most dangerous action (it silences the ENTIRE queue), so it is gated
// TWICE: (1) the originating event must be a real, trusted gesture, and (2) the human must confirm
// in a modal. The confirm-gated instantiation of runGuardedDisposition — kept as a named entry
// point because the tripwire pins the pane's adopt wiring to it.
export function runGuardedAdopt(
  evt: unknown,
  confirm: () => Promise<boolean>,
  action: () => Promise<void>,
): Promise<AdoptOutcome> {
  return runGuardedDisposition(evt, confirm, action);
}
