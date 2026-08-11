// Ported from obsidian-stewardship/tests/diff.test.mjs (#83, cycle 1) — the pure
// handwritten diff (line-LCS + word refinement + git-style hunk collapsing), now at
// src/kernel/governance/diff.ts. Read-only display data; nothing here writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFrontmatter, diffLines, wordDiff, diffNote, toHunks } from "../src/kernel/governance/diff.ts";

function sameLines(n, prefix = "l") {
  return Array.from({ length: n }, (_, i) => ({ status: "same", text: `${prefix}${i}` }));
}

test("diffFrontmatter reports added / removed / changed / unchanged", () => {
  const base = "---\ntitle: A\nstatus: draft\nkeep: same\n---\nb";
  const cur = "---\ntitle: A\nstatus: final\nnew: x\n---\nb";
  const d = diffFrontmatter(base, cur);
  const byKey = Object.fromEntries(d.map((x) => [x.key, x.status]));
  assert.equal(byKey.title, "unchanged");
  assert.equal(byKey.status, "changed");
  assert.equal(byKey.keep, "removed");
  assert.equal(byKey.new, "added");
});

test("diffLines yields same/added/removed lines", () => {
  const d = diffLines("l1\nl2\nl3", "l1\nl2-edited\nl3\nl4");
  const kinds = d.map((x) => x.status);
  assert.ok(kinds.includes("same"));
  assert.ok(kinds.includes("removed"));
  assert.ok(kinds.includes("added"));
  // l4 is a pure addition at the end.
  assert.ok(d.some((x) => x.status === "added" && x.text === "l4"));
});

test("wordDiff marks only the changed tokens", () => {
  const { removedSpans, addedSpans } = wordDiff("the quick brown fox", "the slow brown fox");
  assert.ok(removedSpans.some((s) => s.text === "quick" && s.changed));
  assert.ok(addedSpans.some((s) => s.text === "slow" && s.changed));
  assert.ok(removedSpans.some((s) => s.text === "brown" && !s.changed));
});

test("diffNote combines frontmatter + body", () => {
  const d = diffNote("---\na: 1\n---\nbody", "---\na: 2\n---\nbody changed");
  assert.equal(d.frontmatter.find((f) => f.key === "a").status, "changed");
  assert.ok(d.body.some((l) => l.status === "removed"));
});

// ---- toHunks ----

test("toHunks: single change deep in a long unchanged file collapses both sides", () => {
  const lines = [
    ...sameLines(50, "before"),
    { status: "removed", text: "old" },
    { status: "added", text: "new" },
    ...sameLines(50, "after"),
  ];
  const hunks = toHunks(lines, 3);

  const collapsed = hunks.filter((h) => h.kind === "collapsed");
  assert.equal(collapsed.length, 2, "expected exactly one leading and one trailing marker");
  // 50 unchanged lines with 3 kept as context => 47 hidden on each side.
  assert.equal(collapsed[0].count, 47);
  assert.equal(collapsed[1].count, 47);
  assert.equal(collapsed[0].lines.length, 47);

  const visibleLines = hunks.filter((h) => h.kind === "line");
  // 3 context + removed + added + 3 context = 8 visible lines.
  assert.equal(visibleLines.length, 8);
  assert.equal(visibleLines[0].line.text, "before47");
  assert.equal(visibleLines[visibleLines.length - 1].line.text, "after2");
});

test("toHunks: changes closer than 2*context merge into one visible run (no marker between)", () => {
  const lines = [
    ...sameLines(20),
    { status: "removed", text: "a-old" },
    { status: "added", text: "a-new" },
    ...sameLines(4, "mid"), // gap of 4 < 2*context(6) -> should NOT collapse
    { status: "removed", text: "b-old" },
    { status: "added", text: "b-new" },
    ...sameLines(20, "tail"),
  ];
  const hunks = toHunks(lines, 3);
  const collapsed = hunks.filter((h) => h.kind === "collapsed");
  // Only leading + trailing collapse; nothing between the two changes.
  assert.equal(collapsed.length, 2);
  // The 4 "mid" lines must all appear as plain visible lines, uncollapsed.
  const midTexts = hunks
    .filter((h) => h.kind === "line")
    .map((h) => h.line.text)
    .filter((t) => t.startsWith("mid"));
  assert.equal(midTexts.length, 4);
});

test("toHunks: no changes collapses the whole file into a single marker", () => {
  const lines = sameLines(30);
  const hunks = toHunks(lines, 3);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].kind, "collapsed");
  assert.equal(hunks[0].count, 30);
});

test("toHunks: all lines changed leaves nothing collapsed", () => {
  const lines = [
    { status: "removed", text: "x1" },
    { status: "added", text: "y1" },
    { status: "removed", text: "x2" },
    { status: "added", text: "y2" },
  ];
  const hunks = toHunks(lines, 3);
  assert.ok(hunks.every((h) => h.kind === "line"));
  assert.equal(hunks.length, 4);
});

test("toHunks: leading and trailing unchanged runs collapse independently", () => {
  const lines = [
    ...sameLines(10, "lead"),
    { status: "added", text: "only-change" },
    ...sameLines(10, "trail"),
  ];
  const hunks = toHunks(lines, 3);
  assert.equal(hunks[0].kind, "collapsed");
  assert.equal(hunks[0].count, 7); // 10 - 3 context
  assert.equal(hunks[hunks.length - 1].kind, "collapsed");
  assert.equal(hunks[hunks.length - 1].count, 7);
});

test("toHunks: empty input yields no hunks", () => {
  assert.deepEqual(toHunks([], 3), []);
});
