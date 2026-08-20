// sources.ts — resolve a `derived-from` source ENTRY to the concrete vault
// files it names, over the injected ProvenanceSource. Port of the Python
// `sources.py` (`resolve_source` / `latest_mtime`).
//
// A source entry is either a glob (contains `*`, `?`, or `[`) or a literal
// path. Python's `resolve_source`:
//     if any(ch in entry for ch in "*?["):
//         return sorted(p for p in vault_root.glob(entry) if p.is_file())
//     p = vault_root / entry
//     return [p] if p.is_file() else []
// Here `source.glob` already returns sorted FILE paths (folders excluded), and
// the literal branch uses `source.stat` to keep only a path that is a file —
// exactly the `p.is_file()` guard, so a folder or an absent path yields [].

import type { ProvenanceSource } from "./provenance-source.js";

/** True when the entry uses glob metacharacters (`*?[`), matching Python's
 *  `any(ch in entry for ch in "*?[")`. */
export function isGlob(entry: string): boolean {
  return /[*?[]/.test(entry);
}

/** Resolve one `derived-from` entry to the sorted vault-relative FILE paths it
 *  names. A glob defers to `source.glob`; a literal path is included only when
 *  it is a file (a folder or absent path → []). */
export async function resolveSource(source: ProvenanceSource, entry: string): Promise<string[]> {
  if (isGlob(entry)) return source.glob(entry);
  const st = await source.stat(entry);
  return st?.type === "file" ? [entry] : [];
}

/** The resolution of a whole `derived-from` list — what `checkFreshness` needs
 *  in order to speak about DELETED sources, and what a Governor generator needs
 *  in order to stamp the source-count witness over the same set. */
export interface ResolvedEntries {
  /** Every resolved file, in entry order. Duplicates are KEPT when two entries
   *  name the same file: this is the list `FreshnessVerdict.sources` reports and
   *  the number the `derived-source-count` witness counts, so the witness and
   *  the check are the same arithmetic by construction. */
  files: string[];
  /** NON-GLOB entries that resolved to nothing — a missing / moved / deleted
   *  source, unambiguously (a plain path names exactly one file). Glob entries
   *  are never listed here: a glob matching nothing may be perfectly legitimate
   *  (an empty folder is not an error), so an empty glob is reported only
   *  through the count witness, never as a "missing" entry. */
  missing: string[];
  /** True when at least one entry is a glob — i.e. when this note has a source
   *  class whose deletions the resolution alone cannot see. */
  hasGlob: boolean;
}

/** Resolve a whole `derived-from` list at once, recording which non-glob entries
 *  named nothing. One pass over the entries; `resolveSource` per entry, so glob
 *  and literal semantics are unchanged. */
export async function resolveEntries(
  source: ProvenanceSource,
  entries: string[],
): Promise<ResolvedEntries> {
  const files: string[] = [];
  const missing: string[] = [];
  let hasGlob = false;
  for (const entry of entries) {
    const glob = isGlob(entry);
    hasGlob ||= glob;
    const resolved = await resolveSource(source, entry);
    if (resolved.length === 0 && !glob) missing.push(entry);
    files.push(...resolved);
  }
  return { files, missing, hasGlob };
}

/** The newest mtime (epoch ms) among the given paths, or 0 when the list is
 *  empty — the port of Python `latest_mtime`. A path whose stat is missing
 *  contributes 0 (Python would have raised; here an absent source file simply
 *  cannot be "newer than generated"). */
export async function latestMtime(source: ProvenanceSource, paths: string[]): Promise<number> {
  let latest = 0;
  for (const p of paths) {
    const st = await source.stat(p);
    if (st && st.mtime > latest) latest = st.mtime;
  }
  return latest;
}
