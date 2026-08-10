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
  LockStore,
  LockCapError,
  holderOf,
  scopeCovers,
  scopesOverlap,
  LOCK_TTL_DEFAULT_MS,
  LOCK_TTL_MAX_MS,
  LOCK_TTL_MIN_MS,
  LOCK_MAX,
  LOCK_MAX_PER_HOLDER,
  loadInstallId,
  mintInstallId,
  INSTALL_ID_FILE,
} from "../src/kernel/index.ts";
import { makeGuarded, withKernelArgs, KERNEL_ARG_KEYS } from "../src/mcp/guarded.ts";
import { registerLockTools } from "../src/mcp/tools-locks.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Drains pending microtasks (promise .then chains) without touching the
// (possibly mocked) timer queue — for tests that need the write-queue's
// internal Promise.resolve().then(...).then(...) chain to settle without
// racing real wall-clock time.
async function flushMicrotasks(turns = 10) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

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

  test("an abandoned operation settling later cannot double-release the queue", async (t) => {
    // Real-timer version of this test raced the queue's OWN 20ms timeout: the
    // second operation ("held") is subject to the same fixed timeout as the
    // first, so pacing the test with real setTimeout ticks (tick(5) x3 = 15ms
    // of intended wall clock) could — under load, when the event loop lags —
    // let more than 20ms of *actual* wall clock pass before the test resolves
    // `gate`, tripping "held"'s own timeout and invalidating the assertions
    // that follow. Mocking setTimeout removes wall clock from the picture
    // entirely: the queue's 20ms timer only fires when the test explicitly
    // advances the clock, so "held" cannot time out behind the test's back no
    // matter how slow or contended the machine running it is.
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const queue = new WriteQueue(20);
    const wedged = deferred();
    const stuck = queue.run("stuck", () => wedged.promise);
    t.mock.timers.tick(20); // fires the queue's own timeout, abandoning "stuck"
    await assert.rejects(stuck, WriteTimeoutError);

    const gate = deferred();
    const held = queue.run("held", () => gate.promise);
    // The abandoned operation finishes now — it must not free the slot the
    // next operation is holding. No clock advance happens here, so "held"
    // cannot time out itself while the test inspects the queue.
    wedged.resolve("late");
    await flushMicrotasks();
    let jumperRan = false;
    const jumper = queue.run("jumper", async () => { jumperRan = true; });
    await flushMicrotasks();
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

function fakeKernel({ timeoutMs = 1000, revs = new Map(), uids = new Map(), probe, idempotency, locks } = {}) {
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
  const p = probe ?? { uid: (path) => uids.get(path), rev: (path) => revs.get(path) };
  const kernel = new Kernel(
    new WriteQueue(timeoutMs),
    journal,
    p,
    idempotency ?? new IdempotencyStore(),
    locks ?? new LockStore()
  );
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

  test("on a move, the checked target is the SOURCE — pinned against schema reordering", async () => {
    // obsidian_move_note declares `from` before `to`, and collectPaths walks the
    // argument object in declaration order, so `from` is the primary target.
    // That is what if_rev must compare: the note whose content the caller read.
    // If the schema (or PATH_KEYS) is ever reordered so `to` comes first, this
    // fails rather than quietly checking the destination's revision.
    const revs = new Map([["Src.md", 100], ["Dst.md", 900]]);
    const { kernel, records } = fakeKernel({ revs });
    const args = { from: "Src.md", to: "Dst.md", update_backlinks: true };

    // The destination's revision must NOT be what is compared.
    const err = await kernel
      .runMutation({ op: "obsidian_move_note", args, actor: ACTOR, ifRev: 900 }, async () => assert.fail("ran"))
      .then(() => assert.fail("if_rev matched the destination, not the source"), (e) => e);
    assert.ok(err instanceof RevConflictError);
    assert.equal(err.path, "Src.md", "the conflict must name the source path");
    assert.equal(err.expected, 900);
    assert.equal(err.actual, 100, "the revision compared must be the SOURCE's");

    // …and the source's revision does pass.
    let ran = false;
    await kernel.runMutation({ op: "obsidian_move_note", args, actor: ACTOR, ifRev: 100 }, async () => {
      ran = true;
      return { content: [] };
    });
    assert.equal(ran, true);

    await tick(5);
    const recs = records();
    assert.equal(recs[0].target.path, "Src.md", "the journal's primary target is the source");
    assert.deepEqual(recs[0].target.paths, ["Src.md", "Dst.md"], "declaration order: source first");
    assert.equal(recs[0].revBefore, 100);
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

  // ── HIGH-1: concurrent in-flight retries ───────────────────────────────────

  test("N simultaneous calls with one key run the handler exactly once", async () => {
    // The defect this pins: with the store written only on completion, four
    // simultaneous retries of one dropped request all miss the lookup and all
    // write. The key must be RESERVED at entry, not on the way out.
    const { kernel, records } = fakeKernel();
    let runs = 0;
    const gate = deferred();
    const handler = async () => {
      runs++;
      await gate.promise;
      return { content: [{ type: "text", text: `run ${runs}` }] };
    };

    const calls = [0, 1, 2, 3].map(() => kernel.runMutation(ctx({ idempotencyKey: "kc1" }), handler));
    await tick(5);
    assert.equal(runs, 1, "more than one simultaneous retry executed");
    assert.equal(kernel.idempotency.inFlight, 1, "the key must be reserved while in flight");

    gate.resolve();
    const results = await Promise.all(calls);
    assert.equal(runs, 1, "a waiter re-ran the handler after the winner finished");
    for (const r of results) {
      assert.equal(r, results[0], "every retry must get the SAME envelope the winner produced");
      assert.equal(r.content[0].text, "run 1");
    }
    assert.equal(kernel.idempotency.inFlight, 0, "the reservation must be released once it settles");

    await tick(5);
    const recs = records();
    assert.equal(recs.length, 4);
    assert.deepEqual(recs.map((r) => r.outcome), ["ok", "deduped", "deduped", "deduped"]);
    for (const r of recs.slice(1)) {
      assert.equal(r.dedupeOf, recs[0].ts, "a waiter must name the winner's record");
      assert.equal(r.idempotencyKey, "kc1");
      assert.equal(r.durationMs, 0, "nothing ran for a waiter");
      assert.equal(r.op, recs[0].op);
    }
    // Only one operation ever reached the queue.
    assert.equal(kernel.queue.depth, 0);
    assert.equal(kernel.queue.running, false);
  });

  test("waiters share a THROWN outcome, and only afterwards is the key free", async () => {
    const { kernel, records } = fakeKernel({ timeoutMs: 25 });
    const wedged = deferred();
    let runs = 0;
    const handler = () => { runs++; return wedged.promise; };

    const calls = [0, 1, 2, 3].map(() =>
      kernel.runMutation(ctx({ idempotencyKey: "kc2" }), handler).then(
        () => assert.fail("a shared failure must not resolve"),
        (e) => e
      )
    );
    const errors = await Promise.all(calls);
    assert.equal(runs, 1, "only the winner may execute");
    for (const e of errors) {
      assert.ok(e instanceof WriteTimeoutError, "every waiter must get the winner's failure");
      assert.equal(e, errors[0], "one logical request, one outcome — the very same error object");
    }

    await tick(5);
    const recs = records();
    assert.deepEqual(recs.map((r) => r.outcome), ["error", "deduped", "deduped", "deduped"]);
    assert.match(recs[0].error, /write-queue timeout/);
    for (const r of recs.slice(1)) {
      assert.equal(r.dedupeOf, recs[0].ts);
      assert.match(r.error, /write-queue timeout/, "a deduped failure must not look like a clean replay");
    }

    // …and NOW the key is free: the thrown failure stored nothing, so a fresh
    // call with the same key genuinely retries.
    assert.equal(kernel.idempotency.inFlight, 0);
    assert.equal(kernel.idempotency.size, 0, "a thrown failure must store nothing");
    const retried = await kernel.runMutation(ctx({ idempotencyKey: "kc2" }), async () => ({
      content: [{ type: "text", text: "retried" }],
    }));
    assert.equal(retried.content[0].text, "retried");
    wedged.resolve({ content: [] });
    await tick(5);
  });

  // ── MEDIUM-1: key identity includes the arguments ──────────────────────────

  test("a stored key presented with DIFFERENT arguments is a typed mismatch, not a replay", async () => {
    const { kernel, records } = fakeKernel();
    await kernel.runMutation(ctx({ idempotencyKey: "kd1", args: { path: "A.md", content: "one" } }), async () => ({
      content: [{ type: "text", text: "wrote A" }],
    }));

    let ran = false;
    const err = await kernel
      .runMutation(ctx({ idempotencyKey: "kd1", args: { path: "B.md", content: "one" } }), async () => { ran = true; })
      .then(() => assert.fail("a divergent-args replay must not resolve"), (e) => e);

    assert.ok(err instanceof IdempotencyMismatchError);
    assert.equal(err.code, "idempotency_mismatch");
    assert.equal(err.reason, "args");
    assert.match(err.message, /DIFFERENT arguments/);
    assert.equal(ran, false, "the write must not run — but it must not be silently discarded either");

    await tick(5);
    const recs = records();
    assert.deepEqual(recs.map((r) => r.outcome), ["ok", "error"]);
    assert.match(recs[1].error, /idempotency_key/);
  });

  test("argument divergence is caught below the digest, where bodies are collapsed", async () => {
    // digestArgs renders any `content` as `<N chars>`, so two DIFFERENT bodies
    // of equal length share a digest. Key identity must still separate them —
    // otherwise the second write is discarded and reported as success.
    const { kernel } = fakeKernel();
    const write = (body) =>
      kernel.runMutation(ctx({ idempotencyKey: "kd2", args: { path: "A.md", content: body } }), async () => ({
        content: [{ type: "text", text: `wrote ${body}` }],
      }));

    assert.equal((await write("aaaa")).content[0].text, "wrote aaaa");
    const err = await write("bbbb").then(() => assert.fail("equal-length bodies replayed"), (e) => e);
    assert.ok(err instanceof IdempotencyMismatchError);
    assert.equal(err.reason, "args");
    // The same body still replays — the fingerprint is stable, not merely picky.
    assert.equal((await write("aaaa")).content[0].text, "wrote aaaa");
  });

  test("argument key ORDER is not divergence: a re-serialized retry still replays", async () => {
    const { kernel } = fakeKernel();
    let runs = 0;
    const handler = async () => ({ content: [{ type: "text", text: `run ${++runs}` }] });
    await kernel.runMutation(ctx({ idempotencyKey: "kd3", args: { path: "A.md", overwrite: true } }), handler);
    const replay = await kernel.runMutation(
      ctx({ idempotencyKey: "kd3", args: { overwrite: true, path: "A.md" } }),
      handler
    );
    assert.equal(runs, 1, "key order must not look like divergent arguments");
    assert.equal(replay.content[0].text, "run 1");
  });

  test("an IN-FLIGHT key presented with different arguments (or a different op) is a mismatch", async () => {
    const { kernel } = fakeKernel();
    const gate = deferred();
    const held = kernel.runMutation(ctx({ idempotencyKey: "kd4", args: { path: "A.md" } }), () => gate.promise);
    await tick(0);

    const argsErr = await kernel
      .runMutation(ctx({ idempotencyKey: "kd4", args: { path: "B.md" } }), async () => assert.fail("ran"))
      .then(() => assert.fail("a divergent-args waiter must not attach"), (e) => e);
    assert.ok(argsErr instanceof IdempotencyMismatchError);
    assert.equal(argsErr.reason, "args");

    const opErr = await kernel
      .runMutation(ctx({ op: "obsidian_delete_note", idempotencyKey: "kd4", args: { path: "A.md" } }), async () =>
        assert.fail("ran"))
      .then(() => assert.fail("a divergent-op waiter must not attach"), (e) => e);
    assert.ok(opErr instanceof IdempotencyMismatchError);
    assert.equal(opErr.reason, "op");
    assert.match(opErr.message, /obsidian_write_note/);

    gate.resolve({ content: [] });
    await held;
  });

  // ── MEDIUM-2: a replay never evaluated the precondition ────────────────────

  test("a deduped record carries no ifRev — the precondition was never evaluated", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs });
    await kernel.runMutation(ctx({ idempotencyKey: "ke1", ifRev: 100 }), async () => ({ content: [] }));
    await kernel.runMutation(ctx({ idempotencyKey: "ke1", ifRev: 100 }), async () => assert.fail("ran"));

    await tick(5);
    const [original, replay] = records();
    assert.equal(original.ifRev, 100, "the call that actually dequeued still records its precondition");
    assert.equal(replay.outcome, "deduped");
    assert.equal(replay.ifRev, undefined, "a replay never reached the dequeue check; the field must be absent");
    assert.equal(replay.idempotencyKey, "ke1", "the argument that produced the record is still recorded");
    assert.equal(replay.dedupeOf, original.ts);
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

    // …and on the guard-only path too: the arguments are peeled off there as
    // well, so a handler's contract never depends on whether a kernel exists.
    // (`if_rev` is not passed here — without a kernel it is refused outright,
    // which the LOW-2 test below pins.)
    const bare = makeGuarded({ getSettings: () => OPEN_SETTINGS, actor: () => ACTOR });
    let seenBare;
    await bare(RW_DEF, async (args) => { seenBare = args; return { content: [] }; }, "obsidian_write_note")(
      { path: "A.md", idempotency_key: "k" },
      {}
    );
    assert.deepEqual(seenBare, { path: "A.md" });
  });

  // ── LOW-2: an unenforceable precondition fails closed ──────────────────────

  test("without a kernel, if_rev is refused rather than silently ignored", async () => {
    const bare = makeGuarded({ getSettings: () => OPEN_SETTINGS, actor: () => ACTOR });
    let ran = false;
    const write = bare(RW_DEF, async () => { ran = true; return { content: [{ type: "text", text: "wrote" }] }; },
      "obsidian_write_note");

    const res = await write({ path: "A.md", if_rev: 100 }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[precondition_unsupported\]/);
    assert.match(res.content[0].text, /obsidian_write_note/);
    assert.equal(ran, false, "an unenforceable if_rev must not fall through to an unconditional write");

    // Scoped to calls that actually carry if_rev: everything else is untouched.
    assert.equal((await write({ path: "A.md" }, {})).content[0].text, "wrote");
    assert.equal((await write({ path: "A.md", idempotency_key: "k" }, {})).content[0].text, "wrote");
    // …and a READ carrying if_rev is nonsense but harmless — no write to guard.
    const read = bare(RO_DEF, async () => ({ content: [{ type: "text", text: "read" }] }), "obsidian_read_note");
    assert.equal((await read({ path: "A.md", if_rev: 100 }, {})).content[0].text, "read");
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

// ── MEDIUM-A: kernel arguments are part of a key's identity ──────────────────
//
// The builder ruling: a keyed call presented with a DIFFERENT `if_rev` than the
// original — including present-vs-absent in either direction — is an
// idempotency_mismatch (reason "if_rev"), never a silent replay. The precondition
// is half of what the caller asked for; replaying across it would report that a
// condition held which was never evaluated.

describe("MEDIUM-A: if_rev is part of the idempotency key's identity", () => {
  const ctx = (over = {}) => ({ op: "obsidian_write_note", args: { path: "Notes/A.md" }, actor: ACTOR, ...over });

  test("a replay with the SAME if_rev still replays", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs });
    let runs = 0;
    const handler = async () => ({ content: [{ type: "text", text: `run ${++runs}` }] });

    const first = await kernel.runMutation(ctx({ idempotencyKey: "ma1", ifRev: 100 }), handler);
    const second = await kernel.runMutation(ctx({ idempotencyKey: "ma1", ifRev: 100 }), handler);
    assert.equal(runs, 1, "an identical keyed retry must not re-execute");
    assert.equal(second, first);

    await tick(5);
    assert.deepEqual(records().map((r) => r.outcome), ["ok", "deduped"]);
  });

  test("a completed key presented with a DIFFERENT if_rev is a mismatch naming both revisions", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel, records } = fakeKernel({ revs });
    await kernel.runMutation(ctx({ idempotencyKey: "ma2", ifRev: 100 }), async () => ({ content: [] }));

    let ran = false;
    const err = await kernel
      .runMutation(ctx({ idempotencyKey: "ma2", ifRev: 200 }), async () => { ran = true; })
      .then(() => assert.fail("a divergent-precondition replay must not resolve"), (e) => e);

    assert.ok(err instanceof IdempotencyMismatchError);
    assert.equal(err.code, "idempotency_mismatch");
    assert.equal(err.reason, "if_rev");
    assert.equal(err.firstIfRev, 100);
    assert.equal(err.ifRev, 200);
    assert.match(err.message, /if_rev 100/);
    assert.match(err.message, /if_rev 200/);
    assert.equal(ran, false);

    await tick(5);
    const recs = records();
    assert.deepEqual(recs.map((r) => r.outcome), ["ok", "error"]);
    assert.match(recs[1].error, /idempotency_key/, "a mismatch is journaled terminally, like any other");
    assert.equal(recs[1].idempotencyKey, "ma2");
  });

  test("present-vs-absent counts, in BOTH directions", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel } = fakeKernel({ revs });

    // first with a precondition, retried without
    await kernel.runMutation(ctx({ idempotencyKey: "ma3", ifRev: 100 }), async () => ({ content: [] }));
    const dropped = await kernel
      .runMutation(ctx({ idempotencyKey: "ma3" }), async () => assert.fail("ran"))
      .then(() => assert.fail("dropping if_rev must not replay"), (e) => e);
    assert.equal(dropped.reason, "if_rev");
    assert.equal(dropped.firstIfRev, 100);
    assert.equal(dropped.ifRev, undefined);
    assert.match(dropped.message, /no if_rev/);

    // first WITHOUT a precondition, retried with one
    await kernel.runMutation(ctx({ idempotencyKey: "ma4" }), async () => ({ content: [] }));
    const added = await kernel
      .runMutation(ctx({ idempotencyKey: "ma4", ifRev: 100 }), async () => assert.fail("ran"))
      .then(() => assert.fail("adding if_rev must not replay"), (e) => e);
    assert.equal(added.reason, "if_rev");
    assert.equal(added.firstIfRev, undefined);
    assert.equal(added.ifRev, 100);
  });

  test("an IN-FLIGHT key presented with a different if_rev is a mismatch, not a waiter", async () => {
    const revs = new Map([["Notes/A.md", 100]]);
    const { kernel } = fakeKernel({ revs });
    const gate = deferred();
    const held = kernel.runMutation(ctx({ idempotencyKey: "ma5", ifRev: 100 }), () => gate.promise);
    await tick(0);

    const err = await kernel
      .runMutation(ctx({ idempotencyKey: "ma5", ifRev: 101 }), async () => assert.fail("ran"))
      .then(() => assert.fail("a divergent-precondition waiter must not attach"), (e) => e);
    assert.ok(err instanceof IdempotencyMismatchError);
    assert.equal(err.reason, "if_rev");

    gate.resolve({ content: [] });
    await held;
  });

  test("the mismatch surfaces through the tool wrapper as a typed envelope", async () => {
    const { kernel } = fakeKernel({ revs: new Map([["A.md", 100]]) });
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const write = guarded(RW_DEF, async () => ({ content: [{ type: "text", text: "wrote" }] }), "obsidian_write_note");

    assert.equal((await write({ path: "A.md", if_rev: 100, idempotency_key: "ma6" }, {})).content[0].text, "wrote");
    const res = await write({ path: "A.md", if_rev: 999, idempotency_key: "ma6" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[idempotency_mismatch\]/);
    assert.match(res.content[0].text, /if_rev/);
  });
});

