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

// True only for a genuine, user-agent-dispatched gesture: a real Event whose isTrusted is true.
// Rejects forged plain objects (not an Event) and synthesized Events (isTrusted forced false).
export function isRealGesture(evt?: unknown): evt is Event {
  return evt instanceof Event && evt.isTrusted === true;
}

export type DispositionOutcome = "blocked-untrusted" | "cancelled" | "done";
export type AdoptOutcome = DispositionOutcome;

// THE ONE SHARED GESTURE GATE for every state-mutating human disposition (#101/#221: gating is
// applied by authority CLASS, not per-button code). `action` runs only when `evt` is a genuine
// trusted gesture AND — when a `confirm` gate is supplied (adopt's confirmation modal) — the human
// confirmed. Returns which gate stopped it (for tests + UX). A forged plain object or a
// synthesized click stops at the first gate: the confirm modal never even opens.
export async function runGuardedDisposition(
  evt: unknown,
  confirm: (() => Promise<boolean>) | null,
  action: () => Promise<void>,
): Promise<DispositionOutcome> {
  if (!isRealGesture(evt)) return "blocked-untrusted";
  if (confirm) {
    const confirmed = await confirm();
    if (!confirmed) return "cancelled";
  }
  await action();
  return "done";
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
