/**
 * fs-mode.ts — stateless FS-mode MCP handler factory.
 *
 * Extracts the per-request MCP handling from index.ts into a reusable factory
 * so the unified front (Task 5) can call it when Obsidian is offline.
 *
 * Usage:
 *   const fs = createFsHandler();
 *   await fs.ready();         // one-time: buildIndex + startVaultWatcher
 *   app.post("/mcp", (req, res) => fs.handle(req, res));
 *   // on shutdown:
 *   await fs.stop();          // closes the vault watcher
 *
 * The factory is behavior-preserving: handle() reproduces the per-request
 * logic that index.ts:buildServer() + the POST /mcp handler used to inline.
 * Response shapes are identical.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import {
  listNotes,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  findByTag,
  vaultRoot,
  getFrontmatterField,
  setFrontmatterField,
  deleteFrontmatterField,
  patchNote,
  deleteNote,
  moveNote,
  listFolders,
  buildIndex,
  indexStatus,
  resolveRefs,
  getBacklinks,
  getOutlinks,
  searchByFrontmatter,
  startVaultWatcher,
  registerFsTools,
} from "@vault-mcp/core";
import type { VaultBackend, VaultWatcherHandle } from "@vault-mcp/core";
import path from "node:path";
import { FsWriteKernel, defaultJournalDir } from "./fs-write-kernel.js";

/** This server's version, as asserted in MCP serverInfo and journal identity. */
const SERVER_VERSION = "1.0.0";

// ── Public interface ──────────────────────────────────────────────────────────

export interface FsHandler {
  /** Per-request handler: builds a fresh stateless McpServer and serves it. */
  handle(req: express.Request, res: express.Response): Promise<void>;

  /**
   * One-time startup: runs buildIndex() + startVaultWatcher(). Idempotent —
   * calling twice returns the same Promise without rebuilding.
   */
  ready(): Promise<void>;

  /**
   * Close the vault watcher. Must be called in tests to avoid open handles.
   * Idempotent; resolves immediately if ready() was never called or the
   * watcher failed to start.
   */
  stop(): Promise<void>;
}

export interface FsHandlerOpts {
  /**
   * When true (the default), pass `indexStatus` to registerFsTools so every
   * read-tool response includes an `index_status` block. Set to false to
   * suppress it (e.g., when the live Obsidian backend is active).
   */
  indexStatus?: boolean;
  /**
   * Explicit override for whether FS-mode writes are permitted (issue #92).
   * Omitted (the normal case) ⇒ resolved from `isFsWritesEnabled()` (the
   * `VAULT_MCP_FS_ALLOW_WRITES` env var) at the moment `buildFsServer()`
   * constructs the backend — so every FS-server entry point picks up the
   * same deployment-wide setting without being wired individually. The
   * granularity differs by caller: `createFsHandler().handle()` calls
   * `buildFsServer(opts)` fresh per HTTP request, so it re-reads the env var
   * every time; `semantic-proxy.ts`'s `getFsClient()` builds its FS backend
   * once and caches it for the process's lifetime (until `stop()`), so a
   * mid-process env var change there only takes effect after a restart. Set
   * `allowWrites` explicitly only for tests or callers that need a value
   * independent of the env var.
   */
  allowWrites?: boolean;
  /**
   * Explicit FsWriteKernel override (tests). Omitted ⇒ the process-wide
   * singleton from getFsWriteKernel(), which is what gives FS-mode writes
   * cross-connection serialization — every per-request server built by this
   * factory shares the one queue and the one journal.
   */
  kernel?: FsWriteKernel;
}

// ── FS-mode write gate + write kernel (issue #92) ───────────────────────────
//
// FS-fallback mode used to have no journal and no serialized write queue:
// those live in the plugin's kernel (packages/plugin/src/kernel/), and
// packages/server depends on @vault-mcp/core + third-party only — it does not,
// and must not, depend on packages/plugin. That gap is now closed at the
// queue+journal level by fs-write-kernel.ts, a lean server-local counterpart:
// every FS-mode mutation runs through one process-wide FIFO queue and appends
// exactly one JSONL record to the server-side journal
// (`~/.claude/vault-mcp/journal/<slug>/YYYY-MM.jsonl` by default).
//
// The opt-in gate REMAINS, because journal+queue is not full kernel parity:
// FS-mode writes still bypass the plugin kernel's governance surface (if_rev
// preconditions, idempotency keys, advisory locks, the pending-review flow),
// and serialization is in-process only — nothing here can serialize against a
// concurrently running Obsidian or a second server process. Writes are
// refused by default, with a typed refusal that names the residual gap and
// how to opt in. Reads are never gated — FS-mode read fallback keeps working
// exactly as before.

