// When a vault DELETE must invalidate the pending-review queue.
//
// The queue is recomputed by `refresh()` (wiring.ts), which is driven by two
// things: an explicit Refresh click, and a poll that only fires when the
// vault-mcp write JOURNAL grows. A human deleting a note in Obsidian writes no
// journal record — so before this module the deleted note sat in the sidebar
// queue until an unrelated agent write happened to land, offering Accept on a
// file that no longer exists.
//
// The decision lives here, pure, rather than inline in the event handler, for
// the reason mount-state.ts exists: the registration itself (registerEvent,
// TFile/TFolder instanceof, debounce timers) is not headlessly testable, but
// "does this deletion change the queue?" is, and it is the part with edge cases
// worth pinning.
//
// It is a NARROWING check, never a widening one: a false negative leaves the
// stale row this fix exists to remove, so every uncertain case must answer
// true. Deleting something the queue never contained is the only case that
// answers false — and that case is the common one (most deletes are not
// pending notes), which is what keeps this from recomputing the whole governed
// corpus on every unrelated delete.

/**
 * Whether deleting `deletedPath` requires recomputing the pending queue.
 *
 * @param deletedPath  vault-relative path of the deleted file or folder.
 * @param isFolder     true when Obsidian reported a TFolder. A folder delete
 *                     does not reliably fire a per-child event, so a folder is
 *                     matched as a PREFIX against every pending path.
 * @param pendingPaths the paths currently in the queue (the cached queue —
 *                     what the sidebar is actually showing right now).
 */
export function deleteInvalidatesQueue(
  deletedPath: string,
  isFolder: boolean,
  pendingPaths: Iterable<string>
): boolean {
  const target = normalize(deletedPath);
  if (target === "") {
    // The vault root (or an unnameable path): cannot reason about it — answer
    // true and let the refresh sort it out. Cheap, and never wrong-in-the-
    // dangerous-direction.
    return true;
  }
  // A folder match must be at a SEGMENT boundary: deleting "Notes" must not
  // invalidate on "Notes archive/x.md" (same prefix, different folder), and
  // must invalidate on "Notes/x.md". The same trap the lock scopes document.
  const folderPrefix = target + "/";
  for (const raw of pendingPaths) {
    const pending = normalize(raw);
    if (pending === target) return true;
    if (isFolder && pending.startsWith(folderPrefix)) return true;
  }
  return false;
}

/**
 * Path comparison for the check above. Obsidian hands out vault-relative paths
 * with forward slashes and no leading slash, but the pending list is data that
 * has been through a publish/read round-trip, so both sides are normalized
 * rather than trusted: leading "./" and "/" dropped, duplicate slashes
 * collapsed, one trailing slash removed. Deliberately NOT a case fold — APFS is
 * case-insensitive but Obsidian's own paths are case-preserving, and folding
 * here would make two genuinely distinct pending paths look like one.
 */
function normalize(path: string): string {
  return path
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}
