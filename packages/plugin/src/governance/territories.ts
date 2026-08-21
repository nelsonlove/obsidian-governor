// GUARDED TERRITORIES — the vault areas Governor must never review, touch, or
// retain copies of.
//
// Extracted from governance/wiring.ts the day capture became the second
// consumer. Two hand-copied lists of the same territories would drift, and a
// drifted copy here fails PRIVATE: a prefix present in the pane's list but
// missing from capture's means the pane politely skips a folder while capture
// quietly writes its note bodies to disk. One list, two consumers.
//
// The list itself is this vault's folder names hardcoded — issue #321 tracks
// promoting it to real configuration. Until that lands, this module is the
// single place the names live.

/**
 * Top-level areas the plugin must never review or touch (guarded territories /
 * hold zones — they are archival or legally sensitive, not live governed
 * content). `80-89` is the legal/PII area with a standing rule that its
 * contents do not leave it.
 */
export const EXCLUDED_PREFIXES = ["obsidian-old/", "80-89", "_keep/", "holds/"];

/** Whether a vault path lies inside a guarded territory. */
export function isExcludedTerritory(path: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
}
