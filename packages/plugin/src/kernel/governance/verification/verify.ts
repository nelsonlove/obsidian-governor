// VERIFY — run a subject's required predicates over the EXACT subject (WP6).
//
// The output is a verdict about one digest. Three rules carry the safety:
//
//   1. Coverage is exact and total: every predicate the subject names runs,
//      and one failure fails the whole verification — "sampling may
//      supplement an audit but does not replace required verification"
//      (settled decision). A missing registration throws before anything
//      runs; a check that cannot run has not passed.
//   2. A verdict is addressed: each record carries the subject digest it is
//      ABOUT. Consumers compare digests, so a verdict cannot be borrowed by
//      a changed subject (verification goes STALE on any subject change by
//      construction — the digests stop matching).
//   3. An evaluator throwing is a FAILED verification, not a skipped one.
//      The thrown detail is recorded; the human sees "could not evaluate",
//      never a green light with an asterisk.

import { subjectDigest, type ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { PredicateRegistry } from "./registry.js";
import type { VerificationEvidence, VerificationRecord } from "./predicate.js";

export interface VerificationOutcome {
  /** True only when EVERY required predicate ran and passed. */
  passed: boolean;
  records: VerificationRecord[];
}

export async function verifySubject(
  registry: PredicateRegistry,
  subject: ProposalItemSubjectV1,
  evidence: VerificationEvidence,
  now: number
): Promise<VerificationOutcome> {
  const digest = subjectDigest(subject);
  const required = registry.requiredFor(subject); // throws on missing registration
  const records: VerificationRecord[] = [];

  for (const predicate of required) {
    let passed = false;
    let detail: string;
    try {
      const result = await predicate.evaluate(subject, evidence);
      passed = result.passed;
      detail = result.detail;
    } catch (e) {
      passed = false;
      detail = `predicate could not evaluate: ${e instanceof Error ? e.message : String(e)}`;
    }
    records.push({
      predicate: { id: predicate.id, version: predicate.version },
      subjectDigest: digest,
      passed,
      detail,
      evaluatedAt: now,
    });
  }

  return { passed: records.length === required.length && records.every((r) => r.passed), records };
}
