// Handwritten diff — no dependency. Line-level LCS for the body (with an optional
// word-level refinement inside changed runs, the v0 "bonus"), and a key-by-key
// comparison for frontmatter. Read-only display data; nothing here writes.
//
// Ported verbatim from obsidian-stewardship/src/diff.ts (#83, cycle 1). Pure logic.

import { parseNote, frontmatterKeys } from "./frontmatter.js";

export type LineStatus = "same" | "added" | "removed";
export interface DiffLine {
  status: LineStatus;
  text: string;
  // For a "changed" pairing we still emit a removed line then an added line, but tag
  // them with word-level spans so the view can highlight intra-line edits.
  words?: WordSpan[];
}
export interface WordSpan {
  text: string;
  changed: boolean;
}

export type FmStatus = "unchanged" | "added" | "removed" | "changed";
export interface FmKeyDiff {
  key: string;
  status: FmStatus;
  base: string | null;
  current: string | null;
}

export interface NoteDiff {
  frontmatter: FmKeyDiff[];
  body: DiffLine[];
}

// ---- Frontmatter: key-by-key ----
export function diffFrontmatter(baseContent: string, curContent: string): FmKeyDiff[] {
  const baseKeys = frontmatterKeys(parseNote(baseContent).frontmatterText);
  const curKeys = frontmatterKeys(parseNote(curContent).frontmatterText);
  const allKeys: string[] = [];
  const seen = new Set<string>();
  for (const k of baseKeys.keys()) { if (!seen.has(k)) { seen.add(k); allKeys.push(k); } }
  for (const k of curKeys.keys()) { if (!seen.has(k)) { seen.add(k); allKeys.push(k); } }

  const out: FmKeyDiff[] = [];
  for (const key of allKeys) {
    const inBase = baseKeys.has(key);
    const inCur = curKeys.has(key);
    const b = inBase ? baseKeys.get(key)! : null;
    const c = inCur ? curKeys.get(key)! : null;
    let status: FmStatus;
    if (inBase && !inCur) status = "removed";
    else if (!inBase && inCur) status = "added";
    else if (b !== c) status = "changed";
    else status = "unchanged";
    out.push({ key, status, base: b, current: c });
  }
  return out;
}

// ---- Body: line-level LCS ----
export function diffLines(baseBody: string, curBody: string): DiffLine[] {
  const a = baseBody.split("\n");
  const b = curBody.split("\n");
  const dp = lcsMatrix(a, b); // suffix-LCS: dp[x][y] = LCS length of a[x:], b[y:]

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ status: "same", text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ status: "removed", text: a[i] });
      i++;
    } else {
      out.push({ status: "added", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ status: "removed", text: a[i++] });
  while (j < b.length) out.push({ status: "added", text: b[j++] });
  return refineWordSpans(out);
}

function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let x = m - 1; x >= 0; x--) {
    for (let y = n - 1; y >= 0; y--) {
      dp[x][y] = a[x] === b[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
    }
  }
  return dp;
}

// Bonus: where a removed line is immediately followed by an added line, compute a
// word-level diff between the pair and attach spans, so the view can highlight the
// changed words rather than the whole line.
function refineWordSpans(lines: DiffLine[]): DiffLine[] {
  for (let k = 0; k + 1 < lines.length; k++) {
    if (lines[k].status === "removed" && lines[k + 1].status === "added") {
      const { removedSpans, addedSpans } = wordDiff(lines[k].text, lines[k + 1].text);
      lines[k].words = removedSpans;
      lines[k + 1].words = addedSpans;
    }
  }
  return lines;
}

export function wordDiff(a: string, b: string): { removedSpans: WordSpan[]; addedSpans: WordSpan[] } {
  const aw = tokenize(a);
  const bw = tokenize(b);
  const dp = lcsMatrix(aw, bw);
  const removedSpans: WordSpan[] = [];
  const addedSpans: WordSpan[] = [];
  let i = 0, j = 0;
  while (i < aw.length && j < bw.length) {
    if (aw[i] === bw[j]) {
      removedSpans.push({ text: aw[i], changed: false });
      addedSpans.push({ text: bw[j], changed: false });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removedSpans.push({ text: aw[i], changed: true });
      i++;
    } else {
      addedSpans.push({ text: bw[j], changed: true });
      j++;
    }
  }
  while (i < aw.length) removedSpans.push({ text: aw[i++], changed: true });
  while (j < bw.length) addedSpans.push({ text: bw[j++], changed: true });
  return { removedSpans, addedSpans };
}

function tokenize(s: string): string[] {
  // Keep whitespace as its own tokens so reconstruction is lossless.
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

export function diffNote(baseContent: string, curContent: string): NoteDiff {
  return {
    frontmatter: diffFrontmatter(baseContent, curContent),
    body: diffLines(parseNote(baseContent).body, parseNote(curContent).body),
  };
}

// ---- Git-style unified-diff collapsing ----
// Pure, display-agnostic: walk the line list, keep `context` unchanged lines on each side of
// every added/removed run, and fold any longer unchanged gap — including a leading run before
// the first change or a trailing run after the last — into a single collapsed marker. Because
// visibility is computed independently around each change and then merged, two changes closer
// together than 2*context end up with overlapping (thus fully visible) context and are never
// split by a marker — they read as one hunk, same as `git diff`.
export interface HunkVisible {
  kind: "line";
  line: DiffLine;
}
export interface HunkCollapsed {
  kind: "collapsed";
  count: number;
  // The hidden lines themselves, so a renderer can expand the marker in place without needing
  // the original array/indices.
  lines: DiffLine[];
}
export type HunkItem = HunkVisible | HunkCollapsed;

export function toHunks(lines: DiffLine[], context = 3): HunkItem[] {
  const n = lines.length;
  const visible = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (lines[i].status !== "same") {
      const lo = Math.max(0, i - context);
      const hi = Math.min(n - 1, i + context);
      for (let j = lo; j <= hi; j++) visible[j] = true;
    }
  }
  const out: HunkItem[] = [];
  let i = 0;
  while (i < n) {
    if (visible[i]) {
      out.push({ kind: "line", line: lines[i] });
      i++;
    } else {
      let j = i;
      while (j < n && !visible[j]) j++;
      out.push({ kind: "collapsed", count: j - i, lines: lines.slice(i, j) });
      i = j;
    }
  }
  return out;
}
