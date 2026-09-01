// SETTLEMENT — durable admission claims (WP6, §10).
//
// The ADMISSION CLAIM is the durable statement "this exact subject was
// admitted under this authority at this moment" — content the standing ref
// points at, conceptually.
//
// (This file previously also defined a crash-recovery decision function and
// type, plus a companion read-side chain-walking resolver in a sibling
// module, encoding the guide's two asymmetric rules from §10: "An admission
// claim written without a ref advance is unattached evidence and can be
// retried safely. A ref that points to a missing or invalid claim is a
// critical health failure and must not be presented as standing." Neither
// had a caller outside its own tests, so both were removed dead (issue
// #379) — the doctrine they documented now lives only in git history and in
// that issue, a loss Nelson accepted deliberately, not one that was
// overlooked.)

import { mintId } from "../contracts/ids.js";
import type { Sha256Digest } from "@vault-mcp/core";
import type { VerificationRecord } from "../verification/predicate.js";

/**
 * How a claim was authorized — a WIDENED DISCRIMINATED UNION (WP10b,
 * governor-lead's condition 6), never an optional field: adding the mandate
 * variant as a second arm makes tsc enumerate every reader, where an
 * optional gestureRef would let the promoted case silently inherit the
 * human case's handling. Both arms carry their evidence REQUIRED:
 *   * human-gesture — the one-shot ref the gesture gate minted;
 *   * mandate — the mandate that authorized it, the SERVICE-minted use ref
 *     (callers cannot supply one), and the exact promoted tuple key the
 *     admission ran under, so "what let this happen automatically" is
 *     answerable from the claim alone (condition 10: an automatic admission
 *     is distinguishable after the fact, in the chain itself).
 */
export type ClaimAuthority =
  | { kind: "human-gesture"; gestureRef: string }
  | { kind: "mandate"; mandateId: string; useRef: string; promotedTuple: string };

export interface AdmissionClaimV1 {
  schema: "governor.admission-claim/v1";
  id: string;
  subjectDigest: Sha256Digest;
  proposalId: string;
  authority: ClaimAuthority;
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
   * claim (WP7b), pinned equal to the manifest. Designed so a chain walk
   * could decide supersession NOTE-WISE from these — a subject superseded
   * only by a newer claim covering the SAME note, never by an unrelated
   * admission — though the resolver that walked the chain (#334) was
   * removed dead (#379); this shape is otherwise still load-bearing for
   * `bySubject`/claim identity below.
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
  /** The full discriminated authority — the caller STATES which arm; there is no default. */
  authority: ClaimAuthority;
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
    authority:
      args.authority.kind === "human-gesture"
        ? { kind: "human-gesture", gestureRef: args.authority.gestureRef }
        : { kind: "mandate", mandateId: args.authority.mandateId, useRef: args.authority.useRef, promotedTuple: args.authority.promotedTuple },
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
