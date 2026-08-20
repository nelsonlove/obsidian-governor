// Repointing baselines whose note MOVED — the identity half of the baseline store.
//
// A baseline is keyed by `contentHash(path)` (baseline-store.ts), and a path is a
// LOCATION, not an identity. So a rename or a move silently orphans the acceptance:
// the note reads as never-accepted, with no error and no signal anywhere. Measured
// on the real vault 2026-08-20: 158 of 273 baselines had drifted that way across a
// few weeks of reorganizations.
//
// The rename EVENT closes most of it (wiring re-keys on `vault.on("rename")`), but
// not all: a rename that happens while the plugin is not running — Obsidian closed,
// Sync landing a peer's move, another tool, a bulk script — is never observed. This
// module is the repair for exactly that residue, and it keys on the one thing that
// survives a move: the note's `uid`, which is carried inside the baseline's own
// stored content because the content is the note's full text, frontmatter included.
//
// DELIBERATELY NON-DESTRUCTIVE. The plan only ever REPOINTS. It never deletes a
// baseline — not for a note that vanished, not for a duplicate. A baseline is the
// machine-readable record of a human's acceptance; pruning that is a decision a
// human makes, not a repair a startup task performs. Everything it declines to
// repoint comes back as an `unresolved` entry with a reason, so a caller can report
// it rather than discover it later.

import type { Baseline } from "./baseline-store.js";
import { parseNote } from "./frontmatter.js";

/** Why a drifted baseline was left alone. */
export type UnresolvedReason =
  /** The stored content carries no `uid:` — nothing to match on. Predates the uid convention. */
  | "no-uid"
  /** No live note carries that uid: the note was deleted, or its uid was changed. */
  | "uid-not-found"
  /** Several live notes carry the uid — resolving would be a guess. */
  | "uid-ambiguous"
  /** The destination already has its own baseline; repointing would overwrite a live acceptance. */
  | "target-has-baseline"
  /** Another drifted baseline resolves to the same note and was accepted more recently. */
  | "superseded";

export interface Repoint {
  from: string;
  to: string;
  uid: string;
  baseline: Baseline;
}

export interface Unresolved {
  path: string;
  reason: UnresolvedReason;
  /** Set for "superseded" / "target-has-baseline": the note this one resolved to. */
  target?: string;
}

export interface ReconcilePlan {
  repoint: Repoint[];
  unresolved: Unresolved[];
}

export interface ReconcileInputs {
  /** Every baseline currently in the store. */
  baselines: Baseline[];
  /** Does a note exist at this path right now? */
  noteExists(path: string): boolean;
  /** The uid of the note CURRENTLY at this path, or null (no note / no uid). */
  uidAtPath(path: string): string | null;
  /** Live notes carrying this uid, in any order. */
  pathsForUid(uid: string): string[];
  /** Does this path already have its own baseline? */
  hasBaseline(path: string): boolean;
}

/**
 * The `uid:` of a note, read from its frontmatter text.
 *
 * Reads the stored CONTENT rather than the live note on purpose: the baseline's
 * content is the note as it was when accepted, so its uid is the identity that
 * acceptance was given to. Quotes are tolerated because a hand-edited note may
 * carry `uid: "01a0…"`; anything past the first whitespace is ignored.
 */
export function uidOfContent(content: string): string | null {
  const { hasFrontmatter, frontmatterText } = parseNote(content);
  if (!hasFrontmatter) return null;
  for (const line of frontmatterText.split("\n")) {
    const m = /^uid:\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[1].trim().replace(/^['"]|['"]$/g, "").split(/\s/)[0];
    return value || null;
  }
  return null;
}

/**
 * Decide, for every baseline whose note is no longer at its recorded path, whether
 * it can be repointed at the note's current path.
 *
 * Deterministic: `repoint` comes back sorted by destination, and when two drifted
 * baselines resolve to the SAME note the more recently accepted one wins (ties
 * broken by path, so the same store always yields the same plan). The loser is
 * reported `superseded` rather than dropped — merges are real (three notes in the
 * measured vault had collapsed into one), and the older acceptance is still a fact
 * someone may want to look at.
 */
export function planBaselineReconcile(inputs: ReconcileInputs): ReconcilePlan {
  const { baselines, noteExists, uidAtPath, pathsForUid, hasBaseline } = inputs;
  const unresolved: Unresolved[] = [];
  const byTarget = new Map<string, { uid: string; baseline: Baseline }[]>();

  for (const baseline of baselines) {
    const uid = uidOfContent(baseline.content);

    // Drift is decided by IDENTITY, not by vacancy. Testing only "is the path empty?"
    // misses the swap: an offline renumber that moves X→Y and Y→Z leaves Y's baseline
    // attached to a DIFFERENT note, its path occupied, so it would never be
    // reconsidered — a silently wrong diff base, and revertNote would write a foreign
    // note's content over it. If the note now at this path carries a different uid,
    // this baseline has drifted even though something lives there.
    if (noteExists(baseline.path)) {
      if (!uid) continue;                            // nothing to compare on; leave it
      const occupantUid = uidAtPath(baseline.path);
      if (occupantUid === null) continue;            // occupant has no uid — can't tell; leave it
      if (occupantUid === uid) continue;             // same note, still in place
      // else: someone else is standing here — fall through and repoint by uid.
    }

    if (!uid) { unresolved.push({ path: baseline.path, reason: "no-uid" }); continue; }

    const live = pathsForUid(uid);
    if (live.length === 0) { unresolved.push({ path: baseline.path, reason: "uid-not-found" }); continue; }
    if (live.length > 1) { unresolved.push({ path: baseline.path, reason: "uid-ambiguous" }); continue; }

    const target = live[0];
    if (target === baseline.path) continue; // noteExists said otherwise; nothing to do
    if (hasBaseline(target)) {
      unresolved.push({ path: baseline.path, reason: "target-has-baseline", target });
      continue;
    }
    const group = byTarget.get(target) ?? [];
    group.push({ uid, baseline });
    byTarget.set(target, group);
  }

  const repoint: Repoint[] = [];
  for (const [target, group] of [...byTarget.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    group.sort((x, y) => {
      const at = (y.baseline.acceptedAt ?? "").localeCompare(x.baseline.acceptedAt ?? "");
      return at !== 0 ? at : x.baseline.path.localeCompare(y.baseline.path);
    });
    const [winner, ...losers] = group;
    repoint.push({ from: winner.baseline.path, to: target, uid: winner.uid, baseline: winner.baseline });
    for (const loser of losers) {
      unresolved.push({ path: loser.baseline.path, reason: "superseded", target });
    }
  }
  return { repoint, unresolved };
}

/** One-line summary for the console — reconcile runs at startup and must be legible there. */
export function summarizePlan(plan: ReconcilePlan): string {
  const counts = new Map<UnresolvedReason, number>();
  for (const u of plan.unresolved) counts.set(u.reason, (counts.get(u.reason) ?? 0) + 1);
  const detail = [...counts.entries()].map(([r, n]) => `${r}: ${n}`).join(", ");
  return `${plan.repoint.length} repointed` + (detail ? `; left alone — ${detail}` : "");
}
