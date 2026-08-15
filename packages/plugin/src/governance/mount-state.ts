// The governance live-mount transition decision — a pure, obsidian-free helper so the
// idempotency + mount/unmount decision is headlessly unit-testable (mount-state.test.mjs).
// main.ts's applyGovernanceMount uses this to decide what to do when the governance module's
// enable toggle flips live, and wireGovernance/removeChild carry out the obsidian-coupled work.

/** What to do given the pane's CURRENT mount state and the DESIRED enabled setting. */
export type MountAction = "mount" | "unmount" | "none";

/**
 * Decide the transition. The two "already in the desired state" cases return "none" — this is
 * the idempotency guard: enabling when already mounted, or disabling when already unmounted, is
 * a no-op (never a double-wire or a double-teardown). Only a genuine change yields work.
 */
export function mountAction(mounted: boolean, enabled: boolean): MountAction {
  if (enabled === mounted) return "none";
  return enabled ? "mount" : "unmount";
}
