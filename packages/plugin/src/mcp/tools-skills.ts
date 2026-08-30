// tools-skills.ts — the vault-skills module's tool surface, folded into
// vault-mcp (cycle 2 of #82). Six tools:
//
//   vault_skills_validate — collect + transform, report errors/warnings/counts (read-only)
//   vault_skills_tree     — the agent/skill hierarchy (read-only)
//   vault_skills_preview  — the compiled output diffed against the export dir (read-only)
//   vault_skills_export   — materialize the Claude Code plugin to disk (mutating)
//   vault_skills_release  — export into a repo dir + stamp a version (mutating)
//   vault_skills_mark     — mark a note skill/agent/policy/command in its frontmatter (mutating)
//
// The three read tools compile the vault through the pure exporter core
// (kernel/skills/*, Obsidian-free over an injected SkillsSource). The export
// product stays MATERIALIZE-TO-DISK — the tool triggers a write to the
// configured output dir; Claude Code loads the skills off disk. That contract
// is unchanged from the standalone plugin.
//
// ── The one load-bearing security requirement (accept guard) ─────────────────
//
// `vault_skills_mark` writes note frontmatter, so it MUST route through the
// plugin's accept-forbidden guard like every other vault write: a skills-mark
// can NOT introduce or change an `accepted` / `accepted-by` / `accepted-on`
// field, or set `acceptance-status` to an accepted value. Acceptance is a
// human gesture only, in no API. This module contributes NO accept/approve
// tool (the ModuleRegistry name tripwire refuses those regardless), and the
// mark path runs the SAME `acceptTransitionReason` predicate the fs / Obsidian
// write primitives use (@vault-mcp/core), in `guardSkillsMark` below — pinned
// by tests/skills-module.test.mjs.
//
// Obsidian-free by construction: vault state arrives through the injected
// SkillsBackend (structurally typed, like VocabSource / LinkSource), so every
// handler and the mark guard are unit-testable headlessly. The Obsidian
// adapter is `obsidianSkillsBackend(app)` — the only vault coupling for skills.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AcceptForbiddenError, acceptTransitionReason } from "@vault-mcp/core";
import { ok, fail } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import {
  analyzeVault,
  previewVault,
  runExport,
  readPluginVersion,
  markFrontmatter,
  applyMark,
  skillsConfigOf,
  fieldsOf,
  expandTilde,
  type DetectConfig,
  type EmbedLookup,
  type MarkInput,
  type MarkResult,
  type SkillsSource,
  type SourceNote,
} from "../kernel/skills/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** The write half of the skills backend — what `vault_skills_mark` needs on
 * top of the read-only SkillsSource. Kept structural (no `obsidian` import) so
 * the handler stays headless-testable against a fake. */
export interface SkillsWriter {
  /** The note's current frontmatter (metadata cache), or null when it has none
   * / is absent — the BEFORE the accept-transition guard compares against. */
  frontmatterOf(path: string): Record<string, unknown> | null;
  /** True when a file exists at this vault-relative path. */
  exists(path: string): boolean;
  /** Apply a mutator to the note's frontmatter (Obsidian processFrontMatter). */
  applyFrontmatter(path: string, mutate: (fm: Record<string, unknown>) => void): Promise<void>;
}

/** The full backend the skills tools drive: the exporter's read seam plus the
 * mark write primitive. */
export type SkillsBackend = SkillsSource & SkillsWriter;

export interface SkillsToolsCtx {
  /** The merged `modules.skills.config` (defaults ∪ user override), as
   * `register()` receives it — resolved per connection like the module's
   * enabled state. */
  config: Record<string, unknown>;
  /** The guard's settings — the allowlist filter for the read/compile tools.
   * Absent ⇒ unfiltered. */
  getSettings?: () => GuardSettings;
}

/** The Obsidian adapter — the ONLY vault coupling for skills in vault-mcp.
 * Duck-typed against `app` (no `obsidian` import), like `obsidianVocabSource`
 * / `obsidianLinkSource`, so this file stays headless-testable. */
