// tools-cli-dedicated.ts — dedicated, schema'd tools over PINNED Obsidian CLI
// subcommands, decomposing the opaque `obsidian_cli` proxy (which is now demoted
// behind the default-OFF "Raw CLI proxy" setting; see tools-cli.ts).
//
// Why: the proxy's free-text command string is the root of a whole
// guard-complexity family (#76/#79/#107/#110/#137/#153), and its real usage was
// a handful of commands that deserve first-class tools. Each tool here pins ONE
// subcommand and takes typed arguments, so:
//
//   - the read tools (obsidian_note_history, obsidian_note_diff) take a `path`
//     argument — a recognized path key — so the guard's allowlist check scopes
//     them at the interception point, which the raw proxy could never be
//     (that unscopability was why the proxy refused under any allowlist);
//   - `history:restore` is deliberately NOT promoted to a tool: restoring a
//     prior version can reinstate an accepted value a human revoked, and the
//     restored bytes cannot be scanned pre-exec (#110). It stays reachable only
//     through the raw proxy, where it is denied by default
//     (UNINSPECTABLE_WRITE_CLI_COMMANDS) behind two human-only settings;
//   - the mutating tools register through the guard-patched registrar like any
//     other (read-only mode, queue, journal, kernel args), and
//     obsidian_base_create runs the SAME content accept scan the proxy applies
//     to `base:create` (cliAcceptRefusal — no second definition of "accepted");
//   - plugin install/uninstall keep the proxy's EXACT danger gate: refused
//     unless the human-only "Allow dangerous CLI commands" setting is on
//     (install loads third-party code whose onload() runs immediately;
//     uninstall can remove plugins — including, guarded separately, the governor plugin
//     itself — out from under every connected session).
//
// Transport: the SAME machinery as the proxy — buildCliArgs (vault pinned,
// caller can never name a vault), the shared defaultCliExec (execFile, spawn
// env, timeout + SIGKILL, MAX_BUFFER), the settings deny list
// (cliCommandRefusal), and configPathRefusal on path params. No second exec
// path exists.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, okError, codedError } from "./helpers.js";
import { PLUGIN_ID, LEGACY_PLUGIN_ID } from "../id-migration.js";
import type { ServerCtx } from "./tools-core.js";
import {
  findObsidianBinary,
  buildCliArgs,
  defaultCliExec,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  cliAcceptRefusal,
  type CliExec,
} from "./tools-cli.js";
import { cliCommandRefusal, configPathRefusal } from "./cli-policy.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// Install fetches the community catalog + plugin release from the network.
const RW_INSTALL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const RW_UNINSTALL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const TIMEOUT_MS = z
  .number()
  .int()
  .min(1000)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`Time budget for the CLI call (default ${DEFAULT_TIMEOUT_MS}).`);

/** The exact CLI subcommands these tools pin — exported so tests can assert the
 * set (and that `history:restore` is NOT in it; #110). */
export const DEDICATED_CLI_COMMANDS = {
  obsidian_note_history: "history",
  obsidian_note_diff: "diff",
  obsidian_base_create: "base:create",
  obsidian_plugin_install: "plugin:install",
  obsidian_plugin_uninstall: "plugin:uninstall",
} as const;

// Same message the raw proxy's danger gate emits — one refusal shape for the
// gated set, whichever surface names it.
function dangerRefusal(command: string) {
  return fail(
    `CLI command '${command}' is dangerous (code execution / app control) and is blocked. Enable "Allow dangerous CLI commands" in the Governor settings to permit it.`
  );
}

