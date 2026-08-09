// The uid index's read surface: one tool, both directions.
//
// `obsidian_resolve_uid` answers "which note is this uid?", "what uid does this
// note carry?", and "where do two notes claim one uid?". It is the companion to
// `uid:<value>` addressing (mcp/guarded.ts): addressing is how you ACT on a uid,
// this is how you look one up, and how you find out why an ambiguous one
// refused.
//
// Allowlist-aware, deliberately. The index is built from the whole vault, so an
// allowlisted session that could read any uid's path would have a path oracle
// for the area it is sandboxed out of. Candidate paths are therefore filtered
// through the same guardCall the tool surface uses, and a uid whose every path
// is outside the allowlist reads as unknown.
//
// Imports nothing from `obsidian`: the index is Obsidian-free, so this module is
// unit-testable headlessly like tools-locks.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail } from "./helpers.js";
import { visiblePaths, type GuardSettings } from "../guard.js";
import type { Kernel } from "../kernel/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export interface UidToolsCtx {
  kernel?: Kernel | null;
  /** The guard's settings — the allowlist filter below. Absent ⇒ unfiltered. */
  getSettings?: () => GuardSettings;
}

const NO_INDEX = "the uid index needs the kernel, which is not active in this build";

export function registerUidTools(server: McpServer, ctx: UidToolsCtx): void {
  /**
   * Paths this session is allowed to be told about. The rule itself lives in
   * guard.ts (`visiblePaths`) because uid ADDRESSING decides over the same set —
   * one copy, so the lookup and the addressing cannot drift into disagreeing
   * about what a duplicated uid names.
   */
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());

  server.registerTool(
    "obsidian_resolve_uid",
    {
      title: "Resolve a note uid",
      description:
        "Look up the frontmatter `uid` index, in either direction. Give `uid` to get the note's current path (plus " +
        "`duplicates` if more than one note carries it); give `path` to get that note's uid; give neither to get index " +
        "totals and every duplicated uid. A uid survives renames and moves, so it is the stable way to refer to a note " +
        "across a session — and any tool argument that takes a path also takes `uid:<value>` directly, resolved the same " +
        "way. Read-only: this reports duplicates, it never repairs them.",
      inputSchema: {
        uid: z.string().min(1).optional().describe("A frontmatter uid to resolve to a path."),
        path: z.string().min(1).optional().describe("A vault-relative path to resolve to its uid (the reverse direction)."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        const index = ctx.kernel?.uids;
        if (!index) return fail(new Error(NO_INDEX));
        if (args.uid && args.path) {
          return fail(new Error("give `uid` or `path`, not both — they are the two directions of one lookup"));
        }

        if (args.uid) {
          const paths = visible(index.resolve(args.uid).paths);
          return ok({
            uid: args.uid,
            found: paths.length > 0,
            path: paths[0] ?? null,
            // Present only when it matters. A uid with several paths cannot be
            // used for addressing until the duplication is resolved — by a
            // human, in the vault; nothing here rewrites frontmatter.
            ...(paths.length > 1 ? { duplicates: paths, ambiguous: true } : {}),
          });
        }

        if (args.path) {
          const uid = visible([args.path]).length > 0 ? index.uidFor(args.path) : undefined;
          return ok({ path: args.path, found: uid !== undefined, uid: uid ?? null });
        }

        // No argument: the index's own state, and every duplicate in it.
        const duplicates = index
          .duplicates()
          .map((d) => ({ uid: d.uid, paths: visible(d.paths) }))
          .filter((d) => d.paths.length > 1);
        // The TOTALS are filtered too (D1). `index.size` / `index.uidCount`
        // describe the whole vault, so reporting them raw told a session
        // sandboxed to one folder how many notes exist outside it — a
        // cardinality oracle beside the path oracle the duplicates list already
        // closes. A session sees its own visible cardinality and nothing more.
        //
        // `visiblePaths` hands back the SAME array when no allowlist is active,
        // so the unfiltered case still reads the index's own counters and costs
        // nothing.
        const all = index.indexedPaths();
        const shown = visible(all);
        const uidCount =
          shown === all ? index.uidCount : new Set(shown.map((p) => index.uidFor(p))).size;
        return ok({
          indexed_notes: shown.length,
          indexed_uids: uidCount,
          duplicate_count: duplicates.length,
          duplicates,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
