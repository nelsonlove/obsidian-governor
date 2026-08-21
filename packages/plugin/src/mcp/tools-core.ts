// obsidian_resolve and obsidian_get_backlinks have been migrated to
// registerFsTools + ObsidianBackend in server.ts (fs-expressible tools).
// This file retains only obsidian_doctor and obsidian_get_active_note
// (live-only: they use workspace/app state not expressible on the filesystem).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App, TFile } from "obsidian";
import { ok, fail } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import type { ExternalToolEntry } from "./external-tools.js";
import type { Kernel, ModuleSettings, ServerIdentity, VocabInstanceSettings } from "../kernel/index.js";
import { findObsidianBinary } from "./tools-cli.js";
import type { SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import type { CliCommandPolicy } from "./cli-policy.js";

export interface ServerCtx {
  pluginVersion: string;
  socketPath: string;
  vaultName: string;
  /** The plugin's own directory (`<config dir>/plugins/vault-mcp` unless Obsidian's manifest
   * says otherwise) — where plugin-owned state files live (journal, governance). Optional:
   * absent in tests; consumers fall back to the default plugin path. */
  pluginDir?: string;
  enabledPlugins: () => string[];
  /**
   * Guard settings plus policy gates:
   *   `allowDangerousCli`        — obsidian_cli's danger gate.
   *   `trustedReadOnlyPlugins`   — plugin ids whose `readOnlyHint: true` is
   *                                believed. Any other publisher's read-only
   *                                claim is distrusted; see external-tools.ts.
   *   `schemes`                  — scope-provider instance configs (id +
   *                                provider + per-provider config), fed to
   *                                kernel/scheme/registry.ts's makeRegistry.
   *                                Optional here for the same reason the rest
   *                                of this bag is optional: absent in tests
   *                                that don't exercise scheme tools.
   */
  getSettings: () => GuardSettings & {
    allowDangerousCli?: boolean;
    /** Register the raw `obsidian_cli` proxy. DEFAULT OFF — the dedicated
     * pinned-subcommand tools (tools-cli-dedicated.ts / tools-snippets.ts)
     * cover the real usage; the free-text proxy is a surface a human opts
     * back into (Security › "Raw CLI proxy"). */
    rawCliProxy?: boolean;
    trustedReadOnlyPlugins?: string[];
    schemes?: SchemeInstanceConfig[];
    /** Module-host rows (`modules.<id>.enabled` / `.config`) — the mount
     * (mcp/modules-mount.ts) reads these; absent ⇒ every built-in module at
     * its default. */
    modules?: ModuleSettings;
    /** Command policy for obsidian_cli / obsidian_run_command
     * (mcp/cli-policy.ts). Absent ⇒ the defaults: the opaque-accept set
     * denied, everything else allowed. */
    cliPolicy?: CliCommandPolicy;
    /** Record-immutability enforcement (#264). Absent ⇒ ENFORCED: only an
     * explicit `false` disables it, so a caller that never wired the setting
     * fails toward protection. Read live by the per-connection probe. */
    enforceRecordImmutability?: boolean;
  /** Capture the exact bytes a native read returned. Default off — see main.ts. */
  captureObservations?: boolean;
  /** Stopgap ceiling on total captured bytes, pending real retention. */
  captureMaxBytes?: number;
  };
  /** The configured controlled-vocabulary sources (tools-vocab.ts). Optional:
   * absent means the defaults; absent in tests that don't exercise it. */
  getVocabularies?: () => VocabInstanceSettings[];
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
