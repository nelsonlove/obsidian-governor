// inbox.ts — Stage B of the jd-dashboard fold: the "XX.01 Unsorted/Inbox"
// rollup jd-dashboard's InboxDashboardView showed in a sidebar pane.
//
// Ported from obsidian-jd-dashboard/src/scanner.ts's `scanInboxes` (area/
// category/id folder-shape regexes carried over VERBATIM: AREA_RE, CATEGORY_RE,
// ID_RE, the ".01" + "Unsorted"/"Inbox" title-prefix test, and scanInboxes's
// own inline cover-note/dot-file/+README exclusion — NOT `isCoverNote`, a
// different function in the original file used only by its drift scanner),
// but reworked from an `app.vault` TFolder tree
// walk to operate purely over a flat markdown-path listing — same "pure, no
// obsidian import" discipline as the rest of this directory (findings.ts,
// jd.ts). This is genuinely a scope-provider-shaped question ("what's in this
// address prefix") but is written as a self-contained function rather than
// through `ScopeProvider.membersOf`/`expectedFolder`: those two answer "what
// notes carry an address under scope S" and "what folder should THIS address's
// OWN note live in" respectively — neither answers "what is the actual vault
// folder path of a specific `.01` id, so its contents can be counted", because
// an id's own folder is deliberately not a `membersOf`-style scope container
// (jd.ts's scopesAlongPath: "an id/fractal-id folder — an id's own
// attachment-folder, not a new scope container"). Extending the ScopeProvider
// interface for this one pane's sake would touch jd.ts, a shared, tested,
// load-bearing file, for a feature only this module needs — so `.01`
// = "Inbox" (already named as such in kernel/jd-scaffold/standard-zeros.ts's
// ZeroSpec table) is treated as JD-domain knowledge local to this file,
// matching the precedent of category-index.ts's own local ID_RE.
//
// Counting-fidelity note: the original counts DIRECT TFolder children (files
// AND subfolders, one level deep, so a subfolder counts as "1" regardless of
// what — or how much — is inside it, and non-markdown attachments count too),
// excluding the cover note, any dot-prefixed name, and any name containing
// "+README" (a documented legacy-leftover exclusion). This module only ever
// sees markdown note paths, so it approximates the TFolder count by counting
// DISTINCT direct entry names under the inbox folder — a bare filename for a
// note directly in the folder, or a subfolder's own name (deduped) for
// anything nested one or more levels deeper — applying the same cover-note/
// dot-file/+README exclusions to that name set. This still undercounts versus
// the original in two ways, both accepted as the fold's known reduction: a
// non-markdown attachment sitting directly in the inbox folder is invisible,
// and an entirely-empty subfolder (no markdown notes anywhere inside it) is
// invisible. Everything else — which folder counts as which item, the three
// exclusions, the busiest-first sort, the area grouping — matches the
// original exactly.
//
// This function does NOT filter by a scheme instance's `excludedRoots` —
// that is the wiring layer's job (scheme/wiring.ts), applied to the `notes`
// listing BEFORE it reaches this function, so an excluded root is invisible
// to both discovery and counting here without this pure function needing to
// know about scheme instances at all.

const AREA_RE = /^(\d{2})-(\d{2})\s+(.+)$/;
const CATEGORY_RE = /^(\d{2})\s+(.+)$/;
const ID_RE = /^(\d{2}\.\d{2}|\d{5})\s+(.+)$/;
const INBOX_SUFFIXES = ["Unsorted", "Inbox"];

export interface InboxItem {
  /** Category folder's full display name, e.g. "26 Divorce". */
  category: string;
  /** The .01 folder's full display name, e.g. "26.01 Unsorted". */
  inboxFolder: string;
  /** Full vault path to the inbox folder. */
  path: string;
  /** Distinct direct entries (files or subfolder names) under the inbox
   *  folder, excluding its own cover note — see the counting-fidelity note
   *  above for exactly what this does and doesn't see. */
  count: number;
}

export interface InboxAreaGroup {
  /** Area folder's full display name, e.g. "20-29 Personal". */
  area: string;
  /** This area's non-empty inboxes, busiest-first. */
  items: InboxItem[];
}

/** Vault-root-relative folder segments a note's path descends through
 *  (drops the filename itself). */
function folderSegments(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1);
}

/**
 * Scan a flat markdown-note listing for every `XX.01 Unsorted`/`XX.01 Inbox`
 * folder — matching the original's `<area>/<category>/<id>` nesting depth
 * exactly (areas are only ever recognized at the vault root, same as the
 * original only scanning `root.children`) — and return their non-empty
 * counts grouped by area, busiest-first (a single flat sort over all items,
 * then grouped preserving that order — so an area's own item list is also
 * busiest-first, and areas themselves appear in order of their busiest
 * inbox, matching the original's Map-insertion-order behavior).
 */
export function scanInboxes(notes: string[]): InboxAreaGroup[] {
  const inboxes = new Map<string, { area: string; category: string; inboxFolder: string; path: string }>();
  for (const note of notes) {
    const segs = folderSegments(note);
    if (segs.length < 3) continue;
    if (!AREA_RE.test(segs[0])) continue;
    if (!CATEGORY_RE.test(segs[1])) continue;
    const idMatch = ID_RE.exec(segs[2]);
    if (!idMatch) continue;
    if (!idMatch[1].endsWith(".01")) continue;
    if (!INBOX_SUFFIXES.some((s) => idMatch[2].startsWith(s))) continue;
    const path = segs.slice(0, 3).join("/");
    if (!inboxes.has(path)) inboxes.set(path, { area: segs[0], category: segs[1], inboxFolder: segs[2], path });
  }

  const items: Array<InboxItem & { area: string }> = [];
  for (const { area, category, inboxFolder, path } of inboxes.values()) {
    const prefix = `${path}/`;
    const coverPath = `${path}/${inboxFolder}.md`;
    const directNames = new Set<string>();
    for (const note of notes) {
      if (!note.startsWith(prefix) || note === coverPath) continue;
      const name = note.slice(prefix.length).split("/")[0];
      // Same exclusions the original applies to its direct-children count
      // (scanner.ts's own filter, verbatim in spirit): a dot-prefixed name
      // and any name containing "+README" (a legacy leftover) don't count
      // as real unsorted items either.
      if (name.startsWith(".") || name.includes("+README")) continue;
      directNames.add(name);
    }
    if (directNames.size > 0) items.push({ area, category, inboxFolder, path, count: directNames.size });
  }
  items.sort((a, b) => b.count - a.count);

  const byArea = new Map<string, InboxItem[]>();
  for (const { area, ...item } of items) {
    const list = byArea.get(area) ?? [];
    list.push(item);
    byArea.set(area, list);
  }
  return [...byArea.entries()].map(([area, groupItems]) => ({ area, items: groupItems }));
}