/**
 * The process-wide FS write kernel — lazy, so a read-only FS session (or a
 * deployment that never opts into FS writes) creates nothing. Env-derived
 * configuration (journal dir, vault name) is read once at first use and cached
 * for the process's lifetime, same convention as semantic-proxy's cached FS
 * backend.
 */
let processKernel: FsWriteKernel | null = null;

export function getFsWriteKernel(): FsWriteKernel {
  if (!processKernel) {
    const vaultName = path.basename(vaultRoot());
    processKernel = new FsWriteKernel({
      journalDir: defaultJournalDir(vaultName),
      identity: { vault: vaultName, version: SERVER_VERSION },
      resolvePath: (relPath) => path.join(vaultRoot(), relPath),
    });
  }
  return processKernel;
}

/** Env var that opts a deployment into FS-mode writes. Unset/falsy ⇒ refused. */
export const FS_WRITES_ENV_VAR = "VAULT_MCP_FS_ALLOW_WRITES";

/**
 * True if `VAULT_MCP_FS_ALLOW_WRITES` is set to a truthy value. Read from
 * process.env at call time (same convention as auth.ts's
 * `isAllowAnyAuthenticated` / front.ts's `VAULT_MCP_SEAMLESS` parsing) so
 * entrypoints and tests can check it after startup.
 */
export function isFsWritesEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env[FS_WRITES_ENV_VAR] ?? "").trim().toLowerCase(),
  );
}

/**
 * Typed refusal for a write attempted in FS-fallback mode without opting in —
 * rendered as `Error [fs_writes_disabled]: …` by core's `fail()`. The message
 * explains the gap and how to enable it deliberately; it names no vault path
 * and no configuration value the caller isn't already entitled to (the env
 * var name is documentation, not a secret).
 */
export class FsWritesDisabledError extends Error {
  readonly code = "fs_writes_disabled";
  constructor() {
    super(
      "FS-fallback mode is a degraded write path: Obsidian is offline, so there is no plugin " +
        "kernel to route through. FS-mode writes are serialized in-process and journaled to the " +
        "server-side write journal, but they still bypass the kernel's governance surface " +
        "(if_rev preconditions, idempotency keys, advisory locks, pending review) and cannot be " +
        `serialized against other processes. Refused by default. Set ${FS_WRITES_ENV_VAR}=true ` +
        "to opt in deliberately, understanding that writes made this way carry only queue+journal " +
        "guarantees until Obsidian reconnects and LIVE mode resumes.",
    );
    this.name = "FsWritesDisabledError";
  }
}

// ── VaultBackend adapter ──────────────────────────────────────────────────────
//
// Wraps the module-level singleton functions from @vault-mcp/core so that
// registerFsTools can drive them through the VaultBackend interface. The
// singletons are pinned to VAULT_PATH at process start, which is the same
// root the vault watcher uses — keeping the index consistent.

