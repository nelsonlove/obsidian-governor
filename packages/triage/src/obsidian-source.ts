// obsidian-source.ts — the live vault adapter (the obsidian-triage-source.ts
// pattern it was extracted from: a separate file so tools.ts stays
// obsidian-free and headless-testable; only main.ts imports this).
//
// The write primitives, and what each one is:
//
//   move   — `moveNote` below: `app.fileManager.renameFile`, Obsidian's
//            LINK-UPDATING rename, with parent folders created and NEVER an
//            overwrite. In the host this was `tools-vault-write.ts`'s shared
//            `moveOne`; that function has three other host callers and stays
//            there, so the satellite carries its own. That is a duplicated
//            twenty lines, deliberately: the alternative is publishing an
//            `obsidian`-importing function out of `@vault-mcp/core`, which is
//            obsidian-free by contract and must stay that way. The property
//            that matters is not the shared function but the shared RULE —
//            never `vault.rename`, which moves the bytes and orphans every
//            backlink — and this package pins it the same way the host does,
//            with a source scan over its own `src/**/*.ts` plus a live test
//            through the real handler (tests/link-healing.test.mjs).
//   trash  — app.fileManager.trashFile: Obsidian's own trash (respects the
//            user's trash preference; recoverable, never a hard delete).
//   updateFrontmatter — app.fileManager.processFrontMatter: Obsidian's atomic
//            frontmatter read-modify-write.
//   runChoice — `executeQuickAddChoice` from `@vault-mcp/core`, the shared #225
//            seam. It was published to core at this extraction rather than
//            copied: the host's `obsidian_run_command` drives the same seam,
//            and the file's whole reason for existing is that the two surfaces
//            must not drift on how a choice is resolved and invoked. The
//            binding arrives from human-only plugin config; nothing here
//            consults or bypasses the host's cli-policy denies.

import { TFile, type App } from "obsidian";
import { executeQuickAddChoice } from "@vault-mcp/core";
import type { TriageSource } from "./tools.js";

async function ensureParentFolders(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        /* exists / race */
      }
    }
  }
}

/**
 * Move one note, link-healing and never overwriting.
 *
 * The tool layer refuses `destination_occupied` before this is reached; the
 * check here is the race backstop, and it FAILS rather than clobbering — there
 * is no `overwrite` parameter at all, because no triage disposition has ever
 * had a reason to overwrite a note.
 */
export async function moveNote(app: App, from: string, to: string): Promise<void> {
  if (!from.endsWith(".md")) throw new Error("source must end in .md");
  if (!to.endsWith(".md")) throw new Error("destination must end in .md");
  if (from === to) throw new Error("from and to are the same path");
  const file = app.vault.getAbstractFileByPath(from);
  if (!(file instanceof TFile)) throw new Error(`not found: ${from}`);
  if (app.vault.getAbstractFileByPath(to)) throw new Error(`destination exists: ${to}`);
  await ensureParentFolders(app, to);
  // NEVER app.vault.rename — that moves the bytes and leaves every backlink
  // pointing at a note that is no longer there. Pinned by the source scan in
  // tests/link-healing.test.mjs.
  await app.fileManager.renameFile(file, to);
}

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
    move: (from, to) => moveNote(app, from, to),
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
    runChoice: (binding, variables) => executeQuickAddChoice(app, { binding }, variables),
  };
}
