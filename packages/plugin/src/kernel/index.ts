// Kernel v0 — the two capabilities that ship in the transport: a serialized
// write queue (the transaction pipeline's embryo) and a write journal (the
// audit stream). One instance per plugin, shared by every connection's server.
//
// Kernel.runMutation is the single place both meet: it derives the operation's
// target, runs the handler through the queue, and journals exactly one record
// per mutating operation whatever the outcome.

import { collectPaths } from "../guard.js";
import { WriteQueue, WriteTimeoutError } from "./write-queue.js";
import { digestArgs, WriteJournal, type JournalActor, type JournalOutcome, type JournalTarget } from "./journal.js";

export { WriteQueue, WriteTimeoutError, WRITE_TIMEOUT_MS } from "./write-queue.js";
export type { LateSettlement } from "./write-queue.js";
export { WriteJournal, digestArgs, monthKey } from "./journal.js";
export type { JournalRecord, JournalActor, JournalAdapter, JournalOutcome, JournalTarget } from "./journal.js";

/**
 * Cheap, synchronous lookups against live vault state, for the journal's
 * identity and revision fields. Implemented over Obsidian's metadata cache in
 * obsidian-probe.ts; kept as an interface so the kernel stays Obsidian-free.
 */
export interface TargetProbe {
  /** Frontmatter `uid` for a vault path, when the metadata cache already holds it. */
  uid(path: string): string | undefined;
  /** Revision token for a vault path — file mtime in ms. Undefined when absent. */
  rev(path: string): number | undefined;
}

export interface MutationContext {
  /** Tool name — the operation identity in the journal. */
  op: string;
  args: Record<string, unknown>;
  actor: JournalActor;
  /**
   * Non-path target for an operation whose arguments name no vault path
   * (`command:editor:toggle-bold`, `plugin:dataview`). Derived at the
   * interception layer, where the tool surface's argument conventions live; the
   * kernel only records it, and only when no path was found.
   */
  ref?: string;
}

// A batch move can name 100 paths; the journal records the shape, not the payload.
const MAX_JOURNALED_PATHS = 20;
const MAX_JOURNALED_ERROR = 500;

/**
 * Pull the error text out of a tool result. Tool handlers report failure by
 * RETURNING `{isError: true}` (ok()/fail() convention), not by throwing, so the
 * journal's outcome must be read off the envelope.
 */
function errorTextOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true) return undefined;
  const first = Array.isArray(r.content) ? (r.content[0] as { text?: unknown } | undefined) : undefined;
  return typeof first?.text === "string" ? first.text.slice(0, MAX_JOURNALED_ERROR) : "error";
}

export class Kernel {
  constructor(
    readonly queue: WriteQueue = new WriteQueue(),
    private readonly journal: WriteJournal | null = null,
    private readonly probe: TargetProbe | null = null
  ) {}

  /**
   * Run one mutating operation: serialized behind every other mutating
   * operation on this plugin instance, and journaled exactly once.
   *
   * Rethrows what the queue rejects with — including WriteTimeoutError, which
   * the caller renders as a typed tool error (see mcp/guarded.ts). An operation
   * abandoned that way is journaled `error`; if it later settles anyway, a
   * second, CORRECTIVE record is appended (the journal never rewrites a line).
   */
  async runMutation<T>(mc: MutationContext, run: () => Promise<T>): Promise<T> {
    const enqueued = Date.now();
    // Everything below is sampled AT DEQUEUE, inside the queued closure: with a
    // queue depth ≥ 1 the vault changes between enqueue and execution, so a
    // revBefore (or uid) read here would describe some earlier operation's
    // world, not this one's. `started` likewise, so durationMs measures the
    // handler and queueWaitMs measures the wait.
    let target: JournalTarget = {};
    let revBefore: number | undefined;
    let started = enqueued;
    let queueWaitMs = 0;

    let outcome: JournalOutcome = "ok";
    let error: string | undefined;
    // Read by the late-settlement handler to link its corrective record back.
    let ts: string | undefined;
    try {
      const result = await this.queue.run(
        mc.op,
        () => {
          started = Date.now();
          queueWaitMs = started - enqueued;
          target = this.resolveTarget(mc.args, mc.ref);
          // A delete or move destroys the source's identity, so uid/revBefore
          // have to be read while it still exists — but no earlier than this.
          revBefore = target.path ? this.probe?.rev(target.path) : undefined;
          return run();
        },
        // The queue abandoned this operation on timeout and we already journaled
        // an `error`; if it settles later, correct the record rather than let
        // the journal keep asserting a failure that may not have happened.
        (settlement) => {
          const lateError = settlement.ok
            ? errorTextOf(settlement.value)
            : settlement.error instanceof Error
              ? settlement.error.message.slice(0, MAX_JOURNALED_ERROR)
              : String(settlement.error).slice(0, MAX_JOURNALED_ERROR);
          const lateRevAfter = this.revAfterOf(target);
          void this.journal?.append({
            ts: new Date().toISOString(),
            op: mc.op,
            target,
            actor: mc.actor,
            argsDigest: digestArgs(mc.args),
            outcome: lateError === undefined ? "late-ok" : "late-error",
            ...(lateError !== undefined ? { error: lateError } : {}),
            durationMs: Date.now() - started,
            queueWaitMs,
            ...(revBefore !== undefined ? { revBefore } : {}),
            ...(lateRevAfter !== undefined ? { revAfter: lateRevAfter } : {}),
            ...(ts !== undefined ? { corrects: ts } : {}),
          });
        }
      );
      const text = errorTextOf(result);
      if (text !== undefined) { outcome = "error"; error = text; }
      return result;
    } catch (e) {
      outcome = "error";
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const durationMs = Date.now() - started;
      const revAfter = this.revAfterOf(target);
      ts = new Date().toISOString();
      // Fire-and-forget: WriteJournal.append never rejects, and the operation's
      // result must not wait on (or be affected by) the audit write.
      void this.journal?.append({
        ts,
        op: mc.op,
        target,
        actor: mc.actor,
        argsDigest: digestArgs(mc.args),
        outcome,
        ...(error !== undefined ? { error } : {}),
        durationMs,
        queueWaitMs,
        ...(revBefore !== undefined ? { revBefore } : {}),
        ...(revAfter !== undefined ? { revAfter } : {}),
      });
    }
  }

  /** Fresh revision probe for the target, if it names a path at all. */
  private revAfterOf(target: JournalTarget): number | undefined {
    return target.path ? this.probe?.rev(target.path) : undefined;
  }

  /**
   * Derive the operation's target from its arguments, reusing the guard's
   * recursive path collector so the journal sees exactly the paths the
   * allowlist would scope — a tool the guard can see cannot be invisible here.
   *
   * `ref` is the fallback for pathless mutators (run a command, toggle a
   * plugin): it is recorded only when the arguments name no path at all, so a
   * real path always wins.
   */
  private resolveTarget(args: Record<string, unknown>, ref?: string): JournalTarget {
    const paths = collectPaths(args ?? {});
    if (paths.length === 0) return ref ? { ref } : {};
    const path = paths[0];
    const uid = this.probe?.uid(path);
    return {
      path,
      ...(uid !== undefined ? { uid } : {}),
      ...(paths.length > 1 ? { paths: paths.slice(0, MAX_JOURNALED_PATHS) } : {}),
    };
  }
}
