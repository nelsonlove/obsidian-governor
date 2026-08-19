// jd-scaffold module, Stage A of the jd-dashboard fold
// (docs/superpowers/specs/2026-08-19-jd-dashboard-fold-design.md): three
// mutating tools ported from obsidian-jd-dashboard's standard-zeros.ts and
// promote-to-folder.ts. Each is a thin PLAN-then-APPLY shell over the pure
// planners in kernel/jd-scaffold/ — matching tools-scheme-write.ts's shape
// exactly, including its allowlist discipline: an input path is checked
// before planning, and every path a plan COMPUTES is re-checked before being
// applied, unconditionally, even under dry_run: true.
//
// Registered as a proper `mutating: true` capability module through
// modules-mount.ts (see builtinModules), NOT hand-registered in server.ts —
// unlike tools-scheme-write.ts/tools-survey.ts/tools-quickadd.ts, these three
// tools mutate real vault NOTES, not another plugin's config, so nothing
// blocks them from going the module-host route and picking up its free
// settings-tab enable/disable toggle. That route means this file takes an
// injected JdScaffoldSource (mirroring vocabSource/skillsSource/
// provenanceSource) rather than a raw `App` — modules-mount.ts's MountDeps
// deliberately never carries one, so the Obsidian binding lives in the
// adapter (obsidian-jd-scaffold-source.ts) instead, keeping this file
// Obsidian-free and headless-testable like every other module's tool layer.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, codedError } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import {
  planStandardZeros,
  planEnsureCategoryIndexes,
} from "../kernel/jd-scaffold/standard-zeros.js";
import { planPromoteToFolder } from "../kernel/jd-scaffold/promote-to-folder.js";
import type { CategoryFolderInput, PlannedCreate } from "../kernel/jd-scaffold/types.js";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** The Obsidian-facing seam this module needs — nothing more. The live
 *  implementation is `obsidianJdScaffoldSource` in
 *  obsidian-jd-scaffold-source.ts; tests supply a fake directly. */
