/**
 * bases-module.test.mjs — the Bases module (#243): evaluated Base rows for
 * agents via a hidden-leaf capture. What this proves, headlessly:
 *
 *   1. the PURE core (kernel/bases/*, Obsidian-free): `.base` config
 *      interpretation over parsed YAML (views + a view's columns),
 *      propertyId normalization (the YAML `note["x"]` and live
 *      `note.note["x"]` spellings both resolve to the engine's `note.x`
 *      storage key), row bounding (allowlist filter → boolean-only hidden
 *      marker, cap + truncated), and config validation;
 *   2. the capture lifecycle scaffold: cleanup runs EXACTLY ONCE on success,
 *      failure, and timeout alike (a timed-out capture must never leak its
 *      leaf), the timeout refusal is the TYPED BaseTimeoutError, and a
 *      cleanup throw never masks the outcome;
 *   3. the capture serializer: concurrent queries run strictly one at a
 *      time, FIFO, and a rejection never wedges the chain;
 *   4. the tool layer (tools-bases.ts over a fake BasesSource): the feature
 *      gate (no Bases API ⇒ nothing registers), base_list's
 *      allowlist-filtered enumeration + per-file parse-error reporting,
 *      base_query's typed refusals (not_a_base / out_of_allowlist /
 *      not_found / base_parse_error / view_not_found / base_timeout), view
 *      selection + column normalization handed to the capture, the row
 *      cap/limit clamp, and the allowlist row-drop with its boolean-only
 *      `some_rows_hidden`;
 *   5. module-host conformance: the module mounts DEFAULT-ENABLED through
 *      the registry (read-only, no `mutating` flag — the registerAll gate
 *      passes both tools without exemption), degrades to absent when the
 *      source reports the Bases API missing, and TOOL-INVENTORY.md documents
 *      both names (the crosssession precedent for non-obsidian_* names, set
 *      before that module left for the vault-crosssession satellite).
 *
 * The one un-headless seam is the live adapter (obsidian-bases-source.ts):
 * the detached-leaf construction, the hidden-host isShown trick, and the
 * engine's data push — covered by the live smoke recorded on the PR.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeServer } from "./fake-server.mjs";
import {
  DEFAULT_BASES_CONFIG,
  validateBasesConfig,
  basesConfigOf,
  baseViewsOf,
  selectView,
  normalizePropertyId,
  boundRows,
  captureWithCleanup,
  makeSerializer,
  BaseTimeoutError,
} from "../src/kernel/bases/index.ts";
import { registerBasesTools, emptyBasesSource, queryBaseRows } from "../src/mcp/tools-bases.ts";
import { mountModules, builtinModules } from "../src/mcp/modules-mount.ts";
import { visiblePaths } from "../src/guard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 1. pure core: .base interpretation ──────────────────────────────────────

describe("baseViewsOf / selectView", () => {
  const parsed = {
    filters: { and: ['file.ext == "md"'] },
    views: [
      { type: "table", name: "Queue", order: ["file.name", 'note["acceptance-status"]', "author"] },
      { type: "cards", name: "Gallery" },
    ],
  };

  test("declared views come back with name/type/order (order null when absent)", () => {
    assert.deepEqual(baseViewsOf(parsed), [
      { name: "Queue", type: "table", order: ["file.name", 'note["acceptance-status"]', "author"] },
      { name: "Gallery", type: "cards", order: null },
    ]);
  });

  test("a config with no views key is an EMPTY list, not a shape error", () => {
    assert.deepEqual(baseViewsOf({ filters: {} }), []);
  });

  test("non-mapping documents and non-list views are shape errors (null)", () => {
    assert.equal(baseViewsOf("just text"), null);
    assert.equal(baseViewsOf(null), null);
    assert.equal(baseViewsOf(["a"]), null);
    assert.equal(baseViewsOf({ views: "table" }), null);
  });

  test("non-string order entries are dropped; junk view entries are skipped", () => {
    const v = baseViewsOf({ views: [{ type: "table", name: "V", order: ["file.name", 7, null] }, "junk", null] });
    assert.deepEqual(v, [{ name: "V", type: "table", order: ["file.name"] }]);
  });

  test("selectView: named (exact), default = FIRST declared, missing = null", () => {
    const views = baseViewsOf(parsed);
    assert.equal(selectView(views, "Gallery").type, "cards");
    assert.equal(selectView(views, undefined).name, "Queue");
    assert.equal(selectView(views, "queue"), null); // case-sensitive, like the container
    assert.equal(selectView([], undefined), null);
  });
});

// ── 1b. propertyId normalization (live-verified equivalences) ───────────────

describe("normalizePropertyId", () => {
  for (const [raw, want] of [
    ["file.name", "file.name"],
    ["formula.age_days", "formula.age_days"],
    ['note["acceptance-status"]', "note.acceptance-status"], // YAML order spelling
    ['note.note["acceptance-status"]', "note.acceptance-status"], // live getOrder() spelling
    ["note.author", "note.author"],
    ["author", "note.author"], // YAML bare shorthand
    ["note['single']", "note.single"],
    ["note.x.y", "note.x.y"],
  ]) {
    test(`${raw} → ${want}`, () => assert.equal(normalizePropertyId(raw), want));
  }
});

// ── 1c. row bounding ────────────────────────────────────────────────────────

describe("boundRows", () => {
  const rows = [
    { path: "Projects/a.md", values: { "note.x": "1" } },
    { path: "Archive/b.md", values: { "note.x": "2" } },
    { path: "Projects/c.md", values: { "note.x": "3" } },
  ];

  test("no filter: all rows, exact total, no hidden marker set", () => {
    const b = boundRows(rows, undefined, 10);
    assert.equal(b.rows.length, 3);
    assert.equal(b.total, 3);
    assert.equal(b.truncated, false);
    assert.equal(b.someRowsHidden, false);
  });

  test("allowlist filter drops hidden rows; hidden is a BOOLEAN, never a count", () => {
    const visible = (paths) => paths.filter((p) => p.startsWith("Projects/"));
    const b = boundRows(rows, visible, 10);
    assert.deepEqual(b.rows.map((r) => r.path), ["Projects/a.md", "Projects/c.md"]);
    assert.equal(b.total, 2);
    assert.equal(b.someRowsHidden, true);
    assert.ok(!("hiddenCount" in b), "no hidden-cardinality field may exist");
  });

  test("cap truncates AFTER filtering, with truncated flag and pre-cap total", () => {
    const b = boundRows(rows, undefined, 2);
    assert.equal(b.rows.length, 2);
    assert.equal(b.total, 3);
    assert.equal(b.truncated, true);
  });
});

// ── 1d. config ──────────────────────────────────────────────────────────────

describe("bases config", () => {
  test("defaults", () => {
    assert.deepEqual(basesConfigOf(undefined), DEFAULT_BASES_CONFIG);
    assert.deepEqual(basesConfigOf({}), DEFAULT_BASES_CONFIG);
  });

  test("valid overrides land; invalid fall back to the default", () => {
    assert.equal(basesConfigOf({ queryTimeoutMs: 5000 }).queryTimeoutMs, 5000);
    assert.equal(basesConfigOf({ rowCap: 50 }).rowCap, 50);
    assert.equal(basesConfigOf({ queryTimeoutMs: 10 }).queryTimeoutMs, DEFAULT_BASES_CONFIG.queryTimeoutMs);
    assert.equal(basesConfigOf({ rowCap: 0 }).rowCap, DEFAULT_BASES_CONFIG.rowCap);
  });

  test("validateBasesConfig reports range/type problems, accepts blanks", () => {
    assert.deepEqual(validateBasesConfig({}), []);
    assert.deepEqual(validateBasesConfig({ queryTimeoutMs: 30000, rowCap: 500 }), []);
    assert.equal(validateBasesConfig({ queryTimeoutMs: "fast" }).length, 1);
    assert.equal(validateBasesConfig({ queryTimeoutMs: 999 }).length, 1);
    assert.equal(validateBasesConfig({ rowCap: 2.5 }).length, 1);
    assert.equal(validateBasesConfig({ rowCap: 100_000 }).length, 1);
  });
});

// ── 2. capture lifecycle: timeout + cleanup-always ──────────────────────────

describe("captureWithCleanup", () => {
  test("success: result passes through, cleanup ran once", async () => {
    let cleanups = 0;
    const out = await captureWithCleanup({ start: async () => 42, cleanup: () => cleanups++ }, 1000);
    assert.equal(out, 42);
    assert.equal(cleanups, 1);
  });

  test("failure: rejection propagates, cleanup still ran", async () => {
    let cleanups = 0;
    await assert.rejects(
      captureWithCleanup({ start: async () => { throw new Error("boom"); }, cleanup: () => cleanups++ }, 1000),
      /boom/,
    );
    assert.equal(cleanups, 1);
  });

  test("timeout: TYPED BaseTimeoutError, cleanup ran — the leaf can never leak", async () => {
    let cleanups = 0;
    let fire;
    const timers = { set: (fn) => { fire = fn; return 1; }, clear: () => {} };
    const never = new Promise(() => {});
    const p = captureWithCleanup({ start: () => never, cleanup: () => cleanups++ }, 500, timers);
    fire(); // the fake clock expires the deadline
    await assert.rejects(p, (e) => e instanceof BaseTimeoutError && e.code === "base_timeout");
    assert.equal(cleanups, 1);
  });

  test("a cleanup throw never masks the outcome", async () => {
    const out = await captureWithCleanup(
      { start: async () => "ok", cleanup: () => { throw new Error("cleanup exploded"); } },
      1000,
    );
    assert.equal(out, "ok");
  });

  test("the deadline timer is cleared on settlement (no stray timer)", async () => {
    let cleared = 0;
    const timers = { set: () => "t", clear: (t) => { if (t === "t") cleared++; } };
    await captureWithCleanup({ start: async () => 1, cleanup: () => {} }, 1000, timers);
    assert.equal(cleared, 1);
  });
});

// ── 3. serializer ───────────────────────────────────────────────────────────

describe("makeSerializer", () => {
  test("concurrent tasks run strictly one at a time, FIFO", async () => {
    const run = makeSerializer();
    const events = [];
    let release1;
    const p1 = run(async () => {
      events.push("1-start");
      await new Promise((r) => (release1 = r));
      events.push("1-end");
      return 1;
    });
    const p2 = run(async () => {
      events.push("2-start");
      return 2;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ["1-start"], "task 2 must not start while task 1 holds the capture");
    release1();
    assert.deepEqual([await p1, await p2], [1, 2]);
    assert.deepEqual(events, ["1-start", "1-end", "2-start"]);
  });

  test("a rejection surfaces to its caller and never wedges the chain", async () => {
    const run = makeSerializer();
    await assert.rejects(run(async () => { throw new Error("first fails"); }), /first fails/);
    assert.equal(await run(async () => "still alive"), "still alive");
  });
});

// ── 4. tool layer over a fake source ────────────────────────────────────────

const QUEUE_BASE = {
  filters: { and: ['file.ext == "md"'] },
  views: [
    { type: "table", name: "Queue", order: ["file.name", 'note["acceptance-status"]', "author"] },
    { type: "table", name: "Done" },
  ],
};

/** A fake BasesSource. `bases` maps path → parsed config (or the string
 * "PARSE_ERROR"); `rows` is what capture hands back; `captureImpl` overrides
 * the whole capture for timeout/serialization tests. */
