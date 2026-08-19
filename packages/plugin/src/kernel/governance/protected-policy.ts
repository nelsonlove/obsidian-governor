// ============================================================================
//  PROTECTED-PROPERTY HONOR RULE (#224) + the per-note auto-accept policy (#135)
// ----------------------------------------------------------------------------
//  The write-side half of the protected-property perimeter lives in
//  @vault-mcp/core's accept guard: no agent transport may introduce / change /
//  remove a declared property. This module is the READ-side half for the
//  `authority-conferring` grade — HONOR-ONLY-IF-BLESSED:
//
//    a declared authority-conferring property's value takes EFFECT only once
//    the write that set it is attributed to a human or accepted in review.
//
//  The blessed source is the governance BASELINE, and that is not a shortcut —
//  it is the point. A baseline advances through exactly four paths, every one
//  of them blessed by construction:
//    • Accept (gesture-gated human click; covers a reviewed agent/side-door write),
//    • the silent human-edit advance (requires the reconciler's POSITIVE
//      isTrusted human-input attribution — classify.ts),
//    • Adopt-baseline (gesture- AND confirmation-gated mass human snapshot),
//    • auto-accept (mechanical classes whose detectors treat ANY change to a
//      frontmatter key outside their own field set as residual → a change to a
//      declared property is never auto-accepted by a class; and the policy
//      branch below evaluates against the PRIOR baseline, so a policy cannot
//      bless its own introduction).
//  So `honoredValueFromBlessed` NEVER reads the raw frontmatter: a value
//  sneaked in through a side door (another plugin, a script, Sync) sits in the
//  note but confers nothing until a human blesses it — at which point it IS the
//  baseline and starts to be honored.
//
//  Pure + obsidian-free: callers hand in the blessed CONTENT (wiring.ts reads
//  it off the BaselineStore); everything here is unit-testable headlessly.
//  Parsing binds to the SAME fail-closed recognizer the guard itself uses
//  (`parseGuardFrontmatter`) — one recognizer, so the honor rule cannot honor a
//  block the guard could not see (#209's recognizer-sharing lesson). A block
//  the recognizer refuses reads as "no honored value" (fail safe: confer
//  nothing on doubt).
// ============================================================================

import {
  canonicalPropertyKey,
  declaredGradeOf,
  declaredProtectedProperties,
  findPropertiesCanonical,
  frontmatterValuesEqual,
  leadingFrontmatterBlock,
  parseGuardFrontmatter,
} from "@vault-mcp/core";

/**
 * The last BLESSED value of declared property `key`, given the note's blessed
 * (baseline) content — or undefined when nothing is honored: no baseline, the
 * key is not declared `authority-conferring`, the blessed frontmatter lacks it,
 * or the blessed block cannot be confidently parsed.
 *
 * The grade gate is deliberate: a key the human removed from the declared list
 * stops conferring anything at once, even if old blessed content still carries
 * it — authority flows from the DECLARATION plus the blessing, never from
 * bytes alone.
 */
export function honoredValueFromBlessed(blessed: string | null | undefined, key: string): unknown {
  if (declaredGradeOf(key) !== "authority-conferring") return undefined;
  if (typeof blessed !== "string") return undefined;
  let fm: Record<string, unknown> | null;
  try {
    fm = parseGuardFrontmatter(blessed);
  } catch {
    return undefined; // unclassifiable blessed frontmatter confers nothing
  }
  if (!fm) return undefined;
  const hits = findPropertiesCanonical(fm, key);
  if (hits.length === 0) return undefined;
  // Canonical duplicates (`auto-accept` AND `auto_accept`) with DIFFERING
  // values are an ambiguity: confer nothing (fail safe) rather than pick one.
  for (const h of hits.slice(1)) {
    if (!frontmatterValuesEqual(h.value, hits[0].value)) return undefined;
  }
  return hits[0].value;
}

// ── the first consumer: the per-note auto-accept policy (#135) ───────────────

export type AutoAcceptPolicy = "appends" | "all";

/**
 * The HONORED per-note auto-accept policy carried by the blessed content, or
 * null when there is none. Only the two spec'd string values count
 * (case-insensitive, trimmed); any other shape — arrays, maps, other strings —
 * is no policy (fail safe, the detector discipline).
 */
export function autoAcceptPolicyOf(blessed: string | null | undefined): AutoAcceptPolicy | null {
  const v = honoredValueFromBlessed(blessed, "auto-accept");
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "appends" || s === "all" ? s : null;
}

// ── governance watch: side-door drift over declared properties (#224 §3) ─────

/**
 * Which DECLARED protected properties differ between the blessed content and
 * the current content — the "a change arrived from a non-human-attributed path"
 * detector the queue uses to surface side-door writes for review instead of
 * leaving them to linger invisibly (they are already INERT; this makes them
 * SEEN).
 *
 * Fail toward SURFACING: when either side cannot be confidently parsed, a
 * property is reported as drifted iff its name appears textually in either
 * content (surfacing a review row costs a look; missing a side-door change to
 * an authority-carrying key costs the perimeter).
 */
export function protectedPropertyDrift(blessed: string, current: string): string[] {
  const props = declaredProtectedProperties();
  if (props.length === 0) return [];
  const parse = (content: string): Record<string, unknown> | null | undefined => {
    try {
      return parseGuardFrontmatter(content); // null = no frontmatter (confident)
    } catch {
      return undefined; // unclassifiable
    }
  };
  const bf = parse(blessed);
  const cf = parse(current);
  const out: string[] = [];
  for (const prop of props) {
    const key = canonicalPropertyKey(prop.key);
    if (bf === undefined || cf === undefined) {
      // Scoped to the leading frontmatter BLOCK, not the body — prose that
      // merely mentions a key name must not surface a review row.
      const mentions = (c: string) => {
        const block = leadingFrontmatterBlock(c);
        if (block === null) return false;
        const l = block.toLowerCase();
        return l.includes(key) || l.includes(key.replace(/-/g, "_"));
      };
      if (mentions(blessed) || mentions(current)) out.push(key);
      continue;
    }
    const b = findPropertiesCanonical(bf, key);
    const c = findPropertiesCanonical(cf, key);
    if (b.length !== c.length) {
      out.push(key);
      continue;
    }
    // Same count: drifted iff the value multisets differ (greedy match).
    const remaining = b.map((x) => x.value);
    let drifted = false;
    for (const n of c) {
      const i = remaining.findIndex((v) => frontmatterValuesEqual(v, n.value));
      if (i < 0) {
        drifted = true;
        break;
      }
      remaining.splice(i, 1);
    }
    if (drifted) out.push(key);
  }
  return out;
}
