// The governance review pane — a right-sidebar ItemView. Lists pending notes grouped by agent;
// click a row to see the baseline-vs-current diff and the Accept / Revert buttons. Ported from
// obsidian-stewardship/src/view.ts as part of the governance (Acceptance) module fold (#83,
// cycle 2). This is the ONE obsidian-facing accept surface in vault-mcp.
//
// SECURITY: the Accept, Revert, Adopt-baseline AND auto-accept allowlist controls below are the
// ONLY call sites of the baseline-advance / allowlist-mutation code paths in the entire plugin.
// They are wired with `addEventListener('click', …)` — NEVER `el.onclick = …` — so the handler
// function is not a reachable property (`btn.onclick` stays null; renderer-JS cannot grab it to
// forge-call). Each handler additionally gates on `isRealGesture(evt)`, which requires a genuine
// `Event` whose isTrusted is true — a forged `{isTrusted:true}` plain object fails `instanceof
// Event`, and a synthesized `dispatchEvent(new MouseEvent(...))` has isTrusted forced false.
// Together only a physical human click fires accept/revert/adopt/setClassEnabled. Adopt-baseline
// additionally opens a confirmation modal because it silences the ENTIRE queue. See
// kernel/governance/gesture.ts and kernel/governance/accept.ts for the full invariant.
//
// REACHABILITY: the controller (which carries the accept/revert/adopt/setClassEnabled callables)
// is NOT stored as an instance field — a `private readonly controller` is an enumerable own
// property at runtime, so `getLeavesOfType('governance-review')[0].view.controller.accept(path)`
// would be a self-approval gadget for renderer-JS. Instead the controller lives in the
// module-scope `viewDeps` WeakMap below, keyed by the view instance. The WeakMap reference is
// module-private (unreachable from `app`), and its entries are not enumerable. The only live
// reference to an accept-capable callable is inside each button's addEventListener('click')
// closure, closed over the specific displayed row.

import { ItemView, WorkspaceLeaf, Notice, Modal, TFile, type App } from "obsidian";
import { type PendingItem, groupByAgent } from "../kernel/governance/queue.js";
import { diffNote, toHunks, type DiffLine, type HunkCollapsed } from "../kernel/governance/diff.js";
import { isRealGesture, runGuardedAdopt } from "../kernel/governance/gesture.js";
import { badgeVisible } from "../kernel/governance/badge.js";
import { renderIntent } from "../kernel/governance/intent-view.js";
import type { ClassId, ClassSpec } from "../kernel/governance/auto-accept/classes.js";

export const VIEW_TYPE_GOVERNANCE = "governance-review";

export interface ReviewController {
  getPending(): PendingItem[];
  getBaselineContent(path: string): string | null;
  readCurrent(path: string): Promise<string>;
  accept(path: string): Promise<void>;
  revert(path: string): Promise<void>;
  // adopt-baseline: snapshots ALL current content as the reviewed baseline and clears the queue.
  // Wired to the module-scope performAdopt closure in wiring.ts — NOT a method on any instance and
  // NOT a command. Reachable only via a trusted-gesture UI handler that ALSO confirms (below).
  adopt(): Promise<void>;
  refresh(): Promise<void>;
  // Read-only badge-display setting (plain boolean — confers no accept capability).
  showTabBadge(): boolean;
  // ── auto-accept allowlist (HUMAN-ONLY-MUTABLE, gesture-gated) ──────────────
  // The set of ever-allowable mechanical classes (the frozen AUTHORIZED_CLASSES), each note's
  // current enabled state, and the ONE mutator — setClassEnabled — which does nothing unless
  // handed a real trusted gesture. Reached only from the pane's allowlist-checkbox click handler.
  authorizedClasses(): ReadonlyArray<ClassSpec>;
  isClassEnabled(id: ClassId): boolean;
  setClassEnabled(id: ClassId, on: boolean, evt: unknown): Promise<boolean>;
}

