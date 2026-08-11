// Read-only pending-index serializer — a pure, obsidian-free view of the review queue
// (PendingItem[]) so the vault-mcp READ tool (obsidian_pending_review, #75) can let agents
// SEE which notes have unaccepted changes, without granting any accept/revert/adopt capability.
//
// This is a DATA publish only: every field below is already shown in the review pane. It is
// derived ENTIRELY from the computed queue — no new source of truth, no new read of note
// content, no secrets. `status` is always the literal "pending" because only items already IN
// the queue are serialized here; this module never decides what is pending, it only reshapes
// the result for external readers.
//
// Kept pure (no vault/adapter access) so it unit-tests without the `obsidian` runtime.
//
// Ported verbatim from obsidian-stewardship/src/pending-index.ts (#83, cycle 1); its only
// dependency, the PendingItem type, now lives in ./pending-types.js (queue.ts was not folded
// this cycle). The bytes it produces are the exact bytes obsidian_pending_review parses.

import type { PendingItem } from "./pending-types.js";

export interface PendingIndexEntry {
  path: string;
  status: "pending";
  agent: string;
  op: string;
  when: string;
  writeCount: number;
}

export interface PendingIndex {
  version: 1;
  generatedAt: string;
  pending: PendingIndexEntry[];
}

export function pendingIndex(items: PendingItem[], generatedAt: string): PendingIndex {
  return {
    version: 1,
    generatedAt,
    pending: items.map((it) => ({
      path: it.path,
      status: "pending",
      agent: it.agent,
      op: it.op,
      when: it.when,
      writeCount: it.writeCount,
    })),
  };
}

// The exact bytes written to pending-index.json (pretty-printed, stable key order).
export function serializePendingIndex(items: PendingItem[], generatedAt: string): string {
  return JSON.stringify(pendingIndex(items, generatedAt), null, 2);
}
