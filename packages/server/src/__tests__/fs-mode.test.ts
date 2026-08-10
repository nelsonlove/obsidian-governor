/**
 * TDD tests for createFsHandler (packages/server/src/fs-mode.ts).
 *
 * Uses the MCP SDK's InMemoryTransport to drive the McpServer that the factory
 * builds, without needing a live Express server.
 *
 * Asserts:
 *   1. tools/list returns exactly 17 tools.
 *   2. obsidian_write_note + obsidian_read_note round-trip (write, read back same content).
 *   3. obsidian_read_note response carries `index_status` block when indexStatus=true.
 *   4. The server's declared capabilities include tools.listChanged === true.
 *
 * VAULT_PATH must be set BEFORE any @vault-mcp/core module is imported — vault.ts
 * and index-store.ts capture their root and initial state at module load. This file
 * sets VAULT_PATH in a `before()` hook then dynamically imports fs-mode.ts and
 * @vault-mcp/core (same pattern as packages/core/tests/vault.test.ts).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ── Dynamic imports — resolved after VAULT_PATH is set ───────────────────────

// These will be populated in the `before()` hook below.
let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let createFsHandler: (typeof import("../fs-mode.js"))["createFsHandler"];
let FS_WRITES_ENV_VAR: (typeof import("../fs-mode.js"))["FS_WRITES_ENV_VAR"];
let FS_TOOLS: (typeof import("@vault-mcp/core"))["FS_TOOLS"];

// ── Temp vault setup ─────────────────────────────────────────────────────────

let tmpVault: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any; // FsHandler instance for ready()/stop() lifecycle

before(async () => {
  // Create temp vault dir and wire VAULT_PATH before any vault module loads.
  tmpVault = await mkdtemp(path.join(tmpdir(), "fs-mode-test-"));
  process.env.VAULT_PATH = tmpVault;

  // Dynamic import after env is set — vault.ts captures VAULT_ROOT at import time.
  const fsMod = await import("../fs-mode.js");
  buildFsServer = fsMod.buildFsServer;
  createFsHandler = fsMod.createFsHandler;
  FS_WRITES_ENV_VAR = fsMod.FS_WRITES_ENV_VAR;

  const coreMod = await import("@vault-mcp/core");
  FS_TOOLS = coreMod.FS_TOOLS;

  // Create a handler and call ready() to build the index + start the watcher.
  // ready() is idempotent — safe to call once for all tests that need a live index.
  handler = createFsHandler({ indexStatus: true });
  await handler.ready();
});

after(async () => {
  // Close the vault watcher so no open handles remain and the test runner exits.
  if (handler) await handler.stop();
  // Clean up temp vault.
  await rm(tmpVault, { recursive: true, force: true });
});

// ── Test harness ──────────────────────────────────────────────────────────────

/**
 * Build a fresh McpServer via the factory and wire it to a Client over
 * InMemoryTransport. Returns the client and a teardown function.
 *
 * Uses buildFsServer (the internal factory helper exported from fs-mode.ts)
 * so tests drive exactly the same server construction that createFsHandler.handle()
 * uses per-request — without needing a live Express server.
 *
 * `allowWrites` defaults to true here so tests that exercise write tools for
 * OTHER reasons (round-trips, the accept-forbidden guard) aren't tripped up by
 * the FS-write gate (issue #92) — that gate has its own dedicated describe
 * block below, which passes allowWrites explicitly per case.
 */
