// tools.ts — the vault-crosssession satellite's tool surface (#232): the
// fleet's coordination-log conventions given a real agent surface. FOUR tools,
// published to the Governor host through `vault-mcp-api` (see main.ts):
//
//   channels — discovery by fileclass + `audience:` frontmatter (declared
//              read-only; never by path)
//   delta    — entries newer than the caller's attested read position, both
//              entry forms merged (declared read-only)
//   attest   — record a read receipt: "handle read through <stamp>" (MUTATING —
//              this plugin's own state, not vault state; the lock-tools
//              precedent: a mutating registration buys the host's journal
//              record, so who-claimed-to-have-read is in the audit stream)
//   post     — append one `## <stamp> · <handle>` section to the channel's log
//              file; REFUSED (`stale_read`, typed, before any write) while
//              unread foreign entries exist (MUTATING — an ordinary guarded
//              vault write)
//
// ── The published names DID change ──────────────────────────────────────────
//
// The host publishes an external tool as `<sanitized publisher id>_<bare name>`.
// This plugin's id is `vault-crosssession`, which sanitizes to
// `vault_crosssession`, so the four bare names below go on the wire as
// `vault_crosssession_channels` / `_delta` / `_attest` / `_post` — NOT the
// `crosssession_*` the folded module shipped. Same rename class as the triage
// satellite, and for the same structural reason: the plugin id IS the tool
// namespace. Recorded in CLAUDE.md as the extraction's one breaking change,
// with the one-line reversal (the plugin id) named there.
//
// ── The cooperative-handle model (fallible-not-adversarial) ─────────────────
//
// `handle` is a tool argument the caller declares about itself. It is NOT
// authenticated: a session that lies about its handle defeats the staleness
// check for itself, exactly as a session that lies in a log entry defeats the
// log. The threat model (the fleet's standing call, restated in #232) is
// honest lapses — a session posting without having read — not adversaries;
// this plugin catches the former mechanically and does not pretend to stop
// the latter.
//
// Attestation is a READ-RECEIPT, not authority: it grants nothing, gates only
// this plugin's own `post`, needs no human gesture (agents attest their own
// reads), and lives in the plugin's state file — never in any note's
// frontmatter, and nowhere near the accepted family (it writes no note at
// all). See kernel/receipts.ts.
//
// ── Staleness (the `stale_read` policy refusal) ─────────────────────────────
//
// Posting asserts you are current: `post` refuses — typed `stale_read`, checked
// BEFORE any write — while the channel contains entries the posting handle's
// receipt does not cover. The handle's own entries are exempt (you are always
// current with yourself). On success the post auto-attests through its own
// entry, so a clean post-post-post run needs no interleaved attest calls.
//
// ── Allowlist discipline, as a satellite ────────────────────────────────────
//
// The ENFORCED boundary is now the HOST's, and for this surface it is strictly
// stricter than the in-tool filter it replaces. Precisely:
//
//   * NONE of the four tools carries a recognized path key. `channel` is a
//     REF — a channel uid, its folder-note path, or its folder — not a path
//     argument, and `handle` / `body` / `through_stamp` are not paths either.
//     The host distrusts an external tool's `readOnly: true` unless the
//     publisher's raw id is in `trustedReadOnlyPlugins`, so all four register
//     as MUTATING; and a mutating external tool with no recognized path key is
//     BLOCKED OUTRIGHT while a path allowlist is active — trusted or not. So
//     under an allowlist the whole surface is refused WHOLESALE, where the
//     module filtered its channel listing. That is fail-closed and strictly
//     stricter. With no allowlist configured the `visible` filter was a no-op
//     anyway, so nothing else changes.
//   * `channel` was deliberately NOT renamed to a path key, and that is a
//     decision rather than an omission. Three reasons, in order of weight:
//     (1) it would not scope the write — `post` appends to a log file it
//     DISCOVERS inside the channel folder, which no call argument ever names,
//     so path-keying `channel` would hand the guard the folder NOTE and leave
//     the file actually written unscoped, which is the illusion of a check;
//     (2) a `channel` value may be a UID, and `isVisible` would prefix-match a
//     uid string as if it were a path and refuse every uid-addressed call under
//     an allowlist — the exact bug the host fixed by renaming its scheme-write
//     `to` → `to_address` AWAY from a path key, an address string not being a
//     path; (3) it would newly expose the tool to the host's record-immutability
//     guard on the WRONG path (the folder note, not the appended file). The
//     triage satellite's `target` → `target_path` rename went the other way
//     because `target` WAS the destination the call named. See CLAUDE.md.
//
// `ctx.visible` and `ctx.getSettings` are kept as seams and are NOT supplied in
// the shipped configuration — the same defence-in-depth posture the skills and
// triage satellites keep. Their tests supply them so they cannot rot, and a
// future `vault-mcp-api` that can carry the caller's scope to a publisher (an
// apiVersion-2 item) will supply them for real with no change to the code below.
//
// ── The record-immutability guard, before and after ─────────────────────────
//
// The host refuses a mutating operation that NAMES a note whose frontmatter
// carries `record: true`, exempting `obsidian_append_note` by tool identity.
// `crosssession_post` was named in that exemption set's comment as the one
// other pure-EOF-append tool, deliberately NOT exempted because it was
// "unreachable by this check today". That reasoning was never about bypassing
// the kernel — module tools registered through the same guard-patched
// registrar this satellite's tools now ride, kernel checks included. It was
// about ARGUMENTS: the host collects paths from `PATH_KEYS`, `channel` is not
// one, so `collectPaths({handle, channel, body})` is empty and the guard has
// nothing to check. THAT IS UNCHANGED BY THE EXTRACTION — the argument names
// did not change — so `vault_crosssession_post` reaches the check with the same
// empty path list and is refused by it exactly as often as before: never. The
// exemption set was therefore NOT widened; the host's comment and test were
// updated to name the new tool identity and where it lives.
//
// ── Envelope convention (the satellite contract) ────────────────────────────
//
// A handler returns PLAIN DATA and THROWS on refusal. The host wraps a return
// value in `ok()` and a thrown error in `fail()`; `fail()` reads a lowercase
// snake `code` off the thrown error and renders `Error [code]: message`, the
// same shape the module's `codedError` produced — so every typed refusal an
// agent sees is byte-compatible with the folded era. `ok` / `fail` /
// `codedError` themselves are host-internal and are not imported here.
//
// ── Schema fidelity across the boundary ─────────────────────────────────────
//
// The SDK converts a zod shape to JSON Schema and the host converts it back
// through a deliberately small subset (`json-schema-to-zod.ts`): `type`,
// `description` and STRING `enum` survive; `default`, `min`, `max` and
// `pattern` DO NOT. Every `.min(1)` below is therefore re-applied in the
// handler (`requireText`) — that is the `vault_skills_release` semver lesson:
// a constraint that lives only in the declared schema never runs for an MCP
// caller.
//
// Obsidian-free by construction: the vault arrives through the injected
// CrosssessionSource, receipts through ReceiptStoreLike — every handler is
// headless-testable. The live adapters are in obsidian-source.ts.

