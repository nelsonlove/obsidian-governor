import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, MarkdownView } from "obsidian";
import { ok, fail, codedError } from "./helpers.js";
import { isVisible } from "../guard.js";
import type { ServerCtx } from "./tools-core.js";

const RO = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ── internal-API helpers ──────────────────────────────────────────────────────
// All access to `internalPlugins`, `internalPlugins.getPluginById`, `.instance.*`,
// `app.plugins.enablePlugin / disablePlugin` is internal / undocumented; cast to
// `any` with a comment at each site.

/** Resolve the "workspaces" internal plugin instance, or null if not enabled. */
function workspacesPlugin(app: App) {
  // internalPlugins is internal — not in public obsidian types.
  return (app as any).internalPlugins?.getPluginById("workspaces")?.instance ?? null;
}

/**
 * Own-property lookup on the plugin registries. They are plain objects, so a
 * raw read answers `constructor` / `toString` truthily — enough for a garbage
 * id to pass an existence check and reach `unloadPlugin`.
 */
function own(map: unknown, key: string): unknown {
  if (map === null || typeof map !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(map, key) ? (map as Record<string, unknown>)[key] : undefined;
}

/**
 * One community plugin's state, keeping apart the two versions that can
 * disagree: `installed_version` is the manifest Obsidian read from disk,
 * `version` is the manifest the loaded instance carries. A rebuild moves the
 * first; only a reload moves the second.
 *
 * `enabled` (configured to run) and `loaded` (running) are likewise distinct —
 * `enabledPlugins` can name a configured-but-uninstalled plugin, so any
 * decision about what is actually there reads `loaded`.
 */
function pluginState(app: App, id: string) {
  // app.plugins.{manifests,plugins,enabledPlugins} are internal — not in public obsidian types.
  const plugins = (app as any).plugins;
  const manifest = (own(plugins?.manifests, id) ?? null) as any;
  const instance = (own(plugins?.plugins, id) ?? null) as any;
  const running: string | null = instance?.manifest?.version ?? null;
  const installed: string | null = manifest?.version ?? null;
  return {
    id,
    name: manifest?.name ?? instance?.manifest?.name ?? id,
    enabled: plugins?.enabledPlugins?.has?.(id) === true,
    loaded: instance !== null && instance !== undefined,
    version: running,
    installed_version: installed,
    stale: running !== null && installed !== null && running !== installed,
    author: manifest?.author ?? null,
    description: manifest?.description ?? null,
    dir: manifest?.dir ?? null,
  };
}

/** Resolve the "bookmarks" internal plugin instance, or null if not enabled. */
function bookmarksPlugin(app: App) {
  // internalPlugins is internal — not in public obsidian types.
  return (app as any).internalPlugins?.getPluginById("bookmarks")?.instance ?? null;
}

// ── Bookmark item shape (internal) ───────────────────────────────────────────
interface BookmarkItem {
  type: string;
  title?: string;
  path?: string;
  items?: BookmarkItem[]; // groups can contain nested items
}

/** Flatten a bookmark tree into a list of leaf items. */
function flattenBookmarks(items: BookmarkItem[]): Array<{ title: string; type: string; path?: string }> {
  const result: Array<{ title: string; type: string; path?: string }> = [];
  for (const item of items) {
    if (item.type === "group" && item.items) {
      result.push(...flattenBookmarks(item.items));
    } else {
      result.push({
        title: item.title ?? item.path ?? "",
        type: item.type,
        path: item.path,
      });
    }
  }
  return result;
}

/** Find the raw bookmark item by display title (recurses into groups). */
function findRawBookmark(items: BookmarkItem[], title: string): BookmarkItem | undefined {
  for (const item of items) {
    if (item.type === "group" && item.items) {
      const found = findRawBookmark(item.items, title);
      if (found) return found;
    } else if ((item.title ?? item.path ?? "") === title) {
      return item;
    }
  }
  return undefined;
}

export function registerNavTools(server: McpServer, app: App, ctx: ServerCtx) {

  // ── obsidian_jump_to ────────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_jump_to",
    {
      title: "Jump to location in a note",
      description:
        "Open a note and scroll to a heading, block reference, or line number. Supply at most one of heading / block / line. Returns {path, jumped:true}.",
      inputSchema: {
        path:    z.string().min(1).describe("Vault-relative path of the note."),
        heading: z.string().optional().describe("Heading text to scroll to (no leading #)."),
        block:   z.string().optional().describe("Block ID to scroll to (no leading ^)."),
        line:    z.number().int().min(1).optional().describe("1-based line number to jump to."),
      },
      annotations: RW,
    },
    async ({ path: p, heading, block, line }) => {
      try {
        // Build the link fragment for heading / block anchors.
        let fragment = "";
        if (heading) fragment = `#${heading}`;
        else if (block) fragment = `#^${block}`;

        // openLinkText handles fragment scrolling natively.
        await app.workspace.openLinkText(p + fragment, "", false);

        // For plain line jumps, move the cursor after the file is open.
        if (line !== undefined) {
          const view = app.workspace.getActiveViewOfType(MarkdownView);
          if (view?.editor) {
            const zeroLine = line - 1;
            view.editor.setCursor({ line: zeroLine, ch: 0 });
            view.editor.scrollIntoView({ from: { line: zeroLine, ch: 0 }, to: { line: zeroLine, ch: 0 } }, true);
          }
        }

        return ok({ path: p, jumped: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_toggle_view_mode ───────────────────────────────────────────────
  server.registerTool(
    "obsidian_toggle_view_mode",
    {
      title: "Toggle view mode",
      description:
        "Switch the active MarkdownView (or the one showing path) to source, preview, or live-preview mode. Returns {mode}.",
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path to target; omit for the currently-active leaf."),
        mode: z.enum(["source", "preview", "live"]).describe('"source" = source mode, "preview" = reading view, "live" = live preview.'),
      },
      annotations: RW,
    },
    async ({ path: p, mode }) => {
      try {
        // Locate the MarkdownView to target.
        let view: MarkdownView | null = null;

        if (p) {
          // Iterate leaves to find one showing the requested path.
          // iterateAllLeaves is public; the leaf's view type guard is safe.
          app.workspace.iterateAllLeaves((leaf) => {
            if (view) return;
            const v = leaf.view;
            if (v instanceof MarkdownView && v.file?.path === p) {
              view = v;
            }
          });
          if (!view) {
            // Open the file if it isn't already visible.
            await app.workspace.openLinkText(p, "", false);
            view = app.workspace.getActiveViewOfType(MarkdownView);
          }
        } else {
          view = app.workspace.getActiveViewOfType(MarkdownView);
        }

        if (!view) return fail(new Error("No MarkdownView available"));

        // setViewState shape: { state: { mode, source } }
        // "source" mode: { mode: "source", source: true }
        // "preview" mode: { mode: "preview", source: false }
        // "live" mode: { mode: "source", source: false }  (live preview is "source" without CM source toggle)
        // leaf.setViewState is public API.
        const leaf = (view as MarkdownView).leaf;
        const curState = leaf.getViewState();
        const newState = {
          ...curState,
          state: {
            ...curState.state,
            mode:   mode === "preview" ? "preview" : "source",
            source: mode === "source",
          },
        };
        await leaf.setViewState(newState);

        return ok({ mode });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_open_workspace ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_open_workspace",
    {
      title: "Open a saved workspace layout",
      description: "Load a named Obsidian workspace layout (requires the core Workspaces plugin to be enabled). Returns {name, opened:true}.",
      inputSchema: {
        name: z.string().min(1).describe("Workspace name to load."),
      },
      annotations: RW,
    },
    async ({ name }) => {
      try {
        const instance = workspacesPlugin(app);
        if (!instance) return fail(new Error("workspaces plugin not enabled"));
        // loadWorkspace is internal — not in public obsidian types.
        (instance as any).loadWorkspace(name);
        return ok({ name, opened: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_save_workspace ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_save_workspace",
    {
      title: "Save current layout as a workspace",
      description: "Save the current Obsidian layout under a name (requires the core Workspaces plugin). Returns {name, saved:true}.",
      inputSchema: {
        name: z.string().min(1).describe("Workspace name to save/overwrite."),
      },
      annotations: RW,
    },
    async ({ name }) => {
      try {
        const instance = workspacesPlugin(app);
        if (!instance) return fail(new Error("workspaces plugin not enabled"));
        // saveWorkspace is internal — not in public obsidian types.
        (instance as any).saveWorkspace(name);
        return ok({ name, saved: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_list_workspaces ────────────────────────────────────────────────
  server.registerTool(
    "obsidian_list_workspaces",
    {
      title: "List saved workspace layouts",
      description: "List all saved workspace layout names (requires the core Workspaces plugin). Read-only. Returns {workspaces: string[]}.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const instance = workspacesPlugin(app);
        if (!instance) return fail(new Error("workspaces plugin not enabled"));
        // instance.workspaces is a Record<string, unknown> — internal.
        const workspaces = Object.keys((instance as any).workspaces ?? {});
        return ok({ workspaces });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_periodic_note ──────────────────────────────────────────────────
  server.registerTool(
    "obsidian_periodic_note",
    {
      title: "Open or create a periodic note",
      description:
        "Open or create a daily / weekly / monthly note. Prefers the community Periodic Notes plugin if enabled; falls back to the core Daily Notes plugin for kind='daily'. Returns {kind, path, created}. FLAG: live verification required — Periodic Notes plugin API shape varies by version.",
      inputSchema: {
        kind:   z.enum(["daily", "weekly", "monthly"]).default("daily"),
        action: z.enum(["open", "create"]).default("open"),
      },
      annotations: RW,
    },
    async ({ kind, action }) => {
      // The periodic note's path comes from another plugin's settings, not from
      // this call's arguments, so the guard cannot check it. Its RESPONSE is
      // contained here — an out-of-allowlist note reports `path: null`, a value
      // this tool already returns on its command-dispatch branches. The note is
      // still opened or created where its owner's settings say; containing the
      // WRITE would need the target resolved before the call, which no stable
      // API offers. Documented in the README's sandbox section.
      const settings = ctx.getSettings();
      const shownPath = (p: string | null | undefined): string | null =>
        p && isVisible(p, settings) ? p : null;
      try {
        // Prefer community Periodic Notes plugin.
        // app.plugins.plugins is internal — not in public obsidian types.
        const periodicPlugin = (app as any).plugins?.plugins?.["periodic-notes"];
        if (periodicPlugin) {
          // The Periodic Notes plugin exposes per-granularity APIs; shape varies by version.
          // Attempt the v0.0.17+ approach: plugin.openNote(granularity, moment()).
          // granularity strings: "day", "week", "month"
          const granularity = kind === "daily" ? "day" : kind === "weekly" ? "week" : "month";
          const pluginInstance = periodicPlugin as any;
          if (typeof pluginInstance.openNote === "function") {
            const file = await pluginInstance.openNote(granularity);
            return ok({ kind, path: shownPath(file?.path), created: action === "create" });
          }
          // Fallback: use commands to open/create via Obsidian command system.
          // Command IDs follow the pattern: "periodic-notes:open-<granularity>-note"
          const cmdId = `periodic-notes:open-${granularity}-note`;
          const executed = (app as any).commands?.executeCommandById(cmdId) as boolean | undefined;
          if (executed !== false) return ok({ kind, path: null, created: false });
        }

        // Fall back to core Daily Notes plugin (only supports daily).
        if (kind !== "daily") {
          return fail(new Error(`kind='${kind}' requires the Periodic Notes community plugin`));
        }

        // Core Daily Notes: prefer the internal plugin's createNewDailyNote() / openDailyNote().
        // internalPlugins is internal — not in public obsidian types.
        const dailyInstance = (app as any).internalPlugins?.getPluginById("daily-notes")?.instance as any;
        if (dailyInstance) {
          if (action === "create" && typeof dailyInstance.createNewDailyNote === "function") {
            const file = await dailyInstance.createNewDailyNote();
            return ok({ kind, path: shownPath(file?.path), created: true });
          }
          // openDailyNote opens or creates and navigates.
          if (typeof dailyInstance.openDailyNote === "function") {
            await dailyInstance.openDailyNote();
            const active = app.workspace.getActiveFile();
            return ok({ kind, path: shownPath(active?.path), created: false });
          }
        }

        // Last resort: run the daily-notes command.
        (app as any).commands?.executeCommandById("daily-notes");
        const active = app.workspace.getActiveFile();
        return ok({ kind, path: shownPath(active?.path), created: false });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_open_bookmark ──────────────────────────────────────────────────
  server.registerTool(
    "obsidian_open_bookmark",
    {
      title: "Open a bookmark",
      description: "Open a bookmark by its title — any type (file, folder, search, graph, group). Requires the core Bookmarks plugin. Returns {name, type, opened:true}.",
      inputSchema: {
        name: z.string().min(1).describe("Bookmark title (exact match)."),
      },
      annotations: RW,
    },
    async ({ name }) => {
      try {
        const instance = bookmarksPlugin(app);
        if (!instance) return fail(new Error("bookmarks plugin not enabled"));

        // instance.items holds the bookmark tree — internal, not in public types.
        const items: BookmarkItem[] = (instance as any).items ?? [];
        const bm = findRawBookmark(items, name);
        // Same rule as the listing, so the two agree about what exists: a
        // bookmark you may not be told about is not one you may open by
        // guessing its title. Identical message, so it discloses nothing.
        if (!bm || (bm.path && !isVisible(bm.path, ctx.getSettings()))) {
          return fail(new Error(`bookmark not found: ${name}`));
        }

        // Delegate to the Bookmarks plugin's own opener, which handles every
        // bookmark type (file/folder/search/graph/group) — not just files.
        await (instance as any).openBookmark(bm, "tab");
        return ok({ name, type: bm.type, opened: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_list_bookmarks ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_list_bookmarks",
    {
      title: "List bookmarks",
      description:
        "Return all bookmarks as a flat list of {title, type, path?} (requires the core Bookmarks plugin). Read-only. " +
        "While a path allowlist is active, bookmarks pointing outside it are omitted.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const instance = bookmarksPlugin(app);
        if (!instance) return fail(new Error("bookmarks plugin not enabled"));

        // instance.items or instance.getBookmarks() — internal; prefer items directly.
        const items: BookmarkItem[] =
          typeof (instance as any).getBookmarks === "function"
            ? (instance as any).getBookmarks()
            : ((instance as any).items ?? []);

        // A bookmark list is an argument-less read of the human's own map of the
        // vault: file and folder bookmarks carry paths, and a file bookmark's
        // default title IS its path. Path-bearing entries outside the allowlist
        // are dropped — pathless ones (searches, graphs) name no note and stay.
        const settings = ctx.getSettings();
        const bookmarks = flattenBookmarks(items).filter((b) => !b.path || isVisible(b.path, settings));
        return ok({ count: bookmarks.length, bookmarks });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_plugin_toggle ──────────────────────────────────────────────────
  server.registerTool(
    "obsidian_plugin_toggle",
    {
      title: "Enable or disable a community plugin",
      description: "Enable or disable a community plugin by its ID. Returns {plugin_id, enabled}.",
      inputSchema: {
        plugin_id: z.string().min(1).describe("Community plugin ID, e.g. 'dataview'."),
        enabled:   z.boolean().describe("true to enable, false to disable."),
      },
      annotations: RW,
    },
    async ({ plugin_id, enabled }) => {
      try {
        // Don't let the MCP disable its own host plugin — it would tear down
        // this connection mid-response. Use Obsidian's settings to disable.
        if (!enabled && plugin_id === "vault-mcp") {
          return fail(new Error("refusing to disable vault-mcp via MCP (it hosts this connection); use Obsidian settings"));
        }
        // app.plugins.enablePlugin / disablePlugin are internal — not in public obsidian types.
        const plugins = (app as any).plugins;
        if (!plugins) return fail(new Error("community plugins manager not available"));
        if (enabled) {
          await (plugins as any).enablePlugin(plugin_id);
        } else {
          await (plugins as any).disablePlugin(plugin_id);
        }
        return ok({ plugin_id, enabled });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_plugin_info ────────────────────────────────────────────────────
  // Answers "what is actually RUNNING", which `obsidian_environment_info` cannot:
  // that reports the manifests on disk. The two disagree for as long as a rebuilt
  // plugin sits unloaded — and a symlinked dev build never touches the folder
  // Obsidian watches, so nothing closes the gap on its own. Exposing the gap is
  // the point of the tool; `obsidian_plugin_reload` below is how you close it.
  server.registerTool(
    "obsidian_plugin_info",
    {
      title: "Community plugin state: loaded vs installed",
      description:
        "Report community plugin state. With plugin_id, one plugin; without it, every installed plugin. " +
        "Each entry is {id, name, enabled, loaded, version, installed_version, stale, author, description, dir}: " +
        "`version` is what the loaded instance is running (null when not loaded), `installed_version` is the " +
        "manifest on disk, and `stale` is true when they disagree — a rebuild that has not been reloaded yet.",
      inputSchema: {
        plugin_id: z.string().min(1).optional()
          .describe("Community plugin ID, e.g. 'dataview'. Omit to report every installed plugin."),
      },
      annotations: RO,
    },
    async ({ plugin_id }) => {
      try {
        // app.plugins.manifests is internal — not in public obsidian types.
        const plugins = (app as any).plugins;
        if (!plugins) return fail(new Error("community plugins manager not available"));
        const manifests = plugins.manifests ?? {};
        if (plugin_id) {
          if (own(manifests, plugin_id) === undefined) {
            return codedError("plugin_not_found", `no community plugin with id '${plugin_id}' is installed`);
          }
          return ok({ plugin: pluginState(app, plugin_id) });
        }
        const ids = Object.keys(manifests).sort();
        return ok({ count: ids.length, plugins: ids.map((id) => pluginState(app, id)) });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_plugin_reload ──────────────────────────────────────────────────
  // Disable + enable, the same pair the Hot Reload plugin uses. Mutating, so it
  // takes a queue slot and journals `plugin:<id>` through the generic REF_KEYS
  // fallback, exactly like obsidian_plugin_toggle.
  server.registerTool(
    "obsidian_plugin_reload",
    {
      title: "Reload one community plugin",
      description:
        "Disable then re-enable a community plugin so a rebuilt main.js takes effect, re-reading the " +
        "manifests first so a bumped version is picked up too. The plugin must already be loaded. " +
        "Returns {plugin_id, reloaded, manifests_reloaded, version} — the version now running. " +
        "A plugin that fails to come back is reported as an error saying it is now OFF, never as a reload.",
      inputSchema: {
        plugin_id: z.string().min(1).describe("Community plugin ID, e.g. 'obsidian-meta-bind-plugin'."),
      },
      annotations: RW,
    },
    async ({ plugin_id }) => {
      try {
        // Reloading the host plugin tears down the connection carrying this
        // response — same reasoning as obsidian_plugin_toggle's disable refusal.
        if (plugin_id === "vault-mcp") {
          return codedError("reload_refused", "refusing to reload vault-mcp via MCP (it hosts this connection); reload it from Obsidian's settings");
        }
        // app.plugins.{manifests,plugins,loadManifests,disablePlugin,enablePlugin} are internal.
        const plugins = (app as any).plugins;
        if (!plugins) return fail(new Error("community plugins manager not available"));
        if (own(plugins.manifests, plugin_id) === undefined) {
          return codedError("plugin_not_found", `no community plugin with id '${plugin_id}' is installed`);
        }
        // Gate on the LOADED instance, not enabledPlugins: that set can name a
        // configured-but-uninstalled plugin, and there is nothing to reload
        // when nothing is running.
        if (own(plugins.plugins, plugin_id) === undefined) {
          return codedError("plugin_not_loaded", `'${plugin_id}' is installed but not loaded; enable it with obsidian_plugin_toggle`);
        }
        // A rebuild can change manifest.json too, and disable/enable alone
        // re-runs the manifest Obsidian read at startup. Reported rather than
        // assumed: on a host without it, a version bump is NOT picked up, and
        // the caller should be told which of the two reloads it got.
        const manifests_reloaded = typeof plugins.loadManifests === "function";
        if (manifests_reloaded) await plugins.loadManifests();
        // The re-read can drop the id — a rebuild that truncates manifest.json
        // mid-write is exactly the situation this tool is used in. Enabling a
        // plugin Obsidian no longer has a manifest for is not a reload.
        if (own(plugins.manifests, plugin_id) === undefined) {
          return codedError("plugin_not_found", `'${plugin_id}' vanished from the manifests when they were re-read (a broken or half-written manifest.json?); it is still loaded and was NOT disabled`);
        }

        await plugins.disablePlugin(plugin_id);
        // Obsidian SWALLOWS a throwing onunload: disablePlugin catches, shows a
        // Notice, and leaves the instance in `plugins.plugins`. Enabling over
        // the top would run two copies, the older one unreachable and still
        // wired to its events — so stop here instead, with the plugin in the
        // state the failure left it (loaded, old build).
        if (own(plugins.plugins, plugin_id) !== undefined) {
          return codedError("unload_failed", `'${plugin_id}' did not unload (its onunload threw — see the developer console); it was NOT re-enabled, because loading a second instance over a live one leaves both running`);
        }

        let enabled: unknown;
        try {
          enabled = await plugins.enablePlugin(plugin_id);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          return codedError("reload_failed", `'${plugin_id}' was disabled but failed to re-enable, and is now OFF: ${why}`);
        }
        // enablePlugin RESOLVES FALSE on failure rather than throwing — it
        // catches the load error itself and reports it as a Notice. Checking
        // only for a throw would return success for a plugin now switched off,
        // so the post-state is what decides.
        const instance = own(plugins.plugins, plugin_id) as any;
        if (enabled === false || instance === undefined) {
          return codedError("reload_failed", `'${plugin_id}' was disabled but did not come back, and is now OFF (a failed load, an isDesktopOnly/minAppVersion mismatch, or a deprecated plugin — see the developer console)`);
        }
        return ok({ plugin_id, reloaded: true, manifests_reloaded, version: instance?.manifest?.version ?? null });
      } catch (e) { return fail(e); }
    }
  );
}
