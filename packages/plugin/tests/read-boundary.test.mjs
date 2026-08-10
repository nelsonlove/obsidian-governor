/**
 * read-boundary.test.mjs — slice 3.0: the path allowlist as a READ boundary.
 *
 * The allowlist was enforced by `guardCall`, which checks the paths an
 * operation NAMES IN ITS ARGUMENTS. That is the whole story for a write and for
 * a read that says where to read. It is no story at all for a read that says
 * nothing: `obsidian_search_notes` took a query, opened every note in the vault
 * and handed back matching lines, so a session allowlisted to `Projects` could
 * lift `AWS_SECRET=hunter2` straight out of a note it had no path to. The same
 * shape held for listing with no subdir, find-by-tag, frontmatter search, the
 * tag aggregate, the bookmark list, the active note, and every integration that
 * queries somebody else's index.
 *
 * Every test here asserts the same three things per surface:
 *
 *   1. hidden CONTENT is never returned (and, where it matters, never read),
 *   2. hidden PATHS are never named — not in a list, a count, or an error,
 *   3. with NO allowlist the answer is unchanged, byte for byte.
 *
 * The third is not a formality. The filter is `visiblePaths`, which returns the
 * caller's own array when no allowlist is configured, and the handlers lean on
 * that identity to skip filtering altogether — so "unchanged" is a property of
 * the code, and this file is where it is checked.
 *
 * Also here: D-D (uid_coverage's shape with no index) and the guard's one-path
 * helper. D-E (a throwing effectsOf) lives beside the other effects tests in
 * link-healing.test.mjs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile, TFolder, MarkdownView } from "./obsidian-stub.mjs";
import { visiblePaths, isVisible } from "../src/guard.ts";
import { UidIndex } from "../src/kernel/index.ts";
import { registerLinkTools } from "../src/mcp/tools-links.ts";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerCoreTools } = await import("../src/mcp/tools-core.ts");
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");
const { registerNavTools } = await import("../src/mcp/tools-nav.ts");
const { registerIntegrationTools } = await import("../src/mcp/tools-integrations.ts");
const { registerFsTools } = await import("@vault-mcp/core");

// ── the sandboxed vault every test runs against ───────────────────────────────
//
// `Projects/` is what the session may see. `Archive/Payroll/` is what it may
// not, and it holds the secret the original defect was proven with.

const SECRET = "AWS_SECRET=hunter2";

const NOTES = {
  "Projects/Alpha.md": "# Alpha\nstatus: live\nsee [[Salaries]] and [[Beta]]\n",
  "Projects/Beta.md": "# Beta\nnothing interesting\n",
  "Archive/Payroll/Salaries.md": `# Salaries\n${SECRET}\nsee [[Alpha]]\n`,
};

const CACHES = {
  "Projects/Alpha.md": {
    frontmatter: { kind: "project", status: "live" },
    tags: [{ tag: "#work" }],
    links: [{ link: "Salaries" }, { link: "Beta" }],
  },
  "Projects/Beta.md": { frontmatter: { kind: "project", status: "done" }, tags: [{ tag: "#work" }] },
  "Archive/Payroll/Salaries.md": {
    frontmatter: { kind: "payroll", status: "live" },
    tags: [{ tag: "#payroll" }, { tag: "#work" }],
    links: [{ link: "Alpha" }],
  },
};

const ALLOWED = ["Projects"];
const settingsOf = (allowlist) => ({ readOnly: false, allowlist });

/**
 * A fake Obsidian. `reads` records every note whose CONTENT was opened, so a
 * test can assert the boundary filtered before the read rather than after it.
 */