// ── LOW-B: a stale settle cannot overwrite a newer entry ─────────────────────

describe("LOW-B: settle is guarded by reservation identity", () => {
  test("a stale second settle cannot overwrite the entry a later call stored", async () => {
    const store = new IdempotencyStore();
    // First owner: settles with a THROW, which stores nothing and frees the key.
    const first = store.claim("sk", "obsidian_write_note", "args-1");
    assert.equal(first.kind, "owner");
    first.settle({ ok: false, error: new Error("boom"), ts: "t1" });
    assert.equal(store.size, 0, "a thrown failure must store nothing");

    // Second owner claims the freed key and completes normally.
    const second = store.claim("sk", "obsidian_write_note", "args-1");
    assert.equal(second.kind, "owner");
    second.settle({ ok: true, result: { content: [{ type: "text", text: "newer" }] }, ts: "t2" });
    assert.equal(store.get("sk").ts, "t2");

    // The first owner settles AGAIN (a double-settle bug, or a late unwind).
    // Its reservation is long gone, so it must not clobber the newer entry.
    first.settle({ ok: true, result: { content: [{ type: "text", text: "stale" }] }, ts: "t1" });
    const stored = store.get("sk");
    assert.equal(stored.ts, "t2", "a stale settle overwrote a newer entry");
    assert.equal(stored.result.content[0].text, "newer");
  });

  test("a stale settle does not evict the live reservation of a later call", async () => {
    const store = new IdempotencyStore();
    const first = store.claim("sk2", "obsidian_write_note", "a");
    first.settle({ ok: false, error: new Error("x"), ts: "t1" });
    const second = store.claim("sk2", "obsidian_write_note", "a");
    assert.equal(second.kind, "owner");
    assert.equal(store.inFlight, 1);
    first.settle({ ok: false, error: new Error("x again"), ts: "t1" });
    assert.equal(store.inFlight, 1, "a stale settle released someone else's reservation");
    second.settle({ ok: true, result: { content: [] }, ts: "t2" });
    assert.equal(store.inFlight, 0);
  });
});

