// tools-survey.ts — the survey module's tool surface: two tools over the
// pure kernel/survey/* core.
//
//   obsidian_survey_status — staleness of a note's filesystem-mirror slot (read-only)
//   obsidian_survey_slot   — regenerate the "## Contents (Filesystem)" section;
//                            dry-run by default, `apply: true` persists (MUTATING)
//
// Folded in from the standalone `obsidian-jd-survey` plugin (2026-08-19),
// scoped down: this v1 assumes the mirror directory is the SAME relative path
// under a configured `mirrorRoot` as the note's own vault-relative folder —
// deliberately simpler than coupling to kernel/scheme's JD area/category
// model, and per-note `survey-mirror` frontmatter overrides that default when
// it's wrong (see resolveMirrorDir below). "Assume a mirrored filesystem" was
// the explicit brief; tighter scheme-coupling was considered and dropped as
// unneeded complexity for that brief.
//
// Cannot register obsidian_survey_slot through modules-mount.ts: that host's
// `registerAll` gate refuses any tool whose `annotations.readOnlyHint !==
// true` (see tools-scheme-write.ts's identical note). Both tools here
// register directly in server.ts for one cohesive module, though
// obsidian_survey_status alone could in principle go through the module host
// — a reasonable follow-up once this shape is in use, not forced into v1.
//
// Prose generation (askClaude) is optional per call (`generate_prose`) and is
// never on the read path — a status check never spawns a subprocess.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import * as fs from "node:fs";
import { ok, fail, codedError } from "./helpers.js";
import { visiblePaths, type GuardSettings } from "../guard.js";
import { walk, type DirEntry } from "../kernel/survey/walk.js";
import { staleness, type SurveyStamp } from "../kernel/survey/staleness.js";
import { planSection } from "../kernel/survey/section.js";
import { askClaude } from "../kernel/survey/ask-claude.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export interface SurveyToolsCtx {
  notes: () => string[];
  getSettings?: () => GuardSettings;
}

