// obsidian_write_note, obsidian_append_note, obsidian_manage_frontmatter,
// obsidian_patch_note, obsidian_move_note, and obsidian_delete_note have been
// migrated to registerFsTools + ObsidianBackend in server.ts.
//
// This file retains the live-only tools that are not part of the 17
// fs-expressible set — obsidian_move_notes (batch move/rename) and
// obsidian_repoint_link (repoint broken wikilinks) — along with their helpers.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import { ok, fail, okError, validateMoves } from "./helpers.js";
import { repointLinksInText } from "./repoint.js";
import { visiblePaths, type GuardSettings } from "../guard.js";

export const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export interface VaultWriteToolsCtx {
  /**
   * The guard's settings — the allowlist `obsidian_repoint_link` scopes its
   * VAULT-WIDE SCAN by. Absent ⇒ no allowlist ⇒ unfiltered, exactly as before.
   *
   * The guard checks the paths an operation NAMES IN ITS ARGUMENTS, and a
   * repoint names only its target: the set it reads, rewrites and then reports
   * back is derived inside the handler, where no per-argument check can reach
   * it. So the handler applies the same rule to that set itself.
   */
  getSettings?: () => GuardSettings;
}

async function ensureParentFolders(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); } catch { /* exists / race */ }
    }
  }
}