// ── advisory locks: the store ────────────────────────────────────────────────

describe("LockStore lifecycle", () => {
  // A hand-driven clock: lazy expiry is the only expiry there is, so every
  // expiry assertion here is really an assertion about what the NEXT call sees.
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
  }

  test("claim → list → renew → release, with holder, reason and expiry", () => {
    const c = clock();
    const locks = new LockStore(c.now);
    const { lock, overlapping } = locks.claim({ scope: "Projects/Alpha", holder: "h1", reason: "refactor" });

    assert.equal(lock.scope, "Projects/Alpha");
    assert.equal(lock.holder, "h1");
    assert.equal(lock.reason, "refactor");
    assert.equal(lock.expiresAt - lock.claimedAt, LOCK_TTL_DEFAULT_MS, "default TTL is 5 minutes");
    assert.deepEqual(overlapping, [], "nothing else is claimed");
    assert.deepEqual(locks.list().map((l) => l.id), [lock.id]);

    c.advance(4 * 60_000);
    const renewed = locks.renew(lock.id, 60_000, "h1");
    assert.equal(renewed.id, lock.id);
    assert.equal(renewed.expiresAt, c.now() + 60_000, "renewing restarts the clock");

    assert.equal(locks.release(lock.id, "h1").id, lock.id);
    assert.deepEqual(locks.list(), []);
    assert.equal(locks.release(lock.id, "h1"), undefined, "releasing twice is a miss, not an error");
  });

  test("expiry is lazy: an expired claim is gone the next time anyone looks", () => {
    const c = clock();
    const locks = new LockStore(c.now);
    const { lock } = locks.claim({ scope: "Notes", holder: "h1", reason: "tidying", ttlMs: 60_000 });
    assert.equal(locks.list().length, 1);

    c.advance(59_999);
    assert.equal(locks.list().length, 1, "still live one millisecond short of the TTL");

    c.advance(1);
    assert.deepEqual(locks.list(), [], "the claim vanished without a timer");
    assert.equal(locks.size, 0);
    assert.equal(locks.renew(lock.id, 60_000, "h1"), undefined, "an expired claim cannot be renewed");
    assert.equal(locks.release(lock.id, "h1"), undefined);
  });

  test("TTL is clamped to the 30-minute ceiling and the 1-second floor", () => {
    const c = clock();
    const locks = new LockStore(c.now);
    const long = locks.claim({ scope: "A", holder: "h", reason: "r", ttlMs: 24 * 60 * 60_000 }).lock;
    assert.equal(long.expiresAt - long.claimedAt, LOCK_TTL_MAX_MS);
    const short = locks.claim({ scope: "B", holder: "h", reason: "r", ttlMs: 0 }).lock;
    assert.equal(short.expiresAt - short.claimedAt, LOCK_TTL_MIN_MS);
  });

  test("renew and release act on your OWN claim; another holder's is a miss", () => {
    const c = clock();
    const locks = new LockStore(c.now);
    const { lock } = locks.claim({ scope: "Shared", holder: "h1", reason: "mine" });
    assert.equal(locks.renew(lock.id, 60_000, "h2"), undefined, "renewing another holder's claim");
    assert.equal(locks.release(lock.id, "h2"), undefined, "releasing another holder's claim");
    assert.equal(locks.list().length, 1, "the claim survived the foreign attempts");
    assert.equal(locks.release(lock.id, "h1").holder, "h1");
  });

  test("scopes normalize, and a scope escaping the vault root is refused", () => {
    const locks = new LockStore();
    assert.equal(locks.claim({ scope: "/Projects/Alpha/", holder: "h", reason: "r" }).lock.scope, "Projects/Alpha");
    assert.equal(locks.claim({ scope: "Projects/./Beta", holder: "h", reason: "r" }).lock.scope, "Projects/Beta");
    assert.equal(locks.claim({ scope: "", holder: "h", reason: "r" }).lock.scope, "", "empty = whole vault");
    assert.equal(locks.claim({ scope: ".", holder: "h", reason: "r" }).lock.scope, "");
    assert.throws(() => locks.claim({ scope: "../elsewhere", holder: "h", reason: "r" }), TypeError);
  });

  test("scope matching is per path segment, never a bare string prefix", () => {
    assert.equal(scopeCovers("Projects", "Projects/Alpha/a.md"), true);
    assert.equal(scopeCovers("Projects", "Projects"), true);
    assert.equal(scopeCovers("Projects", "Projects-Archive/a.md"), false, "'Projects' must not cover 'Projects-Archive'");
    assert.equal(scopeCovers("", "anything/at/all.md"), true, "the empty scope is the whole vault");
    assert.equal(scopesOverlap("Projects", "Projects/Alpha/a.md"), true);
    assert.equal(scopesOverlap("Projects/Alpha/a.md", "Projects"), true, "overlap is symmetric");
    assert.equal(scopesOverlap("Projects/Alpha", "Projects/Beta"), false);
  });
});

