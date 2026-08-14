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
