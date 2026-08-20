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

/** One candidate from the metadata cache: path, display title, the note's
 * `acceptance-status` frontmatter value (unknown-typed — the cache is untrusted data), and
 * `mtime` (the file's own last-modified time, ms since epoch — plain data, no Date/Obsidian
 * type needed to keep this module Obsidian-free) used only to order the listing. */
export interface ProposedCandidate {
  path: string;
  title: string;
  status: unknown;
  mtime: number;
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
 * carry Accept). Sorted by `mtime` DESCENDING (most recently touched first) — matching the
 * pending queue's own "newest activity first" convention (queue.ts). Alphabetical-by-path
 * was the prior default and had nothing to do with which proposed note actually needs
 * attention soonest.
 */
export function buildProposedList(
  candidates: ProposedCandidate[],
  pendingPaths: Iterable<string>,
  isExcluded: (path: string) => boolean,
): ProposedItem[] {
  const pending = new Set(pendingPaths);
  return candidates
    .filter((c) => c.status === "proposed" && !isExcluded(c.path) && !pending.has(c.path))
    .sort((a, b) => b.mtime - a.mtime)
    .map((c) => ({ path: c.path, title: c.title }));
}
