// PROPOSAL BUILDER — from an operation's evidence to a canonical subject (WP6).
//
// The builder is where D16's dependency rule becomes structural for
// proposals: an EPHEMERAL observation cannot support one. The subject
// schema already rejects `capture: "ephemeral"` entries; what this adds is
// the earlier, friendlier refusal — the builder checks the observation
// records themselves (level + payload availability) before the subject is
// even assembled, so the caller learns WHICH dependency fails and why,
// rather than getting a schema error naming a row number.
//
// Everything here is pure assembly and validation. Digests arrive computed
// (exact note bytes are hashed where the bytes are read); the builder never
// reads the vault.

import { SubjectInvalidError, buildProposalItemSubject, type ProposalItemInput, type ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { ChangeClass } from "../contracts/change-class.js";
import type { Sha256Digest } from "@vault-mcp/core";

/** The slice of an observation record the builder validates against. */
export interface SupportingObservation {
  id: string;
  level: "ephemeral" | "evidence" | "replayable";
  digest: Sha256Digest;
  /** For replayable observations: whether the payload is actually in the store. */
  payloadAvailable: boolean;
}

export class ProposalDependencyError extends Error {
  readonly code = "proposal_dependency_invalid";
  constructor(detail: string) {
    super(`proposal dependency invalid: ${detail}`);
    this.name = "ProposalDependencyError";
  }
}

export interface BuildProposalSubjectInput {
  vaultId: string;
  noteId: string;
  path: string | null;
  pathSemanticallyRelevant: boolean;
  base: Sha256Digest | null;
  proposed: Sha256Digest;
  changeClasses: ChangeClass[];
  transformation: { id: string; version: string };
  predicates: Array<{ id: string; version: string }>;
  producingOperation: { id: string; action: string; actionVersion: number };
  observations: SupportingObservation[];
  sessionId: string;
  mandateId: string | null;
  attachments?: ProposalItemInput["attachments"];
  sideEffects?: ProposalItemInput["sideEffects"];
}

/**
 * Validate the supporting observations and assemble the canonical subject.
 *
 * The refusals, in D16's terms: ephemeral supports nothing (re-observe
 * durably before dependent work); a replayable observation whose payload is
 * gone supports nothing either — its durability was the point, and claiming
 * it while the payload is unpullable would make the proposal's evidence
 * unverifiable at exactly the moment someone tries to verify it.
 */
export function buildProposalSubjectFromOperation(input: BuildProposalSubjectInput): ProposalItemSubjectV1 {
  for (const obs of input.observations) {
    if (obs.level === "ephemeral") {
      throw new ProposalDependencyError(
        `observation ${obs.id} is ephemeral and cannot support a proposal; re-observe durably before dependent work (D16)`
      );
    }
    if (obs.level === "replayable" && !obs.payloadAvailable) {
      throw new ProposalDependencyError(
        `observation ${obs.id} claims replayability but its payload is not in the store; the claim would be unverifiable`
      );
    }
  }
  if (input.changeClasses.length === 0) {
    throw new SubjectInvalidError("a proposal names at least one change class; a read proposes nothing");
  }

  return buildProposalItemSubject({
    vaultId: input.vaultId,
    noteId: input.noteId,
    path: input.path,
    pathSemanticallyRelevant: input.pathSemanticallyRelevant,
    base: input.base,
    proposed: input.proposed,
    attachments: input.attachments ?? [],
    sideEffects: input.sideEffects ?? [],
    changeClasses: input.changeClasses,
    transformation: input.transformation,
    predicates: input.predicates,
    producingOperation: input.producingOperation,
    observations: input.observations.map((o) => ({ id: o.id, digest: o.digest, capture: o.level as "evidence" | "replayable" })),
    sessionId: input.sessionId,
    mandateId: input.mandateId,
  });
}
