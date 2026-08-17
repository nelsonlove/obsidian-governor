import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TFile, stringifyYaml, parseYaml, type App } from "obsidian";
import { registerFsTools, ok } from "@vault-mcp/core";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";
import { registerVaultWriteTools } from "./tools-vault-write.js";
import { registerSchemeWriteTools } from "./tools-scheme-write.js";
import { registerComplementaryTools } from "./tools-complementary.js";
import { registerNavTools } from "./tools-nav.js";
import { registerIntegrationTools } from "./tools-integrations.js";
import { registerCliTools, obsidianTemplateReader } from "./tools-cli.js";
import { registerExternalTools } from "./external-tools.js";
import { registerLockTools } from "./tools-locks.js";
import { registerUidTools } from "./tools-uid.js";
import { registerPendingReviewTools, obsidianPendingReviewSource } from "./tools-pending-review.js";
import { registerLinkTools, obsidianLinkSource } from "./tools-links.js";
import { obsidianVocabSource } from "./tools-vocab.js";
import { obsidianSkillsBackend } from "./tools-skills.js";
import { obsidianProvenanceBackend } from "./tools-provenance.js";
import { obsidianHealthBackend } from "./tools-health.js";
import { mountModules } from "./modules-mount.js";
import { FILECLASS_PLUGIN_ID } from "./tools-fileclass.js";
import { registerCodeModeTools, makeCaptureRegister, type CapturedRegistry } from "./tools-code-mode.js";
import { makeGuarded, resolveGuardedPath, withKernelArgs } from "./guarded.js";
import { sealUnguardedRegistration } from "./seal-registration.js";
import { visiblePaths } from "../guard.js";
import type { JournalActor } from "../kernel/index.js";
import { obsidianProbe } from "../kernel/obsidian-probe.js";
import { ObsidianBackend } from "./obsidian-backend.js";
import { registerWriteNotesTool, type GuardedWrite } from "./tools-write-notes.js";
import { uuidv7, formatLocalTimestamp } from "./write-notes-compose.js";
import { makeRegistry, DEFAULT_SCHEMES } from "../kernel/scheme/registry.js";

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
  // Named so obsidian_write_notes' pre-compose resolve (below) can share the
  // IDENTICAL uid/scheme resolution + read-only/allowlist check `guarded`
  // itself applies — not a second copy of it.
  const guardedOpts = {
    getSettings: () => ctx.getSettings(),
    kernel: ctx.kernel,
    actor,
    // `jd:<address>` addressing at the interception point: same per-call
    // freshness as registerSchemeTools's own registry() below (a scheme
    // config edit lands live), and the same notes() source it uses.
    schemes: () => makeRegistry(ctx.getSettings().schemes ?? DEFAULT_SCHEMES),
    schemeNotes: () => app.vault.getMarkdownFiles().map((f) => f.path),
  };
  const guarded = makeGuarded(guardedOpts);
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

  // Patching registerTool alone left FIVE other registration entry points on
  // the SDK server unguarded (#83). Sealing them is what makes module.ts's
  // "no module-specific bypass possible" true by construction rather than by
  // convention — load-bearing because moduleFromRegistrar hands adapted
  // modules the real server, and #83 mounts the accept-veto module here.
  sealUnguardedRegistration(server);

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
  // Hoisted so obsidian_write_notes can drive the same backend writeNote through
  // its own per-item guarded dispatch (see the write-notes block below).
  const backend = new ObsidianBackend(app, visible);
  registerFsTools(server, backend, {
    decodeHtml: false,
    rev: (p) => probe.rev(p),
  });

  // ── remaining tools — live-only, complementary, nav, integrations ────────────
  registerCoreTools(server, app, ctx);
  // ctx carries the guard's settings: obsidian_repoint_link scans the vault for
  // itself, so it must contain that scan by the allowlist on its own — no
  // argument-level check can see a set the handler discovers.
  registerVaultWriteTools(server, app, ctx);
  // ── scope-provider write surface: assign/refile/renumber address ───────────
  // Cannot go through mountModules below: that host's registerAll gate refuses
  // any tool whose readOnlyHint !== true (its own header comment), and these
  // three mutate by design. Registered directly, same shape as
  // registerVaultWriteTools above, and the same registry()/notes() pair the
  // guarded scheme-addressing wiring (guardedOpts, above) already builds.
  registerSchemeWriteTools(server, app, {
    registry: () => makeRegistry(ctx.getSettings().schemes ?? DEFAULT_SCHEMES),
    notes: () => app.vault.getMarkdownFiles().map((f) => f.path),
    getSettings: () => ctx.getSettings(),
  });
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
  // ── pending human-review queue, read-only (slice B3b; #83) ─────────────────
  // A READ of the index Stewardship publishes at
  // `<config dir>/plugins/stewardship/pending-index.json`, so an agent can see
  // what a human is about to review and avoid stepping on it. Allowlist-filtered
  // like tools-uid.ts (no path oracle), and graceful-empty when Stewardship is
  // absent or its queue never refreshed. Read-only by construction: it reports
  // review status another plugin published; it exposes no accept/baseline verb.
  //
  // ALWAYS-ON, decoupled from the governance module toggle (#83 cycle 2 fix).
  // Cycle 1 mounted this THROUGH the governance module, which gated the only MCP
  // read surface behind that module's default-off toggle — a regression. It is
  // restored to an always-on read-only registration so the read surface stays
  // available regardless of whether the (default-off) accept PANE is enabled.
  // The governance module now gates ONLY the Obsidian review pane (wired in
  // main.ts), and contributes ZERO tools to the MCP transport — the accept
  // surface never touches the bridge. See modules-mount.ts's governance module.
  registerPendingReviewTools(server, {
    source: obsidianPendingReviewSource(app),
    getSettings: () => ctx.getSettings(),
  });
  // ── capability modules: scope-provider + vocab + skills ────────────────────
  // Ruled decision #2 realized: the two capability modules register THROUGH
  // the ModuleRegistry — settings-toggleable (`modules.<id>.enabled`), behind
  // the accept/baseline tripwire, collision refusal, and the mount's
  // read-only-only registrar. The registrar handed over is the PATCHED
  // registerTool above, so module tools land at the same guard/queue/journal
  // interception point as every hand-registered tool, in both modes.
  const moduleRegistry = mountModules((name, def, handler) => (server as any).registerTool(name, def, handler), {
    getSettings: () => ctx.getSettings(),
    getVocabularies: ctx.getVocabularies,
    schemeNotes: () => app.vault.getMarkdownFiles().map((f) => f.path),
    vocabSource: obsidianVocabSource(app),
    skillsSource: obsidianSkillsBackend(app),
    provenanceSource: obsidianProvenanceBackend(app),
    healthSource: obsidianHealthBackend(app),
    // The fileclass module (#188) pins the CLI to THIS vault and gates on the
    // Fileclass plugin being LOADED (the instance, not enabledPlugins — a
    // configured-but-uninstalled plugin lingers there, per the plugin-gated-tools
    // locked decision).
    vaultName: ctx.vaultName,
    fileclassPresent: () => !!(app as any).plugins?.plugins?.[FILECLASS_PLUGIN_ID],
  });
  // Skip-and-report only reports if someone reads the report: every mount
  // defect (unknown module id in settings, a gate-refused tool, a config
  // finding) lands loudly in the console rather than evaporating with the
  // discarded registry. console.error, not a throw — a degraded module
  // surface must not cost the connection (the journal's own convention).
  for (const p of moduleRegistry.problems) console.error("[vault-mcp] module host:", p);
  // ── link drift, reported not repaired (slice 2.2) ──────────────────────────
  // Read-only by construction: moves already heal their own links through
  // fileManager.renameFile, so this reports the drift that came from OUTSIDE.
  registerLinkTools(server, obsidianLinkSource(app), ctx);
  // ── official-CLI proxy — conditional on the CLI binary being installed ──────
  // parseYaml is injected for the accept-forbidden guard's content-fence scan;
  // readTemplate for the template guard (create template= / quickadd:run-
  // template path= draw content from a vault note the params only NAME).
  // Both injected so tools-cli.ts stays obsidian-free for headless tests.
  registerCliTools(server, ctx, { parseYaml, readTemplate: obsidianTemplateReader(app) });
  // ── externally-published tools (other Obsidian plugins via plugin.api) ─────
  registerExternalTools(server, app, ctx);

  // ── batch write + server-side stamping (slice B1) ───────────────────────────
  // obsidian_write_notes is a DISPATCHER, not a single mutating op: to give each
  // item its own journal record it drives a per-item guarded single-writer, and
  // to avoid a reentrant queue deadlock it must not itself take a queue slot. So
  // it registers UNGUARDED via origRegister (the obsidian_call_tool precedent)
  // and each item runs through `guardedWrite` — a real makeGuarded wrapper, so
  // uid/read-only/allowlist/if_rev/idempotency/queue/journal all bind per item.
  // Not registered in Code Mode: that surface is the three meta-tools only, and
  // a session there reaches single writes via obsidian_call_tool.
  if (!opts.codeMode) {
    const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const guardedWrite = guarded(
      { title: "write one note", inputSchema: {}, annotations: RW },
      async ({ path, content, overwrite }: { path: string; content: string; overwrite?: boolean }) =>
        ok(await backend.writeNote(path, content, overwrite ?? true)),
      "obsidian_write_notes"
    ) as unknown as GuardedWrite;
    registerWriteNotesTool(origRegister, guardedWrite, {
      // Same resolution + read-only/allowlist check `guarded` applies at
      // dispatch, shared via guardedOpts — see resolveGuardedPath's doc
      // comment and tools-write-notes.ts for why this must run BEFORE compose.
      resolveTarget: (path) => resolveGuardedPath(path, guardedOpts),
      readExistingFrontmatter: (path) => {
        const f = app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? app.metadataCache.getFileCache(f)?.frontmatter ?? undefined : undefined;
      },
      revOf: (path) => probe.rev(path),
      stringifyYaml,
      parseYaml,
      mintUid: (createdMs) => uuidv7(createdMs),
      formatTs: formatLocalTimestamp,
    });
  }

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
