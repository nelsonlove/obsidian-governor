// MANDATE BUDGETS — bounded delegation's arithmetic (WP9, D02).
//
// A mandate without budgets is a blank check with a nice purpose string. The
// spec's limit set (guide §WP9, sessions-mandates-and-cohorts.md): item
// count, changed bytes, duration, proposals, and failure budget. Budgets are
// IMMUTABLE on the mandate (amendment is replacement); USAGE is the mutable
// half, accumulated as durable events and folded — so "how much is left" is
// always derivable from the record, never from a counter that dies with the
// process.
//
// Reaching a budget is a NORMAL STOP, not an error: the mandate transitions
// to `exhausted`, what completed stays proposed/admitted, and further work
// under the mandate refuses. Nothing here throws; breach detection returns
// data and the caller (policy, lifecycle) decides the transition.

export interface MandateBudgets {
  /** Maximum distinct items (notes) the mandate may touch. */
  maxItems: number;
  /** Maximum total changed bytes across all proposals. */
  maxBytes: number;
  /** Maximum wall-clock lifetime after activation, in ms. Doubles as the expiry source: activation computes expiresAt from it. */
  maxDurationMs: number;
  /** Maximum proposal records produced. */
  maxProposals: number;
  /** Maximum verification failures before the mandate stops. */
  maxFailures: number;
}

export interface MandateUsage {
  items: number;
  bytes: number;
  proposals: number;
  failures: number;
}

export const ZERO_USAGE: MandateUsage = Object.freeze({ items: 0, bytes: 0, proposals: 0, failures: 0 });

/** Every budget must be a positive finite integer bound — an unbounded axis is not delegation. */
export function budgetsInvalidReason(b: MandateBudgets): string | null {
  const axes: Array<[string, number]> = [
    ["maxItems", b.maxItems],
    ["maxBytes", b.maxBytes],
    ["maxDurationMs", b.maxDurationMs],
    ["maxProposals", b.maxProposals],
    ["maxFailures", b.maxFailures],
  ];
  for (const [name, v] of axes) {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) return `${name} must be a non-negative integer, got ${String(v)}`;
  }
  // maxFailures MAY be 0 (first failure stops); the capacity axes must allow at least one unit of work.
  for (const [name, v] of axes.slice(0, 4)) {
    if (v === 0) return `${name} must be positive — a mandate that can do nothing is not a delegation`;
  }
  return null;
}

/** Accumulate usage. Pure; negative deltas are clamped — usage never decreases (the record is append-only). */
export function chargeUsage(usage: MandateUsage, delta: Partial<MandateUsage>): MandateUsage {
  const add = (cur: number, d: number | undefined) => cur + Math.max(0, Math.floor(d ?? 0));
  return {
    items: add(usage.items, delta.items),
    bytes: add(usage.bytes, delta.bytes),
    proposals: add(usage.proposals, delta.proposals),
    failures: add(usage.failures, delta.failures),
  };
}

export interface BudgetBreach {
  axis: "items" | "bytes" | "proposals" | "failures" | "duration";
  detail: string;
}

/**
 * The first breached budget, or null. `failures` breaches at EXCEEDING the
 * budget (a failure budget of 2 tolerates 2); the capacity axes breach at
 * REACHING the cap (a 100-item budget stops after the 100th item lands).
 * Duration is decided against the caller's clock — no timers, decided at use,
 * the session-liveness discipline.
 */
export function budgetBreach(budgets: MandateBudgets, usage: MandateUsage, activatedAt: number, now: number): BudgetBreach | null {
  if (usage.items >= budgets.maxItems) return { axis: "items", detail: `item budget reached: ${usage.items}/${budgets.maxItems}` };
  if (usage.bytes >= budgets.maxBytes) return { axis: "bytes", detail: `byte budget reached: ${usage.bytes}/${budgets.maxBytes}` };
  if (usage.proposals >= budgets.maxProposals) {
    return { axis: "proposals", detail: `proposal budget reached: ${usage.proposals}/${budgets.maxProposals}` };
  }
  if (usage.failures > budgets.maxFailures) {
    return { axis: "failures", detail: `failure budget exceeded: ${usage.failures}/${budgets.maxFailures}` };
  }
  if (now - activatedAt >= budgets.maxDurationMs) {
    return { axis: "duration", detail: `duration budget reached: active ${now - activatedAt}ms of ${budgets.maxDurationMs}ms` };
  }
  return null;
}