// D1: the cap used to EVICT the globally oldest claim to make room. A client
// claiming in a loop could therefore silently destroy every other session's
// live claims — the disclosure mechanism quietly deleting the disclosures.
describe("D1: the claim cap refuses, and never evicts another holder's claim", () => {
  test("200+ claims by holder A cannot remove holder B's claim", () => {
    const locks = new LockStore(() => 1_000_000, 200, 1000);
    const b = locks.claim({ scope: "Bravo/work.md", holder: "B", reason: "B is working here" }).lock;

    let refusals = 0;
    for (let i = 0; i < 400; i++) {
      // Distinct scopes, so nothing is a same-scope replacement: this is the
      // flood the old eviction loop turned into a weapon.
      try {
        locks.claim({ scope: `Alpha/${i}.md`, holder: "A", reason: "flooding" });
      } catch (e) {
        assert.ok(e instanceof LockCapError, "the refusal is typed");
        refusals++;
      }
    }

    assert.ok(refusals > 0, "the cap was reached and refused");
    const survivor = locks.list().find((l) => l.id === b.id);
    assert.ok(survivor, "B's claim survived 400 claims by A — no claim is taken to make room for another's");
    assert.equal(survivor.reason, "B is working here");
    assert.equal(locks.list().length, 200, "the store never grew past its cap either");
  });

  test("the refusal names the cap it hit, and nothing was claimed", () => {
    const locks = new LockStore(() => 1_000_000, 3, 1000);
    for (let i = 0; i < 3; i++) locks.claim({ scope: `S${i}`, holder: "h", reason: "r" });
    assert.throws(
      () => locks.claim({ scope: "S3", holder: "h", reason: "r" }),
      (e) => e instanceof LockCapError && e.kind === "store" && e.cap === 3 && /already holds 3 live advisory claims/.test(e.message)
    );
    assert.equal(locks.size, 3, "a refused claim adds nothing");
  });

  test("the per-holder cap bounds ONE holder, leaving room for the next one", () => {
    const locks = new LockStore(() => 1_000_000, 200, 2);
    locks.claim({ scope: "A/1", holder: "flooder", reason: "r" });
    locks.claim({ scope: "A/2", holder: "flooder", reason: "r" });
    assert.throws(
      () => locks.claim({ scope: "A/3", holder: "flooder", reason: "r" }),
      (e) => e instanceof LockCapError && e.kind === "holder" && e.cap === 2
    );
    // …and everyone else still has room, which is the point of a per-holder cap.
    assert.equal(locks.claim({ scope: "B/1", holder: "someone-else", reason: "r" }).lock.holder, "someone-else");
  });

  // D-C: the per-holder cap does NOT make the store un-exhaustible. A holder is
  // `client#connection`, connections are free, and 4 × 50 = 200 — so a
  // multi-connection client can fill the store and a bystander is refused. The
  // honest property is TTL-bounded self-healing, and the refusal says so.
  test("D-C: a multi-CONNECTION client can still fill the store, and the refusal is honest about it", () => {
    const now = 1_000_000;
    const locks = new LockStore(() => now, LOCK_MAX, LOCK_MAX_PER_HOLDER);
    for (let conn = 0; conn < LOCK_MAX / LOCK_MAX_PER_HOLDER; conn++) {
      for (let i = 0; i < LOCK_MAX_PER_HOLDER; i++) {
        locks.claim({ scope: `Flood/${conn}/${i}.md`, holder: `one-client#conn-${conn}`, reason: "flooding" });
      }
    }
    assert.equal(locks.size, LOCK_MAX, "one client, four connections, the whole store");

    let refusal;
    try {
      locks.claim({ scope: "Bystander/a.md", holder: "bystander#conn-x", reason: "ordinary work" });
    } catch (e) {
      refusal = e;
    }
    assert.ok(refusal instanceof LockCapError && refusal.kind === "store", "the bystander is refused");
    assert.match(
      refusal.message,
      /expire/,
      "a denied bystander is told recovery is bounded — every claim is TTL-bounded, so the store self-heals"
    );
  });

  test("D-C: …and the store recovers on its own once those claims expire", () => {
    let now = 1_000_000;
    const locks = new LockStore(() => now, 2, 2);
    locks.claim({ scope: "A/1", holder: "flooder#1", reason: "r", ttlMs: 60_000 });
    locks.claim({ scope: "A/2", holder: "flooder#1", reason: "r", ttlMs: 60_000 });
    assert.throws(() => locks.claim({ scope: "B/1", holder: "bystander#1", reason: "r" }), LockCapError);

    now += 60_001; // no timer, no sweep: the next call prunes them
    assert.equal(locks.claim({ scope: "B/1", holder: "bystander#1", reason: "r" }).lock.scope, "B/1");
  });

  test("re-claiming your own scope at the cap is a replacement, so it is allowed", () => {
    const locks = new LockStore(() => 1_000_000, 200, 2);
    const first = locks.claim({ scope: "A/1", holder: "h", reason: "r1" }).lock;
    locks.claim({ scope: "A/2", holder: "h", reason: "r2" });
    const again = locks.claim({ scope: "A/1", holder: "h", reason: "restated" });
    assert.equal(again.replaced, true);
    assert.equal(again.lock.id, first.id);
    assert.equal(locks.size, 2, "a replacement never grows the store, so a cap cannot block a renewal");
  });

  test("the documented caps", () => {
    assert.equal(LOCK_MAX, 200);
    assert.equal(LOCK_MAX_PER_HOLDER, 50);
  });
});

