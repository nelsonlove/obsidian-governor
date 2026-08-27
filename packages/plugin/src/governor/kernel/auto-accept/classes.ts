// ============================================================================
//  AUTO-ACCEPT — the AUTHORIZED change-class registry + allowlist normalization
// ----------------------------------------------------------------------------
//  Auto-accept is the ONE automated exception to human-only acceptance: it advances
//  a note's baseline (= accepts it) WITHOUT a human gesture, but ONLY for changes
//  that are provably mechanical and belong to a class Nelson explicitly authorized.
//
//  This module is the frozen UNIVERSE of ever-allowable classes. Nelson authorized
//  EXACTLY four: uid-stamp, timestamp, canonical-order, link-heal. Adding a fifth is
//  a CODE change that must pass the heavy adversarial review — it can never be done
//  by data, config, an agent, a command, or an MCP tool. That is the strongest form
//  of "human-only-mutable": broadening authority requires editing + reviewing THIS
//  source constant, not flipping a runtime value.
//
//  Each class carries `railNeutral`. The four authorized classes are rail-neutral BY
//  CONSTRUCTION — their detector definitions guarantee they touch no conformance-
//  relevant field (see eligibility.ts / detectors.ts). A FUTURE non-rail-neutral
//  class MUST instead supply a real `railCheck` result before it can be allowlisted;
//  the eligibility engine refuses to accept a matched class that is neither
//  rail-neutral nor rail-cleared (see eligibility.ts::evaluateRail). No `obsidian`
//  import — pure + headless-testable.
//
//  Ported verbatim from obsidian-stewardship/src/auto-accept/classes.ts (#83, cycle 1).
//  This is the AUTHORIZATION DATA + allowlist normalization ONLY — pure logic. It wires
//  to no MCP tool, no plugin instance, and no `app` this cycle; the eligibility ENGINE
//  that consumes it (eligibility.ts) is likewise unwired substrate until cycle 2.
// ============================================================================

export type ClassId = "uid-stamp" | "timestamp" | "canonical-order" | "link-heal";

export interface ClassSpec {
  id: ClassId;
  // TRUE iff this class provably changes no conformance-relevant field, so rail-clean
  // holds without running a rail check. All four authorized classes are rail-neutral.
  railNeutral: boolean;
  // One-line justification of the rail-neutrality claim (documented + asserted in tests).
  railNeutralBecause: string;
}

// The four — and ONLY the four — Nelson authorized. Frozen: the sole way to add a class
// is to edit this array in source and pass review. Order here is the canonical order.
export const AUTHORIZED_CLASSES: ReadonlyArray<ClassSpec> = Object.freeze([
  Object.freeze({
    id: "uid-stamp",
    railNeutral: true,
    railNeutralBecause:
      "adds a `uid` field only when absent; a uid-add can only IMPROVE uid-coverage, " +
      "never regress any conformance check.",
  }),
  Object.freeze({
    id: "timestamp",
    railNeutral: true,
    railNeutralBecause:
      "`created`/`modified` are provenance timestamps that no conformance rail checks; " +
      "values are validated to be timestamps so nothing else can ride in.",
  }),
  Object.freeze({
    id: "canonical-order",
    railNeutral: true,
    railNeutralBecause:
      "pure reordering: identical field set AND identical field values baseline↔current, " +
      "only order differs — zero semantic change, so no finding can change.",
  }),
  Object.freeze({
    id: "link-heal",
    railNeutral: true,
    railNeutralBecause:
      "repoints a wikilink to a CONFIRMED rename/move target of the same note; the link " +
      "still resolves to the same underlying note, so link-integrity findings cannot change.",
  }),
]) as ReadonlyArray<ClassSpec>;

const BY_ID: ReadonlyMap<ClassId, ClassSpec> = new Map(
  AUTHORIZED_CLASSES.map((s) => [s.id, s] as const),
);

export function isAuthorizedClass(id: string): id is ClassId {
  return BY_ID.has(id as ClassId);
}

export function specFor(id: ClassId): ClassSpec {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`auto-accept: unknown class ${id}`);
  return s;
}

// The DEFAULT enabled allowlist = every authorized class. (The design's original default was
// EMPTY until Nelson authorized classes; Nelson has now authorized exactly these four, so the
// shipped default IS these four.)
export const DEFAULT_ALLOWLIST: ReadonlyArray<ClassId> = Object.freeze(
  AUTHORIZED_CLASSES.map((s) => s.id),
);

// Normalize an UNTRUSTED persisted/loaded allowlist to a safe canonical list:
//   - keep ONLY ids that are authorized (an unknown/injected id is silently dropped — it can
//     NEVER become eligible, because eligibility only ever matches authorized classes),
//   - dedupe,
//   - return in canonical (AUTHORIZED_CLASSES) order.
// A malformed input (not an array of strings) → the DEFAULT allowlist. Because the worst a
// tampered allowlist can do is enable/disable AMONG the four already-authorized rail-neutral
// classes (enabling can never exceed them; disabling only makes MORE stay pending — the safe
// direction), this normalization confers no dangerous authority in either direction.
export function normalizeAllowlist(input: unknown): ClassId[] {
  if (!Array.isArray(input)) return [...DEFAULT_ALLOWLIST];
  const seen = new Set<ClassId>();
  for (const raw of input) {
    if (typeof raw === "string" && isAuthorizedClass(raw)) seen.add(raw);
  }
  return AUTHORIZED_CLASSES.filter((s) => seen.has(s.id)).map((s) => s.id);
}

export function serializeAllowlist(ids: ReadonlyArray<ClassId>): string {
  return JSON.stringify({ enabled: normalizeAllowlist([...ids]) }, null, 2);
}

// Parse the persisted allowlist file body → normalized ids. Any parse error or unexpected
// shape → DEFAULT (fail toward Nelson's authorized four, never toward a broader set — and
// note DEFAULT is already the maximal authorized set, so this can't broaden authority).
export function deserializeAllowlist(text: string): ClassId[] {
  try {
    const obj = JSON.parse(text) as { enabled?: unknown };
    return normalizeAllowlist(obj?.enabled);
  } catch {
    return [...DEFAULT_ALLOWLIST];
  }
}
