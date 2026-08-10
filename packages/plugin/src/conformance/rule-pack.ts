// rule-pack.ts — the RulePack contract and the vault snapshot packs run over.
//
// A rule pack is a named producer of Findings over a supplied snapshot — the
// same "rail feeds a listing, pack returns typed findings" contract the module
// findings functions already honor (they are pure over an injected listing).
// The module adapters (packs/) wrap `noteVocabFindings` / `schemeFindings`;
// the ported legacy checks (phase 2) implement `run` directly. No pack reads
// the vault itself — the engine injects the snapshot.

import type { Finding } from "./finding.js";
import type { VocabNote } from "../kernel/vocab/blueprint.js";

/** A snapshot note: the structured shape the vocab pack consumes (path,
 * frontmatter, body) PLUS the raw full text the line-oriented legacy packs
 * (port_lint, ste_lint) scan. `text` is the CRLF-normalized full file content
 * (frontmatter block included), so line numbers match the on-disk note. */
export type SnapshotNote = VocabNote & { text: string };

/** The read-only vault state a run sees. Built once by the engine's snapshot
 * layer (snapshot.ts, headless disk read) and shared by every pack. */
export interface VaultSnapshot {
  /** Every in-scope note with the frontmatter/body its consumers need. */
  notes: SnapshotNote[];
  /** Every in-scope note path (the scheme pack's listing). */
  paths: string[];
}

export interface RulePack {
  /** Stable id — becomes the `script` field of every finding this pack emits,
   * and the ratchet key prefix. */
  readonly id: string;
  run(snapshot: VaultSnapshot): Finding[];
}
