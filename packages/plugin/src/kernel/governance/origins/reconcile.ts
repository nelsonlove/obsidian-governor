// RECONCILE — what an origin means for standing (WP5, D12/D06).
//
// The classifier says where a change came from; this decides what happens to
// the note's STANDING because of it. Pure, and deliberately small: the full
// reconciliation machinery (freezing ambiguous changes into a cohort, the
// "Treat these as my changes" gesture) is review-UI work — what belongs here
// is the decision table those surfaces must agree on, so two of them can
// never reach different conclusions from the same facts.
//
// The rules, from D12 and D06:
// - local-human-observed advances silently under the default policy (same-
//   user threat model, adopted behavior);
// - governor-originated is left for the journal-driven review queue — an
//   agent's change is never its own acceptance;
// - sync-attributed and external-unattributed never advance; where the note
//   HAD admitted standing, that standing is marked STALE (the subject
//   changed under it — D06: history is retained, current realization is
//   marked, nothing is rewritten as revoked);
// - everything not silently advanced is routed for review. Ambiguity
//   escalates; it never silently downgrades.

import type { OriginClass } from "../contracts/origin.js";

export interface ReconcileInput {
  origin: OriginClass;
  /** Whether the changed subject carried admitted standing before the change. */
  hadAdmittedStanding: boolean;
}

export interface ReconcileDisposition {
  /** Advance the local baseline without review (the human's own typing). */
  advanceSilently: boolean;
  /** Surface in the review queue. */
  routeForReview: boolean;
  /** Mark existing admitted standing stale — never revoked, never rewritten. */
  markStandingStale: boolean;
}

export function reconcileDisposition(input: ReconcileInput): ReconcileDisposition {
  if (input.origin === "local-human-observed") {
    return { advanceSilently: true, routeForReview: false, markStandingStale: false };
  }
  const markStandingStale = input.hadAdmittedStanding && (input.origin === "sync-attributed" || input.origin === "external-unattributed");
  return { advanceSilently: false, routeForReview: true, markStandingStale };
}
