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
// unlike tools-scheme-write.ts/tools-survey.ts, these three
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
import { isVisible, visiblePaths, type GuardSettings } from "../guard.js";
import {
  planStandardZeros,
  planEnsureCategoryIndexes,
} from "../kernel/jd-scaffold/standard-zeros.js";
import { planPromoteToFolder } from "../kernel/jd-scaffold/promote-to-folder.js";
import type { CategoryFolderInput, PlannedCreate } from "../kernel/jd-scaffold/types.js";
import { planReindexCategory, reindexTier, isIndexFilePath } from "../kernel/jd-scaffold/category-index.js";
import { standardZeros, suffixFor } from "../kernel/jd-scaffold/standard-zeros.js";
import {
  extractJdId,
  classifyTemplates,
  findZeroTemplate,
  findGenericTemplate,
  findStemTemplate,
  buildContext,
  substitute,
  sanitizeTitle,
  destPathForZero,
  destPathForGenericId,
  destPathForStem,
  type TemplateMatch,
} from "../kernel/jd-scaffold/templates.js";
import { scanForAcceptFence } from "./tools-cli.js";

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
  /** Every markdown note's vault path — feeds planReindexCategory's allPaths. */
  allNotePaths(): string[];
  /** A note's current content, or null if it doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Overwrite a note's content in place — the file already exists (unlike
   *  `create`, which is for NEW notes). */
  modify(path: string, content: string): Promise<void>;
  /** Vault paths of a folder's own direct `.md` children (not recursive) —
   *  for discovering a templates folder's own template files. Empty array
   *  for a non-existent or non-folder path, never throws. */
  listFolderChildren(folderPath: string): string[];
  /** Pre-formatted date/time for template placeholder substitution — the
   *  same fixed-format precedent as `today()`, just all three fields the
   *  templates module's `buildContext` wants at once. */
  clock(): { date: string; time: string; now: string };
}

export interface JdScaffoldToolsCtx {
  getSettings: () => GuardSettings;
  /** Feeds the accept-forbidden content scan on template-created notes
   *  (applyTemplate) — same injection shape `registerCliTools`'s own
   *  `{parseYaml}` opt uses. Without it, `templateContentAcceptRefusal`
   *  fails closed on ANY frontmatter-carrying content at all ("carries a
   *  frontmatter fence that cannot be verified without a YAML parser") —
   *  so this isn't a nice-to-have, every real template-creation call needs
   *  it wired to do anything useful. */
  parseYaml?: (yaml: string) => unknown;
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
    allNotePaths: () => [],
    read: async () => null,
    modify: async () => unwired(),
    listFolderChildren: () => [],
    clock: () => ({ date: "", time: "", now: "" }),
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