function fakeSource({ bases = {}, rows = [], captureImpl = null, availableFlag = true } = {}) {
  const calls = { captures: [] };
  return {
    calls,
    available: () => availableFlag,
    listBasePaths: () => Object.keys(bases),
    readBaseConfig: async (p) => {
      if (!(p in bases)) return { exists: false };
      if (bases[p] === "PARSE_ERROR") return { exists: true, parseError: "bad yaml" };
      return { exists: true, config: bases[p] };
    },
    capture: async (p, viewName, columns, timeoutMs) => {
      calls.captures.push({ p, viewName, columns, timeoutMs });
      if (captureImpl) return captureImpl(p, viewName, columns, timeoutMs);
      return { columns: columns ?? ["note.x"], rows };
    },
  };
}

function register(source, ctxOverrides = {}) {
  const server = fakeServer();
  registerBasesTools(server, source, { config: {}, ...ctxOverrides });
  return server;
}

describe("feature gate", () => {
  test("no Bases API ⇒ NOTHING registers (absent, not broken)", () => {
    const server = register(fakeSource({ availableFlag: false }));
    assert.equal(server.tools.size, 0);
    const empty = fakeServer();
    registerBasesTools(empty, emptyBasesSource(), { config: {} });
    assert.equal(empty.tools.size, 0);
  });

  test("Bases API present ⇒ exactly the two read-only tools", () => {
    const server = register(fakeSource());
    assert.deepEqual([...server.tools.keys()].sort(), ["base_list", "base_query"]);
    for (const [, t] of server.tools) assert.equal(t.def.annotations.readOnlyHint, true);
  });
});

