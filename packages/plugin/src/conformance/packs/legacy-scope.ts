// packs/legacy-scope.ts — the governed-notes scope filters the three ported
// Python rail scripts applied to their walk, reproduced so each pack's TRIGGER
// SET matches the Python's regardless of what the snapshot happens to carry.
//
// The snapshot's walk already drops the config-noise dirs (.git/.obsidian/
// .trash/node_modules) and any `excludedRoots`, but the Python scripts also
// scoped by vault convention — no dot-prefixed path segment, no `_`-prefixed
// top-level root, and (per script) no ungoverned `Assent/` or `Vault
// archaeology/` tree. Each script differs slightly; the exact per-script set is
// applied in the pack, composed from these primitives.

/** The first path segment, e.g. "Assent" for "Assent/Build/x.md". */
export function firstSegment(vaultPath: string): string {
  const i = vaultPath.indexOf("/");
  return i === -1 ? vaultPath : vaultPath.slice(0, i);
}

/** True if any `/`-segment starts with "." (a dot-dir/-file) or is ".trash".
 * Mirrors Python's `any(part.startswith(".") or part == ".trash" ...)`. The
 * snapshot already prunes the common ones by dir name; this catches the rest
 * (e.g. a `.hidden/` the snapshot's fixed skip-set would still descend into). */
export function hasDotOrTrashSegment(vaultPath: string): boolean {
  return vaultPath.split("/").some((p) => p.startsWith(".") || p === ".trash");
}

/** True if the top-level root is `_`-prefixed (a staging root: `_keep`, `_hold`,
 * …). Mirrors `rel.parts[0].startswith("_")`. */
export function isUnderscoreRoot(vaultPath: string): boolean {
  return firstSegment(vaultPath).startsWith("_");
}