  server.registerTool(
    "obsidian_jd_reindex_category",
    {
      title: "Rebuild an XX.00 JDex file's Contents section from vault truth",
      description:
        "Rebuilds the `## Contents` section of an `XX.00` index file from the vault's own structure — NOT a " +
        "jd-index.yaml registry. Three tiers, dispatched by the target's own prefix: ordinary per-category " +
        "(`XX.00`, XX not a multiple of 10) lists the category's own folder members; area-management (`X0.00`) " +
        "consolidates every category `## Contents` within the same area; system (`00.00`) consolidates every " +
        "category across every area. Descriptions written as `[[link]] *(note)*` are preserved across every " +
        "regen, at every tier — the target file's own local description always wins over an inherited one. " +
        "While a path allowlist is configured the consolidation is CONTAINED BY IT — a hidden sibling category is " +
        "neither read nor named, so an area/system reindex is partial and `scoped_to_allowlist` says so. " +
        "`dry_run: true` reports the planned new content without writing.",
      inputSchema: {
        path: z.string().describe('Vault path of the XX.00 index file to reindex (e.g. "10-19 Personal/06 Digital tools/06.00 JDex.md").'),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ path, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(path, settings)) {
        return codedError("out_of_allowlist", `"${path}" is outside the active path allowlist.`);
      }

      // Strict XX.00 shape, not just reindexTier's loose two-digit-prefix
      // check — reindexTier is right for the PURE planner's own dispatch
      // (matching the original's real behavior, see category-index.ts's own
      // comment), but wrong as this tool's gate: an ordinary note like
      // "10.13 Something.md" has a leading "10" prefix and would dispatch to
      // "area-management" too, and — since it was never fetched into
      // siblingContent (only strictly XX.00-shaped paths are) — would go on
      // to overwrite that unrelated note with an area consolidation view
      // that has nothing to do with it. isIndexFilePath is the same strict
      // check the planner's own sibling-discovery already uses.
      if (!isIndexFilePath(path)) {
        return codedError("not_index_file", `"${path}" doesn't look like an XX.00 index file (expected "XX.00 Title.md", "XX.00.md", or "XX.00+SUF Title.md").`);
      }
      const tier = reindexTier(path)!; // isIndexFilePath true ⇒ reindexTier can't be null

      // Read-boundary containment (CLAUDE.md): this tool enumerates/reads
      // vault content beyond its own `path` argument — every sibling XX.00
      // file at the area-management/system tiers — so that listing bounds
      // its OWN iteration through the allowlist, same as
      // obsidian_jd_ensure_category_indexes above and obsidian_repoint_link's
      // own precedent (tools-vault-write.ts). Filtered BEFORE any read, not
      // just before the write: a hidden sibling's name/description must
      // never reach `new_content`, not even under dry_run.
      const scoped = Boolean(settings.allowlist?.length);
      const allPaths = scoped ? visiblePaths(source.allNotePaths(), settings) : source.allNotePaths();
      // Only area-management/system tiers cross-read sibling XX.00 files
      // (bulletsForCategory, ported in kernel/jd-scaffold/category-index.ts)
      // — the ordinary tier needs only its own current content. Checking the
      // tier first (no I/O — reindexTier is a pure regex check) avoids
      // reading every category index file vault-wide for the common,
      // single-category case.
      const toFetch = tier === "ordinary" ? [path] : allPaths.filter(isIndexFilePath);
      const siblingContent = new Map<string, string>();
      for (const p of toFetch) {
        const content = await source.read(p);
        if (content !== null) siblingContent.set(p, content);
      }

      const plan = planReindexCategory({ targetIndexPath: path, allPaths, siblingContent });
      if (!plan) {
        // isIndexFilePath already confirmed above, so this would mean it and
        // planReindexCategory's own dispatch disagree — defensive, not
        // expected to fire.
        return codedError("not_index_file", `"${path}" doesn't look like an XX.00 index file.`);
      }

      if (dry_run) return ok({ dry_run: true, new_content: plan.newContent, preserved: plan.preserved, scoped_to_allowlist: scoped });

      await source.modify(path, plan.newContent);
      return ok({ dry_run: false, preserved: plan.preserved, filesChanged: 1, files: [path], scoped_to_allowlist: scoped });
    }
  );

