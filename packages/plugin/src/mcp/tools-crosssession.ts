// tools-crosssession.ts — the cross-session channel module's tool surface
// (#232): the fleet's coordination-log conventions given a real agent surface.
// Four tools:
//
//   crosssession_channels — discovery by fileclass + `audience:` frontmatter
//                           (READ-ONLY; never by path)
//   crosssession_delta    — entries newer than the caller's attested read
//                           position, both entry forms merged (READ-ONLY)
//   crosssession_attest   — record a read receipt: "handle read through
//                           <stamp>" (MUTATING — module state, not vault state;
//                           the lock-tools precedent: readOnlyHint: false buys
//                           the journal record, so who-claimed-to-have-read is
//                           in the audit stream)
//   crosssession_post     — append one `## <stamp> · <handle>` section to the
//                           channel's log file; REFUSED (`stale_read`, typed,
//                           before any write) while unread foreign entries
//                           exist (MUTATING — an ordinary guarded vault write)
//
// ── The cooperative-handle model (fallible-not-adversarial) ─────────────────
//
// `handle` is a tool argument the caller declares about itself. It is NOT
// authenticated: a session that lies about its handle defeats the staleness
// check for itself, exactly as a session that lies in a log entry defeats the
// log. The threat model (the fleet's standing call, restated in #232) is
// honest lapses — a session posting without having read — not adversaries;
// this module catches the former mechanically and does not pretend to stop
// the latter.
//
// Attestation is a READ-RECEIPT, not authority: it grants nothing, gates only
// this module's own `crosssession_post`, needs no human gesture (agents attest
// their own reads), and lives in the module's state file — never in any note's
// frontmatter, and nowhere near the accepted family (it writes no note at
// all). See kernel/crosssession/receipts.ts.
//
// ── Staleness (the `stale_read` policy refusal) ─────────────────────────────
//
// Posting asserts you are current: `crosssession_post` refuses — typed
// `stale_read`, the `cli_denied` shape, checked BEFORE any write — while the
// channel contains entries the posting handle's receipt does not cover. The
// handle's own entries are exempt (you are always current with yourself). On
// success the post auto-attests through its own entry, so a clean
// post-post-post run needs no interleaved attest calls.
//
// ── Allowlist discipline ────────────────────────────────────────────────────
//
// A channel whose folder note is outside the path allowlist is INVISIBLE:
// absent from discovery, and `channel_unresolved` (not `out_of_allowlist`) to
// delta/attest/post — the uid-addressing precedent, so a refusal does not
// confirm the hidden channel exists. Member files are visible-filtered too,
// so a hidden log file or message note contributes no entries.
//
// Obsidian-free by construction: the vault arrives through the injected
// CrosssessionSource, receipts through ReceiptStoreLike — every handler is
// headless-testable. The Obsidian adapters live at the bottom of this file.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, codedError } from "./helpers.js";
import { PLUGIN_ID } from "../id-migration.js";
import type { GuardSettings } from "../guard.js";
import {
  channelKey,
  channelMembers,
  discoverChannels,
  isEntryHeadingLine,
  loadChannelEntries,
  newestStamp,
  orderKey,
  sortEntries,
  unreadFor,
  crosssessionConfigOf,
  ReceiptStore,
  type Channel,
  type ChannelEntry,
  type CrosssessionConfig,
  type ReceiptAdapter,
  type ReceiptStoreLike,
} from "../kernel/crosssession/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** What the module needs from the vault — structurally typed, no `obsidian`
 * import (the LinkSource/VocabSource discipline). */
export interface CrosssessionSource {
  /** Every markdown path in the vault (UNfiltered; the tool layer applies the
   * allowlist before anything is read). */
  paths(): string[];
  /** A note's cached frontmatter, or null. */
  frontmatter(path: string): Record<string, unknown> | null;
  /** A file's full text, or null when it does not exist / cannot be read. */
  read(path: string): Promise<string | null>;
  /** Append `entryText` at end-of-file, inserting a newline first when the
   * file does not already end with one. Throws when the file is missing. */
  append(path: string, entryText: string): Promise<void>;
}

/** An inert source — the mount's default when no vault is injected (settings-UI
 * stand-ins, bare embeds): no channels, nothing to read or write. */
export function emptyCrosssessionSource(): CrosssessionSource {
  return {
    paths: () => [],
    frontmatter: () => null,
    read: async () => null,
    append: async () => {
      throw new Error("no vault source injected");
    },
  };
}