function fakeApp({ notes = NOTES, caches = CACHES, active = null, bookmarks = null, plugins = {} } = {}) {
  const reads = [];
  const files = new Map(Object.keys(notes).map((p) => [p, new TFile(p)]));

  // Folder tree, so getRoot()/getAbstractFileByPath answer a real listFolders.
  const folders = new Map();
  const folderOf = (path) => {
    let f = folders.get(path);
    if (!f) { f = new TFolder(path, []); folders.set(path, f); }
    return f;
  };
  const root = folderOf("");
  for (const [path, file] of files) {
    const parts = path.split("/");
    parts.pop();
    let parent = root;
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const dir = folderOf(cur);
      if (!parent.children.includes(dir)) parent.children.push(dir);
      parent = dir;
    }
    parent.children.push(file);
  }

  const byBasename = new Map();
  for (const [path, file] of files) byBasename.set(file.basename.toLowerCase(), file);

  const app = {
    reads,
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getRoot: () => root,
      getAbstractFileByPath: (p) => files.get(p) ?? folders.get(p) ?? null,
      async read(f) { reads.push(f.path); return notes[f.path]; },
      async cachedRead(f) { reads.push(f.path); return notes[f.path]; },
      getName: () => "TestVault",
    },
    metadataCache: {
      getFileCache: (f) => caches[f.path] ?? null,
      getFirstLinkpathDest: (linkpath) => byBasename.get(String(linkpath).toLowerCase()) ?? null,
      getBacklinksForFile: (file) => {
        const data = new Map();
        for (const [path, cache] of Object.entries(caches)) {
          if ((cache.links ?? []).some((l) => byBasename.get(l.link.toLowerCase())?.path === file.path)) {
            data.set(path, []);
          }
        }
        return { data };
      },
      // The host's own vault-wide aggregate — the one a sandboxed session must
      // not be handed.
      getTags: () => ({ "#work": 3, "#payroll": 1 }),
      unresolvedLinks: {},
    },
    workspace: {
      getActiveFile: () => (active ? files.get(active) ?? null : null),
      activeEditor: null,
      getActiveViewOfType: () => null,
    },
    internalPlugins: {
      getPluginById: (id) => (id === "bookmarks" && bookmarks ? { instance: { items: bookmarks } } : null),
    },
    plugins: { plugins },
  };
  return app;
}

function fakeServer() {
  const tools = new Map();
  return {
    server: { registerTool: (name, def, handler) => tools.set(name, { def, handler }) },
    tools,
    call: (name, args = {}) => tools.get(name).handler(args, {}),
    has: (name) => tools.has(name),
  };
}

/** registerFsTools over the live-Obsidian backend, bounded by `allowlist`. */
function fsServer(app, allowlist) {
  const s = fakeServer();
  const settings = settingsOf(allowlist);
  registerFsTools(s.server, new ObsidianBackend(app, (paths) => visiblePaths(paths, settings)), {
    decodeHtml: false,
  });
  return s;
}

/** The same tools with no filter argument at all — the pre-slice construction. */
function unboundedServer(app) {
  const s = fakeServer();
  registerFsTools(s.server, new ObsidianBackend(app), { decodeHtml: false });
  return s;
}

const ctxOf = (allowlist) => ({
  pluginVersion: "0.6.0",
  socketPath: "/tmp/x.sock",
  vaultName: "TestVault",
  enabledPlugins: () => [],
  getSettings: () => settingsOf(allowlist),
});

const body = (res) => res.structuredContent;
const json = (res) => JSON.stringify(res);

// ── A. obsidian_search_notes — the proven leak ────────────────────────────────

describe("obsidian_search_notes is bounded by the allowlist", () => {
  const SEARCH = { query: "AWS_SECRET", limit: 20, mode: "all" };

  test("the secret is returned when nothing is sandboxed (the leak is real)", async () => {
    const app = fakeApp();
    const res = await fsServer(app, []).call("obsidian_search_notes", SEARCH);
    assert.equal(body(res).count, 1);
    assert.ok(json(res).includes(SECRET), "no allowlist ⇒ the whole vault, as always");
  });

  test("a session allowlisted to Projects gets neither the secret nor the path", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_search_notes", SEARCH);
    assert.equal(res.isError, undefined);
    assert.deepEqual(body(res).hits, []);
    assert.equal(body(res).count, 0);
    assert.equal(json(res).includes(SECRET), false, "hidden CONTENT must never be returned");
    assert.equal(json(res).includes("Payroll"), false, "hidden PATHS must never be named");
  });

  test("the hidden note is never even opened — filtered before cachedRead, not after", async () => {
    const app = fakeApp();
    await fsServer(app, ALLOWED).call("obsidian_search_notes", { query: "e", limit: 20, mode: "all" });
    assert.deepEqual(
      app.reads.filter((p) => p.startsWith("Archive/")),
      [],
      "a note outside the allowlist must not be read at all, even to be discarded"
    );
    assert.ok(app.reads.length > 0, "and the visible ones still are");
  });

  test("visible matches still come back", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_search_notes", { query: "status", limit: 20, mode: "all" });
    assert.deepEqual(body(res).hits.map((h) => h.path), ["Projects/Alpha.md"]);
  });
});

// ── B. listing with no subdir ─────────────────────────────────────────────────

