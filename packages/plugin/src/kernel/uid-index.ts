// The uid index — the identity substrate's first store (Delivery step 2:
// "the uid index … every later store keys on uid").
//
// One map, `uid → path`, and its inverse. It exists because a path is a SECOND
// representation of identity: rename a note and every path-keyed reference to it
// is silently wrong, while its uid is exactly as true as it was. Downstream
// stores (baselines, chains, journal targets) key on uid so they survive
// renames; this is the map they survive them through.
//
// ── what it is NOT ───────────────────────────────────────────────────────────
//
// It does not read files. It is built and refreshed entirely from an injected
// UidSource — in the plugin, Obsidian's own metadata cache, which has already
// parsed every frontmatter block. Building by reading the vault would take
// seconds on a large vault at every load, to learn what the host already knows.
//
// It does not repair anything. Two notes carrying one uid is a real condition in
// a real vault, and the index's job is to make it VISIBLE and queryable, not to
// pick a winner and rewrite somebody's frontmatter behind their back. Link
// healing likewise belongs to a later slice.
//
// ── duplicates ───────────────────────────────────────────────────────────────
//
// A uid may map to several paths. The index keeps them ALL, in precedence order
// (first wins for a bare lookup; `rebuild` sorts and incremental adds insert in
// sorted position, so "first" is a property of the vault rather than of
// cache-warming or edit order — an in-place `onRenamed` is the one documented
// exception). Addressing a duplicated uid is a typed ERROR, never a silent pick:
// see requireOne — which decides over the candidates the caller's allowlist
// leaves VISIBLE, so a duplicate is never a way to read a path out of a sandbox.
//
// ── uid addressing ───────────────────────────────────────────────────────────
//
// `uid:<value>` in any path-bearing argument resolves through this index before
// a tool handler runs — see resolveUidArgs, applied at the one interception
// point in mcp/guarded.ts.
//
// Obsidian-free by construction, like every other kernel module: the adapter
// lives in obsidian-probe.ts and the events are wired in main.ts.

import { mapPaths, visiblePaths, type GuardSettings } from "../guard.js";

/**
 * Where the index gets its facts. Cheap, synchronous, cache-backed lookups —
 * never a read from disk. Implemented over Obsidian's metadataCache in
 * obsidian-probe.ts (`obsidianUidSource`).
 */
export interface UidSource {
  /** Every path the source can carry a uid for. */
  paths(): string[];
  /** Frontmatter `uid` for a path, when the cache already holds one. */
  uidOf(path: string): string | undefined;
}

/** A uid lookup's full answer: the winning path, and every path that carries it. */
export interface UidResolution {
  uid: string;
  /** The winning path — the first in precedence order. Absent when unknown. */
  path?: string;
  /** ALL paths carrying this uid, in precedence order. `length > 1` ⇒ duplicate. */
  paths: string[];
}

/** One uid carried by more than one note. Reported, never auto-fixed. */
export interface UidDuplicate {
  uid: string;
  paths: string[];
}

/** The prefix that turns a path argument into a uid reference. */
export const UID_PREFIX = "uid:";

// A duplicate can in principle be large; an error message should not be.
const MAX_LISTED_PATHS = 10;

/**
 * Typed failure for a uid that names no note. Nothing runs: an unresolvable uid
 * is a caller error, and guessing a path from it is precisely the silent
 * mis-targeting uid addressing exists to prevent.
 */
export class UidUnresolvedError extends Error {
  readonly code = "uid_unresolved";
  constructor(
    readonly uid: string,
    detail?: string
  ) {
    super(
      `uid '${uid}' names no note in this vault` +
        (detail ? ` (${detail})` : "") +
        `. Nothing ran — address the note by path, or look the uid up with obsidian_resolve_uid.`
    );
    this.name = "UidUnresolvedError";
  }
}

/**
 * Typed failure for a uid carried by more than one note. Nothing runs, and the
 * error NAMES the candidates: uid addressing needs exactly one target, and
 * picking the first would write into whichever note happened to sort earlier.
 *
 * The candidates it names are the ALLOWLIST-VISIBLE ones (see requireOne). It
 * used to name every carrier, which handed a sandboxed session the paths its
 * allowlist exists to hide — a duplicated uid was a path oracle for the rest of
 * the vault.
 */
export class UidAmbiguousError extends Error {
  readonly code = "uid_ambiguous";
  constructor(
    readonly uid: string,
    readonly paths: string[]
  ) {
    const listed = paths.slice(0, MAX_LISTED_PATHS);
    super(
      `uid '${uid}' is carried by ${paths.length} notes — ${listed.join(", ")}` +
        (paths.length > listed.length ? `, +${paths.length - listed.length} more` : "") +
        `. Nothing ran: uid addressing needs exactly one target. Address the note by path, or give the ` +
        `duplicates distinct uids.`
    );
    this.name = "UidAmbiguousError";
  }
}

