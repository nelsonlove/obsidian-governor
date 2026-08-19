// Ported from obsidian-jd-dashboard's src/commands/promote-to-folder.ts, split
// into PLAN (pure, here) and APPLY (mcp/tools-jd-scaffold.ts). The original
// operated on Obsidian's "currently active file"; the ported tool takes an
// explicit `path` argument instead — matching every other vault-mcp write
// tool, none of which depend on editor focus state.

import type { PlanPromoteInput, PromoteToFolderPlan } from "./types.js";

const ID_RE = /^(\d{2}\.\d{2}|\d{5})\s+(.+)$/;

export function planPromoteToFolder(input: PlanPromoteInput): PromoteToFolderPlan {
  const { path, existingPaths } = input;
  const slash = path.lastIndexOf("/");
  const basename = (slash === -1 ? path : path.slice(slash + 1)).replace(/\.md$/, "");
  const parentPath = slash === -1 ? "" : path.slice(0, slash);
  const parentName = parentPath === "" ? "" : parentPath.slice(parentPath.lastIndexOf("/") + 1);

  if (!ID_RE.test(basename)) return { ok: false, reason: "not_id_note" };
  if (basename === parentName) return { ok: false, reason: "already_cover_note" };

  const folderPath = parentPath ? `${parentPath}/${basename}` : basename;
  if (existingPaths.has(folderPath)) return { ok: false, reason: "folder_exists" };

  const fileName = path.slice(slash + 1);
  const newFilePath = `${folderPath}/${fileName}`;
  return { ok: true, folderPath, newFilePath };
}
