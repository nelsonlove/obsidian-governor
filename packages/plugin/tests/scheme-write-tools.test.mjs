/**
 * scheme-write-tools.test.mjs — Task 4 of the scope-provider module: the
 * three mutating tools — obsidian_assign_address, obsidian_refile_address,
 * obsidian_renumber_address.
 *
 * Same fixture shape as scheme-tools.test.mjs (a synthetic vault listing),
 * driven through the fake-server pattern tests/uid-index.test.mjs uses for
 * obsidian_resolve_uid: register against a stand-in server, invoke the
 * captured handler directly.
 *
 * The write tools import `moveOne` (tools-vault-write.ts), which imports live
 * `TFile` from "obsidian" — an obsidian-free specifier at test time only via
 * the same stub-and-dynamic-import pattern link-healing.test.mjs uses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";
import { makeRegistry, DEFAULT_SCHEMES } from "../src/kernel/scheme/registry.ts";

installObsidianStub();
const { registerSchemeWriteTools } = await import("../src/mcp/tools-scheme-write.ts");

const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "90-99 Projects/92021 Big thing/92021.11 Other.md",
  "Unfiled/loose.md",
  "Unfiled/New thing.md",
  "Random/06.13 Oops.md",
];

const FOLDERS = [
  "00-09 System",
  "00-09 System/06 Agent tooling",
  "90-99 Projects",
  "90-99 Projects/92021 Big thing",
  "Unfiled",
  "Random",
];

/** A vault that records how it was moved — same three spies as
 * link-healing.test.mjs's fakeVault: renameFile (link-aware, the only one
 * moveOne should ever call), vaultRename (throws — proves it's never
 * reached), and createFolder (harmless no-op bookkeeping). */
function fakeApp({ files = NOTES, folders = FOLDERS } = {}) {
  const tree = new Map(files.map((p) => [p, new TFile(p)]));
  const dirs = new Set(folders);
  const calls = { renameFile: [], vaultRename: [], trash: [], createFolder: [] };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => tree.get(p) ?? (dirs.has(p) ? new TFolder(p) : null),
      async createFolder(p) {
        calls.createFolder.push(p);
        dirs.add(p);
      },
      async trash(file, system) {
        calls.trash.push([file.path, system]);
        tree.delete(file.path);
      },
      async rename(file, to) {
        calls.vaultRename.push([file.path, to]);
        throw new Error("vault.rename is not link-aware — moves must go through fileManager.renameFile");
      },
      getMarkdownFiles: () => [...tree.values()],
    },
    fileManager: {
      async renameFile(file, to) {
        calls.renameFile.push([file.path, to]);
        tree.delete(file.path);
        tree.set(to, new TFile(to));
      },
    },
  };
  return { app, calls, tree };
}

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, def, handler) {
      tools.set(name, { def, handler });
    },
  };
}

function toolServer({ schemes = DEFAULT_SCHEMES, notes = NOTES, folders = FOLDERS, settings = { readOnly: false, allowlist: [] } } = {}) {
  const { app, calls, tree } = fakeApp({ files: notes, folders });
  const server = fakeServer();
  registerSchemeWriteTools(server, app, {
    registry: () => makeRegistry(schemes),
    notes: () => [...tree.values()].map((f) => f.path),
    getSettings: () => ({ ...settings, schemes }),
  });
  const call = (name, args = {}) => server.tools.get(name).handler(args, {});
  return { server, call, calls, app, tree };
}

// ── registration shape ───────────────────────────────────────────────────────

describe("registration", () => {
  test("registers exactly the three expected tools, all mutating (readOnlyHint: false)", () => {
    const { server } = toolServer();
    assert.deepEqual(
      [...server.tools.keys()].sort(),
      ["obsidian_assign_address", "obsidian_refile_address", "obsidian_renumber_address"].sort(),
    );
    for (const [name, { def }] of server.tools) {
      assert.equal(def.annotations.readOnlyHint, false, `${name} must be mutating`);
    }
  });
});

// ── obsidian_assign_address ──────────────────────────────────────────────────