import { z } from "zod";
import type { SdkToolSpec } from "vault-mcp-api";
import type { GuardSettings } from "@vault-mcp/core";
import {
  channelKey,
  channelMembers,
  discoverChannels,
  isEntryHeadingLine,
  loadChannelEntries,
  newestStamp,
  orderKey,
  unreadFor,
  crosssessionConfigOf,
  type Channel,
  type ChannelEntry,
  type CrosssessionConfig,
  type ReceiptStoreLike,
} from "./kernel/index.js";

/** The read tools' SDK flags. `readOnly: true` is a CLAIM the host distrusts by
 * default — see the allowlist note in the header for what that costs. */
const RO = { readOnly: true, destructive: false, idempotent: true } as const;
/** The write tools' SDK flags. */
const RW = { readOnly: false, destructive: false, idempotent: false } as const;

/**
 * A TYPED refusal, thrown. `fail()` in the host reads a lowercase-snake `code`
 * off the error and renders `Error [code]: message` — the identical envelope
 * the module's `codedError` produced.
 */
export class CrosssessionRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CrosssessionRefusal";
    this.code = code;
  }
}

/** Declared as a FUNCTION, not a const arrow: TypeScript only narrows control
 * flow through a `never`-returning call when the callee is a function
 * declaration (or an explicitly annotated const). */
function refuse(code: string, message: string): never {
  throw new CrosssessionRefusal(code, message);
}

/** What the plugin needs from the vault — structurally typed, no `obsidian`
 * import (the LinkSource/TriageSource discipline). */
