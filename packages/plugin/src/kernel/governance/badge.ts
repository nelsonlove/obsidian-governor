// Pure badge-visibility helper — headless-testable without importing the obsidian runtime.
// Ported from obsidian-stewardship/src/badge.ts (#83, cycle 2). Used by both the ribbon badge
// and the review-view tab-icon badge (governance/wiring.ts / governance/pane.ts) so the
// "hidden when count is 0 or the setting is off" rule lives in exactly one place.
export function badgeVisible(count: number, enabled: boolean): boolean {
  return enabled && count > 0;
}
