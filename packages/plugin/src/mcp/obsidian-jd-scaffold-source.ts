// obsidian-jd-scaffold-source.ts — the live Obsidian adapter for the
// jd-scaffold module (tools-jd-scaffold.ts's JdScaffoldSource). Kept out of
// that file so the tool layer stays free of a VALUE-level `obsidian` import
// and is headless-testable with a fake source; only this adapter needs to be
// verified against a running Obsidian.

import { TFolder, type App } from "obsidian";
import type { JdScaffoldSource } from "./tools-jd-scaffold.js";
import type { CategoryFolderInput } from "../kernel/jd-scaffold/types.js";

const CATEGORY_FOLDER_RE = /^(\d{2})\s+(.+)$/;

/** Depth-2 `XX <name>` folders, vault-wide — the same scope
 *  ensureCategoryIndexes' original walk used. */
function categoryFoldersOf(app: App): CategoryFolderInput[] {
  const out: CategoryFolderInput[] = [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (!(f instanceof TFolder)) continue;
    if (f.path.split("/").length !== 2) continue;
    const m = f.name.match(CATEGORY_FOLDER_RE);
    if (!m) continue;
    out.push({
      path: f.path,
      name: f.name,
      prefix: m[1],
      childBasenames: f.children.map((c) => c.name),
    });
  }
  return out;
}

export function obsidianJdScaffoldSource(app: App): JdScaffoldSource {
  return {
    exists(path: string): boolean {
      return !!app.vault.getAbstractFileByPath(path);
    },
    categoryFolders(): CategoryFolderInput[] {
      return categoryFoldersOf(app);
    },
    async create(path: string, content: string): Promise<void> {
      await app.vault.create(path, content);
    },
    async createFolder(path: string): Promise<void> {
      await app.vault.createFolder(path);
    },
    async renameFile(fromPath: string, toPath: string): Promise<void> {
      const file = app.vault.getAbstractFileByPath(fromPath);
      if (!file) throw new Error(`"${fromPath}" no longer exists.`);
      // app.fileManager.renameFile, never vault.rename — the link-healing
      // guarantee packages/plugin/CLAUDE.md's "Link healing" section pins.
      await app.fileManager.renameFile(file, toPath);
    },
    today(): string {
      return new Date().toISOString().slice(0, 10);
    },
  };
}