  server.registerTool(
    "obsidian_jd_new_standard_zero",
    {
      title: "Create one standard-zero note from a template",
      description:
        "Creates a single standard-zero note (e.g. the `06.01 Inbox` slot) from a template classified " +
        '`jd-id: "{{category}}.NN"` in `templates_folder`. Refuses if the slot already exists or no matching ' +
        "template is found. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        folder_path: z.string().describe('Vault path of the category folder (e.g. "10-19 Personal/06 Digital tools").'),
        prefix: z.string().describe('The category\'s two-digit prefix (e.g. "06").'),
        zero_id: z.string().describe('Which standard-zero slot to create (e.g. "01" for Inbox).'),
        templates_folder: z.string().describe("Vault path of the folder containing template notes."),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ folder_path, prefix, zero_id, templates_folder, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(folder_path, settings)) return codedError("out_of_allowlist", `"${folder_path}" is outside the active path allowlist.`);
      if (!isVisible(templates_folder, settings)) return codedError("out_of_allowlist", `"${templates_folder}" is outside the active path allowlist.`);

      const zero = standardZeros(prefix, suffixFor(prefix)).find((z) => z.id === zero_id);
      if (!zero) return codedError("invalid_zero_id", `"${zero_id}" is not one of the 10 standard-zero slots (00-09).`);

      const destPath = destPathForZero(folder_path, prefix, zero);
      if (!isVisible(destPath, settings)) return codedError("out_of_allowlist", `the computed destination for "${zero_id}" is outside the active path allowlist.`);
      if (source.exists(destPath)) return codedError("already_exists", `"${destPath}" already exists.`);

      const discovery = await discoverTemplates(source, settings, templates_folder);
      if (!discovery.ok) return discovery.error;
      const template = findZeroTemplate(discovery.matches, zero.id);
      if (!template) return codedError("template_not_found", `No template classified for zero slot "${zero.id}" in "${templates_folder}".`);

      const folderName = folder_path.includes("/") ? folder_path.slice(folder_path.lastIndexOf("/") + 1) : folder_path;
      const clock = source.clock();
      const context = buildContext({ prefix, id: zero.id, folder: { path: folder_path, name: folderName }, zero, ...clock });
      return applyTemplate(source, settings, template, context, destPath, dry_run, discovery.skipped, ctx.parseYaml);
    }
  );

  server.registerTool(
    "obsidian_jd_new_generic_id",
    {
      title: "Create a generic-id note from a template",
      description:
        'Creates an `XX.YY Title` note from a template classified `jd-id: "{{category}}.{{id}}"` in ' +
        "`templates_folder`. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        folder_path: z.string().describe("Vault path of the category folder."),
        prefix: z.string().describe('The category\'s two-digit prefix (e.g. "06").'),
        id: z.string().describe('Two-digit id for the new note (e.g. "13").'),
        title: z.string().describe("Title for the new note — sanitized before use (no path separators, leading dot, or Windows-forbidden characters)."),
        templates_folder: z.string().describe("Vault path of the folder containing template notes."),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ folder_path, prefix, id, title, templates_folder, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(folder_path, settings)) return codedError("out_of_allowlist", `"${folder_path}" is outside the active path allowlist.`);
      if (!isVisible(templates_folder, settings)) return codedError("out_of_allowlist", `"${templates_folder}" is outside the active path allowlist.`);

      if (!/^\d{2}$/.test(id)) return codedError("invalid_id", `"${id}" must be exactly two digits.`);
      const sanitized = sanitizeTitle(title);
      if (!sanitized) return codedError("invalid_title", `"${title}" is empty, leading-dot, or contains invalid characters (/, \\, .., :, etc.).`);

      const destPath = destPathForGenericId(folder_path, prefix, id, sanitized);
      if (!isVisible(destPath, settings)) return codedError("out_of_allowlist", `the computed destination is outside the active path allowlist.`);
      if (source.exists(destPath)) return codedError("already_exists", `"${destPath}" already exists.`);

      const discovery = await discoverTemplates(source, settings, templates_folder);
      if (!discovery.ok) return discovery.error;
      const template = findGenericTemplate(discovery.matches);
      if (!template) return codedError("template_not_found", `No generic-id template found in "${templates_folder}".`);

      const folderName = folder_path.includes("/") ? folder_path.slice(folder_path.lastIndexOf("/") + 1) : folder_path;
      const clock = source.clock();
      const context = buildContext({ prefix, id, folder: { path: folder_path, name: folderName }, customTitle: sanitized, ...clock });
      return applyTemplate(source, settings, template, context, destPath, dry_run, discovery.skipped, ctx.parseYaml);
    }
  );

  server.registerTool(
    "obsidian_jd_new_stem",
    {
      title: "Create a stem note from a template",
      description:
        'Creates an `XX.00+CODE Name` note from a template classified `jd-id: "XX.00+CODE"` in `templates_folder`. ' +
        "`dry_run: true` reports the plan without writing.",
      inputSchema: {
        folder_path: z.string().describe("Vault path of the category folder."),
        prefix: z.string().describe('The category\'s two-digit prefix (e.g. "06").'),
        stem_code: z.string().describe('The stem code (e.g. "DRAFT" for a template whose jd-id is "XX.00+DRAFT").'),
        name: z.string().describe("Name for the new note — sanitized before use, same rules as a generic-id title."),
        templates_folder: z.string().describe("Vault path of the folder containing template notes."),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ folder_path, prefix, stem_code, name, templates_folder, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(folder_path, settings)) return codedError("out_of_allowlist", `"${folder_path}" is outside the active path allowlist.`);
      if (!isVisible(templates_folder, settings)) return codedError("out_of_allowlist", `"${templates_folder}" is outside the active path allowlist.`);

      // Unlike title/name (sanitizeTitle), stem_code isn't free text — every
      // REAL stem code was already regex-validated at classification time
      // (STEM_ID_RE: leading letter, then word chars/hyphens only, no path
      // separators or dots). Validating it here too, before it ever reaches
      // destPathForStem's string concatenation, closes a narrow but real gap:
      // an unvalidated stem_code containing "/" would introduce EXTRA path
      // segments into the computed destination (destPathForStem doesn't
      // itself sanitize its `code` parameter) before findStemTemplate's own
      // "no such template" refusal ever gets a chance to run.
      if (!/^[A-Za-z][\w-]*$/.test(stem_code)) return codedError("invalid_stem_code", `"${stem_code}" isn't a valid stem code (expected a leading letter, then word characters/hyphens only).`);

      const sanitized = sanitizeTitle(name);
      if (!sanitized) return codedError("invalid_title", `"${name}" is empty, leading-dot, or contains invalid characters (/, \\, .., :, etc.).`);

      const destPath = destPathForStem(folder_path, prefix, stem_code, sanitized);
      if (!isVisible(destPath, settings)) return codedError("out_of_allowlist", `the computed destination is outside the active path allowlist.`);
      if (source.exists(destPath)) return codedError("already_exists", `"${destPath}" already exists.`);

      const discovery = await discoverTemplates(source, settings, templates_folder);
      if (!discovery.ok) return discovery.error;
      const template = findStemTemplate(discovery.matches, stem_code);
      if (!template) return codedError("template_not_found", `No template classified for stem code "${stem_code}" in "${templates_folder}".`);

      const folderName = folder_path.includes("/") ? folder_path.slice(folder_path.lastIndexOf("/") + 1) : folder_path;
      const clock = source.clock();
      const context = buildContext({ prefix, id: `+${stem_code}`, folder: { path: folder_path, name: folderName }, customTitle: sanitized, ...clock });
      return applyTemplate(source, settings, template, context, destPath, dry_run, discovery.skipped, ctx.parseYaml);
    }
  );
}

