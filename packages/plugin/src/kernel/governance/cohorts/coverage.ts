// COVERAGE — full-coverage verification of a frozen cohort (WP7, D03/D13).
//
// The settled rule with no exceptions: "Standing predicates require exact
// subject coverage; sampling may supplement an audit but does not replace
// required verification." Every item runs every predicate its subject names;
// ONE failed or unevaluated item fails the WHOLE cohort — never silently
// dropped, never partially admitted. The way out of a failure is the
// deliberate one: exclude-and-refreeze into a successor subject whose digest
// covers the exclusion.
//
// The aggregate answer is addressed to the cohort DIGEST, so a verification
// outcome can never be borrowed by a cohort it did not cover.

import { verifySubject } from "../verification/verify.js";
import { subjectDigest } from "../contracts/subject-v1.js";
import type { PredicateRegistry } from "../verification/registry.js";
import type { VerificationEvidence, VerificationRecord } from "../verification/predicate.js";
import type { FrozenCohort } from "./freeze.js";
import type { ProposalItemSubjectV1 } from "../contracts/subject-v1.js";

export interface CohortItemOutcome {
  noteId: string;
  proposalId: string;
  passed: boolean;
  records: VerificationRecord[];
}

export interface CohortCoverageOutcome {
  /** The digest of the cohort this verdict is ABOUT. */
  cohortDigest: string;
  /** True only when EVERY item ran EVERY required predicate and passed. */
  passed: boolean;
  items: CohortItemOutcome[];
  /** Item noteIds that failed — the material for a split-by-finding exclusion. */
  failedNoteIds: string[];
}

/**
 * Verify every item of a frozen cohort. Evidence is resolved PER ITEM by the
 * caller-supplied resolver (the same shape admission uses); an item whose
 * evidence cannot be resolved is a FAILED item, not a skipped one.
 */
export async function verifyCohortCoverage(
  registry: PredicateRegistry,
  frozen: FrozenCohort,
  evidenceFor: (item: ProposalItemSubjectV1) => Promise<VerificationEvidence>,
  now: number
): Promise<CohortCoverageOutcome> {
  const items: CohortItemOutcome[] = [];
  for (let i = 0; i < frozen.subject.items.length; i++) {
    const item = frozen.subject.items[i];
    const proposalId = frozen.memberProposalIds[i];
    let passed = false;
    let records: VerificationRecord[] = [];
    try {
      const evidence = await evidenceFor(item);
      const outcome = await verifySubject(registry, item, evidence, now);
      passed = outcome.passed;
      records = outcome.records;
    } catch (e) {
      // "We could not check" has not passed — and it is recorded as its own
      // failure rather than vanishing (one failed item cannot be silently
      // dropped OR silently admitted).
      passed = false;
      records = [
        {
          predicate: { id: "coverage", version: "0" },
          // Addressed to the SUBJECT digest, per the record's own contract —
          // the first draft used the proposed CONTENT digest, which would
          // make a downstream policy read "the subject changed" instead of
          // "evidence could not be resolved" (review finding).
          subjectDigest: subjectDigest(item),
          passed: false,
          detail: `evidence could not be resolved: ${e instanceof Error ? e.message : String(e)}`,
          evaluatedAt: now,
        },
      ];
    }
    items.push({ noteId: item.noteId, proposalId, passed, records });
  }

  const failedNoteIds = items.filter((i) => !i.passed).map((i) => i.noteId);
  return {
    cohortDigest: frozen.digest.value,
    // The loop pushes exactly once per item and every throw is caught, so a
    // length comparison here would be a guard that guards nothing — the one
    // real condition is that no item failed.
    passed: failedNoteIds.length === 0,
    items,
    failedNoteIds,
  };
}
