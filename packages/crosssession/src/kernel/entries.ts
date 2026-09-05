// entries.ts — the cross-session channel model, pure (#232).
//
// A CHANNEL is a vault note discovered by fileclass + `audience:` frontmatter
// (never by path — the vault convention's own rule). Two entry forms live in a
// channel's folder and are read together:
//
//   • the single append-only log file (`## <stamp> · <handle>` sections, e.g.
//     CROSS-SESSION.md), and
//   • per-message notes (`fileClass: Agent/Log/CrossSession`, filename
//     `<stamp> · <handle>.md`, write-once).
//
// STAMPS ARE OPAQUE ORDERED STRINGS, never parsed as datetimes: the live file
// contains imprecise stamps (`…T14:2x`) that no Date parser survives. Ordering
// uses `orderKey` — the stamp with `:` stripped — so the file form
// (`2026-08-18T13:40`) and the filename form (`2026-08-18T1340`) of the same
// minute compare equal instead of interleaving wrongly, and `:2x` still sorts
// deterministically after `:25` (byte order). Beyond that one normalization the
// comparison is plain string order; equal keys keep log-before-note, then
// source-position order (stable sort).
//
// Kernel-module rules apply: no `obsidian` import, no MCP import — the tool
// layer feeds this from an injected source.

/** One parsed channel entry, from either form. */
export interface ChannelEntry {
  /** The entry's stamp, verbatim (e.g. "2026-08-18T13:40", "2026-08-18T14:2x"). */
  stamp: string;
  /** The posting session's self-declared handle (cooperative, not authenticated). */
  handle: string;
  /** Optional third ` · ` heading segment (the fleet convention's EVENT type). */
  event?: string;
  /** Full entry body (everything under the heading, up to the next entry). */
  body: string;
  /** Vault path of the file this entry lives in. */
  source: string;
  /** Which form carried it: a log-file section or a per-message note. */
  form: "log" | "note";
}

/** ` · ` — the middle-dot separator the live convention uses in headings and
 * per-message filenames. */
export const ENTRY_SEP = " · ";

/** Matches an entry heading: `## <stamp> · <handle>[ · <event>]`. Plain `##`
 * headings without the separator (the live file's own rule prose — "##
 * Principle", "## Message format") are NOT entries and stay part of the
 * surrounding text. */
const ENTRY_HEADING_RE = /^##\s+(.+?)\s+·\s+(.+?)\s*$/;

/** True when a line would parse as an entry heading — the shape
 * `crosssession_post` refuses inside a body (an honest paste of a log excerpt
 * would otherwise mint phantom entries on the next parse). */
export function isEntryHeadingLine(line: string): boolean {
  return ENTRY_HEADING_RE.test(line);
}

/** The comparison key for a stamp: `:` stripped, otherwise verbatim. See the
 * header for why this one normalization exists (file form vs filename form of
 * the same minute). */
export function orderKey(stamp: string): string {
  return stamp.replace(/:/g, "");
}

/** Strip a leading `---` YAML frontmatter block, returning the body. Tolerant:
 * an unterminated opener is left in place rather than swallowing the file. The
 * closer must be a line that IS `---` (trimmed), not merely one starting with
 * `---` — a `----` rule inside a multiline YAML string is not a closer. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return text;
}

/**
 * Parse a log file's `## <stamp> · <handle>` sections into entries, in FILE
 * POSITION order. Frontmatter and any preamble before the first entry heading
 * (the live file carries its whole rules document there) are skipped; a plain
 * `##` heading after an entry stays inside that entry's body.
 */
export function parseLogEntries(text: string, source: string): ChannelEntry[] {
  const body = stripFrontmatter(text);
  const lines = body.split("\n");
  const entries: ChannelEntry[] = [];
  let current: ChannelEntry | null = null;
  let bodyLines: string[] = [];
  // Code-fence tracking: the live file's rules preamble carries a FENCED
  // example of the heading shape (`## <ISO timestamp> · <handle> · <EVENT>`
  // inside ``` … ```) — a line inside a fence is content, never a heading.
  // Marker-matched: a fence opened with ``` closes only on ``` and one opened
  // with ~~~ only on ~~~, so a ~~~ block legitimately SHOWING ``` lines does
  // not mis-toggle the state.
  let fence: string | null = null;
  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
      entries.push(current);
    }
    current = null;
    bodyLines = [];
  };
  for (const line of lines) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f && (fence === null || fence === f[1])) {
      fence = fence === null ? f[1] : null;
      if (current) bodyLines.push(line);
      continue;
    }
    const m = fence !== null ? null : ENTRY_HEADING_RE.exec(line);
    if (m) {
      flush();
      // The heading text may carry a further ` · <event>` segment; the regex's
      // second group grabbed everything after the first separator, so split it
      // once more.
      const rest = m[2].split(ENTRY_SEP);
      current = {
        stamp: m[1],
        handle: rest[0].trim(),
        ...(rest.length > 1 ? { event: rest.slice(1).join(ENTRY_SEP).trim() } : {}),
        body: "",
        source,
        form: "log",
      };
    } else if (current) {
      bodyLines.push(line);
    }
    // Lines before the first entry heading: preamble, ignored.
  }
  flush();
  return entries;
}

/**
 * Parse a per-message note (`<stamp> · <handle>.md`) into an entry. Stamp and
 * handle come from the FILENAME (the write-once convention's identity); the
 * body is the note text minus frontmatter. Returns null when the filename does
 * not carry the ` · ` separator — such a file is not a message note.
 */
