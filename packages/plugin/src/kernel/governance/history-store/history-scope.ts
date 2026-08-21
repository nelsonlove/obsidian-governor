// HISTORY SCOPE — the stable, human-chosen include/exclude policy (WP4, D10).
//
// The single most important sentence in D10: "Connection scopes govern what
// one client may access; they never change what history already records." So
// this policy is a SEPARATE object from any allowlist, chosen by the human in
// settings after disclosure that Git retains historical bytes, and no
// connection can widen or narrow it. Changing it is a human settings and
// retention decision.
//
// Two modes:
//   - whole-vault: everything ordinary, minus the exclusions;
//   - explicit:    only the included roots, minus the exclusions.
//
// Exclusions always win. The defaults exclude what D10 names — volatile
// caches, local machinery, and explicitly private roots (the guarded
// territories arrive by injection from governance/territories, keeping this
// module pure and the territory list in its one home).

import { posix } from "node:path";

export interface HistoryScope {
  mode: "whole-vault" | "explicit";
  /** Vault-relative roots. Meaningful only in explicit mode. */
  include: string[];
  /** Vault-relative roots. Always subtracted, in either mode. */
  exclude: string[];
}

/**
 * What D10 excludes even from a whole-vault history: volatile caches and
 * machinery whose bytes are noise, plus the trash (deleted content re-entering
 * history through the back door would defeat "delete it and it is gone").
 * Private roots are NOT listed here — they come from governance/territories
 * via the settings layer, so the territory list stays in one place.
 */
export const DEFAULT_HISTORY_EXCLUDES = [".obsidian/", ".trash/"];

/** Whether the scope records this vault-relative path. Deterministic, total. */
export function isTracked(scope: HistoryScope, path: string): boolean {
  const p = normalize(path);
  if (p === null) return false; // escapes the vault — never tracked
  if (matchesExclude(scope.exclude, p)) return false;
  if (scope.mode === "whole-vault") return true;
  return matchesInclude(scope.include, p);
}

/**
 * The tracked/untracked boundary of an operation, for D10's disclosure rule:
 * "Operations crossing tracked/untracked boundaries must disclose incomplete
 * history and may be ineligible for automatic admission."
 */
export function boundaryDisclosure(
  scope: HistoryScope,
  paths: readonly string[]
): { tracked: string[]; untracked: string[]; crossesBoundary: boolean } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const p of paths) (isTracked(scope, p) ? tracked : untracked).push(p);
  return { tracked, untracked, crossesBoundary: tracked.length > 0 && untracked.length > 0 };
}

/** Normalize a vault-relative path; null when it escapes upward. */
function normalize(path: string): string | null {
  const p = posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (p.startsWith("..") || posix.isAbsolute(p)) return null;
  return p;
}

/**
 * The two lists deliberately match differently, because they err in opposite
 * directions:
 *
 * - An EXCLUDE uses raw-prefix semantics, exactly like the guarded-territory
 *   list ("80-89" matches "80-89 Divorce/…" — the prefix names a JD area, not
 *   one folder). Over-matching an exclude records LESS history: safe.
 * - An INCLUDE uses folder-root semantics ("Notes" matches "Notes" and
 *   "Notes/…", never "Notes2/…"). Over-matching an include would record MORE
 *   history than the human chose, which is the direction D10's disclosure
 *   exists to prevent.
 */
function matchesExclude(roots: readonly string[], p: string): boolean {
  return roots.some((root) => root !== "" && p.startsWith(root));
}

function matchesInclude(roots: readonly string[], p: string): boolean {
  return roots.some((rootRaw) => {
    const root = rootRaw.replace(/\/+$/, "");
    return root !== "" && (p === root || p.startsWith(root + "/"));
  });
}
