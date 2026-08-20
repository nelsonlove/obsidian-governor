// OBSERVATION DEPENDENCIES — Gate 0, WP2 (D16).
//
// The rule that gives capture levels their teeth: an ephemeral observation can
// never support a proposal, a verification result, or an admission. Governor
// re-observes durably instead of promoting a result it did not keep.
//
// Why this is the load-bearing half rather than bookkeeping: without it, "this
// change was based on what I read" degrades into an assertion nobody can check.
// The entire point of capturing reads is that a reviewer can see what the agent
// was actually shown — and a level that retains nothing cannot deliver that,
// however confidently a later claim cites it.
//
// The checks are deliberately conservative in the same direction throughout:
// unknown, partial, truncated and unavailable all REFUSE. A claim built on a
// vault that was never fully seen is not a weaker claim; it is a different one.

import { atLeast, type CaptureLevel } from "./capture-policy.js";

/** What is depending on the observation. Each has its own sufficiency floor. */
export type DependentClaim = "proposal" | "verification" | "admission";

/**
 * The minimum capture level each claim can be built on.
 *
 * `proposal` accepts `evidence`: a proposal states what it intends to change
 * and carries its own diff, so identities and source state can be enough to
 * establish what it was working from.
 *
 * `verification` and `admission` require `replayable`. A verifier compares
 * CONTENT — a digest proves that something was read, never what it said — and
 * an admission rests on the verification. Accepting evidence there would let a
 * predicate claim to have checked bytes nobody kept.
 */
const REQUIRED: Record<DependentClaim, CaptureLevel> = {
  proposal: "evidence",
  verification: "replayable",
  admission: "replayable",
};

/** Stable codes, with the reason each exists. Cited by build output and
 * receipts, so renaming one unlinks a documented failure from its emitter. */
export const DEPENDENCY_PROBLEMS: Record<string, string> = {
  no_dependencies:
    "the claim requires supporting observations and names none; a claim with no evidence is not a weaker claim, it is an unsupported one",
  ephemeral_dependency:
    "an ephemeral observation retained nothing, so nothing depending on it can be re-checked; re-observe durably rather than promoting it",
  insufficient_capture:
    "the observation's capture level is below what this claim needs — most often evidence where a verifier needs the exact bytes it compared",
  foreign_session:
    "the observation belongs to another session; evidence does not transfer between work envelopes without an explicit admitted source",
  truncated_dependency:
    "the observation's result was truncated, so it cannot support a claim about the whole of what it read",
  unavailable_source:
    "a source the observation needed was unavailable, so it describes a vault that was never fully seen",
};

export interface DependencyObservation {
  id: string;
  level: CaptureLevel;
  sessionId: string | null;
  sourceState: Array<{ identity: string; path: string | null; revision: string | null; contentDigest: string | null }>;
  result: { truncated: boolean; unavailable: string[]; payloadObject?: string | null };
}

export interface DependencyProblem {
  code: keyof typeof DEPENDENCY_PROBLEMS;
  observationId: string | null;
  message: string;
}

export interface DependencyCheck {
  observations: DependencyObservation[];
  claim: DependentClaim;
  /** The session the dependent claim belongs to. */
  sessionId: string | null;
  /** Observation ids from another session that a human has explicitly admitted
   * as a source. Empty by default — cross-session evidence is a decision, never
   * a convenience. */
  admittedForeign?: string[];
}

export function validateDependencies(check: DependencyCheck): DependencyProblem[] {
  const problems: DependencyProblem[] = [];
  const required = REQUIRED[check.claim];
  const admitted = new Set(check.admittedForeign ?? []);

  const push = (code: keyof typeof DEPENDENCY_PROBLEMS, observationId: string | null, detail = "") =>
    problems.push({ code, observationId, message: `${DEPENDENCY_PROBLEMS[code]}${detail ? ` (${detail})` : ""}` });

  if (check.observations.length === 0) {
    push("no_dependencies", null, `claim: ${check.claim}`);
    return problems;
  }

  for (const obs of check.observations) {
    // Checked first and separately from `insufficient_capture`, because
    // "retained nothing" and "retained the wrong thing" are different failures
    // and a caller fixes them differently.
    if (obs.level === "ephemeral") {
      push("ephemeral_dependency", obs.id);
      continue;
    }
    if (!atLeast(obs.level, required)) {
      push("insufficient_capture", obs.id, `has '${obs.level}', ${check.claim} needs '${required}'`);
    }
    if (obs.sessionId !== check.sessionId && !admitted.has(obs.id)) {
      push("foreign_session", obs.id, `observed in '${obs.sessionId}', claimed in '${check.sessionId}'`);
    }
    // Truncation only invalidates a claim about the WHOLE result. A proposal
    // over one named note is not weakened by a listing having been capped, so
    // this is scoped to the claims that reason over completeness.
    if (obs.result.truncated && required === "replayable") {
      push("truncated_dependency", obs.id);
    }
    if (obs.result.unavailable.length > 0) {
      push("unavailable_source", obs.id, obs.result.unavailable.join(", "));
    }
  }

  return problems;
}
