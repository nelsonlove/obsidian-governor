/**
 * kernel.test.mjs — kernel v0: the serialized write queue, the write journal,
 * `if_rev` optimistic concurrency and idempotency keys, plus the guarded
 * wrapper where they all bind to the tool surface.
 *
 * Everything under test is Obsidian-free by design (the queue, journal and
 * probe are duck-typed collaborators), so these are real unit tests rather than
 * the live-probe verification the app.* handlers need.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  Kernel,
  WriteQueue,
  WriteJournal,
  WriteTimeoutError,
  RevConflictError,
  ProbeError,
  IdempotencyStore,
  IdempotencyMismatchError,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MAX,
  WRITE_TIMEOUT_MS,
  digestArgs,
  monthKey,
} from "../src/kernel/index.ts";
import { makeGuarded, withKernelArgs, KERNEL_ARG_KEYS } from "../src/mcp/guarded.ts";

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

function fakeKernel({ timeoutMs = 1000, revs = new Map(), uids = new Map(), probe, idempotency } = {}) {
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
  const p = probe ?? { uid: (path) => uids.get(path), rev: (path) => revs.get(path) };
  const kernel = new Kernel(new WriteQueue(timeoutMs), journal, p, idempotency ?? new IdempotencyStore());
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

  test("revBefore is sampled at dequeue, not at enqueue", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs });
    const gate = deferred();
    const args = { path: "Notes/A.md" };

    const first = kernel.runMutation({ op: "obsidian_write_note", args, actor: ACTOR }, async () => {
      await gate.promise;
      revs.set("Notes/A.md", 200);
      return { content: [] };
    });
    // Enqueued while the first still holds the queue: its revBefore must be the
    // revision the FIRST operation left behind, not the one it displaced.
    const second = kernel.runMutation({ op: "obsidian_append_note", args, actor: ACTOR }, async () => {
      await tick(0);
      revs.set("Notes/A.md", 300);
      return { content: [] };
    });

    await tick(5);
    assert.equal(kernel.queue.depth, 1);
    gate.resolve();
    await first;
    await second;
    await tick(0);

    const recs = records();
    assert.equal(recs[0].revBefore, 100);
    assert.equal(recs[0].revAfter, 200);
    assert.equal(recs[1].revBefore, recs[0].revAfter, "a queued operation carried a stale, pre-queue revBefore");
    assert.equal(recs[1].revBefore, 200);
    assert.equal(recs[1].revAfter, 300);
  });

  test("queueWaitMs records the wait; durationMs is handler time only", async () => {
    const { kernel, records } = fakeKernel();
    const gate = deferred();

    const first = kernel.runMutation({ op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR }, () => gate.promise);
    const second = kernel.runMutation({ op: "obsidian_write_note", args: { path: "B.md" }, actor: ACTOR }, async () => {
      await tick(5);
      return { content: [] };
    });

    await tick(40);
    gate.resolve({ content: [] });
    await first;
    await second;
    await tick(0);

    const [head, queued] = records();
    assert.equal(typeof head.queueWaitMs, "number");
    assert.ok(head.queueWaitMs < 25, `an unqueued operation waited (${head.queueWaitMs}ms)`);
    assert.ok(queued.queueWaitMs >= 25, `queue wait was not recorded (${queued.queueWaitMs}ms)`);
    assert.ok(queued.durationMs < 25, `durationMs still includes the queue wait (${queued.durationMs}ms)`);
  });

  test("a late-settling abandoned operation gets a corrective record", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ timeoutMs: 25, revs });
    const wedged = deferred();

    await assert.rejects(
      kernel.runMutation({ op: "obsidian_move_note", args: { path: "Notes/A.md" }, actor: ACTOR }, () => wedged.promise),
      WriteTimeoutError
    );
    await tick(0);
    assert.equal(records().length, 1, "the timeout itself journals exactly one record");

    // The queue is not wedged behind the abandoned operation.
    const next = await kernel.runMutation({ op: "obsidian_write_note", args: { path: "B.md" }, actor: ACTOR }, async () => ({
      content: [{ type: "text", text: "wrote" }],
    }));
    assert.equal(next.content[0].text, "wrote");
    await tick(0);

    // …and now the abandoned operation finally lands.
    revs.set("Notes/A.md", 400);
    wedged.resolve({ content: [{ type: "text", text: "moved" }] });
    await tick(5);

    const recs = records();
    assert.equal(recs.length, 3);
    assert.equal(recs[0].outcome, "error");
    assert.match(recs[0].error, /write-queue timeout/);
    const corrective = recs[2];
    assert.equal(corrective.op, "obsidian_move_note");
    assert.equal(corrective.outcome, "late-ok");
    assert.equal(corrective.error, undefined);
    assert.equal(corrective.corrects, recs[0].ts, "the corrective record must name the record it corrects");
    assert.deepEqual(corrective.target, recs[0].target);
    assert.deepEqual(corrective.actor, ACTOR);
    assert.equal(corrective.revBefore, 100);
    assert.equal(corrective.revAfter, 400, "the correction must re-probe the revision");
    assert.equal(kernel.queue.running, false);
  });

  test("an abandoned operation that fails late is corrected as late-error", async () => {
    const { kernel, records } = fakeKernel({ timeoutMs: 20 });
    const wedged = deferred();
    await assert.rejects(
      kernel.runMutation({ op: "obsidian_patch_note", args: { path: "A.md" }, actor: ACTOR }, () => wedged.promise),
      WriteTimeoutError
    );
    wedged.reject(new Error("disk gave up"));
    await tick(5);

    const [, corrective] = records();
    assert.equal(corrective.outcome, "late-error");
    assert.equal(corrective.error, "disk gave up");
    assert.equal(corrective.corrects, records()[0].ts);
  });

  test("an isError envelope arriving late is corrected as late-error", async () => {
    const { kernel, records } = fakeKernel({ timeoutMs: 20 });
    const wedged = deferred();
    await assert.rejects(
      kernel.runMutation({ op: "obsidian_move_note", args: { path: "A.md" }, actor: ACTOR }, () => wedged.promise),
      WriteTimeoutError
    );
    wedged.resolve({ content: [{ type: "text", text: "Error: destination exists" }], isError: true });
    await tick(5);

    const [, corrective] = records();
    assert.equal(corrective.outcome, "late-error");
    assert.equal(corrective.error, "Error: destination exists");
  });

  test("a broken journal never throws from the late-settlement path", async () => {
    await quietly(async () => {
      const adapter = fakeAdapter();
      adapter.exists = async () => { throw new Error("adapter is on fire"); };
      const kernel = new Kernel(new WriteQueue(20), new WriteJournal(adapter, "dir/journal"), null);
      const wedged = deferred();
      await assert.rejects(
        kernel.runMutation({ op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR }, () => wedged.promise),
        WriteTimeoutError
      );
      wedged.resolve({ content: [] });
      await tick(5); // the corrective append fails, muted, and nothing escapes
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

  test("pathless mutators journal a ref target, and a real path still wins", async () => {
    const { kernel, records } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const call = (name, args) => guarded(RW_DEF, async () => ({ content: [] }), name)(args, {});

    await call("obsidian_run_command", { command_id: "editor:toggle-bold" });
    await call("obsidian_plugin_toggle", { plugin_id: "dataview", enabled: true });
    await call("obsidian_open_workspace", { name: "Writing" });
    await call("obsidian_periodic_note", { kind: "daily", action: "open" });
    await call("obsidian_write_note", { path: "Notes/A.md", name: "not the target" });
    await tick(5);

    const recs = records();
    assert.deepEqual(
      recs.map((r) => r.target.ref),
      ["command:editor:toggle-bold", "plugin:dataview", "name:Writing", "kind:daily", undefined]
    );
    assert.equal(recs[4].target.path, "Notes/A.md", "a path argument always outranks the ref fallback");
  });

  test("without a kernel the wrapper degrades to guard-only (no queue, no journal)", async () => {
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, actor: () => ACTOR });
    const res = await guarded(RW_DEF, async () => ({ content: [{ type: "text", text: "wrote" }] }), "obsidian_write_note")(
      { path: "A.md" },
      {}
    );
    assert.equal(res.content[0].text, "wrote");
  });

  // ── carried finding D1/D2: ref keys ────────────────────────────────────────

  test("obsidian_cli journals a command ref, and an id outranks a name", async () => {
    const { kernel, records } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const call = (name, args) => guarded(RW_DEF, async () => ({ content: [] }), name)(args, {});

    await call("obsidian_cli", { command: "file-history", params: { file: "A.md" } });
    // Most-identifying-first: the id is the target, the name is decoration.
    await call("obsidian_external_tool", { id: "task-42", name: "Do the thing" });
    await tick(5);

    const recs = records();
    assert.equal(recs[0].target.ref, "command:file-history", "obsidian_cli must journal what it ran");
    assert.equal(recs[1].target.ref, "id:task-42", "'id' must outrank 'name' as a target ref");
  });
});

// ── WriteQueue: the late-settlement hook itself (carried finding D6) ──────────

describe("WriteQueue onLate", () => {
  test("a throwing onLate observer is contained and the queue keeps running", async () => {
    await quietly(async (logged) => {
      const queue = new WriteQueue(20);
      const wedged = deferred();

      await assert.rejects(
        queue.run("stuck", () => wedged.promise, () => {
          throw new Error("observer exploded");
        }),
        WriteTimeoutError
      );

      // The abandoned operation settles and the observer blows up.
      wedged.resolve("late");
      await tick(5);

      assert.ok(
        logged.some(([msg]) => /late-settlement handler failed/.test(String(msg))),
        "a failing onLate observer must be logged"
      );
      assert.equal(await queue.run("after", async () => "still running"), "still running");
      assert.equal(queue.running, false);
      assert.equal(queue.depth, 0);
    });
  });

  test("onLate fires only for an operation the queue already abandoned", async () => {
    const queue = new WriteQueue(1000);
    let lateCalls = 0;
    assert.equal(await queue.run("quick", async () => "done", () => { lateCalls++; }), "done");
    await tick(5);
    assert.equal(lateCalls, 0, "a healthy operation must never report a late settlement");
  });
});

// ── if_rev: optimistic concurrency ───────────────────────────────────────────

describe("if_rev preconditions", () => {
  const ctx = (over = {}) => ({ op: "obsidian_write_note", args: { path: "Notes/A.md" }, actor: ACTOR, ...over });

  test("a matching if_rev executes the operation normally", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs });
    let ran = false;

    const res = await kernel.runMutation(ctx({ ifRev: 100 }), async () => {
      ran = true;
      revs.set("Notes/A.md", 200);
      return { content: [{ type: "text", text: "wrote" }] };
    });

    assert.equal(ran, true);
    assert.equal(res.content[0].text, "wrote");
    await tick(0);
    const [rec] = records();
    assert.equal(rec.outcome, "ok");
    assert.equal(rec.ifRev, 100);
    assert.equal(rec.revBefore, 100);
    assert.equal(rec.revAfter, 200);
  });

  test("a mismatched if_rev conflicts: no write, typed error, outcome=conflict", async () => {
    const revs = new Map([["Notes/A.md", 250]]);
    const { kernel, records } = fakeKernel({ revs });
    let ran = false;

    const err = await kernel.runMutation(ctx({ ifRev: 100 }), async () => { ran = true; }).then(
      () => assert.fail("a conflicting mutation must not resolve"),
      (e) => e
    );

    assert.ok(err instanceof RevConflictError);
    assert.equal(err.code, "rev_conflict");
    assert.equal(err.expected, 100);
    assert.equal(err.actual, 250);
    assert.match(err.message, /rev 100/);
    assert.match(err.message, /rev 250/);
    assert.equal(ran, false, "the handler must not run when the precondition fails");
    assert.equal(revs.get("Notes/A.md"), 250, "nothing may be written on a conflict");

    await tick(0);
    const [rec] = records();
    assert.equal(rec.outcome, "conflict");
    assert.equal(rec.ifRev, 100);
    assert.equal(rec.revBefore, 250, "revBefore must record the revision actually found");
    assert.match(rec.error, /expected/);
    assert.equal(kernel.queue.running, false);
    assert.equal(kernel.queue.depth, 0);
  });

  test("if_rev against a target with no revision conflicts (fails closed)", async () => {
    const { kernel } = fakeKernel(); // empty rev map: the note does not exist
    let ran = false;
    const err = await kernel.runMutation(ctx({ ifRev: 100 }), async () => { ran = true; }).then(
      () => assert.fail("an unverifiable precondition must not pass"),
      (e) => e
    );
    assert.ok(err instanceof RevConflictError);
    assert.equal(err.actual, undefined);
    assert.equal(ran, false);
  });

  test("no if_rev means no precondition — behavior is exactly as before", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs });
    const res = await kernel.runMutation(ctx(), async () => ({ content: [] }));
    assert.deepEqual(res, { content: [] });
    await tick(0);
    const [rec] = records();
    assert.equal(rec.outcome, "ok");
    assert.equal(rec.ifRev, undefined, "the field must be absent, not null, when unused");
  });

  test("the precondition is checked at DEQUEUE, so a pipelined write cannot lose an update", async () => {
    // The lost-update kill shot. Both mutations are enqueued while the target
    // is at rev 100; the first bumps it to 200 while the second waits. The
    // second carries if_rev: 100 — the rev its caller READ before the first ran.
    // An enqueue-time check would find 100 and let it clobber the first write.
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs });
    const gate = deferred();
    let secondRan = false;

    const first = kernel.runMutation(ctx({ op: "obsidian_write_note" }), async () => {
      await gate.promise;
      revs.set("Notes/A.md", 200);
      return { content: [] };
    });
    const second = kernel.runMutation(ctx({ op: "obsidian_append_note", ifRev: 100 }), async () => {
      secondRan = true;
      return { content: [] };
    });

    await tick(5);
    assert.equal(kernel.queue.depth, 1, "the second mutation must still be queued");
    gate.resolve();
    await first;
    await assert.rejects(second, RevConflictError);

    assert.equal(secondRan, false, "a stale-rev write ran anyway — the check moved to enqueue time");
    assert.equal(revs.get("Notes/A.md"), 200, "the first write must survive");
    await tick(0);
    const recs = records();
    assert.equal(recs[0].outcome, "ok");
    assert.equal(recs[1].outcome, "conflict");
    assert.equal(recs[1].revBefore, 200);
    assert.equal(recs[1].ifRev, 100);
  });

  test("on a multi-target operation if_rev applies to the primary target", async () => {
    const revs = new Map([["A.md", 100], ["B.md", 999]]);
    const { kernel } = fakeKernel({ revs });
    const args = { moves: [{ from: "A.md", to: "B.md" }] };
    let ran = false;

    // Matches A.md (the first path the arguments name); B.md's revision is
    // deliberately different and must not be what is compared.
    await kernel.runMutation(
      { op: "obsidian_move_notes", args, actor: ACTOR, ifRev: 100 },
      async () => { ran = true; return { content: [] }; }
    );
    assert.equal(ran, true);

    await assert.rejects(
      kernel.runMutation({ op: "obsidian_move_notes", args, actor: ACTOR, ifRev: 999 }, async () => ({ content: [] })),
      RevConflictError
    );
  });
});

// ── idempotency keys ─────────────────────────────────────────────────────────

describe("IdempotencyStore", () => {
  test("the documented TTL and cap", () => {
    assert.equal(IDEMPOTENCY_TTL_MS, 10 * 60_000);
    assert.equal(IDEMPOTENCY_MAX, 500);
  });

  test("entries expire at the TTL and evict LRU-first at the cap", () => {
    let now = 1_000;
    const store = new IdempotencyStore(100, 3, () => now);
    store.set("a", { op: "o", result: 1, ts: "t" });
    assert.equal(store.get("a").result, 1);
    now += 100;
    assert.equal(store.get("a"), undefined, "an entry must not outlive its TTL");

    now = 1_000;
    const lru = new IdempotencyStore(10_000, 2, () => now);
    lru.set("a", { op: "o", result: 1, ts: "t" });
    lru.set("b", { op: "o", result: 2, ts: "t" });
    lru.get("a"); // refreshes a, so b is now the least recently used
    lru.set("c", { op: "o", result: 3, ts: "t" });
    assert.equal(lru.size, 2);
    assert.equal(lru.get("b"), undefined, "the least recently used entry must be evicted first");
    assert.equal(lru.get("a").result, 1);
    assert.equal(lru.get("c").result, 3);
  });
});

describe("idempotency keys", () => {
  const ctx = (over = {}) => ({ op: "obsidian_write_note", args: { path: "Notes/A.md" }, actor: ACTOR, ...over });

  test("a repeated key returns the first result without running the handler again", async () => {
    const { kernel, records } = fakeKernel();
    let runs = 0;
    const handler = async () => {
      runs++;
      return { content: [{ type: "text", text: `run ${runs}` }] };
    };

    const first = await kernel.runMutation(ctx({ idempotencyKey: "k1" }), handler);
    const second = await kernel.runMutation(ctx({ idempotencyKey: "k1" }), handler);

    assert.equal(runs, 1, "the handler ran twice — the retry was not collapsed");
    assert.equal(second, first, "the replay must be the very same result envelope");
    assert.equal(second.content[0].text, "run 1");

    await tick(0);
    const recs = records();
    assert.equal(recs.length, 2, "a replay is still journaled");
    assert.equal(recs[0].outcome, "ok");
    assert.equal(recs[1].outcome, "deduped");
    assert.equal(recs[1].dedupeOf, recs[0].ts, "the replay must name the record it replays");
    assert.equal(recs[1].idempotencyKey, "k1");
    assert.equal(recs[1].op, "obsidian_write_note");
    assert.deepEqual(recs[1].target, recs[0].target);
    assert.equal(recs[1].durationMs, 0, "nothing ran, so nothing took time");
  });

  test("a replay takes no queue slot", async () => {
    const { kernel } = fakeKernel();
    await kernel.runMutation(ctx({ idempotencyKey: "k2" }), async () => ({ content: [] }));

    const gate = deferred();
    const held = kernel.runMutation(ctx({ op: "obsidian_move_note", args: { path: "B.md" } }), () => gate.promise);
    // The queue is busy; a replay must answer anyway.
    const replay = await kernel.runMutation(ctx({ idempotencyKey: "k2" }), async () => assert.fail("ran"));
    assert.deepEqual(replay, { content: [] });
    assert.equal(kernel.queue.depth, 0, "the replay queued behind the in-flight write");

    gate.resolve({ content: [] });
    await held;
  });

  test("an expired key re-executes", async () => {
    let now = 1_000;
    const { kernel, records } = fakeKernel({ idempotency: new IdempotencyStore(50, 10, () => now) });
    let runs = 0;
    const handler = async () => ({ content: [{ type: "text", text: `run ${++runs}` }] });

    await kernel.runMutation(ctx({ idempotencyKey: "k3" }), handler);
    now += 50; // past the TTL
    const again = await kernel.runMutation(ctx({ idempotencyKey: "k3" }), handler);

    assert.equal(runs, 2, "an expired key must not replay");
    assert.equal(again.content[0].text, "run 2");
    await tick(0);
    assert.deepEqual(records().map((r) => r.outcome), ["ok", "ok"]);
  });

  test("reusing one key for a different operation is a typed error and runs nothing", async () => {
    const { kernel, records } = fakeKernel();
    await kernel.runMutation(ctx({ idempotencyKey: "k4" }), async () => ({ content: [] }));

    let ran = false;
    const err = await kernel
      .runMutation({ op: "obsidian_delete_note", args: { path: "Notes/A.md" }, actor: ACTOR, idempotencyKey: "k4" },
        async () => { ran = true; })
      .then(() => assert.fail("a key/op mismatch must not resolve"), (e) => e);

    assert.ok(err instanceof IdempotencyMismatchError);
    assert.equal(err.code, "idempotency_mismatch");
    assert.match(err.message, /obsidian_write_note/);
    assert.match(err.message, /obsidian_delete_note/);
    assert.equal(ran, false);

    await tick(0);
    const recs = records();
    assert.equal(recs.length, 2);
    assert.equal(recs[1].outcome, "error");
    assert.equal(recs[1].op, "obsidian_delete_note");
    assert.match(recs[1].error, /idempotency_key/);
  });

  test("a failure envelope is replayed too; a THROWN failure is never stored", async () => {
    const { kernel } = fakeKernel({ timeoutMs: 25 });
    let runs = 0;

    // Returned isError envelope: one logical request, one recorded outcome.
    const failed = await kernel.runMutation(ctx({ idempotencyKey: "k5" }), async () => {
      runs++;
      return { content: [{ type: "text", text: "Error: nope" }], isError: true };
    });
    const replayed = await kernel.runMutation(ctx({ idempotencyKey: "k5" }), async () => ({ content: [] }));
    assert.equal(runs, 1);
    assert.equal(replayed, failed);

    // A wedged (thrown) operation leaves the vault in an unknown state; the key
    // must stay free so a retry can actually retry.
    const wedged = deferred();
    await assert.rejects(kernel.runMutation(ctx({ idempotencyKey: "k6" }), () => wedged.promise), WriteTimeoutError);
    const retried = await kernel.runMutation(ctx({ idempotencyKey: "k6" }), async () => ({
      content: [{ type: "text", text: "retried" }],
    }));
    assert.equal(retried.content[0].text, "retried");
    wedged.resolve({ content: [] });
    await tick(5);
  });

  test("no key means no store entry — behavior is exactly as before", async () => {
    const { kernel, records } = fakeKernel();
    let runs = 0;
    const handler = async () => ({ content: [{ type: "text", text: `run ${++runs}` }] });
    await kernel.runMutation(ctx(), handler);
    await kernel.runMutation(ctx(), handler);
    assert.equal(runs, 2);
    assert.equal(kernel.idempotency.size, 0);
    await tick(0);
    assert.deepEqual(records().map((r) => r.outcome), ["ok", "ok"]);
    assert.equal(records()[0].idempotencyKey, undefined);
  });
});

// ── carried findings D4 / D5: probe failures ─────────────────────────────────

describe("probe failures", () => {
  test("D5: a throwing dequeue probe is journaled as a probe failure, not a vault failure", async () => {
    const { kernel, records } = fakeKernel({
      probe: {
        uid: () => { throw new Error("metadata cache exploded"); },
        rev: () => 100,
      },
    });
    let ran = false;

    const err = await kernel
      .runMutation({ op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR }, async () => { ran = true; })
      .then(() => assert.fail("a failed probe must not silently proceed"), (e) => e);

    assert.ok(err instanceof ProbeError);
    assert.equal(ran, false);
    await tick(0);
    const [rec] = records();
    assert.equal(rec.outcome, "error");
    assert.match(rec.error, /^probe: /, "a probe failure must not be misattributed to the vault operation");
    assert.match(rec.error, /metadata cache exploded/);
    assert.equal(rec.target.path, "A.md", "the record must still say what was targeted");
  });

  test("D4: a throwing revAfter probe cannot mask the result or lose the record", async () => {
    await quietly(async () => {
      let calls = 0;
      const { kernel, records } = fakeKernel({
        probe: {
          uid: () => "uid-a",
          // First call is revBefore (at dequeue); every later call is a revAfter
          // probe, on the finally path and on the late-settlement path.
          rev: () => { if (++calls > 1) throw new Error("file vanished mid-probe"); return 100; },
        },
      });

      const res = await kernel.runMutation(
        { op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR },
        async () => ({ content: [{ type: "text", text: "wrote" }] })
      );
      assert.equal(res.content[0].text, "wrote", "a throwing revAfter probe masked a successful result");

      await tick(0);
      const [rec] = records();
      assert.ok(rec, "the record was lost when the revAfter probe threw");
      assert.equal(rec.outcome, "ok");
      assert.equal(rec.revBefore, 100);
      assert.equal(rec.revAfter, undefined, "an unreadable revAfter is simply absent");
    });
  });

  test("D4: the same holds on the late-settlement path", async () => {
    await quietly(async () => {
      let calls = 0;
      const { kernel, records } = fakeKernel({
        timeoutMs: 25,
        probe: { uid: () => undefined, rev: () => { if (++calls > 1) throw new Error("gone"); return 100; } },
      });
      const wedged = deferred();
      await assert.rejects(
        kernel.runMutation({ op: "obsidian_move_note", args: { path: "A.md" }, actor: ACTOR }, () => wedged.promise),
        WriteTimeoutError
      );
      wedged.resolve({ content: [{ type: "text", text: "moved" }] });
      await tick(5);

      const recs = records();
      assert.equal(recs.length, 2, "the corrective record was lost when the revAfter probe threw");
      assert.equal(recs[1].outcome, "late-ok");
      assert.equal(recs[1].revAfter, undefined);
    });
  });
});

// ── makeGuarded: the kernel arguments on the tool surface ────────────────────

describe("kernel arguments (if_rev / idempotency_key)", () => {
  const RW_WITH_SCHEMA = {
    annotations: { readOnlyHint: false },
    inputSchema: { path: z.string() },
  };

  test("withKernelArgs declares both on mutating tools only", () => {
    const mutating = withKernelArgs(RW_WITH_SCHEMA);
    assert.deepEqual(Object.keys(mutating.inputSchema), ["path", ...KERNEL_ARG_KEYS]);
    assert.equal(RW_WITH_SCHEMA.inputSchema.if_rev, undefined, "the original def must not be mutated");

    const read = withKernelArgs({ annotations: { readOnlyHint: true }, inputSchema: { path: z.string() } });
    assert.deepEqual(Object.keys(read.inputSchema), ["path"], "a read tool gains nothing");

    // A tool that declares its own if_rev keeps it.
    const own = z.number().min(5);
    const custom = withKernelArgs({ annotations: { readOnlyHint: false }, inputSchema: { if_rev: own } });
    assert.equal(custom.inputSchema.if_rev, own);
  });

  test("declaration is what makes the arguments reachable at all", () => {
    // The SDK validates against the tool's zod shape, and z.object strips
    // unknown keys — so an UNdeclared if_rev never reaches the wrapper.
    const bare = z.object(RW_WITH_SCHEMA.inputSchema).parse({ path: "A.md", if_rev: 7 });
    assert.equal(bare.if_rev, undefined, "undeclared kernel args are stripped by validation");

    const declared = z.object(withKernelArgs(RW_WITH_SCHEMA).inputSchema).parse({
      path: "A.md",
      if_rev: 7,
      idempotency_key: "k",
    });
    assert.deepEqual(declared, { path: "A.md", if_rev: 7, idempotency_key: "k" });
    // Both stay optional: an existing client that sends neither is unaffected.
    assert.deepEqual(z.object(withKernelArgs(RW_WITH_SCHEMA).inputSchema).parse({ path: "A.md" }), { path: "A.md" });
  });

  test("the handler never sees the kernel arguments", async () => {
    const { kernel } = fakeKernel({ revs: new Map([["A.md", 100]]) });
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    let seen;
    await guarded(RW_DEF, async (args) => { seen = args; return { content: [] }; }, "obsidian_write_note")(
      { path: "A.md", content: "x", if_rev: 100, idempotency_key: "k7" },
      {}
    );
    assert.deepEqual(seen, { path: "A.md", content: "x" });

    // …and on the guard-only path too, so behavior does not depend on a kernel.
    const bare = makeGuarded({ getSettings: () => OPEN_SETTINGS, actor: () => ACTOR });
    let seenBare;
    await bare(RW_DEF, async (args) => { seenBare = args; return { content: [] }; }, "obsidian_write_note")(
      { path: "A.md", if_rev: 1, idempotency_key: "k" },
      {}
    );
    assert.deepEqual(seenBare, { path: "A.md" });
  });

  test("a conflict surfaces as a typed rev_conflict envelope naming both revisions", async () => {
    const { kernel, records } = fakeKernel({ revs: new Map([["A.md", 250]]) });
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    let ran = false;

    const res = await guarded(RW_DEF, async () => { ran = true; }, "obsidian_write_note")(
      { path: "A.md", if_rev: 100 },
      {}
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[rev_conflict\]/);
    assert.match(res.content[0].text, /rev 100/);
    assert.match(res.content[0].text, /rev 250/);
    assert.equal(ran, false);

    await tick(5);
    assert.equal(records()[0].outcome, "conflict");
    // The queue is free for the next caller.
    const next = await guarded(RW_DEF, async () => ({ content: [{ type: "text", text: "ok" }] }), "obsidian_write_note")(
      { path: "A.md" },
      {}
    );
    assert.equal(next.content[0].text, "ok");
  });

  test("a retry with the same key replays through the wrapper; a key/op mismatch is typed", async () => {
    const { kernel, records } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    let runs = 0;
    const write = guarded(RW_DEF, async () => ({ content: [{ type: "text", text: `run ${++runs}` }] }), "obsidian_write_note");

    const first = await write({ path: "A.md", idempotency_key: "k8" }, {});
    const second = await write({ path: "A.md", idempotency_key: "k8" }, {});
    assert.equal(runs, 1);
    assert.equal(second.content[0].text, "run 1");

    const other = await guarded(RW_DEF, async () => assert.fail("ran"), "obsidian_delete_note")(
      { path: "A.md", idempotency_key: "k8" },
      {}
    );
    assert.equal(other.isError, true);
    assert.match(other.content[0].text, /Error \[idempotency_mismatch\]/);

    await tick(5);
    const recs = records();
    assert.deepEqual(recs.map((r) => r.outcome), ["ok", "deduped", "error"]);
    assert.equal(recs[1].dedupeOf, recs[0].ts);
    assert.equal(first.content[0].text, "run 1");
  });
});
