// inbox.ts — the triage instance's QUEUE PREDICATE, pure over a path string
// (#221 phase 2). "Is this note an inbox item?" is answered from the path
// alone: a note is an inbox item when any ancestor FOLDER's name contains one
// of the configured inbox markers (default " Inbox for ", the live vault's
// convention — e.g. `00-09 System/03 Agents/03.10 Inbox for 03 Agents/x.md`).
//
// The inbox folder's own FOLDER NOTE (basename equal to its parent folder's
// name) is NOT an item — it IS the inbox — and is excluded.
//
// Deliberately path-only: queue VIEWS are native (a Base over frontmatter or
// folder), and membership must be checkable without reading a single file.

/**
 * The nearest inbox folder containing `path`, or null when the note is not an
 * inbox item under the given markers. Matching is a case-sensitive substring
 * test per folder-name segment; when several nested folders match, the
 * DEEPEST match wins (the note's immediate inbox).
 */
export function inboxFolderOf(path: string, markers: string[]): string | null {
  const segments = path.split("/");
  if (segments.length < 2) return null; // a root-level note has no folder to match
  const folders = segments.slice(0, -1);
  let match: string | null = null;
  let acc = "";
  for (const seg of folders) {
    acc = acc === "" ? seg : `${acc}/${seg}`;
    if (markers.some((m) => m !== "" && seg.includes(m))) match = acc;
  }
  if (match === null) return null;
  const basename = segments[segments.length - 1].replace(/\.md$/i, "");
  if (basename === folders[folders.length - 1]) return null; // the inbox's folder note
  return match;
}

export interface QueueRow {
  path: string;
  /** The nearest enclosing inbox folder. */
  inbox: string;
  /** Creation time (ms epoch) or null when unknown. */
  created: number | null;
  /** Last-modified time (ms epoch) or null when unknown. */
  modified: number | null;
  /** Frontmatter `type` / `status`, or null. */
  type: string | null;
  status: string | null;
}

/** Oldest first by creation time; unknown-created rows sort last; path is the
 * deterministic tiebreak. Pure — sorts a copy. */
export function sortQueue(rows: QueueRow[]): QueueRow[] {
  return [...rows].sort((a, b) => {
    if (a.created === null && b.created === null) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    if (a.created === null) return 1;
    if (b.created === null) return -1;
    if (a.created !== b.created) return a.created - b.created;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}
