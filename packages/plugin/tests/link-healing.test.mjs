/**
 * link-healing.test.mjs — slice 2.2, which closes Delivery step 2 ("the uid
 * index and link healing").
 *
 * Healing has two halves, and this file pins both:
 *
 *   • IN BAND — a move through this server heals its own links, because every
 *     move path renames through `app.fileManager.renameFile`, Obsidian's
 *     link-updating API. `vault.rename` moves the bytes and leaves every
 *     backlink pointing at a note that is no longer there, so calling it is the
 *     regression this file exists to catch. The fake app's `vault.rename`
 *     THROWS: a future refactor that reaches for it fails loudly here.
 *   • OUT OF BAND — drift that no move of ours caused is REPORTED, never
 *     repaired (Assent ch6: the rail detects, the human fixes).
 *     `obsidian_check_links` is read-only, takes no queue slot, and discloses
 *     nothing the caller's allowlist hides.
 *
 * Plus D1 from the Cycle 7 adversarial review: obsidian_resolve_uid's no-arg
 * totals are allowlist-filtered too.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";
import { UidIndex } from "../src/kernel/index.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { registerLinkTools, obsidianLinkSource } from "../src/mcp/tools-links.ts";
import { registerUidTools } from "../src/mcp/tools-uid.ts";

// The move handlers import live Obsidian classes, so the specifier is pointed
// at the stub BEFORE they are imported. Everything above is obsidian-free.
installObsidianStub();
const { registerVaultWriteTools } = await import("../src/mcp/tools-vault-write.ts");
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerFsTools } = await import("@vault-mcp/core");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolvePath(HERE, "../src");
const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };

// ── a vault that records how it was moved ─────────────────────────────────────

/**
 * The three surfaces a move touches, each a spy. `vault.rename` exists and
 * throws — present so "it was never called" is a real assertion about a real
 * method rather than about a typo.
 */
function fakeVault({ files = ["Notes/A.md"], folders = ["Notes"] } = {}) {
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
    metadataCache: { unresolvedLinks: {} },
  };
  return { app, calls, tree };
}

function fakeServer() {
  const tools = new Map();
  return {
    server: { registerTool: (name, def, handler) => tools.set(name, { def, handler }) },
    tools,
    call: (name, args = {}) => tools.get(name).handler(args, {}),
    def: (name) => tools.get(name).def,
  };
}

// ── A. moves are link-aware ───────────────────────────────────────────────────