describe("base_list", () => {
  test("enumerates visible bases with their declared views; parse errors reported per file", async () => {
    const server = register(
      fakeSource({ bases: { "Views/Q.base": QUEUE_BASE, "Views/Broken.base": "PARSE_ERROR", "Views/Odd.base": "scalar" } }),
    );
    const res = await server.tools.get("base_list").handler({});
    assert.equal(res.isError, undefined);
    const byPath = Object.fromEntries(res.structuredContent.bases.map((b) => [b.path, b]));
    assert.deepEqual(byPath["Views/Q.base"].views, [
      { name: "Queue", type: "table", columns: 3 },
      { name: "Done", type: "table", columns: null },
    ]);
    assert.equal(byPath["Views/Broken.base"].error, "parse_error");
    assert.equal(byPath["Views/Broken.base"].views, null);
    assert.equal(byPath["Views/Odd.base"].error, "invalid_shape");
    assert.equal(res.structuredContent.total, 3);
  });

  test("a base outside the allowlist is INVISIBLE — absent, not refused", async () => {
    const server = register(
      fakeSource({ bases: { "Projects/A.base": QUEUE_BASE, "Archive/B.base": QUEUE_BASE } }),
      { visible: (paths) => paths.filter((p) => p.startsWith("Projects/")) },
    );
    const res = await server.tools.get("base_list").handler({});
    assert.deepEqual(res.structuredContent.bases.map((b) => b.path), ["Projects/A.base"]);
  });
});