// Confirmation modal for the mass-silencing adopt-baseline action. Opens on a human gesture,
// resolves true only when the human clicks Continue (itself gesture-gated), false on Cancel /
// Escape / backdrop.
class ConfirmModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private readonly opts: { title: string; body: string; confirmText: string },
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }
  private settle(ok: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(ok);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.body });
    const row = contentEl.createDiv({ cls: "governance-actions" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const confirm = row.createEl("button", { cls: "mod-warning governance-adopt-confirm", text: this.opts.confirmText });
    // The confirm button is itself an accept-class handler → wired via addEventListener (so its
    // onclick is null and the function is unreachable) and gated on isRealGesture (a forged object
    // or synthesized click must not slip past the human-confirmation gate). The listener is torn
    // down with the modal's contentEl on close.
    confirm.addEventListener("click", (evt) => {
      if (!isRealGesture(evt)) return;
      this.settle(true);
      this.close();
    });
  }
  onClose(): void {
    this.settle(false); // Escape / backdrop / Cancel all resolve as "did not confirm".
    this.contentEl.empty();
  }
}

// The exact adopt-baseline confirmation flow. Returns true only if the human confirmed.
export function confirmAdopt(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(
      app,
      {
        title: "Adopt current state as baseline",
        body: "This accepts all current content as the reviewed baseline and clears the queue. Continue?",
        confirmText: "Adopt baseline",
      },
      resolve,
    ).open();
  });
}

// Module-private store of each view's controller. Not reachable by walking the view object:
// `viewDeps` is a module-local binding, and WeakMap entries cannot be enumerated. This is
// what keeps accept/revert/adopt/setClassEnabled off the app-reachable object graph.
const viewDeps = new WeakMap<GovernanceReviewView, ReviewController>();

export class GovernanceReviewView extends ItemView {
  private selected: string | null = null;
  // Which rendering the detail view shows: the unified Diff (default), the Before (baseline
  // content) or the After (current content). Read-only display state — confers no capability.
  private detailMode: "diff" | "before" | "after" = "diff";
  // The pending-count badge overlaid on this view's TAB HEADER icon (read-only display element —
  // confers no capability).
  private tabBadgeEl: HTMLElement | null = null;
  private tabIconUnavailableWarned = false;

  constructor(leaf: WorkspaceLeaf, controller: ReviewController) {
    super(leaf);
    viewDeps.set(this, controller);
  }

  getViewType(): string { return VIEW_TYPE_GOVERNANCE; }
  getDisplayText(): string { return "Governance review"; }
  getIcon(): string { return "gavel"; }

  async onOpen(): Promise<void> { await this.rerender(); }
  async onClose(): Promise<void> {
    if (this.tabBadgeEl) {
      this.tabBadgeEl.remove();
      this.tabBadgeEl = null;
    }
  }

  // Reach the tab header's icon element via this.leaf. Not part of the public Obsidian typings,
  // so this is a best-effort lookup with a fallback and a graceful, once-only failure mode — it is
  // purely a display target (badge overlay), never a capability surface.
  private getTabIconEl(): HTMLElement | null {
    const leafAny = this.leaf as unknown as {
      tabHeaderInnerIconEl?: HTMLElement;
      tabHeaderEl?: HTMLElement;
    };
    const el =
      leafAny.tabHeaderInnerIconEl ??
      leafAny.tabHeaderEl?.querySelector<HTMLElement>(".workspace-tab-header-inner-icon") ??
      null;
    if (!el && !this.tabIconUnavailableWarned) {
      this.tabIconUnavailableWarned = true;
      console.warn(
        "vault-mcp governance: tab header icon element not reachable in this Obsidian version — " +
          "the review-pane tab badge is disabled; the ribbon badge is unaffected.",
      );
    }
    return el;
  }

  private updateTabBadge(count: number, enabled: boolean): void {
    const iconEl = this.getTabIconEl();
    if (!iconEl) return;
    if (!this.tabBadgeEl) {
      iconEl.addClass("governance-tab-icon-wrap");
      this.tabBadgeEl = iconEl.createSpan({ cls: "governance-badge governance-tab-badge" });
    }
    if (badgeVisible(count, enabled)) {
      this.tabBadgeEl.setText(String(count));
      this.tabBadgeEl.show();
    } else {
      this.tabBadgeEl.hide();
    }
  }

