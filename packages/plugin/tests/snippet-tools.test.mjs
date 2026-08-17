/**
 * snippet-tools.test.mjs — the CSS snippet tools (tools-snippets.ts).
 *
 * Everything arrives through the injected SnippetSource, so the handlers are
 * fully testable headlessly: list/read/write/toggle happy paths, the name
 * sanitizer (the `.obsidian/snippets/*.css` containment), the allowlist
 * refusal on the mutating pair, and the read-only-mode block through the same
 * guard wrapper production uses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  registerSnippetTools,
  snippetNameRefusal,
  obsidianSnippetSource,
} from "../src/mcp/tools-snippets.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { fakeServer } from "./fake-server.mjs";

function ctxWith(settings) {
  return {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "testvault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], ...settings }),
  };
}

function fakeSource(initial = {}) {
  const files = new Map(Object.entries(initial.files ?? {})); // name -> css
  const enabled = new Set(initial.enabled ?? []);
  const ops = [];
  return {
    ops,
    files,
    enabledSet: enabled,
    folder: () => ".obsidian/snippets",
    list: () => [...files.keys()].map((name) => ({ name, enabled: enabled.has(name) })),
    exists: async (name) => files.has(name),
    read: async (name) => {
      if (!files.has(name)) throw new Error("ENOENT");
      return files.get(name);
    },
    write: async (name, css) => {
      const created = !files.has(name);
      files.set(name, css);
      ops.push(["write", `.obsidian/snippets/${name}.css`]);
      return { path: `.obsidian/snippets/${name}.css`, created };
    },
    setEnabled: (name, on) => {
      ops.push(["setEnabled", name, on]);
      if (on) enabled.add(name);
      else enabled.delete(name);
    },
  };
}

function build(settings = {}, source = fakeSource()) {
  const server = fakeServer();
  registerSnippetTools(server, ctxWith(settings), { source });
  return { server, source };
}

// ── the name sanitizer — the containment that makes the .obsidian exception safe

describe("snippetNameRefusal", () => {
  const REFUSED = [
    "",
    "../evil",
    "..",
    "a/b",
    "a\\b",
    "/abs",
    ".hidden",
    ". lead-dot-space",
    "trail.",
    "trail ",
    "name.css",
    "NAME.CSS",
    "bad*name",
    "semi;colon",
    "back`tick",
    "nul\u0000byte",
    "x".repeat(120),
    // Windows reserved device names — CON.css targets a device on Windows,
    // even with the extension, so the containment claim would crack there.
    "CON",
    "con",
    "con.dark",
    "NUL",
    "com1",
    "LPT9",
  ];
  for (const name of REFUSED) {
    test(`REFUSES ${JSON.stringify(name)}`, () => {
      assert.ok(snippetNameRefusal(name), `should refuse: ${JSON.stringify(name)}`);
    });
  }
  const ALLOWED = ["theme-tweaks", "My Snippet", "v2.1 overrides", "a", "under_score", "dash-name", "a..b"];
  for (const name of ALLOWED) {
    test(`allows ${JSON.stringify(name)}`, () => {
      assert.equal(snippetNameRefusal(name), null);
    });
  }
});

// ── registration + annotations ────────────────────────────────────────────────

describe("registerSnippetTools — surface", () => {
  test("registers the four snippet tools with the right annotations", () => {
    const { server } = build();
    assert.deepEqual(
      [...server.tools.keys()].sort(),
      ["obsidian_snippet_read", "obsidian_snippet_toggle", "obsidian_snippet_write", "obsidian_snippets_list"],
    );
    assert.equal(server.tools.get("obsidian_snippets_list").def.annotations.readOnlyHint, true);
    assert.equal(server.tools.get("obsidian_snippet_read").def.annotations.readOnlyHint, true);
    assert.equal(server.tools.get("obsidian_snippet_write").def.annotations.readOnlyHint, false);
    assert.equal(server.tools.get("obsidian_snippet_toggle").def.annotations.readOnlyHint, false);
  });
});

// ── happy paths ───────────────────────────────────────────────────────────────

describe("snippet tools — happy paths", () => {
  test("list returns names + enabled state + folder", async () => {
    const source = fakeSource({ files: { a: "x", b: "y" }, enabled: ["b"] });
    const { server } = build({}, source);
    const res = await server.tools.get("obsidian_snippets_list").handler({});
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.folder, ".obsidian/snippets");
    assert.deepEqual(res.structuredContent.snippets, [
      { name: "a", enabled: false },
      { name: "b", enabled: true },
    ]);
  });

  test("read returns the CSS text and enabled state", async () => {
    const source = fakeSource({ files: { a: "body { color: red }" }, enabled: ["a"] });
    const { server } = build({}, source);
    const res = await server.tools.get("obsidian_snippet_read").handler({ name: "a" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.css, "body { color: red }");
    assert.equal(res.structuredContent.enabled, true);
  });

  test("read of a missing snippet is a typed snippet_not_found", async () => {
    const { server } = build();
    const res = await server.tools.get("obsidian_snippet_read").handler({ name: "nope" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[snippet_not_found\]/);
  });

  test("write creates the file at exactly .obsidian/snippets/<name>.css", async () => {
    const source = fakeSource();
    const { server } = build({}, source);
    const res = await server.tools.get("obsidian_snippet_write").handler({ name: "tweaks", css: "b{}" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.created, true);
    assert.equal(res.structuredContent.path, ".obsidian/snippets/tweaks.css");
    assert.deepEqual(source.ops, [["write", ".obsidian/snippets/tweaks.css"]]);
  });

  test("write overwrites an existing snippet (created: false)", async () => {
    const source = fakeSource({ files: { tweaks: "old" } });
    const { server } = build({}, source);
    const res = await server.tools.get("obsidian_snippet_write").handler({ name: "tweaks", css: "new" });
    assert.equal(res.structuredContent.created, false);
    assert.equal(source.files.get("tweaks"), "new");
  });

  test("toggle enables and disables through the app API", async () => {
    const source = fakeSource({ files: { a: "x" } });
    const { server } = build({}, source);
    let res = await server.tools.get("obsidian_snippet_toggle").handler({ name: "a", enabled: true });
    assert.notEqual(res.isError, true);
    assert.deepEqual(res.structuredContent, { name: "a", enabled: true });
    res = await server.tools.get("obsidian_snippet_toggle").handler({ name: "a", enabled: false });
    assert.deepEqual(res.structuredContent, { name: "a", enabled: false });
    assert.deepEqual(source.ops, [["setEnabled", "a", true], ["setEnabled", "a", false]]);
  });

  test("toggle of an unknown snippet is snippet_not_found and calls nothing", async () => {
    const source = fakeSource();
    const { server } = build({}, source);
    const res = await server.tools.get("obsidian_snippet_toggle").handler({ name: "nope", enabled: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /snippet_not_found/);
    assert.equal(source.ops.length, 0);
  });
});

// ── containment: path-escape attempts refuse before the source is touched ─────

describe("snippet tools — path-escape attempts refuse", () => {
  for (const tool of ["obsidian_snippet_read", "obsidian_snippet_write", "obsidian_snippet_toggle"]) {
    for (const name of ["../../data", "..", "a/b", ".hidden", "x.css"]) {
      test(`${tool} refuses ${JSON.stringify(name)}`, async () => {
        const source = fakeSource({ files: { a: "x" } });
        const { server } = build({}, source);
        const args = tool === "obsidian_snippet_write" ? { name, css: "b{}" } : { name, enabled: true };
        const res = await server.tools.get(tool).handler(args);
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /Error \[invalid_snippet_name\]/);
        assert.equal(source.ops.length, 0, "the source must never be touched");
      });
    }
  }
});

// ── allowlist + read-only mode ────────────────────────────────────────────────

describe("snippet tools — allowlist and read-only mode", () => {
  const ACTOR = { transport: "mcp", client: "test/1.0", connection: "c1" };

  test("write and toggle refuse while a path allowlist is active", async () => {
    const source = fakeSource({ files: { a: "x" } });
    const { server } = build({ allowlist: ["Projects"] }, source);
    const w = await server.tools.get("obsidian_snippet_write").handler({ name: "a", css: "b{}" });
    assert.equal(w.isError, true);
    assert.match(w.content[0].text, /allowlist/);
    const t = await server.tools.get("obsidian_snippet_toggle").handler({ name: "a", enabled: true });
    assert.equal(t.isError, true);
    assert.match(t.content[0].text, /allowlist/);
    assert.equal(source.ops.length, 0);
  });

  test("list and read stay available under an allowlist (config CSS, not note content)", async () => {
    const source = fakeSource({ files: { a: "x" } });
    const { server } = build({ allowlist: ["Projects"] }, source);
    const l = await server.tools.get("obsidian_snippets_list").handler({});
    assert.notEqual(l.isError, true);
    const r = await server.tools.get("obsidian_snippet_read").handler({ name: "a" });
    assert.notEqual(r.isError, true);
  });

  test("read-only mode blocks write/toggle through the guard (readOnlyHint: false)", async () => {
    const settings = { readOnly: true, allowlist: [] };
    const source = fakeSource({ files: { a: "x" } });
    const { server } = build(settings, source);
    const guarded = makeGuarded({ getSettings: () => settings, actor: () => ACTOR });
    for (const [tool, args] of [
      ["obsidian_snippet_write", { name: "a", css: "b{}" }],
      ["obsidian_snippet_toggle", { name: "a", enabled: true }],
    ]) {
      const { def, handler } = server.tools.get(tool);
      const res = await guarded(def, handler, tool)(args, {});
      assert.equal(res.isError, true, `${tool} should be blocked`);
      assert.match(res.content[0].text, /Error \[read_only\]/);
    }
    assert.equal(source.ops.length, 0);
  });
});

// ── the live adapter (obsidianSnippetSource) over a fake app ──────────────────

describe("obsidianSnippetSource", () => {
  function fakeApp() {
    const disk = new Map(); // path -> content
    const writes = [];
    const app = {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: async (p) => disk.has(p) || p === ".obsidian/snippets",
          read: async (p) => disk.get(p),
          write: async (p, data) => {
            disk.set(p, data);
            writes.push(p);
          },
          mkdir: async () => {},
        },
      },
      customCss: {
        snippets: ["a"],
        enabledSnippets: new Set(["a"]),
        toggles: [],
        reads: 0,
        setCssEnabledStatus(name, on) {
          this.toggles.push([name, on]);
        },
        readSnippets() {
          this.reads += 1;
        },
        getSnippetsFolder: () => ".obsidian/snippets",
        requestLoadSnippets() {},
      },
    };
    return { app, disk, writes };
  }

  test("list reflects customCss.snippets + enabledSnippets", () => {
    const { app } = fakeApp();
    const source = obsidianSnippetSource(app);
    assert.deepEqual(source.list(), [{ name: "a", enabled: true }]);
  });

  test("write lands at <folder>/<name>.css and asks Obsidian to re-read snippets", async () => {
    const { app, writes } = fakeApp();
    const source = obsidianSnippetSource(app);
    const out = await source.write("tweaks", "b{}");
    assert.deepEqual(out, { path: ".obsidian/snippets/tweaks.css", created: true });
    assert.deepEqual(writes, [".obsidian/snippets/tweaks.css"]);
    assert.equal(app.customCss.reads, 1);
  });

  test("setEnabled goes through setCssEnabledStatus", () => {
    const { app } = fakeApp();
    const source = obsidianSnippetSource(app);
    source.setEnabled("a", false);
    assert.deepEqual(app.customCss.toggles, [["a", false]]);
  });

  test("falls back to configDir/snippets when getSnippetsFolder is absent", () => {
    const { app } = fakeApp();
    delete app.customCss.getSnippetsFolder;
    const source = obsidianSnippetSource(app);
    assert.equal(source.folder(), ".obsidian/snippets");
  });

  test("setEnabled throws a clear error when the app API is absent", () => {
    const { app } = fakeApp();
    delete app.customCss.setCssEnabledStatus;
    const source = obsidianSnippetSource(app);
    assert.throws(() => source.setEnabled("a", true), /no snippet toggle API/);
  });
});