export interface CrosssessionToolsCtx {
  /** The merged `modules.crosssession.config` (defaults ∪ user override). */
  config: Record<string, unknown>;
  /** Guard settings accessor — unused today, retained for parity with the
   * other module ctxs (the allowlist arrives pre-applied via `visible`). */
  getSettings?: () => GuardSettings;
  /** The host's allowlist filter (`host.visible`). Absent ⇒ nothing filtered,
   * matching visiblePaths with no allowlist. */
  visible?: (paths: string[]) => string[];
  /** The read-receipt store (module state — see receipts.ts). */
  receipts: ReceiptStoreLike;
  /** Injectable clock for post/attest stamps (tests). Absent ⇒ run clock. */
  now?: () => Date;
}

/** `YYYY-MM-DDTHH:MM`, local time — minutes precision, the live convention's
 * entry-stamp shape. */
export function formatEntryStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Handle hygiene: non-empty, single-line, and free of the ` · ` separator
 * (which would corrupt the entry heading it is written into). Returns a
 * refusal reason or null. */
export function handleRefusal(handle: unknown): string | null {
  if (typeof handle !== "string" || handle.trim().length === 0) return "handle must be a non-empty string";
  if (/[\r\n]/.test(handle)) return "handle must be a single line";
  if (handle.includes(" · ")) return "handle must not contain the ' · ' separator";
  return null;
}

/** Body hygiene for a post: no line may itself parse as an entry heading — an
 * honestly pasted log excerpt would otherwise mint phantom entries on the next
 * parse (the honest-mistake class this module exists to catch) — and code
 * fences must balance: an unbalanced fence would leave the parser's fence
 * state open across the entry boundary, swallowing every LATER entry's heading
 * as fenced content (the same phantom-entry class, in the opposite
 * direction). */
export function bodyRefusal(body: string): string | null {
  if (body.trim().length === 0) return "body must be non-empty";
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f && (fence === null || fence === f[1])) {
      fence = fence === null ? f[1] : null;
      continue;
    }
    if (fence === null && isEntryHeadingLine(line)) {
      return `body contains a line that would parse as an entry heading (${JSON.stringify(line.slice(0, 60))}); ` +
        "quote log excerpts with '>' or indentation instead";
    }
  }
  if (fence !== null) {
    return `body contains an unbalanced ${fence} code fence — it would swallow every later entry in the log file; ` +
      "close the fence";
  }
  return null;
}

interface ResolvedChannel {
  channel: Channel;
  members: { logFiles: string[]; noteFiles: string[] };
  entries: ChannelEntry[];
}

function entryView(e: ChannelEntry) {
  return {
    stamp: e.stamp,
    handle: e.handle,
    ...(e.event ? { event: e.event } : {}),
    body: e.body,
    source: e.source,
    form: e.form,
  };
}

