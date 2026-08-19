/**
 * write-queue-wallclock.test.mjs — #272: the write queue's abandon deadline is
 * wall-clock math evaluated on queue activity, never something that DEPENDS on
 * a timer firing.
 *
 * Why: the queue runs in Obsidian's renderer, where Chromium suspends timers
 * while the window is occluded. Live-observed: a stalled renameFile held the
 * queue INDEFINITELY (its 30s setTimeout never fired) and every subsequent
 * mutating call queued behind it until a plugin reload. These tests simulate
 * that world — timers armed but INERT (mocked, never ticked) — and drive time
 * purely through an injected wall clock. If any assertion here ever needs a
 * timer to fire to pass, the #272 guarantee has regressed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Kernel,
  WriteQueue,
  WriteTimeoutError,
  WriteJournal,
} from "../src/kernel/index.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Drains promise chains without touching the (mocked, inert) timer queue.
async function flushMicrotasks(turns = 10) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// Injectable wall clock: advances ONLY when the test says the world's clock
// moved — completely decoupled from the (suspended) timer queue.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// The suspended-renderer world: every setTimeout is captured and NEVER fires.
// Unlike t.mock.timers (which couples timers to a tickable clock), this makes
// the suspension total and explicit — the only clock is the injected one.
function suspendTimers(t) {
  const armed = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms) => {
    armed.push({ fn, ms });
    return /** @type {any} */ (armed.length); // opaque handle for clearTimeout
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  return armed;
}

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "wc-1" };

// Minimal adapter for WriteJournal (same narrowing as kernel.test.mjs).
function fakeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async write(p, d) { files.set(p, d); },
    async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
  };
}

