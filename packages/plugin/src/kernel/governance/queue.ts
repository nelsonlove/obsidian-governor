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
// ONE scoped exception (#224): a note that differs WITHOUT any agent write still surfaces
// when a DECLARED protected property drifted from the blessed baseline (the injected
// `protectedDrift` detector) — a side-door write to protected state is inert until blessed,
// but it must be SEEN. Human editor edits to such a property don't linger here either: the
// reconcile attributes them and advances the baseline, at which point there is no drift.
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
  /**
   * #224 governance watch: given (blessed baseline content, current content),
   * the declared protected-property keys that drifted — wired to
   * `protectedPropertyDrift` (protected-policy.ts). When present, a note that
   * differs from its baseline WITHOUT any agent write still surfaces iff a
   * declared property drifted (a side-door write to protected state must be
   * SEEN, not silently inert forever). Absent ⇒ the historical queue exactly.
   */
  protectedDrift?: (blessed: string, current: string) => string[];
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
    if (writes.length === 0) {
      // Differs, but not attributable to an agent → not queued — UNLESS a
      // declared protected property drifted from the blessed baseline (#224):
      // a side-door write to protected state is inert (honor-only-if-blessed)
      // but must surface for review rather than linger invisibly. Requires a
      // real baseline: with none, nothing was ever blessed to drift FROM (and
      // the human-edit reconcile path advances attributed edits before they
      // could surface here). Any drift-detector exception → fail toward the
      // historical behavior (not queued) rather than failing the whole queue.
      if (baseline && inputs.protectedDrift) {
        let drifted: string[] = [];
        try {
          drifted = inputs.protectedDrift(baseline.content, note.content);
        } catch {
          drifted = [];
        }
        if (drifted.length > 0) {
          out.push({
            path: note.path,
            title: titleOf(note.path),
            agent: "(side-door)",
            op: "external-write",
            when: baseline.acceptedAt,
            writeCount: 0,
            writes: [],
            hadBaseline: true,
            sideDoor: true,
            protectedKeys: drifted,
          });
        }
      }
      continue;
    }

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
