// ============================================================================
//  INBOX TRIAGE — the disposition substrate's SECOND instance (#221 phase 2,
//  reshaped by #241 phase 3 per Nelson's 2026-08-19 ruling)
// ----------------------------------------------------------------------------
//  Phase 2 shipped TEN verbs ported from the legacy `dispose-inbox-item` flow.
//  Phase 3 REPLACES that table (breaking, pre-release): the built-in set is
//  the three MECHANICAL PRIMITIVES only —
//
//    trash — Obsidian's recoverable trash (never a hard delete)
//    move  — the shared link-healing move primitive, target required,
//            subject to the configured move whitelist/blacklist
//    stamp — the configured frontmatter patch, note stays in place
//
//  Everything richer is a HUMAN-DECLARED disposition row in module config
//  (config.ts's `declaredDispositions`): `{id, label, description, action:
//  trash|move|stamp|choice, patch?, destination?, inPlace?, choice?}`. One
//  default declared row ships — `escalate` (mechanically stamp-in-place,
//  patch from the `escalateFrontmatter` config, default
//  `{tags: [attention/user]}`) — deletable and editable like any declared
//  row. The nine other legacy verbs do NOT ship; docs/triage.md shows how to
//  re-declare any of them as config rows.
//
//  SUBSTRATE DISCIPLINE, unchanged: the FROZEN code-level instance table is
//  the three built-ins below, declared against the shared
//  DispositionDescriptorShape (dispositions.ts — untouched; the governance
//  instance keeps declaring against the same shape). Declared rows are NOT
//  runtime additions to that table: they are CONFIGURATION the planner
//  interprets — human-only-mutable data whose authority answer is uniform
//  (every declared row is exercised by an agent through the one guarded
//  `triage_dispose` tool; none confers standing; a `choice` row's QuickAdd
//  binding is opaque-by-declaration, see plan.ts / docs). The MERGED table
//  (built-ins ∪ declared) is a derived, per-config view — the single source
//  for the tool enum, its description, and the docs — computed by
//  `mergedDispositionsOf` here.
//
//  ONE SHARED DESCRIPTION FORMAT (ruling point 4): built-ins carry default
//  descriptive text, human-overridable via config (`builtinDescriptions`),
//  the SAME field declared rows carry — descriptions exist to help agents
//  pick the right verb, wherever the verb came from.
// ============================================================================

import type { DispositionDescriptorShape } from "./dispositions.js";

/** The closed built-in id set — the three primitives. */
export type TriageBuiltinId = "trash" | "move" | "stamp";

/** The one surface this instance has: every verb is a guarded MCP tool call
 * (they share the single `triage_dispose` tool, selected by `disposition`). */
export type TriageDispositionSurface = "mcp-tool";

/** What a disposition does to the note. `choice` (declared rows only) runs a
 * human-bound QuickAdd choice — opaque by declaration. */
export type TriageAction = "trash" | "move" | "stamp" | "choice";

export type TriageTargetPolicy = "required" | "config-or-target" | "none";

export interface TriageDispositionDescriptor
  extends DispositionDescriptorShape<TriageBuiltinId, TriageDispositionSurface> {
  readonly action: Extract<TriageAction, "trash" | "move" | "stamp">;
}

/**
 * The frozen built-in instance table — the substrate's code-level triage set.
 * All agent-authority (nothing here confers standing), pure frozen data, no
 * callable. `effect` is the DEFAULT description text; the merged table lets a
 * human override it per built-in (same description field as declared rows).
 */
export const TRIAGE_DISPOSITIONS: ReadonlyArray<TriageDispositionDescriptor> = Object.freeze([
  Object.freeze({
    id: "trash",
    authority: "agent",
    surface: "mcp-tool",
    label: "Trash",
    action: "trash",
    effect: "trash the note (Obsidian's trash — recoverable, never a hard delete)",
  } as const),
  Object.freeze({
    id: "move",
    authority: "agent",
    surface: "mcp-tool",
    label: "Move",
    action: "move",
    effect:
      "move the note into the target folder (link-healing move; missing parents created; the destination is " +
      "checked against the configured move whitelist/blacklist)",
  } as const),
  Object.freeze({
    id: "stamp",
    authority: "agent",
    surface: "mcp-tool",
    label: "Stamp",
    action: "stamp",
    effect:
      "apply the configured stamp frontmatter patch (modules.triage.config.stampFrontmatter; array values union, " +
      "scalars overwrite) and leave the note in place",
  } as const),
]);

export const TRIAGE_BUILTIN_IDS: ReadonlyArray<TriageBuiltinId> = Object.freeze(
  TRIAGE_DISPOSITIONS.map((d) => d.id),
);

// ── declared rows (human config — parsed/validated in config.ts) ────────────

/** One human-declared disposition row, as config.ts sanitizes it. */
export interface DeclaredDispositionRow {
  id: string;
  label?: string;
  description?: string;
  action: TriageAction;
  /** Frontmatter patch (stamp rows: required; move rows: optional). Already
   * accept-forbidden- and proto-key-checked by config.ts. */
  patch?: Record<string, unknown>;
  /** Configured fallback destination folder (an explicit `target` overrides). */
  destination?: string;
  /** Stamp rows: true (the default with no destination) ⇒ the note stays put
   * and `target` is refused; false with no destination ⇒ target required. */
  inPlace?: boolean;
  /** Choice rows: the QuickAdd choice binding (name, or choice id). */
  choice?: string;
}

