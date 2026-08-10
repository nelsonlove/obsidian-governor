// Idempotency keys — kernel v0's "retries are safe" capability.
//
// A caller that cannot tell whether its request landed (dropped socket,
// abandoned write, agent retry loop) resends it with the same
// `idempotency_key`. The kernel replays the FIRST call's result envelope
// verbatim instead of executing the operation a second time, so a retry can
// never duplicate a write.
//
// ── one key, one logical request, one outcome ────────────────────────────────
//
// The store holds two kinds of thing, and a key claim consults BOTH:
//
//   • a RESERVATION — the key is in flight. The first caller to present a key
//     claims it synchronously (single-threaded JS: the check and the set are one
//     uninterruptible step), and every later caller presenting the same key
//     while it is still in flight AWAITS the winner's settlement instead of
//     executing. Without this, four simultaneous retries of one dropped request
//     all miss the completed-entry lookup and all write.
//   • an ENTRY — the key completed and RETURNED an envelope, which is replayed.
//
// Waiters share the winner's outcome WHATEVER IT IS: if the winner throws
// (rev_conflict, write_timeout, probe failure) every waiter attached to that
// reservation gets the same throw. They are one logical request; giving the
// second caller a different answer than the first would mean the key collapsed
// nothing. Only AFTER settlement does the distinction matter: a RETURNED
// envelope is stored (so future calls replay it), a THROWN failure stores
// nothing and RELEASES the key (so a future call re-executes — the vault was
// left in an unknown or unchanged state, where re-running is the right answer).
//
// ── key identity ─────────────────────────────────────────────────────────────
//
// A key's identity is (key, op, tool arguments, KERNEL arguments). Reusing one
// key for a different operation, with different arguments, OR under a different
// `if_rev` precondition is an IdempotencyMismatchError, never a silent replay —
// replaying a call whose arguments have changed would discard the caller's
// actual write and report success for it.
//
// `if_rev` counts, and counts SEPARATELY (reason: "if_rev") rather than being
// folded into the args fingerprint. It is checked separately because it is a
// different kind of divergence with a different fix: same write, different
// belief about the world. `{path:"A.md"} @ if_rev 100` and the same call at
// if_rev 200 — or with no if_rev at all — are two distinct requests, because the
// precondition is half of what the caller asked for. Replaying the first as the
// second would report "your conditional write applied" for a condition that was
// never evaluated. Present-vs-absent is divergence too: dropping the
// precondition on a retry is exactly the mistake worth catching.
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
  /** Fingerprint of the first call's arguments; a differing one is an error, not a replay. */
  args: string;
  /**
   * The first call's `if_rev` precondition, or undefined when it carried none.
   * Part of the key's identity: a retry under a different (or absent)
   * precondition is a different request. See the file header.
   */
  ifRev?: number;
  /** The result envelope the first call returned — replayed byte-for-byte. */
  result: unknown;
  /** `ts` of the journal record the first call wrote; a replay records it as `dedupeOf`. */
  ts: string;
  /** When the entry was stored (ms epoch), for TTL expiry. */
  storedAt: number;
}

/**
 * How the in-flight winner settled, handed to every waiter on its reservation.
 * `ts` is the winner's journal record, which a waiter records as `dedupeOf`.
 */
export type IdempotencySettlement =
  | { ok: true; result: unknown; ts: string }
  | { ok: false; error: unknown; ts: string };

/** A key that has been claimed but has not settled yet. */
interface Reservation {
  op: string;
  args: string;
  ifRev?: number;
  /** Resolves (never rejects) when the winner settles — see IdempotencySettlement. */
  settlement: Promise<IdempotencySettlement>;
  settle: (s: IdempotencySettlement) => void;
}

/**
 * The outcome of presenting a key. Exactly one of these is true at the moment
 * of the (synchronous) claim, and the caller acts on it without awaiting
 * anything in between — that indivisibility is what makes the reservation a
 * reservation.
 */
export type IdempotencyClaim =
  /** The key is ours: run the operation, then call `settle` exactly once. */
  | { kind: "owner"; settle: (s: IdempotencySettlement) => void }
  /** Someone else holds the key right now: await their outcome and share it. */
  | { kind: "wait"; settlement: Promise<IdempotencySettlement> }
  /** The key already completed: replay its envelope. */
  | { kind: "replay"; entry: IdempotencyEntry }
  /** The key is in use for a different operation, arguments, or `if_rev`. */
  | { kind: "mismatch"; firstOp: string; reason: MismatchReason; firstIfRev?: number };

/**
 * Which half of a key's identity diverged.
 *   `op`     — the key was used for another tool.
 *   `args`   — same tool, different tool arguments.
 *   `if_rev` — same tool and arguments, different (or absent) precondition.
 */
export type MismatchReason = "op" | "args" | "if_rev";

// ── argument fingerprints ────────────────────────────────────────────────────

/**
 * Deterministic JSON with object keys sorted, so two structurally identical
 * argument objects fingerprint identically no matter what order the wire put
 * their keys in. (A retry that re-serialized its arguments must not be mistaken
 * for a divergent call.)
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** FNV-1a, 32-bit. Not cryptographic — it only has to separate two argument sets. */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Identity of a call's arguments, for detecting a key reused with DIFFERENT
 * arguments.
 *
 * Two parts, because neither alone is enough:
 *   • the journal's `argsDigest`, stably serialized — greppable, body-free, and
 *     the same summary the record carries, so a mismatch is explicable;
 *   • a hash of the FULL arguments — the digest collapses note bodies to
 *     `<N chars>`, so two different bodies of equal length share a digest. The
 *     hash separates them without ever storing a body.
 */
