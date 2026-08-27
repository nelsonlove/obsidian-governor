// CHANGE CLASSES — the six-class registry and escalation rules (WP3).
//
// The six classes and their canonical order are declared ONCE, in
// kernel/operations/action.ts, because subject hashing sorts by that order and
// two lists would eventually disagree about the sort. This module re-exports
// them for the governance layer and adds what governance needs on top: which
// class GOVERNS admission when a change carries several, and the escalation
// rules from the normative change-classes doc.
//
// The classification rules that bind every consumer (change-classes.md):
//
//   1. Classify the actual effect, not the requested verb.
//   2. A change may carry more than one class.
//   3. The highest-authority applicable class governs admission.
//   4. Uncertainty escalates; it never silently downgrades.
//   5. Classification is evaluated from the proposed diff and relevant schema,
//      not solely from the agent's declaration.
//   6. If a supposedly mechanical change alters assertions or standing, the
//      cohort is blocked and reclassified.
//   7. Scale, sensitivity, reversibility, and confidence are recorded
//      separately from class — they are orthogonal to it.
//
// Rules 1, 5, and 6 are behavior for the classifier (WP5+); rules 3 and 4 are
// pure functions and live here.

import { CHANGE_CLASSES, type ChangeClass } from "../../../kernel/operations/action.js";

export { CHANGE_CLASSES, type ChangeClass };

const RANK = new Map<ChangeClass, number>(CHANGE_CLASSES.map((c, i) => [c, i]));

/** Whether a string names one of the six classes. */
export function isChangeClass(v: unknown): v is ChangeClass {
  return typeof v === "string" && RANK.has(v as ChangeClass);
}

/**
 * Sort classes into the canonical six-class order, dropping duplicates.
 * Subject serialization requires this order; it is also the authority order,
 * lowest to highest.
 */
export function sortClasses(classes: readonly ChangeClass[]): ChangeClass[] {
  return [...new Set(classes)].sort((a, b) => (RANK.get(a) ?? 0) - (RANK.get(b) ?? 0));
}

/**
 * Rule 3: the highest-authority applicable class governs admission. A change
 * that is both `presentation` and `content` is admitted as `content`.
 * Returns null for an empty set — "no classes" is a read, and reads are not
 * admitted.
 */
export function governingClass(classes: readonly ChangeClass[]): ChangeClass | null {
  let top: ChangeClass | null = null;
  for (const c of classes) {
    if (top === null || (RANK.get(c) ?? 0) > (RANK.get(top) ?? 0)) top = c;
  }
  return top;
}

/**
 * Rule 4: uncertainty escalates, never silently downgrades. When a classifier
 * cannot decide between two classes, the change is treated as the
 * higher-authority one. This is the pure half of the rule; refusing to let a
 * later step LOWER a classification is enforced where classifications are
 * stored.
 */
export function escalate(a: ChangeClass, b: ChangeClass): ChangeClass {
  return (RANK.get(a) ?? 0) >= (RANK.get(b) ?? 0) ? a : b;
}
