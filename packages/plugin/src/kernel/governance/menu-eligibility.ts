// Which notes get an "Accept" item on the right-click context menu (governance/wiring.ts's
// file-menu/files-menu registration) — pure set-union over the SAME three listings the pane
// itself uses to decide which rows carry an Accept button (getPending/getProposed/getRevising).
// Extracted so the union logic is headless-testable independent of Obsidian's Menu API, which
// cannot be unit-tested (see packages/plugin/CLAUDE.md's "Verifying tools live" boundary).

/** The minimal shape every listing item this function reads shares. */
interface PathBearing {
  path: string;
}

/**
 * The union of every path currently eligible for the context-aware Accept: in the pending
 * queue, or frontmatter `acceptance-status: proposed`, or `acceptance-status: revising`.
 * Matches the pane's own three Accept-bearing sections exactly — a note NOT in this set has
 * nothing for Accept to do (already accepted, or never governed), so the menu item is
 * omitted rather than offered and then failing.
 */
export function computeAcceptEligiblePaths(
  pending: Iterable<PathBearing>,
  proposed: Iterable<PathBearing>,
  revising: Iterable<PathBearing>,
): Set<string> {
  const out = new Set<string>();
  for (const p of pending) out.add(p.path);
  for (const p of proposed) out.add(p.path);
  for (const p of revising) out.add(p.path);
  return out;
}