export async function moveOne(app: App, from: string, to: string, overwrite: boolean): Promise<void> {
  if (!from.endsWith(".md")) throw new Error("source must end in .md");
  if (!to.endsWith(".md")) throw new Error("destination must end in .md");
  if (from === to) throw new Error("from and to are the same path");
  const file = app.vault.getAbstractFileByPath(from);
  if (!(file instanceof TFile)) throw new Error(`not found: ${from}`);
  const dest = app.vault.getAbstractFileByPath(to);
  let trashedDest = false;
  if (dest) {
    if (!overwrite) throw new Error(`destination exists (set overwrite=true): ${to}`);
    // Recoverable delete: if the subsequent rename fails, the overwritten note is in trash.
    if (dest instanceof TFile) {
      await app.vault.trash(dest, true);
      trashedDest = true;
    }
  }
  await ensureParentFolders(app, to);
  try {
    await app.fileManager.renameFile(file, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (trashedDest)
      throw new Error(`${msg} (the note previously at '${to}' was already moved to the system trash and is recoverable there)`);
    throw e;
  }
}

export function registerVaultWriteTools(server: McpServer, app: App, ctx: VaultWriteToolsCtx = {}) {
  server.registerTool(
    "obsidian_move_notes",
    {
      title: "Move/rename multiple notes",
      description:
        "Move or rename several notes in one call. Items are processed sequentially; backlinks are rewritten canonically by Obsidian's fileManager.renameFile. A runtime-failed item (missing source, existing destination) is reported in `errors` and does not fail the call, but if every item fails the call is flagged as an error. Statically invalid batches are rejected up front with no moves performed: a non-.md path, an item whose from and to are identical, or a path appearing twice as a source, twice as a destination, or as both (swaps/chains) — compared after normalization.",
      inputSchema: {
        moves: z
          .array(
            z.object({
              from: z.string().min(1).describe("Existing vault-relative path ending in .md."),
              to: z.string().min(1).describe("New vault-relative path ending in .md."),
            })
          )
          .min(1)
          .max(50)
          .describe("Move/rename operations, e.g. [{from:'Inbox/A.md',to:'Archive/A.md'}]."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Applies to every item: replace an existing destination (the previous note goes to trash)."),
      },
      annotations: RW,
    },
    async ({ moves, overwrite }) => {
      const invalid = validateMoves(moves);
      if (invalid) return fail(new Error(`invalid batch, no moves performed — ${invalid}`));
      const moved: Array<{ from: string; to: string }> = [];
      const errors: Array<{ from: string; to: string; error: string }> = [];
      for (const { from, to } of moves) {
        try {
          await moveOne(app, from, to, overwrite);
          moved.push({ from, to });
        } catch (e) {
          errors.push({ from, to, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const payload = { count: moved.length, error_count: errors.length, moved, errors };
      // Partial failure is tolerated, but total failure must carry the standard MCP error flag.
      return moved.length === 0 ? okError(payload) : ok(payload);
    }
  );

  server.registerTool(
    "obsidian_repoint_link",
    {
      title: "Repoint a link",
      description:
        "Rewrite every wikilink whose target text matches `link_name` to point at `target_path` instead, across every note you can see. Case-insensitive on the link text; aliases ([[x|alias]]) and subpaths ([[x#heading]]) are preserved. This is the tool for fixing BROKEN links: Obsidian's rename-based backlink rewrite (obsidian_move_note/obsidian_move_notes) only touches links that already resolve to a file, so a dangling [[x]] that points at no note can only be repointed by this text-level scan. While a path allowlist is configured the scan is CONTAINED BY IT — notes outside it are neither read, rewritten, nor named, so the repair is partial and `scoped_to_allowlist: true` says so. Set dry_run=true to report how many links/notes would change without writing anything.",
      inputSchema: {
        link_name: z
          .string()
          .min(1)
          .describe("The link text inside [[ ]] to repoint, e.g. 'Foo Bar'. Case-insensitive; omit the brackets, any alias, and any #heading."),
        target_path: z
          .string()
          .min(1)
          .describe("Vault-relative path (ending in .md) of the note to point the matching links at."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, report linksChanged/filesChanged without modifying any files."),
        unresolved_only: z
          .boolean()
          .default(false)
          .describe("Only rewrite links that do NOT currently resolve from their source file (checked per-file against metadataCache.unresolvedLinks). Guards against repointing working links that share the name."),
        drop_echo_alias: z
          .boolean()
          .default(false)
          .describe("Drop an alias that merely echoes the old link name ([[foo|foo]] becomes [[NewTarget]]), so display text follows the new target. Genuine aliases are always preserved."),
      },
      annotations: RW,
    },
    async ({ link_name, target_path, dry_run, unresolved_only, drop_echo_alias }) => {
      try {
        if (!target_path.endsWith(".md")) return fail(new Error("target_path must end in .md"));
        const target = app.vault.getAbstractFileByPath(target_path);
        if (!(target instanceof TFile)) return fail(new Error(`target not found: ${target_path}`));

        let filesChanged = 0;
        let linksChanged = 0;
        const files: string[] = [];

        // ── allowlist containment ────────────────────────────────────────────
        // This is the one tool whose blast radius is not in its arguments: it
        // scans, rewrites and then NAMES a set it discovers for itself. Handed
        // the whole vault, it reads notes a sandboxed session cannot read,
        // writes notes it cannot write, and hands back their paths in `files` —
        // an allowlist bypass in all three directions at once, in the very tool
        // the link-health docs prescribe as the repair.
        //
        // So the discovered set goes through `visiblePaths`, the same rule the
        // guard applies to a named path (guard.ts — one copy, shared with uid
        // addressing and the drift report). The consequence is honest and must
        // be reported rather than hidden: under an allowlist the repair is
        // PARTIAL, dangling links to the same name survive outside it, and
        // `scoped_to_allowlist` tells the caller so.
        //
        // No allowlist ⇒ visiblePaths returns the same array ⇒ unchanged.
        const settings = ctx.getSettings?.();
        const all = app.vault.getMarkdownFiles();
        const scoped = Boolean(settings?.allowlist?.length);
        const allowed = scoped ? new Set(visiblePaths(all.map((f) => f.path), settings)) : null;

        for (const file of all) {
          if (allowed && !allowed.has(file.path)) continue;
          // Shortest unambiguous link text for the target, relative to this source file.
          const newTarget = app.metadataCache.fileToLinktext(target, file.path, true);
          // unresolved_only: gate each link on Obsidian's own per-file unresolved map,
          // so links that still resolve from this file are left untouched.
          let allowTarget: ((rawTarget: string) => boolean) | undefined;
          if (unresolved_only) {
            const unres = app.metadataCache.unresolvedLinks[file.path] ?? {};
            const unresSet = new Set(Object.keys(unres).map((k) => k.trim().toLowerCase()));
            allowTarget = (raw) => unresSet.has(raw.trim().toLowerCase());
          }
          const opts = { dropEchoAlias: drop_echo_alias, allowTarget };
          // Peek from cache first so unmatched files are never rewritten (no mtime churn).
          const preview = repointLinksInText(await app.vault.cachedRead(file), link_name, newTarget, opts);
          if (preview.count === 0) continue;

          let count = preview.count;
          if (!dry_run) {
            // Re-run under the write lock so the reported count reflects what was written.
            await app.vault.process(file, (data) => {
              const r = repointLinksInText(data, link_name, newTarget, opts);
              count = r.count;
              return r.text;
            });
          }
          if (count === 0) continue;

          filesChanged++;
          linksChanged += count;
          files.push(file.path);
        }

        return ok({
          link_name,
          target_path,
          dry_run,
          unresolved_only,
          drop_echo_alias,
          linksChanged,
          filesChanged,
          files,
          // Present either way, so a caller never has to infer containment from
          // the absence of a flag: `true` means notes outside the allowlist were
          // skipped and this repair is partial.
          scoped_to_allowlist: scoped,
        });
      } catch (e) { return fail(e); }
    }
  );
}
