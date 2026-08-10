# Docs invariant-claim allowlist (#152)

Each entry below is a span of prose from README.md or docs/*.md that
`docs-drift.test.mjs` flagged: it contains BOTH an invariant word ("never",
"every", "always", "cannot", "no way", "guarantee(s)", "impossible") AND a
security-relevant term (journal, accept/acceptance/accepted, guard, audit,
"every write", provenance). The check fails CI unless the exact span text
below is present verbatim.

**This file does not assert that any claim below is true.** It records that
a human reviewed the sentence, checked it against the current implementation
and open issues, and deliberately decided it is safe to publish as written.
Seeded from `main` at the time #152 landed (see the seeding commit) — every
entry here was reviewed at seed time, not rubber-stamped.

If a claim's wording changes at all — including gaining or losing a
qualifier like "through the plugin's guarded path" — it becomes a different
span and is no longer covered by its old entry. That is intentional: a
narrowed claim needs the same conscious re-approval as a new one.

To approve a new or changed claim: confirm the current implementation and
perimeter tests substantiate it, then add the exact span text as a `- `
bullet under the file it lives in (headings below are for review grouping
only; matching is by exact text regardless of which file it's under).
