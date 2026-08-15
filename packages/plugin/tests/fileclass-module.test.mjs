/**
 * fileclass-module.test.mjs — the `fileclass` module (mcp/tools-fileclass.ts):
 * the fileclass-CLI proxy's pure + handler logic, all headless.
 *
 * The exec layer, the plugin-presence probe and the binary are INJECTED, so the
 * whole surface is testable without a live Obsidian / fileclass CLI:
 *   • findFileclassBinary — candidate probing;
 *   • buildFileclassArgs — argv construction (vault pinned, --json, flags);
 *   • fileclassSetAcceptRefusal — the accept-forbidden guard on a field-write;
 *   • registerFileclassTools — the plugin/binary presence gate, the read/write
 *     split, the accept refusal, the set-where dry-run default, the allowlist
 *     refusal, and --json parsing.
 *
 * NOT covered here (un-headless — verified by build + reasoning, see the PR): the
 * live subprocess and `app.plugins.plugins.fileclass` presence detection.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findFileclassBinary,
  buildFileclassArgs,
  fileclassSetAcceptRefusal,
  registerFileclassTools,
  FILECLASS_PLUGIN_ID,
} from "../src/mcp/tools-fileclass.js";
import { fakeServer } from "./fake-server.mjs";

// ── findFileclassBinary ───────────────────────────────────────────────────────

describe("findFileclassBinary", () => {
  test("returns the first existing candidate", () => {
    const bin = findFileclassBinary({
      candidates: ["/a/fileclass", "/b/fileclass"],
      fileExists: (p) => p === "/b/fileclass",
    });
    assert.equal(bin, "/b/fileclass");
  });
  test("returns null when nothing exists", () => {
    assert.equal(findFileclassBinary({ candidates: ["/a"], fileExists: () => false }), null);
  });
  test("default candidates include the user-bin install paths (home-expanded)", () => {
    const seen = [];
    findFileclassBinary({ homedir: "/Users/x", fileExists: (p) => (seen.push(p), false) });
    assert.ok(seen.includes("/Users/x/.local/bin/fileclass"));
    assert.ok(seen.includes("/Users/x/.npm-global/bin/fileclass"));
    assert.ok(seen.includes("/usr/local/bin/fileclass"));
  });
});

// ── buildFileclassArgs ────────────────────────────────────────────────────────

describe("buildFileclassArgs", () => {
  test("appends --vault <name> and --json, vault pinned", () => {
    assert.deepEqual(buildFileclassArgs("My Vault", { command: "fileclasses" }), [
      "fileclasses",
      "--vault",
      "My Vault",
      "--json",
    ]);
  });
  test("positionals precede the flags", () => {
    assert.deepEqual(buildFileclassArgs("v", { command: "get", positionals: ["Books/Dune.md", "status"] }), [
      "get",
      "Books/Dune.md",
      "status",
      "--vault",
      "v",
      "--json",
    ]);
  });
  test("query flags: where / columns / limit in order", () => {
    assert.deepEqual(
      buildFileclassArgs("v", { command: "list", positionals: ["Book"], where: "status is unread", columns: "title,author", limit: 20 }),
      ["list", "Book", "--where", "status is unread", "--columns", "title,author", "--limit", "20", "--vault", "v", "--json"]
    );
  });
  test("validate --fileclass", () => {
    assert.deepEqual(buildFileclassArgs("v", { command: "validate", fileclass: "Book" }), [
      "validate",
      "--fileclass",
      "Book",
      "--vault",
      "v",
      "--json",
    ]);
  });
  test("set-where appends --apply only when apply:true", () => {
    assert.deepEqual(
      buildFileclassArgs("v", { command: "set-where", positionals: ["Book", "status", "to read"], where: "status isEmpty", apply: true }),
      ["set-where", "Book", "status", "to read", "--where", "status isEmpty", "--apply", "--vault", "v", "--json"]
    );
    // dry-run: no --apply
    assert.deepEqual(
      buildFileclassArgs("v", { command: "set-where", positionals: ["Book", "status", "to read"], apply: false }),
      ["set-where", "Book", "status", "to read", "--vault", "v", "--json"]
    );
  });
  test("empty where/columns/fileclass are omitted", () => {
    assert.deepEqual(buildFileclassArgs("v", { command: "list", positionals: ["Book"], where: "", columns: "" }), [
      "list",
      "Book",
      "--vault",
      "v",
      "--json",
    ]);
  });
  test("rejects an unknown command", () => {
    assert.throws(() => buildFileclassArgs("v", { command: "rm -rf" }), /unknown fileclass command/);
    assert.throws(() => buildFileclassArgs("v", { command: "eval" }), /unknown fileclass command/);
  });
});

// ── fileclassSetAcceptRefusal (the accept-forbidden guard) ────────────────────

describe("fileclassSetAcceptRefusal", () => {
  test("refuses acceptance-status set to an accepted value", () => {
    assert.ok(fileclassSetAcceptRefusal("acceptance-status", "accepted"));
  });
  test("refuses an accepted-family KEY whatever the value", () => {
    assert.ok(fileclassSetAcceptRefusal("accepted", "true"));
    assert.ok(fileclassSetAcceptRefusal("accepted-by", "Nelson"));
    assert.ok(fileclassSetAcceptRefusal("accepted-on", "2026-01-01"));
  });
  test("allows a field literally named 'status' set to 'accepted' (not the acceptance field)", () => {
    assert.equal(fileclassSetAcceptRefusal("status", "accepted"), null);
  });
  test("allows acceptance-status: proposed (the agent-writable value)", () => {
    assert.equal(fileclassSetAcceptRefusal("acceptance-status", "proposed"), null);
  });
  test("allows an ordinary field write", () => {
    assert.equal(fileclassSetAcceptRefusal("rating", 5), null);
  });
  test("a numeric/boolean value cannot dodge the check by type (coerced to string)", () => {
    // Not accept-related, but proves coercion runs without throwing on non-strings.
    assert.equal(fileclassSetAcceptRefusal("count", 3), null);
    assert.equal(fileclassSetAcceptRefusal("done", true), null);
  });
});

// ── registerFileclassTools: presence gate ─────────────────────────────────────

const RW_TOOLS = ["fileclass_set", "fileclass_set_where"];
const RO_TOOLS = ["fileclass_list", "fileclass_schema", "fileclass_explain", "fileclass_query", "fileclass_get", "fileclass_validate"];
const ALL_TOOLS = [...RO_TOOLS, ...RW_TOOLS];

function ctxWith(overrides = {}) {
  return {
    config: {},
    getSettings: () => ({ allowlist: [], ...(overrides.settings ?? {}) }),
    vaultName: "V",
    present: () => true,
    binary: "/usr/local/bin/fileclass",
    obsidianBinary: null,
    exec: async () => ({ exitCode: 0, stdout: "{}", stderr: "", timedOut: false }),
    ...overrides.ctx,
  };
}

describe("registerFileclassTools: presence gate", () => {
  test("plugin ABSENT ⇒ registers nothing", () => {
    const server = fakeServer();
    registerFileclassTools(server, ctxWith({ ctx: { present: () => false } }));
    assert.equal(server.tools.size, 0);
  });
  test("binary ABSENT ⇒ registers nothing (even with the plugin present)", () => {
    const server = fakeServer();
    registerFileclassTools(server, ctxWith({ ctx: { binary: null } }));
    assert.equal(server.tools.size, 0);
  });
  test("plugin + binary present ⇒ registers all eight tools with the right read/write split", () => {
    const server = fakeServer();
    registerFileclassTools(server, ctxWith());
    for (const n of ALL_TOOLS) assert.ok(server.tools.has(n), `missing ${n}`);
    for (const n of RO_TOOLS) assert.equal(server.tools.get(n).def.annotations.readOnlyHint, true, `${n} should be read-only`);
    for (const n of RW_TOOLS) assert.equal(server.tools.get(n).def.annotations.readOnlyHint, false, `${n} should be mutating`);
  });
  test("the fileclass plugin id is 'fileclass'", () => {
    assert.equal(FILECLASS_PLUGIN_ID, "fileclass");
  });
  test("config.binaryPath overrides the probe (binary undefined ⇒ resolve from config)", () => {
    const server = fakeServer();
    registerFileclassTools(
      server,
      ctxWith({ ctx: { binary: undefined, config: { binaryPath: "/custom/fileclass" } } })
    );
    // A configured binaryPath means the presence gate passes without a filesystem probe.
    assert.equal(server.tools.size, 8);
  });
});

// ── handler behavior (fake exec) ──────────────────────────────────────────────

describe("fileclass handlers", () => {
  function mounted(overrides = {}) {
    const calls = [];
    const exec = async (bin, args, timeoutMs) => {
      calls.push({ bin, args, timeoutMs });
      return overrides.execResult ?? { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false };
    };
    const server = fakeServer();
    registerFileclassTools(server, ctxWith({ ctx: { exec }, settings: overrides.settings }));
    return { server, calls };
  }

  test("fileclass_list parses --json stdout into result", async () => {
    const { server, calls } = mounted({ execResult: { exitCode: 0, stdout: '[{"name":"Book"}]', stderr: "", timedOut: false } });
    const res = await server.tools.get("fileclass_list").handler({});
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.result, [{ name: "Book" }]);
    assert.deepEqual(calls[0].args, ["fileclasses", "--vault", "V", "--json"]);
  });

  test("fileclass_validate treats exit 1 (violations) as a successful run, not a tool error", async () => {
    const { server } = mounted({ execResult: { exitCode: 1, stdout: '{"violations":[{"path":"a.md"}]}', stderr: "", timedOut: false } });
    const res = await server.tools.get("fileclass_validate").handler({});
    assert.equal(res.isError, undefined, "exit 1 should not flag a tool error");
    assert.equal(res.structuredContent.exit_code, 1);
    assert.deepEqual(res.structuredContent.result.violations, [{ path: "a.md" }]);
  });

  test("fileclass_validate: a real failure exit (2) IS flagged isError", async () => {
    const { server } = mounted({ execResult: { exitCode: 2, stdout: "", stderr: "boom", timedOut: false } });
    const res = await server.tools.get("fileclass_validate").handler({});
    assert.equal(res.isError, true);
  });

  test("fileclass_set refuses an acceptance write BEFORE exec (nothing runs)", async () => {
    const { server, calls } = mounted();
    const res = await server.tools.get("fileclass_set").handler({ path: "a.md", field: "acceptance-status", value: "accepted" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /accept_forbidden/);
    assert.equal(calls.length, 0, "the CLI must not run for a refused write");
  });

  test("fileclass_set runs a clean write", async () => {
    const { server, calls } = mounted();
    const res = await server.tools.get("fileclass_set").handler({ path: "Books/Dune.md", field: "status", value: "read" });
    assert.equal(res.isError, undefined);
    assert.deepEqual(calls[0].args, ["set", "Books/Dune.md", "status", "read", "--vault", "V", "--json"]);
  });

  test("fileclass_set_where is DRY-RUN by default (no --apply)", async () => {
    const { server, calls } = mounted();
    await server.tools.get("fileclass_set_where").handler({ fileclass: "Book", field: "status", value: "to read", where: "status isEmpty" });
    assert.ok(!calls[0].args.includes("--apply"), "dry-run must not pass --apply");
  });

  test("fileclass_set_where passes --apply when apply:true", async () => {
    const { server, calls } = mounted();
    await server.tools.get("fileclass_set_where").handler({ fileclass: "Book", field: "status", value: "to read", apply: true });
    assert.ok(calls[0].args.includes("--apply"));
  });

  test("fileclass_set_where also honors the accept guard", async () => {
    const { server, calls } = mounted();
    const res = await server.tools.get("fileclass_set_where").handler({ fileclass: "Book", field: "accepted-by", value: "x", apply: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /accept_forbidden/);
    assert.equal(calls.length, 0);
  });

  test("every tool refuses while a path allowlist is active (CLI output cannot be path-scoped)", async () => {
    const { server, calls } = mounted({ settings: { allowlist: ["Projects"] } });
    for (const n of ALL_TOOLS) {
      const args =
        n === "fileclass_set"
          ? { path: "Projects/a.md", field: "status", value: "read" }
          : n === "fileclass_set_where"
            ? { fileclass: "Book", field: "status", value: "read" }
            : n === "fileclass_schema" || n === "fileclass_query"
              ? { fileclass: "Book" }
              : n === "fileclass_get"
                ? { path: "Projects/a.md", field: "status" }
                : n === "fileclass_explain"
                  ? { path: "Projects/a.md" }
                  : {};
      const res = await server.tools.get(n).handler(args);
      assert.equal(res.isError, true, `${n} should refuse under an allowlist`);
      assert.match(res.content[0].text, /out_of_allowlist/, `${n} refusal should be coded`);
    }
    assert.equal(calls.length, 0, "no CLI call while an allowlist is active");
  });
});