/**
 * `uid:<value>` → `<value>`; anything else → undefined (so it stays a literal
 * path). A bare `uid:` with nothing after it is NOT a reference — it names no
 * uid, and treating it as one would turn a typo into a typed error about an
 * empty uid rather than a plain "no such file".
 */
export function uidRef(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(UID_PREFIX)) return undefined;
  const uid = value.slice(UID_PREFIX.length).trim();
  return uid || undefined;
}

/** What a call's uid addressing resolved to. */
export interface UidAddressing {
  /**
   * The arguments with every uid reference replaced by its resolved path. The
   * SAME object when the call used no uid addressing at all — behavior for
   * ordinary path arguments is unchanged, byte for byte.
   */
  args: Record<string, unknown>;
  /** Each reference resolved, in walk order. Empty ⇒ no uid addressing was used. */
  resolved: Array<{ uid: string; path: string }>;
}

/**
 * Rewrite every `uid:<value>` path argument to the path it names.
 *
 * Throws UidUnresolvedError / UidAmbiguousError — the caller renders them as
 * typed tool errors and nothing runs. Defined over the guard's own path walker,
 * so the arguments uid addressing reaches and the arguments the allowlist scopes
 * are the same set by construction: a tool the guard can see cannot be
 * unaddressable, and a tool addressable by uid cannot escape the allowlist.
 *
 * `settings` is the session's guard settings, and resolution happens over the
 * candidates that allowlist leaves VISIBLE — the same set `obsidian_resolve_uid`
 * reports, so looking a uid up and acting on it can never disagree. Omit it
 * (tests, no-allowlist embeds) and the whole candidate set decides, as before.
 */
export function resolveUidArgs(
  args: Record<string, unknown>,
  index: UidIndex | null,
  settings?: GuardSettings | null
): UidAddressing {
  const resolved: Array<{ uid: string; path: string }> = [];
  const rewritten = mapPaths(args ?? {}, (value) => {
    const uid = uidRef(value);
    if (uid === undefined) return value;
    // Fail closed. Without an index the reference cannot be resolved, and
    // treating `uid:019f…` as a literal filename would create a junk note (or
    // read a missing one) while the caller believes it addressed a real note.
    if (!index) throw new UidUnresolvedError(uid, "no uid index is active in this build");
    const path = index.requireOne(uid, settings);
    resolved.push({ uid, path });
    return path;
  });
  return { args: rewritten, resolved };
}

/**
 * `uid → path`, and its inverse, over a live UidSource.
 *
 * Freshness is EVENT-DRIVEN, never polled: `rebuild` once when the vault's cache
 * is warm, then `onChanged` / `onRenamed` / `onDeleted` from the host's own
 * events (wired in main.ts). Every mutation is O(1) in the number of notes
 * sharing the uid, so a busy vault costs nothing.
 */
export class UidIndex {
  /** uid → paths, in precedence order. Never contains an empty array. */
  private readonly byUid = new Map<string, string[]>();
  /** path → uid, for the inverse lookup and for cheap change detection. */
  private readonly byPath = new Map<string, string>();

  constructor(private readonly source: UidSource) {}

  /** Notes carrying a uid. Files without one are not indexed at all. */
  get size(): number {
    return this.byPath.size;
  }

  /** Distinct uids known. Lower than `size` exactly when duplicates exist. */
  get uidCount(): number {
    return this.byUid.size;
  }

  /**
   * Build (or rebuild) from scratch. Paths are sorted first so duplicate
   * PRECEDENCE is a property of the vault rather than of the order the metadata
   * cache happened to warm in.
   *
   * Incremental adds insert in sorted position too (see `add`), so a warm index
   * and a freshly rebuilt one agree — the ONE exception is `onRenamed`, which
   * replaces a mapping in place and can leave a duplicate's order diverging from
   * sorted until the next rebuild. That is a deliberate trade, stated here
   * rather than papered over: a rename must not silently demote the note a
   * duplicated uid currently resolves to.
   */
  rebuild(): void {
    this.byUid.clear();
    this.byPath.clear();
    for (const path of [...this.source.paths()].sort()) {
      const uid = this.source.uidOf(path);
      if (uid) this.add(path, uid);
    }
  }

  /**
   * A file's metadata was reparsed: adopt whatever uid it now has. Covers all
   * three edit shapes — a uid added, changed, or removed — and a file with no
   * uid is simply absent from the index rather than recorded as uid-less.
   */
  onChanged(path: string): void {
    const uid = this.source.uidOf(path) || undefined;
    if (this.byPath.get(path) === uid) return; // includes "had none, still none"
    this.drop(path);
    if (uid) this.add(path, uid);
  }

