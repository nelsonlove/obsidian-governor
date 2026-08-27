// Ported from obsidian-stewardship/tests/pending-index.test.mjs (#83, cycle 1) —
// pendingIndex/serializePendingIndex, the pure read-only pending-index serializer,
// now at src/governor/kernel/pending-index.ts. Derived entirely from PendingItem[];
// no I/O, no obsidian runtime. The bytes it emits are what obsidian_pending_review parses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingIndex, serializePendingIndex } from "../src/governor/kernel/pending-index.ts";

const item = (overrides = {}) => ({
  path: "Notes/A.md",
  title: "A",
  agent: "agent-x/1.0",
  op: "obsidian_append_note",
  when: "2026-08-09T10:00:00.000Z",
  writeCount: 2,
  writes: [],
  hadBaseline: true,
  intent: "tidying up",
  ...overrides,
});

test("empty queue → version 1, generatedAt passed through, empty pending array", () => {
  const idx = pendingIndex([], "2026-08-10T00:00:00.000Z");
  assert.deepEqual(idx, { version: 1, generatedAt: "2026-08-10T00:00:00.000Z", pending: [] });
});

test("maps exactly the documented fields from PendingItem, status always 'pending'", () => {
  const idx = pendingIndex([item()], "2026-08-10T00:00:00.000Z");
  assert.equal(idx.pending.length, 1);
  assert.deepEqual(idx.pending[0], {
    path: "Notes/A.md",
    status: "pending",
    agent: "agent-x/1.0",
    op: "obsidian_append_note",
    when: "2026-08-09T10:00:00.000Z",
    writeCount: 2,
  });
});

test("does NOT leak fields beyond the documented schema (no title, writes, hadBaseline, intent)", () => {
  const idx = pendingIndex([item()], "2026-08-10T00:00:00.000Z");
  const keys = Object.keys(idx.pending[0]).sort();
  assert.deepEqual(keys, ["agent", "op", "path", "status", "when", "writeCount"]);
});

test("preserves queue order and count across multiple items", () => {
  const items = [
    item({ path: "A.md", agent: "agent-a" }),
    item({ path: "B.md", agent: "agent-b" }),
    item({ path: "C.md", agent: "agent-a" }),
  ];
  const idx = pendingIndex(items, "2026-08-10T00:00:00.000Z");
  assert.deepEqual(idx.pending.map((p) => p.path), ["A.md", "B.md", "C.md"]);
  assert.deepEqual(idx.pending.map((p) => p.agent), ["agent-a", "agent-b", "agent-a"]);
});

test("serializePendingIndex produces valid JSON that round-trips to the same shape", () => {
  const items = [item()];
  const json = serializePendingIndex(items, "2026-08-10T00:00:00.000Z");
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, pendingIndex(items, "2026-08-10T00:00:00.000Z"));
});

test("serializePendingIndex on an empty queue is valid JSON with an empty pending array", () => {
  const json = serializePendingIndex([], "2026-08-10T00:00:00.000Z");
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.pending, []);
  assert.equal(parsed.version, 1);
});

test("no accept-capability leakage: no field name suggests accept/revert/adopt/baseline content", () => {
  const idx = pendingIndex([item()], "2026-08-10T00:00:00.000Z");
  const json = JSON.stringify(idx);
  assert.ok(!/accept|revert|adopt|baseline/i.test(json), "index must contain no accept-surface vocabulary");
});