export function obsidianSkillsBackend(app: {
  vault: {
    getMarkdownFiles(): Array<{ path: string; extension?: string }>;
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
    // `unknown` (narrowed in basePath) rather than a structural shape: an
    // all-optional `{ getBasePath?: () => string }` is a WEAK type TS refuses
    // to match against Obsidian's DataAdapter (no shared properties).
    adapter?: unknown;
  };
  metadataCache: {
    getFirstLinkpathDest(linkpath: string, from: string): { path: string; extension: string } | null;
    getFileCache(file: unknown): { frontmatter?: Record<string, unknown> } | null;
    getCache(path: string): { frontmatter?: Record<string, unknown> } | null;
  };
  fileManager: { processFrontMatter(file: unknown, fn: (fm: Record<string, unknown>) => void): Promise<void> };
}): SkillsBackend {
  const embed: EmbedLookup = async (linkpath, fromPath) => {
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, fromPath);
    if (!dest || dest.extension !== "md") return null;
    return { path: dest.path, content: await app.vault.cachedRead(dest) };
  };
  return {
    async notes(): Promise<SourceNote[]> {
      const out: SourceNote[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
        const body = frontmatter ? await app.vault.cachedRead(file) : "";
        out.push({ path: file.path, frontmatter, body });
      }
      return out;
    },
    resolveLink(linkpath, fromPath) {
      const dest = app.metadataCache.getFirstLinkpathDest(linkpath, fromPath);
      return dest ? dest.path : null;
    },
    embed,
    basePath() {
      const adapter = app.vault.adapter as { getBasePath?: () => string } | undefined;
      return typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : null;
    },
    frontmatterOf(path) {
      return app.metadataCache.getCache(path)?.frontmatter ?? null;
    },
    exists(path) {
      const f = app.vault.getAbstractFileByPath(path);
      return !!f && typeof f === "object" && "extension" in (f as object);
    },
    async applyFrontmatter(path, mutate) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error(`not found: ${path}`);
      await app.fileManager.processFrontMatter(file, mutate);
    },
  };
}

/**
 * The accept-forbidden guard for `vault_skills_mark`, pure and headless.
 *
 * Computes the frontmatter the mark WOULD land (BEFORE with the mark applied)
 * and runs the shared `acceptTransitionReason` predicate: a mark that
 * introduces or changes an `accepted`-family key, or sets `acceptance-status`
 * to an accepted value the note did not already hold, throws
 * `AcceptForbiddenError` — nothing is written. Carrying an existing
 * human-granted accepted value forward UNCHANGED is allowed (the same
 * transition rule ObsidianBackend's write primitive applies). Returns the
 * MarkResult to apply when the transition is clean.
 */
export function guardSkillsMark(
  before: Record<string, unknown>,
  input: MarkInput,
  fields: DetectConfig,
): MarkResult {
  const result = markFrontmatter(input, fields);
  // Clone BEFORE so computing the after-image never mutates the caller's
  // frontmatter (applyMark reassigns `tags` and Object.assigns `set`).
  const after: Record<string, unknown> = {
    ...before,
    ...(Array.isArray(before.tags) ? { tags: [...(before.tags as unknown[])] } : {}),
  };
  applyMark(after, result);
  const reason = acceptTransitionReason(before, after);
  if (reason) throw new AcceptForbiddenError(reason);
  return result;
}

