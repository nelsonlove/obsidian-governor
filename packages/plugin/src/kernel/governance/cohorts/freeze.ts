// FREEZE — from a selection to an immutable exact manifest (WP7, D02/D13).
//
// The freeze is the moment a query stops being a query: the selected items'
// canonical subjects are bound into ONE cohort subject whose digest covers
// every item, the resolved scope, the exclusions, and the recovery unit.
// After this moment, "later work cannot enter" is not a policy but an
// arithmetic fact — a new proposal changes the item list, the item list
// changes the canonical bytes, and the bytes change the digest the human's
// gesture covers. Admission compares digests; a drifted cohort refuses.
//
// Exclusions likewise: leaving an item out is a DIFFERENT decision, so
// excludeAndRefreeze produces a NEW frozen subject with a NEW digest — the
// original decision is never edited, it is superseded by another one.
//
// WP7b OBLIGATION, stated here because the pure half cannot enforce it: the
// admission gesture must RECOMPUTE subjectDigest(frozen.subject) at decision
// time and compare it to the digest the gesture covers — never trust the
// precomputed frozen.digest. A mutated structure makes the precomputed value
// stale, not wrong; recomputation is what turns tampering into a refusal
// (the cohort-level analogue of the item path's subject_drift). The returned
// structure is deep-frozen as belt; the recomputation is the suspenders.

import { buildCohortSubject, subjectDigest, SubjectInvalidError, type CohortSubjectV1 } from "../contracts/subject-v1.js";
import type { Sha256Digest } from "../contracts/digest.js";
import { groupIneligibilityOf } from "./cohort.js";
import type { ProposalV1 } from "../proposals/proposal.js";

export interface FrozenCohort {
  subject: CohortSubjectV1;
  digest: Sha256Digest;
  /** The member proposals, in the subject's canonical item order. */
  memberProposalIds: string[];
}

export interface FreezeInput {
  items: readonly ProposalV1[];
  resolvedScope: { include: string[]; exclude: string[] };
  recoveryUnit: "item" | "cohort";
  /** Proposal ids DELIBERATELY left out of an earlier freeze of this selection. */
  excludedProposalIds?: string[];
}

/**
 * Freeze a selection. Refuses an ineligible group (mixed classes,
 * transformations, or mandates) — a selector may select anything; only an
 * eligible group may become a decision subject.
 */
export function freezeCohort(input: FreezeInput): FrozenCohort {
  const ineligible = groupIneligibilityOf(input.items);
  if (ineligible !== null) throw new SubjectInvalidError(`cannot freeze: ${ineligible}`);

  const subject = buildCohortSubject({
    items: input.items.map((p) => p.subject),
    resolvedScope: input.resolvedScope,
    excludedProposalIds: [...(input.excludedProposalIds ?? [])],
    recoveryUnit: input.recoveryUnit,
  });
  const digest = subjectDigest(subject);

  // Member ids in the SUBJECT's canonical item order, correlated by the item
  // digest identity (vaultId+noteId is unique within a cohort by schema).
  const byIdentity = new Map(input.items.map((p) => [`${p.subject.vaultId}\u0000${p.subject.noteId}`, p.id]));
  const memberProposalIds = subject.items.map((item) => {
    const id = byIdentity.get(`${item.vaultId}\u0000${item.noteId}`);
    if (!id) throw new SubjectInvalidError(`frozen item ${item.noteId} has no source proposal — the freeze input drifted mid-call`);
    return id;
  });

  // Belt: a frozen decision structure should refuse casual mutation. The
  // suspenders are WP7b's digest recomputation (see the header) — deep
  // freezing alone is defeatable and is not the guarantee.
  deepFreeze(subject);
  Object.freeze(memberProposalIds);
  return Object.freeze({ subject, digest: Object.freeze(digest), memberProposalIds });
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
}

/**
 * Exclude items and produce the SUCCESSOR decision subject. The original
 * frozen cohort is untouched — its digest still names exactly what it named.
 * The successor lists the excluded proposal ids IN ITS SUBJECT, so the
 * exclusion itself is part of what the eventual gesture covers.
 */
export function excludeAndRefreeze(original: FreezeInput, frozen: FrozenCohort, excludeProposalIds: readonly string[]): FrozenCohort {
  // The (original, frozen) pair is caller-correlated, and this module's whole
  // philosophy is arithmetic over trust — so the correlation is CHECKED:
  // re-freezing the claimed original must reproduce the frozen digest, or a
  // mismatched pair could mint a successor whose subject silently diverges
  // from what the exclusion claims (proven by the review's construction).
  const refrozen = freezeCohort(original);
  if (refrozen.digest.value !== frozen.digest.value) {
    throw new SubjectInvalidError(
      "the claimed original does not re-freeze to the frozen cohort's digest; refusing to exclude from a decision that is not the one presented"
    );
  }
  const excludeSet = new Set(excludeProposalIds);
  const unknown = excludeProposalIds.filter((id) => !frozen.memberProposalIds.includes(id));
  if (unknown.length > 0) {
    throw new SubjectInvalidError(`cannot exclude ${unknown.join(", ")}: not members of the frozen cohort`);
  }
  const keep = original.items.filter((p) => !excludeSet.has(p.id));
  return freezeCohort({
    ...original,
    items: keep,
    excludedProposalIds: [...(original.excludedProposalIds ?? []), ...excludeProposalIds].sort(),
  });
}
