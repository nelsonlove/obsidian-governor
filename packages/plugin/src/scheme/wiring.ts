// Wiring for the scheme Inbox and Drift panes (jd-dashboard fold, Stages B
// and C) — registers each view and adds a ribbon icon + command that opens
// it in the right sidebar (matching the original standalone plugin's
// placement); like the original, and like this plugin's skills Preview
// pane, neither forces a leaf open on its own at onload — "wired" means
// registered and reachable, not auto-revealed. Both are read-only chrome: no
// MCP tool, no write capability, no gesture gate — the same trust boundary
// as Obsidian's own file explorer, which is why (unlike an MCP tool's
// `ctx.notes()`) the Inbox pane reads `app.vault` directly rather than going
// through the MCP path-visibility allowlist (guard.ts's `visiblePaths`).
// That allowlist bounds what an MCP-connected AGENT can reach; a human's own
// sidebar in their own Obsidian is not that boundary. (The Drift pane's
// equivalent — the conformance engine's own `excludedRoots` config — is
// handled inside `runConformance` itself, via `obsidian-drift-source.ts`;
// nothing extra needed here.)
//
// The Inbox pane DOES still respect a configured scheme instance's
// `excludedRoots`, though — that is a "what does this vault's addressing
// scheme consider live JD territory at all" judgment (config is not
// hardwired, Nelson's ruling — see tools-scheme.ts's callers of
// `excludeRoots`), independent of the agent-facing allowlist. A
// vault-relative folder an instance is configured to never resolve/list/
// claim (e.g. an archive tree reusing a live spine's addresses) should not
// show up as a "real" inbox here either. Excluded from every configured
// instance's union, not just one — with several instances configured
// differently, any of them saying "this isn't live JD territory" is reason
// enough to leave it out of a human-facing rollup, even though only one
// instance's grammar is what actually finds the inbox folders in the first
// place (inbox.ts's own regexes, JD-specific — see its header for why that
// isn't threaded through ScopeProvider itself).

import { type App, type Plugin, TFolder } from "obsidian";
import { makeRegistry, excludeRoots, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { INBOX_VIEW_TYPE, InboxPaneView, type InboxPaneController } from "./inbox-pane.js";
import { DRIFT_VIEW_TYPE, DriftPaneView, type DriftPaneController } from "./drift-pane.js";
import { obsidianDriftSource } from "../mcp/obsidian-drift-source.js";

function revealFolder(app: App, path: string): void {
  const folder = app.vault.getAbstractFileByPath(path);
  if (!(folder instanceof TFolder)) return;
  const fileExplorer = app.workspace.getLeavesOfType("file-explorer")[0];
  if (!fileExplorer) return;
  app.workspace.revealLeaf(fileExplorer);
  // No public Obsidian API for "select this folder in the file tree" —
  // reaching the built-in file-explorer view's internal method (a typed
  // structural cast, not `any` — same reach, tighter typing than the
  // original jd-dashboard plugin's `(view as any).revealInFolder?.(...)`).
  (fileExplorer.view as unknown as { revealInFolder?: (f: TFolder) => void }).revealInFolder?.(folder);
}

export interface WireSchemeInboxOpts {
  /** The vault's configured scheme instances, read fresh per call — mirrors
   *  server.ts's own `schemes: () => makeRegistry(...)` (a cheap, pure,
   *  rebuild-don't-cache factory), so a settings-tab edit to `excludedRoots`
   *  takes effect on the pane's next refresh without a plugin reload. */
  getSchemes: () => SchemeInstanceConfig[];
}

export function wireSchemeInbox(plugin: Plugin, opts: WireSchemeInboxOpts): void {
  const app = plugin.app;
  const controller: InboxPaneController = {
    notes: () => {
      const notes = app.vault.getMarkdownFiles().map((f) => f.path);
      const roots = makeRegistry(opts.getSchemes())
        .instances()
        .flatMap((inst) => inst.excludedRoots ?? []);
      return excludeRoots(notes, roots.length ? roots : undefined);
    },
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

export function wireSchemeDrift(plugin: Plugin): void {
  const app = plugin.app;
  const source = obsidianDriftSource(app);
  const controller: DriftPaneController = {
    scan: () => source.scan(),
    openNote: (path) => void app.workspace.openLinkText(path, ""),
  };
  plugin.registerView(DRIFT_VIEW_TYPE, (leaf) => new DriftPaneView(leaf, controller));

  const activate = async (): Promise<void> => {
    const existing = app.workspace.getLeavesOfType(DRIFT_VIEW_TYPE);
    if (existing.length > 0) { app.workspace.revealLeaf(existing[0]); return; }
    const leaf = app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: DRIFT_VIEW_TYPE, active: true });
    app.workspace.revealLeaf(leaf);
  };

  plugin.addRibbonIcon("alert-triangle", "Open JD drift", () => void activate());
  plugin.addCommand({ id: "scheme-drift-open", name: "Scheme: open JD drift", callback: () => void activate() });
}