export function fingerprintArgs(digest: Record<string, unknown>, args: Record<string, unknown>): string {
  return `${stableStringify(digest)}#${hash32(stableStringify(args ?? {}))}`;
}

/** Human phrasing for an `if_rev` that may be absent on either side. */
function revPhrase(rev: number | undefined): string {
  return rev === undefined ? "no if_rev" : `if_rev ${rev}`;
}

/**
 * Typed failure for one key reused for a different operation, with different
 * arguments, or under a different `if_rev` precondition.
 */
export class IdempotencyMismatchError extends Error {
  readonly code = "idempotency_mismatch";
  constructor(
    readonly key: string,
    readonly firstOp: string,
    readonly op: string,
    /** Which half of the key's identity diverged — see MismatchReason. */
    readonly reason: MismatchReason = "op",
    /** For `reason: "if_rev"`: the precondition the key was first used with. */
    readonly firstIfRev?: number,
    /** For `reason: "if_rev"`: the precondition this call presented. */
    readonly ifRev?: number
  ) {
    super(
      reason === "args"
        ? `idempotency_key '${key}' was already used for '${firstOp}' with DIFFERENT arguments; ` +
            `replaying it would discard this call's write and report success for it. ` +
            `Use a fresh key per logical operation.`
        : reason === "if_rev"
          ? `idempotency_key '${key}' was already used for '${firstOp}' with ${revPhrase(firstIfRev)}, ` +
              `but this call presents ${revPhrase(ifRev)}. The precondition is part of what was asked, so ` +
              `replaying would report that a condition held which was never checked. ` +
              `Retry with the original if_rev, or use a fresh key.`
          : `idempotency_key '${key}' was already used for '${firstOp}'; it cannot be reused for '${op}'. ` +
              `Use a fresh key per logical operation.`
    );
    this.name = "IdempotencyMismatchError";
  }
}

/**
 * Bounded, TTL'd store of in-flight reservations and completed operations,
 * keyed by idempotency key.
 *
 * Map iteration order is insertion order, and `get` re-inserts on a hit, so the
 * first key in the map is always the least recently used — that is the LRU
 * eviction order, with no extra bookkeeping. Reservations are held in their own
 * map and are never evicted, and their lifetime is longer than it looks: a
 * reservation is taken BEFORE the write queue, so it is held for the operation's
 * queue wait PLUS the write-queue timeout — and the queue wait is bounded by
 * nothing but queue depth, so a deep queue can hold many reservations at once.
 * They are still cheap (one per keyed write that is queued or running, no result
 * payload), they always end (every path settles from a `finally`), and dropping
 * one would leave every waiter on it hanging — so eviction would trade a bounded
 * memory cost for an unbounded liveness bug.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly reservations = new Map<string, Reservation>();

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

  /** Keys claimed but not yet settled. */
  get inFlight(): number {
    return this.reservations.size;
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

  /**
   * Present a key. SYNCHRONOUS AND ATOMIC by construction: the lookup and the
   * reservation that may follow it happen in one uninterruptible step, with no
   * `await` between them, so two simultaneous callers cannot both come away as
   * owner. Everything the caller does afterwards (probing, queuing, running) is
   * already covered by the reservation.
   *
   * The owner MUST call the returned `settle` exactly once — from a `finally`,
   * so a throw anywhere in the operation still releases the waiters.
   */
  claim(key: string, op: string, args: string, ifRev?: number): IdempotencyClaim {
    const held = this.reservations.get(key);
    if (held) {
      if (held.op !== op) return { kind: "mismatch", firstOp: held.op, reason: "op" };
      if (held.args !== args) return { kind: "mismatch", firstOp: held.op, reason: "args" };
      // Kernel arguments are checked at claim time rather than folded into the
      // args fingerprint, so the failure can name WHICH half diverged.
      if (held.ifRev !== ifRev)
        return { kind: "mismatch", firstOp: held.op, reason: "if_rev", firstIfRev: held.ifRev };
      return { kind: "wait", settlement: held.settlement };
    }
    const done = this.get(key);
    if (done) {
      if (done.op !== op) return { kind: "mismatch", firstOp: done.op, reason: "op" };
      if (done.args !== args) return { kind: "mismatch", firstOp: done.op, reason: "args" };
      if (done.ifRev !== ifRev)
        return { kind: "mismatch", firstOp: done.op, reason: "if_rev", firstIfRev: done.ifRev };
      return { kind: "replay", entry: done };
    }

    let settle!: (s: IdempotencySettlement) => void;
    const settlement = new Promise<IdempotencySettlement>((resolve) => {
      settle = resolve;
    });
    const reservation: Reservation = {
      op,
      args,
      ...(ifRev !== undefined ? { ifRev } : {}),
      settlement,
      settle: (s) => {
        // Release first, resolve second: by the time a waiter wakes, the key is
        // either stored (returned envelope) or free (thrown failure), never
        // still reserved. `settle` is idempotent — a resolved promise ignores a
        // second resolve, and deleting an already-deleted key is a no-op.
        //
        // BOTH the delete and the store are gated on still owning the
        // reservation. A second (stale) settle for a key that has since been
        // re-claimed and re-completed must not overwrite the newer entry with
        // this call's result — otherwise the store's idempotence claim is only
        // true for well-behaved callers, which is not what "idempotent" means.
        const mine = this.reservations.get(key) === reservation;
        if (mine) {
          this.reservations.delete(key);
          if (s.ok) this.set(key, { op, args, ...(ifRev !== undefined ? { ifRev } : {}), result: s.result, ts: s.ts });
        }
        settle(s);
      },
    };
    this.reservations.set(key, reservation);
    return { kind: "owner", settle: reservation.settle };
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
