// ============================================================================
//  AUTO-ACCEPT — the APPEND-ONLY detector (pure; no `obsidian` import)  (#135)
// ----------------------------------------------------------------------------
//  Answers ONE yes/no about the objective diff: is `cur` the result of ONLY
//  appending bytes to the end of `base`? Same conservative fail-safe discipline
//  as the per-class detectors (detectors.ts): any doubt → false → the change
//  stays PENDING for a human.
//
//  This is eligibility SUBSTRATE for the per-note "auto-accept appends" policy
//  (#135). The policy itself — where the human's delegation bit lives and how
//  it is set — is NOT built here: Nelson chose protected frontmatter properties
//  in the core guard as the general mechanism (its own issue; per-note policies
//  ride it once it exists). Until then this detector is consulted by nothing;
//  the eligibility predicate (eligibility.ts) remains class-allowlist-only.
//
//  BYTE-PREFIX SEMANTICS (deliberate, documented, pinned by tests):
//  `isAppendOnly(base, cur)` is true iff `cur` is STRICTLY longer than `base`
//  AND `base` is a byte-for-byte prefix of `cur`. Consequences:
//    - byte-identical content is NOT an append (a no-op never qualifies);
//    - a write that appends AND modifies existing content is NOT an append
//      (the modified prefix breaks byte-prefix) → stays pending;
//    - a prepend, any deletion, or any edit inside the existing content → false;
//    - CRLF normalization of EXISTING lines ("a\nb" → "a\r\nb…") is a
//      modification, NOT an append — the appended text may of course itself
//      contain \r\n;
//    - a BOM (or anything) added at the FRONT is a prepend → false;
//    - an empty-string baseline is a prefix of anything, so first content on an
//      accepted-empty note counts as an append (nothing existing was touched).
//  No trimming, no unicode normalization, no line-ending forgiveness: bytes or
//  nothing. (JS strings compare by UTF-16 code unit; a byte-prefix in the
//  file's UTF-8 encoding and a code-unit-prefix of the decoded string agree for
//  any well-formed text, so "byte-prefix" is the honest name for what a caller
//  observes on disk.)
// ============================================================================

export function isAppendOnly(base: unknown, cur: unknown): boolean {
  try {
    if (typeof base !== "string" || typeof cur !== "string") return false;
    if (cur.length <= base.length) return false; // identical or shrunk → not an append
    return cur.startsWith(base);
  } catch {
    return false; // fail safe — doubt means "not provably an append"
  }
}
