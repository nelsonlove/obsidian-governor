/**
 * cli-policy.test.mjs — the command allow/deny policy (mcp/cli-policy.ts)
 * closing the accept-scar's opaque residual, and its wiring into the
 * obsidian_cli handler.
 *
 * Load-bearing properties:
 *   • the opaque-accept set is DENIED BY DEFAULT (fail closed) on both
 *     surfaces — obsidian_cli commands and obsidian_run_command ids;
 *   • re-enable is per-command (allowOpaque names exactly one entry);
 *   • deny ALWAYS wins — over allowOpaque, over defaults;
 *   • the policy composes with the danger gate: a re-enabled `eval` still
 *     needs allowDangerousCli;
 *   • refusals are typed Error [cli_denied], and nothing executes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  OPAQUE_ACCEPT_CLI_COMMANDS,
  OPAQUE_ACCEPT_COMMAND_IDS,
  cliCommandRefusal,
  matchesCommandPattern,
  runCommandRefusal,
} from "../src/mcp/cli-policy.ts";
import { registerCliTools } from "../src/mcp/tools-cli.ts";

describe("matchesCommandPattern", () => {
  test("exact match, no substring leakage", () => {
    assert.equal(matchesCommandPattern("quickadd", "quickadd"), true);
    assert.equal(matchesCommandPattern("quickadd:run", "quickadd"), false);
    assert.equal(matchesCommandPattern("myquickadd", "quickadd"), false);
  });

  test("trailing * is a prefix glob", () => {
    assert.equal(matchesCommandPattern("quickadd:runQuickAdd", "quickadd:*"), true);
    assert.equal(matchesCommandPattern("quickadd", "quickadd:*"), false);
    assert.equal(matchesCommandPattern("anything-at-all", "*"), true);
  });

  test("case-sensitive (matches the danger gate's discipline)", () => {
    assert.equal(matchesCommandPattern("Eval", "eval"), false);
  });

  test("empty pattern matches nothing", () => {
    assert.equal(matchesCommandPattern("x", ""), false);
    assert.equal(matchesCommandPattern("x", "  "), false);
  });
});

describe("cliCommandRefusal: the opaque-accept default", () => {
  test("every opaque-accept command is denied with no policy at all", () => {
    for (const cmd of OPAQUE_ACCEPT_CLI_COMMANDS) {
      assert.ok(cliCommandRefusal(cmd), `${cmd} must be denied by default`);
      assert.ok(cliCommandRefusal(cmd, {}), `${cmd} must be denied with an empty policy`);
    }
  });

  test("ordinary commands are untouched", () => {
    for (const cmd of ["help", "history:list", "theme:set", "property:get", "create"]) {
      assert.equal(cliCommandRefusal(cmd, {}), null, cmd);
    }
  });

  test("allowOpaque re-enables exactly the named command", () => {
    const policy = { allowOpaque: ["quickadd"] };
    assert.equal(cliCommandRefusal("quickadd", policy), null);
    assert.ok(cliCommandRefusal("quickadd:run", policy), "quickadd:run stays denied");
    assert.ok(cliCommandRefusal("eval", policy), "eval stays denied");
  });

  test("deny beats allowOpaque", () => {
    const policy = { deny: ["quickadd"], allowOpaque: ["quickadd"] };
    assert.ok(cliCommandRefusal("quickadd", policy));
  });

  test("deny extends to arbitrary commands, exact or glob", () => {
    const policy = { deny: ["history:restore", "theme:*"] };
    assert.ok(cliCommandRefusal("history:restore", policy));
    assert.ok(cliCommandRefusal("theme:set", policy));
    assert.equal(cliCommandRefusal("history:list", policy), null);
  });
});

describe("runCommandRefusal: command ids", () => {
  test("quickadd:* ids are denied by default; ordinary ids are not", () => {
    assert.ok(runCommandRefusal("quickadd:runQuickAdd", {}));
    assert.equal(runCommandRefusal("editor:toggle-bold", {}), null);
    assert.equal(runCommandRefusal("daily-notes", {}), null);
  });

  test("allowOpaque can re-enable a specific id or the whole prefix", () => {
    assert.equal(runCommandRefusal("quickadd:runQuickAdd", { allowOpaque: ["quickadd:runQuickAdd"] }), null);
    assert.ok(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:runQuickAdd"] }));
    assert.equal(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:*"] }), null);
  });

  test("deny beats allowOpaque for ids too", () => {
    assert.ok(runCommandRefusal("quickadd:runQuickAdd", { deny: ["quickadd:*"], allowOpaque: ["quickadd:*"] }));
  });

  test("the default id set is exactly the QuickAdd prefix", () => {
    assert.deepEqual([...OPAQUE_ACCEPT_COMMAND_IDS], ["quickadd:*"]);
  });
});

// ── handler integration: the policy refuses BEFORE anything executes ─────────

function ctxWith(settings) {
  return {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "testvault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: false, ...settings }),
  };
}

function cliServer(settings) {
  const server = fakeServer();
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "ran", stderr: "", timedOut: false };
  };
  registerCliTools(server, ctxWith(settings), { binary: "/bin/obsidian", exec });
  return { handler: server.tools.get("obsidian_cli").handler, calls };
}

describe("obsidian_cli handler: policy wiring", () => {
  test("quickadd is refused typed cli_denied and never executes", async () => {
    const { handler, calls } = cliServer({});
    const res = await handler({ command: "quickadd", params: { choice: "My Macro" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cli_denied\]/);
    assert.equal(calls.length, 0);
  });

  test("allowOpaque re-enables quickadd; the sibling commands stay denied", async () => {
    const { handler, calls } = cliServer({ cliPolicy: { deny: [], allowOpaque: ["quickadd"] } });
    const ok = await handler({ command: "quickadd", params: { choice: "My Macro" } });
    assert.notEqual(ok.isError, true);
    assert.equal(calls.length, 1);
    const denied = await handler({ command: "quickadd:run" });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /cli_denied/);
  });

  test("policy composes with the danger gate: re-enabled eval still danger-blocked", async () => {
    const { handler, calls } = cliServer({ cliPolicy: { deny: [], allowOpaque: ["eval"] } });
    const res = await handler({ command: "eval", params: { code: "1+1" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /dangerous/);
    assert.equal(calls.length, 0);
  });

  test("re-enabled eval + allowDangerousCli runs", async () => {
    const { handler, calls } = cliServer({
      allowDangerousCli: true,
      cliPolicy: { deny: [], allowOpaque: ["eval"] },
    });
    const res = await handler({ command: "eval", params: { code: "1+1" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("eval with allowDangerousCli but WITHOUT allowOpaque is policy-denied (the new fail-closed default)", async () => {
    const { handler, calls } = cliServer({ allowDangerousCli: true });
    const res = await handler({ command: "eval", params: { code: "1+1" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.equal(calls.length, 0);
  });

  test("settings deny list blocks an otherwise-ordinary command", async () => {
    const { handler, calls } = cliServer({ cliPolicy: { deny: ["history:restore"], allowOpaque: [] } });
    const res = await handler({ command: "history:restore", params: { file: "A.md" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.equal(calls.length, 0);
    const fine = await handler({ command: "history:list", params: { file: "A.md" } });
    assert.notEqual(fine.isError, true);
  });
});