async function makeClientFromFsServer(
  indexStatus?: boolean,
  allowWrites = true,
): Promise<{ client: Client; teardown: () => Promise<void> }> {
  const server = buildFsServer({ indexStatus, allowWrites });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    teardown: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createFsHandler / buildFsServer", () => {
  /**
   * 1. tools/list returns exactly 17 tools.
   */
  test("tools/list returns exactly 17 tools", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 17, `expected 17 tools, got ${tools.length}`);

      const names = tools.map((t) => t.name).sort();
      const expected = FS_TOOLS.map((t) => t.name).sort();
      assert.deepEqual(names, expected, "tool names do not match FS_TOOLS");
    } finally {
      await teardown();
    }
  });

  /**
   * 2. obsidian_write_note + obsidian_read_note round-trip.
   *    Writes a note via the tool, then reads it back and asserts same content.
   */
  test("obsidian_write_note + obsidian_read_note round-trip", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      // Write a note via the tool (uses real vault at tmpVault).
      const writeResult = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-test/RoundTrip.md",
          content: "# Round Trip\nHello from fs-mode test!",
          overwrite: false,
        },
      });
      assert.ok(!writeResult.isError, `write failed: ${JSON.stringify(writeResult.content)}`);
      const writeData = JSON.parse(
        (writeResult.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(writeData.path, "fs-mode-test/RoundTrip.md");
      assert.equal(writeData.created, true);

      // Read it back.
      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-test/RoundTrip.md" },
      });
      assert.ok(!readResult.isError, `read failed: ${JSON.stringify(readResult.content)}`);
      const readData = JSON.parse(
        (readResult.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(readData.content, "# Round Trip\nHello from fs-mode test!");
    } finally {
      await teardown();
    }
  });

  /**
   * 3. obsidian_read_note response carries `index_status` block when indexStatus=true.
   *    Writes a note directly to the temp vault then reads it via the tool.
   */
  test("obsidian_read_note includes index_status when indexStatus=true", async () => {
    // Write a note directly to the filesystem (bypasses the tool round-trip for simplicity).
    const noteDir = path.join(tmpVault, "fs-mode-index-test");
    await mkdir(noteDir, { recursive: true });
    await writeFile(path.join(noteDir, "StatusNote.md"), "# Status Note\ncontent", "utf8");

    const { client, teardown } = await makeClientFromFsServer(true);
    try {
      const result = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-index-test/StatusNote.md" },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.ok("index_status" in data, "index_status field must be present when indexStatus=true");
      assert.ok(
        typeof data.index_status === "object" && data.index_status !== null,
        "index_status must be an object",
      );
      assert.ok("status" in data.index_status, "index_status must have a status field");
    } finally {
      await teardown();
    }
  });

  /**
   * 4. The server's declared capabilities include tools.listChanged === true.
   *    After client.connect(), getServerCapabilities() reflects what the server
   *    announced during initialization.
   */
  test("server capabilities include tools.listChanged === true", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const caps = client.getServerCapabilities();
      assert.ok(caps, "server capabilities must be available after connect");
      assert.ok(caps.tools, "capabilities.tools must be present");
      assert.equal(
        caps.tools.listChanged,
        true,
        "capabilities.tools.listChanged must be true (required for Phase 2b)",
      );
    } finally {
      await teardown();
    }
  });

  /**
   * 5. ready() is idempotent — calling it twice does not double-build the index.
   */
  test("ready() is idempotent — second call returns same promise", async () => {
    const h = createFsHandler({ indexStatus: true });
    try {
      const p1 = h.ready();
      const p2 = h.ready();
      assert.strictEqual(p1, p2, "ready() must return the same Promise on repeated calls");
      await p1;
    } finally {
      await h.stop();
    }
  });

  /**
   * 6. obsidian_read_note does NOT include index_status when indexStatus=false (default opt-out).
   */
  test("obsidian_read_note omits index_status when indexStatus=false", async () => {
    // Write directly to temp vault.
    const noteDir2 = path.join(tmpVault, "fs-mode-noindex-test");
    await mkdir(noteDir2, { recursive: true });
    await writeFile(path.join(noteDir2, "NoIndex.md"), "# No Index\ncontent", "utf8");

    const { client, teardown } = await makeClientFromFsServer(false);
    try {
      const result = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-noindex-test/NoIndex.md" },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.ok(
        !("index_status" in data),
        "index_status must NOT be present when indexStatus=false",
      );
    } finally {
      await teardown();
    }
  });
});

/**
 * Issue #104 — the accept-forbidden guard, exercised through the REAL exposed
 * MCP tool (obsidian_write_note) on the REAL fs-failover handler, not just
 * against the underlying FilesystemBackend/VaultImpl classes directly. An
 * independent PR review of the initial #104 patch found that guarding
 * FilesystemBackend alone was not sufficient: this server's own
 * makeBackend() (fs-mode.ts) wraps the MODULE-LEVEL singleton functions
 * exported from @vault-mcp/core (writeNote/appendNote/setFrontmatterField/
 * patchNote, bound to a private VaultImpl singleton) — a SEPARATE code path
 * from the FilesystemBackend class. The guard had to move into VaultImpl
 * itself (the shared implementation both paths delegate to) for it to
 * actually reach this handler. This suite is the regression test for that:
 * it fails if the guard is ever wired to the wrong implementation again.
 */
describe("obsidian_write_note — accept-forbidden guard reaches the real fs-failover handler (issue #104)", () => {
  test("a write carrying acceptance-status: accepted is REFUSED through the real MCP tool", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-accept-guard-test/Accepted.md",
          content: "---\nacceptance-status: accepted\n---\nbody",
          overwrite: false,
        },
      });
      assert.ok(result.isError, "expected the write to be refused (isError: true)");
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.match(text, /accept_forbidden|accept-forbidden|acceptance/i);

      // And confirm nothing landed on disk.
      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-accept-guard-test/Accepted.md" },
      });
      assert.ok(readResult.isError, "the refused note must not exist on disk");
    } finally {
      await teardown();
    }
  });

  test("a normal (non-accepted) write still SUCCEEDS through the real MCP tool", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-accept-guard-test/Normal.md",
          content: "---\nname: N\n---\nordinary body",
          overwrite: false,
        },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
    } finally {
      await teardown();
    }
  });

  test("a write carrying an accepted-family value behind a leading BOM is REFUSED (recognition parity)", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-accept-guard-test/BomAccepted.md",
          content: "\uFEFF---\nacceptance-status: accepted\n---\nbody",
          overwrite: false,
        },
      });
      assert.ok(result.isError, "a BOM-prefixed accepted fence must be refused, not silently honored unguarded");
    } finally {
      await teardown();
    }
  });
});

