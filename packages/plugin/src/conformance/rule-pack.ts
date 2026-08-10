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
  /** Every FILE path under root (all extensions, not just note types), for the
   * drift pack's `.exists()` checks (`user-script` / `module` / `template`
   * surfaces resolve to arbitrary files — `.js` library scripts, `.md`
   * templates). Skip-dirs and `excludedRoots` are pruned, matching the walk.
   * Optional so a hand-built snapshot (tests, other packs) is unaffected. */
  files?: string[];
  /** Every DIRECTORY path under root (skip-dirs/`excludedRoots` pruned), for
   * the drift pack's `.exists()` checks and its category-collision scan (J,
   * which enumerates the `00-09 System` spine's direct children). Optional. */
  dirs?: string[];
  /** Every collected `.md` note path in Python-`rglob` TRAVERSAL ORDER (raw
   * directory order, a directory's files before its subdirectories, pre-order
   * DFS) — NOT sorted. The drift pack's uid checks (E duplicate-uid, F
   * uid-coverage) embed a traversal-ordered sample of paths in their finding
   * KEY, so they must iterate the exact order `drift_audit.py`'s `iter_notes`
   * did. Every other pack (and drift's other checks) is order-independent and
   * reads the sorted listings above. Optional. */
  walkOrder?: string[];
  /** Raw text of the specific `.obsidian` config files the drift pack reads —
   * `.obsidian/community-plugins.json`, `.obsidian/plugins/quickadd/data.json`,
   * and each `.obsidian/plugins/<id>/manifest.json` — keyed by their
   * vault-relative path. These live under a skip-dir, so the walk never
   * collects them; the snapshot reads this fixed set explicitly. Optional. */
  obsidianConfig?: SourceFile[];
}

export interface RulePack {
  /** Stable id — becomes the `script` field of every finding this pack emits,
   * and the ratchet key prefix. */
  readonly id: string;
  run(snapshot: VaultSnapshot): Finding[];
}