export interface CrosssessionSource {
  /** Every markdown path in the vault (UNfiltered; the tool layer applies the
   * `visible` filter, when it has one, before anything is read). */
  paths(): string[];
  /** A note's cached frontmatter, or null. */
  frontmatter(path: string): Record<string, unknown> | null;
  /** A file's full text, or null when it does not exist / cannot be read. */
  read(path: string): Promise<string | null>;
  /** Append `entryText` at end-of-file, inserting a newline first when the
   * file does not already end with one. Throws when the file is missing. */
  append(path: string, entryText: string): Promise<void>;
}

/** An inert source — a stand-in for tests and for a plugin instance with no
 * vault injected: no channels, nothing to read or write. */
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
  /** The config overrides (this plugin's own settings). A THUNK, read per call:
   * a captured record would freeze the settings tab's values at plugin load.
   * (The tool DESCRIPTIONS below are necessarily build-time snapshots of it,
   * which is why main.ts re-publishes on every settings write.) */
  config: () => Record<string, unknown>;
  /** Guard settings accessor — a DORMANT seam, unsupplied in the shipped
   * configuration (a satellite cannot reach the host's guard settings). Kept
   * for the day `vault-mcp-api` can carry the caller's scope to a publisher. */
  getSettings?: () => GuardSettings;
  /** Allowlist filter — the same dormant seam. Absent ⇒ nothing filtered. */
  visible?: (paths: string[]) => string[];
  /** The read-receipt store (plugin state — see kernel/receipts.ts). */
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

/**
 * Re-apply a `.min(1)` the boundary drops, and the string type with it.
 *
 * The host reconstructs `type: "string"` from the JSON Schema, so a non-string
 * would normally be rejected upstream — but the SDK also accepts a hand-written
 * JSON Schema, and a bare `{}` property degrades to `z.unknown()`. Checking
 * here means the bound holds however the spec reached the host, and it is the
 * same discipline the triage satellite applies to its `limit` clamp.
 */
function requireText(value: unknown, argument: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    refuse("invalid_argument", `'${argument}' must be a non-empty string`);
  }
  return value;
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
 * parse (the honest-mistake class this plugin exists to catch) — and code
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