export function registerCrosssessionTools(server: McpServer, source: CrosssessionSource, ctx: CrosssessionToolsCtx): void {
  const cfg: CrosssessionConfig = crosssessionConfigOf(ctx.config);
  const vis = ctx.visible ?? ((p: string[]) => p);
  const now = ctx.now ?? (() => new Date());

  /** The allowlist-visible vault listing — resolved per call so a settings
   * edit lands live, the same per-call freshness every tool layer follows. */
  const visiblePathsNow = () => vis(source.paths());

  const channels = (paths: string[]): Channel[] =>
    discoverChannels(paths, (p) => source.frontmatter(p), cfg.channelFileclass);

  /** Resolve a `channel` argument — uid, folder-note path, or folder path —
   * against the VISIBLE channel set only. A hidden or nonexistent channel is
   * one answer: null (no existence oracle). */
  async function resolveChannel(ref: string): Promise<ResolvedChannel | null> {
    const paths = visiblePathsNow();
    const ch = channels(paths).find((c) => c.uid === ref || c.path === ref || c.folder === ref);
    if (!ch) return null;
    const members = channelMembers(ch, paths, (p) => source.frontmatter(p), cfg.messageFileclass);
    const entries = await loadChannelEntries(ch, members, (p) => source.read(p));
    return { channel: ch, members, entries };
  }

  server.registerTool(
    "crosssession_channels",
    {
      title: "Discover cross-session channels",
      description:
        "Discover every cross-session coordination channel — notes carrying the channel fileClass " +
        `("${cfg.channelFileclass}" by default) plus an \`audience:\` frontmatter value — by frontmatter only, never ` +
        "by path. Returns uid, path, audience, linked projects, entry count, newest stamp, and every recorded read " +
        "receipt (which handles are current, which are behind). With `handle`, adds that handle's own read position " +
        "and unread count per channel. Read-only.",
      inputSchema: {
        handle: z
          .string()
          .optional()
          .describe("Your session handle (self-declared, cooperative). Adds your read position + unread count per channel."),
      },
      annotations: RO,
    },
    async ({ handle }: { handle?: string }) => {
      try {
        if (handle !== undefined) {
          const bad = handleRefusal(handle);
          if (bad) return codedError("invalid_handle", bad);
        }
        const paths = visiblePathsNow();
        const out = [];
        for (const ch of channels(paths)) {
          const members = channelMembers(ch, paths, (p) => source.frontmatter(p), cfg.messageFileclass);
          const entries = await loadChannelEntries(ch, members, (p) => source.read(p));
          const key = channelKey(ch);
          const receipts = await ctx.receipts.channel(key);
          const receiptRows = Object.entries(receipts).map(([h, r]) => ({
            handle: h,
            through: r.through,
            at: r.at,
            behind: unreadFor(entries, r.through, h).length,
          }));
          const own = handle !== undefined ? (receipts[handle]?.through ?? null) : null;
          out.push({
            uid: ch.uid,
            path: ch.path,
            folder: ch.folder,
            audience: ch.audience,
            projects: ch.projects,
            entry_count: entries.length,
            newest_stamp: newestStamp(entries),
            // CANDIDATES, not confirmed logs: every direct child that is not a
            // per-message note. An entry-less scratch file lists here too; the
            // post path narrows to the entry-bearing one.
            log_candidates: members.logFiles,
            receipts: receiptRows,
            ...(handle !== undefined
              ? { read_position: own, unread_count: unreadFor(entries, own, handle).length }
              : {}),
          });
        }
        return ok({ channels: out, channel_fileclass: cfg.channelFileclass, message_fileclass: cfg.messageFileclass });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "crosssession_delta",
    {
      title: "Read a channel's unread entries",
      description:
        "Entries newer than your attested read position — full text, parsed into {stamp, handle, body} from both " +
        "forms (the channel's `## <stamp> · <handle>` log-file sections and its per-message notes), oldest first. " +
        "Your own entries are omitted (they are exempt from staleness). Capped per channel (`more: true` + " +
        "`next_stamp` when truncated — attest through the last served stamp, then call again). `channel` accepts a " +
        "channel uid, its folder-note path, or its folder; omit it to read every visible channel. Read-only.",
      inputSchema: {
        handle: z.string().min(1).describe("Your session handle (self-declared, cooperative)."),
        channel: z
          .string()
          .optional()
          .describe("Channel uid, folder-note path, or folder path. Omit for all visible channels."),
      },
      annotations: RO,
    },
    async ({ handle, channel }: { handle: string; channel?: string }) => {
      try {
        const bad = handleRefusal(handle);
        if (bad) return codedError("invalid_handle", bad);
        let resolved: ResolvedChannel[];
        if (channel !== undefined) {
          const one = await resolveChannel(channel);
          if (!one) return codedError("channel_unresolved", `no visible channel matches '${channel}'`);
          resolved = [one];
        } else {
          const paths = visiblePathsNow();
          resolved = [];
          for (const ch of channels(paths)) {
            const members = channelMembers(ch, paths, (p) => source.frontmatter(p), cfg.messageFileclass);
            resolved.push({ channel: ch, members, entries: await loadChannelEntries(ch, members, (p) => source.read(p)) });
          }
        }
        const out = [];
        for (const r of resolved) {
          const key = channelKey(r.channel);
          const through = (await ctx.receipts.get(key, handle))?.through ?? null;
          const unread = unreadFor(r.entries, through, handle);
          // The cap may never bisect a stamp-equivalence class: the documented
          // continuation is "attest through next_stamp, call again", and
          // coverage is strictly-greater on orderKey — a boundary inside a run
          // of equal stamps (several posts in one minute) would mark the
          // unserved remainder read without ever serving it. Extend the slice
          // to complete the final equal-key group instead (runs are small).
          let served = unread.slice(0, cfg.deltaCap);
          if (unread.length > served.length && served.length > 0) {
            const lastKey = orderKey(served[served.length - 1].stamp);
            let i = served.length;
            while (i < unread.length && orderKey(unread[i].stamp) === lastKey) i++;
            served = unread.slice(0, i);
          }
          const more = unread.length > served.length;
          out.push({
            channel: { uid: r.channel.uid, path: r.channel.path, audience: r.channel.audience },
            read_position: through,
            newest_stamp: newestStamp(r.entries),
            unread_count: unread.length,
            entries: served.map(entryView),
            more,
            // Where to continue: attest through the LAST SERVED stamp, then
            // call again — the next delta starts after it. `more` implies a
            // non-empty `served` (the group-completion above only ever grows
            // the slice), so the stamp always exists.
            ...(more ? { next_stamp: served[served.length - 1].stamp } : {}),
          });
        }
        return ok({ handle, channels: out });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "crosssession_attest",
    {
      title: "Attest a read position (read receipt)",
      description:
        "Record that your handle has read a channel through `through_stamp` — a READ-RECEIPT, not authority: it " +
        "grants nothing, touches no note (state lives in the module's own file beside the journal), and only feeds " +
        "`crosssession_post`'s staleness check. Any stamp at or before the channel's newest entry is accepted " +
        "(cooperative model: handles are self-declared and receipts are claims, not verified reads). Mutating — the " +
        "receipt write is journaled like a lock claim, though no vault file changes.",
      inputSchema: {
        handle: z.string().min(1).describe("Your session handle (self-declared, cooperative)."),
        channel: z.string().min(1).describe("Channel uid, folder-note path, or folder path."),
        through_stamp: z
          .string()
          .min(1)
          .describe("The stamp of the last entry you have read (verbatim, e.g. \"2026-08-18T13:40\")."),
      },
      annotations: RW,
    },
    async ({ handle, channel, through_stamp }: { handle: string; channel: string; through_stamp: string }) => {
      try {
        const bad = handleRefusal(handle);
        if (bad) return codedError("invalid_handle", bad);
        const r = await resolveChannel(channel);
        if (!r) return codedError("channel_unresolved", `no visible channel matches '${channel}'`);
        const newest = newestStamp(r.entries);
        if (newest === null || orderKey(through_stamp) > orderKey(newest)) {
          return codedError(
            "stamp_ahead",
            newest === null
              ? "the channel has no entries — there is nothing to attest reading"
              : `through_stamp '${through_stamp}' is ahead of the channel's newest entry ('${newest}') — you cannot attest reads that do not exist yet`,
          );
        }
        const key = channelKey(r.channel);
        await ctx.receipts.set(key, handle, through_stamp, now().toISOString());
        return ok({
          channel: { uid: r.channel.uid, path: r.channel.path },
          handle,
          through: through_stamp,
          unread_after: unreadFor(r.entries, through_stamp, handle).length,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "crosssession_post",
    {
      title: "Post to a cross-session channel",
      description:
        "Append one `## <stamp> · <handle>` entry (run clock, minutes precision) to the channel's single append-only " +
        "log file. REFUSES `stale_read` — before anything is written — while the channel holds entries your receipt " +
        "does not cover (your own entries exempt): posting asserts you are current; run crosssession_delta then " +
        "crosssession_attest first. On success, auto-attests your handle through the new entry. An ordinary guarded " +
        "mutating tool: read-only mode, the path allowlist, the write queue and the journal all apply. It appends " +
        "body text at end-of-file only — it does not touch frontmatter.",
      inputSchema: {
        handle: z.string().min(1).describe("Your session handle (self-declared, cooperative)."),
        channel: z.string().min(1).describe("Channel uid, folder-note path, or folder path."),
        body: z
          .string()
          .min(1)
          .describe("The entry body (markdown). May not contain a line that would itself parse as an entry heading."),
      },
      annotations: RW,
    },
    async ({ handle, channel, body }: { handle: string; channel: string; body: string }) => {
      try {
        const badHandle = handleRefusal(handle);
        if (badHandle) return codedError("invalid_handle", badHandle);
        const badBody = bodyRefusal(body);
        if (badBody) return codedError("invalid_body", badBody);
        const r = await resolveChannel(channel);
        if (!r) return codedError("channel_unresolved", `no visible channel matches '${channel}'`);
        const key = channelKey(r.channel);
        const through = (await ctx.receipts.get(key, handle))?.through ?? null;

        // ── the staleness gate: a POLICY refusal, before any write ─────────
        const unread = unreadFor(r.entries, through, handle);
        if (unread.length > 0) {
          const preview = unread
            .slice(0, 5)
            .map((e) => `${e.stamp} · ${e.handle}`)
            .join(", ");
          return codedError(
            "stale_read",
            `posting asserts you are current, and ${unread.length} entr${unread.length === 1 ? "y" : "ies"} in this ` +
              `channel ${unread.length === 1 ? "is" : "are"} newer than your attested read position` +
              `${through === null ? " (you have no receipt on this channel)" : ` ('${through}')`}: ${preview}` +
              `${unread.length > 5 ? ", …" : ""}. Read them with crosssession_delta, attest with crosssession_attest, ` +
              "then post.",
          );
        }

        // ── the append target: the channel's single log file ───────────────
        let logCandidates = r.members.logFiles;
        if (logCandidates.length === 0) {
          return codedError("no_log_file", "this channel has no append-file to post into (only per-message notes)");
        }
        if (logCandidates.length > 1) {
          // Narrow to the files that actually carry entries — a stray non-log
          // note in the channel folder must not make the real log ambiguous.
          const withEntries = logCandidates.filter((p) => r.entries.some((e) => e.source === p));
          if (withEntries.length === 1) logCandidates = withEntries;
          else {
            return codedError(
              "log_ambiguous",
              `this channel has ${logCandidates.length} candidate log files (${logCandidates.join(", ")}) — cannot ` +
                "pick one to append to",
            );
          }
        }
        const target = logCandidates[0];

        const stamp = formatEntryStamp(now());
        const entryText = `\n## ${stamp} · ${handle}\n\n${body.trim()}\n`;
        await source.append(target, entryText);

        // Auto-attest through the post's own entry (never backwards: an odd
        // clock that stamps earlier than the current receipt keeps the newer
        // receipt).
        const newThrough = through !== null && orderKey(through) > orderKey(stamp) ? through : stamp;
        let attested = true;
        try {
          await ctx.receipts.set(key, handle, newThrough, now().toISOString());
        } catch {
          attested = false;
        }
        return ok({
          posted: { channel: { uid: r.channel.uid, path: r.channel.path }, path: target, stamp, handle },
          attested_through: attested ? newThrough : null,
          // The reportedEffects convention (guarded.ts / obsidian_repoint_link):
          // the append target is a DISCOVERED path — the args name only a
          // channel ref, so the journal's argument-derived `target` is empty;
          // `filesChanged`/`files` puts the file actually touched into the
          // record's `effects` field.
          filesChanged: 1,
          files: [target],
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

// ── Obsidian adapters — the only vault coupling (un-headless; verify live) ──

/** Duck-typed against `app` (no `obsidian` import) like
 * obsidianProvenanceBackend, so this file stays headless-testable. */
export function obsidianCrosssessionSource(app: {
  vault: {
    adapter: { stat(p: string): Promise<{ type: "file" | "folder" } | null>; read(p: string): Promise<string> };
    getMarkdownFiles(): Array<{ path: string }>;
    getAbstractFileByPath(path: string): unknown;
    process(file: unknown, fn: (data: string) => string): Promise<string>;
  };
  metadataCache: { getCache(path: string): { frontmatter?: Record<string, unknown> } | null };
}): CrosssessionSource {
  return {
    paths: () => app.vault.getMarkdownFiles().map((f) => f.path),
    frontmatter: (p) => app.metadataCache.getCache(p)?.frontmatter ?? null,
    async read(p) {
      const st = await app.vault.adapter.stat(p);
      if (!st || st.type !== "file") return null;
      try {
        return await app.vault.adapter.read(p);
      } catch {
        return null;
      }
    },
    async append(p, entryText) {
      const f = app.vault.getAbstractFileByPath(p);
      if (!f) throw new Error(`not a note: ${p}`);
      // vault.process is Obsidian's atomic read-modify-write — a concurrent
      // editor save and this append cannot interleave mid-file.
      await app.vault.process(f, (data) => (data === "" || data.endsWith("\n") ? data : data + "\n") + entryText);
    },
  };
}

/** The receipt store over the plugin's own data directory — beside the journal
 * and install-id.json (see receipts.ts's header for why there and not
 * data.json or the note tree).
 *
 * `pluginDir` comes from the host (`manifest.dir`, threaded as `ctx.pluginDir`)
 * and MUST be preferred: the folder name and the manifest id diverge after an
 * in-place id update (folder still `vault-mcp`, id `governor`), and receipts
 * written to the id-derived path would sit outside the live plugin dir — never
 * migrated, and silently discarded when the human deletes the stray folder,
 * which re-serves cross-session entries this session already attested. The
 * id-derived fallback is only for hosts that report no dir. */
export function obsidianReceiptStore(
  app: { vault: { adapter: ReceiptAdapter; configDir: string } },
  pluginDir?: string,
): ReceiptStore {
  return new ReceiptStore(app.vault.adapter, pluginDir ?? `${app.vault.configDir}/plugins/${PLUGIN_ID}`);
}
