// STANDING RESOLVER — the read side of authority (WP6, D08/D11; rebuilt for #334).
//
// D11's consequence: current bytes and standing may differ, and
// standing-aware consumers need an explicit API rather than treating raw
// vault content as admitted. Read-only; no ref advancement anywhere near it.
//
// #334's lesson governs the shape: the standing chain is a history of
// admissions ACROSS THE WHOLE VAULT, not a per-subject lineage — so the head
// claim carries no information about a subject it does not cover, and the
// first implementation's head-only answer reported `superseded` for subjects
// nothing superseded (admitting note B falsely flipped note A; under cohorts,
// one unrelated click would have flipped 600 members). The fix is the chain
// walk governor-lead prescribed on the issue: resolve a subject by walking
// admission claims newest-first to the most recent claim COVERING it, and
// report `superseded` only when a NEWER claim covers the SAME NOTE — the
// receipt contract's own definition ("later admitted subject replaced this
// one") taken literally. One ref, one CAS, §9's shape untouched; the cost is
// a bounded walk over a chain that is stock-git-readable anyway.

import type { AdmissionClaimV1, ClaimStore } from "./settlement.js";

export type StandingAnswer =
  | { state: "ungoverned"; detail: string }
  | { state: "admitted"; claim: AdmissionClaimV1 }
  | { state: "superseded"; claim: AdmissionClaimV1; by: AdmissionClaimV1 }
  | {
      /** The chain cannot be read back — §10's critical health failure, surfaced, never dressed as absence. */
      state: "unresolvable";
      detail: string;
    };

export interface StandingResolver {
  /** What stands for a subject digest, per the CURRENT standing chain. */
  forSubject(subjectDigest: string): Promise<StandingAnswer>;
  /** The claim the standing ref currently names, or null. */
  current(): Promise<AdmissionClaimV1 | null>;
}

export function createStandingResolver(deps: {
  claims: ClaimStore;
  /**
   * The standing chain as CLAIM IDS, newest first — the wiring derives it
   * from the admission commits (repo.log over the standing ref). Throws when
   * the chain cannot be read (dangling ref, unreadable commit): that is a
   * critical health failure, not absence.
   */
  standingChain: () => Promise<string[]>;
}): StandingResolver {
  /** Whether a claim covers a subject digest. Older in-test claims without coveredNotes degrade to digest-only. */
  function covers(claim: AdmissionClaimV1, subjectDigest: string): boolean {
    if (claim.subjectDigest.value === subjectDigest) return true;
    return (claim.coveredNotes ?? []).some((n) => n.subjectDigest === subjectDigest);
  }

  /** The note identities a claim covers FOR a given subject digest. */
  function notesFor(claim: AdmissionClaimV1, subjectDigest: string): Array<{ vaultId: string; noteId: string }> {
    return (claim.coveredNotes ?? []).filter((n) => n.subjectDigest === subjectDigest).map((n) => ({ vaultId: n.vaultId, noteId: n.noteId }));
  }

  /** Whether a claim covers ANY of these note identities (at any digest). */
  function coversNote(claim: AdmissionClaimV1, notes: Array<{ vaultId: string; noteId: string }>): boolean {
    return (claim.coveredNotes ?? []).some((n) => notes.some((q) => q.vaultId === n.vaultId && q.noteId === n.noteId));
  }

  async function chainClaims(): Promise<AdmissionClaimV1[]> {
    const ids = await deps.standingChain();
    const out: AdmissionClaimV1[] = [];
    for (const id of ids) {
      const claim = await deps.claims.byId(id);
      if (!claim) {
        // A chained id the store cannot produce is the critical failure —
        // the chain asserts an admission whose evidence is unreadable.
        throw new Error(`standing chain names claim ${id}, which the store cannot read — critical health failure, not absence`);
      }
      out.push(claim);
    }
    return out;
  }

  return {
    async current() {
      const ids = await deps.standingChain();
      if (ids.length === 0) return null;
      const head = await deps.claims.byId(ids[0]);
      if (!head) throw new Error(`standing ref names claim ${ids[0]}, which the store cannot read — critical health failure, not absence`);
      return head;
    },

    async forSubject(subjectDigest) {
      let chain: AdmissionClaimV1[];
      try {
        chain = await chainClaims();
      } catch (e) {
        return { state: "unresolvable", detail: e instanceof Error ? e.message : String(e) };
      }

      // Newest-first walk to the most recent claim covering this subject.
      const idx = chain.findIndex((c) => covers(c, subjectDigest));
      if (idx === -1) {
        const unattached = await deps.claims.bySubject(subjectDigest);
        return unattached.length > 0
          ? { state: "ungoverned", detail: "claims exist for this subject but none is in the standing chain — unattached evidence, nothing stands" }
          : { state: "ungoverned", detail: "no admission claim covers this subject" };
      }
      const covering = chain[idx];

      // Superseded ONLY by a newer claim over the SAME NOTE — an unrelated
      // admission above it in the chain says nothing about this subject.
      const notes = notesFor(covering, subjectDigest);
      if (notes.length > 0) {
        for (let i = idx - 1; i >= 0; i--) {
          if (coversNote(chain[i], notes)) {
            return { state: "superseded", claim: covering, by: chain[i] };
          }
        }
      }
      return { state: "admitted", claim: covering };
    },
  };
}
