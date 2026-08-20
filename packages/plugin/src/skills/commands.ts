// The skills GUI commands — validate / tree / mark / release, plus the shared modals and the
// version-bump helper. Ported from the standalone vault-skills plugin (obsidian/src/commands.ts)
// as part of the GUI fold (#82 residuals), refactored to take a plain `SkillsGuiCtx` instead of
// the whole plugin so the pure helpers (`bumpPatch`) stay unit-testable.
//
// ── Routing through the guarded core (load-bearing) ──────────────────────────
// These are HUMAN gestures in Obsidian, not MCP calls, so they don't ride the MCP transport's
// per-connection guard/queue/journal. But the ONE security-critical path — `cmdMark`, which
// writes note frontmatter — routes through the SAME accept-forbidden guard the MCP
// `vault_skills_mark` tool uses (`guardSkillsMark` in mcp/tools-skills.ts, which runs the
// shared `acceptTransitionReason` predicate). A mark that would introduce/change an
// acceptance assertion throws and nothing is written. `cmdValidate`/`cmdTree` are read-only;
// `cmdRelease` calls the folded `runExport` core directly (the exact function the MCP
// `vault_skills_release` tool calls), which materializes to a disk dir outside the vault and
// touches no note frontmatter, so it needs no accept guard.

import { App, FuzzySuggestModal, Modal, Notice, Setting } from "obsidian";
import { AcceptForbiddenError } from "@vault-mcp/core";
import {
  analyzeVault,
  applyMark,
  runExport,
  readPluginVersion,
  fieldsOf,
  expandTilde,
  type MarkInput,
  type SkillsConfig,
} from "../kernel/skills/index.js";
import { guardSkillsMark, type SkillsBackend } from "../mcp/tools-skills.js";
import { bumpPatch } from "./version.js";

/** What the skills commands need: the Obsidian app (active file + frontmatter writes via the
 *  backend), the folded skills backend (the exporter read seam + the mark write primitive),
 *  the current typed config, and the shared export path (also used by the ribbon and
 *  export-on-save) so `cmdExport` and the ribbon run the exact same export. */
export interface SkillsGuiCtx {
  app: App;
  backend: SkillsBackend;
  config: () => SkillsConfig;
  exportNow: (quiet?: boolean) => Promise<void>;
}

const base = (p: string): string => (p.split("/").pop() ?? "").replace(/\.md$/, "");

/** Simple scrollable text modal for validate/tree output. */
class TextModal extends Modal {
  constructor(app: App, private titleText: string, private lines: string[]) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("pre", { text: this.lines.join("\n") });
  }
  onClose(): void { this.contentEl.empty(); }
}

/** Single-line text prompt (resolves undefined if dismissed). */
export function promptText(app: App, title: string, initial: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let submitted: string | undefined;
    class P extends Modal {
      onOpen(): void {
        this.titleEl.setText(title);
        let value = initial;
        new Setting(this.contentEl).addText((t) => {
          t.setValue(initial).onChange((v) => { value = v; });
          t.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { submitted = value.trim(); this.close(); }
          });
          t.inputEl.focus();
          t.inputEl.select();
        });
        new Setting(this.contentEl).addButton((b) =>
          b.setButtonText("OK").setCta().onClick(() => { submitted = value.trim(); this.close(); }),
        );
      }
      onClose(): void { this.contentEl.empty(); resolve(submitted); }
    }
    new P(app).open();
  });
}

/** Promise-wrapped fuzzy picker (resolves undefined if dismissed). */
export function pick<T>(app: App, items: T[], label: (t: T) => string): Promise<T | undefined> {
  return new Promise((resolve) => {
    let chosen: T | undefined;
    class S extends FuzzySuggestModal<T> {
      getItems(): T[] { return items; }
      getItemText(t: T): string { return label(t); }
      onChooseItem(t: T): void { chosen = t; resolve(t); }
      onClose(): void { this.contentEl.empty(); resolve(chosen); }
    }
    new S(app).open();
  });
}

export async function cmdValidate(ctx: SkillsGuiCtx): Promise<void> {
  const cfg = ctx.config();
  const a = await analyzeVault(ctx.backend, fieldsOf(cfg), cfg.pluginName, cfg.preloadCap);
  const lines = [
    `${a.counts.agents} agents · ${a.counts.skills} skills · ${a.counts.policies} policies · ${a.counts.commands} commands`,
    "",
    ...(a.errors.length ? ["Errors:", ...a.errors.map((e) => "  ✖ " + e)] : ["No errors ✓"]),
    ...(a.warnings.length ? ["", "Warnings:", ...a.warnings.map((w) => "  ⚠ " + w)] : []),
  ];
  new TextModal(ctx.app, "Vault Skills — validate", lines).open();
}