// ── the merged table (built-ins ∪ declared) — the single-source view ────────

/** One row of the merged disposition table — what the tool enum, description,
 * planner, and docs all render from. */
export interface MergedDisposition {
  id: string;
  label: string;
  /** The shared description field — built-in default/override, or the
   * declared row's own text. */
  description: string;
  builtin: boolean;
  action: TriageAction;
  /** The effective frontmatter patch, or null. Built-in `stamp` resolves this
   * from config at plan time (patchSource: "stampFrontmatter"); a null patch
   * on the built-in stamp row here means "resolved later". */
  patch: Record<string, unknown> | null;
  destination: string | null;
  inPlace: boolean;
  choice: string | null;
  targetPolicy: TriageTargetPolicy;
}

/** Derive a row's target policy from its shape — one rule, applied uniformly:
 * trash / choice / in-place stamp aim at nothing; a declared destination makes
 * `target` an override; a moving row without one requires it. */
export function targetPolicyOf(row: {
  action: TriageAction;
  destination?: string | null;
  inPlace?: boolean;
}): TriageTargetPolicy {
  if (row.action === "trash" || row.action === "choice") return "none";
  if (row.action === "stamp") {
    if (row.destination) return "config-or-target";
    if (row.inPlace === false) return "required";
    return "none"; // in place — the default stamp shape
  }
  // move
  return row.destination ? "config-or-target" : "required";
}

/** The default `escalate` declared row (ruling point 2): mechanically
 * stamp-in-place; the patch comes from the `escalateFrontmatter` config
 * (default `{tags: [attention/user]}` — the tag is configurable there), and
 * the row disappears when the human sets `declaredDispositions` without it. */
export function defaultEscalateRow(escalatePatch: Record<string, unknown>): DeclaredDispositionRow {
  return {
    id: "escalate",
    label: "Escalate",
    description:
      "flag the note for human attention (stamps the configured escalate frontmatter patch, default " +
      "tags: [attention/user]) and leave it in place",
    action: "stamp",
    patch: escalatePatch,
    inPlace: true,
  };
}

/** The inputs `mergedDispositionsOf` consumes — config.ts's parsed view. */
export interface MergeInputs {
  /** Sanitized declared rows, or null when the config leaves them unset
   * (⇒ the default escalate row applies). Collisions with built-in ids and
   * duplicate ids are already dropped (and reported) by config.ts. */
  declared: DeclaredDispositionRow[] | null;
  /** Per-built-in description overrides (the shared description field). */
  builtinDescriptions: Partial<Record<TriageBuiltinId, string>>;
  /** The parsed escalate patch (feeds the DEFAULT escalate row only). */
  escalateFrontmatter: Record<string, unknown>;
}

/**
 * The merged (built-in ∪ declared) disposition table, in render order:
 * built-ins first (declared order), then declared rows (declared order).
 * Pure over its inputs; the tool enum, tool description, planner and docs all
 * derive from this one function — single-sourced by construction.
 */
export function mergedDispositionsOf(inputs: MergeInputs): MergedDisposition[] {
  const builtins: MergedDisposition[] = TRIAGE_DISPOSITIONS.map((d) => ({
    id: d.id,
    label: d.label,
    description: inputs.builtinDescriptions[d.id] ?? d.effect,
    builtin: true,
    action: d.action,
    patch: null, // built-in stamp resolves its patch from config at plan time
    destination: null,
    inPlace: d.action === "stamp",
    choice: null,
    targetPolicy: targetPolicyOf({ action: d.action, destination: null, inPlace: d.action === "stamp" }),
  }));
  const declaredRows = inputs.declared ?? [defaultEscalateRow(inputs.escalateFrontmatter)];
  const declared: MergedDisposition[] = declaredRows.map((r) => ({
    id: r.id,
    label: r.label ?? r.id,
    description: r.description ?? `declared '${r.action}' disposition (no description configured)`,
    builtin: false,
    action: r.action,
    patch: r.patch && Object.keys(r.patch).length > 0 ? r.patch : null,
    destination: r.destination ?? null,
    inPlace: r.action === "stamp" ? r.inPlace !== false && !r.destination : false,
    choice: r.choice ?? null,
    targetPolicy: targetPolicyOf(r),
  }));
  return [...builtins, ...declared];
}

/** Lookup by id over a merged table — undefined for an unknown id. */
export function mergedById(table: MergedDisposition[], id: string): MergedDisposition | undefined {
  return table.find((d) => d.id === id);
}

/** The merged id list, in declared order — the `triage_dispose` enum's single
 * source. */
export function mergedIds(table: MergedDisposition[]): string[] {
  return table.map((d) => d.id);
}

/** One line per verb — the tool description's and the docs' single source. */
export function mergedLines(table: MergedDisposition[]): string[] {
  return table.map((d) => `${d.id} — ${d.description}`);
}
