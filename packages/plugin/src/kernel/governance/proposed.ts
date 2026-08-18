// The Proposed-section listing (#221/#164 acceptance convergence) — pure derivation, no I/O,
// Obsidian-free (the #228 Revising-section discipline, extracted so the dedupe/exclusion
// rules are headless-testable against a metadata-cache fake).
//
// The pane's Proposed section lists notes whose frontmatter says `acceptance-status: proposed`
// but that have NO pending write delta — the frontmatter-lifecycle half of the converged
// Accept. Notes that ARE in the pending queue are deduped out: a pending item already shows
// the (same, context-aware) Accept in the queue detail view, and one note must never render
// two Accept rows. Excluded roots (guarded territories / hold zones — wiring.ts
// EXCLUDED_PREFIXES) are respected exactly like every other pane listing.
//
// Plain data in, plain data out: nothing here reads a file, advances a baseline, or carries
// a callable. The wiring's `listProposed` feeds it the metadata cache; tests feed it fakes.

/** One candidate from the metadata cache: path, display title, and the note's
 * `acceptance-status` frontmatter value (unknown-typed — the cache is untrusted data). */
export interface ProposedCandidate {
  path: string;
  title: string;
  status: unknown;
}

/** One note listed in the Proposed section — display data only. */
export interface ProposedItem {
  path: string;
  title: string;
}

/**
 * Build the Proposed-section listing: `status === "proposed"` (exact string — the cache
 * value is untrusted, so anything else, including arrays or objects, does not match), not
 * under an excluded root, and NOT in the pending queue (deduped — pending items already
 * carry Accept). Sorted by path for a stable render.
 */
export function buildProposedList(
  candidates: ProposedCandidate[],
  pendingPaths: Iterable<string>,
  isExcluded: (path: string) => boolean,
): ProposedItem[] {
  const pending = new Set(pendingPaths);
  return candidates
    .filter((c) => c.status === "proposed" && !isExcluded(c.path) && !pending.has(c.path))
    .map((c) => ({ path: c.path, title: c.title }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
