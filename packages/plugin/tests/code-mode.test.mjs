/**
 * code-mode.test.mjs — Code Mode surface: preamble protocol, meta-tools over a
 * captured registry, listener peek behavior, and the bridge-side preamble.
 *
 * The registry here is hand-built (fake defs/handlers), mirroring what
 * buildMcpServer's capture path produces — the capture wrapper itself is a
 * one-liner exercised implicitly by every guarded-tool test.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { buildPreamble, parsePreamble, DEFAULT_CONN_OPTIONS } from "../src/preamble.js";
import {
  searchRegistry,
  describeTool,
  registerCodeModeTools,
} from "../src/mcp/tools-code-mode.js";
import { UnixSocketListener } from "../src/socket-transport.js";

// ── preamble ──────────────────────────────────────────────────────────────────

describe("preamble", () => {
  test("build/parse round-trip", () => {
    assert.deepEqual(parsePreamble(buildPreamble({ codeMode: true })), { codeMode: true });
    assert.deepEqual(parsePreamble(buildPreamble({ codeMode: false })), { codeMode: false });
  });
  test("a normal JSON-RPC line is not a preamble", () => {
    assert.equal(parsePreamble('{"jsonrpc":"2.0","id":1,"method":"initialize"}'), null);
  });
  test("garbage, arrays, and primitives are not preambles", () => {
    for (const line of ["not json", "[1,2]", "42", "null", '"str"']) {
      assert.equal(parsePreamble(line), null);
    }
  });
  test("defaults are full-surface", () => {
    assert.equal(DEFAULT_CONN_OPTIONS.codeMode, false);
  });
});

// ── meta-tools over a fake captured registry ──────────────────────────────────

function fakeRegistry() {
  const calls = [];
  const registry = new Map([
    [
      "obsidian_read_note",
      {
        def: {
          title: "Read note",
          description: "Read a note by path.",
          inputSchema: { path: z.string().min(1) },
          annotations: { readOnlyHint: true },
        },
        handler: async (args) => {
          calls.push(["read", args]);
          return { content: [{ type: "text", text: "ok" }], structuredContent: { path: args.path } };
        },
      },
    ],
    [
      "obsidian_delete_note",
      {
        def: {
          title: "Delete note",
          description: "Delete a note permanently.",
          inputSchema: { path: z.string(), confirm: z.boolean() },
          annotations: { readOnlyHint: false },
        },
        handler: async (args) => {
          calls.push(["delete", args]);
          return { content: [{ type: "text", text: "deleted" }] };
        },
      },
    ],
    [
      "obsidian_doctor",
      {
        def: { title: "Diagnostics", description: "Health.", inputSchema: {}, annotations: { readOnlyHint: true } },
        handler: async () => ({ content: [{ type: "text", text: "healthy" }] }),
      },
    ],
  ]);
  return { registry, calls };
}

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, def, handler) { tools.set(name, { def, handler }); } };
}

describe("searchRegistry / describeTool", () => {
  test("no query lists all, sorted", () => {
    const { registry } = fakeRegistry();
    const all = searchRegistry(registry);
    assert.deepEqual(all.map((t) => t.name), ["obsidian_delete_note", "obsidian_doctor", "obsidian_read_note"]);
  });
  test("query matches name/title/description, case-insensitive", () => {
    const { registry } = fakeRegistry();
    assert.deepEqual(searchRegistry(registry, "DELETE").map((t) => t.name), ["obsidian_delete_note"]);
    assert.deepEqual(searchRegistry(registry, "health").map((t) => t.name), ["obsidian_doctor"]);
    assert.equal(searchRegistry(registry, "zzz").length, 0);
  });
  test("mutating flag derives from readOnlyHint === false", () => {
    const { registry } = fakeRegistry();
    const byName = Object.fromEntries(searchRegistry(registry).map((t) => [t.name, t.mutating]));
    assert.equal(byName.obsidian_read_note, false);
    assert.equal(byName.obsidian_delete_note, true);
  });
  test("describeTool emits a JSON Schema with the tool's properties", () => {
    const { registry } = fakeRegistry();
    const d = describeTool(registry, "obsidian_delete_note");
    assert.equal(d.name, "obsidian_delete_note");
    assert.ok(d.input_schema.properties.path);
    assert.ok(d.input_schema.properties.confirm);
    assert.deepEqual(new Set(d.input_schema.required), new Set(["path", "confirm"]));
  });
  test("describeTool returns null for unknown", () => {
    const { registry } = fakeRegistry();
    assert.equal(describeTool(registry, "nope"), null);
  });
});

describe("registerCodeModeTools", () => {
  test("registers exactly the three meta-tools", () => {
    const { registry } = fakeRegistry();
    const server = fakeServer();
    registerCodeModeTools(server, registry);
    assert.deepEqual(
      [...server.tools.keys()].sort(),
      ["obsidian_call_tool", "obsidian_describe_tool", "obsidian_search_tools"]
    );
  });

  test("call_tool validates args and delegates to the captured handler", async () => {
    const { registry, calls } = fakeRegistry();
    const server = fakeServer();
    registerCodeModeTools(server, registry);
    const call = server.tools.get("obsidian_call_tool").handler;

    const okRes = await call({ name: "obsidian_read_note", args: { path: "A.md" } }, {});
    assert.notEqual(okRes.isError, true);
    assert.deepEqual(calls, [["read", { path: "A.md" }]]);

    const badRes = await call({ name: "obsidian_read_note", args: {} }, {});
    assert.equal(badRes.isError, true);
    assert.match(badRes.content[0].text, /invalid args for 'obsidian_read_note'/);
    assert.equal(calls.length, 1, "handler must not run on validation failure");
  });

  test("call_tool rejects unknown tools with a pointer to search", async () => {
    const { registry } = fakeRegistry();
    const server = fakeServer();
    registerCodeModeTools(server, registry);
    const res = await server.tools.get("obsidian_call_tool").handler({ name: "nope" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /obsidian_search_tools/);
  });

  test("call_tool with no args object works for zero-arg tools", async () => {
    const { registry } = fakeRegistry();
    const server = fakeServer();
    registerCodeModeTools(server, registry);
    const res = await server.tools.get("obsidian_call_tool").handler({ name: "obsidian_doctor" }, {});
    assert.notEqual(res.isError, true);
  });

  test("guard travels with the captured handler (read-only blocks through call_tool)", async () => {
    // Simulate what buildMcpServer's capture does: wrap the handler with a guard.
    const { registry } = fakeRegistry();
    const entry = registry.get("obsidian_delete_note");
    const guarded = { ...entry, handler: async () => ({ content: [{ type: "text", text: "Error [read_only]: blocked" }], isError: true }) };
    registry.set("obsidian_delete_note", guarded);
    const server = fakeServer();
    registerCodeModeTools(server, registry);
    const res = await server.tools
      .get("obsidian_call_tool")
      .handler({ name: "obsidian_delete_note", args: { path: "A.md", confirm: true } }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /read_only/);
  });
});

// ── listener peek: preamble consumed, non-preamble passed through ─────────────

function tmpSock() {
  return path.join(os.tmpdir(), `vault-mcp-cm-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

function connectTo(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function withListener(fn) {
  const sockPath = tmpSock();
  const accepted = [];
  const listener = new UnixSocketListener(sockPath, (transport, opts) => accepted.push({ transport, opts }));
  await listener.listen();
  try {
    await fn({ sockPath, accepted });
  } finally {
    await listener.close();
  }
}

function until(cond, what, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function startAndCollect(transport) {
  const messages = [];
  transport.onmessage = (m) => messages.push(m);
  await transport.start();
  return messages;
}

describe("UnixSocketListener preamble peek", () => {
  test("preamble first line selects code mode and is consumed", async () => {
    await withListener(async ({ sockPath, accepted }) => {
      const client = await connectTo(sockPath);
      client.write(buildPreamble({ codeMode: true }) + "\n" + '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      await until(() => accepted.length === 1, "connection handoff");
      assert.equal(accepted[0].opts.codeMode, true);
      const messages = await startAndCollect(accepted[0].transport);
      await until(() => messages.length === 1, "initialize delivery");
      assert.equal(messages[0].method, "initialize");
      client.destroy();
    });
  });

  test("no preamble (old bridge): first message is delivered intact, full surface", async () => {
    await withListener(async ({ sockPath, accepted }) => {
      const client = await connectTo(sockPath);
      client.write('{"jsonrpc":"2.0","id":7,"method":"initialize"}\n');
      await until(() => accepted.length === 1, "connection handoff");
      assert.equal(accepted[0].opts.codeMode, false);
      const messages = await startAndCollect(accepted[0].transport);
      await until(() => messages.length === 1, "initialize delivery");
      assert.equal(messages[0].id, 7);
      client.destroy();
    });
  });

  test("first line split across writes is reassembled before classification", async () => {
    await withListener(async ({ sockPath, accepted }) => {
      const client = await connectTo(sockPath);
      const pre = buildPreamble({ codeMode: true }) + "\n";
      client.write(pre.slice(0, 10));
      await new Promise((r) => setTimeout(r, 30));
      client.write(pre.slice(10) + '{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
      await until(() => accepted.length === 1, "connection handoff");
      assert.equal(accepted[0].opts.codeMode, true);
      const messages = await startAndCollect(accepted[0].transport);
      await until(() => messages.length === 1, "ping delivery");
      assert.equal(messages[0].method, "ping");
      client.destroy();
    });
  });

  test("messages arriving after the handoff still flow (initial + live data)", async () => {
    await withListener(async ({ sockPath, accepted }) => {
      const client = await connectTo(sockPath);
      client.write(buildPreamble({ codeMode: false }) + "\n" + '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      await until(() => accepted.length === 1, "connection handoff");
      const messages = await startAndCollect(accepted[0].transport);
      client.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
      await until(() => messages.length === 2, "both messages");
      assert.deepEqual(messages.map((m) => m.id), [1, 2]);
      client.destroy();
    });
  });
});
