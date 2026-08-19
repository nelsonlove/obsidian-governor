// Wiring for the scheme Inbox pane (jd-dashboard fold, Stage B) — registers the
// view, mounts it in the right sidebar on first load (matching the original
// standalone plugin's default placement), and adds a command + ribbon icon to
// reveal it. Read-only chrome: no MCP tool, no write capability, no gesture
// gate — it's the same trust boundary as Obsidian's own file explorer, which
// is why (unlike an MCP tool's `ctx.notes()`) it reads `app.vault` directly
// rather than going through any path-visibility allowlist. That allowlist
// exists to bound what an MCP-connected AGENT can reach; a human's own
// sidebar in their own Obsidian is not that boundary — jd-dashboard's
// original inbox panel had no allowlist concept either.

import { type App, type Plugin, TFolder } from "obsidian";
import { INBOX_VIEW_TYPE, InboxPaneView, type InboxPaneController } from "./inbox-pane.js";

function revealFolder(app: App, path: string): void {
  const folder = app.vault.getAbstractFileByPath(path);
  if (!(folder instanceof TFolder)) return;
  const fileExplorer = app.workspace.getLeavesOfType("file-explorer")[0];
  if (!fileExplorer) return;
  app.workspace.revealLeaf(fileExplorer);
  // No public Obsidian API for "select this folder in the file tree" —
  // reaching the built-in file-explorer view's internal method, same as the
  // original jd-dashboard plugin did.
  (fileExplorer.view as unknown as { revealInFolder?: (f: TFolder) => void }).revealInFolder?.(folder);
}

export function wireSchemeInbox(plugin: Plugin): void {
  const app = plugin.app;
  const controller: InboxPaneController = {
    notes: () => app.vault.getMarkdownFiles().map((f) => f.path),
    revealFolder: (path) => revealFolder(app, path),
  };
  plugin.registerView(INBOX_VIEW_TYPE, (leaf) => new InboxPaneView(leaf, controller));

  const activate = async (): Promise<void> => {
    const existing = app.workspace.getLeavesOfType(INBOX_VIEW_TYPE);
    if (existing.length > 0) { app.workspace.revealLeaf(existing[0]); return; }
    const leaf = app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
    app.workspace.revealLeaf(leaf);
  };

  plugin.addRibbonIcon("inbox", "Open JD inboxes", () => void activate());
  plugin.addCommand({ id: "scheme-inbox-open", name: "Scheme: open JD inboxes", callback: () => void activate() });
}