describe("LockStore overlap disclosure", () => {
  test("a foreign overlapping claim is allowed AND disclosed to the claimer", () => {
    const locks = new LockStore();
    const first = locks.claim({ scope: "Projects", holder: "h1", reason: "restructuring" }).lock;

    const { lock, overlapping } = locks.claim({ scope: "Projects/Alpha", holder: "h2", reason: "editing" });
    assert.equal(lock.holder, "h2", "the overlapping claim stands rather than being refused — advisory means advisory");
    assert.equal(locks.list().length, 2, "both claims are live at once");
    assert.deepEqual(overlapping.map((l) => l.id), [first.id]);
    assert.equal(overlapping[0].holder, "h1");
    assert.equal(overlapping[0].reason, "restructuring", "the claimer learns WHY, not just that");
  });

  test("your own overlapping claims are not disclosed back to you", () => {
    const locks = new LockStore();
    locks.claim({ scope: "Projects", holder: "h1", reason: "first pass" });
    const { overlapping } = locks.claim({ scope: "Projects/Alpha", holder: "h1", reason: "second pass" });
    assert.deepEqual(overlapping, [], "re-claiming inside your own scope is not a conflict with yourself");
  });

  test("disjoint and expired claims are not disclosed", () => {
    let t = 1_000_000;
    const locks = new LockStore(() => t);
    locks.claim({ scope: "Archive", holder: "h1", reason: "unrelated" });
    locks.claim({ scope: "Projects", holder: "h2", reason: "expiring", ttlMs: 60_000 });
    t += 60_001;
    const { overlapping } = locks.claim({ scope: "Projects/Alpha", holder: "h3", reason: "later" });
    assert.deepEqual(overlapping, [], "an expired claim overlaps nothing");
  });

  test("covering() returns foreign claims most-specific first, and never your own", () => {
    const locks = new LockStore();
    locks.claim({ scope: "", holder: "h1", reason: "whole vault" });
    locks.claim({ scope: "Projects/Alpha", holder: "h2", reason: "specific" });
    locks.claim({ scope: "Projects", holder: "h3", reason: "middling" });
    locks.claim({ scope: "Projects/Alpha", holder: "me", reason: "my own work" });

    const covering = locks.covering("Projects/Alpha/a.md", "me");
    assert.deepEqual(covering.map((l) => l.reason), ["specific", "middling", "whole vault"]);
    assert.deepEqual(locks.covering("Elsewhere/x.md", "me").map((l) => l.reason), ["whole vault"]);
  });

  // D3: a move names a `from` and a `to`. Consulting only the primary target
  // made the ARRIVING half of every move invisible — you could move a note into
  // somebody's claimed scope and never be told you had.
  test("D3: coveringAny consults every path, so a move INTO a claimed scope is noticed", () => {
    const locks = new LockStore();
    locks.claim({ scope: "Projects/Alpha", holder: "h1", reason: "restructuring" });

    const movingIn = locks.coveringAny(["Inbox/note.md", "Projects/Alpha/note.md"], "me");
    assert.deepEqual(movingIn.map((l) => l.reason), ["restructuring"], "the destination is inside the claim");
    const movingOut = locks.coveringAny(["Projects/Alpha/note.md", "Inbox/note.md"], "me");
    assert.deepEqual(movingOut.map((l) => l.reason), ["restructuring"], "…and so is the source, symmetrically");
    assert.deepEqual(locks.coveringAny(["Inbox/a.md", "Inbox/b.md"], "me"), [], "a move touching neither is untouched");
  });

  test("D3: one lock covering many of the paths is disclosed ONCE", () => {
    const locks = new LockStore();
    locks.claim({ scope: "Projects", holder: "h1", reason: "sweeping" });
    const batch = Array.from({ length: 50 }, (_, i) => `Projects/n${i}.md`);
    assert.equal(locks.coveringAny(batch, "me").length, 1, "50 paths under one claim is one notice, not 50");
  });

  test("holderOf derives a stable per-connection identity from the journal actor", () => {
    assert.equal(holderOf({ transport: "mcp", client: "claude-code/1.0.0", connection: "c1" }), "claude-code/1.0.0#c1");
    assert.equal(holderOf({ transport: "mcp", connection: "c1" }), "c1", "an anonymous client is still a holder");
  });
});

// ── advisory notices on writes ───────────────────────────────────────────────

