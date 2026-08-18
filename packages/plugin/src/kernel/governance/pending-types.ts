// The PendingItem shape — the computed review-queue entry that the pending-index
// serializer reshapes for external readers.
//
// In obsidian-stewardship this type lived in src/queue.ts alongside `computeQueue`
// (the pure derivation of what is pending). #83 cycle 1 moves the SERIALIZER
// (pending-index.ts) but not the queue-computation logic, so this file carries the
// one small type the serializer needs ("+ any small types they need"). The queue
// computation itself folds in with the modify-listener wiring in a later cycle.

import type { AgentWrite } from "./journal-reader.js";

export interface PendingItem {
  path: string;
  title: string;
  agent: string;   // client of the most recent agent write
  op: string;      // op of the most recent agent write
  when: string;    // ts (ISO) of the most recent agent write
  writeCount: number;
  writes: AgentWrite[];
  hadBaseline: boolean;
  // UNTRUSTED agent-authored "why" note from the latest write, verbatim — absent when the
  // journal record predates the intent field or the agent didn't supply one. Render as a
  // plain text node only.
  intent?: string;
  // #224 governance watch: this row surfaced because a DECLARED protected property drifted
  // from the blessed baseline through a NON-journaled path (another plugin, a script, Sync) —
  // no agent write attributes it. The change is already INERT (honor-only-if-blessed); the
  // row exists so it is SEEN and can be accepted (bless) or reverted. `protectedKeys` names
  // the drifted declared keys.
  sideDoor?: boolean;
  protectedKeys?: string[];
}
