// RECOVERY — settlement inspection and repair plans (WP4).
//
// The store-side half of crash recovery (guide §10): given what the journal
// says was INTENDED and what the repository actually HOLDS, produce a typed
// plan. Pure — the caller gathers the facts, this decides what they mean.
//
// The doctrine that shapes every branch: absence is evidence, not emptiness;
// nothing here invents an admission, revives authority, or advances a ref.
// A plan only ever proposes re-recording (idempotent, content-addressed) or
// surfacing to a human. The dangerous direction — deciding an admission DID
// happen because it plausibly should have — is structurally unavailable:
// there is no plan kind for it.

import type { ObjectId } from "./types.js";

/** What the journal's last record says the store should hold. */
export interface SettlementExpectation {
  ref: string;
  /** The commit the journal says the ref should point at, null = ref should not exist. */
  expectedCommit: ObjectId | null;
}

/** What inspection of the repository actually found. */
export interface SettlementObservation {
  /** Current ref value, null = ref absent. */
  actualCommit: ObjectId | null;
  /** Whether the expected commit object exists and reads back clean. */
  expectedCommitReadable: boolean | null;
  /** Whether every object reachable from the actual ref value reads back clean. */
  actualObjectsReadable: boolean;
}

export type RepairPlan =
  | { kind: "consistent"; detail: string }
  | { kind: "re-record"; detail: string }
  | { kind: "ref-behind"; detail: string }
  | { kind: "surface-to-human"; detail: string };

/**
 * Decide the repair plan. Total over its inputs, no I/O.
 *
 * - consistent      — the store matches the journal; nothing to do.
 * - re-record       — the intended objects never landed (crash between apply
 *                     and record); re-recording is idempotent and safe.
 * - ref-behind      — the objects exist but the ref does not name them; the
 *                     CAS advance is what crashed. Re-advancing is safe ONLY
 *                     because the objects are content-addressed and already
 *                     verified readable.
 * - surface-to-human — anything else: corruption, a ref pointing somewhere
 *                     the journal never intended, an expectation the store
 *                     contradicts. No automatic repair invents facts.
 */
export function planRecovery(expected: SettlementExpectation, observed: SettlementObservation): RepairPlan {
  if (!observed.actualObjectsReadable) {
    return {
      kind: "surface-to-human",
      detail: `objects reachable from ${expected.ref} do not read back clean; the store needs human inspection, not an automatic rewrite`,
    };
  }

  if (expected.expectedCommit === null) {
    if (observed.actualCommit === null) return { kind: "consistent", detail: "ref absent as intended" };
    return {
      kind: "surface-to-human",
      detail: `ref ${expected.ref} exists at ${observed.actualCommit} but the journal never intended it; refusing to guess`,
    };
  }

  if (observed.actualCommit === expected.expectedCommit) {
    return { kind: "consistent", detail: "ref at the intended commit" };
  }

  if (observed.expectedCommitReadable === true) {
    // The intended commit landed; only the ref advance is missing or stale.
    return {
      kind: "ref-behind",
      detail: `commit ${expected.expectedCommit} exists but ${expected.ref} points at ${observed.actualCommit ?? "<absent>"}; the CAS advance did not settle`,
    };
  }

  if (observed.expectedCommitReadable === false) {
    // The crash happened before the objects landed. Re-recording from the
    // journal's inputs is idempotent — same bytes, same addresses.
    return {
      kind: "re-record",
      detail: `intended commit ${expected.expectedCommit} is not in the store; re-record from the journaled inputs`,
    };
  }

  return {
    kind: "surface-to-human",
    detail: "the expected commit's readability was not inspected; inspect before repairing",
  };
}
