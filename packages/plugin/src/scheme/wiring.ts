// Wiring for the scheme Inbox and Drift panes (jd-dashboard fold, Stages B
// and C). Both are read-only chrome: no MCP tool, no write capability, no
// gesture gate — the same trust boundary as Obsidian's own file explorer,
// which is why (unlike an MCP tool's `ctx.notes()`) the Inbox pane reads
// `app.vault` directly rather than going through the MCP path-visibility
// allowlist (guard.ts's `visiblePaths`). That allowlist bounds what an
// MCP-connected AGENT can reach; a human's own sidebar in their own Obsidian
// is not that boundary. (The Drift pane's equivalent — the conformance
// engine's own `excludedRoots` config — is handled inside `runConformance`
// itself, via `obsidian-drift-source.ts`; nothing extra needed here.)
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
//
// LIVE MOUNT/UNMOUNT (fixes governor#286, filed against the original,
// onload-only shape of this file): both views + ribbons register on a
// shared child `Component` (`plugin.addChild`) that `wireSchemePanes`
// returns — a live unmount is `plugin.removeChild(it)`, which detaches any
// open leaves, unregisters both view types, and removes both ribbon
// elements. This mirrors `governance/wiring.ts`'s `wireGovernance` exactly
// (the fix pattern #286 pointed at, itself from #200) — a plugin-toggle
// flip is no longer a "nothing happened until I reload" surprise, and
// disabling the module no longer leaves a registered view type + a live
// leaf pointing at a torn-down mount. Commands are the one piece that stays
// OUTSIDE the component: Obsidian's public API has no `removeCommand`, so
// (matching every other wiring file in this plugin — none live-unregisters
// a command) they register once, unconditionally, at onload, and each
// callback checks the CURRENT enabled state before activating — a stale
// command while the module is off shows a Notice instead of silently
// trying to open an unregistered view type.

import { type App, Component, type Plugin, Notice, TFolder } from "obsidian";
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

/** Best-effort access to Obsidian's internal view registry — the ONE thing
 *  `plugin.registerView` only tears down at plugin unload, so a LIVE
 *  unmount must unregister the type itself (its public wrapper offers no
 *  un-register). Duplicated from governance/wiring.ts's own private helper
 *  of the same name/shape, rather than exported and shared, matching this
 *  file's existing precedent of small per-file helpers (e.g. `vaultRoot` in
 *  mcp/obsidian-drift-source.ts / mcp/obsidian-debt-source.ts). An Obsidian
 *  build without it degrades to "leave the type registered", handled by the
 *  reuse-on-duplicate try/catch below. */
function viewRegistryOf(plugin: Plugin): { unregisterView(type: string): void } | undefined {
  const vr = (plugin.app as unknown as { viewRegistry?: { unregisterView?: (type: string) => void } }).viewRegistry;
  return typeof vr?.unregisterView === "function" ? (vr as { unregisterView(type: string): void }) : undefined;
}

async function activateView(app: App, viewType: string): Promise<void> {
  const existing = app.workspace.getLeavesOfType(viewType);
  if (existing.length > 0) { app.workspace.revealLeaf(existing[0]); return; }
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: viewType, active: true });
  app.workspace.revealLeaf(leaf);
}

export interface WireSchemePanesOpts {
  /** The vault's configured scheme instances, read fresh per call — mirrors
   *  server.ts's own `schemes: () => makeRegistry(...)` (a cheap, pure,
   *  rebuild-don't-cache factory), so a settings-tab edit to `excludedRoots`
   *  takes effect on the Inbox pane's next refresh without a plugin reload. */
  getSchemes: () => SchemeInstanceConfig[];
}

/** Mount both panes on one shared child Component — they're gated by the
 *  same "scheme" module toggle and always mount/unmount together, so one
 *  Component (one `removeChild` call) is a complete teardown of both. */
export function wireSchemePanes(plugin: Plugin, opts: WireSchemePanesOpts): Component {
  const app = plugin.app;
  const component = new Component();
  plugin.addChild(component);

  // ── Inbox pane ──────────────────────────────────────────────────────────
  const inboxController: InboxPaneController = {
    notes: () => {
      const notes = app.vault.getMarkdownFiles().map((f) => f.path);
      const roots = makeRegistry(opts.getSchemes())
        .instances()
        .flatMap((inst) => inst.excludedRoots ?? []);
      return excludeRoots(notes, roots.length ? roots : undefined);
    },
    revealFolder: (path) => revealFolder(app, path),
  };
  try {
    plugin.registerView(INBOX_VIEW_TYPE, (leaf) => new InboxPaneView(leaf, inboxController));
  } catch (e) {
    console.warn("[governor] scheme inbox view type already registered — reusing it", e);
  }
  component.register(() => {
    for (const leaf of app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) leaf.detach();
    try { viewRegistryOf(plugin)?.unregisterView(INBOX_VIEW_TYPE); }
    catch (e) { console.warn("[governor] scheme inbox view unregister failed", e); }
  });
  const inboxRibbon = plugin.addRibbonIcon("inbox", "Open JD inboxes", () => void activateView(app, INBOX_VIEW_TYPE));
  component.register(() => inboxRibbon.remove());

  // ── Drift pane ──────────────────────────────────────────────────────────
  const driftSource = obsidianDriftSource(app);
  const driftController: DriftPaneController = {
    scan: () => driftSource.scan(),
    openNote: (path) => void app.workspace.openLinkText(path, ""),
  };
  try {
    plugin.registerView(DRIFT_VIEW_TYPE, (leaf) => new DriftPaneView(leaf, driftController));
  } catch (e) {
    console.warn("[governor] scheme drift view type already registered — reusing it", e);
  }
  component.register(() => {
    for (const leaf of app.workspace.getLeavesOfType(DRIFT_VIEW_TYPE)) leaf.detach();
    try { viewRegistryOf(plugin)?.unregisterView(DRIFT_VIEW_TYPE); }
    catch (e) { console.warn("[governor] scheme drift view unregister failed", e); }
  });
  const driftRibbon = plugin.addRibbonIcon("alert-triangle", "Open JD drift", () => void activateView(app, DRIFT_VIEW_TYPE));
  component.register(() => driftRibbon.remove());

  return component;
}

/** Registered once, unconditionally, regardless of live mount state —
 *  Obsidian's public API has no `removeCommand`, so (matching every other
 *  wiring file in this plugin) these are never live-unregistered. Each
 *  callback checks `isEnabled()` itself before activating, so a command
 *  invoked while the module is off degrades to a Notice instead of trying
 *  to open a view type that isn't currently registered. */
export function registerSchemeCommands(plugin: Plugin, isEnabled: () => boolean): void {
  const app = plugin.app;
  const guarded = (viewType: string, label: string) => async (): Promise<void> => {
    if (!isEnabled()) { new Notice(`Governor: the scheme module is disabled — enable it in settings to open ${label}.`); return; }
    await activateView(app, viewType);
  };
  plugin.addCommand({ id: "scheme-inbox-open", name: "Scheme: open JD inboxes", callback: () => void guarded(INBOX_VIEW_TYPE, "JD inboxes")() });
  plugin.addCommand({ id: "scheme-drift-open", name: "Scheme: open JD drift", callback: () => void guarded(DRIFT_VIEW_TYPE, "JD drift")() });
}
