/**
 * cli-dedicated.test.mjs — the dedicated pinned-subcommand CLI tools
 * (tools-cli-dedicated.ts): the obsidian_cli decomposition.
 *
 * The exec layer is injected (same seam as the raw proxy), so every handler is
 * fully testable headlessly: pinned argv construction (vault pinned, command a
 * constant), the settings deny list, the danger gate on plugin
 * install/uninstall, the accept scan on base:create content, .obsidian/..
 * param refusal, allowlist behavior (path-scoped reads vs refuse-outright
 * mutators), and the deliberate ABSENCE of any history:restore tool (#110).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { registerCliDedicatedTools, DEDICATED_CLI_COMMANDS } from "../src/mcp/tools-cli-dedicated.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { fakeServer } from "./fake-server.mjs";
import { parseYaml } from "./obsidian-stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function ctxWith(settings) {
  return {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "testvault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: false, ...settings }),
  };
}

function build(settings = {}, deps = {}) {
  const server = fakeServer();
  const calls = [];
  const exec = deps.exec ?? (async (bin, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: `ran ${args.join(" ")}`, stderr: "", timedOut: false };
  });
  registerCliDedicatedTools(server, ctxWith(settings), { binary: "/bin/obsidian", exec, parseYaml, ...deps });
  return { server, calls };
}

const EXPECTED_TOOLS = [
  "obsidian_note_history",
  "obsidian_note_diff",
  "obsidian_base_create",
  "obsidian_plugin_install",
  "obsidian_plugin_uninstall",
];

// ── registration surface ──────────────────────────────────────────────────────

describe("registerCliDedicatedTools — registration", () => {
  test("does not register without a binary", () => {
    const server = fakeServer();
    registerCliDedicatedTools(server, ctxWith({}), { binary: null });
    assert.equal(server.tools.size, 0);
  });

  test("registers exactly the five dedicated tools (no restore tool — #110)", () => {
    const { server } = build();
    assert.deepEqual([...server.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  });

  test("read tools are read-only; base_create/install/uninstall are mutating with the right hints", () => {
    const { server } = build();
    assert.equal(server.tools.get("obsidian_note_history").def.annotations.readOnlyHint, true);
    assert.equal(server.tools.get("obsidian_note_diff").def.annotations.readOnlyHint, true);
    assert.equal(server.tools.get("obsidian_base_create").def.annotations.readOnlyHint, false);
    const install = server.tools.get("obsidian_plugin_install").def.annotations;
    assert.equal(install.readOnlyHint, false);
    assert.equal(install.openWorldHint, true, "plugin install fetches the network");
    const uninstall = server.tools.get("obsidian_plugin_uninstall").def.annotations;
    assert.equal(uninstall.readOnlyHint, false);
    assert.equal(uninstall.destructiveHint, true, "uninstall destroys code + settings");
  });

  test("no dedicated tool pins history:restore, and no source registration does either (#110)", async () => {
    assert.ok(!Object.values(DEDICATED_CLI_COMMANDS).includes("history:restore"));
    const source = await readFile(resolve(HERE, "../src/mcp/tools-cli-dedicated.ts"), "utf-8");
    // The string may appear in comments explaining the exclusion; it must never
    // appear as a pinned command VALUE in the mapping.
    assert.ok(
      !/:\s*"history:restore"/.test(source),
      "tools-cli-dedicated.ts must not pin history:restore as a command"
    );
  });
});

// ── happy paths: pinned argv through the shared transport ─────────────────────

describe("dedicated tools — pinned argv", () => {
  test("obsidian_note_history runs `history path=…` with the vault pinned", async () => {
    const { server, calls } = build();
    const res = await server.tools.get("obsidian_note_history").handler({ path: "Inbox/Note.md" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(calls, [["vault=testvault", "history", "path=Inbox/Note.md"]]);
    assert.equal(res.structuredContent.command, "history");
    assert.equal(res.structuredContent.exit_code, 0);
  });

  test("obsidian_note_diff forwards from/to/filter as typed params", async () => {
    const { server, calls } = build();
    const res = await server.tools
      .get("obsidian_note_diff")
      .handler({ path: "Inbox/Note.md", from: 2, to: 5, filter: "local" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(calls, [["vault=testvault", "diff", "path=Inbox/Note.md", "from=2", "to=5", "filter=local"]]);
  });

  test("obsidian_note_diff with only a path lists versions (no from/to in argv)", async () => {
    const { server, calls } = build();
    await server.tools.get("obsidian_note_diff").handler({ path: "A.md" });
    assert.deepEqual(calls, [["vault=testvault", "diff", "path=A.md"]]);
  });

  test("obsidian_base_create runs `base:create` with path/name/content/view", async () => {
    const { server, calls } = build();
    const res = await server.tools
      .get("obsidian_base_create")
      .handler({ path: "Bases/Projects.base", name: "New item", content: "# Hi", view: "Table" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(calls, [
      ["vault=testvault", "base:create", "path=Bases/Projects.base", "name=New item", "content=# Hi", "view=Table"],
    ]);
  });

  test("obsidian_plugin_install runs `plugin:install id=…` when the danger gate is open", async () => {
    const { server, calls } = build({ allowDangerousCli: true });
    const res = await server.tools.get("obsidian_plugin_install").handler({ plugin_id: "dataview" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(calls, [["vault=testvault", "plugin:install", "id=dataview"]]);
  });

  test("obsidian_plugin_uninstall runs `plugin:uninstall id=…` when the danger gate is open", async () => {
    const { server, calls } = build({ allowDangerousCli: true });
    const res = await server.tools.get("obsidian_plugin_uninstall").handler({ plugin_id: "dataview" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(calls, [["vault=testvault", "plugin:uninstall", "id=dataview"]]);
  });

  test("a non-zero exit keeps the structured report but flags isError", async () => {
    const exec = async () => ({ exitCode: 2, stdout: "no versions", stderr: "boom", timedOut: false });
    const { server } = build({}, { exec });
    const res = await server.tools.get("obsidian_note_history").handler({ path: "A.md" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.exit_code, 2);
    assert.equal(res.structuredContent.stderr, "boom");
  });

  test("a timeout surfaces timed_out plus the may-have-completed note", async () => {
    const exec = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const { server } = build({}, { exec });
    const res = await server.tools.get("obsidian_note_diff").handler({ path: "A.md" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.timed_out, true);
    assert.match(res.structuredContent.note, /may still have completed/);
  });
});

// ── the danger gate (plugin install/uninstall) ────────────────────────────────

describe("dedicated plugin tools — danger-gate parity with the raw proxy", () => {
  test("install is refused, never executed, when the toggle is off — same message as the proxy", async () => {
    const { server, calls } = build();
    const res = await server.tools.get("obsidian_plugin_install").handler({ plugin_id: "dataview" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /'plugin:install' is dangerous/);
    assert.match(res.content[0].text, /Allow dangerous CLI commands/);
    assert.equal(calls.length, 0);
  });

  test("uninstall is refused, never executed, when the toggle is off", async () => {
    const { server, calls } = build();
    const res = await server.tools.get("obsidian_plugin_uninstall").handler({ plugin_id: "dataview" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /'plugin:uninstall' is dangerous/);
    assert.equal(calls.length, 0);
  });

  test("uninstalling vault-mcp itself is refused even with the gate open", async () => {
    const { server, calls } = build({ allowDangerousCli: true });
    const res = await server.tools.get("obsidian_plugin_uninstall").handler({ plugin_id: "vault-mcp" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /refusing to uninstall vault-mcp/);
    assert.equal(calls.length, 0);
  });
});

// ── the settings deny list still binds (guard machinery composes) ─────────────

describe("dedicated tools — command policy deny list", () => {
  test("a denied pinned command refuses cli_denied and never executes", async () => {
    const { server, calls } = build({ cliPolicy: { deny: ["history"], allowOpaque: [] } });
    const res = await server.tools.get("obsidian_note_history").handler({ path: "A.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[cli_denied\]/);
    assert.equal(calls.length, 0);
  });

  test("a deny GLOB covers the pinned plugin commands too", async () => {
    const { server, calls } = build({ allowDangerousCli: true, cliPolicy: { deny: ["plugin:*"], allowOpaque: [] } });
    const res = await server.tools.get("obsidian_plugin_install").handler({ plugin_id: "dataview" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.equal(calls.length, 0);
  });
});

// ── .obsidian / traversal territory stays unreachable ─────────────────────────

describe("dedicated tools — config-territory refusal", () => {
  for (const bad of [".obsidian/plugins/vault-mcp/data.json", "../outside.md", "a/../../b.md"]) {
    test(`note_history refuses '${bad}'`, async () => {
      const { server, calls } = build();
      const res = await server.tools.get("obsidian_note_history").handler({ path: bad });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /cli_denied/);
      assert.equal(calls.length, 0);
    });
  }

  test("note_diff refuses .obsidian territory", async () => {
    const { server, calls } = build();
    const res = await server.tools.get("obsidian_note_diff").handler({ path: ".obsidian/app.json" });
    assert.equal(res.isError, true);
    assert.equal(calls.length, 0);
  });

  test("base_create refuses a .obsidian base path", async () => {
    const { server, calls } = build();
    const res = await server.tools.get("obsidian_base_create").handler({ path: ".obsidian/x.base", name: "n" });
    assert.equal(res.isError, true);
    assert.equal(calls.length, 0);
  });
});

// ── accept scan on base:create content (the shared rule, not a fork) ──────────

describe("obsidian_base_create — accept-forbidden guard", () => {
  test("an accepted frontmatter fence in content is refused, never executed", async () => {
    const { server, calls } = build();
    const res = await server.tools
      .get("obsidian_base_create")
      .handler({ path: "B.base", name: "N", content: "---\nacceptance-status: accepted\n---\nbody" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[accept_forbidden\]/);
    assert.equal(calls.length, 0);
  });

  test("an escaped-newline accepted fence is refused too (the CLI un-escapes)", async () => {
    const { server, calls } = build();
    const res = await server.tools
      .get("obsidian_base_create")
      .handler({ path: "B.base", name: "N", content: "---\\nacceptance-status: accepted\\n---\\nbody" });
    assert.equal(res.isError, true);
    assert.equal(calls.length, 0);
  });

  test("a proposed fence is allowed (agents DO write proposed)", async () => {
    const { server, calls } = build();
    const res = await server.tools
      .get("obsidian_base_create")
      .handler({ path: "B.base", name: "N", content: "---\nacceptance-status: proposed\n---\nbody" });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });
});

// ── allowlist behavior ────────────────────────────────────────────────────────

describe("dedicated tools — allowlist", () => {
  const ACTOR = { transport: "mcp", client: "test/1.0", connection: "c1" };

  // The read tools take a `path` argument — a recognized path key — so in
  // production the guard at the interception point scopes them. Prove it by
  // wrapping the registered handler exactly the way server.ts does.
  test("note_history INSIDE the allowlist passes the guard and runs", async () => {
    const settings = { readOnly: false, allowlist: ["Projects"] };
    const { server, calls } = build(settings);
    const { def, handler } = server.tools.get("obsidian_note_history");
    const guarded = makeGuarded({ getSettings: () => settings, actor: () => ACTOR });
    const res = await guarded(def, handler, "obsidian_note_history")({ path: "Projects/A.md" }, {});
    assert.notEqual(res.isError, true);
    assert.deepEqual(calls, [["vault=testvault", "history", "path=Projects/A.md"]]);
  });

  test("note_history OUTSIDE the allowlist is refused out_of_allowlist, never executed", async () => {
    const settings = { readOnly: false, allowlist: ["Projects"] };
    const { server, calls } = build(settings);
    const { def, handler } = server.tools.get("obsidian_note_history");
    const guarded = makeGuarded({ getSettings: () => settings, actor: () => ACTOR });
    const res = await guarded(def, handler, "obsidian_note_history")({ path: "Archive/Secret.md" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.equal(calls.length, 0);
  });

  test("note_diff outside the allowlist is refused the same way", async () => {
    const settings = { readOnly: false, allowlist: ["Projects"] };
    const { server, calls } = build(settings);
    const { def, handler } = server.tools.get("obsidian_note_diff");
    const guarded = makeGuarded({ getSettings: () => settings, actor: () => ACTOR });
    const res = await guarded(def, handler, "obsidian_note_diff")({ path: "Archive/Secret.md", from: 1 }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /out_of_allowlist/);
    assert.equal(calls.length, 0);
  });

  // The unscopable mutators refuse outright while an allowlist is active.
  test("base_create refuses under an active allowlist (landing folder is the base's config)", async () => {
    const { server, calls } = build({ allowlist: ["Projects"] });
    const res = await server.tools.get("obsidian_base_create").handler({ path: "Projects/B.base", name: "N" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /allowlist/);
    assert.equal(calls.length, 0);
  });

  test("plugin install/uninstall refuse under an active allowlist", async () => {
    const { server, calls } = build({ allowlist: ["Projects"], allowDangerousCli: true });
    for (const tool of ["obsidian_plugin_install", "obsidian_plugin_uninstall"]) {
      const res = await server.tools.get(tool).handler({ plugin_id: "dataview" });
      assert.equal(res.isError, true, `${tool} should refuse`);
      assert.match(res.content[0].text, /allowlist/);
    }
    assert.equal(calls.length, 0);
  });

  // Read-only mode: the guard blocks the mutating tools at the interception
  // point (readOnlyHint: false); prove it with the same wrapper.
  test("read-only mode blocks base_create through the guard but not note_history", async () => {
    const settings = { readOnly: true, allowlist: [] };
    const { server, calls } = build(settings);
    const guarded = makeGuarded({ getSettings: () => settings, actor: () => ACTOR });
    const bc = server.tools.get("obsidian_base_create");
    const blocked = await guarded(bc.def, bc.handler, "obsidian_base_create")({ path: "B.base", name: "N" }, {});
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /Error \[read_only\]/);
    const nh = server.tools.get("obsidian_note_history");
    const okRes = await guarded(nh.def, nh.handler, "obsidian_note_history")({ path: "A.md" }, {});
    assert.notEqual(okRes.isError, true);
    assert.equal(calls.length, 1);
  });
});
