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

export class WriteQueue {
  private readonly pending: QueueItem[] = [];
  private busy = false;

  constructor(private readonly timeoutMs: number = WRITE_TIMEOUT_MS) {}

  /** Operations waiting behind the one currently running. */
  get depth(): number {
    return this.pending.length;
  }

  /** True while an operation holds the queue. */
  get running(): boolean {
    return this.busy;
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
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy) return;
    const item = this.pending.shift();
    if (!item) return;
    this.busy = true;

    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    // Single release point: whoever gets here first (the operation or the
    // timer) owns the outcome; the loser is a no-op. Guarantees the slot is
    // released exactly once even when an abandoned operation settles later.
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      this.busy = false;
      // Microtask, not a direct call: keeps the next operation off this one's
      // stack (no unbounded recursion on a long queue of sync-resolving ops).
      queueMicrotask(() => this.pump());
      return true;
    };

    timer = setTimeout(() => {
      if (claim()) item.reject(new WriteTimeoutError(item.op, this.timeoutMs));
    }, this.timeoutMs);

    // Losing the claim means the timer already abandoned this operation: the
    // caller has its WriteTimeoutError and the slot belongs to someone else, so
    // the settlement is reported through onLate instead of being dropped.
    const late = (settlement: LateSettlement): void => {
      try {
        item.onLate?.(settlement);
      } catch (e) {
        // A misbehaving observer must not take down the queue (or surface as an
        // unhandled rejection on an operation nobody is awaiting any more).
        console.error("[vault-mcp] late-settlement handler failed", e);
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
