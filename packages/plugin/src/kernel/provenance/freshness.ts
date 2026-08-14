// freshness.ts — the general derived-content freshness engine, over the
// injected ProvenanceSource. Port of the Python `freshness.py`.
//
// A "derived" note declares `derived-from:` (source globs/paths, vault-relative)
// and `generated:` (an ISO timestamp) in its frontmatter. It is STALE when any
// resolved source file changed AFTER `generated`; otherwise FRESH. This is the
// general engine `provenance_check` exposes — orthogonal to the plugin-audit
// specialization (plugins.ts / regen.ts), which is one particular derived note.

import type { ProvenanceSource } from "./provenance-source.js";
import { resolveSource } from "./sources.js";

export interface FreshnessVerdict {
  fresh: boolean;
  /** The source files whose mtime is newer than `generated`, vault-relative. */
  changed: string[];
  /** The note's `generated` timestamp, epoch milliseconds. */
  generatedMs: number;
  /** Every source file the note's `derived-from` resolved to (whether or not it
   *  changed) — context for a report. */
  sources: string[];
}

/** Normalize a frontmatter `generated` value (a Date, when Obsidian typed the
 *  property as a date; otherwise an ISO string) to epoch milliseconds. Throws on
 *  an unparseable value — the port of Python's `datetime.fromisoformat` raising. */
function generatedMsOf(gen: unknown): number {
  if (gen instanceof Date) return gen.getTime();
  if (typeof gen === "number") return gen; // already epoch ms
  if (typeof gen === "string") {
    const ms = Date.parse(gen);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new Error(`unparseable \`generated\` timestamp: ${JSON.stringify(gen)}`);
}

/** `derived-from` may be a YAML list (the normal form) or a lone string; both
 *  yield a string array. Non-string entries are dropped (a malformed entry
 *  can't name a file). */
function derivedFromEntries(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((e): e is string => typeof e === "string");
  return [];
}

/**
 * The freshness verdict for a derived note at `artifactPath`.
 *
 * Throws when the note has no `derived-from` (the port of Python's
 * `ValueError`) or an unparseable `generated`. Otherwise resolves every source
 * entry to files and marks the note STALE if any file's mtime exceeds
 * `generated`.
 */
export async function checkFreshness(
  source: ProvenanceSource,
  artifactPath: string,
): Promise<FreshnessVerdict> {
  const fm = source.noteFrontmatter(artifactPath);
  const entries = derivedFromEntries(fm?.["derived-from"]);
  if (entries.length === 0) throw new Error(`${artifactPath} has no derived-from`);
  const generatedMs = generatedMsOf(fm?.["generated"]);

  const sources: string[] = [];
  const changed: string[] = [];
  for (const entry of entries) {
    for (const f of await resolveSource(source, entry)) {
      sources.push(f);
      const st = await source.stat(f);
      if (st && st.mtime > generatedMs) changed.push(f);
    }
  }
  return { fresh: changed.length === 0, changed, generatedMs, sources };
}
