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
/** Cap on live claims, so a misbehaving client cannot grow the store without bound. */
export const LOCK_MAX = 200;

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
    private readonly max: number = LOCK_MAX
  ) {}

  /** Live (unexpired) claims. */
  get size(): number {
    this.prune();
    return this.locks.size;
  }

  /**
   * Claim `scope` for `holder`. Never refuses on account of another holder —
   * the response instead DISCLOSES every live overlapping claim, which is the
   * whole of the advisory contract.
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
    const overlapping = [...this.locks.values()].filter(
      (l) => l.holder !== req.holder && scopesOverlap(l.scope, scope)
    );
    const lock: Lock = {
      id: mintLockId(),
      scope,
      holder: req.holder,
      reason: req.reason,
      claimedAt: now,
      expiresAt: now + ttlMs,
    };
    this.locks.set(lock.id, lock);
    // Insertion order is claim order, so the oldest live claim is the first
    // one out when a client floods the store. Claims are cheap and TTL'd; the
    // cap only exists so a leak cannot become unbounded.
    while (this.locks.size > this.max) {
      const oldest = this.locks.keys().next();
      if (oldest.done || oldest.value === lock.id) break;
      this.locks.delete(oldest.value);
    }
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
    this.prune();
    return [...this.locks.values()]
      .filter((l) => l.holder !== holder && scopeCovers(l.scope, path))
      .sort((a, b) => b.scope.length - a.scope.length || a.claimedAt - b.claimedAt);
  }

  /** Lazy expiry — the only expiry there is. Called by every public method. */
  private prune(): void {
    const now = this.now();
    for (const [id, lock] of this.locks) if (lock.expiresAt <= now) this.locks.delete(id);
  }
}
