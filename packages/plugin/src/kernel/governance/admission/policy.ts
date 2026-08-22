// ADMISSION POLICY — what admission REQUIRES, as one refusal table (WP6, §9).
//
// The guide's list of what the admission call does not accept, made
// structural. Every rule is a typed refusal with the reason in the message,
// because each refusal reaches a human deciding whether to fix or abandon.
//
// The policy is PURE: it receives facts (the proposal, the verification
// records, the authority reference, the clock) and answers. Gathering the
// facts honestly is the service's job; deciding is this module's.

import { subjectDigest, type CohortSubjectV1, type ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { ProposalV1 } from "../proposals/proposal.js";
import type { VerificationRecord } from "../verification/predicate.js";
import type { CohortCoverageOutcome } from "../cohorts/coverage.js";

/** How this admission is authorized. WP6 knows gestures; mandates are WP9. */
export type AdmissionAuthority =
  | {
      kind: "human-gesture";
      /** An opaque reference minted by the gesture path (never caller-supplied). */
      gestureRef: string;
    }
  | {
      kind: "mandate";
      mandateId: string;
    };

export class AdmissionRefusedError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    /** Member noteIds a cohort refusal names — STRUCTURED, so split-by-finding never parses prose (a noteId containing ", " or "—" would corrupt a regex extraction). */
    readonly failedNoteIds?: string[]
  ) {
    super(`admission refused [${code}]: ${detail}`);
    this.name = "AdmissionRefusedError";
  }
}

export interface AdmissionRequest {
  proposal: ProposalV1;
  /** The subject as the CALLER believes it stands. Revalidated against the proposal's. */
  subject: ProposalItemSubjectV1;
  authority: AdmissionAuthority;
}

/**
 * The refusal table. Returns nothing; throws the first violated rule.
 *
 * `verification` is NOT part of the request: the records arrive from the
 * SERVICE, which ran them itself. The first draft accepted caller-supplied
 * records and compared them to the subject's predicate list — and since the
 * caller controls both the subject and the records, it could forge matching
 * pairs freely (proven by the review's exploit: an unverified subject
 * admitted with hand-built passed:true records). Removing the field is the
 * fix §9 actually asks for: "resolves every required predicate" is the
 * service's act, and a verdict has no path into admission except through it.
 *
 * Order matters only for message quality — every rule is independently
 * sufficient to refuse, and none may be skipped for any caller.
 */