describe("base_query refusals", () => {
  const src = () => fakeSource({ bases: { "Views/Q.base": QUEUE_BASE, "Views/Broken.base": "PARSE_ERROR" } });

  async function expectCode(server, args, code) {
    const res = await server.tools.get("base_query").handler(args);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, new RegExp(`^Error \\[${code}\\]`), `expected ${code}`);
    return res;
  }

  test("not a .base path", async () => {
    await expectCode(register(src()), { path: "Views/Q.md" }, "not_a_base");
  });

  test("hidden base path refuses out_of_allowlist (belt to the guard)", async () => {
    const server = register(src(), { visible: (paths) => paths.filter((p) => !p.startsWith("Views/")) });
    await expectCode(server, { path: "Views/Q.base" }, "out_of_allowlist");
  });

  test("missing base refuses not_found", async () => {
    await expectCode(register(src()), { path: "Nope.base" }, "not_found");
  });

  test("unparseable base refuses base_parse_error", async () => {
    await expectCode(register(src()), { path: "Views/Broken.base" }, "base_parse_error");
  });

  test("unknown view name refuses view_not_found, naming the declared views", async () => {
    const res = await expectCode(register(src()), { path: "Views/Q.base", view: "Nope" }, "view_not_found");
    assert.match(res.content[0].text, /Queue, Done/);
  });

  test("a base declaring no views refuses view_not_found", async () => {
    const server = register(fakeSource({ bases: { "Empty.base": { filters: {} } } }));
    await expectCode(server, { path: "Empty.base" }, "view_not_found");
  });

  test("a capture timeout refuses TYPED base_timeout (never a hang, never a bare fail)", async () => {
    const source = fakeSource({
      bases: { "Views/Q.base": QUEUE_BASE },
      captureImpl: async () => { throw new BaseTimeoutError(1234); },
    });
    const res = await expectCode(register(source), { path: "Views/Q.base" }, "base_timeout");
    assert.match(res.content[0].text, /1234ms/);
  });
});

