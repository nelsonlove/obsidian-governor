// ADMISSION POLICY — what admission REQUIRES, as one refusal table (WP6, §9).
//
// The guide's list of what the admission call does not accept, made
// structural. Every rule is a typed refusal with the reason in the message,
// because each refusal reaches a human deciding whether to fix or abandon.
//
// The policy is PURE: it receives facts (the proposal, the verification
// records, the authority reference, the clock) and answers. Gathering the
// facts honestly is the service's job; deciding is this module's.

import { subjectDigest, type ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { ProposalV1 } from "../proposals/proposal.js";
import type { VerificationRecord } from "../verification/predicate.js";

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
    detail: string
  ) {
    super(`admission refused [${code}]: ${detail}`);
    this.name = "AdmissionRefusedError";
  }
}

export interface AdmissionRequest {
  proposal: ProposalV1;
  /** The subject as the CALLER believes it stands. Revalidated against the proposal's. */
  subject: ProposalItemSubjectV1;
  verification: VerificationRecord[];
  authority: AdmissionAuthority;
}

/**
 * The refusal table. Returns nothing; throws the first violated rule.
 *
 * Order matters only for message quality — every rule is independently
 * sufficient to refuse, and none may be skipped for any caller.
 */
export function requireAdmissible(request: AdmissionRequest, now: number): void {
  const { proposal, subject, verification, authority } = request;

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
  // and no required predicate missing. Caller-supplied "trust me, it passed"
  // has no field to arrive through — records are compared to the subject's
  // own predicate list.
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
