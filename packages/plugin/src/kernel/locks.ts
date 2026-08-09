// Advisory locks — kernel v0's claims mechanism.
//
// A caller CLAIMS a scope (a vault path prefix) for a stated reason and a
// bounded time. The claim is ADVISORY and nothing else: it never blocks, never
// queues, never fails another caller's write. What it does is make an intention
// legible — a write that lands inside somebody else's live claim still lands,
// but its result envelope and its journal record both say whose work it walked
// into, and why.
//
// That is deliberate, not a shortcut. Ch4/ch8 put the claims mechanism in the
// transport precisely as disclosure, not enforcement: Obsidian cannot ACL the
// filesystem, so a lock that pretended to block would be a lie about a
// guarantee the host cannot make. There is no accept/approve step and no
// blocking mode to add later — the verbs are claim, renew, release, list.
//
// ── expiry ───────────────────────────────────────────────────────────────────
//
// Every claim carries a TTL (default 5 min, hard ceiling 30 min). A holder that
// crashes, disconnects, or simply forgets cannot wedge a scope forever: expiry
// is LAZY — an expired lock is dropped by the next call that looks — so there is
// no timer to leak and no background sweep to get out of step with the clock.
// The clock is injectable so tests drive expiry without waiting for it.
//
// IN MEMORY, PER PLUGIN INSTANCE, like the idempotency store: a reload clears
// every claim. Claims describe work in flight inside one session's lifetime,
// which is exactly as long as an advisory claim is worth anything.

import { posix } from "node:path";

/** Default claim lifetime — long enough for a multi-step edit, short enough to forget about. */
export const LOCK_TTL_DEFAULT_MS = 5 * 60_000;
/** Hard ceiling. A claim is a statement about work in flight, not a reservation. */
export const LOCK_TTL_MAX_MS = 30 * 60_000;
/** Floor: below this a claim expires before the claimer can act on it. */
export const LOCK_TTL_MIN_MS = 1_000;
/** Cap on live claims store-wide, so a leak cannot grow without bound. */
export const LOCK_MAX = 200;
/**
 * Cap on live claims held by ONE holder. The store cap alone would let a single
 * flooding connection fill the store and refuse everyone else; per-holder is
 * where the pressure belongs, since a holder can always release its own.
 */
export const LOCK_MAX_PER_HOLDER = 50;

/** One live claim. `scope` is normalized; `""` means the whole vault. */
export interface Lock {
  id: string;
  /** Normalized vault path prefix. `""` = the whole vault. */
  scope: string;
  /** Actor identity that claimed it — see holderOf. */
  holder: string;
  reason: string;
  /** ms epoch. */
  claimedAt: number;
  /** ms epoch; the lock vanishes at or after this. */
  expiresAt: number;
}

/** The disclosure a claim response carries: the claim, plus whose claims it overlaps. */
export interface LockClaim {
  lock: Lock;
  /**
   * Live claims by OTHER holders whose scope overlaps this one, at claim time.
   * Overlapping claims are ALLOWED — this is what makes the mechanism advisory
   * — so the disclosure is the whole point: the claimer learns it is not alone.
   */
  overlapping: Lock[];
  /**
   * True when this call REFRESHED a claim the same holder already had on the
   * same scope, rather than adding a second one. Same `id`, same `claimedAt`,
   * new reason and new expiry — see LockStore.claim.
   */
  replaced?: boolean;
}

/**
 * Typed refusal when a claim would push a holder (or the store) past its cap.
 *
 * The cap REFUSES rather than evicting. Evicting the oldest claim to make room
 * — what this store used to do — silently destroys a live claim belonging to
 * SOMEBODY ELSE, so a client that claims in a loop could erase every other
 * session's disclosure and never be told. A claim is never taken from a holder
 * to make room for another's.
 */
export class LockCapError extends Error {
  readonly code = "lock_cap";
  constructor(
    readonly cap: number,
    readonly kind: "holder" | "store"
  ) {
    super(
      kind === "holder"
        ? `refused: this connection already holds ${cap} live advisory claims (the per-holder cap). ` +
            `Release one with obsidian_release_scope, or let it expire — no other holder's claim is ever ` +
            `dropped to make room. Nothing was claimed.`
        : `refused: this vault already holds ${cap} live advisory claims (the store cap). ` +
            `Wait for claims to expire or release some — no holder's claim is ever dropped to make room. ` +
            `Nothing was claimed.`
    );
    this.name = "LockCapError";
  }
}