type DiscoveryResult = { ok: true; matches: TemplateMatch[]; skipped: string[] } | { ok: false; error: ReturnType<typeof codedError> };

/** Reads `templates_folder`'s own direct .md children, classifies each by
 *  its jd-id frontmatter (extractJdId + classifyTemplates, both pure).
 *  Read-boundary containment: a discovered template's OWN path is checked
 *  against the allowlist too, not just the input folder — a hidden template
 *  file's content must never reach a visible note via substitution (the
 *  same class of gap PR review found and fixed on obsidian_jd_reindex_
 *  category's sibling reads; applied here from the start instead). Hidden
 *  templates are silently excluded from discovery, not reported — same
 *  disclosure discipline as every other hidden-content case in this
 *  codebase (absence, not an error naming what's hidden). */
async function discoverTemplates(source: JdScaffoldSource, settings: GuardSettings, templatesFolder: string): Promise<DiscoveryResult> {
  const childPaths = visiblePaths(source.listFolderChildren(templatesFolder), settings);
  if (childPaths.length === 0 && !source.exists(templatesFolder)) {
    return { ok: false, error: codedError("templates_folder_not_found", `Templates folder not found: "${templatesFolder}".`) };
  }
  const candidates = [];
  for (const path of childPaths) {
    const content = await source.read(path);
    if (content === null) continue;
    candidates.push({ path, jdId: extractJdId(content) });
  }
  const { matches, skipped } = classifyTemplates(candidates);
  return { ok: true, matches, skipped };
}