describe("advisory lock notices", () => {
  const OTHER = { transport: "mcp", client: "other-agent/2.0", connection: "conn-other" };
  const ctx = (over = {}) => ({ op: "obsidian_write_note", args: { path: "Projects/Alpha/a.md" }, actor: ACTOR, ...over });
  const okEnvelope = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

  test("a write inside a FOREIGN claim proceeds, and the envelope says whose", async () => {
    const { kernel, records } = fakeKernel();
    kernel.locks.claim({ scope: "Projects/Alpha", holder: holderOf(OTHER), reason: "restructuring", ttlMs: 120_000 });

    let ran = false;
    const res = await kernel.runMutation(ctx(), async () => {
      ran = true;
      return okEnvelope({ written: true });
    });

    assert.equal(ran, true, "an advisory claim must NEVER block the operation");
    assert.equal(res.isError, undefined);
    // The original payload is untouched; the notice is an additional block.
    assert.deepEqual(JSON.parse(res.content[0].text), { written: true });
    assert.equal(res.content.length, 2);
    assert.match(
      res.content[1].text,
      /^advisory lock: other-agent\/2\.0#conn-other claims Projects\/Alpha \(restructuring\), expires in \d+s$/
    );
    assert.equal(res.structuredContent.written, true);
    assert.equal(res.structuredContent.advisory_locks.length, 1);
    assert.equal(res.structuredContent.advisory_locks[0].holder, "other-agent/2.0#conn-other");
    assert.equal(res.structuredContent.advisory_locks[0].scope, "Projects/Alpha");

    await tick(5);
    const [rec] = records();
    assert.equal(rec.outcome, "ok");
    assert.deepEqual(rec.lockNotice, {
      holder: "other-agent/2.0#conn-other",
      scope: "Projects/Alpha",
      reason: "restructuring",
    });
  });

  test("the claim HOLDER's own writes into its scope get no notice at all", async () => {
    const { kernel, records } = fakeKernel();
    kernel.locks.claim({ scope: "Projects/Alpha", holder: holderOf(ACTOR), reason: "my own edit", ttlMs: 120_000 });

    const res = await kernel.runMutation(ctx(), async () => okEnvelope({ written: true }));
    assert.equal(res.content.length, 1, "the point of claiming a scope is to work in it");
    assert.equal(res.structuredContent.advisory_locks, undefined);

    await tick(5);
    assert.equal(records()[0].lockNotice, undefined);
  });

  test("a write outside every claim, and a write under an EXPIRED claim, are untouched", async () => {
    let t = 1_000_000;
    const locks = new LockStore(() => t);
    const { kernel, records } = fakeKernel({ locks });
    locks.claim({ scope: "Archive", holder: holderOf(OTHER), reason: "elsewhere", ttlMs: 60_000 });

    const outside = await kernel.runMutation(ctx(), async () => okEnvelope({ n: 1 }));
    assert.equal(outside.content.length, 1, "a disjoint claim is not this write's business");

    locks.claim({ scope: "Projects/Alpha", holder: holderOf(OTHER), reason: "short", ttlMs: 60_000 });
    t += 60_001;
    const expired = await kernel.runMutation(ctx(), async () => okEnvelope({ n: 2 }));
    assert.equal(expired.content.length, 1, "an expired claim notices nothing");

    await tick(5);
    for (const rec of records()) assert.equal(rec.lockNotice, undefined);
  });

  test("several foreign claims all appear in the envelope; the journal records the most specific", async () => {
    const { kernel, records } = fakeKernel();
    const THIRD = { transport: "mcp", client: "third/1", connection: "conn-3" };
    kernel.locks.claim({ scope: "Projects", holder: holderOf(THIRD), reason: "broad sweep", ttlMs: 120_000 });
    kernel.locks.claim({ scope: "Projects/Alpha", holder: holderOf(OTHER), reason: "narrow edit", ttlMs: 120_000 });

    const res = await kernel.runMutation(ctx(), async () => okEnvelope({ ok: true }));
    assert.equal(res.structuredContent.advisory_locks.length, 2);
    assert.match(res.content[1].text, /narrow edit/);
    assert.match(res.content[1].text, /broad sweep/);

    await tick(5);
    assert.equal(records()[0].lockNotice.reason, "narrow edit", "the closest claim is the one recorded");
  });

  test("D4: several notices are one block, one claim per LINE", async () => {
    const { kernel } = fakeKernel();
    const THIRD = { transport: "mcp", client: "third/1", connection: "conn-3" };
    kernel.locks.claim({ scope: "Projects", holder: holderOf(THIRD), reason: "broad sweep", ttlMs: 120_000 });
    kernel.locks.claim({ scope: "Projects/Alpha", holder: holderOf(OTHER), reason: "narrow edit", ttlMs: 120_000 });

    const res = await kernel.runMutation(ctx(), async () => okEnvelope({ ok: true }));
    assert.equal(res.content.length, 2, "the notice is ONE extra block however many claims it names");
    const lines = res.content[1].text.split("\n");
    assert.equal(lines.length, 2, "…with one line per claim, not a space-joined run-on");
    assert.match(lines[0], /^advisory lock: .*claims Projects\/Alpha \(narrow edit\)/, "closest first");
    assert.match(lines[1], /^advisory lock: .*claims Projects \(broad sweep\)/);
  });

  test("D3: a MOVE into a foreign claim is noticed, though its primary target is outside", async () => {
    const { kernel, records } = fakeKernel();
    kernel.locks.claim({ scope: "Projects/Alpha", holder: holderOf(OTHER), reason: "restructuring", ttlMs: 120_000 });

    // `from` is the primary target and lies OUTSIDE the claim; only `to` is in.
    const res = await kernel.runMutation(
      ctx({ op: "obsidian_move_note", args: { from: "Inbox/note.md", to: "Projects/Alpha/note.md" } }),
      async () => okEnvelope({ moved: true })
    );
    assert.equal(res.content.length, 2, "arriving in somebody's scope is landing in their work");
    assert.equal(res.structuredContent.advisory_locks[0].scope, "Projects/Alpha");

    await tick(5);
    const [rec] = records();
    assert.equal(rec.target.path, "Inbox/note.md", "the journal's primary target is unchanged");
    assert.equal(rec.lockNotice.reason, "restructuring");
  });

  test("a non-envelope handler result is passed through untouched", async () => {
    const { kernel } = fakeKernel();
    kernel.locks.claim({ scope: "Projects", holder: holderOf(OTHER), reason: "r", ttlMs: 120_000 });
    assert.equal(await kernel.runMutation(ctx(), async () => 42), 42);
    assert.deepEqual(await kernel.runMutation(ctx(), async () => ({ raw: 1 })), { raw: 1 });
  });

  test("the notice reaches the tool surface through makeGuarded", async () => {
    const { kernel } = fakeKernel();
    kernel.locks.claim({ scope: "Projects", holder: holderOf(OTHER), reason: "in progress", ttlMs: 120_000 });
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const res = await guarded(RW_DEF, async () => ({ content: [{ type: "text", text: "{}" }] }), "obsidian_write_note")(
      { path: "Projects/Alpha/a.md" },
      {}
    );
    assert.match(res.content[1].text, /advisory lock: other-agent\/2\.0#conn-other claims Projects \(in progress\)/);
  });
});

// ── the claim/release/list tool surface ──────────────────────────────────────

describe("scope-claim tools", () => {
  function lockServer({ kernel = fakeKernel().kernel, actor = ACTOR } = {}) {
    const calls = new Map();
    const server = { registerTool: (name, def, handler) => calls.set(name, { def, handler }) };
    registerLockTools(server, { kernel }, () => actor);
    const call = (name, args = {}) => calls.get(name).handler(args, {});
    return { kernel, calls, call, def: (n) => calls.get(n).def };
  }

  test("claim and release are MUTATING (journaled); listing is read-only", () => {
    const { def } = lockServer();
    assert.equal(def("obsidian_claim_scope").annotations.readOnlyHint, false);
    assert.equal(def("obsidian_release_scope").annotations.readOnlyHint, false);
    assert.equal(def("obsidian_list_scope_claims").annotations.readOnlyHint, true);
  });

  test("the verbs are claim/renew/release only — no grant, approve or accept anywhere", () => {
    const { calls } = lockServer();
    assert.deepEqual(
      [...calls.keys()],
      ["obsidian_claim_scope", "obsidian_renew_scope", "obsidian_release_scope", "obsidian_list_scope_claims"]
    );
    for (const [name, { def }] of calls) {
      const text = `${name} ${def.title} ${def.description}`.toLowerCase();
      for (const banned of ["grant", "approve", "accept"]) {
        assert.equal(text.includes(banned), false, `'${banned}' must not appear in the claims vocabulary (${name})`);
      }
    }
  });

  test("claiming returns the claim and discloses overlapping foreign claims", async () => {
    const { kernel, call } = lockServer();
    kernel.locks.claim({ scope: "Projects", holder: "someone-else", reason: "sweeping", ttlMs: 120_000 });

    const res = await call("obsidian_claim_scope", { scope: "Projects/Alpha", reason: "editing" });
    assert.equal(res.isError, undefined);
    const { claim, overlapping } = res.structuredContent;
    assert.equal(claim.scope, "Projects/Alpha");
    assert.equal(claim.holder, holderOf(ACTOR));
    assert.equal(claim.reason, "editing");
    assert.ok(claim.expires_in_s > 0);
    assert.equal(overlapping.length, 1);
    assert.equal(overlapping[0].holder, "someone-else");
    assert.equal(overlapping[0].reason, "sweeping");
  });

  test("listing shows every live claim and flags your own", async () => {
    const { kernel, call } = lockServer();
    kernel.locks.claim({ scope: "Archive", holder: "someone-else", reason: "theirs", ttlMs: 120_000 });
    await call("obsidian_claim_scope", { scope: "Projects", reason: "mine" });

    const list = (await call("obsidian_list_scope_claims")).structuredContent;
    assert.equal(list.holder, holderOf(ACTOR));
    assert.deepEqual(list.claims.map((c) => [c.reason, c.mine]), [["theirs", false], ["mine", true]]);
  });

  test("releasing drops your claim; another holder's id is refused", async () => {
    const { kernel, call } = lockServer();
    const foreign = kernel.locks.claim({ scope: "Archive", holder: "someone-else", reason: "theirs", ttlMs: 120_000 }).lock;
    const mine = (await call("obsidian_claim_scope", { scope: "Projects", reason: "mine" })).structuredContent.claim;

    const released = await call("obsidian_release_scope", { lock_id: mine.id });
    assert.equal(released.structuredContent.released.id, mine.id);
    assert.deepEqual(kernel.locks.list().map((l) => l.id), [foreign.id]);

    const denied = await call("obsidian_release_scope", { lock_id: foreign.id });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /another holder/);
    assert.equal(kernel.locks.list().length, 1, "a foreign claim survives a release attempt");

    const missing = await call("obsidian_release_scope", { lock_id: "lock-nope" });
    assert.equal(missing.isError, true);
  });

  // D-B: a cap refusal used to be caught and rendered by core `fail(e)`, which
  // emits a bare `Error: <message>` — so the ONE machine-readable thing about it,
  // its code, was dropped on the wire while `codedError` sat in the same file.
  test("D-B: the per-holder cap refusal reaches the wire as Error [lock_cap]", async () => {
    const locks = new LockStore(() => 1_000_000, 200, 1);
    const { call } = lockServer({ kernel: fakeKernel({ locks }).kernel });
    assert.equal((await call("obsidian_claim_scope", { scope: "Projects", reason: "one" })).isError, undefined);

    const res = await call("obsidian_claim_scope", { scope: "Archive", reason: "two" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[lock_cap\]: /, "a coded refusal, not an anonymous Error:");
    assert.match(res.content[0].text, /per-holder cap/);
    assert.equal(locks.list().length, 1, "nothing was claimed");
  });

  test("D-B: the STORE cap refusal carries its own code, and names the TTL recovery", async () => {
    const locks = new LockStore(() => 1_000_000, 1, 50);
    locks.claim({ scope: "Elsewhere", holder: "someone-else#conn-9", reason: "theirs" });
    const { call } = lockServer({ kernel: fakeKernel({ locks }).kernel });

    const res = await call("obsidian_claim_scope", { scope: "Projects", reason: "mine" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[lock_store_cap\]: /, "the store cap is distinguishable from the holder cap");
    assert.match(res.content[0].text, /expire/, "a denied bystander learns the wait is bounded");
    assert.equal(locks.list().length, 1, "no holder's claim was dropped to make room");
  });

  // D2: re-claiming used to ACCUMULATE — one claim per call, all saying the same
  // thing, all counting against the cap. It now replaces.
  test("D2: re-claiming a scope you hold REPLACES that claim rather than adding one", async () => {
    const { kernel, call } = lockServer();
    const first = (await call("obsidian_claim_scope", { scope: "Projects", reason: "pass 1" })).structuredContent;
    assert.deepEqual(first.overlapping, [], "your own scope never overlaps you");
    assert.equal(first.replaced, false, "the first claim replaced nothing");

    const second = (await call("obsidian_claim_scope", { scope: "Projects", reason: "pass 2" })).structuredContent;
    assert.equal(second.replaced, true);
    assert.equal(second.claim.id, first.claim.id, "the claim keeps its identity, so a held id stays valid");
    assert.equal(second.claim.reason, "pass 2", "the reason is restated");
    assert.equal(kernel.locks.list().length, 1, "one scope, one claim");

    // A DIFFERENT scope is a different claim, replaced by nothing.
    const other = (await call("obsidian_claim_scope", { scope: "Archive", reason: "elsewhere" })).structuredContent;
    assert.equal(other.replaced, false);
    assert.equal(kernel.locks.list().length, 2);
  });

  test("D2: obsidian_renew_scope extends a claim you hold, by id", async () => {
    const { kernel, call } = lockServer();
    const claim = (await call("obsidian_claim_scope", { scope: "Projects", reason: "long job" })).structuredContent.claim;

    const renewed = await call("obsidian_renew_scope", { lock_id: claim.id, ttl_ms: LOCK_TTL_MAX_MS });
    assert.equal(renewed.isError, undefined);
    assert.equal(renewed.structuredContent.renewed.id, claim.id, "renewing never mints a new claim");
    assert.equal(renewed.structuredContent.renewed.scope, "Projects", "scope and reason are untouched");
    assert.equal(renewed.structuredContent.renewed.reason, "long job");
    assert.ok(
      new Date(renewed.structuredContent.renewed.expires_at) > new Date(claim.expires_at),
      "the clock restarted"
    );
    assert.equal(kernel.locks.list().length, 1);
  });

  test("D2: renewing another holder's claim, or an unknown id, is refused", async () => {
    const { kernel, call } = lockServer();
    const foreign = kernel.locks.claim({ scope: "Archive", holder: "someone-else", reason: "theirs", ttlMs: 120_000 }).lock;

    const denied = await call("obsidian_renew_scope", { lock_id: foreign.id });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /another holder/);
    assert.equal(
      kernel.locks.list()[0].expiresAt,
      foreign.expiresAt,
      "a foreign claim's clock is not touched by a refused renewal"
    );

    assert.equal((await call("obsidian_renew_scope", { lock_id: "lock-nope" })).isError, true);
  });

  test("D2: renew is MUTATING, so it is journaled, and names the lock", async () => {
    const { kernel, records } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const calls = new Map();
    registerLockTools(
      { registerTool: (name, def, handler) => calls.set(name, guarded(def, handler, name)) },
      { kernel },
      () => ACTOR
    );
    const claimed = await calls.get("obsidian_claim_scope")({ scope: "Projects", reason: "r" }, {});
    const id = claimed.structuredContent.claim.id;
    await calls.get("obsidian_renew_scope")({ lock_id: id }, {});

    await tick(5);
    const renew = records().find((r) => r.op === "obsidian_renew_scope");
    assert.ok(renew, "a renewal is an act the audit stream records");
    assert.equal(renew.target.ref, `lock:${id}`);
  });

  test("without a kernel the tools fail cleanly rather than throwing", async () => {
    const { call } = lockServer({ kernel: null });
    for (const name of ["obsidian_claim_scope", "obsidian_release_scope", "obsidian_list_scope_claims"]) {
      const res = await call(name, { scope: "A", reason: "r", lock_id: "x" });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /kernel/);
    }
  });

  test("a claim journals as its own operation, with target.ref naming the scope", async () => {
    const { kernel, records } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const calls = new Map();
    registerLockTools(
      { registerTool: (name, def, handler) => calls.set(name, guarded(def, handler, name)) },
      { kernel },
      () => ACTOR
    );

    const claimed = await calls.get("obsidian_claim_scope")({ scope: "Projects/Alpha", reason: "editing" }, {});
    await calls.get("obsidian_release_scope")({ lock_id: claimed.structuredContent.claim.id }, {});
    await calls.get("obsidian_list_scope_claims")({}, {});

    await tick(5);
    const recs = records();
    assert.deepEqual(recs.map((r) => r.op), ["obsidian_claim_scope", "obsidian_release_scope"]);
    assert.equal(recs[0].target.ref, "scope:Projects/Alpha");
    assert.equal(recs[1].target.ref, `lock:${claimed.structuredContent.claim.id}`);
    assert.deepEqual(recs[0].actor, ACTOR, "a claim is attributed like any other operation");
  });

  // D8: a claim is a statement about a region of the vault that every other
  // session sees. A session sandboxed to Projects/ that could claim the whole
  // vault would reach out of its sandbox — not to write, but to stamp its name
  // on everybody else's writes.
  describe("D8: a claim is bounded by the path allowlist", () => {
    function sandboxed(allowlist) {
      const calls = new Map();
      const { kernel } = fakeKernel();
      registerLockTools(
        { registerTool: (name, def, handler) => calls.set(name, { def, handler }) },
        { kernel, getSettings: () => ({ readOnly: false, allowlist }) },
        () => ACTOR
      );
      return { kernel, call: (name, args = {}) => calls.get(name).handler(args, {}) };
    }

    test("an allowlisted session may claim INSIDE its allowlist", async () => {
      const { kernel, call } = sandboxed(["Projects"]);
      const res = await call("obsidian_claim_scope", { scope: "Projects/Alpha", reason: "editing" });
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.claim.scope, "Projects/Alpha");
      assert.equal(kernel.locks.list().length, 1);
    });

    test("…and is refused OUTSIDE it, with a typed error and no claim", async () => {
      const { kernel, call } = sandboxed(["Projects"]);
      const res = await call("obsidian_claim_scope", { scope: "Archive", reason: "reaching out" });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
      assert.match(res.content[0].text, /Nothing was claimed/);
      assert.deepEqual(kernel.locks.list(), []);
    });

    test("…and refused the WHOLE-VAULT scope, which no path check would catch", async () => {
      const { kernel, call } = sandboxed(["Projects"]);
      for (const scope of ["", ".", "/"]) {
        const res = await call("obsidian_claim_scope", { scope, reason: "everything" });
        assert.equal(res.isError, true, `scope ${JSON.stringify(scope)} must be refused`);
        assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
      }
      assert.deepEqual(kernel.locks.list(), [], "the empty scope normalizes to whole-vault, and is dropped by collectPaths");
    });

    test("a session with NO allowlist is unchanged, whole-vault claims included", async () => {
      const { kernel, call } = sandboxed([]);
      assert.equal((await call("obsidian_claim_scope", { scope: "", reason: "all of it" })).isError, undefined);
      assert.equal((await call("obsidian_claim_scope", { scope: "Anywhere/At/All", reason: "r" })).isError, undefined);
      assert.equal(kernel.locks.list().length, 2);
    });

    test("listing stays unrestricted — disclosure of who is working is its whole value", async () => {
      const { kernel, call } = sandboxed(["Projects"]);
      kernel.locks.claim({ scope: "Archive", holder: "someone-else", reason: "outside your sandbox", ttlMs: 120_000 });
      const list = await call("obsidian_list_scope_claims");
      assert.equal(list.isError, undefined);
      assert.deepEqual(list.structuredContent.claims.map((c) => c.scope), ["Archive"]);
    });

    test("releasing and renewing your own claim stay allowed: they only ever shrink reach", async () => {
      const { call } = sandboxed(["Projects"]);
      const claim = (await call("obsidian_claim_scope", { scope: "Projects", reason: "r" })).structuredContent.claim;
      assert.equal((await call("obsidian_renew_scope", { lock_id: claim.id })).isError, undefined);
      assert.equal((await call("obsidian_release_scope", { lock_id: claim.id })).isError, undefined);
    });
  });

  test("read-only mode blocks claiming, since there is nothing to disclose", async () => {
    const { kernel } = fakeKernel();
    const guarded = makeGuarded({ getSettings: () => ({ readOnly: true, allowlist: [] }), kernel, actor: () => ACTOR });
    const calls = new Map();
    registerLockTools(
      { registerTool: (name, def, handler) => calls.set(name, guarded(def, handler, name)) },
      { kernel },
      () => ACTOR
    );
    const res = await calls.get("obsidian_claim_scope")({ scope: "A", reason: "r" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[read_only\]/);
    // …but listing still works: it is a read.
    assert.equal((await calls.get("obsidian_list_scope_claims")({}, {})).isError, undefined);
  });
});

