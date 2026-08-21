// PREDICATES — versioned, deterministic verification (WP6, D03/D13).
//
// A predicate proves ONE stated property of an exact subject — never
// universal correctness ("an encoding verifier cannot certify that a factual
// assertion is true", change-classes.md). Versioned because a predicate's
// meaning is part of what an attestation covers: the subject schema carries
// {id, version} pairs, and a result from predicate p@1 says nothing about
// what p@2 would decide.
//
// Determinism is the contract: same subject, same evidence, same verdict.
// Evaluators receive everything they may consult as ARGUMENTS — no clock, no
// vault, no network — so a re-evaluation years later reaches the same verdict
// or fails loudly because the evidence is gone.

import type { ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { Sha256Digest } from "../contracts/digest.js";
import type { ChangeClass } from "../contracts/change-class.js";

/** What a predicate may consult, beyond the subject itself. */
export interface VerificationEvidence {
  /** Exact current bytes of the proposed result, when the predicate needs them. */
  proposedBytes?: Uint8Array | null;
  /** Exact base bytes, when the predicate compares. */
  baseBytes?: Uint8Array | null;
  /** Resolver for observation payloads by digest — replayable evidence only. */
  observationPayload?: (digest: Sha256Digest) => Promise<unknown | null>;
}

export interface PredicateResult {
  passed: boolean;
  /** Human-readable, specific: what was checked and what was found. */
  detail: string;
}

export interface PredicateV1 {
  id: string;
  version: string;
  /** Which change classes this predicate is meaningful for. */
  appliesTo: ChangeClass[];
  /** One sentence: the property this predicate proves. Shown to the human. */
  proves: string;
  evaluate(subject: ProposalItemSubjectV1, evidence: VerificationEvidence): Promise<PredicateResult>;
}

/** A recorded verification outcome — evidence, addressed to the exact subject. */
export interface VerificationRecord {
  predicate: { id: string; version: string };
  /** The subject digest this verdict is ABOUT. A verdict for another digest is not a verdict. */
  subjectDigest: Sha256Digest;
  passed: boolean;
  detail: string;
  evaluatedAt: number;
}