export function requireAdmissible(request: AdmissionRequest, verification: VerificationRecord[], now: number): void {
  const { proposal, subject, authority } = request;

  // The exact subject, not a selector: the caller's subject must digest to
  // exactly what the proposal recorded. A drifted working tree, an edited
  // manifest, a "close enough" — all land here.
  const digest = subjectDigest(subject);
  if (digest.value !== proposal.subjectDigest.value) {
    throw new AdmissionRefusedError(
      "subject_drift",
      `the subject digests to ${digest.value.slice(0, 12)}… but the proposal covers ${proposal.subjectDigest.value.slice(0, 12)}…; re-propose the current state`
    );
  }

  if (proposal.authority !== "proposed") {
    throw new AdmissionRefusedError("proposal_not_proposed", `the proposal is ${proposal.authority}; only a proposed subject can be admitted`);
  }
  // §9: "a result with partial, uncertain, receiving, or conflicted state"
  // is never admitted. The proposal records its producing operation's
  // outcome at open; anything but a clean completion refuses here.
  if (proposal.producedOutcome !== "completed") {
    throw new AdmissionRefusedError(
      "result_not_settled",
      `the producing operation's outcome is '${proposal.producedOutcome}'; only a completed result can be admitted`
    );
  }
  if (proposal.development === "revision-requested") {
    throw new AdmissionRefusedError("revision_open", "a revision was requested; the revised result is a new subject");
  }

  // Ephemeral dependencies cannot support admission (D16). The subject
  // schema already refuses them; this re-checks at the decision boundary
  // because admission is the last door and doors do not trust hallways.
  for (const obs of subject.observations) {
    if ((obs.capture as string) === "ephemeral") {
      throw new AdmissionRefusedError("ephemeral_dependency", `observation ${obs.id} is ephemeral and supports nothing`);
    }
  }

  // Verification: exact coverage of the EXACT digest, every record passed,
  // and no required predicate missing. The records parameter arrives from
  // the SERVICE, which ran them — the request type has no field a
  // caller-supplied verdict could ride in on.
  //
  // The proposal's verification AXIS is deliberately not checked here: it is
  // a projection, and the truth is the freshly-run outcome — a proposal whose
  // axis lags at "unverified" admits fine when the predicates pass NOW, and
  // an axis claiming "passed" proves nothing. (The proposal STORE's
  // withAdmitted still requires the axis, so the projection catches up
  // through setVerification before markAdmitted — two records, each honest
  // about what it is.)
  const required = new Map(subject.predicates.map((p) => [`${p.id}@${p.version}`, false]));
  for (const record of verification) {
    if (record.subjectDigest.value !== digest.value) {
      throw new AdmissionRefusedError(
        "verification_stale",
        `verification of ${record.predicate.id}@${record.predicate.version} addresses a different subject; the subject changed after it ran`
      );
    }
    const k = `${record.predicate.id}@${record.predicate.version}`;
    if (!required.has(k)) continue; // extra verification is harmless; it just proves nothing required
    if (!record.passed) {
      throw new AdmissionRefusedError("verification_failed", `${k} failed: ${record.detail}`);
    }
    required.set(k, true);
  }
  const missing = [...required.entries()].filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length > 0) {
    throw new AdmissionRefusedError("verification_incomplete", `required verification missing: ${missing.join(", ")} — coverage is exact and total, never sampled`);
  }

  // Authority. WP6 admits only through the human gesture; a mandate-kind
  // authority refuses OUTRIGHT until WP9 builds real mandate validation —
  // "no automatic mandated admission" is a Gate 1 condition (D14), so the
  // refusal is the implementation, not a stub of one.
  if (authority.kind === "mandate") {
    throw new AdmissionRefusedError("mandate_not_supported", "mandated admission does not exist until WP9; Gate 1 admits only through the human gesture");
  }
  if (!authority.gestureRef) {
    throw new AdmissionRefusedError("authority_missing", "admission requires the gesture reference minted by the accept surface");
  }

  // A subject claiming to have run under a mandate cannot be admitted before
  // mandates exist — the claim would be unverifiable.
  if (subject.mandateId !== null) {
    throw new AdmissionRefusedError("mandate_not_supported", `the subject claims mandate ${subject.mandateId}, which cannot be validated before WP9`);
  }

  void now; // expiry checks arrive with mandates; the parameter is the seam
}

export interface CohortAdmissionRequest {
  /** The frozen decision subject, as presented to the human. */
  frozenSubject: CohortSubjectV1;
  /** The digest the GESTURE covered — what the human saw and confirmed. */
  gestureCoveredDigest: string;
  /** The member proposals, in the subject's canonical item order. */
  memberProposals: ProposalV1[];
  authority: AdmissionAuthority;
}

/**
 * The cohort refusal table (WP7b). The frozen structure is RECOMPUTED, never
 * trusted (freeze.ts's stated obligation): tampering makes the precomputed
 * digest stale, and recomputation is what turns tampering into a refusal.
 * Coverage arrives from the SERVICE's own run (the WP6a lesson at birth);
 * one failed item fails the gesture whole, with the items named —
 * review-and-safety's abort rule at cohort scale.
 */
