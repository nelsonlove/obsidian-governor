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

/** A raw source file: its vault-relative path and its full text (frontmatter
 * included), universal-newline-normalized (CRLF/CR → LF) to match Python's
 * `Path.read_text`. The ported legacy packs (structure/port/ste) scan raw text
 * line-by-line and apply the SAME regexes the Python scripts did, so they take
 * raw sources rather than the parsed `notes` listing. */
export interface SourceFile {
  path: string;
  text: string;
}

/** The read-only vault state a run sees. Built once by the engine's snapshot
 * layer (snapshot.ts, headless disk read) and shared by every pack. */
export interface VaultSnapshot {
  /** Every in-scope note with the frontmatter/body its consumers need
   * (vocab pack). */
  notes: VocabNote[];
  /** Every in-scope note path (the scheme pack's listing). */
  paths: string[];
  /** Every in-scope `.md` note's raw text (structure/port/ste packs). Optional
   * so a hand-built `{notes, paths}` snapshot (tests) still satisfies the type;
   * the legacy packs treat an absent listing as empty. */
  sources?: SourceFile[];
  /** Every `.blueprint` file's raw text (the structure pack's blueprint
   * sources — emitted-H2 derivation + `{% include %}` resolution). Optional
   * for the same reason. */
  blueprints?: SourceFile[];
}

export interface RulePack {
  /** Stable id — becomes the `script` field of every finding this pack emits,
   * and the ratchet key prefix. */
  readonly id: string;
  run(snapshot: VaultSnapshot): Finding[];
}