describe("base_query success path", () => {
  const ROWS = [
    { path: "Projects/a.md", values: { "file.name": "a", "note.acceptance-status": "proposed", "note.author": "x" } },
    { path: "Archive/b.md", values: { "file.name": "b", "note.acceptance-status": "proposed", "note.author": "y" } },
    { path: "Projects/c.md", values: { "file.name": "c", "note.acceptance-status": null, "note.author": null } },
  ];

  test("columns are the view's declared order, NORMALIZED, handed to the capture; rows shaped {path, properties}", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: ROWS });
    const server = register(source);
    const res = await server.tools.get("base_query").handler({ path: "Views/Q.base" });
    assert.equal(res.isError, undefined);
    const sc = res.structuredContent;
    assert.equal(sc.view, "Queue");
    assert.equal(sc.view_type, "table");
    assert.deepEqual(sc.columns, ["file.name", "note.acceptance-status", "note.author"]);
    assert.deepEqual(source.calls.captures[0].columns, ["file.name", "note.acceptance-status", "note.author"]);
    assert.equal(source.calls.captures[0].viewName, undefined, "default view rides as undefined (the engine's own default)");
    assert.deepEqual(sc.rows[0], { path: "Projects/a.md", properties: ROWS[0].values });
    assert.equal(sc.total, 3);
    assert.equal(sc.truncated, false);
    assert.ok(!("some_rows_hidden" in sc), "no allowlist ⇒ no hidden-rows field at all");
  });

  test("a NAMED view rides into the capture; a view with no order hands columns: null", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: [] });
    const server = register(source);
    const res = await server.tools.get("base_query").handler({ path: "Views/Q.base", view: "Done" });
    assert.equal(res.isError, undefined);
    assert.equal(source.calls.captures[0].viewName, "Done");
    assert.equal(source.calls.captures[0].columns, null);
  });

  test("limit clamps to the module rowCap; truncated + pre-cap total are honest", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: ROWS });
    const server = fakeServer();
    registerBasesTools(server, source, { config: { rowCap: 2 } });
    const res = await server.tools.get("base_query").handler({ path: "Views/Q.base", limit: 99 });
    assert.equal(res.structuredContent.rows.length, 2);
    assert.equal(res.structuredContent.total, 3);
    assert.equal(res.structuredContent.truncated, true);
    const res1 = await server.tools.get("base_query").handler({ path: "Views/Q.base", limit: 1 });
    assert.equal(res1.structuredContent.rows.length, 1);
  });

  test("config queryTimeoutMs reaches the capture", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: [] });
    const server = fakeServer();
    registerBasesTools(server, source, { config: { queryTimeoutMs: 7000 } });
    await server.tools.get("base_query").handler({ path: "Views/Q.base" });
    assert.equal(source.calls.captures[0].timeoutMs, 7000);
  });

  test("under an allowlist, hidden rows DROP and some_rows_hidden is a boolean", async () => {
    const settings = { readOnly: false, allowlist: ["Projects", "Views"] };
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: ROWS });
    const server = fakeServer();
    registerBasesTools(server, source, {
      config: {},
      getSettings: () => settings,
      visible: (paths) => visiblePaths(paths, settings),
    });
    const res = await server.tools.get("base_query").handler({ path: "Views/Q.base" });
    assert.deepEqual(res.structuredContent.rows.map((r) => r.path), ["Projects/a.md", "Projects/c.md"]);
    assert.equal(res.structuredContent.total, 2);
    assert.equal(res.structuredContent.some_rows_hidden, true);
    assert.ok(!("rows_hidden" in res.structuredContent), "never a hidden-row COUNT (cardinality oracle)");
  });

  test("serialization is MODULE-WIDE: captures on two separately-registered servers (two connections) still run one at a time", async () => {
    // The serializer is module-scoped, not per-registration — the hidden leaf
    // is a global resource and buildMcpServer registers a fresh source per
    // connection. This would fail if makeSerializer() ever moved inside
    // registerBasesTools (independent-review finding: the single-server test
    // below cannot catch that regression).
    let releaseFirst;
    let starts = 0;
    const captureImpl = async () => {
      starts++;
      if (starts === 1) await new Promise((r) => (releaseFirst = r));
      return { columns: [], rows: [] };
    };
    const serverA = register(fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, captureImpl }));
    const serverB = register(fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, captureImpl }));
    const q1 = serverA.tools.get("base_query").handler({ path: "Views/Q.base" });
    const q2 = serverB.tools.get("base_query").handler({ path: "Views/Q.base" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(starts, 1, "connection B's capture must wait for connection A's");
    releaseFirst();
    const [r1, r2] = await Promise.all([q1, q2]);
    assert.equal(r1.isError, undefined);
    assert.equal(r2.isError, undefined);
    assert.equal(starts, 2);
  });

  test("belt deadline: a NON-CONFORMING source whose capture never settles cannot wedge the chain — the query refuses base_timeout and the next query still runs", async () => {
    const never = new Promise(() => {});
    let calls = 0;
    const source = fakeSource({
      bases: { "Views/Q.base": QUEUE_BASE },
      captureImpl: () => {
        calls++;
        return calls === 1 ? never : Promise.resolve({ columns: [], rows: [] });
      },
    });
    const server = fakeServer();
    // Tiny timeout so the belt (timeout + grace) fires fast enough for a test.
    registerBasesTools(server, source, { config: { queryTimeoutMs: 1000 } });
    const t0 = Date.now();
    const res = await server.tools.get("base_query").handler({ path: "Views/Q.base" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[base_timeout\]/);
    assert.ok(Date.now() - t0 < 30_000, "the belt must fire at timeout+grace, not hang");
    const res2 = await server.tools.get("base_query").handler({ path: "Views/Q.base" });
    assert.equal(res2.isError, undefined, "the chain must move on past the wedged capture");
  });

  test("two concurrent queries SERIALIZE: the second capture starts only after the first settles", async () => {
    let releaseFirst;
    let starts = 0;
    const source = fakeSource({
      bases: { "Views/Q.base": QUEUE_BASE },
      captureImpl: async () => {
        starts++;
        if (starts === 1) await new Promise((r) => (releaseFirst = r));
        return { columns: [], rows: [] };
      },
    });
    const server = register(source);
    const q1 = server.tools.get("base_query").handler({ path: "Views/Q.base" });
    const q2 = server.tools.get("base_query").handler({ path: "Views/Q.base" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(starts, 1, "the second capture must wait for the first");
    releaseFirst();
    const [r1, r2] = await Promise.all([q1, q2]);
    assert.equal(r1.isError, undefined);
    assert.equal(r2.isError, undefined);
    assert.equal(starts, 2);
  });
});

// ── 5. module-host conformance ──────────────────────────────────────────────

describe("module-host conformance", () => {
  const mountDeps = (settings = {}, basesSource = fakeSource({ bases: { "Q.base": QUEUE_BASE } })) => ({
    getSettings: () => ({ ...settings }),
    schemeNotes: () => [],
    vocabSource: { paths: () => [], frontmatter: () => null, body: async () => null },
    provenanceSource: { noteFrontmatter: () => null, read: async () => null, stat: async () => null, glob: async () => [], writeNote: async () => {} },
    healthSource: {
      resolvedLinks: () => ({}),
      unresolvedLinks: () => ({}),
      tags: () => ({}),
      markdownFiles: () => [],
      allFiles: () => [],
      aliases: () => ({}),
      noteBody: async () => null,
    },
    vaultName: "TestVault",
    fileclassPresent: () => false,
    basesSource,
  });

  test("DEFAULT settings: the bases module is ENABLED and both tools mount, read-only", () => {
    const server = fakeServer();
    const registry = mountModules((n, d, h) => server.registerTool(n, d, h), mountDeps());
    assert.deepEqual(registry.problems, []);
    assert.ok(server.tools.has("base_list"));
    assert.ok(server.tools.has("base_query"));
    assert.equal(server.tools.get("base_list").def.annotations.readOnlyHint, true);
    assert.equal(server.tools.get("base_query").def.annotations.readOnlyHint, true);
    const desc = registry.describe().find((d) => d.id === "bases");
    assert.equal(desc.enabled, true);
  });

  test("settings can DISABLE it (modules.bases.enabled: false)", () => {
    const server = fakeServer();
    mountModules((n, d, h) => server.registerTool(n, d, h), mountDeps({ modules: { bases: { enabled: false } } }));
    assert.ok(!server.tools.has("base_list"));
    assert.ok(!server.tools.has("base_query"));
  });

  test("no Bases API (source unavailable) ⇒ the enabled module contributes nothing, with NO problems", () => {
    const server = fakeServer();
    const registry = mountModules(
      (n, d, h) => server.registerTool(n, d, h),
      mountDeps({}, fakeSource({ availableFlag: false })),
    );
    assert.ok(!server.tools.has("base_list"));
    assert.ok(!server.tools.has("base_query"));
    assert.deepEqual(registry.problems, []);
  });

  test("no basesSource wired (settings-UI stand-in deps) ⇒ absent, no problems", () => {
    const server = fakeServer();
    const deps = mountDeps();
    delete deps.basesSource;
    const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps);
    assert.ok(!server.tools.has("base_list"));
    assert.deepEqual(registry.problems, []);
  });

  test("the module HANDS host.visible through: allowlisted settings filter base_list", async () => {
    const server = fakeServer();
    mountModules(
      (n, d, h) => server.registerTool(n, d, h),
      mountDeps({ allowlist: ["Projects"] }, fakeSource({ bases: { "Projects/A.base": QUEUE_BASE, "Q.base": QUEUE_BASE } })),
    );
    const res = await server.tools.get("base_list").handler({});
    assert.deepEqual(res.structuredContent.bases.map((b) => b.path), ["Projects/A.base"]);
  });

  test("builtinModules declares bases READ-ONLY (no mutating flag), default enabled", () => {
    const mod = builtinModules(mountDeps()).find((m) => m.id === "bases");
    assert.ok(mod, "bases module must be declared");
    assert.equal(mod.posture, "capability");
    assert.equal(mod.enabled, true);
    assert.ok(!mod.mutating, "bases must never declare mutating");
    assert.ok(mod.manifest?.summary.length > 0);
    assert.deepEqual(mod.manifest.directory.tools.map((t) => [t.name, t.readOnly]), [
      ["base_list", true],
      ["base_query", true],
    ]);
  });
});

