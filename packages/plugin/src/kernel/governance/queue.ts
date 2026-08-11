// The pending-review queue — pure derivation, no I/O. Ported from
// obsidian-stewardship/src/queue.ts (#83, cycle 2). Obsidian-free, headless-testable.
//
// A note is PENDING when:
//   (1) its current content differs from its stored baseline, AND
//   (2) the write journal shows an agent (MCP) content-write to it since the baseline's
//       accepted-at timestamp.
// Condition (2) is what keeps the human's own editor edits out of the queue: those never
// pass through MCP, so they leave no journal record and can never satisfy (2). A note that
// merely differs (human edit) is NOT queued here — and separately, the modify-classifier
// advances its baseline silently so it doesn't linger as a phantom diff.
//
// A note with NO baseline at all (e.g. an agent created it after adopt-baseline) is treated
// as having an empty baseline accepted at epoch, so any agent write surfaces it as a full add.

import { contentHash } from "./hash.js";
import type { Baseline } from "./baseline-store.js";
import { agentWritesSince, type JournalRecord } from "./journal-reader.js";
import type { PendingItem } from "./pending-types.js";

export type { PendingItem } from "./pending-types.js";

export interface NoteSnapshot { path: string; content: string; }

export interface QueueInputs {
  notes: NoteSnapshot[];
  getBaseline: (path: string) => Baseline | null;
  journal: JournalRecord[];
}

const EPOCH = new Date(0).toISOString();
const EMPTY_HASH = contentHash("");

export function computeQueue(inputs: QueueInputs): PendingItem[] {
  const { notes, getBaseline, journal } = inputs;
  const out: PendingItem[] = [];
  for (const note of notes) {
    const baseline = getBaseline(note.path);
    const baseHash = baseline ? baseline.hash : EMPTY_HASH;
    const since = baseline ? baseline.acceptedAt : EPOCH;

    if (contentHash(note.content) === baseHash) continue; // unchanged vs baseline

    const writes = agentWritesSince(journal, note.path, since);
    if (writes.length === 0) continue; // differs, but not attributable to an agent → not queued

    const latest = writes[writes.length - 1];
    out.push({
      path: note.path,
      title: titleOf(note.path),
      agent: latest.client,
      op: latest.op,
      when: latest.ts,
      writeCount: writes.length,
      writes,
      hadBaseline: baseline !== null,
      intent: latest.intent,
    });
  }
  // Newest activity first.
  out.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
  return out;
}

// Group pending items by agent (client) for the pane. Stable order: most-recent group first.
export function groupByAgent(items: PendingItem[]): { agent: string; items: PendingItem[] }[] {
  const groups = new Map<string, PendingItem[]>();
  for (const it of items) {
    const arr = groups.get(it.agent) ?? [];
    arr.push(it);
    groups.set(it.agent, arr);
  }
  return [...groups.entries()].map(([agent, items]) => ({ agent, items }));
}

function titleOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}