function linesOf(adapter, file) {
  return (adapter.files.get(file) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("WriteQueue wall-clock deadline (#272 — suspended-timer world)", () => {
  test("a stalled op + inert timers + a later enqueue: the stalled op is abandoned and the newcomer runs", async (t) => {
    const armed = suspendTimers(t);
    const clock = fakeClock();
    const queue = new WriteQueue(30_000, clock.now);

    const wedged = deferred(); // the stalled renameFile — never settles in time
    const stuck = queue.run("obsidian_move_note", () => wedged.promise);
    await flushMicrotasks();
    assert.equal(queue.running, true);
    assert.ok(armed.length >= 1, "the best-effort timer should still arm");

    // The window is occluded: 31s of wall clock pass, no timer ever fires.
    clock.advance(31_000);
    await flushMicrotasks();
    // Nothing has happened yet — the deadline is checked on queue EVENTS, and
    // none occurred. This is the honest boundary, not a bug.
    assert.equal(queue.running, true, "no event yet, so the stalled op still holds the slot");

    // A subsequent enqueue is the event. It must abandon the stalled op and run.
    let newcomerRan = false;
    const newcomer = queue.run("obsidian_write_note", async () => { newcomerRan = true; return "ok"; });

    const err = await stuck.then(
      () => assert.fail("the stalled op must be abandoned, not resolved"),
      (e) => e
    );
    assert.ok(err instanceof WriteTimeoutError, `expected WriteTimeoutError, got ${err}`);
    assert.equal(err.code, "write_timeout");
    assert.equal(err.op, "obsidian_move_note");

    assert.equal(await newcomer, "ok", "the newcomer must run after the wall-clock abandonment");
    assert.equal(newcomerRan, true);
    assert.equal(queue.running, false);
    assert.equal(queue.depth, 0);
  });

  test("nudge() alone (the journal-append entry point) abandons an overdue op with no enqueue", async (t) => {
    suspendTimers(t);
    const clock = fakeClock();
    const queue = new WriteQueue(30_000, clock.now);

    const wedged = deferred();
    const stuck = queue.run("obsidian_patch_note", () => wedged.promise);
    // Something was already queued behind the wedge BEFORE the window occluded.
    let waiterRan = false;
    const waiter = queue.run("obsidian_write_note", async () => { waiterRan = true; return "ran"; });
    await flushMicrotasks();
    assert.equal(queue.depth, 1);

    clock.advance(30_000); // exactly the budget: >= is the deadline
    queue.nudge(); // e.g. a deduped idempotency replay appended a journal record

    await assert.rejects(stuck, WriteTimeoutError);
    assert.equal(await waiter, "ran", "nudge must also pump the backlog, not just abandon");
    assert.equal(waiterRan, true);
  });

  test("nudge() before the deadline is a no-op: the running op keeps its slot", async (t) => {
    suspendTimers(t);
    const clock = fakeClock();
    const queue = new WriteQueue(30_000, clock.now);

    const gate = deferred();
    const held = queue.run("obsidian_write_note", () => gate.promise);
    await flushMicrotasks();

    clock.advance(29_999);
    queue.nudge();
    await flushMicrotasks();
    assert.equal(queue.running, true, "an in-budget op must never be abandoned by a nudge");

    gate.resolve("done");
    assert.equal(await held, "done", "the op settles normally after harmless nudges");
  });

  test("FIFO and one-at-a-time survive a wall-clock abandonment", async (t) => {
    suspendTimers(t);
    const clock = fakeClock();
    const queue = new WriteQueue(30_000, clock.now);

    const wedged = deferred();
    const finished = [];
    const stuck = queue.run("stuck", () => wedged.promise);
    let active = 0;
    let maxActive = 0;
    const op = (name) => queue.run(name, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await flushMicrotasks();
      active--;
      finished.push(name);
      return name;
    });
    const b = op("b");
    const c = op("c");
    await flushMicrotasks();

    clock.advance(31_000);
    const d = op("d"); // the unwedging event arrives LAST in FIFO order

    await assert.rejects(stuck, WriteTimeoutError);
    assert.deepEqual(await Promise.all([b, c, d]), ["b", "c", "d"]);
    assert.deepEqual(finished, ["b", "c", "d"], "enqueue order is run order across an abandonment");
    assert.equal(maxActive, 1, "two operations overlapped after a wall-clock abandonment");
  });

  test("late settlement after a wall-clock abandonment still reaches onLate (abandoned, not cancelled)", async (t) => {
    suspendTimers(t);
    const clock = fakeClock();
    const queue = new WriteQueue(30_000, clock.now);

    const wedged = deferred();
    const settlements = [];
    const stuck = queue.run("obsidian_move_note", () => wedged.promise, (s) => settlements.push(s));
    await flushMicrotasks();

    clock.advance(31_000);
    queue.nudge();
    await assert.rejects(stuck, WriteTimeoutError);
    assert.deepEqual(settlements, [], "onLate must not fire before the op actually settles");

    // The vault operation finishes after all — the move DID land.
    wedged.resolve("moved");
    await flushMicrotasks();
    assert.deepEqual(settlements, [{ ok: true, value: "moved" }]);

    // And a late FAILURE reports too.
    const wedged2 = deferred();
    const settlements2 = [];
    const stuck2 = queue.run("obsidian_write_note", () => wedged2.promise, (s) => settlements2.push(s));
    await flushMicrotasks();
    clock.advance(31_000);
    queue.nudge();
    await assert.rejects(stuck2, WriteTimeoutError);
    const boom = new Error("disk gone");
    wedged2.reject(boom);
    await flushMicrotasks();
    assert.deepEqual(settlements2, [{ ok: false, error: boom }]);
  });

  test("kernel: wall-clock abandonment journals the timeout, and a late settle appends the corrective record", async (t) => {
    suspendTimers(t);
    const clock = fakeClock();
    const queue = new WriteQueue(30_000, clock.now);
    const adapter = fakeAdapter();
    const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-19T12:00:00Z"));
    const kernel = new Kernel(queue, journal, null);

    const wedged = deferred();
    const stalled = kernel.runMutation(
      { op: "obsidian_move_note", args: { from: "A.md", to: "B.md" }, actor: ACTOR },
      () => wedged.promise
    );
    await flushMicrotasks();

    clock.advance(31_000);
    // The unwedging event is the next mutating call — no timer fires anywhere.
    const next = kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "C.md" }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "{}" }] })
    );

    await assert.rejects(stalled, WriteTimeoutError);
    await next;
    await flushMicrotasks();

    const file = "dir/journal/2026-08.jsonl";
    let records = linesOf(adapter, file);
    const timeoutRecord = records.find((r) => r.op === "obsidian_move_note");
    assert.ok(timeoutRecord, "the abandoned op must be journaled");
    assert.equal(timeoutRecord.outcome, "error");
    assert.match(timeoutRecord.error, /write-queue timeout/);
    assert.ok(records.some((r) => r.op === "obsidian_write_note" && r.outcome === "ok"));

    // The move settles after all: the corrective record must land, linked back.
    wedged.resolve({ content: [{ type: "text", text: "{}" }] });
    await flushMicrotasks();
    records = linesOf(adapter, file);
    const corrective = records.find((r) => r.outcome === "late-ok");
    assert.ok(corrective, "a late settlement must append a corrective record");
    assert.equal(corrective.op, "obsidian_move_note");
    assert.equal(corrective.corrects, timeoutRecord.ts);
  });

  test("foreground path unchanged: with live timers and no nudge, the timer still abandons promptly", async () => {
    // Real timers, real Date.now — the pre-#272 behavior must be preserved as
    // the best-effort prompt path.
    const queue = new WriteQueue(25);
    const wedged = deferred();
    let nextRan = false;
    const stuck = queue.run("stuck", () => wedged.promise);
    const next = queue.run("next", async () => { nextRan = true; return "ok"; });

    await assert.rejects(stuck, WriteTimeoutError);
    assert.equal(await next, "ok");
    assert.equal(nextRan, true, "the timer-driven abandonment must still free the queue on its own");
  });

  test("a wall-clock abandonment cannot double-release the slot when the timer would fire later", async (t) => {
    // Both mechanisms target the same op: nudge abandons first; the armed timer
    // callback firing afterwards must be a no-op (single claim point).
    const armed = suspendTimers(t);
    const clock = fakeClock();
    const queue = new WriteQueue(30_000, clock.now);

    const wedged = deferred();
    const stuck = queue.run("stuck", () => wedged.promise);
    await flushMicrotasks();
    // Only the STALE timers — the ones armed for "stuck" — fire late below;
    // "held" arms its own (also inert) timer after this snapshot.
    const staleTimers = armed.splice(0);
    clock.advance(31_000);
    queue.nudge();
    await assert.rejects(stuck, WriteTimeoutError);

    const gate = deferred();
    const held = queue.run("held", () => gate.promise);
    await flushMicrotasks();

    // The suspended window comes back: Chromium fires the stale timer late.
    for (const { fn } of staleTimers) fn();
    await flushMicrotasks();
    assert.equal(queue.running, true, "a stale timer firing late must not release the successor's slot");

    gate.resolve("ok");
    assert.equal(await held, "ok");
  });
});