/** Shared apply: read the template, substitute, and either report the
 *  preview (dry_run) or write it (auto-creating the parent folder first,
 *  matching the original's createFromTemplate — source.createFolder is a
 *  no-op-safe call here since destPath's own parent was already implied
 *  visible/checked by the caller). Any unresolved placeholders are surfaced
 *  in the result rather than only console.warn'd. */
async function applyTemplate(
  source: JdScaffoldSource,
  settings: GuardSettings,
  template: TemplateMatch,
  context: ReturnType<typeof buildContext>,
  destPath: string,
  dryRun: boolean,
  skippedTemplates: string[],
  parseYaml: ((yaml: string) => unknown) | undefined
) {
  const raw = await source.read(template.path);
  if (raw === null) return codedError("template_unreadable", `"${template.path}" could not be read.`);
  const { text, warnings } = substitute(raw, context);

  // accept-forbidden guard, PRE-WRITE (same class #79/#172 closed on the
  // other two "create from template" surfaces in this codebase —
  // obsidian_cli's `create template=` and obsidian_create_note_from_template
  // — for the identical reason: a template file's frontmatter would
  // otherwise be copied into a brand-new note with no content scan ever
  // seeing it, a two-step laundering path for an accepted fence). Scanned
  // over `text` — the SUBSTITUTED result, the actual bytes about to be
  // written — not the raw template: this engine's placeholder values
  // (title/tag) are caller-controlled tool arguments, unlike Templater's
  // pre-exec-only concern, so the fence could in principle appear only
  // after substitution, not just in the template's own raw bytes. Checked
  // even under dry_run — a preview must never claim a plan this call would
  // actually refuse to apply.
  //
  // Deliberately `scanForAcceptFence` alone, NOT the full
  // `templateContentAcceptRefusal` (which also runs `templateExpansionRefusal`,
  // refusing any leftover `{{`/`<%` token unconditionally): that half exists
  // because Templater/core-Templates RE-PROCESS `{{ }}`/`<% %>` AFTER the
  // guard's scan, so an unexpanded token is genuinely uninspectable. jd-
  // scaffold's own substitution has ALREADY fully run by this point — `text`
  // IS the final, verbatim bytes about to be written, nothing downstream
  // re-interprets it — so a harmless unresolved `{{typo}}` (this engine's own
  // documented behavior: an unknown key is left as literal text, reported in
  // `warnings`) must not trip a check meant for a DIFFERENT, still-to-be-
  // rendered template engine.
  const acceptRefusal = scanForAcceptFence(text, parseYaml);
  if (acceptRefusal) {
    return codedError(
      "accept_forbidden",
      `refusing to create "${destPath}" from "${template.path}": it ${acceptRefusal}. Acceptance is a human gesture only.`
    );
  }

  if (dryRun) return ok({ dry_run: true, dest_path: destPath, content: text, placeholder_warnings: warnings, skipped_templates: skippedTemplates });

  const parentPath = destPath.slice(0, destPath.lastIndexOf("/"));
  if (parentPath && !source.exists(parentPath)) await source.createFolder(parentPath);
  await source.create(destPath, text);
  return ok({
    dry_run: false,
    dest_path: destPath,
    placeholder_warnings: warnings,
    skipped_templates: skippedTemplates,
    filesChanged: 1,
    files: [destPath],
  });
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