  async rerender(): Promise<void> {
    const deps = viewDeps.get(this)!;
    const root = this.contentEl;
    root.empty();
    root.addClass("governance-pane");
    const pending = deps.getPending();
    this.updateTabBadge(pending.length, deps.showTabBadge());

    const header = root.createDiv({ cls: "governance-header" });
    header.createEl("h3", { text: "Governance" });
    header.createSpan({ cls: "governance-count", text: `${pending.length} pending` });
    const refreshBtn = header.createEl("button", { cls: "governance-refresh", text: "Refresh" });
    refreshBtn.onclick = async () => { await deps.refresh(); await this.rerender(); };

    // Adopt-baseline is a genuine-user-gesture UI action (NOT a command, NOT an instance method).
    // It closes over `deps.adopt` here; the handler is wired via addEventListener (onclick stays
    // null → the function is unreachable to renderer-JS) and is gesture-gated AND confirmation-
    // gated, since adopting silences the whole queue.
    const adoptBtn = header.createEl("button", { cls: "governance-adopt", text: "Adopt baseline" });
    adoptBtn.addEventListener("click", async (evt) => {
      const outcome = await runGuardedAdopt(
        evt,
        () => confirmAdopt(this.app),
        () => deps.adopt(),
      );
      if (outcome === "done") {
        new Notice("vault-mcp governance: baseline adopted — the vault is now reviewable.");
        await this.rerender();
      }
    });

    if (this.selected && pending.some((p) => p.path === this.selected)) {
      await this.renderDetail(root, pending.find((p) => p.path === this.selected)!);
    } else {
      this.selected = null;
      this.renderList(root, pending);
      this.renderAllowlist(root, deps);
    }
  }

  // The auto-accept allowlist section — HUMAN-ONLY-MUTABLE. Each checkbox is gesture-gated
  // EXACTLY like adopt-baseline: a raw checkbox wired via addEventListener (its `.onclick` stays
  // null → the handler is unreachable to renderer-JS) whose handler refuses unless the click is a
  // genuine trusted gesture (deps.setClassEnabled → isRealGesture). An agent cannot flip it: a
  // synthesized/forged click is rejected and the checkbox reverts. The universe of classes is the
  // frozen AUTHORIZED_CLASSES — this UI can only enable/disable among them, never add a new class.
  private renderAllowlist(root: HTMLElement, deps: ReviewController): void {
    const section = root.createDiv({ cls: "governance-allowlist" });
    section.createDiv({ cls: "governance-allowlist-title", text: "Auto-accept (mechanical changes)" });
    section.createDiv({
      cls: "governance-allowlist-desc",
      text:
        "Auto-accept advances a note's baseline WITHOUT a human click, but ONLY for changes that " +
        "are provably mechanical and belong to a class enabled below. Everything else stays " +
        "pending. Disabling a class makes its changes stay pending.",
    });
    for (const spec of deps.authorizedClasses()) {
      const row = section.createDiv({ cls: "governance-allowlist-row" });
      const label = row.createEl("label", { cls: "governance-allowlist-label" });
      const checkbox = label.createEl("input", { type: "checkbox", cls: "governance-allowlist-check" });
      checkbox.checked = deps.isClassEnabled(spec.id);
      label.createSpan({ cls: "governance-allowlist-name", text: ` ${spec.id}` });
      row.createDiv({ cls: "governance-allowlist-why", text: spec.railNeutralBecause });
      // Gesture-gated: only a genuine trusted click mutates the allowlist. A forged/synthesized
      // click is refused and the checkbox is reverted to the real enabled state.
      checkbox.addEventListener("click", async (evt) => {
        const want = checkbox.checked;
        const applied = await deps.setClassEnabled(spec.id, want, evt);
        if (!applied) {
          evt.preventDefault();
          checkbox.checked = deps.isClassEnabled(spec.id); // revert to real state
        }
      });
    }
  }

  private renderList(root: HTMLElement, pending: PendingItem[]): void {
    if (pending.length === 0) {
      root.createDiv({ cls: "governance-empty", text: "Queue empty — no agent changes awaiting review." });
      return;
    }
    for (const group of groupByAgent(pending)) {
      const g = root.createDiv({ cls: "governance-group" });
      g.createDiv({ cls: "governance-group-agent", text: group.agent });
      for (const item of group.items) {
        const row = g.createDiv({ cls: "governance-row" });
        const main = row.createDiv({ cls: "governance-row-main" });
        main.createDiv({ cls: "governance-row-title", text: item.title });
        main.createDiv({ cls: "governance-row-path", text: item.path });
        // UNTRUSTED agent-authored text. Rendered via renderIntent() (kernel/governance/
        // intent-view.ts), which places it into a text node ONLY (createSpan/text) — never HTML,
        // never a markdown/wikilink/template renderer, however the agent phrased it.
        if (item.intent) {
          renderIntent(main, item.intent, { wrapperCls: "governance-row-intent", full: false });
        }
        const meta = row.createDiv({ cls: "governance-row-meta" });
        meta.createSpan({ text: shortOp(item.op) });
        meta.createSpan({ text: relTime(item.when) });
        row.onclick = () => { this.selected = item.path; this.detailMode = "diff"; void this.rerender(); };
      }
    }
  }