  /**
   * A file moved. The uid travels with it — that is the entire point of the
   * index — so the mapping is REPLACED IN PLACE where possible, which keeps a
   * duplicated uid's precedence order stable across an unrelated rename.
   *
   * What we already knew beats what the source says: at rename time the host's
   * cache may not have re-keyed onto the new path yet, and a subsequent
   * `changed` corrects us anyway if the frontmatter really did move too.
   */
  onRenamed(from: string, to: string): void {
    const carried = this.byPath.get(from);
    // A move can land on top of an existing note; that note's entry is gone.
    if (to !== from) this.drop(to);
    if (carried !== undefined) {
      const paths = this.byUid.get(carried);
      const at = paths ? paths.indexOf(from) : -1;
      if (at >= 0) paths![at] = to;
      this.byPath.delete(from);
      this.byPath.set(to, carried);
      return;
    }
    // Never indexed under `from` — it may have gained a uid, so ask the source.
    const uid = this.source.uidOf(to) || undefined;
    if (uid) this.add(to, uid);
  }

  /** A file is gone: so is its uid mapping. */
  onDeleted(path: string): void {
    this.drop(path);
  }

  /** The winning path for a uid, or undefined. Duplicates resolve to the first. */
  pathFor(uid: string): string | undefined {
    return this.byUid.get(uid)?.[0];
  }

  /** The uid a path carries, or undefined. The inverse direction. */
  uidFor(path: string): string | undefined {
    return this.byPath.get(path);
  }

  /** Full answer for a uid: the winner and every path carrying it. */
  resolve(uid: string): UidResolution {
    const paths = this.byUid.get(uid) ?? [];
    return { uid, ...(paths.length > 0 ? { path: paths[0] } : {}), paths: [...paths] };
  }

  /**
   * The single path a uid names, or a typed error. This is the ONLY resolution
   * uid ADDRESSING is allowed to use: unknown and ambiguous both refuse, because
   * both would otherwise act on a note the caller did not name.
   *
   * The decision is made over the candidates `settings` leaves VISIBLE, never
   * the raw carrier set:
   *
   *   • 0 visible ⇒ unresolved, even when hidden carriers exist. A sandboxed
   *     session learns that the uid names nothing IT can reach, which is all it
   *     is entitled to know;
   *   • 1 visible ⇒ that path. Exactly one target is exactly what addressing
   *     needs, and the hidden carriers are not this session's business;
   *   • 2+ visible ⇒ ambiguous, naming ONLY the visible ones.
   *
   * Which is the same rule `obsidian_resolve_uid` applies to what it reports:
   * the lookup and the addressing answer one question one way. Without settings
   * (or without an allowlist) every carrier is visible and this is the plain
   * duplicate check it has always been.
   */
  requireOne(uid: string, settings?: GuardSettings | null): string {
    const paths = visiblePaths(this.byUid.get(uid) ?? [], settings);
    if (paths.length === 0) throw new UidUnresolvedError(uid);
    if (paths.length > 1) throw new UidAmbiguousError(uid, [...paths]);
    return paths[0];
  }

  /**
   * Every indexed path, in insertion order. Exists so a caller that must report
   * the index's CARDINALITY can filter it first: `size` and `uidCount` describe
   * the whole vault, and handing those to an allowlisted session tells it how
   * much is out there — the same path-oracle leak `visiblePaths` closes for the
   * paths themselves.
   */
  indexedPaths(): string[] {
    return [...this.byPath.keys()];
  }

  /** Every uid carried by more than one note. Reported for repair, never repaired. */
  duplicates(): UidDuplicate[] {
    const out: UidDuplicate[] = [];
    for (const [uid, paths] of this.byUid) if (paths.length > 1) out.push({ uid, paths: [...paths] });
    return out;
  }

  /**
   * Insert in SORTED position, not at the end. Appending made a duplicate's
   * precedence depend on the order the events happened to arrive in, so a warm
   * index and the same vault after a reload could disagree about which note a
   * duplicated uid resolves to — the thing `rebuild`'s sort exists to prevent,
   * undone by the first incremental add. A linear scan over the carriers of ONE
   * uid is free: the array has one element in every case but a duplicate.
   */
  private add(path: string, uid: string): void {
    this.byPath.set(path, uid);
    const paths = this.byUid.get(uid);
    if (!paths) {
      this.byUid.set(uid, [path]);
      return;
    }
    if (paths.includes(path)) return;
    const at = paths.findIndex((p) => p > path);
    paths.splice(at < 0 ? paths.length : at, 0, path);
  }

  private drop(path: string): void {
    const uid = this.byPath.get(path);
    if (uid === undefined) return;
    this.byPath.delete(path);
    const paths = this.byUid.get(uid);
    if (!paths) return;
    const at = paths.indexOf(path);
    if (at >= 0) paths.splice(at, 1);
    if (paths.length === 0) this.byUid.delete(uid);
  }
}