export interface JdScaffoldSource {
  /** True iff a vault path already exists (any type — note or folder). */
  exists(path: string): boolean;
  /** Every depth-2 `XX <name>` category folder, vault-wide. */
  categoryFolders(): CategoryFolderInput[];
  create(path: string, content: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  /** Link-healing rename — must go through app.fileManager.renameFile in the
   *  live adapter, never vault.rename (packages/plugin/CLAUDE.md's "Link
   *  healing" guarantee). */
  renameFile(fromPath: string, toPath: string): Promise<void>;
  /** Today's date, `YYYY-MM-DD`. Injected (not `new Date()` inline) so tests
   *  can pin it without a fake clock plumbed through every call. */
  today(): string;
}

export interface JdScaffoldToolsCtx {
  getSettings: () => GuardSettings;
}

/** MountDeps.jdScaffoldSource's absent-case fallback — matches the
 *  emptyBasesSource/crosssession-empty-source precedent: reads answer empty
 *  rather than throwing (so dry_run always works), writes throw a clear
 *  error that applyCreates' per-item catch (or the tool's own thrown-error
 *  path for promote) turns into a refusal rather than a silent no-op. */
export function emptyJdScaffoldSource(): JdScaffoldSource {
  const unwired = () => { throw new Error("jd-scaffold source not wired (no live Obsidian adapter)."); };
  return {
    exists: () => false,
    categoryFolders: () => [],
    create: async () => unwired(),
    createFolder: async () => unwired(),
    renameFile: async () => unwired(),
    today: () => new Date().toISOString().slice(0, 10),
  };
}

/** Applies a list of planned creates via source.create, one at a time. One
 *  failure is reported per-item and does not abort the rest — matches
 *  jd-dashboard's own original CreateZerosResult/EnsureCategoryIndexesResult
 *  shape. Every path is allowlist-checked immediately before its own write,
 *  not just once up front — a long-running batch must not outlive a
 *  mid-batch settings change. `paths` (the successfully created ones, in
 *  write order) feeds `filesChanged`/`files` in the caller's result — the
 *  guard's `reportedEffects()` convention (guarded.ts) — so the journal's
 *  `effects` field names every note actually written, not just the
 *  argument-derived `folder_path` (which, for ensure_category_indexes, isn't
 *  even an argument at all). */
async function applyCreates(
  source: JdScaffoldSource,
  settings: GuardSettings,
  creates: PlannedCreate[]
): Promise<{ created: number; paths: string[]; failures: { path: string; error: string }[] }> {
  let created = 0;
  const paths: string[] = [];
  const failures: { path: string; error: string }[] = [];
  for (const c of creates) {
    if (!isVisible(c.path, settings)) {
      failures.push({ path: c.path, error: "out_of_allowlist" });
      continue;
    }
    try {
      await source.create(c.path, c.content);
      created++;
      paths.push(c.path);
    } catch (e) {
      failures.push({ path: c.path, error: (e as Error).message });
    }
  }
  return { created, paths, failures };
}

export function registerJdScaffoldTools(server: McpServer, source: JdScaffoldSource, ctx: JdScaffoldToolsCtx): void {
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
        now: source.today(),
        exists: (p) => source.exists(p),
      });

      // Computed paths are re-checked unconditionally, even under dry_run —
      // matching this file's own header comment and tools-scheme-write.ts's
      // precedent. Every candidate is a child of the already-checked
      // folder_path, so prefix-matching means nothing is ever actually
      // dropped here today; the check exists so a preview can never diverge
      // from what applyCreates would really do on the same plan.
      if (dry_run) {
        return ok({ dry_run: true, creates: plan.creates.filter((c) => isVisible(c.path, settings)), skipped: plan.skipped });
      }

      const applied = await applyCreates(source, settings, plan.creates);
      return ok({
        dry_run: false,
        created: applied.created,
        skipped: plan.skipped,
        failures: applied.failures,
        filesChanged: applied.created,
        files: applied.paths,
      });
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
      // No path argument (vault-wide by design), so this tool bounds its OWN
      // iteration — CLAUDE.md's read-boundary rule for argument-less
      // enumeration: filter BEFORE the listing ever reaches the planner, not
      // just before a write. A hidden category folder must be invisible to
      // "what needs an index" the same way it is to any other read.
      const visibleFolders = source.categoryFolders().filter((f) => isVisible(f.path, settings));
      const plan = planEnsureCategoryIndexes(visibleFolders, source.today());

      if (dry_run) return ok({ dry_run: true, creates: plan.creates });

      const applied = await applyCreates(source, settings, plan.creates);
      return ok({
        dry_run: false,
        created: applied.created,
        failures: applied.failures,
        filesChanged: applied.created,
        files: applied.paths,
      });
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

      const plan = planPromoteToFolder({ path, exists: (p) => source.exists(p) });

      if (!plan.ok) return codedError(plan.reason, promoteRefusalMessage(plan.reason, path));
      if (!isVisible(plan.folderPath, settings) || !isVisible(plan.newFilePath, settings)) {
        return codedError("out_of_allowlist", `the computed destination for "${path}" is outside the active path allowlist.`);
      }

      if (dry_run) return ok({ dry_run: true, folder_path: plan.folderPath, new_file_path: plan.newFilePath });

      await source.createFolder(plan.folderPath);
      try {
        await source.renameFile(path, plan.newFilePath);
      } catch (e) {
        // createFolder already succeeded, so a retry's OWN planPromoteToFolder
        // call will now see plan.folderPath as existing and refuse
        // folder_exists — a confusing dead end with no indication why. Not a
        // rollback (this layer has no delete primitive, and inventing one
        // just for this narrow failure isn't worth the added surface for how
        // rarely renameFile fails after a successful createFolder) — just an
        // honest, actionable error instead of a silent, permanently-stuck retry.
        return codedError(
          "promote_partial",
          `"${plan.folderPath}" was created but "${path}" could not be moved into it (${(e as Error).message}). ` +
            `Remove the empty folder before retrying.`
        );
      }
      return ok({
        dry_run: false,
        folder_path: plan.folderPath,
        new_file_path: plan.newFilePath,
        filesChanged: 2,
        files: [plan.folderPath, plan.newFilePath],
      });
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