  private async renderDetail(root: HTMLElement, item: PendingItem): Promise<void> {
    // The accept-capable deps are pulled from the module-private WeakMap and captured ONLY by
    // the button click closures below (each closed over this specific `item` row). They are
    // never assigned to `this`, so no app-reachable walk finds an accept/revert callable.
    const deps = viewDeps.get(this)!;
    const back = root.createEl("button", { cls: "governance-back", text: "← Back to queue" });
    back.onclick = () => { this.selected = null; void this.rerender(); };

    const title = root.createDiv({ cls: "governance-detail-title" });
    title.createEl("strong", { text: item.title });
    title.createDiv({ cls: "governance-row-path", text: item.path });
    title.createDiv({
      cls: "governance-detail-sub",
      text: `${item.agent} · ${shortOp(item.op)} · ${item.writeCount} write(s) · ${relTime(item.when)}`,
    });
    // UNTRUSTED agent-authored text — see kernel/governance/intent-view.ts for the text-node-only
    // render path and its behavioral escaping test.
    if (item.intent) {
      renderIntent(title, item.intent, { wrapperCls: "governance-detail-intent", full: true });
    }

    // Navigation: open the live note in the main editor tab. Read-only — opening a file confers
    // no capability renderer-JS lacks (app.workspace can already do it), so a plain onclick is safe
    // here; this is NOT an accept-class handler.
    const nav = root.createDiv({ cls: "governance-nav" });
    const openBtn = nav.createEl("button", { cls: "governance-open", text: "Open in tab" });
    openBtn.onclick = async () => {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    };

    // Action buttons — the ONLY accept/revert call sites.
    const actions = root.createDiv({ cls: "governance-actions" });
    const acceptBtn = actions.createEl("button", { cls: "mod-cta governance-accept", text: "Accept" });
    const revertBtn = actions.createEl("button", { cls: "governance-revert", text: "Revert" });
    // Wired via addEventListener (onclick stays null → unreachable to renderer-JS) and gated on
    // isRealGesture (forged plain-object arg fails instanceof Event; synthesized click has
    // isTrusted false). Only a physical human click reaches deps.accept / deps.revert.
    acceptBtn.addEventListener("click", async (evt) => {
      if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
      acceptBtn.disabled = revertBtn.disabled = true;
      try {
        await deps.accept(item.path);
        new Notice(`vault-mcp governance: accepted ${item.title}`);
        this.selected = null;
        await this.rerender();
      } catch (e) {
        new Notice(`vault-mcp governance: accept failed — ${(e as Error).message}`);
        acceptBtn.disabled = revertBtn.disabled = false;
      }
    });
    revertBtn.addEventListener("click", async (evt) => {
      if (!isRealGesture(evt)) return; // inert on forged arg or synthesized click
      acceptBtn.disabled = revertBtn.disabled = true;
      try {
        await deps.revert(item.path);
        new Notice(`vault-mcp governance: reverted ${item.title} (previous version quarantined)`);
        this.selected = null;
        await this.rerender();
      } catch (e) {
        new Notice(`vault-mcp governance: revert failed — ${(e as Error).message}`);
        acceptBtn.disabled = revertBtn.disabled = false;
      }
    });

    // Content view — toggle between the unified Diff (default), the Before (baseline) full text and
    // the After (current) full text. All three are read-only renderings; none advances a baseline.
    const baseContent = deps.getBaselineContent(item.path) ?? "";
    let curContent = "";
    try { curContent = await deps.readCurrent(item.path); } catch { curContent = ""; }

    const modeRow = root.createDiv({ cls: "governance-mode" });
    const modes: Array<{ key: "diff" | "before" | "after"; label: string }> = [
      { key: "diff", label: "Diff" },
      { key: "before", label: "Before" },
      { key: "after", label: "After" },
    ];
    for (const m of modes) {
      const b = modeRow.createEl("button", {
        cls: `governance-mode-btn${this.detailMode === m.key ? " is-active" : ""}`,
        text: m.label,
      });
      b.onclick = () => { this.detailMode = m.key; void this.rerender(); };
    }

    if (this.detailMode === "before") {
      root.createEl("pre", { cls: "governance-plain", text: baseContent || "(empty)" });
      return;
    }
    if (this.detailMode === "after") {
      root.createEl("pre", { cls: "governance-plain", text: curContent || "(empty)" });
      return;
    }

    const diff = diffNote(baseContent, curContent);
    const diffEl = root.createDiv({ cls: "governance-diff" });

    const fmChanged = diff.frontmatter.filter((f) => f.status !== "unchanged");
    if (fmChanged.length) {
      diffEl.createDiv({ cls: "governance-diff-section", text: "Frontmatter" });
      const fmTable = diffEl.createDiv({ cls: "governance-fm" });
      for (const f of fmChanged) {
        const rowEl = fmTable.createDiv({ cls: `governance-fm-row fm-${f.status}` });
        rowEl.createSpan({ cls: "governance-fm-key", text: f.key });
        const val = rowEl.createSpan({ cls: "governance-fm-val" });
        if (f.status === "changed") {
          val.createSpan({ cls: "fm-old", text: f.base ?? "" });
          val.createSpan({ cls: "fm-arrow", text: " → " });
          val.createSpan({ cls: "fm-new", text: f.current ?? "" });
        } else if (f.status === "added") {
          val.createSpan({ cls: "fm-new", text: f.current ?? "" });
        } else {
          val.createSpan({ cls: "fm-old", text: f.base ?? "" });
        }
        rowEl.createSpan({ cls: "governance-fm-tag", text: f.status });
      }
    }

    diffEl.createDiv({ cls: "governance-diff-section", text: "Body" });
    const body = diffEl.createDiv({ cls: "governance-body" });
    const bodyChanged = diff.body.some((l) => l.status !== "same");
    if (!bodyChanged) {
      body.createDiv({ cls: "governance-no-changes", text: "No body changes." });
    } else {
      // git-style collapsing: only changed lines + a few lines of surrounding context are
      // shown; long unchanged runs (including leading/trailing) fold into a count marker.
      for (const h of toHunks(diff.body, 3)) {
        if (h.kind === "line") {
          renderDiffLine(body, h.line);
        } else {
          renderCollapsedMarker(body, h);
        }
      }
    }
  }
}

