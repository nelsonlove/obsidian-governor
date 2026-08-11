// The skills Preview pane — the compiled Claude Code output, browsable before export.
// Ported from the standalone vault-skills plugin (obsidian/src/preview-view.ts) as part of
// the GUI fold (#82 residuals). READ-ONLY: it never writes; it compiles the vault through
// the folded skills core (`previewVault`, kernel/skills) and diffs it against the current
// export dir — the exact same core the read-only MCP `vault_skills_preview` tool runs, so the
// pane and the tool can never disagree about the same vault.
//
// Left: the agent/skill tree plus flat groups (commands, policies, static, removed), each
// node badged with its diff status against the current export. Right: the selected entry as
// Claude Code sees it — the listing line (name + description), the full compiled file, and,
// when modified, the currently exported version side by side. Always a fresh render; no
// persisted state.
//
// Refresh triggers: manual button; relevant vault events (note changed/deleted/renamed —
// "relevant" = exportable now, or a source of the last render, so deletions and de-typed
// notes count); and the "vault-mcp:skills-exported" workspace event fired by the GUI's own
// export path (command / ribbon / export-on-save), since writing the output dir emits no
// vault events. NOTE: an MCP-triggered `vault_skills_export` runs in the per-connection
// server process and fires no workspace event, so the pane won't auto-refresh after one —
// the manual Refresh button (or any subsequent note edit) picks up the new baseline. A hidden
// leaf marks itself dirty instead of re-running the pipeline, and re-renders on reveal.

import { ItemView, type WorkspaceLeaf, type TFile } from "obsidian";
import type { PreviewEntry, PreviewResult, DetectConfig } from "../kernel/skills/index.js";
import { debounce, handleNoteChanged, type Debounced } from "./export-trigger.js";

export const SKILLS_PREVIEW_VIEW_TYPE = "vault-mcp-skills-preview";

/** Fired on the workspace by the skills GUI after every export it runs — the pane listens so
 *  it can re-diff against the fresh output dir (which emits no vault events of its own). */
export const SKILLS_EXPORTED_EVENT = "vault-mcp:skills-exported";

/** What the pane needs from the wiring layer: a way to compile the vault (read-only) and the
 *  current detection config (for deciding whether a changed note is export-relevant). Carries
 *  NO write capability — the preview is read-only. */
export interface SkillsPreviewController {
  /** Compile the vault and diff against the export dir (read-only `previewVault`). */
  compile(): Promise<PreviewResult>;
  /** Current detection + field-namespacing config (for the change-relevance check). */
  fields(): DetectConfig;
}

const STATUS_BADGE: Record<string, { text: string; color: string }> = {
  added: { text: "+", color: "var(--color-green)" },
  modified: { text: "±", color: "var(--color-orange)" },
  unchanged: { text: "·", color: "var(--text-faint)" },
  removed: { text: "✕", color: "var(--color-red)" },
};
const POLICY_BADGE = { hard: { text: "‼", color: "var(--color-red)" }, soft: { text: "§", color: "var(--text-muted)" } };

type Tab = "listing" | "compiled" | "diff";

// The controller lives in a module-private WeakMap, not an instance field — consistent with
// how the governance pane keeps its controller off the app-reachable object graph. The
// preview controller confers no write capability (it only compiles + reads config), but the
// same discipline keeps the surfaces uniform.
const viewCtl = new WeakMap<SkillsPreviewView, SkillsPreviewController>();

