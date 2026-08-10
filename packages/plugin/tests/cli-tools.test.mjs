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
  cliAcceptRefusal,
  CLI_OPAQUE_ACCEPT_RESIDUAL,
} from "../src/mcp/tools-cli.js";
import { fakeServer } from "./fake-server.mjs";
import { parseYaml } from "./obsidian-stub.mjs";

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
  for (const cmd of ["eval", "devtools", "restart", "reload", "command", "plugins:restrict", "plugin:install", "plugin:uninstall", "dev:cdp", "dev:screenshot"]) {
    test(`${cmd} is dangerous`, () => assert.equal(isDangerousCliCommand(cmd), true));
  }
  for (const cmd of ["help", "history:list", "theme:set", "plugin:enable", "plugin:disable", "developer"]) {
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
  test("rejects mixed-case command names (danger-gate case-bypass hardening)", () => {
    for (const bad of ["Eval", "DEV:cdp", "Help"]) {
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
    // `restart` is dangerous but NOT in the opaque-accept set, so the danger
    // gate is the one that fires (eval/command hit the command policy first —
    // pinned in cli-policy.test.mjs).
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "restart" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Allow dangerous CLI commands/);
  });

  test("dangerous command runs when allowDangerousCli is on", async () => {
    const server = fakeServer();
    // eval also needs the command policy's per-command re-enable now — the
    // fail-closed default of the opaque-accept set (cli-policy.ts).
    registerCliTools(
      server,
      ctxWith({ allowDangerousCli: true, cliPolicy: { deny: [], allowOpaque: ["eval"] } }),
      { binary: "/bin/obsidian", exec: okExec }
    );
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

  test("timeout surfaces timed_out plus the may-have-completed note", async () => {
    const server = fakeServer();
    const exec = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "search", timeout_ms: 1000 });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.timed_out, true);
    assert.match(res.structuredContent.note, /may still have completed/);
  });

  test("mixed-case dangerous command is rejected outright (never executed)", async () => {
    const server = fakeServer();
    let executed = false;
    const exec = async () => { executed = true; return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; };
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "Eval" });
    assert.equal(res.isError, true);
    assert.equal(executed, false);
  });
});

// ── cliAcceptRefusal — the accept-forbidden guard on the CLI path (pure) ───────
//
// The scar "the accept verb goes in no API" reaches the CLI proxy here, reusing
// the SAME accepted-family rule as the MCP write primitive. property:set and
// content writes that would INTRODUCE acceptance are refused; everything else,
// including acceptance-status: proposed, is clean.

describe("cliAcceptRefusal — property:set family", () => {
  test("REJECTS acceptance-status=accepted (documented name=/value= form)", () => {
    assert.ok(cliAcceptRefusal("property:set", { name: "acceptance-status", value: "accepted", file: "Note" }, parseYaml));
  });
  test("REJECTS acceptance-status=accepted (direct shorthand form)", () => {
    assert.ok(cliAcceptRefusal("property:set", { "acceptance-status": "accepted" }, parseYaml));
  });
  test("REJECTS acceptance_status underscore variant", () => {
    assert.ok(cliAcceptRefusal("property:set", { name: "acceptance_status", value: "accepted" }, parseYaml));
  });
  test("REJECTS an accepted-* prefixed value (accepted-by-review)", () => {
    assert.ok(cliAcceptRefusal("property:set", { name: "acceptance-status", value: "accepted-by-review" }, parseYaml));
  });
  for (const key of ["accepted", "accepted-by", "accepted-on", "accepted_by", "accepted_on"]) {
    test(`REJECTS the provenance key ${key} (name=/value= form)`, () => {
      assert.ok(cliAcceptRefusal("property:set", { name: key, value: "Nelson" }, parseYaml));
    });
    test(`REJECTS the provenance key ${key} (shorthand form)`, () => {
      assert.ok(cliAcceptRefusal("property:set", { [key]: "Nelson" }, parseYaml));
    });
  }
  test("frontmatter:add alias is guarded too", () => {
    assert.ok(cliAcceptRefusal("frontmatter:set", { name: "acceptance-status", value: "accepted" }, parseYaml));
  });
  // ── ALLOWED — legitimate property sets are untouched ──
  test("ALLOWS acceptance-status=proposed (the value agents DO write)", () => {
    assert.equal(cliAcceptRefusal("property:set", { name: "acceptance-status", value: "proposed" }, parseYaml), null);
  });
  test("ALLOWS a property literally named 'status' set to 'accepted' (not the acceptance field)", () => {
    assert.equal(cliAcceptRefusal("property:set", { name: "status", value: "accepted" }, parseYaml), null);
  });
  test("ALLOWS a normal property:set foo=bar", () => {
    assert.equal(cliAcceptRefusal("property:set", { name: "foo", value: "bar", file: "Note" }, parseYaml), null);
  });
  test("ALLOWS property:get / property:remove (not set-family)", () => {
    assert.equal(cliAcceptRefusal("property:get", { name: "acceptance-status" }, parseYaml), null);
    assert.equal(cliAcceptRefusal("property:remove", { name: "acceptance-status" }, parseYaml), null);
  });
});