describe("obsidian_assign_address", () => {
  test("dry_run: true reports the computed address and move, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: true });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: true,
      address: "06.10",
      moves: [{ from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.10 New thing.md" }],
    });
    assert.deepEqual(calls.renameFile, [], "a dry run must not move anything");
  });

  test("dry_run: false performs the move via fileManager.renameFile, never vault.rename", async () => {
    const { call, calls, tree } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: false,
      address: "06.10",
      moves: [{ from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.10 New thing.md" }],
    });
    assert.deepEqual(calls.renameFile, [["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.10 New thing.md"]]);
    assert.deepEqual(calls.vaultRename, []);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.10 New thing.md"), true);
  });

  test("an invalid scope is a coded invalid_scope refusal", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "not a scope!", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[invalid_scope\]/);
    assert.deepEqual(calls.renameFile, []);
  });

  test("an unknown scheme id is a plain refusal (an argument problem, not a scope problem)", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", scheme: "nope", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unknown scheme/);
  });

  test("a path outside the allowlist is a coded out_of_allowlist refusal, before any planning runs", async () => {
    const { call, calls } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.deepEqual(calls.renameFile, []);
  });

  test("an exhausted scope surfaces planAssign's own error verbatim via fail()", async () => {
    const filler = [];
    for (let n = 10; n <= 99; n++) filler.push(`00-09 System/06 Agent tooling/06.${n} Filler.md`);
    filler.push("Unfiled/New thing.md");
    const { call } = toolServer({ notes: filler });
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /exhaust/i);
  });
});

// ── obsidian_refile_address ──────────────────────────────────────────────────

describe("obsidian_refile_address", () => {
  test("dry_run: true reports the misfiled note's move, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: true });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: true,
      address: "06.13",
      moves: [{ from: "Random/06.13 Oops.md", to: "00-09 System/06 Agent tooling/06.13 Oops.md" }],
    });
    assert.deepEqual(calls.renameFile, []);
  });

  test("dry_run: false performs the move via fileManager.renameFile", async () => {
    const { call, calls, tree } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.renameFile, [["Random/06.13 Oops.md", "00-09 System/06 Agent tooling/06.13 Oops.md"]]);
    assert.deepEqual(calls.vaultRename, []);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.13 Oops.md"), true);
    assert.equal(res.structuredContent.address, "06.13");
  });

  test("an already-correctly-filed note reports already_correct: true and moves nothing, dry_run or not", async () => {
    const { call, calls } = toolServer();
    for (const dry_run of [true, false]) {
      const res = await call("obsidian_refile_address", { path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md", dry_run });
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      assert.deepEqual(res.structuredContent, { dry_run, address: "06.11", moves: [], already_correct: true });
    }
    assert.deepEqual(calls.renameFile, []);
  });

  test("a note with no address in any configured scheme is refused", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Unfiled/loose.md", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no address in any configured scheme/);
  });

  test("a path outside the allowlist is a coded out_of_allowlist refusal", async () => {
    const { call, calls } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.deepEqual(calls.renameFile, []);
  });
});

// ── obsidian_renumber_address ────────────────────────────────────────────────

