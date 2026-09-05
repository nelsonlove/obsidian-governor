// The skills GUI wiring — the in-Obsidian HUMAN surface: the Preview pane, the six commands,
// the ribbon icon, and the (opt-in) export-on-save trigger. Written for the standalone
// vault-skills plugin, folded into the Governor host (#82 residuals), and extracted back into
// this satellite at the suite split's S4. `wireSkills(plugin, deps)` is called ONCE from
// main.ts's onload — UNCONDITIONALLY now, because this plugin being installed and enabled IS
// the toggle. There is no host module flag to consult any more.
//
// THIS HALF WORKS WITH NO HOST INSTALLED. The pane, the commands, the ribbon and export-on-save
// are pure Obsidian + the compiler core; nothing here touches vault-mcp-api. If Governor is
// absent, all of this still runs and only the six MCP tools go unpublished — which is the
// standalone-operation promise in the README, expressed in code rather than in prose.
//
// The agent-facing surface (the six tool specs in tools.ts) shares the one compiler core with
// this pane (`previewVault` / `analyzeVault` / `runExport` in ./kernel), so the GUI and the
// tools can never disagree about the same vault.
//
// ── What routes through the guarded core ─────────────────────────────────────
// The mutating command `mark` writes note frontmatter through `guardSkillsMark` — the SAME
// accept-forbidden guard the `vault_skills_mark` tool uses (see commands.ts). `export` /
// `release` call `runExport` directly — the exact function the tools call — materializing to a
// disk dir outside the vault (no note frontmatter touched, so no accept guard needed). Nothing
// here reimplements a write or bypasses the mark guard. Extraction changed none of that: the
// accept predicate is `acceptTransitionReason` from @vault-mcp/core, a published contract, so
// leaving the host did not leave the guard behind.
//
// Everything registered is torn down by Obsidian's own registerX cleanup on unload; the one
// thing that isn't (the export-on-save debounce timer) is cancelled by a `plugin.register`
// hook, and its callback is gated on a `disposed` flag so a queued export can't fire against a
// torn-down plugin.