/** Journal/notice shape for a foreign claim a write ran inside. */
export interface LockNotice {
  holder: string;
  scope: string;
  reason: string;
}

/**
 * Stable identity for a claim holder, derived from the journal actor — the same
 * identity the audit stream records, so "who holds this" and "who wrote that"
 * are the same vocabulary. Per CONNECTION, because that is the granularity the
 * transport can actually assert: a reconnect is a new holder, and its claims
 * start empty rather than being silently inherited.
 */
export function holderOf(actor: { client?: string; connection: string }): string {
  return actor.client ? `${actor.client}#${actor.connection}` : actor.connection;
}

/**
 * Normalize a scope to a comparable path prefix: no trailing slash, `.`/`..`
 * collapsed, and no escape above the vault root. `""`, `"."` and `"/"` all mean
 * the whole vault.
 *
 * Throws on an escaping scope rather than clamping it — a claim on
 * `../other-vault` is a mistake worth reporting, and silently rewriting it would
 * disclose overlaps against a scope the caller never asked for.
 */
export function normalizeScope(scope: string): string {
  const trimmed = (scope ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") return "";
  const norm = posix.normalize(trimmed).replace(/\/+$/, "");
  if (norm === "." || norm === "") return "";
  if (norm === ".." || norm.startsWith("../")) {
    throw new TypeError(`scope '${scope}' escapes the vault root`);
  }
  return norm;
}

/** Does `scope` cover `path`? Prefix matching at a path-segment boundary only. */
export function scopeCovers(scope: string, path: string): boolean {
  if (scope === "") return true; // whole-vault claim
  const p = posix.normalize(path).replace(/\/+$/, "");
  return p === scope || p.startsWith(`${scope}/`);
}

/** Two scopes overlap when either covers the other (`Projects` vs `Projects/a.md`). */
export function scopesOverlap(a: string, b: string): boolean {
  return scopeCovers(a, b) || scopeCovers(b, a);
}

/** Seconds until expiry, for human-readable notices. Never negative. */
export function expiresInSeconds(lock: Lock, now: number): number {
  return Math.max(0, Math.round((lock.expiresAt - now) / 1000));
}

/**
 * The one-line advisory notice a write inside a foreign claim carries, on the
 * result envelope and (in structured form) in the journal.
 */
export function lockNoticeText(lock: Lock, now: number): string {
  return (
    `advisory lock: ${lock.holder} claims ${lock.scope || "the whole vault"} ` +
    `(${lock.reason}), expires in ${expiresInSeconds(lock, now)}s`
  );
}

let lockSeq = 0;
const LOCK_EPOCH = Date.now().toString(36);

/** Unique enough within a plugin load; the epoch keeps ids distinct across reloads. */
function mintLockId(): string {
  return `lock-${LOCK_EPOCH}-${++lockSeq}`;
}

/**
 * The advisory claims a plugin instance is currently holding.
 *
 * Deliberately NOT a mutual-exclusion primitive: `claim` always succeeds (up to
 * the size cap), and overlapping claims by different holders coexist. Every
 * method prunes expired claims first, which is the only expiry mechanism there
 * is.
 */
export class LockStore {
  private readonly locks = new Map<string, Lock>();

  constructor(
    /** Injectable clock — tests drive TTL expiry without waiting for it. */
    private readonly now: () => number = () => Date.now(),
    private readonly max: number = LOCK_MAX,
    private readonly maxPerHolder: number = LOCK_MAX_PER_HOLDER
  ) {}

  /** Live (unexpired) claims. */
  get size(): number {
    this.prune();
    return this.locks.size;
  }

  /**
   * Claim `scope` for `holder`. Never refuses on account of ANOTHER holder —
   * the response instead DISCLOSES every live overlapping claim, which is the
   * whole of the advisory contract. It refuses only at a cap, and only ever
   * the caller's own claim (LockCapError); no claim is evicted to make room.
   *
   * Re-claiming a scope you ALREADY hold REPLACES that claim rather than adding
   * a second: same id, same `claimedAt`, new reason, new expiry. Claims
   * accumulating one per call was how a holder walked itself into the cap while
   * every one of those claims said the same thing.
   *
   * `ttlMs` is clamped into [1s, 30min]; the tool layer rejects out-of-range
   * values outright, so the clamp here is a defensive floor/ceiling that keeps
   * the store's invariant ("no claim outlives 30 minutes") true for every
   * caller, including future ones.
   */
  claim(req: { scope: string; holder: string; reason: string; ttlMs?: number }): LockClaim {
    this.prune();
    const scope = normalizeScope(req.scope);
    const now = this.now();
    const ttlMs = Math.min(LOCK_TTL_MAX_MS, Math.max(LOCK_TTL_MIN_MS, req.ttlMs ?? LOCK_TTL_DEFAULT_MS));
    const mine = [...this.locks.values()].filter((l) => l.holder === req.holder);
    const overlapping = [...this.locks.values()].filter(
      (l) => l.holder !== req.holder && scopesOverlap(l.scope, scope)
    );

    // Same holder, same scope ⇒ this is a renewal wearing a claim's clothes.
    // Refresh in place: the claim keeps its identity (callers may still hold the
    // id) and the store does not grow.
    const held = mine.find((l) => l.scope === scope);
    if (held) {
      const refreshed: Lock = { ...held, reason: req.reason, expiresAt: now + ttlMs };
      this.locks.set(held.id, refreshed);
      return { lock: refreshed, overlapping, replaced: true };
    }

    // Caps refuse; they never evict. See LockCapError.
    if (mine.length >= this.maxPerHolder) throw new LockCapError(this.maxPerHolder, "holder");
    if (this.locks.size >= this.max) throw new LockCapError(this.max, "store");

    const lock: Lock = {
      id: mintLockId(),
      scope,
      holder: req.holder,
      reason: req.reason,
      claimedAt: now,
      expiresAt: now + ttlMs,
    };
    this.locks.set(lock.id, lock);
    return { lock, overlapping };
  }

  /**
   * Extend a live claim. Returns the renewed lock, or undefined when the id is
   * unknown, already expired, or held by someone else — renewing is an act on
   * your OWN claim, so a holder mismatch is a miss rather than a takeover.
   */
  renew(id: string, ttlMs?: number, holder?: string): Lock | undefined {
    this.prune();
    const held = this.locks.get(id);
    if (!held) return undefined;
    if (holder !== undefined && held.holder !== holder) return undefined;
    const clamped = Math.min(LOCK_TTL_MAX_MS, Math.max(LOCK_TTL_MIN_MS, ttlMs ?? LOCK_TTL_DEFAULT_MS));
    const renewed: Lock = { ...held, expiresAt: this.now() + clamped };
    this.locks.set(id, renewed);
    return renewed;
  }

  /**
   * Drop a claim. Returns the released lock, or undefined when the id is
   * unknown, already expired, or held by someone else (same reasoning as
   * `renew`: releasing another holder's claim would be a takeover dressed up as
   * housekeeping).
   */
  release(id: string, holder?: string): Lock | undefined {
    this.prune();
    const held = this.locks.get(id);
    if (!held) return undefined;
    if (holder !== undefined && held.holder !== holder) return undefined;
    this.locks.delete(id);
    return held;
  }

  /** Every live claim, oldest first. Expired claims are pruned on the way. */
  list(): Lock[] {
    this.prune();
    return [...this.locks.values()];
  }

  /**
   * Live claims by holders OTHER than `holder` whose scope covers `path` —
   * the notice set for a mutating operation on that path. Most specific
   * (longest scope) first, so the closest claim is the one a single-notice
   * consumer sees. A holder's own claims never notice its own writes: the
   * point of claiming a scope is to work in it.
   */
  covering(path: string, holder: string): Lock[] {
    return this.coveringAny([path], holder);
  }

  /**
   * The same, for an operation that names SEVERAL paths — a move, a batch move,
   * a multi-note edit. Every path is consulted, not just the primary, because a
   * move INTO somebody's claimed scope lands inside their work exactly as much
   * as a move out of it does, and consulting only the source made the arriving
   * half of that operation invisible.
   *
   * Each lock appears at most ONCE however many of the paths it covers, so a
   * batch of fifty notes under one claim discloses one notice, not fifty.
   */
  coveringAny(paths: string[], holder: string): Lock[] {
    this.prune();
    return [...this.locks.values()]
      .filter((l) => l.holder !== holder && paths.some((p) => scopeCovers(l.scope, p)))
      .sort((a, b) => b.scope.length - a.scope.length || a.claimedAt - b.claimedAt);
  }

  /** Lazy expiry — the only expiry there is. Called by every public method. */
  private prune(): void {
    const now = this.now();
    for (const [id, lock] of this.locks) if (lock.expiresAt <= now) this.locks.delete(id);
  }
}
