/**
 * accept-guard-control-char.test.mjs — the #155 live-exercise CRITICAL finding.
 *
 * THREE write paths use three frontmatter recognizers, and they must decide
 * identically. The fs path (`parseGuardFrontmatter`) and the CLI/template path
 * (`scanForAcceptFence`) both FAIL CLOSED on a lone carriage return (0x0d with
 * no following 0x0a) inside a frontmatter scalar, because the byte sequence has
 * already diverged from what the vault will honor. The plugin's Obsidian write
 * path did NOT: `ObsidianBackend.guardWrittenContent` decided over
 * `frontmatterOf(content, obsidian.parseYaml)`, and that parser reads
 * `title: X\racceptance-status: accepted` as ONE scalar (no acceptance key)
 * while Obsidian's own metadataCache honorer splits the identical bytes into
 * TWO keys, one of them an acceptance assertion. The guard saw no acceptance,
 * let the write through, and the vault honored the accepted value. A live,
 * exploitable accept-guard bypass.
 *
 * ── WHY THE OLD TEST MISSED IT ──────────────────────────────────────────────
 *
 * accept-fence-parity.test.mjs pinned the lone-CR property only against a MOCK
 * `parseYaml` and the folded/CLI recognizers — it NEVER drove the actual
 * Obsidian-write-path recognizer that shipped. A unit test whose oracle is the
 * mock cannot catch a divergence between the mock and reality; that is the exact
 * gap this file closes. So this file drives the REAL guard path — the fs-tool
 * `obsidian_write_note` over the REAL `ObsidianBackend` — and does NOT depend on
 * any mock parser for the guard decision: after the fix the backend recognizer
 * is `parseGuardFrontmatter`, which is parser-independent (it splits on `\r?\n`
 * and fails closed on any raw control character).
 *
 * The backend imports live Obsidian classes, so the specifier is stubbed before
 * it is imported (the same mechanism accept-forbidden.test.mjs uses).
 *
 * NON-VACUITY: reverting the fix — pointing the backend's `fmOf` back at
 * `frontmatterOf(markdown, parseYaml)` — makes the lone-CR / control-char cases
 * below flip to ALLOWED and this file FAILS, which is the whole point (a unit
 * test alone missed it once; see the run-back note in the PR).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile, parseYaml } from "./obsidian-stub.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerFsTools } = await import("@vault-mcp/core");

// ── a minimal in-memory vault the backend can drive (mirrors accept-forbidden) ──

/** Extract + parse a note's leading frontmatter fence for the fake metadataCache only. */
function fmOf(content) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content ?? "");
  return m ? parseYaml(m[1]) : null;
}

function fakeApp({ files = {} } = {}) {
  const store = new Map(Object.entries(files));
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p) : null),
      read: async (f) => store.get(f.path) ?? "",
      cachedRead: async (f) => store.get(f.path) ?? "",
      create: async (p, c) => { store.set(p, c); },
      modify: async (f, c) => { store.set(f.path, c); },
      append: async (f, c) => { store.set(f.path, (store.get(f.path) ?? "") + c); },
      createFolder: async () => {},
    },
    metadataCache: {
      getFileCache: (f) => {
        const fm = fmOf(store.get(f.path) ?? "");
        return fm ? { frontmatter: fm } : {};
      },
    },
    fileManager: {},
  };
  return { app, store };
}

function harness(appOpts) {
  const { app, store } = fakeApp(appOpts);
  const tools = new Map();
  const server = { registerTool: (name, def, handler) => tools.set(name, { def, handler }) };
  registerFsTools(server, new ObsidianBackend(app), { decodeHtml: false });
  const call = (name, args) => tools.get(name).handler(args, {});
  return { call, store };
}

function assertRejected(res) {
  assert.equal(res.isError, true, "the write must be refused");
  assert.match(res.content[0].text, /\[accept_forbidden\]/, "the refusal carries the accept_forbidden code");
}

const CR = "\r"; // lone carriage return, no following \n — #155's finding
const BOM = "﻿";