/**
 * Issue #92 — FS-mode writes bypass the plugin kernel's serialized write
 * queue and append-only write journal entirely (FS mode has no kernel to
 * route through; packages/server does not, and must not, depend on
 * packages/plugin). Rather than silently shipping unaudited writes under
 * the same tool names as the journaled LIVE path, FS-mode writes are
 * refused by default and require an explicit opt-in — this suite is the
 * regression test for that gate.
 */
describe("FS-mode write gate (issue #92)", () => {
  test("obsidian_write_note is refused by default (no allowWrites option, no env var)", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, false);
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-write-gate-test/ShouldNotExist.md",
          content: "body",
          overwrite: false,
        },
      });
      assert.ok(result.isError, "expected the write to be refused (isError: true)");
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.match(text, /fs_writes_disabled/);

      // Confirm nothing landed on disk.
      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-write-gate-test/ShouldNotExist.md" },
      });
      assert.ok(readResult.isError, "the refused write must not have created the note");
    } finally {
      await teardown();
    }
  });

  test("obsidian_append_note, obsidian_delete_note, and obsidian_manage_frontmatter (set) are also refused by default", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, false);
    try {
      const appendResult = await client.callTool({
        name: "obsidian_append_note",
        arguments: { path: "fs-mode-write-gate-test/Append.md", content: "more" },
      });
      assert.ok(appendResult.isError, "append must be refused by default");
      assert.match(
        (appendResult.content as Array<{ type: string; text: string }>)[0].text,
        /fs_writes_disabled/,
      );

      const fmResult = await client.callTool({
        name: "obsidian_manage_frontmatter",
        arguments: { path: "fs-mode-write-gate-test/Fm.md", key: "title", op: "set", value: "x" },
      });
      assert.ok(fmResult.isError, "manage_frontmatter set must be refused by default");
      assert.match(
        (fmResult.content as Array<{ type: string; text: string }>)[0].text,
        /fs_writes_disabled/,
      );

      const deleteResult = await client.callTool({
        name: "obsidian_delete_note",
        arguments: { path: "fs-mode-write-gate-test/Nonexistent.md", confirm: true },
      });
      assert.ok(deleteResult.isError, "delete must be refused by default");
      assert.match(
        (deleteResult.content as Array<{ type: string; text: string }>)[0].text,
        /fs_writes_disabled/,
      );
    } finally {
      await teardown();
    }
  });

  test("obsidian_write_note succeeds when allowWrites: true is explicitly opted in", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, true);
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-write-gate-test/Allowed.md",
          content: "# Allowed\nbody",
          overwrite: false,
        },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);

      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-write-gate-test/Allowed.md" },
      });
      assert.ok(!readResult.isError);
      const data = JSON.parse((readResult.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(data.content, "# Allowed\nbody");
    } finally {
      await teardown();
    }
  });

  test("obsidian_write_note succeeds when VAULT_MCP_FS_ALLOW_WRITES env var is set, with no explicit option", async () => {
    const prev = process.env[FS_WRITES_ENV_VAR];
    process.env[FS_WRITES_ENV_VAR] = "true";
    try {
      // buildFsServer({ indexStatus }) — allowWrites intentionally omitted, so
      // makeBackend() must fall back to reading the env var itself.
      const server = buildFsServer({ indexStatus: false });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "obsidian_write_note",
          arguments: {
            path: "fs-mode-write-gate-test/EnvAllowed.md",
            content: "via env var",
            overwrite: false,
          },
        });
        assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      if (prev === undefined) delete process.env[FS_WRITES_ENV_VAR];
      else process.env[FS_WRITES_ENV_VAR] = prev;
    }
  });

  test("reads (obsidian_list_notes, obsidian_read_note) work identically whether or not writes are allowed", async () => {
    // Seed a note directly on disk (bypassing the gated write tools).
    const noteDir = path.join(tmpVault, "fs-mode-write-gate-read-test");
    await mkdir(noteDir, { recursive: true });
    await writeFile(path.join(noteDir, "ReadMe.md"), "# Read fallback\nstill works", "utf8");

    for (const allowWrites of [false, true]) {
      const { client, teardown } = await makeClientFromFsServer(undefined, allowWrites);
      try {
        const listResult = await client.callTool({
          name: "obsidian_list_notes",
          arguments: { subdir: "fs-mode-write-gate-read-test", limit: 10, offset: 0 },
        });
        assert.ok(!listResult.isError, `list failed (allowWrites=${allowWrites})`);

        const readResult = await client.callTool({
          name: "obsidian_read_note",
          arguments: { path: "fs-mode-write-gate-read-test/ReadMe.md" },
        });
        assert.ok(!readResult.isError, `read failed (allowWrites=${allowWrites})`);
        const data = JSON.parse((readResult.content as Array<{ type: string; text: string }>)[0].text);
        assert.equal(data.content, "# Read fallback\nstill works");
      } finally {
        await teardown();
      }
    }
  });
});