// ── server identity ──────────────────────────────────────────────────────────

describe("server identity", () => {
  test("actor.server travels onto every journal record", async () => {
    const { kernel, records } = fakeKernel();
    const actor = {
      transport: "mcp",
      client: "claude-code/1.0.0",
      connection: "abc-1",
      server: { vault: "Assent", install: "i-123", version: "0.9.2" },
    };
    await kernel.runMutation({ op: "obsidian_write_note", args: { path: "A.md" }, actor }, async () => ({ content: [] }));
    await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "A.md" }, actor, idempotencyKey: "si1" },
      async () => ({ content: [] })
    );
    await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "A.md" }, actor, idempotencyKey: "si1" },
      async () => assert.fail("ran")
    );

    await tick(5);
    const recs = records();
    assert.equal(recs.length, 3);
    for (const rec of recs) {
      assert.deepEqual(rec.actor.server, { vault: "Assent", install: "i-123", version: "0.9.2" });
    }
    assert.equal(recs[2].outcome, "deduped", "a terminal record carries the identity too");
  });

  test("an actor without server identity journals exactly as before", async () => {
    const { kernel, records } = fakeKernel();
    await kernel.runMutation({ op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR }, async () => ({
      content: [],
    }));
    await tick(5);
    assert.deepEqual(records()[0].actor, ACTOR);
    assert.equal("server" in records()[0].actor, false, "the field is additive, never synthesized");
  });

  test("holders derive from the connection, so two connections claim independently", () => {
    const a = { transport: "mcp", client: "claude-code/1.0.0", connection: "c1", server: { vault: "V", install: "i", version: "1" } };
    const b = { ...a, connection: "c2" };
    assert.notEqual(holderOf(a), holderOf(b));
  });
});

