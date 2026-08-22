// SETTLEMENT — durable admission claims and crash-recovery decisions (WP6, §10).
//
// Two artifact kinds live here. The ADMISSION CLAIM is the durable statement
// "this exact subject was admitted under this authority at this moment" —
// content the standing ref points at, conceptually. The SETTLEMENT DECISION
// is what recovery concludes when the claim and the ref disagree after a
// crash. The guide's two sentences are the whole law:
//
//   "An admission claim written without a ref advance is unattached evidence
//    and can be retried safely. A ref that points to a missing or invalid
//    claim is a critical health failure and must not be presented as
//    standing."
//
// Asymmetric on purpose: the first is the objects-first-ref-last crash
// window and self-heals; the second means something advanced authority
// without evidence, and nothing self-heals THAT — it surfaces.

import { mintId } from "../contracts/ids.js";
import type { Sha256Digest } from "../contracts/digest.js";
import type { VerificationRecord } from "../verification/predicate.js";

export interface AdmissionClaimV1 {
  schema: "governor.admission-claim/v1";
  id: string;
  subjectDigest: Sha256Digest;
  proposalId: string;
  authority: { kind: "human-gesture"; gestureRef: string };
  verification: Array<{ predicate: { id: string; version: string }; passed: true }>;
  admittedAt: number;
  /** The standing ref value this admission expected to succeed (null = first admission). */
  expectedStanding: string | null;
  /**
   * The note identities this claim's subject covers — DERIVED from the
   * subject at build time, never supplied beside it (#334's shaping note: a
   * suppliable list would be a second, softer answer to "what did this click
   * admit?" arriving by a quieter door, the caller-supplied-verification
   * shape again). One entry for an item claim; every member for a cohort
   * claim (WP7b), pinned equal to the manifest. The resolver's chain walk
   * decides supersession NOTE-WISE from these: a subject is superseded only
   * by a newer claim covering the SAME note, never by an unrelated
   * admission.
   *
   * DECIDED (#335 review, finding 2): forSubject is a PER-ITEM question.
   * A cohort claim's own subjectDigest (the cohort manifest digest) has no
   * note identity, so querying it answers admitted-and-never-superseded —
   * which is coherent because a cohort decision is not a note: cohort
   * standing is a projection over its members' per-item answers, and
   * "was this exact cohort decision ever replaced" is a chain-history
   * question, not a standing one. WP7b builds its cohort projection over
   * member answers; it does not query cohort digests through forSubject.
   *
   * Schema note: added to /v1 in place — zero claims have ever been written
   * outside tests (the feature has been default-off since birth), so there
   * is no deployed data to migrate; older in-test claims without the field
   * degrade to subjectDigest-only matching.
   */
  coveredNotes: Array<{ vaultId: string; noteId: string; subjectDigest: string }>;
}

export interface ClaimIo {
  appendLine(line: string): Promise<void>;
  readLines(): Promise<string[]>;
}

export interface ClaimStore {
  append(claim: AdmissionClaimV1): Promise<void>;
  byId(id: string): Promise<AdmissionClaimV1 | null>;
  bySubject(subjectDigest: string): Promise<AdmissionClaimV1[]>;
  all(): Promise<AdmissionClaimV1[]>;
}

export function buildAdmissionClaim(args: {
  subjectDigest: Sha256Digest;
  proposalId: string;
  gestureRef: string;
  verification: VerificationRecord[];
  expectedStanding: string | null;
  /** The note identities the subject covers — the SERVICE derives these from the subject itself. */
  coveredNotes: Array<{ vaultId: string; noteId: string; subjectDigest: string }>;
  now: number;
  rand?: Uint8Array;
}): AdmissionClaimV1 {
  return {
    schema: "governor.admission-claim/v1",
    // The claim id is minted from the mintable "proposal" family's sibling —
    // claims are their own records; reusing the proposal id would make two
    // different facts share one identity.
    id: mintId("proposal", args.now, args.rand),
    subjectDigest: args.subjectDigest,
    proposalId: args.proposalId,
    authority: { kind: "human-gesture", gestureRef: args.gestureRef },
    verification: args.verification.filter((r) => r.passed).map((r) => ({ predicate: r.predicate, passed: true as const })),
    admittedAt: args.now,
    expectedStanding: args.expectedStanding,
    coveredNotes: args.coveredNotes.map((n) => ({ vaultId: n.vaultId, noteId: n.noteId, subjectDigest: n.subjectDigest })),
  };
}

export function createClaimStore(io: ClaimIo): ClaimStore {
  let lines: string[] | null = null;
  // The PARSED array is cached beside the lines (#335 review: per-call
  // re-parsing made a chain walk O(chain × store) — 415 ms per query at
  // cohort scale, ~4 minutes for a 600-member pane refresh). Both caches
  // advance together in append, through the same seed-before-append
  // ordering that closed the double-count bug.
  let parsedCache: AdmissionClaimV1[] | null = null;
  async function allLines(): Promise<string[]> {
    if (lines === null) lines = await io.readLines();
    return lines;
  }
  async function parsed(): Promise<AdmissionClaimV1[]> {
    if (parsedCache !== null) return parsedCache;
    const out: AdmissionClaimV1[] = [];
    for (const line of await allLines()) {
      try {
        const c = JSON.parse(line) as AdmissionClaimV1;
        if (c?.schema === "governor.admission-claim/v1") out.push(c);
      } catch {
        /* a corrupt tail must not take down prior claims */
      }
    }
    parsedCache = out;
    return out;
  }
  return {
    async append(claim) {
      // Cache seeded BEFORE the append: a cold cache read AFTER appendLine
      // already contains the new line, and pushing it again double-counts.
      const cached = await allLines();
      const cachedParsed = await parsed();
      const line = JSON.stringify(claim);
      await io.appendLine(line);
      cached.push(line);
      cachedParsed.push(claim);
    },
    async byId(id) {
      return (await parsed()).find((c) => c.id === id) ?? null;
    },
    async bySubject(subjectDigest) {
      return (await parsed()).filter((c) => c.subjectDigest.value === subjectDigest);
    },
    async all() {
      return parsed();
    },
  };
}

// ── recovery decisions ───────────────────────────────────────────────────────

export type SettlementDecision =
  | { kind: "settled"; detail: string }
  | { kind: "retry-ref-advance"; detail: string }
  | { kind: "critical-health-failure"; detail: string };

/**
 * Decide what a claim/ref pair means after a crash. Pure and total; the two
 * asymmetric rules from the header, plus the quiet case.
 */
export function decideSettlement(args: {
  /** The claim, if it is readable in the store. */
  claim: AdmissionClaimV1 | null;
  /** Whether the standing ref currently reflects this admission. */
  refReflectsClaim: boolean;
  /** Whether the ref names an admission for which NO readable claim exists. */
  refWithoutClaim: boolean;
}): SettlementDecision {
  if (args.refWithoutClaim) {
    return {
      kind: "critical-health-failure",
      detail: "the standing ref advanced without a readable admission claim; this must not be presented as standing — surface to a human, never rebuild the claim from the ref",
    };
  }
  if (args.claim && !args.refReflectsClaim) {
    return {
      kind: "retry-ref-advance",
      detail: `claim ${args.claim.id} is durable but the standing ref does not reflect it; the CAS advance crashed and can be retried safely`,
    };
  }
  if (args.claim && args.refReflectsClaim) {
    return { kind: "settled", detail: "claim and standing ref agree" };
  }
  return { kind: "settled", detail: "nothing claimed, nothing advanced" };
}
