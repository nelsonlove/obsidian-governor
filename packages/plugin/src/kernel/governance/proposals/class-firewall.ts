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

/** Exported for tests: the canonical order the firewall sorts into. */
export { CHANGE_CLASSES };