// ── install id ───────────────────────────────────────────────────────────────

describe("install id", () => {
  // The journal's adapter stub already models the four DataAdapter methods the
  // kernel narrows to; install-id.ts needs `read` as well.
  function idAdapter() {
    const a = fakeAdapter();
    a.read = async (p) => {
      if (!a.files.has(p)) throw new Error(`ENOENT ${p}`);
      return a.files.get(p);
    };
    return a;
  }

  test("mints once and returns the SAME id on every later load (file-backed)", async () => {
    const adapter = idAdapter();
    let minted = 0;
    const mint = () => `install-${++minted}`;

    const first = await loadInstallId(adapter, "dir", mint);
    assert.equal(first.install, "install-1");
    assert.equal(first.persisted, true);
    assert.ok(adapter.files.has(`dir/${INSTALL_ID_FILE}`));
    assert.deepEqual(JSON.parse(adapter.files.get(`dir/${INSTALL_ID_FILE}`)).install, "install-1");

    // A fresh kernel instantiation — a plugin reload, an Obsidian restart —
    // reads the id back rather than minting a second one.
    const second = await loadInstallId(adapter, "dir", mint);
    assert.equal(second.install, "install-1");
    assert.equal(minted, 1, "the id must survive re-instantiation, or it isn't an install id");
  });

  test("a corrupt file is replaced rather than respected", async () => {
    const adapter = idAdapter();
    adapter.files.set(`dir/${INSTALL_ID_FILE}`, "{not json");
    await quietly(async () => {
      const loaded = await loadInstallId(adapter, "dir", () => "fresh");
      assert.equal(loaded.install, "fresh");
      assert.equal(loaded.persisted, true);
    });
    // …and it is stable from then on.
    assert.equal((await loadInstallId(adapter, "dir", () => "other")).install, "fresh");
  });

  test("an unwritable data dir degrades to an ephemeral id, never a failed load", async () => {
    const adapter = idAdapter();
    adapter.write = async () => { throw new Error("EROFS"); };
    await quietly(async () => {
      const loaded = await loadInstallId(adapter, "dir", () => "ephemeral");
      assert.equal(loaded.install, "ephemeral");
      assert.equal(loaded.persisted, false, "the caller can tell the id will not survive a restart");
    });
  });

  test("mintInstallId produces distinct, non-empty ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintInstallId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.ok(id.length > 8);
  });
});
