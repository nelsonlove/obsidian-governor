// jd-scaffold module, Stage A of the jd-dashboard fold
// (docs/superpowers/specs/2026-08-19-jd-dashboard-fold-design.md): three
// mutating tools ported from obsidian-jd-dashboard's standard-zeros.ts and
// promote-to-folder.ts. Each is a thin PLAN-then-APPLY shell over the pure
// planners in kernel/jd-scaffold/ — matching tools-scheme-write.ts's shape
// exactly, including its allowlist discipline: an input path is checked
// before planning, and every path a plan COMPUTES is re-checked before being
// applied, unconditionally, even under dry_run: true.
//
// Existence checks feed the planners as an `exists` predicate
// (`app.vault.getAbstractFileByPath`), not a pre-built Set — see
// kernel/jd-scaffold/types.ts's own comment on PlanStandardZerosInput.exists
// for why: a pre-built listing would make this file independently enumerate
// the same candidate paths the planner itself computes, risking the two
// falling out of sync.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App, TFolder } from "obsidian";
import { ok, codedError } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import {
  planStandardZeros,
  planEnsureCategoryIndexes,
} from "../kernel/jd-scaffold/standard-zeros.js";
import { planPromoteToFolder } from "../kernel/jd-scaffold/promote-to-folder.js";
import type { CategoryFolderInput, PlannedCreate } from "../kernel/jd-scaffold/types.js";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export interface JdScaffoldToolsCtx {
  getSettings: () => GuardSettings;
}

/** Applies a list of planned creates via app.vault.create, one at a time. One
 *  failure is reported per-item and does not abort the rest — matches
 *  jd-dashboard's own original CreateZerosResult/EnsureCategoryIndexesResult
 *  shape. Every path is allowlist-checked immediately before its own write,
 *  not just once up front — a long-running batch must not outlive a
 *  mid-batch settings change. */
async function applyCreates(
  app: App,
  settings: GuardSettings,
  creates: PlannedCreate[]
): Promise<{ created: number; failures: { path: string; error: string }[] }> {
  let created = 0;
  const failures: { path: string; error: string }[] = [];
  for (const c of creates) {
    if (!isVisible(c.path, settings)) {
      failures.push({ path: c.path, error: "out_of_allowlist" });
      continue;
    }
    try {
      await app.vault.create(c.path, c.content);
      created++;
    } catch (e) {
      failures.push({ path: c.path, error: (e as Error).message });
    }
  }
  return { created, failures };
}

/** Depth-2 `XX <name>` folders, vault-wide — the same scope
 *  ensureCategoryIndexes' original walk used. Duck-types TFolder via
 *  `"children" in f` rather than an `instanceof` check against the real
 *  class, so this stays free of a value-level `obsidian` import (only the
 *  TFolder type is imported, erased at compile time). */
function categoryFolders(app: App): CategoryFolderInput[] {
  const CATEGORY_RE = /^(\d{2})\s+(.+)$/;
  const out: CategoryFolderInput[] = [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (!("children" in f)) continue;
    const folder = f as TFolder;
    if (folder.path.split("/").length !== 2) continue;
    const m = folder.name.match(CATEGORY_RE);
    if (!m) continue;
    out.push({
      path: folder.path,
      name: folder.name,
      prefix: m[1],
      childBasenames: folder.children.map((c: any) => c.name as string),
    });
  }
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerJdScaffoldTools(server: McpServer, app: App, ctx: JdScaffoldToolsCtx): void {
  server.registerTool(
    "obsidian_jd_standard_zeros",
    {
      title: "Create standard zeros (XX.00-XX.09) for a JD category",
      description:
        "Creates the fixed 10-note standard-zeros set (JDex, Inbox, Task & project management, Templates, Links, " +
        "Conventions & policies, Knowledge base, Dashboard, Someday, Archive) inside a category folder. An " +
        "already-existing target is SKIPPED, never overwritten. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        folder_path: z.string().describe('Vault path of the category folder (e.g. "10-19 Personal/06 Digital tools").'),
        prefix: z.string().describe('The category\'s two-digit prefix (e.g. "06").'),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ folder_path, prefix, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(folder_path, settings)) {
        return codedError("out_of_allowlist", `"${folder_path}" is outside the active path allowlist.`);
      }

      const folderName = folder_path.includes("/") ? folder_path.slice(folder_path.lastIndexOf("/") + 1) : folder_path;
      const plan = planStandardZeros({
        folderPath: folder_path,
        folderName,
        prefix,
        now: today(),
        exists: (p) => !!app.vault.getAbstractFileByPath(p),
      });

      if (dry_run) return ok({ dry_run: true, creates: plan.creates, skipped: plan.skipped });

      const applied = await applyCreates(app, settings, plan.creates);
      return ok({ dry_run: false, created: applied.created, skipped: plan.skipped, failures: applied.failures });
    }
  );

  server.registerTool(
    "obsidian_jd_ensure_category_indexes",
    {
      title: "Self-heal missing XX.00 JDex files vault-wide",
      description:
        "Walks every depth-2 `XX <name>` category folder and creates a minimal `XX.00` JDex index for any that " +
        "lack one (in any of `XX.00 Title.md`, `XX.00.md`, `XX.00+SUF Title.md` form). Vault-wide, no target " +
        "argument. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ dry_run }) => {
      const settings = ctx.getSettings();
      const folders = categoryFolders(app);
      const plan = planEnsureCategoryIndexes(folders, today());

      if (dry_run) return ok({ dry_run: true, creates: plan.creates });

      const applied = await applyCreates(app, settings, plan.creates);
      return ok({ dry_run: false, created: applied.created, failures: applied.failures });
    }
  );

  server.registerTool(
    "obsidian_jd_promote_to_folder",
    {
      title: "Promote a JD id note to a same-named folder",
      description:
        "Converts an XX.YY (or 5-digit expanded-area id) note into a same-named folder with the note moved inside " +
        "as the folder's cover note, via app.fileManager.renameFile (link-healing). Refuses (not_id_note / " +
        "already_cover_note / folder_exists) rather than guessing. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        path: z.string().describe("Vault path of the note to promote."),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ path, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(path, settings)) {
        return codedError("out_of_allowlist", `"${path}" is outside the active path allowlist.`);
      }

      const plan = planPromoteToFolder({ path, exists: (p) => !!app.vault.getAbstractFileByPath(p) });

      if (!plan.ok) return codedError(plan.reason, promoteRefusalMessage(plan.reason, path));
      if (!isVisible(plan.folderPath, settings) || !isVisible(plan.newFilePath, settings)) {
        return codedError("out_of_allowlist", `the computed destination for "${path}" is outside the active path allowlist.`);
      }

      if (dry_run) return ok({ dry_run: true, folder_path: plan.folderPath, new_file_path: plan.newFilePath });

      await app.vault.createFolder(plan.folderPath);
      const file = app.vault.getAbstractFileByPath(path);
      await app.fileManager.renameFile(file as any, plan.newFilePath);
      return ok({ dry_run: false, folder_path: plan.folderPath, new_file_path: plan.newFilePath });
    }
  );
}

function promoteRefusalMessage(reason: "not_id_note" | "already_cover_note" | "folder_exists", path: string): string {
  switch (reason) {
    case "not_id_note":
      return `"${path}" doesn't look like a JD id note (expected "XX.YY Title" or a 5-digit id).`;
    case "already_cover_note":
      return `"${path}" is already its folder's cover note.`;
    case "folder_exists":
      return `the destination folder for "${path}" already exists.`;
  }
}
