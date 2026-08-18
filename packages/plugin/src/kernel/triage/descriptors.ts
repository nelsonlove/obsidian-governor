// ============================================================================
//  INBOX TRIAGE — the disposition substrate's SECOND instance (#221, phase 2)
// ----------------------------------------------------------------------------
//  Successor to the vault's retired `dispose-inbox-item` QuickAdd flow: ten
//  dispositions over notes sitting in inbox positions. NONE of the ten confers
//  standing — every one is a mechanical, reversible write (a move through the
//  link-healing move primitive, a frontmatter transition, or a trash) — so per
//  the authority axis ALL TEN are `authority: "agent"`: ordinary guarded MCP
//  verbs, human-drivable through the tool-runner, with NO pane surface at all
//  (Nelson's native-tooling rule on #221: queue VIEWS are native Bases over
//  frontmatter; bespoke pane UI is reserved for gesture-gated authority
//  dispositions, of which this instance has none).
//
//  The table below is the SINGLE SOURCE for the instance: the `triage_dispose`
//  tool derives its disposition enum, its description text, and the module
//  manifest's directory entry from it, so the ten verbs cannot drift apart
//  across surfaces.
//
//  Effect-mapping metadata (this instance's data extension of the substrate
//  shape — still plain strings, still frozen, still no callable):
//
//    action        — what the disposition does to the note: "move" (via the
//                    shared link-healing move primitive), "trash" (Obsidian
//                    trash, never a hard delete), or "in-place" (frontmatter
//                    only, the note stays put).
//    targetPolicy  — "required": the call must name a `target` folder;
//                    "config-or-target": an explicit `target` wins, else the
//                    configured destination (destinationKey), else a typed
//                    refusal; "none": a `target` is refused (nothing to aim).
//    destinationKey / frontmatterKey — which TriageConfig keys supply the
//                    fallback destination / the frontmatter patch. VAULT
//                    SEMANTICS LIVE IN CONFIG, never here: the descriptors
//                    name config keys, and the keys' defaults (config.ts)
//                    mirror the legacy flow's live-vault behavior while
//                    staying per-vault overridable.
// ============================================================================

import type { DispositionDescriptorShape } from "./dispositions.js";

export type TriageDispositionId =
  | "discard"
  | "route"
  | "establish-new-home"
  | "convert-to-action"
  | "develop-as-knowledge"
  | "register"
  | "curate-as-link"
  | "defer-to-someday"
  | "archive-as-record"
  | "escalate";

/** The one surface this instance has: every verb is a guarded MCP tool call
 * (they share the single `triage_dispose` tool, selected by `disposition`). */
export type TriageDispositionSurface = "mcp-tool";

export type TriageAction = "move" | "trash" | "in-place";
export type TriageTargetPolicy = "required" | "config-or-target" | "none";

/** TriageConfig keys a descriptor may name (see config.ts). */
export type TriageDestinationKey =
  | "actionDestination"
  | "knowledgeDestination"
  | "somedayDestination"
  | "archiveDestination";
export type TriageFrontmatterKey = "actionFrontmatter" | "somedayFrontmatter" | "escalateFrontmatter";

export interface TriageDispositionDescriptor
  extends DispositionDescriptorShape<TriageDispositionId, TriageDispositionSurface> {
  readonly action: TriageAction;
  readonly targetPolicy: TriageTargetPolicy;
  /** Config key holding the fallback destination folder ("config-or-target" only). */
  readonly destinationKey?: TriageDestinationKey;
  /** Config key holding the frontmatter patch this disposition applies. */
  readonly frontmatterKey?: TriageFrontmatterKey;
}

/**
 * The inbox-triage instance's full disposition set. Frozen: the tool surface
 * and docs render FROM this; nothing may add to it at runtime.
 */
export const TRIAGE_DISPOSITIONS: ReadonlyArray<TriageDispositionDescriptor> = Object.freeze([
  Object.freeze({
    id: "discard",
    authority: "agent",
    surface: "mcp-tool",
    label: "Discard",
    action: "trash",
    targetPolicy: "none",
    effect: "trash the note (Obsidian's trash — recoverable, never a hard delete)",
  } as const),
  Object.freeze({
    id: "route",
    authority: "agent",
    surface: "mcp-tool",
    label: "Route",
    action: "move",
    targetPolicy: "required",
    effect: "move the note into the target folder it already belongs in (link-healing move)",
  } as const),
  Object.freeze({
    id: "establish-new-home",
    authority: "agent",
    surface: "mcp-tool",
    label: "Establish new home",
    action: "move",
    targetPolicy: "required",
    effect: "move the note into a NEW home folder named by target (missing parent folders are created)",
  } as const),
  Object.freeze({
    id: "convert-to-action",
    authority: "agent",
    surface: "mcp-tool",
    label: "Convert to action",
    action: "move",
    targetPolicy: "config-or-target",
    destinationKey: "actionDestination",
    frontmatterKey: "actionFrontmatter",
    effect:
      "retype the note as a task (the configured action frontmatter patch), then move it to target or the " +
      "configured action destination",
  } as const),
  Object.freeze({
    id: "develop-as-knowledge",
    authority: "agent",
    surface: "mcp-tool",
    label: "Develop as knowledge",
    action: "move",
    targetPolicy: "config-or-target",
    destinationKey: "knowledgeDestination",
    effect: "move the note to target or the configured knowledge destination, to be developed as a knowledge note",
  } as const),
  Object.freeze({
    id: "register",
    authority: "agent",
    surface: "mcp-tool",
    label: "Register",
    action: "move",
    targetPolicy: "required",
    effect: "move the note into the registry location named by target",
  } as const),
  Object.freeze({
    id: "curate-as-link",
    authority: "agent",
    surface: "mcp-tool",
    label: "Curate as link",
    action: "move",
    targetPolicy: "required",
    effect: "move the note into the link-collection location named by target",
  } as const),
  Object.freeze({
    id: "defer-to-someday",
    authority: "agent",
    surface: "mcp-tool",
    label: "Defer to someday",
    action: "move",
    targetPolicy: "config-or-target",
    destinationKey: "somedayDestination",
    frontmatterKey: "somedayFrontmatter",
    effect:
      "apply the configured someday frontmatter patch, then move the note to target or the configured someday " +
      "destination",
  } as const),
  Object.freeze({
    id: "archive-as-record",
    authority: "agent",
    surface: "mcp-tool",
    label: "Archive as record",
    action: "move",
    targetPolicy: "config-or-target",
    destinationKey: "archiveDestination",
    effect: "move the note to target or the configured archive destination, kept as a record",
  } as const),
  Object.freeze({
    id: "escalate",
    authority: "agent",
    surface: "mcp-tool",
    label: "Escalate",
    action: "in-place",
    targetPolicy: "none",
    frontmatterKey: "escalateFrontmatter",
    effect:
      "flag the note for human attention (the configured escalate frontmatter patch) and leave it in place — " +
      "the simplest faithful mapping of the legacy escalate",
  } as const),
]);

/** Lookup by id — undefined for an unknown id (the set is closed). */
export function triageDispositionById(id: string): TriageDispositionDescriptor | undefined {
  return TRIAGE_DISPOSITIONS.find((d) => d.id === id);
}

/** The closed id list, in declared order — the `triage_dispose` enum's single
 * source. */
export function triageDispositionIds(): TriageDispositionId[] {
  return TRIAGE_DISPOSITIONS.map((d) => d.id);
}

/** One line per verb — the tool description's and the docs' single source. */
export function triageDispositionLines(): string[] {
  return TRIAGE_DISPOSITIONS.map((d) => `${d.id} — ${d.effect}`);
}