// ── inventory doc lock (the precedent set by the since-extracted crosssession
// module, for tool families whose names are not obsidian_*) ─────────────────

describe("TOOL-INVENTORY documents the bases surface", () => {
  test("both tool names appear in TOOL-INVENTORY.md", () => {
    const doc = readFileSync(path.join(HERE, "..", "TOOL-INVENTORY.md"), "utf8");
    assert.ok(doc.includes("`base_list`"), "TOOL-INVENTORY.md must document base_list");
    assert.ok(doc.includes("`base_query`"), "TOOL-INVENTORY.md must document base_query");
  });
});

// ── the shared evaluated-rows seam, tested directly ─────────────────────────
//
// `queryBaseRows` is the whole base_query evaluation path factored out. It was
// factored out for the triage module's base-backed queues, and these tests came
// back HERE when triage left for its own plugin at S5 — the seam is host code
// and its coverage belongs with the module that owns it. The satellite does not
// consume it (see the seam's own note in tools-bases.ts for why a copy would
// have raced this file's module-scoped capture serializer), so what these pin
// is base_query's shell contract: the callable-level feature gate, the typed
// refusals, and the allowlist row bound.

describe("queryBaseRows: the shared seam itself (fake BasesSource)", () => {
  const baseSource = (over = {}) => ({
    available: () => true,
    listBasePaths: () => ["V/A.base"],
    readBaseConfig: async () => ({
      exists: true,
      config: { views: [{ name: "q", type: "table", order: ["note.status"] }] },
    }),
    capture: async () => ({
      columns: ["note.status"],
      rows: [
        { path: "A/x.md", values: { "note.status": "open" } },
        { path: "Secret/z.md", values: { "note.status": "open" } },
      ],
    }),
    ...over,
  });

  test("unavailable source ⇒ typed bases_unavailable (the callable-level feature gate)", async () => {
    const out = await queryBaseRows(baseSource({ available: () => false }), { config: {} }, { path: "V/A.base" });
    assert.equal(out.refusal.code, "bases_unavailable");
  });

  test("rows are allowlist-filtered (identical to base_query's discipline)", async () => {
    const out = await queryBaseRows(
      baseSource(),
      { config: {}, visible: (paths) => paths.filter((p) => !p.startsWith("Secret/")) },
      { path: "V/A.base", view: "q" },
    );
    assert.deepEqual(out.result.rows.map((r) => r.path), ["A/x.md"]);
    assert.equal(out.result.someRowsHidden, true);
  });

  test("a hidden base refuses out_of_allowlist; a non-.base refuses not_a_base", async () => {
    const hidden = await queryBaseRows(
      baseSource(),
      { config: {}, visible: () => [] },
      { path: "V/A.base" },
    );
    assert.equal(hidden.refusal.code, "out_of_allowlist");
    const notBase = await queryBaseRows(baseSource(), { config: {} }, { path: "note.md" });
    assert.equal(notBase.refusal.code, "not_a_base");
  });

  test("view selection + refusal, and the limit cap", async () => {
    const missing = await queryBaseRows(baseSource(), { config: {} }, { path: "V/A.base", view: "nope" });
    assert.equal(missing.refusal.code, "view_not_found");
    const capped = await queryBaseRows(baseSource(), { config: {} }, { path: "V/A.base", limit: 1 });
    assert.equal(capped.result.rows.length, 1);
    assert.equal(capped.result.truncated, true);
  });
});