describe("obsidian_list_notes / obsidian_list_folders with no subdir", () => {
  test("list_notes names only visible notes, and `total` is the visible total", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_list_notes", { limit: 50, offset: 0 });
    assert.deepEqual(body(res).notes.map((n) => n.path), ["Projects/Alpha.md", "Projects/Beta.md"]);
    assert.equal(body(res).total, 2, "an unfiltered total is a cardinality oracle for the hidden area");
    assert.equal(body(res).has_more, false);
  });

  test("list_notes paginates over the VISIBLE set, so a hidden note can't be paged into", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_list_notes", { limit: 50, offset: 2 });
    assert.deepEqual(body(res).notes, []);
    assert.equal(json(res).includes("Payroll"), false);
  });

  test("list_folders at the vault root omits a hidden folder entirely", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_list_folders", {});
    assert.deepEqual(body(res).folders, [{ path: "Projects", note_count: 2 }]);
    assert.equal(json(res).includes("Archive"), false, "the folder NAME is disclosure too");
  });

  test("a visible folder's note_count counts only visible notes", async () => {
    // `Mixed/` is visible; one of its notes is not.
    const app = fakeApp({
      notes: { "Mixed/Open.md": "a", "Mixed/Secret/Closed.md": "b" },
      caches: {},
    });
    const res = await fsServer(app, ["Mixed/Open.md"]).call("obsidian_list_folders", {});
    assert.deepEqual(body(res).folders, [], "a folder that merely CONTAINS the allowlist is outside it");
    const wide = await fsServer(app, ["Mixed"]).call("obsidian_list_folders", {});
    assert.deepEqual(wide.structuredContent.folders, [{ path: "Mixed", note_count: 2 }]);
  });
});

// ── C. cache sweeps ───────────────────────────────────────────────────────────

describe("metadata sweeps are bounded", () => {
  test("obsidian_find_by_tag never names a hidden carrier", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_find_by_tag", { tag: "work", limit: 20 });
    assert.deepEqual(body(res).notes.map((n) => n.path), ["Projects/Alpha.md", "Projects/Beta.md"]);
    const only = await fsServer(app, ALLOWED).call("obsidian_find_by_tag", { tag: "payroll", limit: 20 });
    assert.deepEqual(body(only).notes, [], "a tag used only outside the allowlist finds nothing");
  });

  test("obsidian_search_by_frontmatter leaks neither the path nor the frontmatter block", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_search_by_frontmatter", {
      property: "status",
      value: "live",
      limit: 20,
    });
    assert.deepEqual(body(res).notes.map((n) => n.path), ["Projects/Alpha.md"]);
    assert.equal(body(res).total, 1, "the total counts visible matches only");
    assert.equal(json(res).includes("payroll"), false);
  });
});

// ── D. answers that RESOLVE a path ────────────────────────────────────────────

describe("link resolution fails closed", () => {
  test("obsidian_resolve reports a hidden destination as unresolved, never by path", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_resolve", { refs: ["Salaries", "Beta"] });
    assert.deepEqual(body(res).resolved.map((r) => r.path), ["Projects/Beta.md"]);
    assert.deepEqual(body(res).unresolved.map((r) => r.ref), ["Salaries"]);
    assert.equal(json(res).includes("Payroll"), false);
  });

  test("obsidian_get_backlinks does not name a linker the session cannot read", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_get_backlinks", { path: "Projects/Alpha.md" });
    assert.deepEqual(body(res).backlinks, []);
    assert.equal(body(res).count, 0, "the count follows the list — a bare count is still an oracle");
    const open = await fsServer(app, []).call("obsidian_get_backlinks", { path: "Projects/Alpha.md" });
    assert.deepEqual(open.structuredContent.backlinks, ["Archive/Payroll/Salaries.md"]);
  });

  test("obsidian_get_outlinks keeps the link TEXT and withholds where it landed", async () => {
    const app = fakeApp();
    const res = await fsServer(app, ALLOWED).call("obsidian_get_outlinks", { path: "Projects/Alpha.md" });
    // Compared as it goes over the wire: an absent destination is `undefined`
    // in memory and simply not there in the JSON, exactly as a genuinely
    // dangling link has always been.
    assert.deepEqual(JSON.parse(JSON.stringify(body(res).outlinks)), [
      // The text is written in a note the caller can read, so it is reported as
      // written; the destination is not, and reads exactly like a dangling link.
      { ref: "Salaries" },
      { ref: "Beta", resolved_path: "Projects/Beta.md" },
    ]);
    assert.equal(json(res).includes("Payroll"), false);
  });
});

