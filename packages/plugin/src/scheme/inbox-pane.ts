// The scheme Inbox pane — a sidebar rollup of every "XX.01 Unsorted"/"XX.01
// Inbox" folder's contents, grouped by area, busiest-first. Ported from
// obsidian-jd-dashboard's InboxDashboardView (src/views/inbox-dashboard.ts) as
// part of the jd-dashboard fold, Stage B. READ-ONLY: it never writes anything;
// it re-scans the vault's markdown listing through the pure kernel query
// (kernel/scheme/inbox.ts's scanInboxes) on every relevant vault event.
//
// Click a row to reveal that folder in Obsidian's file explorer — same
// `revealInFolder` internal-API call the original used (there is no public
// Obsidian API for "select this folder in the file tree"; the cast to `any`
// is inherent to reaching it, same as the original).

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { scanInboxes, type InboxAreaGroup } from "../kernel/scheme/inbox.js";

export const INBOX_VIEW_TYPE = "vault-mcp-scheme-inbox";

/** What the pane needs from the wiring layer: the current markdown-note
 *  listing (read-only) and a way to reveal a folder in the file explorer. */
export interface InboxPaneController {
  notes(): string[];
  revealFolder(path: string): void;
}

const viewCtl = new WeakMap<InboxPaneView, InboxPaneController>();

export class InboxPaneView extends ItemView {
  private groups: InboxAreaGroup[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, controller: InboxPaneController) {
    super(leaf);
    viewCtl.set(this, controller);
  }

  getViewType(): string { return INBOX_VIEW_TYPE; }
  getDisplayText(): string { return "JD inboxes"; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("create", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.requestRefresh()));
    this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private requestRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 500);
  }

  private refresh(): void {
    this.groups = scanInboxes(viewCtl.get(this)!.notes());
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-mcp-inbox-pane");

    const total = this.groups.reduce((sum, g) => sum + g.items.reduce((s, i) => s + i.count, 0), 0);
    const header = root.createDiv();
    header.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 6px;";
    header.createEl("h3", { text: "Inboxes" }).style.margin = "0";
    header.createEl("span", { text: String(total) }).style.cssText = "color: var(--text-muted); font-weight: 600;";

    if (this.groups.length === 0) {
      root.createEl("p", { text: "All inboxes empty." }).style.color = "var(--text-muted)";
      return;
    }

    const controller = viewCtl.get(this)!;
    for (const group of this.groups) {
      const areaEl = root.createDiv();
      areaEl.style.marginTop = "8px";
      areaEl.createEl("div", { text: group.area }).style.cssText =
        "font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint);";

      const list = areaEl.createEl("ul");
      list.style.cssText = "list-style: none; margin: 2px 0; padding: 0;";
      for (const item of group.items) {
        const li = list.createEl("li");
        li.style.cssText = "display: flex; justify-content: space-between; padding: 2px 4px; cursor: pointer; border-radius: 4px;";
        li.createEl("span", { text: item.category });
        li.createEl("span", { text: String(item.count) }).style.color = "var(--text-muted)";
        li.addEventListener("click", () => controller.revealFolder(item.path));
      }
    }

    const footer = root.createDiv();
    footer.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--background-modifier-border);";
    footer.createEl("span", { text: `Updated ${new Date().toLocaleTimeString()}` }).style.cssText =
      "color: var(--text-faint); font-size: var(--font-ui-smaller);";
    const btn = footer.createEl("button", { text: "Refresh" });
    btn.addEventListener("click", () => this.refresh());
  }
}
