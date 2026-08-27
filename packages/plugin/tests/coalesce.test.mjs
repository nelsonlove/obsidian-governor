/**
 * coalesce.test.mjs — the rename-storm fix.
 *
 * The property that failed in production and must never fail again: a BURST of
 * requests runs the expensive pass ONCE. Measured on the live vault
 * (2026-08-27): renaming one note rewrote ~120 backlinking notes, each firing a
 * modify event, each ending in a whole-vault refresh — 120 × 3,581 reads, all
 * in memory, which is why it burned CPU while writing nothing.
 *
 * Timers are injected so the collapse is COUNTED, not slept for.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createCoalescer } from "../src/governor/kernel/coalesce.ts";

/** A fake clock: setTimeout records, advance() fires what is due. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const scheduled = new Map();
  return {
    api: {
      setTimeout: (fn, ms) => { const h = ++seq; scheduled.set(h, { fn, at: now + ms }); return h; },
      clearTimeout: (h) => { scheduled.delete(h); },
    },
    advance(ms) {
      now += ms;
      for (const [h, t] of [...scheduled]) {
        if (t.at <= now) { scheduled.delete(h); t.fn(); }
      }
    },
    scheduledCount: () => scheduled.size,
  };
}

describe("createCoalescer — one pass per burst", () => {
  test("THE RENAME STORM: 120 requests in one window run the pass exactly ONCE", () => {
    const timers = fakeTimers();
    let runs = 0;
    const c = createCoalescer(() => { runs++; }, 400, () => {}, timers.api);
    for (let i = 0; i < 120; i++) c.request();   // the backlink rewrite burst
    assert.equal(runs, 0, "nothing runs during the burst — trailing edge");
    assert.equal(timers.scheduledCount(), 1, "the burst leaves ONE timer, not 120");
    timers.advance(400);
    assert.equal(runs, 1, "120 events, one whole-vault pass");
  });

  test("a later burst runs again — coalescing is not suppression", () => {
    const timers = fakeTimers();
    let runs = 0;
    const c = createCoalescer(() => { runs++; }, 400, () => {}, timers.api);
    c.request(); timers.advance(400);
    assert.equal(runs, 1);
    c.request(); c.request(); timers.advance(400);
    assert.equal(runs, 2, "the second burst gets its own pass");
  });

  test("trailing, not leading: a request during the wait pushes the pass out", () => {
    const timers = fakeTimers();
    let runs = 0;
    const c = createCoalescer(() => { runs++; }, 400, () => {}, timers.api);
    c.request();
    timers.advance(300);
    c.request();                 // still arriving
    timers.advance(300);         // 600ms since the first, 300 since the last
    assert.equal(runs, 0, "the pass waits for the burst to settle");
    timers.advance(100);
    assert.equal(runs, 1);
  });

  test("cancel drops a pending pass (teardown must not run against a dead mount)", () => {
    const timers = fakeTimers();
    let runs = 0;
    const c = createCoalescer(() => { runs++; }, 400, () => {}, timers.api);
    c.request();
    assert.equal(c.pending(), true);
    c.cancel();
    assert.equal(c.pending(), false);
    timers.advance(1000);
    assert.equal(runs, 0);
  });

  test("a throwing or rejecting pass is reported, never propagated — a failed refresh must not kill the event handler", () => {
    const timers = fakeTimers();
    const errors = [];
    const sync = createCoalescer(() => { throw new Error("sync boom"); }, 10, (e) => errors.push(String(e)), timers.api);
    sync.request();
    timers.advance(10);          // must not throw out of advance()
    assert.equal(errors.length, 1);

    const async_ = createCoalescer(async () => { throw new Error("async boom"); }, 10, (e) => errors.push(String(e)), timers.api);
    async_.request();
    timers.advance(10);
    return new Promise((r) => setTimeout(r, 0)).then(() => {
      assert.equal(errors.length, 2, "a rejected pass is caught too");
    });
  });
});

describe("the wiring uses it — pinned at the source", () => {
  const src = fs.readFileSync(new URL("../src/governor/wiring/wiring.ts", import.meta.url), "utf8");
  // Comments explain the bug at length; strip them so the scan reads CODE.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("reconcile — the per-file handler — never awaits a whole-vault refresh directly", () => {
    const start = code.indexOf("async function reconcile(");
    assert.ok(start > 0, "reconcile must exist for this pin to mean anything");
    const body = code.slice(start, code.indexOf("\n}", start));
    assert.ok(!/await\s+refresh\(plugin\)/.test(body),
      "reconcile awaiting refresh() is the 120 × 3,581 blowup — it must call requestRefresh()");
    assert.ok(/requestRefresh\(plugin\)/.test(body), "reconcile must ask through the coalescer");
  });

  test("the modify handler still only SCHEDULES per-file work (it must not gain a sweep)", () => {
    const m = /vault\.on\("modify",[\s\S]{0,220}?\)\)/.exec(code);
    assert.ok(m, "the modify registration must be findable");
    assert.ok(!/getMarkdownFiles/.test(m[0]), "no vault sweep in the modify handler");
    assert.ok(/scheduleReconcile/.test(m[0]));
  });

  test("requestRefresh coalesces per plugin and refresh() stays the only full pass", () => {
    assert.match(code, /const refreshCoalescers = new WeakMap/, "coalescers are module-private, per plugin");
    assert.match(code, /createCoalescer\(\s*\n?\s*\(\) => refresh\(plugin\)/, "the coalesced pass IS refresh()");
    // ONE definition of the EXPENSIVE pass. The cost that mattered is reading
    // every note's CONTENT (cachedRead per governed file); other loops over
    // governedMarkdownFiles touch only the metadata cache (listRevising, the
    // Proposed listing) and run on pane render, not per event. A second
    // content-reading sweep would dodge the coalescer, so that is what is
    // pinned — not the loop keyword.
    const contentSweeps = code.match(/for \(const file of governedMarkdownFiles\(plugin\)\)\s*\{[^}]*cachedRead/g) ?? [];
    assert.equal(contentSweeps.length, 1, "exactly one whole-vault CONTENT read loop exists (a second would bypass the coalescer)");
  });
});
