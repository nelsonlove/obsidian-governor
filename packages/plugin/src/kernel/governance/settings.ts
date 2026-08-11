// Plain, non-capability governance display settings — badge display toggles only. These
// booleans confer no accept/revert/adopt capability; they only control whether a pending-count
// badge is painted. Ported from obsidian-stewardship/src/settings.ts (#83, cycle 2). Kept in a
// dedicated module (no obsidian import) so DEFAULT_GOVERNANCE_SETTINGS is headless-testable.
//
// In vault-mcp these live in the governance module's config
// (`settings.modules.governance.config`), read at pane-wire time; the pane defaults them ON
// when the config is absent. They are deliberately NOT part of the accept surface.
export interface GovernanceDisplaySettings {
  showRibbonBadge: boolean;
  showViewTabBadge: boolean;
}

export const DEFAULT_GOVERNANCE_SETTINGS: GovernanceDisplaySettings = {
  showRibbonBadge: true,
  showViewTabBadge: true,
};

// Coerce an untrusted config record (from data.json) into display settings, defaulting each
// toggle ON. Never throws — a malformed value falls back to the default.
export function governanceDisplaySettings(config: unknown): GovernanceDisplaySettings {
  const c = (config ?? {}) as Record<string, unknown>;
  return {
    showRibbonBadge: typeof c.showRibbonBadge === "boolean" ? c.showRibbonBadge : DEFAULT_GOVERNANCE_SETTINGS.showRibbonBadge,
    showViewTabBadge: typeof c.showViewTabBadge === "boolean" ? c.showViewTabBadge : DEFAULT_GOVERNANCE_SETTINGS.showViewTabBadge,
  };
}
