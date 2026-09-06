/**
 * bases-module.test.mjs — the vault-bases satellite (#243): evaluated Base rows
 * for agents via a hidden-leaf capture. What this proves, headlessly:
 *
 *   1. the PURE core (src/kernel, Obsidian-free): `.base` config interpretation
 *      over parsed YAML (views + a view's columns), propertyId normalization
 *      (the YAML `note["x"]` and live `note.note["x"]` spellings both resolve
 *      to the engine's `note.x` storage key), row bounding (allowlist filter →
 *      boolean-only hidden marker, cap + truncated), and config validation;
 *   2. the capture lifecycle scaffold: cleanup runs EXACTLY ONCE on success,
 *      failure, and timeout alike (a timed-out capture must never leak its
 *      leaf), the timeout refusal is the TYPED BaseTimeoutError, and a cleanup
 *      throw never masks the outcome;
 *   3. the capture serializer: concurrent queries run strictly one at a time,
 *      FIFO, a rejection never wedges the chain, and the serializer is
 *      MODULE-scoped rather than per-build — the pin that would fail if
 *      `makeSerializer()` ever moved inside `buildBasesTools`;
 *   4. the tool layer (src/tools.ts over a fake BasesSource, published through
 *      tests/host-shim.mjs so every assertion reads the ENVELOPE an agent
 *      actually sees): the feature gate (no Bases API ⇒ nothing published),
 *      `list`'s enumeration + per-file parse-error reporting, `query`'s typed
 *      refusals (invalid_path / not_a_base / out_of_allowlist / not_found /
 *      base_parse_error / view_not_found / base_timeout), view selection +
 *      column normalization handed to the capture, the row cap/limit clamp, and
 *      the (now dormant) allowlist row-drop with its boolean-only
 *      `some_rows_hidden`;
 *   5. THE PUBLICATION CONTRACT, which replaces the module-host conformance
 *      block the host suite had: the wire names `vault_bases_list` /
 *      `vault_bases_query`, the untrusted read-only claim, the ASYMMETRY that
 *      `list` carries no host path key while `query`'s `path` IS one, the
 *      schema bounds re-applied in the handler, and the coded-error rendering;
 *   6. the one-shot config adoption from the host's `modules.bases.config`.
 *
 * NOT covered here on purpose:
 *   • the host's kernel, journal, write queue, read-only mode and path
 *     allowlist. Those are HOST code with host tests; a second copy could drift
 *     into asserting a posture the host does not enforce. What this package
 *     owns — which of its argument names the host's guard can read — is pinned
 *     in the publication block instead.
 *   • the live adapter (src/obsidian-source.ts): the detached-leaf
 *     construction, the hidden-host isShown trick, and the engine's data push
 *     — covered by the live smoke recorded on the PR.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isVisible } from "@vault-mcp/core";
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
} from "../src/kernel/index.ts";
import { buildBasesTools, emptyBasesSource, queryBaseRows } from "../src/tools.ts";
import {
  adoptHostConfig,
  settingsOf,
  ADOPTABLE_KEYS,
  BASES_FIELDS,
  DEFAULT_PLUGIN_SETTINGS,
} from "../src/settings.ts";
import { publishInto, OWNER, HOST_PATH_KEYS } from "./host-shim.mjs";

/** The host's `visiblePaths`, reproduced over core's published `isVisible` —
 *  the one-path predicate both sides share. It feeds the DORMANT `visible`
 *  seam so the seam's behaviour cannot rot; nothing supplies it in the shipped
 *  plugin (see tools.ts). Never re-implement `isVisible`. */
const visiblePaths = (paths, settings) =>
  !settings?.allowlist?.length ? paths : paths.filter((p) => isVisible(p, settings));

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
    // NOTE: this branch is DORMANT in the shipped satellite — nothing supplies
    // `visible`. It is kept, and tested, because apiVersion 2 re-lights it.
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

/**
 * Build the specs and publish them through the host shim, so every assertion
 * reads the ENVELOPE an agent actually sees (`ok()` / `fail()`'s
 * `Error [code]: message`) rather than a raw return value.
 *
 * `call` takes the BARE name and prefixes it, so the test bodies stay readable
 * while the wire name is still what is exercised; `publication` below pins the
 * prefix itself.
 */