export function buildCrosssessionTools(source: CrosssessionSource, ctx: CrosssessionToolsCtx): SdkToolSpec[] {
  const vis = ctx.visible ?? ((p: string[]) => p);
  const now = ctx.now ?? (() => new Date());

  /** The effective config, resolved PER CALL so a settings edit lands live. */
  const cfgNow = (): CrosssessionConfig => crosssessionConfigOf(ctx.config());
  /** The config as it stands while the SPECS are built — descriptions only.
   * The host snapshots a published spec, so this is necessarily frozen at
   * publish time; main.ts re-publishes on every settings write. */
  const cfgAtBuild = cfgNow();

  /** The visible vault listing — resolved per call, same freshness rule. */
  const visiblePathsNow = () => vis(source.paths());

  const channels = (paths: string[], cfg: CrosssessionConfig): Channel[] =>
    discoverChannels(paths, (p) => source.frontmatter(p), cfg.channelFileclass);

  /** Resolve a `channel` argument — uid, folder-note path, or folder path —
   * against the VISIBLE channel set only. A hidden or nonexistent channel is
   * one answer: null (no existence oracle). */
  async function resolveChannel(ref: string, cfg: CrosssessionConfig): Promise<ResolvedChannel | null> {
    const paths = visiblePathsNow();
    const ch = channels(paths, cfg).find((c) => c.uid === ref || c.path === ref || c.folder === ref);
    if (!ch) return null;
    const members = channelMembers(ch, paths, (p) => source.frontmatter(p), cfg.messageFileclass);
    const entries = await loadChannelEntries(ch, members, (p) => source.read(p));
    return { channel: ch, members, entries };
  }

  return [
    {
      name: "channels",
      description:
        "Discover every cross-session coordination channel — notes carrying the channel fileClass " +
        `("${cfgAtBuild.channelFileclass}" by default) plus an \`audience:\` frontmatter value — by frontmatter ` +
        "only, never by path. Returns uid, path, audience, linked projects, entry count, newest stamp, and every " +
        "recorded read receipt (which handles are current, which are behind). With `handle`, adds that handle's " +
        "own read position and unread count per channel. Read-only in intent; the Governor host registers it as " +
        "mutating unless this plugin is trusted, and blocks it outright while a path allowlist is active (it " +
        "carries no path argument to scope by).",
      inputSchema: {
        handle: z
          .string()
          .optional()
          .describe("Your session handle (self-declared, cooperative). Adds your read position + unread count per channel."),
      },
      ...RO,
      handler: async ({ handle }: Record<string, unknown>) => {
        const cfg = cfgNow();
        if (handle !== undefined) {
          const bad = handleRefusal(handle);
          if (bad) refuse("invalid_handle", bad);
        }
        const own = typeof handle === "string" ? handle : undefined;
        const paths = visiblePathsNow();
        const out = [];
        for (const ch of channels(paths, cfg)) {
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
          const mine = own !== undefined ? (receipts[own]?.through ?? null) : null;
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
            ...(own !== undefined
              ? { read_position: mine, unread_count: unreadFor(entries, mine, own).length }
              : {}),
          });
        }
        return { channels: out, channel_fileclass: cfg.channelFileclass, message_fileclass: cfg.messageFileclass };
      },
    },

    {
      name: "delta",
      description:
        "Entries newer than your attested read position — full text, parsed into {stamp, handle, body} from both " +
        "forms (the channel's `## <stamp> · <handle>` log-file sections and its per-message notes), oldest first. " +
        "Your own entries are omitted (they are exempt from staleness). Capped per channel (`more: true` + " +
        "`next_stamp` when truncated — attest through the last served stamp, then call again). `channel` accepts a " +
        "channel uid, its folder-note path, or its folder; omit it to read every visible channel. Read-only in " +
        "intent; blocked outright while a Governor path allowlist is active (no path argument to scope by).",
      inputSchema: {
        handle: z.string().min(1).describe("Your session handle (self-declared, cooperative)."),
        channel: z
          .string()
          .optional()
          .describe("Channel uid, folder-note path, or folder path. Omit for all visible channels."),
      },
      ...RO,
      handler: async (args: Record<string, unknown>) => {
        const cfg = cfgNow();
        const handle = requireText(args.handle, "handle");
        const bad = handleRefusal(handle);
        if (bad) refuse("invalid_handle", bad);
        const channelRef = args.channel;
        let resolved: ResolvedChannel[];
        if (channelRef !== undefined) {
          const ref = requireText(channelRef, "channel");
          const one = await resolveChannel(ref, cfg);
          if (!one) refuse("channel_unresolved", `no visible channel matches '${ref}'`);
          resolved = [one];
        } else {
          const paths = visiblePathsNow();
          resolved = [];
          for (const ch of channels(paths, cfg)) {
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
        return { handle, channels: out };
      },
    },

    {
      name: "attest",
      description:
        "Record that your handle has read a channel through `through_stamp` — a READ-RECEIPT, not authority: it " +
        "grants nothing, touches no note (state lives in this plugin's own directory, never in note frontmatter " +
        "and never in settings), and only feeds `post`'s staleness check. Any stamp at or before the channel's " +
        "newest entry is accepted (cooperative model: handles are self-declared and receipts are claims, not " +
        "verified reads). Mutating — the receipt write is journaled by the host like a lock claim, though no vault " +
        "file changes.",
      inputSchema: {
        handle: z.string().min(1).describe("Your session handle (self-declared, cooperative)."),
        channel: z.string().min(1).describe("Channel uid, folder-note path, or folder path."),
        through_stamp: z
          .string()
          .min(1)
          .describe("The stamp of the last entry you have read (verbatim, e.g. \"2026-08-18T13:40\")."),
      },
      ...RW,
      handler: async (args: Record<string, unknown>) => {
        const cfg = cfgNow();
        const handle = requireText(args.handle, "handle");
        const bad = handleRefusal(handle);
        if (bad) refuse("invalid_handle", bad);
        const channelRef = requireText(args.channel, "channel");
        const throughStamp = requireText(args.through_stamp, "through_stamp");
        const r = await resolveChannel(channelRef, cfg);
        if (!r) refuse("channel_unresolved", `no visible channel matches '${channelRef}'`);
        const newest = newestStamp(r.entries);
        if (newest === null || orderKey(throughStamp) > orderKey(newest)) {
          refuse(
            "stamp_ahead",
            newest === null
              ? "the channel has no entries — there is nothing to attest reading"
              : `through_stamp '${throughStamp}' is ahead of the channel's newest entry ('${newest}') — you cannot attest reads that do not exist yet`,
          );
        }
        const key = channelKey(r.channel);
        await ctx.receipts.set(key, handle, throughStamp, now().toISOString());
        return {
          channel: { uid: r.channel.uid, path: r.channel.path },
          handle,
          through: throughStamp,
          unread_after: unreadFor(r.entries, throughStamp, handle).length,
        };
      },
    },

    {
      name: "post",
      description:
        "Append one `## <stamp> · <handle>` entry (run clock, minutes precision) to the channel's single " +
        "append-only log file. REFUSES `stale_read` — before anything is written — while the channel holds " +
        "entries your receipt does not cover (your own entries exempt): posting asserts you are current; run the " +
        "delta tool then the attest tool first. On success, auto-attests your handle through the new entry. An " +
        "ordinary guarded mutating tool: the Governor host's read-only mode, write queue, journal and kernel " +
        "arguments all apply, and an active path allowlist blocks it outright (the channel reference is not a " +
        "path argument). It appends body text at end-of-file only — it does not touch frontmatter.",
      inputSchema: {
        handle: z.string().min(1).describe("Your session handle (self-declared, cooperative)."),
        channel: z.string().min(1).describe("Channel uid, folder-note path, or folder path."),
        body: z
          .string()
          .min(1)
          .describe("The entry body (markdown). May not contain a line that would itself parse as an entry heading."),
      },
      ...RW,
      handler: async (args: Record<string, unknown>) => {
        const cfg = cfgNow();
        const handle = requireText(args.handle, "handle");
        const badHandle = handleRefusal(handle);
        if (badHandle) refuse("invalid_handle", badHandle);
        const channelRef = requireText(args.channel, "channel");
        const body = requireText(args.body, "body");
        const badBody = bodyRefusal(body);
        if (badBody) refuse("invalid_body", badBody);
        const r = await resolveChannel(channelRef, cfg);
        if (!r) refuse("channel_unresolved", `no visible channel matches '${channelRef}'`);
        const key = channelKey(r.channel);
        const through = (await ctx.receipts.get(key, handle))?.through ?? null;

        // ── the staleness gate: a POLICY refusal, before any write ─────────
        const unread = unreadFor(r.entries, through, handle);
        if (unread.length > 0) {
          const preview = unread
            .slice(0, 5)
            .map((e) => `${e.stamp} · ${e.handle}`)
            .join(", ");
          refuse(
            "stale_read",
            `posting asserts you are current, and ${unread.length} entr${unread.length === 1 ? "y" : "ies"} in this ` +
              `channel ${unread.length === 1 ? "is" : "are"} newer than your attested read position` +
              `${through === null ? " (you have no receipt on this channel)" : ` ('${through}')`}: ${preview}` +
              `${unread.length > 5 ? ", …" : ""}. Read them with the delta tool, attest with the attest tool, ` +
              "then post.",
          );
        }

        // ── the append target: the channel's single log file ───────────────
        let logCandidates = r.members.logFiles;
        if (logCandidates.length === 0) {
          refuse("no_log_file", "this channel has no append-file to post into (only per-message notes)");
        }
        if (logCandidates.length > 1) {
          // Narrow to the files that actually carry entries — a stray non-log
          // note in the channel folder must not make the real log ambiguous.
          const withEntries = logCandidates.filter((p) => r.entries.some((e) => e.source === p));
          if (withEntries.length === 1) logCandidates = withEntries;
          else {
            refuse(
              "log_ambiguous",
              `this channel has ${logCandidates.length} candidate log files (${logCandidates.join(", ")}) — cannot ` +
                "pick one to append to",
            );
          }
        }
        const target = logCandidates[0];

        // BYTE-COMPATIBLE with the folded module and with the hand-written
        // convention: a blank line, the `## <stamp> · <handle>` heading, a blank
        // line, the trimmed body, a trailing newline. The source's `append`
        // inserts the file's own missing trailing newline first. Nothing about
        // this format may drift — the fleet's live CROSS-SESSION.md is parsed by
        // this plugin AND by humans AND by shell heredoc appends.
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
        return {
          posted: { channel: { uid: r.channel.uid, path: r.channel.path }, path: target, stamp, handle },
          attested_through: attested ? newThrough : null,
          // The host's reportedEffects convention (guarded.ts): the append
          // target is a DISCOVERED path — the args name only a channel ref, so
          // the journal's argument-derived `target` is empty; `filesChanged` /
          // `files` puts the file actually touched into the record's `effects`
          // field. It survives the publishing boundary because the host wraps a
          // returned object as `ok(data)`, so this IS the structuredContent
          // `reportedEffects` reads.
          filesChanged: 1,
          files: [target],
        };
      },
    },
  ];
}
