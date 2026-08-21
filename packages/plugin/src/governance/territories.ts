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

import { posix } from "node:path";

/**
 * Top-level areas the plugin must never review or touch (guarded territories /
 * hold zones — they are archival or legally sensitive, not live governed
 * content). `80-89` is the legal/PII area with a standing rule that its
 * contents do not leave it.
 */
export const EXCLUDED_PREFIXES = ["obsidian-old/", "80-89", "_keep/", "holds/"];

/**
 * Whether a vault path lies inside a guarded territory.
 *
 * The path is normalized first (mirroring guard.ts's allowlist check) so a
 * spelling like `./80-89 Divorce/x.md` or `Notes/../80-89 Divorce/x.md`
 * cannot defeat the prefix match. A path that still escapes upward after
 * normalization (`../…`) answers TRUE: this predicate guards retention, so
 * "cannot tell where this points" fails closed, not open.
 */
export function isExcludedTerritory(path: string): boolean {
  const p = posix.normalize(path.replace(/\\/g, "/"));
  if (p.startsWith("..")) return true;
  return EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix));
}
