/**
 * run-command-policy.test.mjs — the command policy wired into the REAL
 * `obsidian_run_command` handler (tools-complementary.ts).
 *
 * Uses the obsidian stub (sparingly, per its own charter): the property under
 * test — a policy-refused command id executes NOTHING, not even the
 * `file_path` open that precedes execution — is a property of the real
 * handler's ordering, not of a re-implementation. The pure policy semantics
 * are covered in cli-policy.test.mjs; this file pins only the wiring.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");

function build(settings = {}) {
  const server = fakeServer();
  const opened = [];
  const executed = [];
  const app = {
    workspace: { openLinkText: async (p) => opened.push(p) },
    commands: { executeCommandById: (id) => (executed.push(id), true) },
    vault: { getMarkdownFiles: () => [], getName: () => "test" },
    metadataCache: {},
  };
  const ctx = {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "test",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], ...settings }),
  };
  registerComplementaryTools(server, app, ctx);
  return { handler: server.tools.get("obsidian_run_command").handler, opened, executed };
}

describe("obsidian_run_command: policy wiring in the real handler", () => {
  test("a quickadd:* id is refused cli_denied BEFORE the file_path open", async () => {
    const { handler, opened, executed } = build();
    const res = await handler({ command_id: "quickadd:runQuickAdd", file_path: "Inbox/Note.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cli_denied\]/);
    assert.deepEqual(opened, []);
    assert.deepEqual(executed, []);
  });

  test("an ordinary id executes, with the file_path opened first", async () => {
    const { handler, opened, executed } = build();
    const res = await handler({ command_id: "editor:toggle-bold", file_path: "Inbox/Note.md" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(opened, ["Inbox/Note.md"]);
    assert.deepEqual(executed, ["editor:toggle-bold"]);
  });

  test("an exact allowOpaque entry re-enables exactly that id", async () => {
    const { handler, executed } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:runQuickAdd"] } });
    const ok = await handler({ command_id: "quickadd:runQuickAdd" });
    assert.notEqual(ok.isError, true);
    assert.deepEqual(executed, ["quickadd:runQuickAdd"]);
    const denied = await handler({ command_id: "quickadd:toggleMacro" });
    assert.equal(denied.isError, true);
  });

  test("the settings deny list gates ordinary ids too", async () => {
    const { handler, executed } = build({ cliPolicy: { deny: ["templater:*"], allowOpaque: [] } });
    const res = await handler({ command_id: "templater:insert" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.deepEqual(executed, []);
  });
});
