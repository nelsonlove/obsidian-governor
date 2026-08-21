// ADMISSION SERVICE — the only code allowed to advance standing (WP6, §9).
//
// The isolation is CAPABILITY-SHAPED, not name-shaped: the constructor takes
// a `standingAdvance` closure — compare-and-swap over the standing ref —
// that the wiring builds from the history repository and hands to this
// service alone. The guide is explicit that "a public TypeScript method with
// a suggestive name is not sufficient isolation": nothing here is placed on
// a plugin instance, a view, a command registry, an MCP registry, or a DOM
// property, and the source-scan test enforces that the standing ref's name
// is constructed nowhere outside the refs module, this package, and the one
// wiring point that builds the capability.
//
// The required ordering (§10), each step durable before the next:
//
//   1. revalidate subject and authority   (policy.requireAdmissible, fresh)
//   2. construct and durably store claim  (unattached evidence if we crash)
//   3. compare-and-swap the standing ref  (the actual authority transition)
//   4. append the settlement record       (what happened, for recovery)
//   5. refresh rebuildable projections    (a callback; failures degrade)
//
// A crash between 2 and 3 leaves a retriable claim; between 3 and 4 leaves a
// consistent-but-unrecorded settlement the recovery pass completes. Nothing
// in any window leaves a ref pointing at evidence that does not exist,
// because the claim lands BEFORE the ref moves.

import { AdmissionRefusedError, requireAdmissible, type AdmissionRequest } from "./policy.js";
import { buildAdmissionClaim, type AdmissionClaimV1, type ClaimStore } from "./settlement.js";
import { RefCasError } from "../history-store/types.js";
import type { ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { VerificationOutcome } from "../verification/verify.js";

/**
 * The capability: CAS over the standing ref, pre-bound to the ref name by
 * whoever built it. Receiving (expected, next) and NOT a ref name is the
 * point — the service cannot address arbitrary refs even if it wanted to.
 */
export type StandingAdvance = (expectedClaimId: string | null, nextClaimId: string) => Promise<void>;

export interface AdmissionDeps {
  claims: ClaimStore;
  standingAdvance: StandingAdvance;
  /**
   * Run the subject's required predicates, NOW, and return the outcome. §9:
   * the service "resolves every required predicate" — itself, at admission
   * time. This is a capability like standingAdvance: the wiring builds it
   * from the predicate registry and evidence sources, and the REQUEST has no
   * field a caller-supplied verdict could arrive through. The first draft
   * checked caller-provided records instead, and the review admitted an
   * unverified subject with hand-forged passed:true records; this closure is
   * that hole closed structurally.
   */
  verify: (subject: ProposalItemSubjectV1) => Promise<VerificationOutcome>;
  /** Current standing claim id, read fresh — the CAS expectation. */
  currentStanding: () => Promise<string | null>;
  /** Step 4: append the settlement record. Failures here are retried by recovery, not silently dropped. */
  recordSettlement: (record: { claimId: string; subjectDigest: string; at: number }) => Promise<void>;
  /** Step 5: rebuildable projections. A throw degrades observability only. */
  refreshProjections?: () => Promise<void>;
  now: () => number;
  rand?: () => Uint8Array | undefined;
}

export interface AdmissionResult {
  claim: AdmissionClaimV1;
}

export interface AdmissionService {
  /**
   * Admit one proposal. Throws AdmissionRefusedError (typed, specific) when
   * the refusal table says no; throws RefCasError when standing moved under
   * the admission (the caller re-reads and re-decides — never retries
   * blindly, because the new standing may change the human's answer).
   */
  admit(request: AdmissionRequest): Promise<AdmissionResult>;
}

export function createAdmissionService(deps: AdmissionDeps): AdmissionService {
  // Admissions serialize: two concurrent gestures racing the same standing
  // ref would both read the same expectation, and the loser's refusal should
  // be the clean RefCasError from a consistent read — not an interleaved
  // claim store.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    admit(request) {
      return serialized(async () => {
        const now = deps.now();

        // 1. Revalidate, FRESH — the facts may have aged while this call
        //    waited behind another admission — and RUN the verification
        //    ourselves. The caller's opinion of the verdict never existed as
        //    an input.
        const outcome = await deps.verify(request.subject);
        requireAdmissible(request, outcome.records, now);
        if (!outcome.passed) {
          // requireAdmissible refuses per-record failures with specifics;
          // this is the belt for an outcome failing for any other reason
          // (zero records for a subject requiring some, an aggregate rule).
          throw new AdmissionRefusedError("verification_failed", "verification did not pass for the exact subject");
        }

        // 2. Durable claim, before any authority moves. If we crash after
        //    this line, the claim is unattached evidence: retriable, harmless.
        const expected = await deps.currentStanding();
        const claim = buildAdmissionClaim({
          subjectDigest: request.proposal.subjectDigest,
          proposalId: request.proposal.id,
          gestureRef: request.authority.kind === "human-gesture" ? request.authority.gestureRef : "",
          verification: outcome.records,
          expectedStanding: expected,
          now,
          rand: deps.rand?.(),
        });
        await deps.claims.append(claim);

        // 3. The authority transition itself. RefCasError propagates — the
        //    caller re-reads and re-decides.
        await deps.standingAdvance(expected, claim.id);

        // 4. Settlement record. A failure here is NOT unwound (the admission
        //    HAS happened); recovery completes the record from the claim.
        await deps.recordSettlement({ claimId: claim.id, subjectDigest: claim.subjectDigest.value, at: now });

        // 5. Projections: best-effort, rebuildable by definition.
        try {
          await deps.refreshProjections?.();
        } catch (e) {
          console.error("[governor] projection refresh after admission failed (rebuildable)", e);
        }

        return { claim };
      });
    },
  };
}

export { AdmissionRefusedError, RefCasError };
