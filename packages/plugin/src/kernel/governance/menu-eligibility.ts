// Which notes get an "Accept" item on the right-click context menu (governance/wiring.ts's
// file-menu/files-menu registration) — the PER-NOTE predicate behind that decision, plus the
// multi-select filter built on it. Extracted so the rule is headless-testable independent of
// Obsidian's Menu API, which cannot be unit-tested (see packages/plugin/CLAUDE.md's "Verifying
// tools live" boundary).
//
// The rule mirrors the pane's own three Accept-bearing sections exactly, clause for clause:
//   - the PENDING queue          → `pendingPaths` (the already-cached queue; no scan)
//   - the PROPOSED section       → `acceptance-status: proposed`   (proposed notes that ARE
//                                  pending are deduped OUT of that section, but they are in the
//                                  pending clause, so the union is unchanged)
//   - the REVISING section       → `acceptance-status: revising`
// …all three restricted to governed territory (`isExcluded`), like every pane listing.
//
// It is deliberately a per-note check rather than a set built from the three listings: the pane's
// listProposed/listRevising each sweep `vault.getMarkdownFiles()`, and a context menu opens on
// EVERY right-click in the file explorer — two full metadata-cache sweeps to decide whether to
// show one menu item, usually for a note that turns out ineligible. One metadata-cache lookup per
// candidate answers the identical question. Plain data in, boolean out: nothing here reads a
// file, advances a baseline, or carries a callable.

/** The minimal shape a multi-select entry must have for `selectAcceptEligible`. */
interface PathBearing {
  path: string;
}

/** The (cheap, already-computed) vault facts the eligibility rule reads. */
export interface AcceptEligibilityCtx {
  /** Paths currently in the pending review queue (the cached queue — not a fresh sweep). */
  pendingPaths: ReadonlySet<string>;
  /** One note's `acceptance-status` frontmatter value from the metadata cache, or null. */
  statusOf: (path: string) => string | null;
  /** Guarded territories / hold zones (wiring.ts EXCLUDED_PREFIXES) — never governed. */
  isExcluded: (path: string) => boolean;
}

/**
 * Whether ONE note is eligible for the context-aware Accept: in the pending queue, or
 * frontmatter `acceptance-status: proposed`, or `acceptance-status: revising` — and inside
 * governed territory. A note NOT eligible has nothing for Accept to do (already accepted, or
 * never governed), so the menu item is omitted rather than offered and then failing.
 */
export function isAcceptEligible(path: string, ctx: AcceptEligibilityCtx): boolean {
  if (ctx.isExcluded(path)) return false;
  if (ctx.pendingPaths.has(path)) return true;
  const status = ctx.statusOf(path);
  return status === "proposed" || status === "revising";
}

/**
 * The eligible subset of a multi-select, in the caller's order. An all-ineligible selection
 * returns an empty array — the caller adds no menu item at all in that case.
 */
export function selectAcceptEligible<T extends PathBearing>(
  items: Iterable<T>,
  ctx: AcceptEligibilityCtx,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (isAcceptEligible(item.path, ctx)) out.push(item);
  }
  return out;
}
