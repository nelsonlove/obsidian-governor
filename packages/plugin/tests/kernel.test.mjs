/**
 * kernel.test.mjs — kernel v0 slice A: the serialized write queue and the
 * write journal, plus the guarded wrapper where both bind to the tool surface.
 *
 * Everything under test is Obsidian-free by design (the queue and journal take
 * duck-typed collaborators), so these are real unit tests rather than the
 * live-probe verification the app.* handlers need.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Kernel,
  WriteQueue,
  WriteJournal,
  WriteTimeoutError,
  WRITE_TIMEOUT_MS,
  digestArgs,
  monthKey,
} from "../src/kernel/index.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Stand-in for Obsidian's DataAdapter — the four methods WriteJournal narrows to.
function fakeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    calls: [],
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { this.calls.push(["mkdir", p]); dirs.add(p); },
    async write(p, d) { this.calls.push(["write", p]); files.set(p, d); },
    async append(p, d) { this.calls.push(["append", p]); files.set(p, (files.get(p) ?? "") + d); },
  };
}

function linesOf(adapter, file) {
  return (adapter.files.get(file) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };

// Runs fn with console.error muted, so expected-failure paths don't spam output.
async function quietly(fn) {
  const orig = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a);
  try { return await fn(seen); } finally { console.error = orig; }
}

// ── WriteQueue: serialization ────────────────────────────────────────────────

describe("WriteQueue serialization", () => {
  test("runs one operation at a time, in enqueue order", async () => {
    const queue = new WriteQueue(1000);
    let active = 0;
    let maxActive = 0;
    const finished = [];

    const op = (name, delay) => queue.run(name, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(delay);
      active--;
      finished.push(name);
      return name;
    });

    // Deliberately inverted durations: a parallel implementation would finish
    // these out of order, so the ordering assertion is load-bearing.
    const results = await Promise.all([op("a", 30), op("b", 1), op("c", 15), op("d", 0)]);

    assert.equal(maxActive, 1, "two mutating operations overlapped");
    assert.deepEqual(finished, ["a", "b", "c", "d"], "operations must complete in enqueue order");
    assert.deepEqual(results, ["a", "b", "c", "d"]);
    assert.equal(queue.depth, 0);
    assert.equal(queue.running, false);
  });

  test("a later operation does not start until the earlier one settles", async () => {
    const queue = new WriteQueue(1000);
    const gate = deferred();
    let secondStarted = false;

    const first = queue.run("first", () => gate.promise);
    const second = queue.run("second", async () => { secondStarted = true; });

    await tick(10);
    assert.equal(secondStarted, false, "second operation started while the first held the queue");
    assert.equal(queue.depth, 1);

    gate.resolve("done");
    assert.equal(await first, "done");
    await second;
    assert.equal(secondStarted, true);
  });

  test("a failing operation rejects only itself; the queue continues", async () => {
    const queue = new WriteQueue(1000);
    const boom = queue.run("boom", async () => { throw new Error("handler exploded"); });
    const sync = queue.run("sync-boom", () => { throw new Error("thrown synchronously"); });
    const after = queue.run("after", async () => "still running");

    await assert.rejects(boom, /handler exploded/);
    await assert.rejects(sync, /thrown synchronously/);
    assert.equal(await after, "still running");
  });

  test("the default timeout is the documented 30s constant", () => {
    assert.equal(WRITE_TIMEOUT_MS, 30_000);
  });
});

// ── WriteQueue: wedged operations ────────────────────────────────────────────

describe("WriteQueue timeout", () => {
  test("a wedged operation fails typed and the queue moves on", async () => {
    const queue = new WriteQueue(25);
    const wedged = deferred(); // never resolves during the test
    let nextRan = false;

    const stuck = queue.run("obsidian_move_note", () => wedged.promise);
    const next = queue.run("obsidian_write_note", async () => { nextRan = true; return "ok"; });

    const err = await stuck.then(
      () => assert.fail("wedged operation should not resolve"),
      (e) => e
    );
    assert.ok(err instanceof WriteTimeoutError);
    assert.equal(err.code, "write_timeout");
    assert.equal(err.op, "obsidian_move_note");
    assert.match(err.message, /obsidian_move_note/);
    assert.match(err.message, /25ms/);

    assert.equal(await next, "ok", "queue must continue after abandoning a wedged operation");
    assert.equal(nextRan, true);
    assert.equal(queue.running, false);
  });

  test("an abandoned operation settling later cannot double-release the queue", async () => {
    const queue = new WriteQueue(20);
    const wedged = deferred();
    await assert.rejects(queue.run("stuck", () => wedged.promise), WriteTimeoutError);

    const gate = deferred();
    const held = queue.run("held", () => gate.promise);
    await tick(5);
    // The abandoned operation finishes now — it must not free the slot the
    // next operation is holding.
    wedged.resolve("late");
    await tick(5);
    let jumperRan = false;
    const jumper = queue.run("jumper", async () => { jumperRan = true; });
    await tick(5);
    assert.equal(jumperRan, false, "a late-settling abandoned operation released the queue");
    gate.resolve("ok");
    assert.equal(await held, "ok");
    await jumper;
    assert.equal(jumperRan, true);
  });
});

// ── WriteJournal ─────────────────────────────────────────────────────────────

describe("WriteJournal", () => {
  const record = (over = {}) => ({
    ts: "2026-08-08T12:00:00.000Z",
    op: "obsidian_write_note",
    target: { path: "Notes/A.md", uid: "uid-a" },
    actor: ACTOR,
    argsDigest: { path: "Notes/A.md", overwrite: true },
    outcome: "ok",
    durationMs: 4,
    revBefore: 100,
    revAfter: 200,
    ...over,
  });

  test("appends one JSONL record per operation, creating the dir once", async () => {
    const adapter = fakeAdapter();
    const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));

    await journal.append(record());
    await journal.append(record({ op: "obsidian_delete_note", outcome: "error", error: "Error: not found" }));

    const file = "dir/journal/2026-08.jsonl";
    assert.equal(journal.currentFile(), file);
    const lines = linesOf(adapter, file);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], record());
    assert.equal(lines[1].op, "obsidian_delete_note");
    assert.equal(lines[1].outcome, "error");
    assert.equal(lines[1].error, "Error: not found");
    assert.deepEqual(adapter.calls.filter(([m]) => m === "mkdir"), [["mkdir", "dir/journal"]]);
    // First line created the file; every later line appended.
    assert.deepEqual(
      adapter.calls.filter(([m]) => m === "write" || m === "append"),
      [["write", file], ["append", file]]
    );
  });

  test("append-only: existing lines are never rewritten and there is no edit/delete API", async () => {
    const adapter = fakeAdapter();
    const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
    for (let i = 0; i < 5; i++) await journal.append(record({ durationMs: i }));
    const lines = linesOf(adapter, "dir/journal/2026-08.jsonl");
    assert.deepEqual(lines.map((l) => l.durationMs), [0, 1, 2, 3, 4], "earlier records must survive verbatim");

    const surface = new Set([
      ...Object.getOwnPropertyNames(WriteJournal.prototype),
      ...Object.keys(journal),
    ]);
    for (const forbidden of ["delete", "remove", "edit", "update", "rewrite", "truncate", "prune", "compact"]) {
      assert.equal(surface.has(forbidden), false, `WriteJournal must expose no '${forbidden}' API`);
    }
  });

  test("concurrent appends serialize into whole lines", async () => {
    const adapter = fakeAdapter();
    const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => journal.append(record({ durationMs: i }))));
    const lines = linesOf(adapter, "dir/journal/2026-08.jsonl");
    assert.deepEqual(lines.map((l) => l.durationMs), [0, 1, 2, 3, 4, 5]);
  });

  test("rolls monthly by filename", async () => {
    const adapter = fakeAdapter();
    let now = new Date("2026-08-31T23:59:59Z");
    const journal = new WriteJournal(adapter, "dir/journal", () => now);
    await journal.append(record());
    now = new Date("2026-09-01T00:00:01Z");
    await journal.append(record());
    assert.equal(linesOf(adapter, "dir/journal/2026-08.jsonl").length, 1);
    assert.equal(linesOf(adapter, "dir/journal/2026-09.jsonl").length, 1);
    // UTC keying, so a file name never disagrees with the ts of its records.
    assert.equal(monthKey(new Date("2026-01-05T12:00:00Z")), "2026-01");
    assert.equal(monthKey(new Date("2026-12-31T23:00:00Z")), "2026-12");
  });

  test("a journal write failure is logged, never thrown, and never blocks the chain", async () => {
    await quietly(async (logged) => {
      const adapter = fakeAdapter();
      adapter.write = async () => { throw new Error("disk full"); };
      const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
      await journal.append(record()); // must resolve, not reject
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][0]), /journal append failed/);
      // The chain survives: a later append with a working adapter still lands.
      adapter.write = async (p, d) => { adapter.files.set(p, d); };
      await journal.append(record({ op: "obsidian_append_note" }));
      assert.equal(linesOf(adapter, "dir/journal/2026-08.jsonl").length, 1);
    });
  });
});

// ── argsDigest ───────────────────────────────────────────────────────────────

describe("digestArgs", () => {
  test("summarizes note bodies and over-long strings, keeps paths and flags", () => {
    const d = digestArgs({
      path: "Notes/A.md",
      content: "# Title\nA short body, but still a body.",
      overwrite: true,
      limit: 25,
      blurb: "x".repeat(500),
    });
    assert.equal(d.path, "Notes/A.md");
    assert.equal(d.content, "<39 chars>", "note bodies must never reach the journal");
    assert.equal(d.overwrite, true);
    assert.equal(d.limit, 25);
    assert.equal(d.blurb, "<500 chars>");
  });

  test("preserves nested shape, truncates long arrays", () => {
    const d = digestArgs({
      moves: [{ from: "A.md", to: "B.md" }, { from: "C.md", to: "D.md" }],
      paths: Array.from({ length: 14 }, (_, i) => `N${i}.md`),
    });
    assert.deepEqual(d.moves, [{ from: "A.md", to: "B.md" }, { from: "C.md", to: "D.md" }]);
    assert.equal(d.paths.length, 11);
    assert.equal(d.paths[10], "<+4 more>");
  });
});

// ── Kernel.runMutation ───────────────────────────────────────────────────────

function fakeKernel({ timeoutMs = 1000, revs = new Map(), uids = new Map() } = {}) {
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
  const probe = { uid: (p) => uids.get(p), rev: (p) => revs.get(p) };
  const kernel = new Kernel(new WriteQueue(timeoutMs), journal, probe);
  const records = () => linesOf(adapter, "dir/journal/2026-08.jsonl");
  return { kernel, journal, adapter, records };
}

describe("Kernel.runMutation", () => {
  test("journals a full record for a successful operation", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs, uids: new Map([["Notes/A.md", "uid-a"]]) });

    const result = await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "Notes/A.md", content: "hello", overwrite: true }, actor: ACTOR },
      async () => { revs.set("Notes/A.md", 200); return { content: [{ type: "text", text: "{}" }] }; }
    );
    assert.deepEqual(result, { content: [{ type: "text", text: "{}" }] });

    // runMutation journals fire-and-forget; a macrotask flushes the write chain.
    await tick(0);
    const [rec] = records();
    assert.equal(rec.op, "obsidian_write_note");
    assert.deepEqual(rec.target, { path: "Notes/A.md", uid: "uid-a" });
    assert.deepEqual(rec.actor, ACTOR);
    assert.deepEqual(rec.argsDigest, { path: "Notes/A.md", content: "<5 chars>", overwrite: true });
    assert.equal(rec.outcome, "ok");
    assert.equal(rec.error, undefined);
    assert.equal(rec.revBefore, 100);
    assert.equal(rec.revAfter, 200);
    assert.equal(typeof rec.durationMs, "number");
    assert.ok(!Number.isNaN(Date.parse(rec.ts)));
  });

  test("records outcome=error when a handler returns an isError envelope", async () => {
    const { kernel, records } = fakeKernel();
    const res = await kernel.runMutation(
      { op: "obsidian_delete_note", args: { path: "Gone.md", confirm: true }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "Error: not found: Gone.md" }], isError: true })
    );
    assert.equal(res.isError, true);
    await tick(0);
    const [rec] = records();
    assert.equal(rec.outcome, "error");
    assert.equal(rec.error, "Error: not found: Gone.md");
  });

  test("records outcome=error and rethrows when a handler throws", async () => {
    const { kernel, records } = fakeKernel();
    await assert.rejects(
      kernel.runMutation({ op: "obsidian_patch_note", args: { path: "A.md" }, actor: ACTOR }, async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    await tick(0);
    const [rec] = records();
    assert.equal(rec.outcome, "error");
    assert.equal(rec.error, "boom");
  });

  test("multi-target operations record every path, primary first", async () => {
    const { kernel, records } = fakeKernel();
    await kernel.runMutation(
      { op: "obsidian_move_notes", args: { moves: [{ from: "A.md", to: "B.md" }], overwrite: false }, actor: ACTOR },
      async () => ({ content: [] })
    );
    await tick(0);
    const [rec] = records();
    assert.equal(rec.target.path, "A.md");
    assert.deepEqual(rec.target.paths, ["A.md", "B.md"]);
  });

  test("a broken journal never fails the operation", async () => {
    await quietly(async () => {
      const adapter = fakeAdapter();
      adapter.exists = async () => { throw new Error("adapter is on fire"); };
      const kernel = new Kernel(new WriteQueue(1000), new WriteJournal(adapter, "dir/journal"), null);
      const res = await kernel.runMutation(
        { op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR },
        async () => ({ content: [{ type: "text", text: "written" }] })
      );
      assert.deepEqual(res, { content: [{ type: "text", text: "written" }] });
      await tick(0); // let the fire-and-forget journal write fail while muted
    });
  });

  test("mutations from different connections share one queue", async () => {
    const { kernel } = fakeKernel();
    const gate = deferred();
    let secondRan = false;
    const connA = { ...ACTOR, connection: "conn-a" };
    const connB = { ...ACTOR, connection: "conn-b" };

    const first = kernel.runMutation({ op: "obsidian_write_note", args: { path: "A.md" }, actor: connA }, () => gate.promise);
    const second = kernel.runMutation({ op: "obsidian_write_note", args: { path: "B.md" }, actor: connB }, async () => {
      secondRan = true;
      return { content: [] };
    });

    await tick(10);
    assert.equal(secondRan, false, "a second connection's mutation ran while the first held the queue");
    gate.resolve({ content: [] });
    await first;
    await second;
    assert.equal(secondRan, true);
  });
});

// ── makeGuarded: where guard, queue, and journal bind to the tool surface ─────

const RW_DEF = { annotations: { readOnlyHint: false } };
const RO_DEF = { annotations: { readOnlyHint: true } };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };

describe("makeGuarded", () => {
  test("reads never queue: a read runs while a mutation holds the queue", async () => {
    const { kernel } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const gate = deferred();

    const write = guarded(RW_DEF, () => gate.promise, "obsidian_write_note");
    const read = guarded(RO_DEF, async () => ({ content: [{ type: "text", text: "read" }] }), "obsidian_read_note");

    const writing = write({ path: "A.md" }, {});
    const readResult = await read({ path: "A.md" }, {});
    assert.equal(readResult.content[0].text, "read", "a read waited behind an in-flight write");

    gate.resolve({ content: [] });
    await writing;
  });

  test("reads are not journaled", async () => {
    const { kernel, records } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    await guarded(RO_DEF, async () => ({ content: [] }), "obsidian_read_note")({ path: "A.md" }, {});
    await tick(5);
    assert.equal(records().length, 0);
  });

  test("the guard still runs first — a blocked call never reaches the queue or journal", async () => {
    const { kernel, records } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => ({ readOnly: true, allowlist: [] }), kernel, actor: () => ACTOR });
    let ran = false;
    const res = await guarded(RW_DEF, async () => { ran = true; }, "obsidian_write_note")({ path: "A.md" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[read_only\]/);
    assert.equal(ran, false);
    await tick(5);
    assert.equal(records().length, 0);
    assert.equal(kernel.queue.depth, 0);
  });

  test("a wedged mutation returns a typed write_timeout error and the queue continues", async () => {
    const { kernel, records } = fakeKernel({ timeoutMs: 25 });
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const wedged = deferred();

    const stuck = guarded(RW_DEF, () => wedged.promise, "obsidian_move_note")({ path: "A.md" }, {});
    const next = guarded(RW_DEF, async () => ({ content: [{ type: "text", text: "moved" }] }), "obsidian_write_note")(
      { path: "B.md" },
      {}
    );

    const res = await stuck;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[write_timeout\]/);
    assert.match(res.content[0].text, /obsidian_move_note/);

    const after = await next;
    assert.equal(after.content[0].text, "moved");

    await tick(5);
    const recs = records();
    assert.equal(recs.length, 2);
    assert.equal(recs[0].op, "obsidian_move_note");
    assert.equal(recs[0].outcome, "error");
    assert.match(recs[0].error, /write-queue timeout/);
    assert.equal(recs[1].op, "obsidian_write_note");
    assert.equal(recs[1].outcome, "ok");
  });

  test("without a kernel the wrapper degrades to guard-only (no queue, no journal)", async () => {
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, actor: () => ACTOR });
    const res = await guarded(RW_DEF, async () => ({ content: [{ type: "text", text: "wrote" }] }), "obsidian_write_note")(
      { path: "A.md" },
      {}
    );
    assert.equal(res.content[0].text, "wrote");
  });
});