export function registerSkillsTools(server: McpServer, source: SkillsBackend, ctx: SkillsToolsCtx): void {
  // Config is resolved per connection (like the module's enabled state); the
  // read/compile tools then run over the whole vault the compile requires.
  const cfg = skillsConfigOf(ctx.config);
  const fields = fieldsOf(cfg);

  server.registerTool(
    "vault_skills_validate",
    {
      title: "Validate the vault-skills tree",
      description:
        "Collect skill/agent/policy/command notes and run the transform without writing. Returns errors, warnings, " +
        "counts, multi-parent attachments (first parent is primary, the rest are recorded attachments), and each " +
        "agent's preload set — the `skills:` frontmatter the export would emit, which preloads content rather than " +
        "restricting access. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const a = await analyzeVault(source, fields, cfg.pluginName, cfg.preloadCap);
        return ok({
          ok: a.errors.length === 0, errors: a.errors, warnings: a.warnings, counts: a.counts,
          attachments: a.attachments, preloads: a.preloads, preloadCap: a.preloadCap,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vault_skills_tree",
    {
      title: "Show the vault-skills tree",
      description:
        "Return the current agent/skill hierarchy (name, kind, primary parent, level, owned skills, children, plus " +
        "any extra-parent attachments and preload flags). Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const a = await analyzeVault(source, fields, cfg.pluginName, cfg.preloadCap);
        return ok({ tree: a.tree, counts: a.counts, attachments: a.attachments, preloads: a.preloads });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vault_skills_preview",
    {
      title: "Preview the compiled plugin output",
      description:
        "Run the transform without writing and diff it against the current export. No args: a manifest of every file " +
        "the export would write plus removed files, diff counts, and policy placements. `name`: return one entry " +
        "(matched by generated name, output path, or source note path) with its full compiled content. `content: " +
        "true`: include full compiled content for every entry (large). Read-only.",
      inputSchema: {
        name: z.string().optional().describe("Generated name, output path, or source note path of one entry to return in full."),
        content: z.boolean().optional().describe("Include full compiled content for every entry (large)."),
      },
      annotations: RO,
    },
    async ({ name, content }) => {
      try {
        const p = await previewVault(source, {
          outputDir: expandTilde(cfg.outputDir), pluginName: cfg.pluginName, fields, preloadCap: cfg.preloadCap,
        });
        const summary = {
          diff: p.diff, removed: p.removed, policies: p.policies,
          attachments: p.attachments, preloads: p.preloads, preloadCap: p.preloadCap,
          errors: p.errors, warnings: p.warnings, counts: p.counts,
          outputDir: p.outputDir, assetsNote: p.assetsNote,
        };
        // THE COMPILE is whole-vault and must stay that way (parent edges span
        // the tree, so a partial compile produces a broken plugin). What must
        // NOT be whole-vault is the CONTENT this hands back: an entry's
        // `content` is the compiled body of its SOURCE NOTE, so returning it
        // for a note outside the caller's allowlist is the same read-boundary
        // leak `obsidian_search_notes` once had. Manifest rows stay — they are
        // structure, and the counts have to add up — but bodies are filtered.
        const settings = ctx.getSettings?.();

        // A compiled entry's `content` is ASSEMBLED, not copied — so checking
        // the entry's own `from` is not enough, and the first version of this
        // filter got that wrong. Three notes can contribute bytes to one body:
        //
        //   1. the entry's own source note (`from`);
        //   2. every note it TRANSCLUDES — `![[Other]]` inlines that note's
        //      stripped body verbatim, and those paths are collected in
        //      `sources`;
        //   3. every `type: policy` note injected into an AGENT's definition —
        //      the policy's full body is appended, and the policy's path is
        //      NOT in `sources`. `p.policies` records which genNames each
        //      policy landed in, which is the only place that edge is visible.
        //
        // So a sandboxed session could author a visible note transcluding a
        // hidden one, or park a policy at a hidden path under a visible agent,
        // and read the hidden bytes straight back out of the compiled body.
        // All three contributors must be visible before a body is returned.
        //
        // `(static)` is the exporter's marker for its own compiled-in files
        // (exporter.ts) — not a vault path, so it can never be "visible", and
        // treating it as a real path silently made the plugin's own shipped
        // content unpreviewable under any allowlist.
        const pathVisible = (path: string | undefined): boolean =>
          !settings || !path || path === "(static)" || isVisible(path, settings);

        // genNames whose compiled body carries a policy from outside the allowlist.
        const tainted = new Set<string>();
        for (const pol of p.policies ?? []) {
          if (!pathVisible(pol.path)) for (const a of pol.agents ?? []) tainted.add(a);
        }

        const sourceVisible = (e: { from?: string; name?: string; sources?: string[] }): boolean =>
          pathVisible(e.from) &&
          (e.sources ?? []).every(pathVisible) &&
          !(e.name !== undefined && tainted.has(e.name));

        if (name) {
          const entry = p.entries.find((x) => x.name === name || x.relOut === name || x.from === name);
          // A hidden source reads as NOT FOUND rather than refused, matching how
          // uid/scheme addressing decides (0 visible candidates ⇒ unresolved):
          // a distinct "forbidden" answer would confirm the note exists.
          if (!entry || !sourceVisible(entry)) {
            return fail(new Error(`no preview entry matches "${name}" — try a generated name, output path, or source note path`));
          }
          return ok({ entry, ...summary });
        }
        const entries = p.entries.map((e) => {
          const { cachedContent: _cached, content: full, ...rest } = e;
          return content && sourceVisible(e) ? { ...rest, content: full } : rest;
        });
        return ok({ entries, ...summary });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vault_skills_export",
    {
      title: "Export the Claude Code plugin",
      description:
        "Write skills/agents to the configured output dir. Then run /reload-plugins in Claude Code to load. Mutating.",
      inputSchema: {},
      annotations: RW,
    },
    async () => {
      try {
        const summary = await runExport(source, {
          outputDir: expandTilde(cfg.outputDir), pluginName: cfg.pluginName, fields,
          assetsRoot: expandTilde(cfg.assetsRoot), preloadCap: cfg.preloadCap,
        });
        return ok({
          skills: summary.skills, agents: summary.agents, commands: summary.commands,
          assets: summary.assets, removed: summary.removed,
          errors: summary.errors, warnings: summary.warnings, outputDir: summary.outputDir,
          note: "Run /reload-plugins in Claude Code to load the changes.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vault_skills_release",
    {
      title: "Package a versioned release into a repo",
      description:
        "Export the full plugin into a git checkout (the configured release repo dir, or an explicit dir) and stamp " +
        "the given version into .claude-plugin/plugin.json. Does not commit, tag, or push. Mutating.",
      inputSchema: {
        version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Release version (semver, e.g. 1.2.0)."),
        dir: z.string().optional().describe("Target repo directory; defaults to the release repo dir from settings."),
      },
      annotations: RW,
    },
    async ({ version, dir }) => {
      try {
        const releaseDir = expandTilde(dir ?? cfg.releaseDir);
        if (!releaseDir) return fail(new Error("no release dir: pass `dir` or set the release repo directory in the skills module config"));
        const previous = readPluginVersion(releaseDir) ?? null;
        const summary = await runExport(source, {
          outputDir: releaseDir, pluginName: cfg.pluginName, fields,
          assetsRoot: expandTilde(cfg.assetsRoot), version, preloadCap: cfg.preloadCap,
        });
        return ok({
          version, previous,
          skills: summary.skills, agents: summary.agents, commands: summary.commands,
          assets: summary.assets, removed: summary.removed,
          errors: summary.errors, warnings: summary.warnings, outputDir: summary.outputDir,
          note: "Packaged only — commit & tag in the repo to publish.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vault_skills_mark",
    {
      title: "Mark a note as skill / agent / policy / command",
      description:
        "Mark an existing note as a skill/agent/policy/command, honoring the vault's detection mode: in frontmatter " +
        "mode it sets the `type` field; in tags mode it appends the configured kind tag. Parent/description are " +
        "written as frontmatter either way (commands are flat — any parent is ignored and a stale one is cleared). " +
        "Does not create the note. Mutating — and, like every write, it can never set an acceptance field.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note to mark."),
        type: z.enum(["skill", "agent", "policy", "command"]),
        parent: z.string().optional().describe("Parent agent basename or [[wikilink]]; omit for root. Ignored for commands."),
        description: z.string().optional(),
      },
      annotations: RW,
    },
    async ({ path: p, type, parent, description }) => {
      try {
        if (!source.exists(p)) return fail(new Error(`not found: ${p}`));
        const before = source.frontmatterOf(p) ?? {};
        // Accept-forbidden guard: refuses a mark whose resulting frontmatter
        // would introduce/change an acceptance assertion — nothing is written.
        const result = guardSkillsMark(before, { type, parent, description }, fields);
        await source.applyFrontmatter(p, (fm) => applyMark(fm, result));
        return ok({ marked: p, type, parent: parent ?? null });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // THE COMPILE is whole-vault and stays that way: parent edges span the tree,
  // so a partial compile produces a broken plugin. `validate` and `tree` return
  // structural summaries over that whole-vault compile and are unfiltered by
  // design — they name paths, they do not return note bodies.
  //
  // `preview` is the one that returns CONTENT, and since 2026-08-29 it filters
  // bodies by the source note's visibility. Before that it did not, and
  // `ctx.getSettings` sat on the context declared-but-never-called while
  // `{name: "<any source note path>"}` returned that note's full compiled body
  // regardless of the allowlist — the same shape as the `obsidian_search_notes`
  // leak that motivated the read-boundary sweep. If you add another tool here
  // that returns bodies, filter it the same way; if it returns only structure,
  // it does not need to.
  //
  // The mutating surface is gated separately: export / release are
  // read-only-mode-blocked, and `vault_skills_mark` is path-scoped +
  // accept-guarded at the interception point.
}