export function requireCohortAdmissible(request: CohortAdmissionRequest, coverage: CohortCoverageOutcome, now: number): void {
  const { frozenSubject, memberProposals, authority } = request;

  // The RECOMPUTED digest must be what the gesture covered. A tampered
  // structure, a drifted member (re-observed digests are rebuilt into the
  // click-time subject by the wiring), or a stale presentation all land here.
  const recomputed = subjectDigest(frozenSubject);
  if (recomputed.value !== request.gestureCoveredDigest) {
    throw new AdmissionRefusedError(
      "subject_drift",
      `the cohort recomputes to ${recomputed.value.slice(0, 12)}… but the gesture covered ${request.gestureCoveredDigest.slice(0, 12)}…; the decision changed between presentation and click`
    );
  }

  // Members correlate to frozen items by NOTE IDENTITY, never by position:
  // buildCohortSubject sorts items canonically by noteId while callers hold
  // members in selection order, so a positional check would refuse legitimate
  // cohorts whenever real-vault noteIds don't happen to ascend in selection
  // order (review finding — every early test's uid-001…uid-00N ascended, so
  // position and canon always agreed and the suite couldn't see it).
  if (memberProposals.length !== frozenSubject.items.length) {
    throw new AdmissionRefusedError("subject_drift", "the member list does not match the frozen manifest");
  }
  const byIdentity = new Map(memberProposals.map((p) => [`${p.subject.vaultId}\u0000${p.subject.noteId}`, p]));
  if (byIdentity.size !== memberProposals.length) {
    throw new AdmissionRefusedError("subject_drift", "the member list carries duplicate note identities");
  }
  for (const item of frozenSubject.items) {
    const proposal = byIdentity.get(`${item.vaultId}\u0000${item.noteId}`);
    if (!proposal) {
      throw new AdmissionRefusedError("subject_drift", `frozen item ${item.noteId} has no corresponding member proposal`);
    }
    if (proposal.authority !== "proposed") {
      throw new AdmissionRefusedError("proposal_not_proposed", `member ${item.noteId} is ${proposal.authority}; only proposed items admit`);
    }
    if (proposal.producedOutcome !== "completed") {
      throw new AdmissionRefusedError("result_not_settled", `member ${item.noteId}'s producing operation was '${proposal.producedOutcome}'`);
    }
    // The item table's rule at cohort scale: an open human objection blocks
    // the member, and one blocked member blocks the decision (whole-abort).
    // A revision request flips no note bytes, so drift and coverage both
    // pass over it — this row is the ONLY thing that can see it.
    if (proposal.development === "revision-requested") {
      throw new AdmissionRefusedError("revision_open", `a revision was requested on member ${item.noteId}; the revised result is a new subject`, [item.noteId]);
    }
    if (item.mandateId !== null) {
      throw new AdmissionRefusedError("mandate_not_supported", `member ${item.noteId} claims a mandate, which cannot be validated before WP9`);
    }
  }

  // Coverage: the service's own run, exact and total, addressed to THIS digest.
  if (coverage.cohortDigest !== recomputed.value) {
    throw new AdmissionRefusedError("verification_stale", "the coverage outcome addresses a different cohort digest");
  }
  if (!coverage.passed) {
    throw new AdmissionRefusedError(
      "verification_failed",
      `coverage failed for ${coverage.failedNoteIds.length} member(s): ${coverage.failedNoteIds.join(", ")} — exclude-and-refreeze (split by finding) or resolve them; a failed item is never silently dropped or admitted`
    );
  }

  if (authority.kind === "mandate") {
    throw new AdmissionRefusedError("mandate_not_supported", "mandated admission does not exist until WP9");
  }
  if (!authority.gestureRef) {
    throw new AdmissionRefusedError("authority_missing", "cohort admission requires the gesture reference minted by the accept surface");
  }

  // Cross-item base compatibility (change-classes' "compatible base state")
  // in its CROSS-item sense — all bases sampled from one consistent
  // world-state — is session-base territory (D01) and lands with the
  // session-base predicate, not here: per-item base agreement is what
  // coverage just proved. Named so the omission reads as a decision.
  void now;
}