export function parseMessageNote(path: string, text: string): ChannelEntry | null {
  const base = path.split("/").pop() ?? path;
  const name = base.endsWith(".md") ? base.slice(0, -3) : base;
  const parts = name.split(ENTRY_SEP);
  if (parts.length < 2) return null;
  return {
    stamp: parts[0].trim(),
    handle: parts[1].trim(),
    ...(parts.length > 2 ? { event: parts.slice(2).join(ENTRY_SEP).trim() } : {}),
    body: stripFrontmatter(text).trim(),
    source: path,
    form: "note",
  };
}

/**
 * Total order over a channel's entries: by `orderKey(stamp)`, stable — the
 * input arrays' own orders (file position for log entries; caller-sorted path
 * order for notes) break ties, with log entries before note entries when both
 * carry the same key (pass logs first). `Array.prototype.sort` is stable per
 * spec, so this is deterministic over the same entry set.
 */
export function sortEntries(entries: ChannelEntry[]): ChannelEntry[] {
  return [...entries].sort((a, b) => {
    const ka = orderKey(a.stamp);
    const kb = orderKey(b.stamp);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * The entries `handle` has NOT covered: stamp strictly after the attested
 * `through` position (string order over `orderKey`), excluding the handle's
 * OWN entries (posting's staleness check exempts them — you are always current
 * with yourself). `through: null` means no receipt: everything foreign is
 * unread.
 */
export function unreadFor(entries: ChannelEntry[], through: string | null, handle: string): ChannelEntry[] {
  const thr = through === null ? null : orderKey(through);
  return entries.filter((e) => e.handle !== handle && (thr === null || orderKey(e.stamp) > thr));
}

/** The newest entry's stamp under the channel order, or null for an empty
 * channel. */
export function newestStamp(entries: ChannelEntry[]): string | null {
  if (entries.length === 0) return null;
  const sorted = sortEntries(entries);
  return sorted[sorted.length - 1].stamp;
}

// ── channel discovery ────────────────────────────────────────────────────────

/** A discovered channel: the folder note that declares it. */
export interface Channel {
  /** Frontmatter `uid`, when present — the durable receipt key (a reorg move
   * keeps read state). Null ⇒ the path keys the receipts instead. */
  uid: string | null;
  /** Vault path of the channel's folder note. */
  path: string;
  /** The folder whose files are the channel's entries. */
  folder: string;
  /** Frontmatter `audience:` verbatim ("fleet", "project", …). */
  audience: string;
  /** Frontmatter `projects:` links, verbatim strings. */
  projects: string[];
}

/** The receipt-map key for a channel: uid when the note carries one, else the
 * path (prefixed so the two namespaces cannot collide). */
export function channelKey(ch: Channel): string {
  return ch.uid ?? `path:${ch.path}`;
}

/** True when a `fileClass` frontmatter value (string or array) names `want`. */
export function fileClassMatches(value: unknown, want: string): boolean {
  if (typeof value === "string") return value === want;
  if (Array.isArray(value)) return value.some((v) => v === want);
  return false;
}

function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Discover every channel in a note listing: a note whose fileclass matches
 * `channelFileclass` AND whose frontmatter carries a string `audience`. BY
 * FRONTMATTER ONLY — no path is ever special-cased, matching the vault
 * convention ("discovery is by fileclass + audience frontmatter, never by
 * hardcoded path"). The caller passes an allowlist-VISIBLE listing; a hidden
 * channel note is simply never seen here.
 */
export function discoverChannels(
  paths: string[],
  frontmatterOf: (path: string) => Record<string, unknown> | null,
  channelFileclass: string,
): Channel[] {
  const out: Channel[] = [];
  for (const p of paths) {
    const fm = frontmatterOf(p);
    if (!fm) continue;
    if (!fileClassMatches(fm.fileClass, channelFileclass)) continue;
    if (typeof fm.audience !== "string" || fm.audience.length === 0) continue;
    const projects = Array.isArray(fm.projects) ? fm.projects.filter((x): x is string => typeof x === "string") : [];
    out.push({
      uid: typeof fm.uid === "string" && fm.uid.length > 0 ? fm.uid : null,
      path: p,
      folder: dirnameOf(p),
      audience: fm.audience,
      projects,
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A channel's member files, split by form. `paths` must already be the
 * allowlist-visible listing — a hidden member contributes no entries and is
 * never read. Only DIRECT children of the channel folder count. */
export function channelMembers(
  ch: Channel,
  paths: string[],
  frontmatterOf: (path: string) => Record<string, unknown> | null,
  messageFileclass: string,
): { logFiles: string[]; noteFiles: string[] } {
  const logFiles: string[] = [];
  const noteFiles: string[] = [];
  for (const p of paths) {
    if (p === ch.path || dirnameOf(p) !== ch.folder || !p.endsWith(".md")) continue;
    const fm = frontmatterOf(p);
    if (fm && fileClassMatches(fm.fileClass, messageFileclass)) noteFiles.push(p);
    else logFiles.push(p);
  }
  logFiles.sort();
  noteFiles.sort();
  return { logFiles, noteFiles };
}

/**
 * Load and order a channel's full entry list from both forms. `read` returns a
 * file's text or null (a vanished/unreadable member contributes nothing rather
 * than failing the channel).
 */
export async function loadChannelEntries(
  ch: Channel,
  members: { logFiles: string[]; noteFiles: string[] },
  read: (path: string) => Promise<string | null>,
): Promise<ChannelEntry[]> {
  const logs: ChannelEntry[] = [];
  for (const p of members.logFiles) {
    const text = await read(p);
    if (text !== null) logs.push(...parseLogEntries(text, p));
  }
  const notes: ChannelEntry[] = [];
  for (const p of members.noteFiles) {
    const text = await read(p);
    if (text === null) continue;
    const e = parseMessageNote(p, text);
    if (e) notes.push(e);
  }
  // Logs first so the stable sort keeps log-before-note on equal keys.
  return sortEntries([...logs, ...notes]);
}
