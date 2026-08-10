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
import { registerLockTools } from "./tools-locks.js";
import { registerUidTools } from "./tools-uid.js";
import { registerLinkTools, obsidianLinkSource } from "./tools-links.js";
import { registerVocabTools, obsidianVocabSource } from "./tools-vocab.js";
import { registerCodeModeTools, makeCaptureRegister, type CapturedRegistry } from "./tools-code-mode.js";
import { makeGuarded, withKernelArgs } from "./guarded.js";
import { visiblePaths } from "../guard.js";
import type { JournalActor } from "../kernel/index.js";
import { obsidianProbe } from "../kernel/obsidian-probe.js";
import { ObsidianBackend } from "./obsidian-backend.js";

export interface BuildOpts {
  /** Code Mode: expose the search/describe/call meta-tool surface instead of the full tool set. */
  codeMode?: boolean;
}

// Per-connection id for the journal's actor block. Monotonic within a plugin
// load; the load-time epoch keeps ids from colliding across plugin reloads.
let connSeq = 0;
const CONN_EPOCH = Date.now().toString(36);

export function buildMcpServer(app: App, ctx: ServerCtx, opts: BuildOpts = {}): McpServer {
  // serverInfo, as returned by `initialize`. `title` carries the vault name so a
  // client with two vault-mcp servers attached can tell them apart at the
  // handshake, without a tool call — the same assertion the journal's
  // `actor.server` makes, made once at connect time.
  const server = new McpServer({
    name: "vault-mcp",
    version: ctx.pluginVersion,
    ...(ctx.vaultName ? { title: `vault-mcp (${ctx.vaultName})` } : {}),
  });
  const connectionId = `${CONN_EPOCH}-${++connSeq}`;

  // Wrap registerTool so every tool handler is guarded before registration.
  // This monkeypatch fires for ALL registerTool calls that follow, including the
  // 17 fs-expressible tools registered via registerFsTools below — because
  // registerFsTools calls server.registerTool, which is this patched version.
  // Cast origRegister to any to bypass overload signature checking on the wrapped handler.
  //
  // The same wrapper also routes MUTATING calls through the plugin-singleton
  // write queue and the write journal (ctx.kernel) — one interception point, so
  // the guarded set, the serialized set, and the journaled set are the same set
  // by construction.
  //
  // In Code Mode the same interception point CAPTURES each guarded tool into a
  // registry instead of registering it; the three meta-tools registered at the
  // end are the only tools the session sees. The guard wrapper travels with
  // the captured handler, so read-only/allowlist bind identically in both modes.
  const origRegister: any = server.registerTool.bind(server);
  // Resolved per call, not once: the MCP client's identity only exists after
  // the initialize handshake, which happens well after the server is built.
  // `server` is the transport's own assertion — which vault, which install,
  // which version — and is resolved once at load, not per call.
  const actor = (): JournalActor => {
    const info = (server.server as any)?.getClientVersion?.();
    const client = info?.name ? (info.version ? `${info.name}/${info.version}` : String(info.name)) : undefined;
    return {
      transport: "mcp",
      ...(client ? { client } : {}),
      connection: connectionId,
      ...(ctx.serverIdentity ? { server: ctx.serverIdentity } : {}),
    };
  };
  const guarded = makeGuarded({ getSettings: () => ctx.getSettings(), kernel: ctx.kernel, actor });
  const registry: CapturedRegistry = new Map();
  const capture = makeCaptureRegister(registry, guarded);
  const register = opts.codeMode
    ? capture
    : (name: string, def: any, handler: any) => origRegister(name, def, guarded(def, handler, name));
  // withKernelArgs runs on the way in, so `if_rev` / `idempotency_key` are
  // declared on every mutating tool's schema — in both modes, and for external
  // tools too — without any registrar knowing they exist. Undeclared arguments
  // are stripped by the SDK's own validation, so declaring here is what makes
  // them reachable by a client at all.
  (server as any).registerTool = (name: string, def: any, handler: any) =>
    register(name, withKernelArgs(def), handler);

  // ── 17 fs-expressible tools — shared registry + live ObsidianBackend ────────
  // decodeHtml: false — no HTML entities expected from in-process calls.
  // includeIndexStatus omitted — Obsidian's cache is always live; read tools
  // don't need an index_status block.
  // rev: the same mtime token the journal records, so a read hands back exactly
  // what a following write can pass as `if_rev`.
  //
  // The backend also carries the READ BOUNDARY (slice 3.0): six of its methods
  // enumerate the vault with no path to guard, so they filter their own
  // iteration through the allowlist. The filter is resolved per call, like the
  // guard's own settings, so a settings change lands without a reconnect.
  const probe = obsidianProbe(app);
  const visible = (paths: string[]) => visiblePaths(paths, ctx.getSettings());
  registerFsTools(server, new ObsidianBackend(app, visible), {
    decodeHtml: false,
    rev: (p) => probe.rev(p),
  });

  // ── remaining tools — live-only, complementary, nav, integrations ────────────
  registerCoreTools(server, app, ctx);
  // ctx carries the guard's settings: obsidian_repoint_link scans the vault for
  // itself, so it must contain that scan by the allowlist on its own — no
  // argument-level check can see a set the handler discovers.
  registerVaultWriteTools(server, app, ctx);
  registerComplementaryTools(server, app, ctx);
  // ctx: obsidian_list_bookmarks enumerates paths the human bookmarked, which
  // is another argument-less read of vault structure.
  registerNavTools(server, app, ctx);
  registerIntegrationTools(server, app, ctx);
  // ── advisory scope claims (kernel v0) ──────────────────────────────────────
  // Registered here, after the interception patch, so a claim is guarded,
  // serialized and journaled like any other mutating operation — the claim is
  // itself an act the audit stream should record.
  registerLockTools(server, ctx, actor);
  // ── the uid index's read surface (identity substrate, Delivery step 2) ─────
  // Addressing by uid needs no tool of its own — `uid:<value>` binds at the
  // interception point above — so this is purely the lookup, in both directions.
  registerUidTools(server, ctx);
  // ── link drift, reported not repaired (slice 2.2) ──────────────────────────
  // Read-only by construction: moves already heal their own links through
  // fileManager.renameFile, so this reports the drift that came from OUTSIDE.
  registerLinkTools(server, obsidianLinkSource(app), ctx);
  // ── the controlled vocabulary's read surface (step 5, vocab provider) ──────
  // Validation and resolution only — the enforcement ladder is a later slice,
  // and the whole-vault rule pack (kernel/vocab/findings.ts) is not a tool.
  registerVocabTools(server, obsidianVocabSource(app), {
    getSettings: ctx.getSettings,
    getVocabularies: ctx.getVocabularies,
  });
  // ── official-CLI proxy — conditional on the CLI binary being installed ──────
  registerCliTools(server, ctx);
  // ── externally-published tools (other Obsidian plugins via plugin.api) ─────
  registerExternalTools(server, app, ctx);

  if (opts.codeMode) {
    // Meta-tools register through origRegister directly: they must NOT be
    // guard-wrapped — obsidian_call_tool would otherwise be blocked wholesale
    // in read-only mode, blocking read tools too. The captured handlers carry
    // the guard — and the queue and journal — so enforcement happens per target
    // call. That also keeps the queue non-reentrant: obsidian_call_tool itself
    // never takes a queue slot, so its target can't wait on its own caller.
    // The capture patch is
    // deliberately LEFT INSTALLED: any post-build registration still lands in
    // the registry, guarded — the "every registerTool call is guarded" locked
    // invariant holds in both modes for the server's whole lifetime.
    registerCodeModeTools(server, registry, origRegister);
  }
  return server;
}