describe("obsidian_renumber_address", () => {
  test("dry_run: true reports the single move when the target is free, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.20",
      dry_run: true,
      on_occupied: "fail",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: true,
      moves: [{ from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.20 New thing.md" }],
      displaced: null,
    });
    assert.deepEqual(calls.renameFile, []);
  });

  test("dry_run: false performs the single move when the target is free", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.20",
      dry_run: false,
      on_occupied: "fail",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.renameFile, [["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.20 New thing.md"]]);
  });

  test("on_occupied 'fail' (the default) refuses when the target is occupied, with no moves performed", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.11",
      dry_run: false,
      on_occupied: "fail",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /occupied/);
    assert.deepEqual(calls.renameFile, []);
  });

  // The fake harness (like scheme-tools.test.mjs's and link-healing.test.mjs's)
  // invokes handlers directly and does not run the SDK's zod parsing, so a
  // schema-level `.default(...)` never applies to an omitted argument through
  // this harness — it's exercised at the schema itself instead.
  test("on_occupied's zod schema defaults to 'fail'", () => {
    const { server } = toolServer();
    const schema = server.tools.get("obsidian_renumber_address").def.inputSchema.on_occupied;
    assert.equal(schema.parse(undefined), "fail");
  });

  test("on_occupied 'auto' — dry_run reports both moves, occupant first, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.11",
      dry_run: true,
      on_occupied: "auto",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent.moves, [
      { from: "00-09 System/06 Agent tooling/06.11 Vault MCP.md", to: "00-09 System/06 Agent tooling/06.10 Vault MCP.md" },
      { from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.11 New thing.md" },
    ]);
    assert.equal(res.structuredContent.displaced, "00-09 System/06 Agent tooling/06.10 Vault MCP.md");
    assert.deepEqual(calls.renameFile, []);
  });

  test("on_occupied 'auto' — apply performs BOTH moves, occupant strictly before source (call-log order)", async () => {
    const { call, calls, tree } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.11",
      dry_run: false,
      on_occupied: "auto",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.renameFile, [
      ["00-09 System/06 Agent tooling/06.11 Vault MCP.md", "00-09 System/06 Agent tooling/06.10 Vault MCP.md"],
      ["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.11 New thing.md"],
    ]);
    assert.deepEqual(calls.vaultRename, []);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.10 Vault MCP.md"), true);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.11 New thing.md"), true);
    assert.equal(res.structuredContent.displaced, "00-09 System/06 Agent tooling/06.10 Vault MCP.md");
  });

  test("on_occupied 'manual' — requires displace_to, and moves occupant there first", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.11",
      dry_run: false,
      on_occupied: "manual",
      displace_to: "06.50",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.renameFile, [
      ["00-09 System/06 Agent tooling/06.11 Vault MCP.md", "00-09 System/06 Agent tooling/06.50 Vault MCP.md"],
      ["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.11 New thing.md"],
    ]);
  });

  test("on_occupied 'manual' without displace_to is refused by the planner", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.11",
      dry_run: true,
      on_occupied: "manual",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /displace_to/);
    assert.deepEqual(calls.renameFile, []);
  });

  test("an unparseable `to` is refused before any planning runs", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", { path: "Unfiled/New thing.md", to: "not an address!", dry_run: true });
    assert.equal(res.isError, true);
    assert.deepEqual(calls.renameFile, []);
  });

  test("an unparseable displace_to (on_occupied manual) is refused before any planning runs", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.11",
      dry_run: true,
      on_occupied: "manual",
      displace_to: "not an address!",
    });
    assert.equal(res.isError, true);
    assert.deepEqual(calls.renameFile, []);
  });

  test("a path outside the allowlist is a coded out_of_allowlist refusal", async () => {
    const { call, calls } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_renumber_address", { path: "Unfiled/New thing.md", to: "06.20", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.deepEqual(calls.renameFile, []);
  });

  test("a partial failure mid-execution reports which step landed and which failed, naming both paths", async () => {
    const { app, calls, tree } = fakeApp();
    // Make the SECOND move (the source note into 06.11) fail by having
    // fileManager.renameFile throw only for that specific destination —
    // the occupant's own displacement (the first step) must still succeed.
    const originalRename = app.fileManager.renameFile.bind(app.fileManager);
    app.fileManager.renameFile = async (file, to) => {
      if (to === "00-09 System/06 Agent tooling/06.11 New thing.md") {
        calls.renameFile.push([file.path, to]);
        throw new Error("simulated failure");
      }
      return originalRename(file, to);
    };
    const server = fakeServer();
    registerSchemeWriteTools(server, app, {
      registry: () => makeRegistry(DEFAULT_SCHEMES),
      notes: () => [...tree.values()].map((f) => f.path),
      getSettings: () => ({ readOnly: false, allowlist: [], schemes: DEFAULT_SCHEMES }),
    });
    const call = (name, args = {}) => server.tools.get(name).handler(args, {});

    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to: "06.11",
      dry_run: false,
      on_occupied: "auto",
    });

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /inconsistent state/);
    assert.match(res.content[0].text, /00-09 System\/06 Agent tooling\/06\.11 Vault MCP\.md/);
    assert.match(res.content[0].text, /00-09 System\/06 Agent tooling\/06\.10 Vault MCP\.md/);
    assert.match(res.content[0].text, /Unfiled\/New thing\.md/);
    // The occupant's own move already landed — the vault really is in the
    // reported inconsistent state, not merely described as such.
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.10 Vault MCP.md"), true);
    assert.equal(tree.has("Unfiled/New thing.md"), true, "the source note never moved");
  });
});
