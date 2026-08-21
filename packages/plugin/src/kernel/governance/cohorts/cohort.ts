// COHORT SELECTORS — dynamic queries that SELECT, never define (WP7, D02/D03).
//
// The settled decision this module exists to honor: "Cohorts are immutable
// exact manifests; dynamic session/folder/collection queries only select
// them." A selector is a lens over the pending proposals — by session, by
// folder, by class, by transformation, by verification state, or any
// intersection — and its output is a CANDIDATE LIST. Nothing about a
// selector is authority: the authority object is the frozen manifest
// (freeze.ts), and between selection and freezing the world may move.
//
// Selection is pure and total. Every predicate is conjunctive (intersection
// is the only combinator, per the deliverable list) — union invites "the
// query grew while I looked away", which is exactly what freezing exists to
// end.

import type { ProposalV1 } from "../proposals/proposal.js";
import type { ChangeClass } from "../contracts/change-class.js";
import type { VerificationState } from "../contracts/states.js";

export interface CohortSelector {
  /** Proposals produced in this session. */
  sessionId?: string;
  /** Vault-relative folder prefix (folder-root semantics, like history includes). */
  folder?: string;
  /** The subject's EXACT class combination must equal this set (order-free). */
  classes?: ChangeClass[];
  /** The subject's transformation id (version-free match unless given). */
  transformation?: { id: string; version?: string };
  /** The proposal's verification axis. */
  verification?: VerificationState;
}

/**
 * Select candidates. Only `authority: "proposed"` proposals are ever
 * candidates — an admitted, superseded, or revoked proposal has left the
 * decision space, and grouping eligibility (change-classes.md) demands "no
 * unresolved error or escalation".
 */
export function selectProposals(proposals: readonly ProposalV1[], selector: CohortSelector): ProposalV1[] {
  return proposals.filter((p) => {
    if (p.authority !== "proposed") return false;
    if (selector.sessionId !== undefined && p.sessionId !== selector.sessionId) return false;
    if (selector.folder !== undefined) {
      const root = selector.folder.replace(/\/+$/, "");
      const path = p.subject.path;
      if (path === null) return false;
      if (!(path === root || path.startsWith(root + "/"))) return false;
    }
    if (selector.classes !== undefined) {
      const want = [...selector.classes].sort().join("+");
      const have = [...p.subject.changeClasses].sort().join("+");
      // EXACT combination equality — grouping eligibility requires "the same
      // change class or exact class combination", not overlap.
      if (want !== have) return false;
    }
    if (selector.transformation !== undefined) {
      if (p.subject.transformation.id !== selector.transformation.id) return false;
      if (selector.transformation.version !== undefined && p.subject.transformation.version !== selector.transformation.version) return false;
    }
    if (selector.verification !== undefined && p.verification !== selector.verification) return false;
    return true;
  });
}

/**
 * Grouping eligibility (change-classes.md): items may enter ONE cohort only
 * when they share the exact class combination, the same transformation AND
 * verifier policy (the predicates list — one gesture must not cover items
 * verified to different standards), the same mandate, and no unresolved
 * error or escalation (only proposed-and-not-revising members freeze).
 * Returns the reason the group is ineligible, or null. Checked at freeze
 * time — a selector may legally select an ineligible mix; FREEZING it is
 * what's refused.
 *
 * Base-state COMPATIBILITY is deliberately not checked here: it is a
 * verification-level fact (content-diff@1 re-checks each item's base bytes
 * against its recording at coverage time), and a freeze-time check would
 * duplicate a weaker version of the same comparison. Named so the omission
 * reads as a decision, not a gap.
 */
export function groupIneligibilityOf(items: readonly ProposalV1[]): string | null {
  if (items.length === 0) return "an empty cohort decides nothing";
  const classKey = (p: ProposalV1) => [...p.subject.changeClasses].sort().join("+");
  const predicateKey = (p: ProposalV1) => p.subject.predicates.map((x) => `${x.id}@${x.version}`).join(",");
  const first = items[0];
  for (const p of items) {
    // No unresolved error or escalation: an admitted/superseded member has
    // left the decision space, and a revision-requested one carries an open
    // human objection — neither may ride a cohort gesture.
    if (p.authority !== "proposed") {
      return `member ${p.id} is ${p.authority}; only proposed items freeze`;
    }
    if (p.development === "revision-requested") {
      return `member ${p.id} has an open revision request; resolve it before grouping`;
    }
    if (classKey(p) !== classKey(first)) {
      return `mixed class combinations (${classKey(first)} vs ${classKey(p)}); a cohort shares ONE exact combination`;
    }
    if (p.subject.transformation.id !== first.subject.transformation.id || p.subject.transformation.version !== first.subject.transformation.version) {
      return "mixed transformations; a cohort shares one transformation";
    }
    if (predicateKey(p) !== predicateKey(first)) {
      return "mixed verifier policies; one gesture must not cover items verified to different standards";
    }
    if (p.subject.mandateId !== first.subject.mandateId) {
      return "mixed mandates; a cohort shares one mandate (or none)";
    }
  }
  return null;
}