/** Production DirLister: real fs, `withFileTypes` so isDirectory is free. */
function realList(path: string): DirEntry[] {
  return fs.readdirSync(path, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
}

/** The mirror directory for `notePath`, honoring a `survey-mirror`
 *  frontmatter override before falling back to the same-relative-path
 *  default. Returns null if neither yields an existing directory. */
function resolveMirrorDir(app: App, notePath: string, mirrorRoot: string): string | null {
  const file = app.vault.getAbstractFileByPath(notePath);
  const fm = file instanceof TFile ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
  const override = fm?.["survey-mirror"];
  const candidate =
    typeof override === "string" && override.trim() ? override.trim() : `${mirrorRoot}/${notePath.replace(/\/[^/]+$/, "")}`;
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

export function registerSurveyTools(server: McpServer, app: App, ctx: SurveyToolsCtx): void {
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());
  const outOfAllowlist = (path: string) => codedError("out_of_allowlist", `"${path}" is not visible to this session.`);
  const notMd = (path: string) => (path.endsWith(".md") ? null : fail(new Error("path must end in .md")));

  server.registerTool(
    "obsidian_survey_status",
    {
      title: "Check staleness of a note's filesystem-mirror survey",
      description:
        "Walk the filesystem directory a note's `## Contents (Filesystem)` section is meant to summarize, and " +
        "report whether that section is stale relative to what's actually there now. Read-only — does not touch " +
        "the note or the mirror directory. The mirror directory defaults to the same relative path under " +
        "`mirror_root` as the note's own vault folder; a note's own `survey-mirror` frontmatter overrides that " +
        "when the mirror doesn't follow the default layout.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to check."),
        mirror_root: z.string().min(1).describe("Absolute filesystem path the vault's folder tree is mirrored under."),
        depth: z.number().int().min(0).max(6).default(1).describe("How many directory levels deep to count, 0 = immediate children only."),
      },
      annotations: RO,
    },
    async ({ path, mirror_root, depth }) => {
      try {
        const mdError = notMd(path);
        if (mdError) return mdError;
        if (visible([path]).length === 0) return outOfAllowlist(path);

        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return codedError("not_found", `"${path}" does not exist.`);

        const mirrorDir = resolveMirrorDir(app, path, mirror_root);
        if (!mirrorDir) return codedError("mirror_not_found", `No mirror directory found for "${path}" under "${mirror_root}".`);

        const result = walk(mirrorDir, depth, realList);
        const stamp = app.metadataCache.getFileCache(file)?.frontmatter?.survey as SurveyStamp | undefined;
        const stale = staleness(result, depth, stamp);

        return ok({ mirror_dir: mirrorDir, items: result.items, stubs: result.stubs, depth_reached: result.depthReached, ...stale });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_survey_slot",
    {
      title: "Regenerate a note's Contents (Filesystem) section from its mirror directory",
      description:
        "Walk the note's filesystem-mirror directory and write (or refresh) its `## Contents (Filesystem)` " +
        "section, stamping `survey:` frontmatter (`at`, `items`, `depth`, `by`) so future calls can tell whether " +
        "it's still current. Refuses to touch a section last stamped `by: \"claude-code\"` or `by: \"human\"` " +
        "unless `force: true` — that stamp means someone deliberately wrote prose there, not a placeholder. " +
        "`generate_prose: true` asks a headless Claude Code call (subscription-billed, no API key involved) for " +
        "the section body instead of a bare item-count skeleton; omit for the skeleton. `apply: false` (default) " +
        "reports the plan without writing. Mutating when `apply: true`.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to survey."),
        mirror_root: z.string().min(1).describe("Absolute filesystem path the vault's folder tree is mirrored under."),
        depth: z.number().int().min(0).max(6).default(1).describe("How many directory levels deep to count."),
        generate_prose: z.boolean().default(false).describe("Ask Claude for prose instead of a bare skeleton."),
        force: z.boolean().default(false).describe("Overwrite a section protected by a prior human/claude-code stamp."),
        apply: z.boolean().describe("If true, write the change. If false, report the plan only."),
      },
      annotations: RW,
    },
    async ({ path, mirror_root, depth, generate_prose, force, apply }) => {
      try {
        const mdError = notMd(path);
        if (mdError) return mdError;
        if (visible([path]).length === 0) return outOfAllowlist(path);

        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return codedError("not_found", `"${path}" does not exist.`);

        const mirrorDir = resolveMirrorDir(app, path, mirror_root);
        if (!mirrorDir) return codedError("mirror_not_found", `No mirror directory found for "${path}" under "${mirror_root}".`);

        const walked = walk(mirrorDir, depth, realList);
        const currentFm = app.metadataCache.getFileCache(file)?.frontmatter;
        const stampBy = (currentFm?.survey as SurveyStamp | undefined)?.by;
        const stampByStr = typeof stampBy === "string" ? stampBy : undefined;

        let snapshotBody: string;
        let by: "skeleton" | "claude-code" = "skeleton";
        if (generate_prose) {
          const prompt =
            `Write 2-4 sentences summarizing the contents of this directory for a knowledge-base note. ` +
            `${walked.items} item(s), ${walked.stubs} empty subfolder(s) found. ` +
            `Directory: ${mirrorDir}. Plain prose, no heading, no preamble.`;
          const reply = await askClaude(prompt, { maxTurns: 1 });
          snapshotBody = reply.text.trim();
          by = "claude-code";
        } else {
          snapshotBody = `> [!info] Filesystem snapshot\n> ${walked.items} item(s), ${walked.stubs} empty subfolder(s), depth ${walked.depthReached}.`;
        }

        const currentBody = await app.vault.read(file);
        const plan = planSection(currentBody, snapshotBody, stampByStr, force);

        if (plan.kind === "protected") {
          return codedError(
            "section_protected",
            `"## Contents (Filesystem)" in "${path}" was last stamped by "${plan.protectedBy}" — pass force: true to overwrite.`
          );
        }

        if (!apply) {
          return ok({ apply: false, plan_kind: plan.kind, items: walked.items, stubs: walked.stubs, by });
        }

        await app.vault.process(file, () => plan.newBody as string);
        await app.fileManager.processFrontMatter(file, (front) => {
          front.survey = { at: new Date().toISOString(), items: walked.items, depth, by };
        });

        return ok({ apply: true, plan_kind: plan.kind, items: walked.items, stubs: walked.stubs, by, filesChanged: 1, files: [path] });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