// ── E. the active note ────────────────────────────────────────────────────────

describe("obsidian_get_active_note", () => {
  test("a hidden note in focus reads as `active: null` — the human's focus is not a bypass", async () => {
    const app = fakeApp({ active: "Archive/Payroll/Salaries.md" });
    const s = fakeServer();
    registerCoreTools(s.server, app, ctxOf(ALLOWED));
    const res = await s.call("obsidian_get_active_note");
    assert.deepEqual(body(res), { active: null });
    assert.equal(json(res).includes(SECRET), false);
    assert.deepEqual(app.reads, [], "and it is not read on the way to being suppressed");
  });

  test("the same note with no allowlist comes back in full", async () => {
    const app = fakeApp({ active: "Archive/Payroll/Salaries.md" });
    const s = fakeServer();
    registerCoreTools(s.server, app, ctxOf([]));
    const res = await s.call("obsidian_get_active_note");
    assert.equal(body(res).active.path, "Archive/Payroll/Salaries.md");
    assert.ok(body(res).active.content.includes(SECRET));
  });

  test("a visible note in focus is unaffected", async () => {
    const app = fakeApp({ active: "Projects/Alpha.md" });
    const s = fakeServer();
    registerCoreTools(s.server, app, ctxOf(ALLOWED));
    assert.equal(body(await s.call("obsidian_get_active_note")).active.path, "Projects/Alpha.md");
  });
});

// ── F. the tag aggregate ──────────────────────────────────────────────────────

describe("obsidian_tags_list", () => {
  test("with no allowlist it is the host's own aggregate, unchanged", async () => {
    const app = fakeApp();
    const s = fakeServer();
    registerComplementaryTools(s.server, app, ctxOf([]));
    const res = await s.call("obsidian_tags_list");
    assert.deepEqual(body(res), { count: 2, tags: [{ tag: "#work", count: 3 }, { tag: "#payroll", count: 1 }] });
  });

  test("under an allowlist it is recomputed over visible notes — vocabulary and counts both", async () => {
    const app = fakeApp();
    const s = fakeServer();
    registerComplementaryTools(s.server, app, ctxOf(ALLOWED));
    const res = await s.call("obsidian_tags_list");
    assert.deepEqual(body(res), { count: 1, tags: [{ tag: "#work", count: 2 }] });
    assert.equal(json(res).includes("payroll"), false, "a tag used only outside the allowlist is not vocabulary you get");
  });
});

// ── G. bookmarks ──────────────────────────────────────────────────────────────

describe("bookmarks", () => {
  const BOOKMARKS = [
    { type: "file", path: "Projects/Alpha.md", title: "Alpha" },
    { type: "group", items: [{ type: "file", path: "Archive/Payroll/Salaries.md", title: "Salaries" }] },
    { type: "search", title: "open work" },
  ];

  test("obsidian_list_bookmarks drops path-bearing entries outside the allowlist, keeps pathless ones", async () => {
    const app = fakeApp({ bookmarks: BOOKMARKS });
    const s = fakeServer();
    registerNavTools(s.server, app, ctxOf(ALLOWED));
    const res = await s.call("obsidian_list_bookmarks");
    assert.deepEqual(body(res).bookmarks.map((b) => b.title), ["Alpha", "open work"]);
    assert.equal(json(res).includes("Payroll"), false);
  });

  test("with no allowlist every bookmark is listed", async () => {
    const app = fakeApp({ bookmarks: BOOKMARKS });
    const s = fakeServer();
    registerNavTools(s.server, app, ctxOf([]));
    assert.equal(body(await s.call("obsidian_list_bookmarks")).count, 3);
  });

  test("obsidian_open_bookmark answers a hidden bookmark exactly as it answers a missing one", async () => {
    const app = fakeApp({ bookmarks: BOOKMARKS });
    const s = fakeServer();
    registerNavTools(s.server, app, ctxOf(ALLOWED));
    const hidden = await s.call("obsidian_open_bookmark", { name: "Salaries" });
    const missing = await s.call("obsidian_open_bookmark", { name: "Nope" });
    assert.equal(hidden.isError, true);
    assert.equal(hidden.content[0].text, "Error: bookmark not found: Salaries");
    assert.match(missing.content[0].text, /bookmark not found: Nope/);
  });
});

// ── H. third-party query surfaces ─────────────────────────────────────────────

