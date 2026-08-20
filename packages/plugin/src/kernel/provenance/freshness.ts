// freshness.ts — the general derived-content freshness engine, over the
// injected ProvenanceSource. Port of the Python `freshness.py`.
//
// A "derived" note declares `derived-from:` (source globs/paths, vault-relative)
// and `generated:` (an ISO timestamp) in its frontmatter. It is STALE when any
// resolved source file changed AFTER `generated`; otherwise FRESH. This is the
// general engine `provenance_check` exposes — orthogonal to the plugin-audit
// specialization (plugins.ts / regen.ts), which is one particular derived note.
//
// ── What "changed" can and cannot see (the deleted-source blind spot) ────────
//
// The mtime rule alone only sees files that are STILL THERE. Three edits to the
// source set, and what catches each:
//
//   ADDED    — a new file matching a glob carries a fresh mtime, so the mtime
//              rule already trips. Nothing extra is needed.
//   MODIFIED — the mtime rule, by construction.
//   DELETED  — invisible to the mtime rule: a resolved-to-nothing entry simply
//              drops out of the comparison and the note reads FRESH. This is the
//              blind spot the two tiers below close.
//
// TIER 1 — missing plain-path entries (always on, no schema change). A NON-GLOB
// `derived-from` entry resolving to nothing names exactly one file that is gone
// (deleted, moved, or renamed). It is reported in `missing` and the note is
// STALE. A GLOB matching nothing is deliberately NOT the same claim — an empty
// folder can be a legitimate source set — so globs never populate `missing`.
//
// TIER 2 — the `derived-source-count` witness (opt-in, per derived note). A
// generator may stamp how many source files the whole `derived-from` set
// resolved to at generation time. When the CURRENT count is LOWER, sources were
// removed and the note is STALE with a distinct reason (`sourcesRemoved`).
//
// Why a COUNT rather than digests or a stored path list: pure deletion drops the
// count, and delete-plus-add keeps the count but the added file's fresh mtime
// already trips the mtime rule — so count + mtime cover the space between them,
// without hashing every source or freezing 48 paths into a note's frontmatter.
// A HIGHER count is NOT stale by itself: additions are the case mtime already
// catches, so treating "more files than before" as staleness would only add
// false positives (e.g. a note regenerated from a set that legitimately grew
// while every file predates `generated`).
//
// The residual: a deletion paired with a file that arrives carrying an OLD mtime
// (a `mv` within a filesystem preserves mtime) keeps both the count and the
// newest mtime unchanged, and is undetectable here. And with NO witness, glob
// deletions stay invisible exactly as before — the verdict says so out loud
// (`globDeletionsUndetectable`) so a caller can tell "checked and fine" from
// "could not check that class".

import type { ProvenanceSource } from "./provenance-source.js";
import { resolveEntries } from "./sources.js";
import { SOURCE_COUNT_FIELD } from "./provenance-config.js";

export interface FreshnessVerdict {
  fresh: boolean;
  /** The source files whose mtime is newer than `generated`, vault-relative. */
  changed: string[];
  /** The note's `generated` timestamp, epoch milliseconds. */
  generatedMs: number;
  /** Every source file the note's `derived-from` resolved to (whether or not it
   *  changed) — context for a report. */
  sources: string[];
  /** NON-GLOB `derived-from` entries that resolve to no file today — a missing /
   *  moved / deleted source. Non-empty ⇒ NOT fresh. Globs are never listed here
   *  (see the tier-1 note above). */
  missing: string[];
  /** The `derived-source-count` witness as read from the note, when present and
   *  well-formed (a non-negative integer). Absent ⇒ no witness was available.
   *  A malformed value is treated exactly like an absent one. */
  expectedSourceCount?: number;
  /** Present only when a witness says the source set SHRANK: `expected` is the
   *  witnessed count, `actual` the count resolved now. Present ⇒ NOT fresh. */
  sourcesRemoved?: { expected: number; actual: number };
  /** True when this note has at least one GLOB entry and no usable witness — the
   *  honest statement that deletions inside the globbed set were not checked.
   *  False means either every entry is a plain path (deletions fully covered) or
   *  a witness was available (the count check ran). */
  globDeletionsUndetectable: boolean;
}

/** Read the `derived-source-count` witness. Accepts a non-negative integer
 *  number (Obsidian types a numeric property as one) or a digits-only string;
 *  anything else — a negative, a fraction, any other string, an absent field —
 *  reads as NO witness, which degrades to pre-witness behavior rather than
 *  inventing a comparison. */
function sourceCountWitness(v: unknown): number | undefined {
  // The string branch is DIGITS ONLY, not bare `Number()`: `"0x30"` would
  // otherwise read as 48 and `"1e3"` as 1000, neither of which is what anyone
  // typed into frontmatter. A value we cannot read plainly is no witness.
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
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
 * entry to files and marks the note STALE when ANY of:
 *
 *   - a resolved file's mtime exceeds `generated` (`changed` — the original
 *     rule, unchanged: modifications and additions);
 *   - a non-glob entry resolves to nothing (`missing` — tier 1);
 *   - a `derived-source-count` witness exceeds the count resolved now
 *     (`sourcesRemoved` — tier 2).
 *
 * Pure over the injected source: `noteFrontmatter`, `stat` and `glob` only — no
 * new primitive, so the engine stays obsidian-free and headless-testable.
 */
export async function checkFreshness(
  source: ProvenanceSource,
  artifactPath: string,
): Promise<FreshnessVerdict> {
  const fm = source.noteFrontmatter(artifactPath);
  const entries = derivedFromEntries(fm?.["derived-from"]);
  if (entries.length === 0) throw new Error(`${artifactPath} has no derived-from`);
  const generatedMs = generatedMsOf(fm?.["generated"]);

  const { files: sources, missing, hasGlob } = await resolveEntries(source, entries);
  const changed: string[] = [];
  for (const f of sources) {
    const st = await source.stat(f);
    if (st && st.mtime > generatedMs) changed.push(f);
  }

  const expected = sourceCountWitness(fm?.[SOURCE_COUNT_FIELD]);
  // A HIGHER current count is not staleness (see the header): only a SHRUNK set
  // is reported, because a grown set is already the mtime rule's business.
  const sourcesRemoved =
    expected !== undefined && sources.length < expected
      ? { expected, actual: sources.length }
      : undefined;

  const verdict: FreshnessVerdict = {
    fresh: changed.length === 0 && missing.length === 0 && sourcesRemoved === undefined,
    changed,
    generatedMs,
    sources,
    missing,
    globDeletionsUndetectable: hasGlob && expected === undefined,
  };
  if (expected !== undefined) verdict.expectedSourceCount = expected;
  if (sourcesRemoved) verdict.sourcesRemoved = sourcesRemoved;
  return verdict;
}
