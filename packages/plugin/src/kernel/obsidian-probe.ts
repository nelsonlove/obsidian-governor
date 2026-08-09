// The kernel's TargetProbe over live Obsidian state. Split from kernel/index.ts
// so the kernel itself imports nothing from `obsidian` and stays unit-testable
// headlessly (the same reason ObsidianBackend is separate from registerFsTools).

import { TFile, type App } from "obsidian";
import type { TargetProbe } from "./index.js";

export function obsidianProbe(app: App): TargetProbe {
  const fileAt = (path: string): TFile | null => {
    const f = app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  };
  return {
    // Cache lookup only — never a read from disk. When the cache hasn't parsed
    // the file yet the journal simply carries no uid, which is the documented
    // "when cheaply available" contract.
    uid(path) {
      const file = fileAt(path);
      if (!file) return undefined;
      const v = app.metadataCache.getFileCache(file)?.frontmatter?.uid;
      return typeof v === "string" ? v : undefined;
    },
    // mtime is Obsidian's own cheap revision token; a durable rev lands with the
    // identity substrate (Delivery step 2).
    rev(path) {
      return fileAt(path)?.stat.mtime;
    },
  };
}