function build(source, ctxOverrides = {}) {
  const { tools } = publishInto(buildBasesTools(source, { config: () => ({}), ...ctxOverrides }));
  const call = (bare, args = {}) => tools.get(`${OWNER}_${bare}`).handler(args);
  return { tools, call, source };
}

const errText = (res) => res.content[0].text;

describe("feature gate", () => {
  test("no Bases API ⇒ NOTHING is published (absent, not broken)", () => {
    assert.deepEqual(buildBasesTools(fakeSource({ availableFlag: false }), { config: () => ({}) }), []);
    assert.deepEqual(buildBasesTools(emptyBasesSource(), { config: () => ({}) }), []);
  });

  test("Bases API present ⇒ exactly the two tools, both CLAIMING read-only", () => {
    const specs = buildBasesTools(fakeSource(), { config: () => ({}) });
    assert.deepEqual(specs.map((s) => s.name), ["list", "query"]);
    for (const s of specs) assert.equal(s.readOnly, true);
  });
});

describe("vault_bases_list", () => {
  test("enumerates bases with their declared views; parse errors reported per file", async () => {
    const { call } = build(
      fakeSource({ bases: { "Views/Q.base": QUEUE_BASE, "Views/Broken.base": "PARSE_ERROR", "Views/Odd.base": "scalar" } }),
    );
    const res = await call("list");
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

  test("with the DORMANT visible seam supplied, a hidden base is absent rather than refused", async () => {
    // Nothing supplies `visible` in the shipped plugin — under a real allowlist
    // the host blocks this tool outright instead, because it carries no
    // arguments to scope by (pinned in the publication block). The seam is
    // exercised here so it cannot rot before apiVersion 2 re-lights it.
    const { call } = build(
      fakeSource({ bases: { "Projects/A.base": QUEUE_BASE, "Archive/B.base": QUEUE_BASE } }),
      { visible: (paths) => paths.filter((p) => p.startsWith("Projects/")) },
    );
    const res = await call("list");
    assert.deepEqual(res.structuredContent.bases.map((b) => b.path), ["Projects/A.base"]);
  });
});

describe("vault_bases_query refusals", () => {
  const src = () => fakeSource({ bases: { "Views/Q.base": QUEUE_BASE, "Views/Broken.base": "PARSE_ERROR" } });

  async function expectCode(call, args, code) {
    const res = await call("query", args);
    assert.equal(res.isError, true);
    assert.match(errText(res), new RegExp(`^Error \\[${code}\\]`), `expected ${code}, got: ${errText(res)}`);
    return res;
  }

  test("A BACKSLASH IN `path` IS REFUSED OUTRIGHT, before every other path check", async () => {
    // 2026-09-05 satellite-review rule, the same one triage applied at
    // plan.ts's `targetProblem`: every downstream check — the `.base` suffix
    // test, `pathVisible`, and the host guard's own `isVisible` — splits on "/"
    // alone, so a backslash segment reads as one opaque name here and as a
    // traversal to whatever normalizes it later. Obsidian paths never contain
    // one.
    const { call } = build(src());
    await expectCode(call, { path: "Views\\..\\..\\secret.base" }, "invalid_path");
    // It precedes not_a_base: a backslash path that is not even a .base still
    // answers invalid_path, so the class is closed rather than the instance.
    await expectCode(call, { path: "Views\\Q.md" }, "invalid_path");
  });

  test("not a .base path", async () => {
    await expectCode(build(src()).call, { path: "Views/Q.md" }, "not_a_base");
  });

  test("hidden base refuses out_of_allowlist (the dormant belt; the host's guard is what enforces)", async () => {
    const { call } = build(src(), { visible: (paths) => paths.filter((p) => !p.startsWith("Views/")) });
    await expectCode(call, { path: "Views/Q.base" }, "out_of_allowlist");
  });

  test("missing base refuses not_found", async () => {
    await expectCode(build(src()).call, { path: "Nope.base" }, "not_found");
  });

  test("unparseable base refuses base_parse_error", async () => {
    await expectCode(build(src()).call, { path: "Views/Broken.base" }, "base_parse_error");
  });

  test("unknown view name refuses view_not_found, naming the declared views", async () => {
    const res = await expectCode(build(src()).call, { path: "Views/Q.base", view: "Nope" }, "view_not_found");
    assert.match(errText(res), /Queue, Done/);
  });

  test("a base declaring no views refuses view_not_found", async () => {
    const { call } = build(fakeSource({ bases: { "Empty.base": { filters: {} } } }));
    await expectCode(call, { path: "Empty.base" }, "view_not_found");
  });

  test("a capture timeout refuses TYPED base_timeout (never a hang, never a bare fail)", async () => {
    const { call } = build(
      fakeSource({
        bases: { "Views/Q.base": QUEUE_BASE },
        captureImpl: async () => { throw new BaseTimeoutError(1234); },
      }),
    );
    const res = await expectCode(call, { path: "Views/Q.base" }, "base_timeout");
    assert.match(errText(res), /1234ms/);
  });
});

describe("vault_bases_query success path", () => {
  const ROWS = [
    { path: "Projects/a.md", values: { "file.name": "a", "note.acceptance-status": "proposed", "note.author": "x" } },
    { path: "Archive/b.md", values: { "file.name": "b", "note.acceptance-status": "proposed", "note.author": "y" } },
    { path: "Projects/c.md", values: { "file.name": "c", "note.acceptance-status": null, "note.author": null } },
  ];

  test("columns are the view's declared order, NORMALIZED, handed to the capture; rows shaped {path, properties}", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: ROWS });
    const { call } = build(source);
    const res = await call("query", { path: "Views/Q.base" });
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
    assert.ok(!("some_rows_hidden" in sc), "no visible allowlist ⇒ no hidden-rows field at all");
  });

  test("a NAMED view rides into the capture; a view with no order hands columns: null", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: [] });
    const { call } = build(source);
    const res = await call("query", { path: "Views/Q.base", view: "Done" });
    assert.equal(res.isError, undefined);
    assert.equal(source.calls.captures[0].viewName, "Done");
    assert.equal(source.calls.captures[0].columns, null);
  });

  test("limit clamps to the configured rowCap; truncated + pre-cap total are honest", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: ROWS });
    const { call } = build(source, { config: () => ({ rowCap: 2 }) });
    const res = await call("query", { path: "Views/Q.base", limit: 99 });
    assert.equal(res.structuredContent.rows.length, 2);
    assert.equal(res.structuredContent.total, 3);
    assert.equal(res.structuredContent.truncated, true);
    const res1 = await call("query", { path: "Views/Q.base", limit: 1 });
    assert.equal(res1.structuredContent.rows.length, 1);
  });

  test("config queryTimeoutMs reaches the capture, and is read PER CALL", async () => {
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: [] });
    let config = { queryTimeoutMs: 7000 };
    const { call } = build(source, { config: () => config });
    await call("query", { path: "Views/Q.base" });
    assert.equal(source.calls.captures[0].timeoutMs, 7000);
    // A settings edit lands without a republish for BEHAVIOUR; the description
    // is the one thing that is frozen at publish time, which is why main.ts
    // re-publishes anyway.
    config = { queryTimeoutMs: 9000 };
    await call("query", { path: "Views/Q.base" });
    assert.equal(source.calls.captures[1].timeoutMs, 9000);
  });

  test("with the DORMANT visible seam supplied, hidden rows DROP and some_rows_hidden is a boolean", async () => {
    // The shipped satellite supplies neither `visible` nor `getSettings`, so
    // this whole branch is dormant there — a real reduction in containment,
    // stated in README.md. Tested so it cannot rot before apiVersion 2.
    const settings = { readOnly: false, allowlist: ["Projects", "Views"] };
    const source = fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, rows: ROWS });
    const { call } = build(source, {
      getSettings: () => settings,
      visible: (paths) => visiblePaths(paths, settings),
    });
    const res = await call("query", { path: "Views/Q.base" });
    assert.deepEqual(res.structuredContent.rows.map((r) => r.path), ["Projects/a.md", "Projects/c.md"]);
    assert.equal(res.structuredContent.total, 2);
    assert.equal(res.structuredContent.some_rows_hidden, true);
    assert.ok(!("rows_hidden" in res.structuredContent), "never a hidden-row COUNT (cardinality oracle)");
  });

  test("serialization is MODULE-WIDE: captures from two separately-built spec sets still run one at a time", async () => {
    // The serializer is module-scoped, not per-build — the hidden leaf is a
    // global resource, the host snapshots specs per connection, and main.ts
    // rebuilds them on every settings write. This would fail if
    // makeSerializer() ever moved inside buildBasesTools (independent-review
    // finding: the single-build test below cannot catch that regression).
    let releaseFirst;
    let starts = 0;
    const captureImpl = async () => {
      starts++;
      if (starts === 1) await new Promise((r) => (releaseFirst = r));
      return { columns: [], rows: [] };
    };
    const a = build(fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, captureImpl }));
    const b = build(fakeSource({ bases: { "Views/Q.base": QUEUE_BASE }, captureImpl }));
    const q1 = a.call("query", { path: "Views/Q.base" });
    const q2 = b.call("query", { path: "Views/Q.base" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(starts, 1, "spec set B's capture must wait for spec set A's");
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
    // Tiny timeout so the belt (timeout + grace) fires fast enough for a test.
    const { call } = build(source, { config: () => ({ queryTimeoutMs: 1000 }) });
    const t0 = Date.now();
    const res = await call("query", { path: "Views/Q.base" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[base_timeout\]/);
    assert.ok(Date.now() - t0 < 30_000, "the belt must fire at timeout+grace, not hang");
    const res2 = await call("query", { path: "Views/Q.base" });
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
    const { call } = build(source);
    const q1 = call("query", { path: "Views/Q.base" });
    const q2 = call("query", { path: "Views/Q.base" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(starts, 1, "the second capture must wait for the first");
    releaseFirst();
    const [r1, r2] = await Promise.all([q1, q2]);
    assert.equal(r1.isError, undefined);
    assert.equal(r2.isError, undefined);
    assert.equal(starts, 2);
  });
});

// ── 5. the publication contract (replaces the module-host conformance block) ─
//
// There is no module to mount any more. What takes its place is the contract
// with the Governor host: the names the two tools go on the wire under, the
// flags the host reads off them, and the argument shapes the host's guard can
// see. Each of these was a property the module got for free from the mount and
// now has to be asserted explicitly.
//
// The host's own machinery — write queue, journal, read-only mode, path
// allowlist — is NOT reproduced here. It is host code with host tests, and
// external tools ride the same guarded registration path as built-ins, so the
// behaviour is the host's to pin. What this package owns is the half below:
// what its arguments are NAMED.

describe("publication: names, flags, and what the host's guard can scope", () => {
  const specs = () => buildBasesTools(fakeSource({ bases: { "Views/Q.base": QUEUE_BASE } }), { config: () => ({}) });

  test("the plugin id sanitizes to `vault_bases`, and the bare names shed their `base_` prefix", () => {
    // The rename table, pinned. `base_list`/`base_query` would have published
    // as `vault_bases_base_list`/`vault_bases_base_query` — stuttering — so the
    // bare names are `list`/`query`. Breaking for saved prompts; reversible in
    // one line (the plugin id, plus this shim's PLUGIN_ID and the settings
    // tab's status line).
    assert.equal(OWNER, "vault_bases");
    assert.deepEqual(specs().map((t) => t.name), ["list", "query"]);
    const { tools } = publishInto(specs());
    assert.deepEqual([...tools.keys()], ["vault_bases_list", "vault_bases_query"]);
  });

  test("both tools CLAIM read-only, and an untrusted claim registers as MUTATING", () => {
    // This is why the allowlist posture is what it is: the host distrusts an
    // external tool's readOnlyHint unless the raw publisher id is in
    // trustedReadOnlyPlugins, and a mutating tool with no path argument is
    // blocked outright under an allowlist. Trust answers read-only mode; it
    // never answers scoping.
    const untrusted = publishInto(specs()).tools;
    for (const bare of ["list", "query"]) {
      assert.equal(untrusted.get(`vault_bases_${bare}`).def.claimsReadOnly, true, bare);
      assert.equal(untrusted.get(`vault_bases_${bare}`).def.annotations.readOnlyHint, false, bare);
    }
    const trusted = publishInto(specs(), { trusted: true }).tools;
    for (const bare of ["list", "query"]) {
      assert.equal(trusted.get(`vault_bases_${bare}`).def.annotations.readOnlyHint, true, bare);
    }
  });

  test("THE ASYMMETRY: `list` carries NO host path key, `query`'s `path` IS one", () => {
    // The whole of this package's allowlist story, in one assertion. `list`
    // takes no arguments at all, so under an active allowlist the host blocks
    // it wholesale (stricter than the module's filtered listing). `query`
    // carries `path`, which the host's collectPaths recognizes, so it is SCOPED
    // rather than blocked — and its ROW filter is dormant, which is the loosened
    // half. If either assertion flips, README.md's posture section is wrong.
    const [list, query] = specs();
    assert.deepEqual(Object.keys(list.inputSchema ?? {}), [], "`list` must take no arguments");
    for (const key of Object.keys(list.inputSchema ?? {})) {
      assert.ok(!HOST_PATH_KEYS.includes(key), `list.${key} unexpectedly scopable`);
    }
    assert.ok(HOST_PATH_KEYS.includes("path"), "`path` must be a host path key for query to be scopable");
    assert.ok(Object.keys(query.inputSchema ?? {}).includes("path"));
    assert.ok(!HOST_PATH_KEYS.includes("view"), "`view` is a view NAME, never a path");
    assert.ok(!HOST_PATH_KEYS.includes("limit"));
  });

  test("refusals throw with a lowercase-snake code, which the host renders as `Error [code]: message`", async () => {
    const { call } = build(fakeSource({ bases: { "Views/Q.base": QUEUE_BASE } }));
    const res = await call("query", { path: "Nope.base" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[not_found\]: /);
  });

  test("the schema bounds are re-applied in the HANDLER, because the schema's do not survive the boundary", async () => {
    // The SDK converts zod to JSON Schema and the host converts it back through
    // a small subset: type, description and string enums survive; min, max,
    // default and pattern do not. So an empty `path` and a 0 / fractional
    // `limit` reach the handler and must refuse there. This is the
    // vault_skills_release semver lesson.
    const { call } = build(fakeSource({ bases: { "Views/Q.base": QUEUE_BASE } }));
    for (const args of [
      { path: "" },
      { path: "   " },
      { path: 7 },
      { path: "Views/Q.base", view: "" },
      { path: "Views/Q.base", limit: 0 },
      { path: "Views/Q.base", limit: -3 },
      { path: "Views/Q.base", limit: 2.5 },
      { path: "Views/Q.base", limit: "10" },
    ]) {
      const res = await call("query", args);
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(errText(res), /^Error \[invalid_argument\]: /, JSON.stringify(args));
    }
  });

  test("the tool DESCRIPTIONS render config values, which is why main.ts re-publishes on every settings write", () => {
    // The host snapshots a published spec when it registers it, so a
    // description built from config is frozen at publish time. If these stop
    // rendering config, the republish in main.ts is no longer load-bearing —
    // and if they keep rendering it, removing the republish silently misreports
    // the plugin's limits to every agent reading the tool list.
    const specsAt = (config) => buildBasesTools(fakeSource({ bases: {} }), { config: () => config });
    const query = specsAt({ rowCap: 42, queryTimeoutMs: 4321 })[1];
    assert.match(query.description, /currently 42/);
    assert.match(query.description, /currently 4321ms/);
  });
});

// ── the shared evaluated-rows seam, tested directly ─────────────────────────
//
// `queryBaseRows` is the whole `query` evaluation path factored out. It was
// factored out for the triage module's base-backed queues; that consumer left
// the host at S5 WITHOUT taking the seam, and its `baseQuery` ctx seam is a
// shaped type nothing ever supplies. So when bases itself left at S7 there were
// zero host callers — which is why the serializer could MOVE rather than having
// to be copied, and why there is no second copy to race this one.

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

  test("a backslash path refuses invalid_path at the seam too, before the .base check", async () => {
    const out = await queryBaseRows(baseSource(), { config: {} }, { path: "V\\A.base" });
    assert.equal(out.refusal.code, "invalid_path");
    const notEvenBase = await queryBaseRows(baseSource(), { config: {} }, { path: "V\\A.md" });
    assert.equal(notEvenBase.refusal.code, "invalid_path", "backslash outranks not_a_base");
  });

  test("rows are allowlist-filtered when a filter is supplied (dormant in the shipped plugin)", async () => {
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

// ── one-shot config adoption from the host's modules.bases.config ────────────

describe("settings adoption (pure)", () => {
  const HOST = (config) => ({ modules: { bases: { enabled: true, config } } });
  const fresh = () => ({ ...DEFAULT_PLUGIN_SETTINGS, config: {} });

  test("adopts the recognized keys once and latches", () => {
    const out = adoptHostConfig(fresh(), HOST({ queryTimeoutMs: 60_000, rowCap: 50 }));
    assert.deepEqual(out.config, { queryTimeoutMs: 60_000, rowCap: 50 });
    assert.equal(out.adoptedFromHost, true);
    assert.equal(adoptHostConfig(out, HOST({ rowCap: 999 })), null, "the latch is one-shot");
  });

  test("the satellite's OWN values win; adoption only fills gaps", () => {
    const out = adoptHostConfig({ ...fresh(), config: { rowCap: 99 } }, HOST({ rowCap: 50, queryTimeoutMs: 60_000 }));
    assert.deepEqual(out.config, { rowCap: 99, queryTimeoutMs: 60_000 });
  });

  test("an unrecognized host key is NOT copied", () => {
    const out = adoptHostConfig(fresh(), HOST({ notAField: 1, rowCap: 7 }));
    assert.deepEqual(out.config, { rowCap: 7 });
    assert.deepEqual([...ADOPTABLE_KEYS].sort(), Object.keys(DEFAULT_BASES_CONFIG).sort());
  });

  test("an ABSENT host adopts nothing and does NOT latch — the one chance survives", () => {
    assert.equal(adoptHostConfig(fresh(), undefined), null);
    assert.equal(adoptHostConfig(fresh(), null), null);
  });

  test("a host whose `settings` is still UNDEFINED reads as NOT READY, not as empty settings", () => {
    // The host declares `settings` without an initializer and assigns it
    // mid-onload, so an instance visible in app.plugins.plugins before that
    // assignment must not burn the latch. main.ts passes `undefined` in that
    // case, which is exactly the absent-host argument below. Found by the
    // skills extraction's review.
    assert.equal(adoptHostConfig(fresh(), undefined), null);
  });

  test("a host present with NO bases config still latches — the question was asked and answered", () => {
    const out = adoptHostConfig(fresh(), { modules: { bases: { enabled: true } } });
    assert.deepEqual(out.config, {});
    assert.equal(out.adoptedFromHost, true);
  });

  test("settingsOf coerces a corrupt or hand-edited data.json to the defaults", () => {
    assert.deepEqual(settingsOf(null), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf([1, 2]), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf({ config: "nope", adoptedFromHost: "yes" }), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf({ config: { rowCap: 7 }, adoptedFromHost: true }), {
      config: { rowCap: 7 },
      adoptedFromHost: true,
    });
  });

  test("there is only ONE latch: this surface holds no live operational state to adopt", () => {
    // The cross-session satellite needed a second, independently-latched
    // adoption for its receipt file. Bases has no state file, no cache and no
    // note it ever wrote — checked, not assumed. If a second latch is ever
    // needed here, this assertion is where you will notice.
    assert.deepEqual(Object.keys(DEFAULT_PLUGIN_SETTINGS).sort(), ["adoptedFromHost", "config"]);
  });

  test("the settings-tab fields are the host manifest's two keys, in order", () => {
    assert.deepEqual(BASES_FIELDS.map((f) => f.key), ["queryTimeoutMs", "rowCap"]);
    for (const f of BASES_FIELDS) {
      assert.ok(f.label && f.help, `${f.key} must carry its label and help text`);
      assert.ok(["text", "number"].includes(f.type));
    }
  });

  test("no shipped help text still points at `modules.bases.config` or the retired tool names", () => {
    // Lesson 5 of the satellite reviews: a string that names a path which no
    // longer exists is worse than no string. `modules.bases.config.*` names
    // nothing in this plugin, and neither does `base_query`.
    for (const f of BASES_FIELDS) {
      assert.ok(!f.help.includes("modules.bases"), `${f.key} help still names the host's settings path`);
      assert.ok(!/\bbase_query\b/.test(f.help), `${f.key} help still names the retired tool base_query`);
      assert.ok(!/\bbase_list\b/.test(f.help), `${f.key} help still names the retired tool base_list`);
    }
    const [list, query] = buildBasesTools(fakeSource({ bases: {} }), { config: () => ({}) });
    for (const spec of [list, query]) {
      assert.ok(!spec.description.includes("modules.bases"), `${spec.name} description still names the host's settings path`);
      assert.ok(!/\bbase_query\b/.test(spec.description), `${spec.name} description still names base_query`);
      assert.ok(!/\bbase_list\b/.test(spec.description), `${spec.name} description still names base_list`);
    }
  });
});
