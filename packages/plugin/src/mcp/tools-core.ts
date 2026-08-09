// obsidian_resolve and obsidian_get_backlinks have been migrated to
// registerFsTools + ObsidianBackend in server.ts (fs-expressible tools).
// This file retains only obsidian_doctor and obsidian_get_active_note
// (live-only: they use workspace/app state not expressible on the filesystem).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App, TFile } from "obsidian";
import { ok, fail } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import type { ExternalToolEntry } from "./external-tools.js";
import type { Kernel, ServerIdentity } from "../kernel/index.js";
import { findObsidianBinary } from "./tools-cli.js";

export interface ServerCtx {
  pluginVersion: string;
  socketPath: string;
  vaultName: string;
  enabledPlugins: () => string[];
  /**
   * Guard settings plus policy gates:
   *   `allowDangerousCli`        — obsidian_cli's danger gate.
   *   `trustedReadOnlyPlugins`   — plugin ids whose `readOnlyHint: true` is
   *                                believed. Any other publisher's read-only
   *                                claim is distrusted; see external-tools.ts.
   */
  getSettings: () => GuardSettings & { allowDangerousCli?: boolean; trustedReadOnlyPlugins?: string[] };
  /** Externally-published tools (other Obsidian plugins via plugin.api). Optional: absent in tests that don't exercise it. */
  getExternalTools?: () => ExternalToolEntry[];
  /**
   * Kernel v0: the PLUGIN-SINGLETON write queue + journal. It must be created
   * once in main.ts and shared by every connection's server — a per-connection
   * kernel would serialize nothing, since concurrent sessions are exactly what
   * the queue exists to order. Optional: absent in tests that don't exercise it.
   */
  kernel?: Kernel;
  /**
   * Kernel v0 server identity — `{vault, install, version}`, stamped into every
   * journal record's actor block. Resolved once at plugin load (main.ts);
   * absent in tests that don't exercise it.
   */
  serverIdentity?: ServerIdentity;
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerCoreTools(server: McpServer, app: App, ctx: ServerCtx) {
  server.registerTool(
    "obsidian_doctor",
    {
      title: "Diagnostics",
      description: "Report vault-mcp health: socket path, bound vault, plugin version, and which integration plugins are detected. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const integrations = ["dataview", "templater-obsidian", "omnisearch", "metadata-menu"];
        const enabled = new Set(ctx.enabledPlugins());
        return ok({
          status: "ok",
          vault_name: ctx.vaultName,
          socket_path: ctx.socketPath,
          plugin_version: ctx.pluginVersion,
          integrations: Object.fromEntries(integrations.map((id) => [id, enabled.has(id)])),
          // obsidian_cli registers only when this is non-null — surfaced here so
          // its absence is diagnosable, like the integration gates above.
          cli_binary: findObsidianBinary(),
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_get_active_note",
    {
      title: "Get active note",
      description:
        "Return the currently focused note's path, content, and the current editor selection (if any). Read-only. " +
        "Returns {active: null} when nothing is focused — or when what is focused lies outside your path allowlist.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const file = app.workspace.getActiveFile();
        // The focus is the HUMAN's, not the caller's, and this tool takes no
        // argument the guard could check — so an allowlisted session could read
        // any note simply by asking while its owner had it open. A hidden note
        // reads as "nothing is focused": the same answer, so not even the fact
        // that something is open leaks.
        if (!file || !isVisible(file.path, ctx.getSettings())) return ok({ active: null });
        const content = await app.vault.read(file as TFile);
        // Selection, if a markdown editor is focused.
        let selection: string | null = null;
        const mv = app.workspace.activeEditor;
        if (mv?.editor) selection = mv.editor.getSelection() || null;
        return ok({ active: { path: file.path, content, selection } });
      } catch (e) { return fail(e); }
    }
  );
}