export class SkillsPreviewView extends ItemView {
  private result: PreviewResult | null = null;
  private error: string | null = null;
  private selected: string | null = null; // entry relOut, "policy:<path>", or "removed:<relOut>"
  private tab: Tab = "listing";
  private refreshDebounced: Debounced | null = null;
  private dirty = false;
  private sources = new Set<string>(); // vault paths the last render was compiled from
  private navLines = new Map<string, HTMLElement>();
  private detailEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, controller: SkillsPreviewController) {
    super(leaf);
    viewCtl.set(this, controller);
  }

  getViewType(): string { return SKILLS_PREVIEW_VIEW_TYPE; }
  getDisplayText(): string { return "Vault skills preview"; }
  getIcon(): string { return "eye"; }

  async onOpen(): Promise<void> {
    // Debounced so a rename's burst of cache events collapses into one re-render of the
    // settled tree (same reasoning as export-on-save; see export-trigger.ts).
    this.refreshDebounced = debounce(() => void this.refresh(), 1000);

    const ctl = viewCtl.get(this)!;
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        // Exportable now (new/edited definition) — or a source of the last render, which
        // catches a note whose kind was just removed and would otherwise fail the check.
        if (this.sources.has(file.path)) { this.requestRefresh(); return; }
        handleNoteChanged(file, {
          isEnabled: () => true,
          fields: () => ctl.fields(),
          getFrontmatter: (f) => this.app.metadataCache.getFileCache(f as TFile)?.frontmatter as Record<string, unknown> | undefined,
          requestExport: () => this.requestRefresh(),
        });
      }),
    );
    // metadataCache "changed" never fires for deletions or the old path of a rename; the
    // vault events do. Only sources of the last render are relevant — anything else can't
    // change the compiled output.
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.sources.has(file.path)) this.requestRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.sources.has(oldPath) || this.sources.has(file.path)) this.requestRefresh();
    }));
    // Fired by the GUI after every export it runs — the output dir is outside the vault, so
    // nothing else tells us the diff baseline moved. (An MCP-triggered export fires nothing
    // here; use Refresh.) Cast: the event name isn't in Obsidian's typed workspace events.
    this.registerEvent(this.app.workspace.on(SKILLS_EXPORTED_EVENT as "quit", () => this.requestRefresh()));
    // A leaf revealed with a pending dirty flag re-renders now.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      if (this.dirty && this.containerEl.isShown()) void this.refresh();
    }));

    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.refreshDebounced?.cancel();
    this.contentEl.empty();
  }

  private requestRefresh(): void {
    this.refreshDebounced?.();
  }

  private async refresh(): Promise<void> {
    // Don't burn the pipeline for a leaf nobody can see — re-render on reveal instead.
    if (!this.containerEl.isShown()) { this.dirty = true; return; }
    this.dirty = false;
    try {
      this.result = await viewCtl.get(this)!.compile();
      this.error = null;
      this.sources = new Set([
        ...this.result.entries.map((e) => e.from).filter((f) => !f.startsWith("(")),
        ...this.result.entries.flatMap((e) => e.sources ?? []),
        ...this.result.policies.map((p) => p.path),
      ]);
      if (this.selected && !this.selectionExists(this.selected)) this.selected = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  private selectionExists(sel: string): boolean {
    const r = this.result;
    if (!r) return false;
    if (sel.startsWith("policy:")) return r.policies.some((p) => `policy:${p.path}` === sel);
    if (sel.startsWith("removed:")) return r.removed.some((p) => `removed:${p}` === sel);
    return r.entries.some((e) => e.relOut === sel);
  }

  /** Full rebuild — only on refresh. Selection/tab changes re-render the detail pane only,
   *  so the nav keeps its DOM and scroll position. */
  private render(): void {
    const root = this.contentEl;
    root.empty();
    this.navLines.clear();
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.height = "100%";

    this.renderHeader(root);
    if (this.error) {
      root.createEl("div", { text: `Preview failed: ${this.error}` }).style.color = "var(--color-red)";
      return;
    }
    const r = this.result;
    if (!r) { root.createEl("div", { text: "Loading…" }); return; }

    if (r.errors.length) {
      const banner = root.createDiv();
      banner.style.cssText = "color: var(--color-red); padding: 4px 8px; border: 1px solid var(--color-red); border-radius: 4px; margin: 4px 0;";
      banner.createEl("strong", { text: `${r.errors.length} transform error(s)` });
      for (const e of r.errors) banner.createEl("div", { text: `✖ ${e}` });
    }

    const body = root.createDiv();
    body.style.cssText = "display: flex; flex: 1; min-height: 0; gap: 8px;";
    const nav = body.createDiv();
    nav.style.cssText = "width: 280px; overflow-y: auto; border-right: 1px solid var(--background-modifier-border); padding-right: 8px; flex-shrink: 0;";
    this.detailEl = body.createDiv();
    this.detailEl.style.cssText = "flex: 1; overflow-y: auto; min-width: 0;";

    this.renderNav(nav, r);
    this.renderDetail(r);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv();
    header.style.cssText = "display: flex; align-items: center; gap: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 6px;";
    const btn = header.createEl("button", { text: "Refresh" });
    btn.addEventListener("click", () => void this.refresh());
    const r = this.result;
    if (r) {
      const d = r.diff;
      header.createEl("span", {
        text: `${d.added} added · ${d.modified} modified · ${d.unchanged} unchanged · ${d.removed} removed`,
      }).style.color = "var(--text-muted)";
      header.createEl("span", { text: `→ ${r.outputDir}` }).style.cssText = "color: var(--text-faint); font-size: var(--font-ui-smaller);";
    }
  }

  private select(sel: string): void {
    if (!sel) return;
    const prev = this.selected;
    this.selected = sel;
    this.tab = "listing";
    if (prev) this.navLines.get(prev)?.style.removeProperty("background");
    const line = this.navLines.get(sel);
    if (line) line.style.background = "var(--background-modifier-hover)";
    if (this.result) this.renderDetail(this.result);
  }

  private navLine(parent: HTMLElement, opts: { sel: string; badge: { text: string; color: string }; label: string; depth: number; muted?: boolean }): void {
    const line = parent.createDiv();
    line.style.cssText = `padding: 1px 4px 1px ${4 + opts.depth * 14}px; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
    if (this.selected === opts.sel) line.style.background = "var(--background-modifier-hover)";
    const badge = line.createEl("span", { text: opts.badge.text + " " });
    badge.style.color = opts.badge.color;
    badge.style.fontFamily = "var(--font-monospace)";
    line.createEl("span", { text: opts.label }).style.color = opts.muted ? "var(--text-muted)" : "var(--text-normal)";
    if (opts.sel) this.navLines.set(opts.sel, line);
    line.addEventListener("click", () => this.select(opts.sel));
  }

  private group(nav: HTMLElement, title: string): HTMLElement {
    const h = nav.createEl("div", { text: title });
    h.style.cssText = "margin-top: 10px; font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint);";
    return nav.createDiv();
  }

  private renderNav(nav: HTMLElement, r: PreviewResult): void {
    // Entries carry the generated name — look up by (kind, name) instead of re-encoding
    // the output layout (agents/<name>.md, …), which only transform.ts should know.
    const byNameKind = new Map(r.entries.filter((e) => e.name).map((e) => [`${e.kind}:${e.name}`, e]));
    const entryFor = (name: string, kind: "agent" | "skill"): PreviewEntry | undefined => byNameKind.get(`${kind}:${name}`);
    const byName = new Map(r.tree.map((n) => [n.name, n]));
    // Crosscutting agents are deliberately absent from their parent's `children` (they fan
    // into scope agents as specialists, not vertical lanes) — walk them from `parent` so
    // they still render in the tree, marked ⤫.
    const crosscutUnder = (name: string) => r.tree.filter((n) => n.kind === "agent" && n.crosscutting && n.parent === name);

    const treeBox = this.group(nav, "Tree");
    const walk = (name: string, depth: number): void => {
      const n = byName.get(name);
      if (!n) return;
      const e = entryFor(n.name, "agent");
      this.navLine(treeBox, {
        sel: e?.relOut ?? "",
        badge: STATUS_BADGE[e?.status ?? "unchanged"],
        label: `▸ ${n.name}${n.crosscutting ? " ⤫" : ""}`,
        depth,
      });
      for (const s of n.skills) {
        const se = entryFor(s, "skill");
        this.navLine(treeBox, { sel: se?.relOut ?? "", badge: STATUS_BADGE[se?.status ?? "unchanged"], label: s, depth: depth + 1 });
      }
      for (const c of n.children) walk(c, depth + 1);
      for (const cc of crosscutUnder(n.name)) walk(cc.name, depth + 1);
    };
    for (const rootNode of r.tree.filter((n) => n.parent === null)) walk(rootNode.name, 0);

    const commands = r.entries.filter((e) => e.kind === "command");
    if (commands.length) {
      const box = this.group(nav, "Commands");
      for (const c of commands) this.navLine(box, { sel: c.relOut, badge: STATUS_BADGE[c.status], label: `/${c.name ?? c.relOut}`, depth: 0 });
    }

    if (r.policies.length) {
      const box = this.group(nav, "Policies");
      for (const p of r.policies) {
        this.navLine(box, { sel: `policy:${p.path}`, badge: p.hard ? POLICY_BADGE.hard : POLICY_BADGE.soft, label: p.title, depth: 0 });
      }
    }

    const statics = r.entries.filter((e) => e.from === "(static)");
    if (statics.length) {
      const box = this.group(nav, "Static");
      for (const s of statics) this.navLine(box, { sel: s.relOut, badge: STATUS_BADGE[s.status], label: s.relOut, depth: 0, muted: true });
    }

    if (r.removed.length) {
      const box = this.group(nav, "Removed on next export");
      for (const rel of r.removed) this.navLine(box, { sel: `removed:${rel}`, badge: STATUS_BADGE.removed, label: rel, depth: 0, muted: true });
    }
  }

  private pre(parent: HTMLElement, text: string): void {
    const pre = parent.createEl("pre", { text });
    pre.style.cssText = "white-space: pre-wrap; word-break: break-word; user-select: text; font-size: var(--font-smaller); background: var(--background-secondary); padding: 8px; border-radius: 4px;";
  }

  private sourceLink(parent: HTMLElement, from: string): void {
    if (from.startsWith("(")) { parent.createEl("span", { text: from }).style.color = "var(--text-faint)"; return; }
    const a = parent.createEl("a", { text: from });
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.app.workspace.openLinkText(from, "", false);
    });
  }

  private renderDetail(r: PreviewResult): void {
    const detail = this.detailEl;
    if (!detail) return;
    detail.empty();
    const sel = this.selected;
    if (!sel) {
      detail.createEl("div", { text: "Select a node to preview its compiled output." }).style.color = "var(--text-muted)";
      return;
    }

    if (sel.startsWith("policy:")) {
      const p = r.policies.find((x) => `policy:${x.path}` === sel);
      if (!p) return;
      detail.createEl("h3", { text: p.title + (p.hard ? " (hard)" : "") });
      const meta = detail.createDiv();
      meta.createEl("span", { text: "source: " });
      this.sourceLink(meta, p.path);
      detail.createEl("p", {
        text: p.agents.length
          ? `Injected into ${p.agents.length} agent file(s):`
          : "Not injected into any agent file (parent agent has no valid subtree).",
      });
      const ul = detail.createEl("ul");
      for (const a of p.agents) {
        const li = ul.createEl("li");
        const link = li.createEl("a", { text: `agents/${a}.md` });
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          const target = r.entries.find((x) => x.kind === "agent" && x.name === a);
          if (target) { this.select(target.relOut); this.tab = "compiled"; this.renderDetail(r); }
        });
      }
      return;
    }

    if (sel.startsWith("removed:")) {
      const rel = sel.slice("removed:".length);
      detail.createEl("h3", { text: rel });
      detail.createEl("p", { text: "Present in the current export but no longer generated — the next export deletes it." })
        .style.color = "var(--color-red)";
      return;
    }

    const e = r.entries.find((x) => x.relOut === sel);
    if (!e) return;

    detail.createEl("h3", { text: e.name ?? e.relOut });
    const meta = detail.createDiv();
    meta.style.cssText = "color: var(--text-muted); font-size: var(--font-ui-smaller); margin-bottom: 6px;";
    meta.createEl("span", { text: `${e.kind} · ${e.relOut} · ${e.bytes} bytes · ${e.status} · source: ` });
    this.sourceLink(meta, e.from);
    if (e.sources?.length) {
      const asm = detail.createDiv();
      asm.style.cssText = "color: var(--text-muted); font-size: var(--font-ui-smaller); margin-bottom: 6px;";
      asm.createEl("span", { text: "transcludes: " });
      e.sources.forEach((s, i) => {
        if (i) asm.createEl("span", { text: " · " });
        this.sourceLink(asm, s);
      });
    }

    const tabs: Tab[] = e.status === "modified" ? ["listing", "compiled", "diff"] : ["listing", "compiled"];
    if (!tabs.includes(this.tab)) this.tab = "listing";
    const bar = detail.createDiv();
    bar.style.cssText = "display: flex; gap: 4px; margin-bottom: 6px;";
    for (const t of tabs) {
      const b = bar.createEl("button", { text: t });
      if (t === this.tab) b.style.cssText = "background: var(--interactive-accent); color: var(--text-on-accent);";
      b.addEventListener("click", () => { this.tab = t; this.renderDetail(r); });
    }

    if (this.tab === "listing") {
      // The line Claude Code's skill/agent lists actually show: name + description.
      const box = detail.createDiv();
      box.style.cssText = "background: var(--background-secondary); padding: 8px; border-radius: 4px;";
      if (e.name) box.createEl("div", { text: e.name }).style.fontWeight = "600";
      box.createEl("div", { text: e.description ?? "(no listing line — static file)" });
    } else if (this.tab === "compiled") {
      this.pre(detail, e.content);
    } else {
      detail.createEl("div", { text: "Currently exported:" }).style.fontWeight = "600";
      this.pre(detail, e.cachedContent ?? "");
      detail.createEl("div", { text: "After export:" }).style.fontWeight = "600";
      this.pre(detail, e.content);
    }
  }
}
