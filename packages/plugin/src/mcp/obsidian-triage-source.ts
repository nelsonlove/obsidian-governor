// obsidian-triage-source.ts — the triage module's live vault adapter (the
// obsidian-debt-source.ts pattern: a separate file so tools-triage.ts stays
// obsidian-free and headless-testable; only server.ts imports this).
//
// The write primitives are deliberately the SHARED ones, not re-implementations:
//
//   move   — tools-vault-write.ts's `moveOne` (overwrite: false, hard-pinned):
//            the link-healing fileManager.renameFile path every other move
//            tool uses, with parent folders created and NEVER an overwrite —
//            the tool layer refuses `destination_occupied` first, and a race
//            that slips past it fails the move rather than clobbering.
//   trash  — app.fileManager.trashFile: Obsidian's own trash (respects the
//            user's trash preference; recoverable, never a hard delete).
//   updateFrontmatter — app.fileManager.processFrontMatter: Obsidian's atomic
//            frontmatter read-modify-write.

import { TFile, type App } from "obsidian";
import { moveOne } from "./tools-vault-write.js";
import type { TriageSource } from "./tools-triage.js";

export function obsidianTriageSource(app: App): TriageSource {
  const fileOf = (path: string): TFile | null => {
    const f = app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  };
  return {
    paths: () => app.vault.getMarkdownFiles().map((f) => f.path),
    frontmatter: (p) => app.metadataCache.getCache(p)?.frontmatter ?? null,
    stat: (p) => {
      const f = fileOf(p);
      return f ? { ctime: f.stat.ctime ?? null, mtime: f.stat.mtime ?? null } : null;
    },
    exists: (p) => app.vault.getAbstractFileByPath(p) !== null,
    move: (from, to) => moveOne(app, from, to, false),
    async trashNote(p) {
      const f = fileOf(p);
      if (!f) throw new Error(`not a note: ${p}`);
      await app.fileManager.trashFile(f);
    },
    async updateFrontmatter(p, apply) {
      const f = fileOf(p);
      if (!f) throw new Error(`not a note: ${p}`);
      await app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => apply(fm));
    },
  };
}