describe("cliAcceptRefusal — content writes (create/append/prepend + periodic)", () => {
  const fence = (v) => `---\nacceptance-status: ${v}\n---\nbody`;
  for (const cmd of ["create", "append", "prepend", "base:create", "daily:append", "weekly:prepend", "monthly:create"]) {
    test(`REJECTS ${cmd} whose content carries an accepted fence`, () => {
      assert.ok(cliAcceptRefusal(cmd, { content: fence("accepted") }, parseYaml));
    });
  }
  test("REJECTS base:create with an accepted fence (same name=/content= writer as create)", () => {
    assert.ok(cliAcceptRefusal("base:create", { name: "My Base", content: fence("accepted") }, parseYaml));
  });
  test("ALLOWS a normal base:create (no acceptance)", () => {
    assert.equal(cliAcceptRefusal("base:create", { name: "My Base", content: "# View\n\nrows" }, parseYaml), null);
  });
  test("REJECTS an accepted-family VALUE array form (acceptance-status: [accepted])", () => {
    assert.ok(cliAcceptRefusal("create", { content: "---\nacceptance-status: [accepted]\n---\nx" }, parseYaml));
  });
  test("REJECTS a block-sequence accepted form", () => {
    assert.ok(cliAcceptRefusal("create", { content: "---\nacceptance-status:\n  - accepted\n---\nx" }, parseYaml));
  });
  test("REJECTS an accepted-by provenance key in a fence", () => {
    assert.ok(cliAcceptRefusal("append", { content: "---\naccepted-by: Nelson\n---\n" }, parseYaml));
  });
  test("REJECTS an escaped-newline fence (\\n interpreted by the CLI)", () => {
    assert.ok(cliAcceptRefusal("create", { content: "---\\nacceptance-status: accepted\\n---\\nbody" }, parseYaml));
  });
  test("REJECTS an embedded (non-leading) accepted fence, conservatively", () => {
    assert.ok(cliAcceptRefusal("append", { content: "some body\n\n---\nacceptance-status: accepted\n---\n" }, parseYaml));
  });
  // ── ALLOWED — legitimate content writes are untouched ──
  test("ALLOWS a plain content write with no frontmatter", () => {
    assert.equal(cliAcceptRefusal("append", { content: "New line" }, parseYaml), null);
  });
  test("ALLOWS content whose fence sets acceptance-status: proposed", () => {
    assert.equal(cliAcceptRefusal("create", { content: fence("proposed") }, parseYaml), null);
  });
  test("ALLOWS a heading that merely mentions the word accepted in prose", () => {
    assert.equal(cliAcceptRefusal("create", { content: "# Accepted papers\n\nNotes about accepted submissions." }, parseYaml), null);
  });
  test("fails CLOSED on a fence when no parser is injected", () => {
    assert.ok(cliAcceptRefusal("create", { content: fence("proposed") }, undefined));
  });
});

describe("cliAcceptRefusal — unrelated commands are clean", () => {
  for (const cmd of ["read", "search", "history:list", "help", "backlinks", "quickadd", "quickadd:run", "eval", "command"]) {
    test(`${cmd} is not accept-guarded (returns null)`, () => {
      assert.equal(cliAcceptRefusal(cmd, { file: "Note", query: "accepted" }, parseYaml), null);
    });
  }
  test("the opaque-macro set is named for the report/description (authoritative copy in cli-policy.ts)", () => {
    assert.deepEqual(
      [...CLI_OPAQUE_ACCEPT_RESIDUAL].sort(),
      ["command", "eval", "quickadd", "quickadd:run", "quickadd:run-template"],
    );
  });
});

// ── handler integration: refused BEFORE exec, coded Error [accept_forbidden] ───

describe("registerCliTools — accept guard wired into the handler", () => {
  function recordingServer() {
    const server = fakeServer();
    const calls = [];
    const exec = async (bin, args) => { calls.push(args); return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false }; };
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec, parseYaml });
    return { handler: server.tools.get("obsidian_cli").handler, calls };
  }

  test("property:set acceptance-status=accepted is refused and NOT executed", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", params: { name: "acceptance-status", value: "accepted", file: "Note" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[accept_forbidden\]/);
    assert.equal(calls.length, 0);
  });

  test("create with an accepted fence is refused and NOT executed", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "create", params: { name: "N", content: "---\nacceptance-status: accepted\n---\nbody" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /accept_forbidden/);
    assert.equal(calls.length, 0);
  });

  test("append with an accepted fence is refused and NOT executed", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "append", params: { file: "N", content: "---\naccepted-on: 2026-08-10\n---\n" } });
    assert.equal(res.isError, true);
    assert.equal(calls.length, 0);
  });

  test("a normal property:set foo=bar runs", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", params: { name: "foo", value: "bar", file: "Note" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("acceptance-status=proposed runs (agents DO write proposed)", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", params: { name: "acceptance-status", value: "proposed", file: "Note" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("a normal content write runs", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "create", params: { name: "N", content: "# Hello" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("the former quickadd residual is CLOSED: denied by the command policy, not the accept guard", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "quickadd", params: { choice: "Some Macro" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.equal(calls.length, 0);
    // The accept guard itself still does not match quickadd — the closure is
    // the policy's, and cliAcceptRefusal stays scoped to inspectable writes.
    assert.equal(cliAcceptRefusal("quickadd", { choice: "Some Macro" }, parseYaml), null);
  });
});