function renderDiffLine(container: HTMLElement, line: DiffLine, before: Node | null = null): void {
  const lineEl = container.createDiv({ cls: `governance-line line-${line.status}` });
  const gutter = line.status === "added" ? "+" : line.status === "removed" ? "−" : " ";
  lineEl.createSpan({ cls: "governance-gutter", text: gutter });
  const textEl = lineEl.createSpan({ cls: "governance-line-text" });
  if (line.words && line.words.length) {
    for (const w of line.words) {
      textEl.createSpan({ cls: w.changed ? "word-changed" : "word-same", text: w.text });
    }
  } else {
    textEl.setText(line.text === "" ? " " : line.text);
  }
  if (before) container.insertBefore(lineEl, before);
}

// Collapsed-run marker — a plain display convenience, not an accept-class control: clicking it
// only expands already-computed, already-visible-in-the-diff lines in place (no vault read/write,
// no baseline advance), so a bare `.onclick` is appropriate here, same as "Open in tab" and the
// mode-toggle buttons above. See the SECURITY note at the top of this file for what IS gated.
function renderCollapsedMarker(container: HTMLElement, h: HunkCollapsed): void {
  const markerEl = container.createDiv({ cls: "governance-collapsed" });
  markerEl.setText(`⋯ ${h.count} unchanged line${h.count === 1 ? "" : "s"} ⋯`);
  markerEl.onclick = () => {
    for (const line of h.lines) renderDiffLine(container, line, markerEl);
    markerEl.remove();
  };
}

function shortOp(op: string): string {
  return op.replace(/^obsidian_/, "");
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
