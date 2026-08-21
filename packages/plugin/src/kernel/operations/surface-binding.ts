// SURFACE BINDINGS — Gate 0, WP0.
//
// A binding says: "this door opens onto that action, at that version." It is
// the only legitimate way a caller reaches an action, and it is deliberately
// data rather than code so both directions of the inventory are checkable:
//
//   forward — every registered action has at least one binding, so an action
//             whose implementation was deleted fails the build rather than
//             lingering in the capability projection; and
//   inverse — every reachable handler has a binding naming a registered
//             action, so a tool added without an action fails the build rather
//             than becoming an invisible second semantic owner.
//
// A binding may never WEAKEN its action's contract. It carries no scope,
// authority, retention or verification fields of its own for exactly that
// reason: there is nothing here to disagree with the action.

import type { SurfaceKind } from "./action.js";

/**
 * Surface kinds an AGENT can reach.
 *
 * `mcp` is the bridge's own tool surface; `external` is a third-party plugin
 * publishing through `plugin.api`, which is agent-reachable for the same
 * reason (its tools are projected to the client). `ui` is a human gesture,
 * `automation` is Governor's own scheduled work, and `internal` is a
 * Governor-to-Governor call — none of the three is something a connected
 * client can invoke.
 *
 * This constant is what the authority fence is defined over: an action that
 * can create standing may not be bound to any kind in this set. That makes
 * "no agent-facing surface binds to admission" a build-time property rather
 * than a convention someone has to remember.
 */
export const AGENT_REACHABLE_SURFACES: readonly SurfaceKind[] = ["mcp", "external"];

export function isAgentReachable(kind: SurfaceKind): boolean {
  return AGENT_REACHABLE_SURFACES.includes(kind);
}

/** One door onto one action. */
export interface SurfaceBinding {
  kind: SurfaceKind;
  /**
   * The surface's own identity, unique across the whole registry: an MCP tool
   * name (`obsidian_read_note`), an Obsidian command id
   * (`governor:open-review`), a pane control id, an automation id, or a dotted
   * internal call site. Uniqueness is what makes the inverse inventory a
   * lookup rather than a search.
   */
  id: string;
  /** Registered action id this surface opens onto. */
  action: string;
  /** Registered action version. A surface binds an exact contract version, so
   * a version bump is a visible, reviewable change at every door. */
  actionVersion: number;
  /**
   * Where the binding lives, for the source-scan inventory to point at.
   * Repo-relative, no line number — line numbers churn and would make the
   * fixture a merge-conflict generator.
   */
  source?: string;
  /** Free-text note for a binding whose existence needs explaining (an
   * unguarded registration, a deliberate dispatcher, a legacy alias). */
  note?: string;
}
