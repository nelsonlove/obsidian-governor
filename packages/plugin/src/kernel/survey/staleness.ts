// kernel/survey/staleness.ts — pure staleness comparison for the survey
// module. Ported from `obsidian-jd-survey`'s `staleness.ts`.
//
// A slot is stale when what the mirror directory reports NOW disagrees with
// what the note's `survey:` frontmatter last recorded. Two disjoint causes,
// reported separately rather than collapsed into one boolean, because they
// call for different next actions: a count drift means the snapshot text is
// wrong and should be regenerated; a missing/malformed stamp means the note
// has never been surveyed (or the stamp was hand-edited into an unusable
// shape) and a first survey is what's needed, not a refresh.

import type { WalkResult } from "./walk.js";

/** The `survey:` frontmatter object a prior run stamped, as read back. */
export interface SurveyStamp {
  at?: unknown;
  items?: unknown;
  depth?: unknown;
  by?: unknown;
  stubs?: unknown;
}

export type StalenessReason = "never-surveyed" | "malformed-stamp" | "count-drift" | "depth-changed";

export interface StalenessResult {
  stale: boolean;
  reason: StalenessReason | null;
}

/** Coerce a stamp field to a finite number, or null if it isn't one — a
 *  hand-edited or partially-written stamp degrades to "never surveyed"
 *  rather than throwing, matching this codebase's skip-and-report
 *  discipline for untrusted stored config. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Compare a fresh `walk()` result (at the depth the caller actually used)
 * against the note's last-stamped `survey:` object.
 */
export function staleness(current: WalkResult, requestedDepth: number, stamp: SurveyStamp | undefined): StalenessResult {
  if (!stamp || typeof stamp !== "object") {
    return { stale: true, reason: "never-surveyed" };
  }
  const stampedItems = num(stamp.items);
  const stampedDepth = num(stamp.depth);
  if (stampedItems === null || stampedDepth === null) {
    return { stale: true, reason: "malformed-stamp" };
  }
  if (stampedDepth !== requestedDepth) {
    // A shallower or deeper survey than last time isn't comparable on item
    // count alone — the counts mean different things at different depths.
    return { stale: true, reason: "depth-changed" };
  }
  if (stampedItems !== current.items) {
    return { stale: true, reason: "count-drift" };
  }
  return { stale: false, reason: null };
}
