// COALESCE — one expensive pass per burst, not one per event.
//
// THE BUG THIS EXISTS TO KILL (measured on the live vault, 2026-08-27):
// renaming ONE note makes Obsidian rewrite every backlinking note — ~120 of
// them — which fires ~120 `vault.modify` events. The review queue's
// `reconcile()` ran per file (correct: each file needs its own decision) and
// then ended with `await refresh(plugin)` on EVERY exit — and `refresh()`
// reads the WHOLE vault, `cachedRead` per governed note. So one rename cost
// 120 × 3,581 = ~430,000 reads. In memory, so it wrote nothing to disk and
// burned pure CPU — which is exactly why it looked like nothing was
// happening while everything was slow.
//
// The generation guard inside `refresh()` did not help and could not: it
// stops an overtaken run from PUBLISHING a stale queue, but the overtaken
// run has already done all of its reads by then. Its own comment says so.
// A correctness guard is not a cost guard.
//
// The shape of the fix is the thing to remember: work that is PER FILE stays
// per file; work that is ABOUT THE WHOLE VAULT happens once per burst. A
// trailing-edge coalescer is how the second one is spelled.
//
// Pure and timer-injected so the collapse is provable headlessly — the
// property under test ("N requests in one window run the pass ONCE") is
// exactly the property that failed in production, and a test that cannot
// count invocations cannot pin it.

export interface Coalescer {
  /** Ask for a run. Any number of requests inside one window produce ONE run. */
  request(): void;
  /** Drop a pending run (teardown). Never runs the pass. */
  cancel(): void;
  /** Whether a run is currently scheduled — for tests and diagnostics. */
  pending(): boolean;
}

export interface CoalesceTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: CoalesceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Trailing-edge coalescer. The pass runs `waitMs` after the LAST request in a
 * burst — trailing, not leading, because the burst's later events carry the
 * state the pass should see (a rename's backlink rewrites arrive over several
 * hundred ms; running on the first one would read a half-rewritten vault and
 * then need to run again anyway).
 *
 * A pass that throws is reported and swallowed: this drives a queue refresh,
 * and a failed refresh must not take down the event handler that asked for it.
 * A pass already in flight when a new request arrives does NOT cancel it —
 * the new request schedules the next one, so the refresh's own generation
 * guard settles which result publishes.
 */
export function createCoalescer(
  run: () => void | Promise<void>,
  waitMs: number,
  onError: (e: unknown) => void = () => {},
  timers: CoalesceTimers = REAL_TIMERS
): Coalescer {
  let handle: unknown = null;
  return {
    request() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => {
        handle = null;
        try {
          const r = run();
          if (r && typeof (r as Promise<void>).then === "function") {
            void (r as Promise<void>).catch(onError);
          }
        } catch (e) {
          onError(e);
        }
      }, waitMs);
    },
    cancel() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
    pending() {
      return handle !== null;
    },
  };
}
