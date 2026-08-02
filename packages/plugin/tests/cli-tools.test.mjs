/**
 * cli-tools.test.mjs — obsidian_cli (official-CLI proxy) pure logic + handler.
 *
 * The exec layer is injected, so the handler is fully testable headlessly:
 * danger gate, allowlist refusal, arg construction, and result shaping.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findObsidianBinary,
  isDangerousCliCommand,
  buildCliArgs,
  registerCliTools,
} from "../src/mcp/tools-cli.js";

// ── findObsidianBinary ────────────────────────────────────────────────────────

describe("findObsidianBinary", () => {
  test("returns the first existing candidate", () => {
    const bin = findObsidianBinary({
      candidates: ["/a/obsidian", "/b/obsidian"],
      fileExists: (p) => p === "/b/obsidian",
    });
    assert.equal(bin, "/b/obsidian");
  });
  test("returns null when nothing exists", () => {
    assert.equal(findObsidianBinary({ candidates: ["/a"], fileExists: () => false }), null);
  });
});

// ── isDangerousCliCommand ─────────────────────────────────────────────────────

describe("isDangerousCliCommand", () => {
  for (const cmd of ["eval", "devtools", "restart", "reload", "command", "plugins:restrict", "dev:cdp", "dev:screenshot"]) {
    test(`${cmd} is dangerous`, () => assert.equal(isDangerousCliCommand(cmd), true));
  }
  for (const cmd of ["help", "history:list", "theme:set", "plugin:install", "developer"]) {
    test(`${cmd} is not dangerous`, () => assert.equal(isDangerousCliCommand(cmd), false));
  }
});

// ── buildCliArgs ──────────────────────────────────────────────────────────────

describe("buildCliArgs", () => {
  test("pins the vault first, then command, params, flags", () => {
    assert.deepEqual(
      buildCliArgs({
        vaultName: "my vault",
        command: "history:list",
        params: { file: "Inbox/Note.md", limit: 5, verbose: true },
        flags: ["--json"],
      }),
      ["vault=my vault", "history:list", "file=Inbox/Note.md", "limit=5", "verbose=true", "--json"]
    );
  });
  test("trims the command", () => {
    assert.deepEqual(buildCliArgs({ vaultName: "v", command: " help " }), ["vault=v", "help"]);
  });
  test("rejects a vault param (pinned)", () => {
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", params: { vault: "other" } }), /pinned/);
  });
  test("rejects malformed command names", () => {
    for (const bad of ["", "help me", "read; rm", "--json", "1abc"]) {
      assert.throws(() => buildCliArgs({ vaultName: "v", command: bad }), /invalid command/);
    }
  });
  test("rejects malformed param keys", () => {
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", params: { "bad key": "x" } }), /invalid param key/);
  });
  test("rejects non-flag flags", () => {
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", flags: ["json"] }), /invalid flag/);
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", flags: ["extra=positional"] }), /invalid flag/);
  });
  test("accepts flag=value", () => {
    assert.deepEqual(
      buildCliArgs({ vaultName: "v", command: "read", flags: ["--format=json", "-v"] }),
      ["vault=v", "read", "--format=json", "-v"]
    );
  });
});

// ── registerCliTools handler ──────────────────────────────────────────────────

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, def, handler) {
      tools.set(name, { def, handler });
    },
  };
}

function ctxWith(settings) {
  return {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "testvault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: false, ...settings }),
  };
}

const okExec = async (bin, args) => ({ exitCode: 0, stdout: `ran ${args.join(" ")}`, stderr: "", timedOut: false });

describe("registerCliTools", () => {
  test("does not register without a binary", () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: null });
    assert.equal(server.tools.size, 0);
  });

  test("registers obsidian_cli with mutating annotations", () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/usr/local/bin/obsidian", exec: okExec });
    const entry = server.tools.get("obsidian_cli");
    assert.ok(entry);
    assert.equal(entry.def.annotations.readOnlyHint, false);
  });

  test("happy path: structured report with argv, exit_code, stdout", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "help" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.exit_code, 0);
    assert.deepEqual(res.structuredContent.argv, ["vault=testvault", "help"]);
    assert.match(res.structuredContent.stdout, /^ran vault=testvault help/);
  });

  test("non-zero exit keeps the structured report but flags isError", async () => {
    const server = fakeServer();
    const exec = async () => ({ exitCode: 3, stdout: "partial", stderr: "boom", timedOut: false });
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "read" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.exit_code, 3);
    assert.equal(res.structuredContent.stderr, "boom");
  });

  test("dangerous command is blocked by default, with the setting named", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "eval" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Allow dangerous CLI commands/);
  });

  test("dangerous command runs when allowDangerousCli is on", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({ allowDangerousCli: true }), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "eval", params: { code: "1+1" } });
    assert.notEqual(res.isError, true);
  });

  test("refuses to run while a path allowlist is active", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({ allowlist: ["00-09 System"] }), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "help" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /allowlist/);
  });

  test("invalid input surfaces as a tool error, not a throw", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "read", params: { vault: "other" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /pinned/);
  });

  test("timeout surfaces timed_out in the report", async () => {
    const server = fakeServer();
    const exec = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "search", timeout_ms: 1000 });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.timed_out, true);
  });
});
