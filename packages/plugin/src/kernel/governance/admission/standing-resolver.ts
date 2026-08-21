// STANDING RESOLVER — the read side of authority (WP6, D08/D11).
//
// D11's consequence: current bytes and standing may differ, and
// standing-aware consumers need an explicit API rather than treating raw
// vault content as admitted. This is that API's kernel: given the claim
// store and the current standing ref value, answer what stands — read-only,
// no ref advancement anywhere near it (D08: external tools resolve standing
// without internal refs; internal ones go through here for the same reason).

import type { AdmissionClaimV1, ClaimStore } from "./settlement.js";

export type StandingAnswer =
  | { state: "ungoverned"; detail: string }
  | { state: "admitted"; claim: AdmissionClaimV1 }
  | { state: "superseded"; claim: AdmissionClaimV1; by: AdmissionClaimV1 }
  | {
      /** The ref names a claim the store cannot produce — §10's critical health failure. */
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
  /** The standing ref's current claim id, read fresh per call. */
  currentStanding: () => Promise<string | null>;
}): StandingResolver {
  async function current(): Promise<AdmissionClaimV1 | null> {
    const id = await deps.currentStanding();
    if (id === null) return null;
    const claim = await deps.claims.byId(id);
    if (!claim) {
      // The caller sees this as `unresolvable` through forSubject; here the
      // honest answer is a throw — returning null would present a critical
      // health failure as "nothing admitted", which is the one presentation
      // §10 forbids.
      throw new Error(`standing ref names claim ${id}, which the store cannot read — critical health failure, not absence`);
    }
    return claim;
  }

  return {
    current,
    async forSubject(subjectDigest) {
      let head: AdmissionClaimV1 | null;
      try {
        head = await current();
      } catch (e) {
        return { state: "unresolvable", detail: e instanceof Error ? e.message : String(e) };
      }
      const mine = await deps.claims.bySubject(subjectDigest);
      if (mine.length === 0) return { state: "ungoverned", detail: "no admission claim covers this subject" };
      const newest = mine.reduce((a, b) => (b.admittedAt >= a.admittedAt ? b : a));
      if (head && head.subjectDigest.value === subjectDigest && head.id === newest.id) {
        return { state: "admitted", claim: newest };
      }
      if (head && head.id !== newest.id) {
        return { state: "superseded", claim: newest, by: head };
      }
      // A claim exists but the chain has moved past it without a head match.
      return head
        ? { state: "superseded", claim: newest, by: head }
        : { state: "ungoverned", detail: "claims exist but nothing currently stands" };
    },
  };
}