import { Notice, type Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
import {
  previewVault,
  runExport,
  skillsConfigOf,
  fieldsOf,
  expandTilde,
  type SkillsConfig,
  type PreviewResult,
} from "./kernel/index.js";
import { obsidianSkillsBackend, type SkillsBackend } from "./tools.js";
import { SkillsPreviewView, SKILLS_PREVIEW_VIEW_TYPE, SKILLS_EXPORTED_EVENT, type SkillsPreviewController } from "./pane.js";
import { cmdValidate, cmdTree, cmdMark, cmdRelease, type SkillsGuiCtx } from "./commands.js";
import { debounce, handleNoteChanged, type Debounced } from "./export-trigger.js";

const EXPORT_ON_SAVE_DEBOUNCE_MS = 750;

/** What wireSkills needs beyond the base Plugin surface: a reader for this plugin's own config
 * record (settings.ts's `config`, which carries the same keys the host's
 * `modules.skills.config` did), from which the typed SkillsConfig (output dir, plugin name,
 * detection mode, exportOnSave, …) is derived per read. Plain data — read per call, so a change
 * in the settings tab lands without a plugin reload. */
export interface SkillsWireDeps {
  getConfig: () => Record<string, unknown>;
}

/**
 * Wire the skills GUI into this plugin. Called ONCE from onload. Additive: it leaves the
 * published tool surface and the compiler core untouched, and needs no host.
 */
export function wireSkills(plugin: Plugin, deps: SkillsWireDeps): void {
  const app = plugin.app;
  const backend: SkillsBackend = obsidianSkillsBackend(app);
  const config = (): SkillsConfig => skillsConfigOf(deps.getConfig());

  // Shared export state — one in-flight guard and the transcluded-source set, shared by the
  // command, the ribbon, and export-on-save (exactly as the standalone plugin shared them).
  let exporting = false;
  let exportSources = new Set<string>();

  // Single export path. `quiet` shortens the success Notice (export-on-save fires often).
  const exportNow = async (quiet = false): Promise<void> => {
    // Concurrency guard: a change arriving mid-export isn't lost — the export-on-save trigger
    // re-arms itself while `exporting` is true (see below).
    if (exporting) return;
    exporting = true;
    try {
      const cfg = config();
      const summary = await runExport(backend, {
        outputDir: expandTilde(cfg.outputDir),
        pluginName: cfg.pluginName,
        fields: fieldsOf(cfg),
        assetsRoot: expandTilde(cfg.assetsRoot),
        preloadCap: cfg.preloadCap,
      });
      exportSources = new Set(summary.sources);

      const issue = (label: string, items: string[]) =>
        items.length ? `\n${items.length} ${label}: ${items[0]}${items.length > 1 ? " …" : ""}` : "";
      new Notice(
        `Vault Skills: exported ${summary.skills} skill(s) + ${summary.agents} agent(s)` +
          (summary.commands ? ` + ${summary.commands} command(s)` : "") +
          (summary.removed ? `, removed ${summary.removed}` : "") +
          issue("error(s)", summary.errors) +
          issue("warning(s)", summary.warnings) +
          `\nRun /reload-plugins in Claude Code to load.`,
        quiet ? 4000 : summary.errors.length ? 12000 : 8000,
      );
      // Let an open Preview pane re-diff against the fresh output (the output dir emits no
      // vault events). Only the GUI export path fires this — an MCP-triggered export runs in
      // another process and can't.
      app.workspace.trigger(SKILLS_EXPORTED_EVENT);
    } catch (e) {
      new Notice(`Vault Skills: export failed — ${e instanceof Error ? e.message : String(e)}`, 10000);
    } finally {
      exporting = false;
    }
  };

  const ctx: SkillsGuiCtx = { app, backend, config, exportNow };

  // ── Preview pane ───────────────────────────────────────────────────────────
  const controller: SkillsPreviewController = {
    compile: (): Promise<PreviewResult> => {
      const cfg = config();
      return previewVault(backend, { outputDir: expandTilde(cfg.outputDir), pluginName: cfg.pluginName, fields: fieldsOf(cfg), preloadCap: cfg.preloadCap });
    },
    fields: () => fieldsOf(config()),
  };
  plugin.registerView(SKILLS_PREVIEW_VIEW_TYPE, (leaf) => new SkillsPreviewView(leaf, controller));

  const activatePreview = async (): Promise<void> => {
    // Reuse an existing preview leaf; otherwise open one in the main pane (the compiled corpus
    // is full-width content, not sidebar content).
    const existing = app.workspace.getLeavesOfType(SKILLS_PREVIEW_VIEW_TYPE);
    const leaf: WorkspaceLeaf = existing[0] ?? app.workspace.getLeaf(true);
    await leaf.setViewState({ type: SKILLS_PREVIEW_VIEW_TYPE, active: true });
    app.workspace.revealLeaf(leaf);
  };

  // ── Ribbon + commands ──────────────────────────────────────────────────────
  // Ribbon triggers an export (matching the standalone plugin's ribbon). A ribbon click is a
  // genuine user gesture; export touches no acceptance state, so it needs no gesture gate.
  plugin.addRibbonIcon("sync", "Export vault skills to Claude Code", () => void exportNow());

  plugin.addCommand({ id: "skills-export", name: "Skills: export skills & agents to Claude Code", callback: () => void exportNow() });
  plugin.addCommand({ id: "skills-validate", name: "Skills: validate tree", callback: () => void cmdValidate(ctx) });
  plugin.addCommand({ id: "skills-tree", name: "Skills: show tree", callback: () => void cmdTree(ctx) });
  plugin.addCommand({ id: "skills-mark", name: "Skills: mark note as skill / agent / policy / command", callback: () => void cmdMark(ctx) });
  plugin.addCommand({ id: "skills-release", name: "Skills: export release to repo", callback: () => void cmdRelease(ctx) });
  plugin.addCommand({ id: "skills-preview", name: "Skills: preview compiled output", callback: () => void activatePreview() });

  // ── Export-on-save (opt-in) ────────────────────────────────────────────────
  // Re-export when a skill/agent/policy/command note (or a transcluded source note) changes.
  // Debounced so a rename's burst of change events (the file rename plus cascaded [[wikilink]]
  // rewrites in child notes) collapses into ONE export against the settled tree — exporting
  // mid-burst would validate half-rewritten parent links and drop children with spurious
  // "unresolved parent" errors (see export-trigger.ts). The single gate re-checks the setting
  // at fire time (it may be toggled off during the debounce window) and, if an export is
  // already in flight, re-arms itself so the change isn't lost.
  let disposed = false;
  let requestExport: Debounced | null = null;
  requestExport = debounce(() => {
    if (disposed || !config().exportOnSave) return;
    if (exporting) { requestExport?.(); return; }
    void exportNow(true);
  }, EXPORT_ON_SAVE_DEBOUNCE_MS);

  plugin.registerEvent(
    app.metadataCache.on("changed", (file) =>
      handleNoteChanged(file, {
        isEnabled: () => config().exportOnSave,
        fields: () => fieldsOf(config()),
        getFrontmatter: (f) => app.metadataCache.getFileCache(f as TFile)?.frontmatter as Record<string, unknown> | undefined,
        requestExport: () => requestExport?.(),
        isSource: (p) => exportSources.has(p),
      }),
    ),
  );

  // Drop any pending export-on-save on unload so it can't fire against a torn-down plugin;
  // flip `disposed` so a debounce callback already scheduled becomes a no-op.
  plugin.register(() => {
    disposed = true;
    requestExport?.cancel();
  });
}