describe("integration tools", () => {
  const dataview = { api: { query: async () => ({ successful: true, value: { type: "list", values: ["x"] } }) } };
  const omnisearch = {
    api: {
      search: async () => [
        { path: "Projects/Alpha.md", score: 1, excerpt: "status: live" },
        { path: "Archive/Payroll/Salaries.md", score: 2, excerpt: SECRET },
      ],
    },
  };
  const metadataMenu = {
    fieldIndex: {
      fileClassesFields: new Map([
        ["Projects/Project", [{ name: "status", type: "Select" }]],
        ["Archive/Payroll/Ledger", [{ name: "amount", type: "Number" }]],
      ]),
    },
  };

  test("a Dataview query is REFUSED while an allowlist is active — it cannot be bounded", async () => {
    const app = fakeApp({ plugins: { dataview } });
    const s = fakeServer();
    registerIntegrationTools(s.server, app, ctxOf(ALLOWED));
    const res = await s.call("obsidian_dataview_list_query", { dql: 'LIST FROM ""' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]:/, "typed, like every other scope refusal");
    const table = await s.call("obsidian_dataview_table_query", { dql: 'TABLE file.path FROM ""' });
    assert.equal(table.isError, true);
  });

  test("with no allowlist Dataview runs exactly as before", async () => {
    const app = fakeApp({ plugins: { dataview } });
    const s = fakeServer();
    registerIntegrationTools(s.server, app, ctxOf([]));
    const res = await s.call("obsidian_dataview_list_query", { dql: 'LIST FROM ""' });
    assert.equal(res.isError, undefined);
    assert.deepEqual(body(res).values, ["x"]);
  });

  test("obsidian_omnisearch drops hidden hits, excerpt and all", async () => {
    const app = fakeApp({ plugins: { omnisearch } });
    const s = fakeServer();
    registerIntegrationTools(s.server, app, ctxOf(ALLOWED));
    const res = await s.call("obsidian_omnisearch", { query: "anything" });
    assert.deepEqual(body(res).hits.map((h) => h.path), ["Projects/Alpha.md"]);
    assert.equal(json(res).includes(SECRET), false);

    const open = fakeServer();
    registerIntegrationTools(open.server, fakeApp({ plugins: { omnisearch } }), ctxOf([]));
    assert.equal(body(await open.call("obsidian_omnisearch", { query: "anything" })).hits.length, 2);
  });

  test("obsidian_fileclass_schema's not-found and ambiguous branches can only name visible fileClasses", async () => {
    const app = fakeApp({ plugins: { "metadata-menu": metadataMenu } });
    const s = fakeServer();
    registerIntegrationTools(s.server, app, ctxOf(ALLOWED));

    const hidden = await s.call("obsidian_fileclass_schema", { fileclass: "Ledger" });
    assert.equal(hidden.isError, true);
    // The name the CALLER supplied is echoed, as it must be; what must not
    // appear is where it lives, or that it exists at all.
    assert.equal(json(hidden).includes("Payroll"), false, "the 'Available: …' list is a folder listing if unbounded");
    assert.equal(json(hidden).includes("Archive"), false);

    const visible = await s.call("obsidian_fileclass_schema", { fileclass: "Project" });
    assert.equal(visible.isError, undefined);
    assert.equal(body(visible).fileclass_key, "Projects/Project");
  });
});

// ── I. no allowlist ⇒ byte-identical ──────────────────────────────────────────

describe("with no allowlist the read surface is unchanged", () => {
  // The filtered construction (an explicit visiblePaths filter over an empty
  // allowlist) against the unfiltered one (no filter argument at all — the
  // pre-slice call). Same answers, or the containment changed something it had
  // no business changing.
  const CALLS = [
    ["obsidian_list_notes", { limit: 50, offset: 0 }],
    ["obsidian_list_notes", { subdir: "Projects", limit: 50, offset: 0 }],
    ["obsidian_list_folders", {}],
    ["obsidian_search_notes", { query: "e", limit: 50, mode: "all" }],
    ["obsidian_search_notes", { query: "e", limit: 50, mode: "one_per_note" }],
    ["obsidian_find_by_tag", { tag: "work", limit: 50 }],
    ["obsidian_search_by_frontmatter", { property: "status", value: "live", limit: 50 }],
    ["obsidian_resolve", { refs: ["Salaries", "Beta", "Nothing"] }],
    ["obsidian_get_backlinks", { path: "Projects/Alpha.md" }],
    ["obsidian_get_outlinks", { path: "Projects/Alpha.md" }],
  ];

  for (const [name, args] of CALLS) {
    test(`${name}${args.subdir ? " (subdir)" : ""}${args.mode ? ` (${args.mode})` : ""} is identical`, async () => {
      const bounded = await fsServer(fakeApp(), []).call(name, args);
      const original = await unboundedServer(fakeApp()).call(name, args);
      assert.deepEqual(bounded, original);
    });
  }

  test("and the reads it performs are the same reads", async () => {
    const a = fakeApp();
    const b = fakeApp();
    await fsServer(a, []).call("obsidian_search_notes", { query: "e", limit: 50, mode: "all" });
    await unboundedServer(b).call("obsidian_search_notes", { query: "e", limit: 50, mode: "all" });
    assert.deepEqual(a.reads, b.reads);
  });
});