export function makeBackend(
  opts: { allowWrites?: boolean; kernel?: FsWriteKernel } = {},
): VaultBackend {
  const allowWrites = opts.allowWrites ?? isFsWritesEnabled();
  const requireWrites = (): void => {
    if (!allowWrites) throw new FsWritesDisabledError();
  };

  /**
   * Route one mutating operation through the FS write kernel (issue #92):
   * gate first (a refusal runs nothing, so — like the plugin's pre-queue
   * refusals — it is not journaled), then queue + journal. The kernel resolves
   * lazily so a read-only session never instantiates it; the default is the
   * process-wide singleton, which is what serializes writes ACROSS the
   * stateless per-request servers this factory builds.
   */
  const mutate = <T>(
    op: string,
    target: { path?: string; paths?: string[] },
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    requireWrites();
    const kernel = opts.kernel ?? getFsWriteKernel();
    return kernel.runMutation(op, target, args, fn);
  };

  return {
    listNotes: (subdir, limit, offset) => listNotes(subdir, limit, offset),

    listFolders: (subdir) => listFolders(subdir),

    readNote: (relPath) => readNote(relPath),

    searchNotes: (query, limit, mode) => searchNotes(query, limit, mode),

    findByTag: (tag, limit) => findByTag(tag, limit),

    searchByFrontmatter: async (property, value) => {
      const matches = searchByFrontmatter(property, value);
      return matches.map((n) => ({ path: n.path, frontmatter: n.frontmatter }));
    },

    resolve: (refs) => Promise.resolve(resolveRefs(refs)),

    getBacklinks: (notePath) => Promise.resolve(getBacklinks(notePath)),

    getOutlinks: (notePath) => Promise.resolve(getOutlinks(notePath)),

    forceReindex: () => buildIndex(),

    manageFrontmatter: async (relPath, key, op, value) => {
      if (op === "get") {
        return { value: await getFrontmatterField(relPath, key) };
      }
      // op names are the MCP tool names, so the FS journal greps like the
      // plugin's (only `set`/`delete` reach here — `get` returned above and,
      // like every read, is never queued and never journaled).
      return mutate(
        "obsidian_manage_frontmatter",
        { path: relPath },
        { path: relPath, key, op, ...(value !== undefined ? { value } : {}) },
        async () => {
          if (op === "delete") {
            return deleteFrontmatterField(relPath, key);
          }
          // op === "set"
          if (value === undefined) {
            throw new Error("`value` is required for op='set'");
          }
          return setFrontmatterField(relPath, key, value);
        },
      );
    },

    patchNote: async (relPath, anchor, op, content) =>
      mutate(
        "obsidian_patch_note",
        { path: relPath },
        { path: relPath, anchor, op, content },
        () => patchNote(relPath, anchor, op, content),
      ),

    writeNote: async (relPath, content, overwrite) =>
      mutate(
        "obsidian_write_note",
        { path: relPath },
        { path: relPath, content, overwrite },
        () => writeNote(relPath, content, overwrite),
      ),

    appendNote: async (relPath, content) =>
      mutate(
        "obsidian_append_note",
        { path: relPath },
        { path: relPath, content },
        () => appendNote(relPath, content),
      ),

    moveNote: async (fromRel, toRel, options) =>
      mutate(
        "obsidian_move_note",
        { path: fromRel, paths: [fromRel, toRel] },
        {
          from: fromRel,
          to: toRel,
          update_backlinks: options.update_backlinks,
          overwrite: options.overwrite,
        },
        () =>
          moveNote(fromRel, toRel, {
            update_backlinks: options.update_backlinks,
            overwrite: options.overwrite,
            backlinks_provider: getBacklinks,
            resolve_ref: (ref: string) => resolveRefs([ref])[0]?.path,
          }),
      ),

    deleteNote: async (relPath, confirm) =>
      mutate(
        "obsidian_delete_note",
        { path: relPath },
        { path: relPath, confirm },
        () => deleteNote(relPath, confirm),
      ),
  };
}

// ── Server factory ────────────────────────────────────────────────────────────
//
// Exported so tests can build a server and wire it over InMemoryTransport
// without standing up a full Express + HTTP stack.

export function buildFsServer(opts?: FsHandlerOpts): McpServer {
  const server = new McpServer(
    { name: "obsidian-vault-mcp-server", version: SERVER_VERSION },
    // listChanged: true is required by Phase 2b (notifications/tools/list_changed);
    // harmless in Phase 2a but declared now so the capability is advertised.
    { capabilities: { tools: { listChanged: true } } },
  );

  registerFsTools(server, makeBackend({ allowWrites: opts?.allowWrites, kernel: opts?.kernel }), {
    decodeHtml: true,
    includeIndexStatus: (opts?.indexStatus ?? true) ? indexStatus : undefined,
  });

  return server;
}

// ── Handler factory ───────────────────────────────────────────────────────────

export function createFsHandler(opts?: FsHandlerOpts): FsHandler {
  let readyPromise: Promise<void> | null = null;
  let watcher: VaultWatcherHandle | null = null;

  // Build the vault index + start the watcher. Idempotent; re-armed by stop().
  function ready(): Promise<void> {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      await buildIndex();
      const s = indexStatus();
      console.error(
        `index: ${s.status} (${s.count} notes)${s.error ? ` — error: ${s.error}` : ""}`,
      );
      if (s.status !== "ready") {
        console.error("watcher: skipped (index not ready)");
        return;
      }
      try {
        watcher = await startVaultWatcher({ vaultRoot: vaultRoot() });
      } catch (e) {
        console.error(
          `watcher: failed to start — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();

    return readyPromise;
  }

  async function stop(): Promise<void> {
    // Re-arm ready() so a later return to FS mode rebuilds the index + restarts
    // the watcher. The watcher must NOT run during LIVE mode: a live vault
    // watcher corrupts child_process fd setup under launchd and EBADFs the
    // bridge spawn (see front.ts wireFailover).
    readyPromise = null;
    if (!watcher) return;
    const w = watcher;
    watcher = null;
    try {
      await w.stop();
    } catch (e) {
      console.error(
        `watcher: stop failed — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    // ── Per-request handler ─────────────────────────────────────────────────
    async handle(req: express.Request, res: express.Response): Promise<void> {
      // Lazily build the index on first FS-mode use. In LIVE mode the FS
      // machinery (and its watcher) never starts, keeping the bridge spawn safe.
      await ready();
      const server = buildFsServer(opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("MCP request error:", err);
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      }
    },

    ready,
    stop,
  };
}