export async function cmdTree(ctx: SkillsGuiCtx): Promise<void> {
  const cfg = ctx.config();
  const a = await analyzeVault(ctx.backend, fieldsOf(cfg), cfg.pluginName, cfg.preloadCap);
  const byName = new Map(a.tree.map((n) => [n.name, n]));
  const lines: string[] = [];
  const walk = (name: string, depth: number): void => {
    const n = byName.get(name);
    if (!n) return;
    lines.push("  ".repeat(depth) + "▸ " + n.name + (n.skills.length ? `  ⟨${n.skills.join(", ")}⟩` : ""));
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of a.tree.filter((n) => n.parent === null)) walk(r.name, 0);
  if (!lines.length) lines.push("(no skills or agents found)");
  new TextModal(ctx.app, "Vault Skills — tree", lines).open();
}

export async function cmdMark(ctx: SkillsGuiCtx): Promise<void> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) { new Notice("Vault Skills: no active note."); return; }
  const fields = fieldsOf(ctx.config());

  const type = await pick(ctx.app, ["agent", "skill", "policy", "command"] as const, (t) => t);
  if (!type) return;

  // Commands are flat — no parent. Every other kind is placed under an agent.
  let parent: string | undefined;
  if (type !== "command") {
    const notes = await ctx.backend.notes();
    const agents = notes.filter((n) => n.frontmatter?.type === "agent").map((n) => base(n.path)).sort();
    const NONE = "— none (attach to root) —";
    const choice = await pick(ctx.app, [NONE, ...agents], (t) => t);
    if (choice === undefined) return;
    parent = choice === NONE ? undefined : choice;
  }

  try {
    // The SAME accept-forbidden guard the MCP `vault_skills_mark` tool runs: computes the
    // frontmatter the mark would land and refuses it if it would introduce/change an
    // acceptance assertion — nothing is written on refusal.
    const before = ctx.backend.frontmatterOf(file.path) ?? {};
    const result = guardSkillsMark(before, { type, parent } as MarkInput, fields);
    await ctx.backend.applyFrontmatter(file.path, (fm) => applyMark(fm, result));
    new Notice(`Vault Skills: marked "${file.basename}" as ${type}${parent ? ` · parent ${parent}` : ""}. Re-export to publish.`);
  } catch (e) {
    if (e instanceof AcceptForbiddenError) {
      new Notice(`Vault Skills: mark refused — it would set an acceptance field (${e.message}). Nothing written.`, 10000);
      return;
    }
    new Notice(`Vault Skills: mark failed — ${e instanceof Error ? e.message : String(e)}`, 8000);
  }
}

export async function cmdRelease(ctx: SkillsGuiCtx): Promise<void> {
  const cfg = ctx.config();
  const releaseDir = expandTilde(cfg.releaseDir);
  if (!releaseDir) {
    new Notice("Vault Skills: set the release repo directory in the skills module config first.");
    return;
  }
  const version = await promptText(ctx.app, "Release version", bumpPatch(readPluginVersion(releaseDir)));
  if (!version) return;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    new Notice(`Vault Skills: "${version}" is not a semver version (X.Y.Z) — release aborted.`);
    return;
  }
  try {
    // Calls the folded `runExport` core directly — the exact function the MCP
    // vault_skills_release tool calls. Materializes to the release dir; no note write.
    const summary = await runExport(ctx.backend, {
      outputDir: releaseDir,
      pluginName: cfg.pluginName,
      fields: fieldsOf(cfg),
      assetsRoot: expandTilde(cfg.assetsRoot),
      version,
      preloadCap: cfg.preloadCap,
    });
    const issues = summary.errors.length ? ` · ${summary.errors.length} error(s): ${summary.errors[0]}` : "";
    new Notice(
      `Vault Skills: packaged ${version} → ${releaseDir}\n` +
        `${summary.skills} skill(s) + ${summary.agents} agent(s) + ${summary.commands} command(s) + ${summary.assets} supporting file(s)${issues}\n` +
        `Commit & tag in the repo to publish.`,
      summary.errors.length ? 12000 : 8000,
    );
  } catch (e) {
    new Notice(`Vault Skills: release export failed — ${e instanceof Error ? e.message : String(e)}`, 10000);
  }
}
