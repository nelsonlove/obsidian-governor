// Serialized write queue — kernel v0's transaction-pipeline embryo.
//
// Every mutating tool call runs through ONE FIFO queue per plugin instance, so
// only one vault mutation is in flight at a time across ALL connections. The
// plugin builds a fresh McpServer per connection, so the queue deliberately
// lives on the plugin singleton (main.ts) and rides into each server via
// ServerCtx — a per-connection queue would serialize nothing that matters.
//
// Reads never queue: they don't change vault state, and making them wait behind
// a slow write would turn every write into a session-wide stall.
//
// Timeout semantics: each queued operation gets WRITE_TIMEOUT_MS of wall clock.
// On expiry the queue REJECTS THAT OPERATION with a typed WriteTimeoutError and
// immediately runs the next one. The wedged operation is abandoned, not
// cancelled — Obsidian's app.* APIs expose no cancellation, so the alternative
// is a queue (and therefore a bridge, and therefore every concurrent session)
// wedged behind one stuck call. Losing one operation beats losing the transport.
//
// HOW the deadline fires matters as much as what it means (#272): this code
// runs in Obsidian's renderer, where Chromium suspends timers while the window
// is occluded — a setTimeout-only deadline simply never fired during unattended
// sessions, and one stalled renameFile wedged the queue indefinitely, which is
// the exact failure the timeout exists to prevent. So the deadline is
// WALL-CLOCK MATH, not a timer: dequeue stamps `startedAt`, and every queue
// event — an enqueue, an explicit nudge() — re-evaluates the running
// operation's elapsed time and abandons it if the budget is spent. A setTimeout
// still arms per operation as a best-effort prompt abandon for the foreground
// case, but the guarantee never DEPENDS on it: any new mutating call (and any
// journal append — main.ts wires journal→nudge, the #270 pattern) unwedges the
// queue even in a world where no timer ever fires.

/**
 * Wall-clock budget for a single queued mutating operation.
 *
 * Constant, not a setting: it is a liveness backstop, not a tuning knob. 30s is
 * far above any healthy in-process app.* mutation (the slowest real operation,
 * a vault-wide link repoint, runs in low seconds on a large vault) and far
 * below the point where a caller has given up on the session.
 */
export const WRITE_TIMEOUT_MS = 30_000;

/** Typed failure for an operation the queue abandoned after WRITE_TIMEOUT_MS. */
export class WriteTimeoutError extends Error {
  readonly code = "write_timeout";
  constructor(readonly op: string, readonly timeoutMs: number) {
    super(
      `'${op}' exceeded the ${timeoutMs}ms write-queue timeout and was abandoned; ` +
        `the queue moved on to the next operation. The vault may or may not have been modified — re-read before retrying.`
    );
    this.name = "WriteTimeoutError";
  }
}

/**
 * How an ABANDONED operation eventually settled. The queue has already rejected
 * it with WriteTimeoutError and moved on, so this is the only remaining evidence
 * of what the vault actually did — the journal turns it into a corrective record.
 */
export type LateSettlement = { ok: true; value: unknown } | { ok: false; error: unknown };

interface QueueItem {
  op: string;
  fn: () => unknown;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  onLate?: (settlement: LateSettlement) => void;
}

/** The operation currently holding the queue, as the deadline check sees it. */
interface RunningOp {
  /** Dequeue time (`now()`), the base of the wall-clock deadline. */
  startedAt: number;
  /** Abandon this operation: reject it WriteTimeoutError and release the slot. No-op if it already settled. */
  abandon: () => void;
}

export class WriteQueue {
  private readonly pending: QueueItem[] = [];
  private current: RunningOp | null = null;

  constructor(
    private readonly timeoutMs: number = WRITE_TIMEOUT_MS,
    /**
     * Clock, injectable for tests. MUST be wall clock (Date.now), never a
     * monotonic-while-running source tied to timers — the whole point is that
     * the deadline keeps advancing while Chromium has the renderer's timers
     * suspended.
     */
    private readonly now: () => number = Date.now
  ) {}

  /** Operations waiting behind the one currently running. */
  get depth(): number {
    return this.pending.length;
  }

  /** True while an operation holds the queue. */
  get running(): boolean {
    return this.current !== null;
  }

  /**
   * Enqueue `fn` and resolve with its result. Rejects with WriteTimeoutError if
   * it hasn't settled within the queue's timeout; rejects with whatever `fn`
   * threw otherwise. FIFO: enqueue order is run order.
   *
   * `onLate` is called if — and only if — an operation the queue already
   * ABANDONED settles afterwards. Without it that settlement vanishes and the
   * audit trail keeps asserting the timeout's failure for an operation that may
   * well have succeeded.
   */
  run<T>(op: string, fn: () => Promise<T> | T, onLate?: (settlement: LateSettlement) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ op, fn, resolve, reject, onLate });
      // Enqueue is a queue event: check the running operation's wall-clock
      // deadline before pumping, so a newcomer never sits behind an operation
      // whose budget is already spent just because the timer never fired.
      this.nudge();
    });
  }

  /**
   * Queue-activity hook: re-evaluate the running operation's wall-clock
   * deadline — abandoning it if the budget is spent — then run the next
   * operation if the slot is free. Idempotent and cheap when nothing is
   * overdue; safe to call from any event that implies the world moved on
   * (an enqueue calls it internally; main.ts wires journal appends to it).
   *
   * This, not the per-operation timer, is what carries the "never wedge the
   * bridge" guarantee: renderer timers are suspended while the Obsidian window
   * is occluded, but queue events keep arriving exactly because callers are
   * still trying to write.
   */
  nudge(): void {
    const cur = this.current;
    if (cur !== null && this.now() - cur.startedAt >= this.timeoutMs) cur.abandon();
    this.pump();
  }

  private pump(): void {
    if (this.current !== null) return;
    const item = this.pending.shift();
    if (!item) return;

    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    // Single release point: whoever gets here first (the operation, the timer,
    // or a wall-clock abandon via nudge()) owns the outcome; the loser is a
    // no-op. Guarantees the slot is released exactly once even when an
    // abandoned operation settles later.
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      this.current = null;
      // Microtask, not a direct call: keeps the next operation off this one's
      // stack (no unbounded recursion on a long queue of sync-resolving ops).
      queueMicrotask(() => this.pump());
      return true;
    };

    // Shared by the timer (best-effort, prompt in the foreground) and the
    // wall-clock check in nudge() (the guarantee — fires even in a world where
    // timers never do). Both paths produce the identical abandonment.
    const abandon = (): void => {
      if (claim()) item.reject(new WriteTimeoutError(item.op, this.timeoutMs));
    };

    this.current = { startedAt: this.now(), abandon };
    timer = setTimeout(abandon, this.timeoutMs);

    // Losing the claim means this operation was already abandoned: the caller
    // has its WriteTimeoutError and the slot belongs to someone else, so the
    // settlement is reported through onLate instead of being dropped.
    const late = (settlement: LateSettlement): void => {
      try {
        item.onLate?.(settlement);
      } catch (e) {
        // A misbehaving observer must not take down the queue (or surface as an
        // unhandled rejection on an operation nobody is awaiting any more).
        console.error("[governor] late-settlement handler failed", e);
      }
    };

    // Promise.resolve().then keeps a SYNCHRONOUS throw from fn() inside the
    // queue's control flow — otherwise it would escape run()'s executor.
    Promise.resolve()
      .then(() => item.fn())
      .then(
        (v) => { if (claim()) item.resolve(v); else late({ ok: true, value: v }); },
        (e) => { if (claim()) item.reject(e); else late({ ok: false, error: e }); }
      );
  }
}
