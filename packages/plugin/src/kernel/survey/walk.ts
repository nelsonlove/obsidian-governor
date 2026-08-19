// kernel/survey/walk.ts — pure directory-walk core for the survey module.
//
// Ported from the standalone `obsidian-jd-survey` plugin's `walker.ts`. The
// mirror directory being walked lives on the real filesystem, outside the
// vault, so this is real fs traversal rather than an Obsidian vault read —
// but the traversal itself takes an injected `DirLister` rather than calling
// `fs` directly, so it stays pure and headless-testable the way the rest of
// this kernel is (see provenance-config.ts's "Obsidian-free" convention,
// applied here to "filesystem-free" instead).

/** One directory entry, as the injected lister reports it. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

/** Reads one directory's immediate children. Production wiring uses
 *  `fs.readdirSync(path, { withFileTypes: true })`; tests inject a fake. */
export type DirLister = (path: string) => DirEntry[];

export interface WalkResult {
  /** Files found (not directories), at any depth up to `depth`. */
  items: number;
  /** Subdirectories that are themselves empty (no items, no further subdirs) —
   *  ported from jd-survey's "stubs" count: placeholder folders with nothing
   *  in them yet. */
  stubs: number;
  /** Depth actually reached is capped by `depth`; a deeper tree is not an
   *  error, just not counted past the configured limit. */
  depthReached: number;
}

const DOTFILE = /^\./;

/**
 * Walk `root` up to `depth` levels (0 = root's immediate children only),
 * counting files as items and empty subdirectories as stubs. Dotfiles and
 * dot-directories are skipped — mirrors jd-survey's own ignore rule, and
 * keeps `.git`/`.DS_Store` out of a count meant to reflect real content.
 *
 * Never throws on a listing failure for a subdirectory (e.g. a permissions
 * error, or a symlink that resolves outside the tree): that branch is
 * counted as a stub rather than aborting the whole walk, so one bad
 * subdirectory does not blank out an otherwise-good survey.
 */
export function walk(root: string, depth: number, list: DirLister): WalkResult {
  let items = 0;
  let stubs = 0;
  let depthReached = 0;

  function visit(dir: string, level: number): void {
    depthReached = Math.max(depthReached, level);
    let entries: DirEntry[];
    try {
      entries = list(dir).filter((e) => !DOTFILE.test(e.name));
    } catch {
      stubs += 1;
      return;
    }
    if (entries.length === 0) {
      stubs += 1;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (level < depth) {
          visit(`${dir}/${entry.name}`, level + 1);
        } else {
          // At the depth ceiling: count the subdirectory's presence as an
          // item rather than descending into it, so a deep tree still
          // contributes something to the count instead of vanishing.
          items += 1;
        }
      } else {
        items += 1;
      }
    }
  }

  visit(root, 0);
  return { items, stubs, depthReached };
}
