// ============================================================================
//  DISPOSITIONS AS DATA — the acceptance instance's declared disposition set
//  (#101, phase 1 of #221)
// ----------------------------------------------------------------------------
//  Every verb the governance surface offers is DECLARED here as a descriptor:
//  `{ id, authority, surface, label, effect, … }`. The pane renders its human
//  controls from this set (membership, order, labels) and the one agent verb's
//  tool name is derived from it — so "what dispositions exist, and who may
//  exercise each" is a reviewable data table, not knowledge scattered across
//  button-creation call sites.
//
//  THE AUTHORITY AXIS (#221): a disposition that confers standing — that decides
//  what enters or leaves the accepted knowledge base — is `authority: "human"`
//  and exists ONLY as a gesture-gated pane control (addEventListener +
//  isRealGesture; see gesture.ts and governance/pane.ts). A mechanical,
//  reversible write that merely SUPPLIES a candidate is `authority: "agent"`
//  and exists ONLY as an ordinary guarded MCP tool. Nothing here changes the
//  gating: descriptors are DATA. Deliberately:
//
//    - NO callable rides a descriptor. `effect` is a documentation string, not
//      a function — an accept-capable callable on module-exported data would be
//      exactly the app-walkable accept gadget the reachability invariant
//      (governance/wiring.ts header) forbids.
//    - NO registry / plugin API for third-party dispositions. The set below is
//      frozen; extending it is a reviewed code change, same as
//      AUTHORIZED_CLASSES (auto-accept/classes.ts).
//
//  Obsidian-free, pure data — headless-testable (tests/governance-
//  dispositions.test.mjs pins completeness + authority classes).
// ============================================================================

export type DispositionId =
  | "accept"
  | "revert"
  | "adopt"
  | "request-changes"
  | "withdraw"
  | "submit-revision"
  | "skip";

export type DispositionAuthority = "human" | "agent";

/** Where a disposition surfaces. */
export type DispositionSurface =
  /** A button on a pending item's detail view (per-note). */
  | "pending-item"
  /** A control on the queue header (whole-queue). */
  | "queue"
  /** A button on a Revising-section row (per-note). */
  | "revising-item"
  /** An MCP tool — the ONE agent-expressible disposition. */
  | "mcp-tool"
  /** Stateless navigation (skip/back) — mutates nothing. */
  | "navigation";

export interface DispositionDescriptor {
  readonly id: DispositionId;
  /** Who may exercise it. "human" ⇒ gesture-gated pane control ONLY; "agent" ⇒ guarded MCP tool ONLY. */
  readonly authority: DispositionAuthority;
  readonly surface: DispositionSurface;
  /** Button text (human) / display label (agent). */
  readonly label: string;
  /** One-line effect description — documentation + log/PR vocabulary, never a callable. */
  readonly effect: string;
  /** Human only: additionally confirmation-gated behind a modal (adopt). */
  readonly confirm?: boolean;
  /** Human only: captures free text in a modal before acting (request-changes). */
  readonly input?: boolean;
  /** True when the disposition mutates NOTHING (skip): exempt from gesture gating. */
  readonly stateless?: boolean;
}

/** The agent-facing revision tool's name — derived from the one `authority: "agent"` descriptor. */
export const SUBMIT_REVISION_TOOL = "governance_submit_revision";

/**
 * The acceptance instance's full disposition set (#101's authority table).
 * Frozen: the pane renders FROM this; nothing may add to it at runtime.
 */
export const DISPOSITIONS: ReadonlyArray<DispositionDescriptor> = Object.freeze([
  Object.freeze({
    id: "accept",
    authority: "human",
    surface: "pending-item",
    label: "Accept",
    effect:
      "the ONE accept, context-aware across both lifecycles (#221/#164 convergence): advance this note's " +
      "baseline to its current content; iff the note is acceptance-status: proposed, ALSO stamp the accepted " +
      "family (acceptance-status: accepted, accepted-by: <configured identity>, accepted-on: <local minutes " +
      "precision>) via processFrontMatter, with the baseline advanced from the post-stamp content. Notes " +
      "without proposed status get baseline-advance only (byte-untouched); revising notes are never stamped",
  } as const),
  Object.freeze({
    id: "revert",
    authority: "human",
    surface: "pending-item",
    label: "Revert",
    effect: "restore the note to its accepted baseline; quarantine (never delete) the rejected version",
  } as const),
  Object.freeze({
    id: "request-changes",
    authority: "human",
    surface: "pending-item",
    label: "Request changes…",
    input: true,
    effect:
      "set acceptance-status: revising and insert the feedback as a [!revision-request] callout below the note's H1",
  } as const),
  Object.freeze({
    id: "adopt",
    authority: "human",
    surface: "queue",
    label: "Adopt baseline",
    confirm: true,
    effect: "snapshot ALL current content as the reviewed baseline and clear the queue (mass-silence)",
  } as const),
  Object.freeze({
    id: "withdraw",
    authority: "human",
    surface: "revising-item",
    label: "Withdraw",
    effect: "remove the [!revision-request] callout(s) this pane inserted and set acceptance-status: proposed",
  } as const),
  Object.freeze({
    id: "submit-revision",
    authority: "agent",
    surface: "mcp-tool",
    label: SUBMIT_REVISION_TOOL,
    effect:
      "a revising agent resubmits: acceptance-status: proposed, addressed [!revision-request] callouts removed, " +
      "optional [!revision-report] summary inserted — lands in the pending channel for human review",
  } as const),
  Object.freeze({
    id: "skip",
    authority: "human",
    surface: "navigation",
    label: "← Back to queue",
    stateless: true,
    effect: "rotate/deselect only — reads and writes nothing",
  } as const),
]);

/** The descriptors for one surface, in declared (render) order. */
export function dispositionsFor(surface: DispositionSurface): DispositionDescriptor[] {
  return DISPOSITIONS.filter((d) => d.surface === surface);
}

/** Lookup by id — undefined for an unknown id (the set is closed). */
export function dispositionById(id: DispositionId): DispositionDescriptor | undefined {
  return DISPOSITIONS.find((d) => d.id === id);
}

/**
 * The human dispositions that MUTATE state — exactly the set that must be
 * gesture-gated (addEventListener + isRealGesture, never `.onclick =`).
 * Stateless navigation (skip) is exempt; the one agent disposition is not a
 * pane control at all.
 */
export function gestureGatedDispositions(): DispositionDescriptor[] {
  return DISPOSITIONS.filter((d) => d.authority === "human" && !d.stateless);
}

/**
 * The context-aware Accept's per-note effect text (#221/#164): what THIS click will do,
 * surfaced on the button (tooltip/aria) so the human sees what will be stamped before the
 * one click. Pure display string — no callable, no capability; still exactly one click.
 */
export function acceptEffectFor(status: string | null | undefined, acceptedBy: string): string {
  return status === "proposed"
    ? "Accept: advances the baseline AND stamps acceptance-status: accepted, " +
        `accepted-by: ${acceptedBy}, accepted-on: <now, minutes precision> into the note's frontmatter`
    : "Accept: advances the baseline only — the note itself is not edited";
}
