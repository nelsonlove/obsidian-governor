// Ported from obsidian-stewardship/tests/journal-reader.test.mjs (#83, cycle 1) — the
// pure vault-mcp-write-journal reader, now at src/kernel/governance/journal-reader.ts.
// READER only; parses already-loaded JSONL text, no obsidian runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJournal, agentWritesSince, recentAgentWrite } from "../src/kernel/governance/journal-reader.ts";

const rec = (o) => JSON.stringify(o);
const AGENT = { transport: "mcp", client: "agent-x/1.0", connection: "c1" };

const lines = [
  rec({ ts: "2026-08-09T10:00:00.000Z", op: "obsidian_append_note", target: { path: "A.md" }, actor: AGENT, outcome: "ok" }),
  rec({ ts: "2026-08-09T10:05:00.000Z", op: "obsidian_write_note", target: { path: "A.md" }, actor: AGENT, outcome: "ok" }),
  rec({ ts: "2026-08-09T10:06:00.000Z", op: "obsidian_move_note", target: { path: "A.md" }, actor: AGENT, outcome: "ok" }),
  rec({ ts: "2026-08-09T10:07:00.000Z", op: "obsidian_write_note", target: { path: "B.md" }, actor: AGENT, outcome: "ok" }),
  "   ",
  "{ this is not json",
].join("\n");

test("parseJournal skips blank and malformed lines", () => {
  const recs = parseJournal(lines);
  assert.equal(recs.length, 4); // 4 valid records; blank + bad-json dropped
});

test("agentWritesSince filters by path, op-is-content-write, transport, and ts", () => {
  const recs = parseJournal(lines);
  // Only writes to A.md strictly after 10:00 → the 10:05 write (10:00 is not strictly after; move excluded).
  const w = agentWritesSince(recs, "A.md", "2026-08-09T10:00:00.000Z");
  assert.equal(w.length, 1);
  assert.equal(w[0].op, "obsidian_write_note");
  assert.equal(w[0].client, "agent-x/1.0");
});

test("agentWritesSince from epoch returns all content writes to the path, oldest first", () => {
  const recs = parseJournal(lines);
  const w = agentWritesSince(recs, "A.md", new Date(0).toISOString());
  assert.deepEqual(w.map((x) => x.op), ["obsidian_append_note", "obsidian_write_note"]);
});

test("human/editor edits never appear (no mcp transport record)", () => {
  const human = parseJournal(rec({ ts: "2026-08-09T11:00:00.000Z", op: "obsidian_write_note", target: { path: "A.md" }, actor: { transport: "editor" }, outcome: "ok" }));
  assert.equal(agentWritesSince(human, "A.md", new Date(0).toISOString()).length, 0);
});

test("recentAgentWrite honours the window", () => {
  const recs = parseJournal(lines);
  assert.equal(recentAgentWrite(recs, "A.md", "2026-08-09T10:05:03.000Z", 15000), true);
  assert.equal(recentAgentWrite(recs, "A.md", "2026-08-09T10:30:00.000Z", 15000), false);
});

test("agentWritesSince carries the optional `intent` field through when present", () => {
  const withIntent = parseJournal(rec({
    ts: "2026-08-09T12:00:00.000Z", op: "obsidian_write_note", target: { path: "C.md" },
    actor: AGENT, outcome: "ok", intent: "Fixing the broken frontmatter date format.",
  }));
  const w = agentWritesSince(withIntent, "C.md", new Date(0).toISOString());
  assert.equal(w.length, 1);
  assert.equal(w[0].intent, "Fixing the broken frontmatter date format.");
});

test("agentWritesSince leaves `intent` undefined on older records that lack it", () => {
  const recs = parseJournal(lines); // none of these records have an intent field
  const w = agentWritesSince(recs, "A.md", new Date(0).toISOString());
  assert.equal(w.length, 2);
  for (const write of w) assert.equal(write.intent, undefined);
});

test("agentWritesSince ignores a malformed (non-string) `intent` rather than propagating it", () => {
  const malformed = parseJournal(rec({
    ts: "2026-08-09T12:00:00.000Z", op: "obsidian_write_note", target: { path: "D.md" },
    actor: AGENT, outcome: "ok", intent: { not: "a string" },
  }));
  const w = agentWritesSince(malformed, "D.md", new Date(0).toISOString());
  assert.equal(w.length, 1);
  assert.equal(w[0].intent, undefined);
});

test("agentWritesSince preserves intent verbatim, including markup-like text (no interpretation here)", () => {
  const raw = "Rewriting per <script>alert(1)</script> [[wikilink]] {{template}}\nline two";
  const recs = parseJournal(rec({
    ts: "2026-08-09T12:00:00.000Z", op: "obsidian_write_note", target: { path: "E.md" },
    actor: AGENT, outcome: "ok", intent: raw,
  }));
  const w = agentWritesSince(recs, "E.md", new Date(0).toISOString());
  assert.equal(w[0].intent, raw); // parsing layer must not alter or strip anything
});
