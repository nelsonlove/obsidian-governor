// The kernel's TargetProbe over live Obsidian state. Split from kernel/index.ts
// so the kernel itself imports nothing from `obsidian` and stays unit-testable
// headlessly (the same reason ObsidianBackend is separate from registerFsTools).

import { TFile, type App } from "obsidian";
import type { TargetProbe } from "./index.js";
import type { ServerIdentity } from "./install-id.js";
import type { UidSource } from "./uid-index.js";

/**
 * The transport's own identity, for the journal's actor block: which vault,
 * which install, which plugin version. Lives here rather than in the kernel
 * because `app.vault.getName()` is the one Obsidian call it needs — same reason
 * obsidianProbe does.
 */
export function obsidianServerIdentity(app: App, install: string, version: string): ServerIdentity {
  return { vault: app.vault.getName(), install, version };
}

/** The one Obsidian call both the probe and the uid index's source need. */
function frontmatterUid(app: App, path: string): string | undefined {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return undefined;
  const v = app.metadataCache.getFileCache(f)?.frontmatter?.uid;
  return typeof v === "string" && v ? v : undefined;
}

/**
 * The uid index's source over Obsidian's metadata cache — every markdown file's
 * frontmatter `uid`, already parsed by the host. Cache lookups only: building
 * the index must never read the vault, or plugin load would pay seconds to learn
 * what Obsidian already knows.
 *
 * Lives here, with the probe, for the same reason: it is the only part of the
 * uid index that touches `obsidian`, and keeping it here leaves uid-index.ts
 * headlessly testable.
 */
export function obsidianUidSource(app: App): UidSource {
  return {
    paths: () => app.vault.getMarkdownFiles().map((f) => f.path),
    uidOf: (path) => frontmatterUid(app, path),
  };
}

export function obsidianProbe(app: App): TargetProbe {
  const fileAt = (path: string): TFile | null => {
    const f = app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  };
  return {
    // Cache lookup only — never a read from disk. When the cache hasn't parsed
    // the file yet the journal simply carries no uid, which is the documented
    // "when cheaply available" contract. The uid INDEX is consulted first by the
    // kernel; this stays the fallback for a path the index has not caught up to.
    uid(path) {
      return frontmatterUid(app, path);
    },
    // mtime is Obsidian's own cheap revision token; a durable rev lands with the
    // identity substrate (Delivery step 2).
    rev(path) {
      return fileAt(path)?.stat.mtime;
    },
  };
}
