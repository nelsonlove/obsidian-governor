// CLASS FIREWALL — classification from the DIFF, not the declaration (WP6b-1).
//
// Classification rule 5 (change-classes.md): "Classification is evaluated
// from the proposed diff and relevant schema, not solely from the agent's
// declaration." The attack this closes is NARROWING — an action declaring
// `presentation` over a diff that actually changes content, routing a
// substantive edit through mechanical verification. Widening is the safe
// direction (rule 3: the highest applicable class governs; rule 4:
// uncertainty escalates, never downgrades), so a declaration ABOVE the
// derivation passes, and a declaration MISSING a derived class refuses with a
// reclassification finding, per the firewall paragraph: "Any mismatch blocks
// cohort admission and produces a reclassification finding."
//
// The seam is built now, while the only consumer (`note.write@1`, asserting
// `content` — the second-highest class) is the safe case; the first NARROW
// action (a formatter asserting `presentation`) inherits a working firewall
// instead of needing one built under pressure. The derivation itself is
// deliberately coarse and errs UPWARD: distinguishing presentation from
// content byte-diffs is a rule pack that arrives with the first narrow
// action; until then, any byte change derives `content` and any path change
// derives `structural`, which can only over-classify — the safe direction.

import { CHANGE_CLASSES, sortClasses, type ChangeClass } from "../contracts/change-class.js";
import { LEADING_FRONTMATTER_RE, stripLeadingBom, canonicalPropertyKey, isAuthorityFamilyKey } from "@vault-mcp/core";

export interface DiffFacts {
  /** Exact base bytes, null for a creation. */
  baseBytes: Uint8Array | null;
  /** Exact proposed bytes. */
  proposedBytes: Uint8Array;
  /** Whether the note's path changed (a move/rename rode along). */
  pathChanged: boolean;
  /**
   * Whether the diff touches the acceptance/authority frontmatter family.
   * Computed by the caller from the parsed frontmatter, because the firewall
   * does not parse YAML — it classifies what the caller measured.
   */
  touchesAuthorityKeys: boolean;
}

export class ClassMismatchError extends Error {
  readonly code = "class_mismatch";
  constructor(
    readonly declared: ChangeClass[],
    readonly derived: ChangeClass[],
    detail: string
  ) {
    super(`reclassification finding: ${detail} (declared: ${declared.join("+") || "none"}, derived: ${derived.join("+") || "none"})`);
    this.name = "ClassMismatchError";
  }
}

/** Derive the change classes the diff actually carries. Errs upward on purpose. */
export function deriveClasses(facts: DiffFacts): ChangeClass[] {
  const out: ChangeClass[] = [];
  const bytesChanged =
    facts.baseBytes === null ||
    facts.baseBytes.length !== facts.proposedBytes.length ||
    !facts.baseBytes.every((b, i) => b === facts.proposedBytes[i]);
  if (bytesChanged) out.push("content");
  if (facts.pathChanged) out.push("structural");
  if (facts.touchesAuthorityKeys) out.push("authority");
  return sortClasses(out);
}

/**
 * The firewall: every DERIVED class must be covered by the DECLARATION.
 * A declaration may exceed the derivation (widening buys a stricter path);
 * a derivation exceeding the declaration is the narrowing attack and
 * refuses. An empty derivation with a non-empty declaration passes — the
 * caller declared more scrutiny than the diff needed.
 */
export function requireClassesCovered(declared: readonly ChangeClass[], derived: readonly ChangeClass[]): void {
  const have = new Set(declared);
  const missing = derived.filter((c) => !have.has(c));
  if (missing.length > 0) {
    throw new ClassMismatchError(
      [...declared],
      [...derived],
      `the diff carries ${missing.join("+")} which the declaration does not cover — a substantive change cannot ride a mechanical claim`
    );
  }
}

/**
 * Whether the diff touches the authority frontmatter family — accepted
 * provenance fields or acceptance-status, recognized by core's ONE family
 * predicate (never a local copy). The scan is line-based over the leading
 * frontmatter block: authority keys are flat scalars in practice, and the
 * scan's failure mode is OVER-detection (a block scalar containing
 * "accepted-by:" text), which derives authority, fails the coverage check,
 * and skips the proposal — the write itself stands. Erring toward refusal on
 * an authority-shaped diff is the direction rule 6 requires.
 *
 * The first draft hardcoded false with a "by construction" claim the review
 * disproved: the accept guard refuses INTRODUCING or CHANGING accepted keys,
 * but a write that REMOVES them, or downgrades acceptance-status
 * accepted → proposed (deliberately allowed, #228), passes the guard and
 * changes standing — an authority-class change that would have classified as
 * content-only.
 */
export function authorityKeysDiffer(baseText: string | null, proposedText: string): boolean {
  const a = authorityEntries(baseText);
  const b = authorityEntries(proposedText);
  if (a.size !== b.size) return true;
  for (const [k, v] of a) if (b.get(k) !== v) return true;
  return false;
}

function authorityEntries(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (text === null) return out;
  const m = LEADING_FRONTMATTER_RE.exec(stripLeadingBom(text));
  if (!m) return out;
  for (const line of m[1].split(/\r\n|\n|\r/)) {
    const kv = /^([A-Za-z0-9_ -]+?)\s*:(.*)$/.exec(line);
    if (!kv) continue;
    const key = canonicalPropertyKey(kv[1]);
    if (isAuthorityFamilyKey(key)) out.set(key, kv[2].trim());
  }
  return out;
}

/**
 * The note's uid, parsed from the EXACT bytes the write landed — not from the
 * metadata cache, which updates asynchronously and lags a create long enough
 * that every new note's proposal would get the path fallback even when the
 * write stamped a uid (review finding). Cache remains the caller's fallback
 * for notes whose uid predates this write.
 */
export function frontmatterUid(text: string): string | null {
  const m = LEADING_FRONTMATTER_RE.exec(stripLeadingBom(text));
  if (!m) return null;
  for (const line of m[1].split(/\r\n|\n|\r/)) {
    const kv = /^uid\s*:(.*)$/.exec(line);
    if (kv) {
      const v = kv[1].trim().replace(/^["']|["']$/g, "");
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/** Exported for tests: the canonical order the firewall sorts into. */
export { CHANGE_CLASSES };
