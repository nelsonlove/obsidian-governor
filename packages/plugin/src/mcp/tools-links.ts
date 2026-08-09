// Link drift, detected out of band — the report half of "link healing".
//
// Slice 2.2 closes Delivery step 2 ("the uid index and link healing") with a
// deliberate asymmetry:
//
//   • IN BAND, a move heals its own links. Every move path in this plugin goes
//     through `app.fileManager.renameFile`, Obsidian's link-updating rename, so
//     references to a note that MOVED THROUGH US are rewritten canonically by
//     the host at move time. There is nothing to heal afterwards.
//   • OUT OF BAND, links rot anyway: a note deleted in Finder, a rename done by
//     another tool, a wikilink typed against a note that was never created, a
//     uid pasted into two notes. Nothing the transport did caused it, and
//     nothing the transport does will silently repair it.
//
// `obsidian_check_links` is the second half: a READ-ONLY report of that drift.
// Per Assent ch6 the rail DETECTS and names; the repair is a human's (or an
// operation's) act, not a side effect of asking. So this tool mutates nothing,
// takes no queue slot, writes no journal record, and has no `fix`/`heal`/`auto`
// argument. `obsidian_repoint_link` remains the tool that actually rewrites a
// dangling link, and it is called deliberately, one target at a time.
//
// What it reports, both bounded by the caller's own visibility:
//
//   1. DANGLING WIKILINKS — Obsidian's own `metadataCache.unresolvedLinks`,
//      which is the host's answer to "which links resolve to nothing", already
//      computed. We never parse a file.
//   2. DUPLICATED UIDS — the uid index's `duplicates()`, the same already-
//      computed data `obsidian_resolve_uid` reports with no argument.
//
// Allowlist-aware for the same reason obsidian_resolve_uid is: an unfiltered
// report is a path oracle for the area a sandboxed session is excluded from —
// "you have 412 dangling links, here they are" would enumerate half a vault the
// caller cannot read. Every path in the report passes `visiblePaths` (guard.ts,
// one copy shared with uid addressing), and `scope` narrows further.
//
// Imports nothing from `obsidian`: the unresolved-link map arrives through an
// injected LinkSource (the same shape as the uid index's UidSource), so this
// module is unit-testable headlessly.

import { z } from "zod";
import { posix } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail } from "./helpers.js";
import { visiblePaths, type GuardSettings } from "../guard.js";
import type { Kernel } from "../kernel/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * Obsidian's unresolved-link map: source path → link text → occurrence count.
 * The link TEXT, not a path — a dangling link by definition names no file.
 */
export type UnresolvedLinks = Record<string, Record<string, number>>;

/** Where the drift report gets its facts. Cache-backed lookups, never a read from disk. */
export interface LinkSource {
  unresolved(): UnresolvedLinks;
}

/**
 * The adapter over Obsidian's metadata cache. Typed STRUCTURALLY rather than
 * against `App` so this file imports nothing from `obsidian` at all — the live
 * `app` satisfies it, and a test can hand over a plain object.
 */
export function obsidianLinkSource(app: { metadataCache: { unresolvedLinks: UnresolvedLinks } }): LinkSource {
  return { unresolved: () => app.metadataCache.unresolvedLinks ?? {} };
}

export interface LinkToolsCtx {
  kernel?: Kernel | null;
  /** The guard's settings — the allowlist filter below. Absent ⇒ unfiltered. */
  getSettings?: () => GuardSettings;
}

/**
 * A report is a summary, not a dump. Counts are always exact and describe the
 * WHOLE visible-and-in-scope set; the lists are capped, and `truncated` says so
 * — narrow `scope` to see the rest. A vault with four thousand dangling links
 * must not cost a session its context window to learn that.
 */
const MAX_ITEMS = 100;

/**
 * A scope is a vault-relative folder prefix, `posix.normalize`d for the same
 * reason guardCall normalizes: `Projects/../Archive` must not read as
 * `Projects…`. One that normalizes to nothing, to `.`, or above the vault root
 * is REFUSED rather than quietly widened to everything — a caller who wrote a
 * `..` meant to narrow, and silently handing back the whole vault instead is
 * the opposite of what they asked for. Omitting `scope` is how you ask for
 * everything, and it is unambiguous.
 */
function normalizeScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const prefix = posix.normalize(scope).replace(/\/+$/, "");
  if (!prefix || prefix === "." || prefix === ".." || prefix.startsWith("../")) {
    throw new Error(
      `scope '${scope}' does not name a folder in this vault — give a vault-relative prefix like 'Projects', ` +
        `or omit scope to report on everything you can see`
    );
  }
  return prefix;
}

/** Segment-boundary prefix match against an already-normalized scope. */
function inScope(path: string, prefix?: string): boolean {
  if (!prefix) return true;
  const p = posix.normalize(path);
  return p === prefix || p.startsWith(prefix + "/");
}

export function registerLinkTools(server: McpServer, links: LinkSource, ctx: LinkToolsCtx): void {
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());

  server.registerTool(
    "obsidian_check_links",
    {
      title: "Check link health",
      description:
        "Report link drift in the vault, read-only: wikilinks that point at no note (from Obsidian's own unresolved-link " +
        "map) and uids carried by more than one note. Nothing is written and nothing is repaired — this names what has " +
        "drifted so you (or a deliberate follow-up call) can decide. Moves made through this server do not need it: " +
        "obsidian_move_note / obsidian_move_notes rename through Obsidian's link-updating API, which rewrites backlinks " +
        "as it goes. Drift comes from outside — a note deleted or renamed by another tool, a link typed against a note " +
        "that was never created, a uid pasted twice. To fix a dangling link, call obsidian_repoint_link with the target " +
        "you meant; to fix a duplicated uid, edit one note's frontmatter. Pass `scope` to narrow to a folder. Counts are " +
        "exact; the lists are capped at 100 each with a `truncated` flag.",
      inputSchema: {
        scope: z
          .string()
          .min(1)
          .optional()
          .describe("Vault-relative path prefix to report on, e.g. 'Projects' — omit for everything you can see."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        const scope = normalizeScope(args.scope);

        // ── 1. dangling wikilinks ────────────────────────────────────────────
        // Source notes are filtered to the scope AND to the allowlist first, so
        // an out-of-allowlist note never contributes a count, let alone a name.
        // The link TEXT is disclosed only from a note this session could read
        // itself, which is where it is written.
        const map = links.unresolved();
        const sources = visible(Object.keys(map).filter((p) => inScope(p, scope))).sort();
        const dangling: Array<{ from: string; link: string; count: number }> = [];
        let linkCount = 0;
        let noteCount = 0;
        // Rows are (note, link-text) pairs; `link_count` counts OCCURRENCES, so
        // the two totals differ and only the row total can say whether the list
        // was capped.
        let rowCount = 0;
        for (const from of sources) {
          const entries = Object.entries(map[from] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
          if (entries.length === 0) continue;
          noteCount++;
          for (const [link, count] of entries) {
            const n = typeof count === "number" && count > 0 ? count : 1;
            linkCount += n;
            rowCount++;
            if (dangling.length < MAX_ITEMS) dangling.push({ from, link, count: n });
          }
        }

        // ── 2. duplicated uids ───────────────────────────────────────────────
        // The same already-computed data obsidian_resolve_uid reports, narrowed
        // to the scope. A duplicate counts when two or more of its carriers are
        // BOTH visible and in scope — one visible carrier is not an ambiguity
        // for this session, which is exactly how uid addressing decides.
        const index = ctx.kernel?.uids;
        const duplicates = index
          ? index
              .duplicates()
              .map((d) => ({ uid: d.uid, paths: visible(d.paths.filter((p) => inScope(p, scope))) }))
              .filter((d) => d.paths.length > 1)
              // Sorted, so a report is a function of the vault rather than of
              // the order the index happened to learn things in.
              .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
          : [];

        return ok({
          scope: scope ?? null,
          dangling_links: {
            note_count: noteCount,
            link_count: linkCount,
            truncated: rowCount > dangling.length,
            items: dangling,
          },
          duplicate_uids: {
            // Without a kernel there is no uid index in this build; say so
            // rather than reporting a confident zero.
            available: Boolean(index),
            count: duplicates.length,
            truncated: duplicates.length > MAX_ITEMS,
            items: duplicates.slice(0, MAX_ITEMS),
          },
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