// ── A. the exact finding: a lone CR splits into an acceptance key for the vault
//        while a scalar-blind parser sees none. The guard must FAIL CLOSED. ─────

describe("obsidian_write_note — lone-CR acceptance smuggling is refused (#155)", () => {
  const CR_PAYLOADS = [
    {
      name: "CR between two keys (honorer splits, parseYaml folds)",
      content: `---\ntitle: X${CR}acceptance-status: accepted\n---\nbody`,
    },
    {
      name: "CR right after the acceptance key's colon",
      content: `---\nacceptance-status:${CR}accepted\n---\nbody`,
    },
    {
      name: "CR smuggling an accepted-by provenance key",
      content: `---\nname: N${CR}accepted-by: ghost\n---\nbody`,
    },
    {
      name: "leading CR before the acceptance key",
      content: `---\n${CR}acceptance-status: accepted\n---\nbody`,
    },
  ];

  for (const { name, content } of CR_PAYLOADS) {
    test(`refused — ${name}`, async () => {
      const { call, store } = harness();
      const res = await call("obsidian_write_note", { path: "New/CR.md", content, overwrite: true });
      assertRejected(res);
      assert.equal(store.has("New/CR.md"), false, "a refused write must never land on disk");
    });
  }
});

// ── B. other raw control characters the honorer could split on but the
//        scalar-blind parser does not — fail closed, matching the fs path. ──────

describe("obsidian_write_note — other control-char splits are refused too", () => {
  const CTRL_PAYLOADS = [
    { name: "vertical tab (0x0b)", ch: "\x0b" },
    { name: "form feed (0x0c)", ch: "\x0c" },
    { name: "file separator (0x1c)", ch: "\x1c" },
    { name: "unit separator (0x1f)", ch: "\x1f" },
    { name: "NUL (0x00)", ch: "\x00" },
  ];

  for (const { name, ch } of CTRL_PAYLOADS) {
    test(`refused — ${name}`, async () => {
      const { call, store } = harness();
      const content = `---\ntitle: X${ch}acceptance-status: accepted\n---\nbody`;
      const res = await call("obsidian_write_note", { path: "New/Ctrl.md", content, overwrite: true });
      assertRejected(res);
      assert.equal(store.has("New/Ctrl.md"), false);
    });
  }
});

// ── C. the pre-existing cases must STILL be refused (no regression). ────────────

describe("obsidian_write_note — the already-covered accepted shapes stay refused", () => {
  const STILL_REFUSED = [
    { name: "plain acceptance-status: accepted", content: "---\nacceptance-status: accepted\n---\nbody" },
    { name: "leading BOM + accepted", content: `${BOM}---\nacceptance-status: accepted\n---\nbody` },
    { name: "quoted acceptance-provenance key", content: '---\n"accepted-by": nelson\n---\nbody' },
    { name: "document-root flow map", content: "---\n{acceptance-status: accepted}\n---\nbody" },
  ];

  for (const { name, content } of STILL_REFUSED) {
    test(`refused — ${name}`, async () => {
      const { call, store } = harness();
      const res = await call("obsidian_write_note", { path: "New/Prior.md", content, overwrite: true });
      assertRejected(res);
      assert.equal(store.has("New/Prior.md"), false);
    });
  }
});

// ── D. control: a clean `proposed` write is UNAFFECTED and still succeeds. ──────

describe("obsidian_write_note — a clean proposed write is unaffected", () => {
  test("a plain proposed write succeeds and lands", async () => {
    const { call, store } = harness();
    const content = "---\nname: F\nacceptance-status: proposed\n---\nhi";
    const res = await call("obsidian_write_note", { path: "Ok/F.md", content, overwrite: true });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.equal(store.get("Ok/F.md"), content, "the clean write lands verbatim");
  });

  test("an ordinary frontmatter-less write succeeds", async () => {
    const { call, store } = harness();
    const res = await call("obsidian_write_note", { path: "Ok/G.md", content: "just a body", overwrite: true });
    assert.notEqual(res.isError, true);
    assert.equal(store.get("Ok/G.md"), "just a body");
  });
});
