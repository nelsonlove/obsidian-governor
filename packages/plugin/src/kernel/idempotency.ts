// Idempotency keys — kernel v0's "retries are safe" capability.
//
// A caller that cannot tell whether its request landed (dropped socket,
// abandoned write, agent retry loop) resends it with the same
// `idempotency_key`. The kernel replays the FIRST call's result envelope
// verbatim instead of executing the operation a second time, so a retry can
// never duplicate a write.
//
// IN MEMORY, PER PLUGIN INSTANCE. Nothing is persisted: a plugin reload (or an
// Obsidian restart) clears every key, after which the same key re-executes.
// That is the v0 boundary — the store exists to collapse retries inside one
// session's lifetime, not to make an operation exactly-once forever.

/** Default replay window. Long enough to cover a stuck write plus a retry, short enough to stay small. */
export const IDEMPOTENCY_TTL_MS = 10 * 60_000;
/** Default cap. Oldest-used entries are evicted first (LRU). */
export const IDEMPOTENCY_MAX = 500;

/** A completed operation, kept so its exact result can be replayed. */
export interface IdempotencyEntry {
  /** The operation the key was first used with; reusing it for another op is an error. */
  op: string;
  /** The result envelope the first call returned — replayed byte-for-byte. */
  result: unknown;
  /** `ts` of the journal record the first call wrote; a replay records it as `dedupeOf`. */
  ts: string;
  /** When the entry was stored (ms epoch), for TTL expiry. */
  storedAt: number;
}

/** Typed failure for one key reused across two different operations. */
export class IdempotencyMismatchError extends Error {
  readonly code = "idempotency_mismatch";
  constructor(readonly key: string, readonly firstOp: string, readonly op: string) {
    super(
      `idempotency_key '${key}' was already used for '${firstOp}'; it cannot be reused for '${op}'. ` +
        `Use a fresh key per logical operation.`
    );
    this.name = "IdempotencyMismatchError";
  }
}

/**
 * Bounded, TTL'd store of completed operations keyed by idempotency key.
 *
 * Map iteration order is insertion order, and `get` re-inserts on a hit, so the
 * first key in the map is always the least recently used — that is the LRU
 * eviction order, with no extra bookkeeping.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly ttlMs: number = IDEMPOTENCY_TTL_MS,
    private readonly max: number = IDEMPOTENCY_MAX,
    /** Injectable clock — tests drive TTL expiry without waiting for it. */
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Live (unexpired) entries. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The entry for `key`, or undefined when absent or past its TTL. A hit is
   * refreshed to most-recently-used (it does NOT extend the TTL — the window
   * runs from the original completion, not from the last retry).
   */
  get(key: string): IdempotencyEntry | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  /** Record a completed operation's result under `key`, evicting the LRU entry if full. */
  set(key: string, entry: Omit<IdempotencyEntry, "storedAt">): void {
    this.entries.delete(key);
    this.entries.set(key, { ...entry, storedAt: this.now() });
    while (this.entries.size > this.max) {
      const lru = this.entries.keys().next();
      if (lru.done) break;
      this.entries.delete(lru.value);
    }
  }
}
