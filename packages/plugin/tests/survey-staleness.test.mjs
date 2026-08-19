import assert from "node:assert/strict";
import { test } from "node:test";
import { staleness } from "../src/kernel/survey/staleness.js";

const walked = (items) => ({ items, stubs: 0, depthReached: 1 });

test("staleness: no stamp at all is never-surveyed", () => {
  const out = staleness(walked(3), 1, undefined);
  assert.equal(out.stale, true);
  assert.equal(out.reason, "never-surveyed");
});

test("staleness: a stamp missing items/depth is malformed-stamp, not a crash", () => {
  const out = staleness(walked(3), 1, { at: "2026-01-01" });
  assert.equal(out.stale, true);
  assert.equal(out.reason, "malformed-stamp");
});

test("staleness: matching depth and item count is not stale", () => {
  const out = staleness(walked(5), 1, { at: "x", items: 5, depth: 1 });
  assert.equal(out.stale, false);
  assert.equal(out.reason, null);
});

test("staleness: item count drift at the same depth is count-drift", () => {
  const out = staleness(walked(7), 1, { at: "x", items: 5, depth: 1 });
  assert.equal(out.stale, true);
  assert.equal(out.reason, "count-drift");
});

test("staleness: a different depth than last time is depth-changed, even with equal counts", () => {
  const out = staleness(walked(5), 2, { at: "x", items: 5, depth: 1 });
  assert.equal(out.stale, true);
  assert.equal(out.reason, "depth-changed");
});
