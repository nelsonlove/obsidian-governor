// The pending-review queue derivation (#83, cycle 2). Ported from obsidian-stewardship/tests/
// queue.test.mjs. Pure: computeQueue is obsidian-free.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeQueue, groupByAgent } from "../src/governor/kernel/queue.ts";
import { contentHash } from "../src/governor/kernel/hash.ts";
import { parseJournal } from "../src/governor/kernel/journal-reader.ts";

const baseline = (path, content, at) => ({ path, content, hash: contentHash(content), acceptedAt: at, acceptedBy: "seed" });
const jrec = (o) => JSON.stringify(o);
const AGENT = (client) => ({ transport: "mcp", client, connection: "c" });

test("agent write since baseline → note is pending", () => {
  const baselines = { "A.md": baseline("A.md", "old", "2026-08-09T00:00:00.000Z") };
  const journal = parseJournal(jrec({
    ts: "2026-08-09T10:00:00.000Z", op: "obsidian_append_note",
    target: { path: "A.md" }, actor: AGENT("agent-x/1.0"), outcome: "ok",
  }));
  const q = computeQueue({
    notes: [{ path: "A.md", content: "old + agent addition" }],
    getBaseline: (p) => baselines[p] ?? null,
    journal,
  });
  assert.equal(q.length, 1);
  assert.equal(q[0].path, "A.md");
  assert.equal(q[0].agent, "agent-x/1.0");
  assert.equal(q[0].op, "obsidian_append_note");
});

test("human edit (differs from baseline, NO agent journal write) → NOT queued", () => {
  const baselines = { "A.md": baseline("A.md", "old", "2026-08-09T00:00:00.000Z") };
  const q = computeQueue({
    notes: [{ path: "A.md", content: "old, edited by the human in the editor" }],
    getBaseline: (p) => baselines[p] ?? null,
    journal: [], // no MCP record — humans don't journal
  });
  assert.equal(q.length, 0);
});

test("content identical to baseline → NOT queued even if an agent wrote (write was accepted)", () => {
  const baselines = { "A.md": baseline("A.md", "same", "2026-08-09T00:00:00.000Z") };
  const journal = parseJournal(jrec({
    ts: "2026-08-09T10:00:00.000Z", op: "obsidian_write_note",
    target: { path: "A.md" }, actor: AGENT("a"), outcome: "ok",
  }));
  const q = computeQueue({ notes: [{ path: "A.md", content: "same" }], getBaseline: (p) => baselines[p] ?? null, journal });
  assert.equal(q.length, 0);
});

test("agent write BEFORE the baseline's accepted-at → NOT queued (already accepted)", () => {
  const baselines = { "A.md": baseline("A.md", "old", "2026-08-09T10:30:00.000Z") };
  const journal = parseJournal(jrec({
    ts: "2026-08-09T10:00:00.000Z", op: "obsidian_write_note",
    target: { path: "A.md" }, actor: AGENT("a"), outcome: "ok",
  }));
  const q = computeQueue({ notes: [{ path: "A.md", content: "changed" }], getBaseline: (p) => baselines[p] ?? null, journal });
  assert.equal(q.length, 0);
});

test("agent-created note with NO baseline → queued as a full add", () => {
  const journal = parseJournal(jrec({
    ts: "2026-08-09T10:00:00.000Z", op: "obsidian_write_note",
    target: { path: "New.md" }, actor: AGENT("mk/1.0"), outcome: "ok",
  }));
  const q = computeQueue({ notes: [{ path: "New.md", content: "brand new" }], getBaseline: () => null, journal });
  assert.equal(q.length, 1);
  assert.equal(q[0].hadBaseline, false);
});

test("pending item carries the latest write's intent when present", () => {
  const baselines = { "A.md": baseline("A.md", "old", "2026-08-09T00:00:00.000Z") };
  const journal = parseJournal([
    jrec({ ts: "2026-08-09T10:00:00.000Z", op: "obsidian_append_note", target: { path: "A.md" }, actor: AGENT("agent-x/1.0"), outcome: "ok", intent: "first pass" }),
    jrec({ ts: "2026-08-09T10:05:00.000Z", op: "obsidian_write_note", target: { path: "A.md" }, actor: AGENT("agent-x/1.0"), outcome: "ok", intent: "Tightened the intro per the style guide." }),
  ].join("\n"));
  const q = computeQueue({
    notes: [{ path: "A.md", content: "old + agent addition, tightened" }],
    getBaseline: (p) => baselines[p] ?? null,
    journal,
  });
  assert.equal(q.length, 1);
  assert.equal(q[0].intent, "Tightened the intro per the style guide.");
});

test("pending item omits intent (undefined, not empty string) when the journal record has none", () => {
  const baselines = { "A.md": baseline("A.md", "old", "2026-08-09T00:00:00.000Z") };
  const journal = parseJournal(jrec({
    ts: "2026-08-09T10:00:00.000Z", op: "obsidian_write_note",
    target: { path: "A.md" }, actor: AGENT("a"), outcome: "ok", // no intent field
  }));
  const q = computeQueue({ notes: [{ path: "A.md", content: "old, changed" }], getBaseline: (p) => baselines[p] ?? null, journal });
  assert.equal(q.length, 1);
  assert.equal(q[0].intent, undefined);
});

test("groupByAgent buckets pending items by client", () => {
  const items = [
    { agent: "x", path: "1" }, { agent: "y", path: "2" }, { agent: "x", path: "3" },
  ];
  const groups = groupByAgent(items);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.agent === "x").items.length, 2);
});