describe("moves rename through Obsidian's link-updating API", () => {
  test("obsidian_move_note (fs tool → ObsidianBackend) calls fileManager.renameFile, never vault.rename", async () => {
    const { app, calls, tree } = fakeVault();
    const s = fakeServer();
    registerFsTools(s.server, new ObsidianBackend(app), { decodeHtml: false });

    const res = await s.call("obsidian_move_note", {
      from: "Notes/A.md",
      to: "Archive/2026/A.md",
      update_backlinks: true,
      overwrite: false,
    });

    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.renameFile, [["Notes/A.md", "Archive/2026/A.md"]]);
    assert.deepEqual(calls.vaultRename, [], "vault.rename would move the bytes and orphan every backlink");
    assert.equal(tree.has("Archive/2026/A.md"), true);
    // Obsidian rewrites backlinks internally and reports no count, so the
    // response omits the fields rather than claiming zero.
    assert.equal(res.structuredContent.moved, true);
    assert.equal("backlinks_updated" in res.structuredContent, false);
  });

  test("update_backlinks:false still renames through fileManager — there is no non-rewriting rename", async () => {
    const { app, calls } = fakeVault();
    const s = fakeServer();
    registerFsTools(s.server, new ObsidianBackend(app), { decodeHtml: false });

    await s.call("obsidian_move_note", {
      from: "Notes/A.md",
      to: "Notes/B.md",
      update_backlinks: false,
      overwrite: false,
    });

    assert.deepEqual(calls.renameFile, [["Notes/A.md", "Notes/B.md"]]);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("obsidian_move_notes (batch) routes every item through fileManager.renameFile", async () => {
    const { app, calls } = fakeVault({ files: ["Notes/A.md", "Notes/B.md"], folders: ["Notes"] });
    const s = fakeServer();
    registerVaultWriteTools(s.server, app);

    const res = await s.call("obsidian_move_notes", {
      moves: [
        { from: "Notes/A.md", to: "Archive/A.md" },
        { from: "Notes/B.md", to: "Archive/B.md" },
      ],
      overwrite: false,
    });

    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.count, 2);
    assert.deepEqual(calls.renameFile, [
      ["Notes/A.md", "Archive/A.md"],
      ["Notes/B.md", "Archive/B.md"],
    ]);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("an overwriting move trashes the destination recoverably, then renames link-aware", async () => {
    const { app, calls } = fakeVault({ files: ["Notes/A.md", "Notes/B.md"] });
    const s = fakeServer();
    registerVaultWriteTools(s.server, app);

    await s.call("obsidian_move_notes", { moves: [{ from: "Notes/A.md", to: "Notes/B.md" }], overwrite: true });

    assert.deepEqual(calls.trash, [["Notes/B.md", true]], "system trash, so the overwritten note is recoverable");
    assert.deepEqual(calls.renameFile, [["Notes/A.md", "Notes/B.md"]]);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("no move path anywhere in the plugin source reaches for vault.rename", async () => {
    const files = ["mcp/obsidian-backend.ts", "mcp/tools-vault-write.ts", "mcp/tools-complementary.ts", "mcp/tools-nav.ts"];
    for (const rel of files) {
      const text = await readFile(resolvePath(SRC, rel), "utf8");
      const offending = text
        .split("\n")
        .filter((line) => /\bvault\s*\.\s*rename\s*\(/.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
      assert.deepEqual(offending, [], `${rel} calls vault.rename — use app.fileManager.renameFile`);
    }
  });
});

// ── B. obsidian_check_links — read-only drift report ──────────────────────────

describe("obsidian_check_links", () => {
  function linkServer({ unresolved = {}, uids = null, allowlist = [], kernel } = {}) {
    const index = uids ? new UidIndex({ paths: () => Object.keys(uids), uidOf: (p) => uids[p] }) : null;
    index?.rebuild();
    const s = fakeServer();
    const k = kernel === undefined ? (index ? { uids: index } : null) : kernel;
    registerLinkTools(s.server, obsidianLinkSource({ metadataCache: { unresolvedLinks: unresolved } }), {
      kernel: k,
      getSettings: () => ({ readOnly: false, allowlist }),
    });
    return { ...s, index, call: (args = {}) => s.call("obsidian_check_links", args) };
  }

  test("it registers read-only, and says so in its annotations", () => {
    const { def } = linkServer();
    assert.deepEqual(def("obsidian_check_links").annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("no accept/approve/grant verb, and no auto-repair verb, in its vocabulary", () => {
    const d = linkServer().def("obsidian_check_links");
    const text = `obsidian_check_links ${d.title} ${d.description}`.toLowerCase();
    for (const banned of ["grant", "approve", "accept", "auto-heal", "autoheal"]) {
      assert.equal(text.includes(banned), false, banned);
    }
  });

  test("read-only means it never reaches the write queue: runMutation is not called", async () => {
    let mutations = 0;
    const index = new UidIndex({ paths: () => [], uidOf: () => undefined });
    index.rebuild();
    const kernel = {
      uids: index,
      runMutation: () => {
        mutations++;
        throw new Error("a read-only report must never take a queue slot or write a journal record");
      },
    };
    const { tools } = linkServer({ unresolved: { "A.md": { Ghost: 1 } }, kernel });
    const { def, handler } = tools.get("obsidian_check_links");
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      kernel,
      actor: () => ACTOR,
    })(def, handler, "obsidian_check_links");

    const res = await guarded({}, {});
    assert.equal(res.isError, undefined);
    assert.equal(mutations, 0);
  });

  test("it is not blocked in read-only mode — a report is a read", async () => {
    const { tools } = linkServer({ unresolved: { "A.md": { Ghost: 1 } } });
    const { def, handler } = tools.get("obsidian_check_links");
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: true, allowlist: [] }),
      kernel: null,
      actor: () => ACTOR,
    })(def, handler, "obsidian_check_links");
    const res = await guarded({}, {});
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.dangling_links.link_count, 1);
  });

  test("it reports a dangling wikilink: which note, which link text, how many", async () => {
    const { call } = linkServer({
      unresolved: { "Notes/A.md": { "Missing Note": 2, Ghost: 1 }, "Notes/B.md": {} },
    });
    const res = await call();
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.dangling_links, {
      note_count: 1,
      link_count: 3,
      truncated: false,
      items: [
        { from: "Notes/A.md", link: "Ghost", count: 1 },
        { from: "Notes/A.md", link: "Missing Note", count: 2 },
      ],
    });
    assert.equal(res.structuredContent.scope, null);
  });

  test("a healthy vault reports zero rather than an error", async () => {
    const res = await linkServer().call();
    assert.deepEqual(res.structuredContent.dangling_links, { note_count: 0, link_count: 0, truncated: false, items: [] });
  });

  test("`scope` narrows the report to a folder, on segment boundaries", async () => {
    const { call } = linkServer({
      unresolved: {
        "Projects/A.md": { Ghost: 1 },
        "Projects Archive/B.md": { Ghost: 1 },
        "Archive/C.md": { Ghost: 1 },
      },
    });
    const res = await call({ scope: "Projects" });
    assert.equal(res.structuredContent.scope, "Projects");
    assert.deepEqual(
      res.structuredContent.dangling_links.items.map((i) => i.from),
      ["Projects/A.md"],
      "'Projects Archive' is a different folder, not a prefix match"
    );
    assert.equal(res.structuredContent.dangling_links.note_count, 1);
  });

  test("a scope that normalizes out of itself is refused, not silently widened to everything", async () => {
    const { call } = linkServer({ unresolved: { "Archive/secret.md": { Ghost: 1 } } });
    for (const scope of ["Projects/../Archive/..", "..", "./"]) {
      const res = await call({ scope });
      assert.equal(res.isError, true, `scope '${scope}' should refuse`);
      assert.match(res.content[0].text, /does not name a folder/);
      assert.equal(JSON.stringify(res).includes("secret"), false, "a refusal reports nothing");
    }
  });

  test("it never names a path outside the allowlist", async () => {
    const { call } = linkServer({
      unresolved: {
        "Projects/A.md": { Ghost: 1 },
        "Archive/Payroll/Salaries 2026.md": { "Bonus Pool": 3 },
      },
      uids: { "Archive/Payroll/a.md": "dup", "Archive/Payroll/b.md": "dup" },
      allowlist: ["Projects"],
    });
    const res = await call();
    const text = JSON.stringify(res);
    assert.equal(text.includes("Payroll"), false, "an out-of-allowlist path leaked into the report");
    assert.equal(text.includes("Bonus Pool"), false, "…as did the link text inside it");
    assert.deepEqual(res.structuredContent.dangling_links, {
      note_count: 1,
      link_count: 1,
      truncated: false,
      items: [{ from: "Projects/A.md", link: "Ghost", count: 1 }],
    });
    assert.deepEqual(res.structuredContent.duplicate_uids.items, []);
    assert.equal(res.structuredContent.duplicate_uids.count, 0);
  });

  test("uid duplicates are reported from already-computed index data, scoped and visible-filtered", async () => {
    const { call } = linkServer({
      uids: { "Projects/A.md": "dup", "Projects/B.md": "dup", "Archive/C.md": "other", "Archive/D.md": "other" },
    });

    const all = await call();
    assert.equal(all.structuredContent.duplicate_uids.available, true);
    assert.deepEqual(all.structuredContent.duplicate_uids.items, [
      { uid: "dup", paths: ["Projects/A.md", "Projects/B.md"] },
      { uid: "other", paths: ["Archive/C.md", "Archive/D.md"] },
    ]);

    const scoped = await call({ scope: "Projects" });
    assert.deepEqual(scoped.structuredContent.duplicate_uids.items, [
      { uid: "dup", paths: ["Projects/A.md", "Projects/B.md"] },
    ]);
    assert.equal(scoped.structuredContent.duplicate_uids.count, 1);
  });

  test("a duplicate with only ONE carrier in scope is not an ambiguity for this scope", async () => {
    const { call } = linkServer({ uids: { "Projects/A.md": "dup", "Archive/B.md": "dup" } });
    const res = await call({ scope: "Projects" });
    assert.deepEqual(res.structuredContent.duplicate_uids.items, []);
  });

  test("without a uid index the duplicates half says so instead of reporting a confident zero", async () => {
    const res = await linkServer({ kernel: null, unresolved: { "A.md": { Ghost: 1 } } }).call();
    assert.equal(res.structuredContent.duplicate_uids.available, false);
    assert.equal(res.structuredContent.duplicate_uids.count, 0);
    assert.equal(res.structuredContent.dangling_links.link_count, 1, "the dangling half still works");
  });

  test("counts stay exact when the list is capped, and the cap is flagged", async () => {
    const unresolved = {};
    for (let i = 0; i < 150; i++) unresolved[`Notes/n${String(i).padStart(3, "0")}.md`] = { Ghost: 1 };
    const res = await linkServer({ unresolved }).call();
    assert.equal(res.structuredContent.dangling_links.note_count, 150);
    assert.equal(res.structuredContent.dangling_links.link_count, 150);
    assert.equal(res.structuredContent.dangling_links.items.length, 100);
    assert.equal(res.structuredContent.dangling_links.truncated, true);
  });
});

// ── C. D1 — the no-argument totals are allowlist-filtered too ─────────────────

describe("obsidian_resolve_uid — D1: totals are the session's own cardinality", () => {
  function uidServer({ entries, allowlist = [] }) {
    const index = new UidIndex({ paths: () => Object.keys(entries), uidOf: (p) => entries[p] });
    index.rebuild();
    const s = fakeServer();
    registerUidTools(s.server, { kernel: { uids: index }, getSettings: () => ({ readOnly: false, allowlist }) });
    return (args = {}) => s.call("obsidian_resolve_uid", args);
  }

  test("an allowlisted session is told how much IT can see, not how big the vault is", async () => {
    const call = uidServer({
      entries: {
        "Projects/A.md": "a",
        "Projects/B.md": "b",
        "Archive/C.md": "c",
        "Archive/D.md": "d",
        "Archive/E.md": "e",
      },
      allowlist: ["Projects"],
    });
    assert.deepEqual((await call()).structuredContent, {
      indexed_notes: 2,
      indexed_uids: 2,
      duplicate_count: 0,
      duplicates: [],
    });
  });

  test("a duplicated uid counts once in the visible uid total", async () => {
    const call = uidServer({
      entries: { "Projects/A.md": "dup", "Projects/B.md": "dup", "Archive/C.md": "hidden" },
      allowlist: ["Projects"],
    });
    const res = await call();
    assert.equal(res.structuredContent.indexed_notes, 2);
    assert.equal(res.structuredContent.indexed_uids, 1, "two notes, one uid between them");
    assert.deepEqual(res.structuredContent.duplicates, [{ uid: "dup", paths: ["Projects/A.md", "Projects/B.md"] }]);
  });

  test("with no allowlist the totals are the index's own, unchanged", async () => {
    const call = uidServer({ entries: { "A.md": "dup", "B.md": "dup", "C.md": "solo" } });
    assert.deepEqual((await call()).structuredContent, {
      indexed_notes: 3,
      indexed_uids: 2,
      duplicate_count: 1,
      duplicates: [{ uid: "dup", paths: ["A.md", "B.md"] }],
    });
  });
});
