import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { registerFsTools } from "@vault-mcp/core";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";
import { registerVaultWriteTools } from "./tools-vault-write.js";
import { registerComplementaryTools } from "./tools-complementary.js";
import { registerNavTools } from "./tools-nav.js";
import { registerIntegrationTools } from "./tools-integrations.js";
import { registerCliTools } from "./tools-cli.js";
import { registerExternalTools } from "./external-tools.js";
import { registerCodeModeTools, type CapturedRegistry } from "./tools-code-mode.js";
import { guardCall } from "../guard.js";
import { ObsidianBackend } from "./obsidian-backend.js";

export interface BuildOpts {
  /** Code Mode: expose the search/describe/call meta-tool surface instead of the full tool set. */
  codeMode?: boolean;
}

export function buildMcpServer(app: App, ctx: ServerCtx, opts: BuildOpts = {}): McpServer {
  const server = new McpServer({ name: "vault-mcp", version: ctx.pluginVersion });

  // Wrap registerTool so every tool handler is guarded before registration.
  // This monkeypatch fires for ALL registerTool calls that follow, including the
  // 17 fs-expressible tools registered via registerFsTools below — because
  // registerFsTools calls server.registerTool, which is this patched version.
  // Cast origRegister to any to bypass overload signature checking on the wrapped handler.
  //
  // In Code Mode the same interception point CAPTURES each guarded tool into a
  // registry instead of registering it; the three meta-tools registered at the
  // end are the only tools the session sees. The guard wrapper travels with
  // the captured handler, so read-only/allowlist bind identically in both modes.
  const origRegister: any = server.registerTool.bind(server);
  const guarded = (def: any, handler: any) => async (args: any, extra: any) => {
    const isMutating = def?.annotations?.readOnlyHint === false;
    const blocked = guardCall({ isMutating, args: args ?? {}, settings: ctx.getSettings() });
    if (blocked) {
      return { content: [{ type: "text" as const, text: `Error [${blocked.code}]: ${blocked.message}` }], isError: true as const };
    }
    return handler(args, extra);
  };
  const registry: CapturedRegistry = new Map();
  (server as any).registerTool = opts.codeMode
    ? (name: string, def: any, handler: any) => {
        registry.set(name, { def, handler: guarded(def, handler) });
        // Callers ignore the RegisteredTool return value; a stub keeps the shape.
        return { name };
      }
    : (name: string, def: any, handler: any) => origRegister(name, def, guarded(def, handler));

  // ── 17 fs-expressible tools — shared registry + live ObsidianBackend ────────
  // decodeHtml: false — no HTML entities expected from in-process calls.
  // includeIndexStatus omitted — Obsidian's cache is always live; read tools
  // don't need an index_status block.
  registerFsTools(server, new ObsidianBackend(app), { decodeHtml: false });

  // ── remaining tools — live-only, complementary, nav, integrations ────────────
  registerCoreTools(server, app, ctx);
  registerVaultWriteTools(server, app);
  registerComplementaryTools(server, app, ctx);
  registerNavTools(server, app);
  registerIntegrationTools(server, app, ctx);
  // ── official-CLI proxy — conditional on the CLI binary being installed ──────
  registerCliTools(server, ctx);
  // ── externally-published tools (other Obsidian plugins via plugin.api) ─────
  registerExternalTools(server, app, ctx);

  if (opts.codeMode) {
    // Meta-tools register directly (restore the original registerTool): they
    // must NOT be guard-wrapped — obsidian_call_tool would otherwise be blocked
    // wholesale in read-only mode, blocking read tools too. The captured
    // handlers carry the guard, so enforcement happens per target call.
    (server as any).registerTool = origRegister;
    registerCodeModeTools(server, registry);
  }
  return server;
}
