// LOCAL DATA ROOT — where the history repository's git directory lives (WP4, D10).
//
// OUTSIDE the vault and OUTSIDE Obsidian Sync, for the same reason the
// observation store is (see governor/wiring/observations/local-store.ts, which
// carries the full argument): Git retains historical bytes, deletion and
// redaction propagate through the vault but not through history, and a synced
// or in-vault object database would carry removed bytes to every replica
// permanently. D10 names the Git object database itself as something even the
// HISTORY SCOPE excludes — the store must not record itself.
//
// Layout: `~/.claude/governor/history/<vault-slug>/` — a bare-style git
// directory whose WORKTREE is the vault root (D10: one vault-root worktree;
// repository identity belongs to the vault). The plugin is the single writer.

import * as path from "node:path";
import { stateDir, vaultSlug } from "../../../paths.js";

const SLUG = /^[a-z0-9._-]+$/;

/** The git directory for a vault's history repository. */
export function historyDir(slugOrName: string): string {
  const slug = SLUG.test(slugOrName) ? slugOrName : vaultSlug(slugOrName);
  if (!SLUG.test(slug) || slug.includes("..")) {
    throw new Error(`refusing history dir for unusable vault slug '${slugOrName}'`);
  }
  return path.join(stateDir(), "history", slug);
}