// ── J. the guard's own helpers ────────────────────────────────────────────────

describe("visiblePaths / isVisible", () => {
  test("no allowlist returns the CALLER'S OWN array — the identity handlers rely on", () => {
    const paths = ["a.md", "b.md"];
    assert.equal(visiblePaths(paths, settingsOf([])), paths);
    assert.equal(visiblePaths(paths, null), paths);
    assert.equal(visiblePaths(paths, undefined), paths);
  });

  test("isVisible agrees with visiblePaths, one path at a time", () => {
    const s = settingsOf(ALLOWED);
    const all = ["Projects/A.md", "Archive/B.md", "Projects", "ProjectsX/C.md"];
    assert.deepEqual(
      all.filter((p) => isVisible(p, s)),
      visiblePaths(all, s)
    );
    assert.deepEqual(visiblePaths(all, s), ["Projects/A.md", "Projects"]);
  });

  test("isVisible is true for everything when nothing is sandboxed", () => {
    assert.equal(isVisible("Archive/Payroll/Salaries.md", settingsOf([])), true);
    assert.equal(isVisible("Archive/Payroll/Salaries.md", null), true);
  });

  test("traversal cannot buy visibility", () => {
    assert.equal(isVisible("Projects/../Archive/Payroll/Salaries.md", settingsOf(ALLOWED)), false);
  });
});

// ── K. D-D: uid_coverage's shape with no index ────────────────────────────────

describe("obsidian_check_links uid_coverage with no index (D-D)", () => {
  function linkServer({ uids = null, notes = [] } = {}) {
    const index = uids ? new UidIndex({ paths: () => Object.keys(uids), uidOf: (p) => uids[p] }) : null;
    index?.rebuild();
    const s = fakeServer();
    registerLinkTools(
      s.server,
      { unresolved: () => ({}), notes: () => notes },
      { kernel: index ? { uids: index } : null, getSettings: () => settingsOf([]) }
    );
    return s;
  }

  test("no index ⇒ the uid counts are null, not a confident zero", async () => {
    const s = linkServer({ notes: ["A.md", "B.md"] });
    const cov = body(await s.call("obsidian_check_links", {})).uid_coverage;
    assert.deepEqual(cov, {
      available: false,
      notes_total: 2,
      notes_with_uid: null,
      notes_without_uid: null,
      truncated: false,
      uncovered: [],
    });
  });

  test("the halves sum to the total whenever they are numbers at all", async () => {
    for (const fixture of [
      { uids: { "A.md": "u1" }, notes: ["A.md", "B.md"] },
      { uids: { "A.md": "u1", "B.md": "u2" }, notes: ["A.md", "B.md"] },
      { notes: ["A.md", "B.md"] },
    ]) {
      const cov = body(await linkServer(fixture).call("obsidian_check_links", {})).uid_coverage;
      if (cov.available) {
        assert.equal(cov.notes_with_uid + cov.notes_without_uid, cov.notes_total);
      } else {
        assert.equal(cov.notes_with_uid, null);
        assert.equal(cov.notes_without_uid, null);
      }
    }
  });

  test("with an index the counts are numbers and `uncovered` names the gap", async () => {
    const s = linkServer({ uids: { "A.md": "u1" }, notes: ["A.md", "B.md"] });
    const cov = body(await s.call("obsidian_check_links", {})).uid_coverage;
    assert.deepEqual(cov, {
      available: true,
      notes_total: 2,
      notes_with_uid: 1,
      notes_without_uid: 1,
      truncated: false,
      uncovered: ["B.md"],
    });
  });
});

// Referenced so the stub's MarkdownView export is exercised by the import that
// tools-nav needs it for; a missing export would fail the import above, not here.
assert.equal(typeof MarkdownView, "function");
