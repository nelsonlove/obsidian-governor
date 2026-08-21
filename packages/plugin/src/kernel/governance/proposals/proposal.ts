// PROPOSALS — a governed change awaiting authority (WP6, D03/D11/D13).
//
// A proposal is the durable record that a specific operation produced a
// specific result — canonical subject, exact digests — and that the result
// now sits in the VISIBLE working tree (D11) waiting for verification and a
// human decision. The proposal does not hold the bytes; the history store
// holds the recording and the vault holds the visible result. What lives
// here is the identity, the subject, and the state axes.
//
// State is the five-axis model (contracts/states), not one enum: a proposal
// can be development-ready, verification-stale, and authority-proposed all at
// once, and collapsing those was the old model's mistake.

import { mintId, type ProposalId } from "../contracts/ids.js";
import { subjectDigest, type ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { Sha256Digest } from "../contracts/digest.js";
import type { AuthorityState, DevelopmentState, VerificationState } from "../contracts/states.js";

export interface ProposalV1 {
  schema: "governor.proposal/v1";
  id: ProposalId;
  /** The canonical subject — what an acceptance would cover, exactly. */
  subject: ProposalItemSubjectV1;
  /** subjectDigest(subject), precomputed: the identity every later record uses. */
  subjectDigest: Sha256Digest;
  /** The session that produced it (D01: replica-local). */
  sessionId: string;
  /** The producing operation, mirrored from the subject for cheap lookup. */
  operationId: string;
  /** The history-store recording ref holding the snapshot, when recorded. */
  recordingRef: string | null;
  createdAt: number;
  /**
   * The producing operation's outcome, recorded at open. §9 refuses partial,
   * uncertain, receiving, or conflicted results; only "completed" admits.
   */
  producedOutcome: string;
  development: DevelopmentState;
  verification: VerificationState;
  authority: AuthorityState;
}

/** A proposal may not change once its subject is decided — amendments are new proposals. */
export class ProposalStateError extends Error {
  readonly code = "proposal_state_invalid";
  constructor(detail: string) {
    super(`invalid proposal state transition: ${detail}`);
    this.name = "ProposalStateError";
  }
}

export interface OpenProposalInput {
  subject: ProposalItemSubjectV1;
  sessionId: string;
  recordingRef?: string | null;
  /** The producing operation's outcome. Defaults to "completed" — the only admissible value. */
  producedOutcome?: string;
}

/**
 * Create a proposal from a built canonical subject. The digest is computed
 * HERE, once, and every later stage compares against it — a stage that
 * recomputes from a subject it was handed could be handed a different
 * subject.
 */
export function openProposal(input: OpenProposalInput, now: number, rand?: Uint8Array): ProposalV1 {
  return {
    schema: "governor.proposal/v1",
    id: mintId("proposal", now, rand),
    subject: input.subject,
    subjectDigest: subjectDigest(input.subject),
    sessionId: input.sessionId,
    operationId: input.subject.producingOperation.id,
    recordingRef: input.recordingRef ?? null,
    createdAt: now,
    producedOutcome: input.producedOutcome ?? "completed",
    development: "ready",
    verification: "unverified",
    authority: "proposed",
  };
}

/** Verification outcomes move ONLY the verification axis. */
export function withVerification(p: ProposalV1, v: VerificationState): ProposalV1 {
  if (p.authority !== "proposed") throw new ProposalStateError(`verification cannot change on a ${p.authority} proposal`);
  return { ...p, verification: v };
}

/**
 * Admission moves the authority axis — and ONLY through the admission
 * service, which is why this helper takes the admission claim id as evidence
 * rather than trusting the caller's word that one exists.
 */
export function withAdmitted(p: ProposalV1, admissionClaimId: string): ProposalV1 {
  if (p.authority !== "proposed") throw new ProposalStateError(`cannot admit a ${p.authority} proposal`);
  if (p.verification !== "passed") throw new ProposalStateError("cannot admit an unverified proposal");
  if (!admissionClaimId) throw new ProposalStateError("admission requires the claim id as evidence");
  return { ...p, authority: "admitted" };
}

/** A superseded proposal keeps its history; a new proposal carries the work. */
export function withSuperseded(p: ProposalV1): ProposalV1 {
  if (p.authority === "admitted") throw new ProposalStateError("an admitted proposal is superseded by a NEW admission, not by editing this one");
  return { ...p, authority: "superseded" };
}

/** Revision requested: development reopens, authority stays proposed. */
export function withRevisionRequested(p: ProposalV1): ProposalV1 {
  if (p.authority !== "proposed") throw new ProposalStateError(`cannot request revision on a ${p.authority} proposal`);
  return { ...p, development: "revision-requested", verification: "stale" };
}