export function registerCliDedicatedTools(
  server: McpServer,
  ctx: ServerCtx,
  deps?: {
    binary?: string | null;
    exec?: CliExec;
    parseYaml?: (yaml: string) => unknown;
  }
) {
  // Conditional registration at build time, same as the proxy: no CLI binary →
  // none of these tools this session (obsidian_doctor reports the probe).
  const binary = deps?.binary !== undefined ? deps.binary : findObsidianBinary();
  if (!binary) return;
  const exec = deps?.exec ?? defaultCliExec;
  const parseYaml = deps?.parseYaml;

  // One pinned invocation: settings deny list first (a human can deny any of
  // these by name — the guard machinery composes, it is not bypassed), then the
  // exec with the report shape the proxy established. The COMMAND is a
  // compile-time constant here; only typed params vary.
  async function runPinned(
    command: string,
    params: Record<string, string | number | boolean>,
    timeoutMs: number | undefined
  ) {
    const denied = cliCommandRefusal(command, ctx.getSettings().cliPolicy);
    if (denied) return codedError("cli_denied", denied);
    const argv = buildCliArgs({ vaultName: ctx.vaultName, command, params });
    const started = Date.now();
    const res = await exec(binary!, argv, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const report = {
      command,
      exit_code: res.exitCode,
      timed_out: res.timedOut,
      duration_ms: Date.now() - started,
      stdout: res.stdout,
      stderr: res.stderr,
      ...(res.errorMessage ? { error: res.errorMessage } : {}),
      // The CLI binary is a forwarder into the running Obsidian; killing it on
      // timeout does NOT cancel the in-app command.
      ...(res.timedOut
        ? { note: "the command may still have completed inside Obsidian — verify state before retrying" }
        : {}),
    };
    return res.exitCode === 0 ? ok(report) : okError(report);
  }

  server.registerTool(
    "obsidian_note_history",
    {
      title: "List a note's file-history versions",
      description:
        "List the File Recovery version history for one note (pinned CLI `history` subcommand; the vault is pinned). " +
        "Read-only; the path argument is allowlist-scoped like any other path-taking read tool. " +
        "Read a specific version's diff with obsidian_note_diff. There is deliberately NO restore tool: " +
        "restoring a prior version could reinstate an accepted value a human revoked, and the restored bytes " +
        "cannot be inspected pre-exec (#110) — restores stay a human act in Obsidian's File Recovery UI.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path (exact), e.g. 'Inbox/Note.md'."),
        timeout_ms: TIMEOUT_MS,
      },
      annotations: RO,
    },
    async (args: { path: string; timeout_ms?: number }) => {
      try {
        const configReason = configPathRefusal({ path: args.path });
        if (configReason) return codedError("cli_denied", configReason);
        return await runPinned(DEDICATED_CLI_COMMANDS.obsidian_note_history, { path: args.path }, args.timeout_ms);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_note_diff",
    {
      title: "Diff a note's file-history versions",
      description:
        "List or diff File Recovery / Sync versions of one note (pinned CLI `diff` subcommand; the vault is pinned). " +
        "With `from`/`to` version numbers (from obsidian_note_history) it diffs those two versions; with one of them, " +
        "the note against that version; with neither, it lists the versions. Read-only; the path argument is " +
        "allowlist-scoped. Restoring a version is deliberately NOT exposed (#110 — a restore can resurrect revoked " +
        "acceptance); restores stay a human act in Obsidian's File Recovery UI.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path (exact), e.g. 'Inbox/Note.md'."),
        from: z.number().int().min(1).optional().describe("Version number to diff from (see obsidian_note_history)."),
        to: z.number().int().min(1).optional().describe("Version number to diff to."),
        filter: z.enum(["local", "sync"]).optional().describe("Limit versions to one source."),
        timeout_ms: TIMEOUT_MS,
      },
      annotations: RO,
    },
    async (args: { path: string; from?: number; to?: number; filter?: "local" | "sync"; timeout_ms?: number }) => {
      try {
        const configReason = configPathRefusal({ path: args.path });
        if (configReason) return codedError("cli_denied", configReason);
        const params: Record<string, string | number | boolean> = { path: args.path };
        if (args.from !== undefined) params.from = args.from;
        if (args.to !== undefined) params.to = args.to;
        if (args.filter !== undefined) params.filter = args.filter;
        return await runPinned(DEDICATED_CLI_COMMANDS.obsidian_note_diff, params, args.timeout_ms);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_base_create",
    {
      title: "Create an item in a base",
      description:
        "Create a new item (note) in a Bases file (pinned CLI `base:create` subcommand; the vault is pinned). " +
        "Mutating: rides the ordinary write rails (read-only mode, serialized queue, write journal). The initial " +
        "content is scanned with the same accept-forbidden rule as every content write — a frontmatter fence " +
        "asserting acceptance refuses with Error [accept_forbidden]. Refuses while a path allowlist is active: " +
        "the new item's landing folder is decided by the base's own configuration, not by these arguments, so the " +
        "write cannot be path-scoped honestly.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the .base file (exact), e.g. 'Bases/Projects.base'."),
        name: z.string().min(1).describe("Name for the new item (the note the base creates)."),
        content: z.string().optional().describe("Initial content for the new item."),
        view: z.string().optional().describe("Base view name to create the item in."),
        timeout_ms: TIMEOUT_MS,
      },
      annotations: RW,
    },
    async (args: { path: string; name: string; content?: string; view?: string; timeout_ms?: number }) => {
      try {
        const settings = ctx.getSettings();
        if (settings.allowlist.length > 0) {
          return fail(
            "obsidian_base_create is disabled while a path allowlist is active: the new item's landing folder is " +
              "decided by the base's configuration, not by the call's arguments, so the allowlist cannot be enforced on it."
          );
        }
        const params: Record<string, string | number | boolean> = { path: args.path, name: args.name };
        if (args.content !== undefined) params.content = args.content;
        if (args.view !== undefined) params.view = args.view;
        const configReason = configPathRefusal(params);
        if (configReason) return codedError("cli_denied", configReason);
        // The SAME accept-forbidden rule the proxy applies to `base:create`
        // content — the shared path scans it, so this tool does not special-case
        // it out (a base item's initial content can carry a frontmatter fence).
        const acceptReason = cliAcceptRefusal(DEDICATED_CLI_COMMANDS.obsidian_base_create, params, parseYaml);
        if (acceptReason) {
          return codedError(
            "accept_forbidden",
            `${acceptReason}. Acceptance is a human gesture, in no API — this tool will not persist it. ` +
              `Agents write only acceptance-status: proposed; never accepted / accepted-by / accepted-on.`
          );
        }
        return await runPinned(DEDICATED_CLI_COMMANDS.obsidian_base_create, params, args.timeout_ms);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_plugin_install",
    {
      title: "Install a community plugin",
      description:
        "Install a community plugin by id (pinned CLI `plugin:install` subcommand; the vault is pinned). DANGEROUS: " +
        "an installed plugin is third-party code whose onload() runs immediately — the human-only \"Allow dangerous " +
        "CLI commands\" setting must be on, exactly as for the raw proxy's plugin:install. Fetches the community " +
        "catalog and the plugin release from the network. The plugin is installed but NOT enabled — enable it with " +
        "obsidian_plugin_toggle. Refuses while a path allowlist is active (a plugin install cannot be path-scoped).",
      inputSchema: {
        plugin_id: z.string().min(1).describe("Community plugin id, e.g. 'dataview'."),
        timeout_ms: TIMEOUT_MS,
      },
      annotations: RW_INSTALL,
    },
    async (args: { plugin_id: string; timeout_ms?: number }) => {
      try {
        const settings = ctx.getSettings();
        if (settings.allowlist.length > 0) {
          return fail(
            "obsidian_plugin_install is disabled while a path allowlist is active: a plugin install cannot be path-scoped."
          );
        }
        // Deny list before the danger gate — the proxy's ordering, so a command
        // both policy-denied and dangerous refuses identically on both surfaces.
        const denied = cliCommandRefusal(DEDICATED_CLI_COMMANDS.obsidian_plugin_install, settings.cliPolicy);
        if (denied) return codedError("cli_denied", denied);
        if (!settings.allowDangerousCli) return dangerRefusal(DEDICATED_CLI_COMMANDS.obsidian_plugin_install);
        return await runPinned(
          DEDICATED_CLI_COMMANDS.obsidian_plugin_install,
          { id: args.plugin_id },
          args.timeout_ms
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_plugin_uninstall",
    {
      title: "Uninstall a community plugin",
      description:
        "Uninstall a community plugin by id (pinned CLI `plugin:uninstall` subcommand; the vault is pinned). " +
        "DANGEROUS and destructive: removes the plugin's code and settings from the vault — the human-only \"Allow " +
        "dangerous CLI commands\" setting must be on, exactly as for the raw proxy's plugin:uninstall. Refuses to " +
        "uninstall the governor plugin itself (that would sever every connected session). Refuses while a path allowlist is " +
        "active (a plugin uninstall cannot be path-scoped).",
      inputSchema: {
        plugin_id: z.string().min(1).describe("Community plugin id, e.g. 'dataview'."),
        timeout_ms: TIMEOUT_MS,
      },
      annotations: RW_UNINSTALL,
    },
    async (args: { plugin_id: string; timeout_ms?: number }) => {
      try {
        const settings = ctx.getSettings();
        if (settings.allowlist.length > 0) {
          return fail(
            "obsidian_plugin_uninstall is disabled while a path allowlist is active: a plugin uninstall cannot be path-scoped."
          );
        }
        // Deny list before the danger gate — the proxy's ordering (see install).
        const denied = cliCommandRefusal(DEDICATED_CLI_COMMANDS.obsidian_plugin_uninstall, settings.cliPolicy);
        if (denied) return codedError("cli_denied", denied);
        if (!settings.allowDangerousCli) return dangerRefusal(DEDICATED_CLI_COMMANDS.obsidian_plugin_uninstall);
        // Same self-preservation rule as obsidian_plugin_toggle's disable
        // branch: removing the host plugin would sever every connected session.
        // LEGACY_PLUGIN_ID is refused too, for the 0.12.0 grace period: after
        // an in-place update the LIVE folder can still be named `vault-mcp`
        // (folder name ≠ manifest id), and the migration runbook tells the
        // human to delete "the old folder" — an agent must not do that for
        // them through this tool, whichever of the two ids they name.
        if (args.plugin_id === PLUGIN_ID || args.plugin_id === LEGACY_PLUGIN_ID) {
          return fail(
            `refusing to uninstall '${args.plugin_id}' — that is this plugin (or its pre-0.12.0 id, whose folder ` +
              `may still hold un-migrated data); it would sever every connected session. Do it from Obsidian.`,
          );
        }
        return await runPinned(
          DEDICATED_CLI_COMMANDS.obsidian_plugin_uninstall,
          { id: args.plugin_id },
          args.timeout_ms
        );
      } catch (e) {
        return fail(e);
      }
    }
  );
}
