// Kernel v0 — the capabilities that ship in the transport: a serialized write
// queue (the transaction pipeline's embryo), a write journal (the audit
// stream), `if_rev` optimistic concurrency (precondition checking), and
// idempotency keys (safe retries). One instance per plugin, shared by every
// connection's server.
//
// Kernel.runMutation is the single place they all meet: it replays a known
// idempotency key without executing anything, derives the operation's target,
// checks the caller's revision precondition at dequeue, runs the handler
// through the queue, and journals exactly one record per mutating operation
// whatever the outcome.

import { collectPaths } from "../guard.js";
import { WriteQueue, WriteTimeoutError } from "./write-queue.js";
import { digestArgs, WriteJournal, type JournalActor, type JournalOutcome, type JournalTarget } from "./journal.js";
import { IdempotencyMismatchError, IdempotencyStore } from "./idempotency.js";

export { WriteQueue, WriteTimeoutError, WRITE_TIMEOUT_MS } from "./write-queue.js";
export type { LateSettlement } from "./write-queue.js";
export { WriteJournal, digestArgs, monthKey } from "./journal.js";
export type { JournalRecord, JournalActor, JournalAdapter, JournalOutcome, JournalTarget } from "./journal.js";
export { IdempotencyStore, IdempotencyMismatchError, IDEMPOTENCY_TTL_MS, IDEMPOTENCY_MAX } from "./idempotency.js";
export type { IdempotencyEntry } from "./idempotency.js";

/**
 * Typed failure for an `if_rev` precondition that did not hold: the target's
 * revision at DEQUEUE was not the one the caller read. No write ran.
 */
export class RevConflictError extends Error {
  readonly code = "rev_conflict";
  constructor(
    readonly op: string,
    readonly path: string | undefined,
    readonly expected: number,
    readonly actual: number | undefined
  ) {
    super(
      `'${op}' expected ${path ? `'${path}'` : "the target"} at rev ${expected}, but found ` +
        (actual === undefined
          ? "no revision (the target does not exist, or this build cannot read revisions)"
          : `rev ${actual}`) +
        `. Nothing was written — re-read the note and retry with the current rev.`
    );
    this.name = "RevConflictError";
  }
}

/**
 * A TargetProbe call threw at dequeue. Wrapping it keeps the journaled error
 * attributable: `probe: …` says the identity/revision lookup failed, not the
 * vault operation (which never ran).
 */
export class ProbeError extends Error {
  readonly code = "probe_failed";
  constructor(readonly cause: unknown) {
    super(`probe: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ProbeError";
  }
}

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
  /**
   * Optimistic-concurrency precondition: the revision the caller believes the
   * target holds (the `rev` a read returned). Checked at DEQUEUE against the
   * live revision; a mismatch fails with RevConflictError before the handler
   * runs. For a MULTI-TARGET operation (a batch move) it applies to the
   * PRIMARY target only — `target.path`, the first path the arguments name.
   */
  ifRev?: number;
  /**
   * Retry-collapsing key. A second call carrying a key this kernel has already
   * completed replays that result without executing anything or taking a queue
   * slot. Per plugin instance, TTL'd — see idempotency.ts.
   */
  idempotencyKey?: string;
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
    private readonly probe: TargetProbe | null = null,
    /** Replay store for `idempotency_key`. In memory, cleared by a plugin reload. */
    readonly idempotency: IdempotencyStore = new IdempotencyStore()
  ) {}

  /**
   * Run one mutating operation: serialized behind every other mutating
   * operation on this plugin instance, and journaled exactly once.
   *
   * Rethrows what the queue rejects with — including WriteTimeoutError and
   * RevConflictError, which the caller renders as typed tool errors (see
   * mcp/guarded.ts). An operation abandoned on timeout is journaled `error`; if
   * it later settles anyway, a second, CORRECTIVE record is appended (the
   * journal never rewrites a line).
   */
  async runMutation<T>(mc: MutationContext, run: () => Promise<T>): Promise<T> {
    // Idempotency is settled BEFORE the queue: a retry that is going to be
    // replayed must not take a queue slot behind real work, let alone run.
    if (mc.idempotencyKey !== undefined) {
      const hit = this.idempotency.get(mc.idempotencyKey);
      if (hit) {
        if (hit.op !== mc.op) {
          // One key, two operations: the caller's retry bookkeeping is wrong
          // and executing either interpretation could be the wrong write.
          const mismatch = new IdempotencyMismatchError(mc.idempotencyKey, hit.op, mc.op);
          this.journalTerminal(mc, "error", { error: mismatch.message });
          throw mismatch;
        }
        this.journalTerminal(mc, "deduped", { dedupeOf: hit.ts });
        return hit.result as T;
      }
    }
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
    // Set only when the handler RETURNED an envelope; a throw leaves it unset,
    // so nothing gets stored for replay under an idempotency key.
    let settled: { value: T } | undefined;
    try {
      const result = await this.queue.run(
        mc.op,
        () => {
          started = Date.now();
          queueWaitMs = started - enqueued;
          target = this.resolveTarget(mc.args, mc.ref);
          try {
            // A delete or move destroys the source's identity, so uid/revBefore
            // have to be read while it still exists — but no earlier than this.
            const path = target.path;
            if (path) {
              const uid = this.probe?.uid(path);
              if (uid !== undefined) target = { ...target, uid };
              revBefore = this.probe?.rev(path);
            }
          } catch (e) {
            // A throwing probe is a probe failure, not a vault-operation
            // failure — say so, or the journal blames a write that never ran.
            throw new ProbeError(e);
          }
          // The precondition, checked HERE and nowhere earlier: an enqueue-time
          // check would compare against a world the operations ahead of us in
          // the queue have already changed, which is precisely the lost update
          // `if_rev` exists to catch.
          if (mc.ifRev !== undefined && revBefore !== mc.ifRev) {
            throw new RevConflictError(mc.op, target.path, mc.ifRev, revBefore);
          }
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
            ...this.preconditionFields(mc),
          });
        }
      );
      settled = { value: result };
      const text = errorTextOf(result);
      if (text !== undefined) { outcome = "error"; error = text; }
      return result;
    } catch (e) {
      // A failed precondition is its own outcome: nothing was written, and
      // `revBefore` already holds the revision actually found.
      outcome = e instanceof RevConflictError ? "conflict" : "error";
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const durationMs = Date.now() - started;
      const revAfter = this.revAfterOf(target);
      ts = new Date().toISOString();
      // A retry replays whatever the first call RETURNED — success or a failure
      // envelope alike. One key means one logical request with one outcome; a
      // genuine retry of a failed operation takes a fresh key. Thrown failures
      // (timeout, conflict) are deliberately not stored: they left the vault in
      // an unknown or unchanged state, where re-running is the right answer.
      if (mc.idempotencyKey !== undefined && settled !== undefined) {
        this.idempotency.set(mc.idempotencyKey, { op: mc.op, result: settled.value, ts });
      }
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
        ...this.preconditionFields(mc),
      });
    }
  }

  /** The caller-supplied kernel arguments, recorded on every record they apply to. */
  private preconditionFields(mc: MutationContext): { ifRev?: number; idempotencyKey?: string } {
    return {
      ...(mc.ifRev !== undefined ? { ifRev: mc.ifRev } : {}),
      ...(mc.idempotencyKey !== undefined ? { idempotencyKey: mc.idempotencyKey } : {}),
    };
  }

  /**
   * Journal a record for an operation that never reached the queue — a replayed
   * idempotency key, or a key reused across operations. Same shape as any other
   * record; zero durations, because nothing ran.
   */
  private journalTerminal(
    mc: MutationContext,
    outcome: JournalOutcome,
    extra: { error?: string; dedupeOf?: string } = {}
  ): void {
    void this.journal?.append({
      ts: new Date().toISOString(),
      op: mc.op,
      target: this.withUid(this.resolveTarget(mc.args, mc.ref)),
      actor: mc.actor,
      argsDigest: digestArgs(mc.args),
      outcome,
      ...(extra.error !== undefined ? { error: extra.error.slice(0, MAX_JOURNALED_ERROR) } : {}),
      durationMs: 0,
      queueWaitMs: 0,
      ...(extra.dedupeOf !== undefined ? { dedupeOf: extra.dedupeOf } : {}),
      ...this.preconditionFields(mc),
    });
  }

  /**
   * Fresh revision probe for the target, if it names a path at all.
   *
   * Never throws: this runs on the `finally` path (and its late-settlement
   * twin), where a throwing probe would replace a perfectly good result with an
   * exception — or, worse, lose the journal record entirely.
   */
  private revAfterOf(target: JournalTarget): number | undefined {
    if (!target.path) return undefined;
    try {
      return this.probe?.rev(target.path);
    } catch (e) {
      console.error("[vault-mcp] revAfter probe failed", e);
      return undefined;
    }
  }

  /**
   * Derive the operation's target from its arguments, reusing the guard's
   * recursive path collector so the journal sees exactly the paths the
   * allowlist would scope — a tool the guard can see cannot be invisible here.
   *
   * `ref` is the fallback for pathless mutators (run a command, toggle a
   * plugin): it is recorded only when the arguments name no path at all, so a
   * real path always wins.
   *
   * Probe-free by design: `uid` is attached by the caller, which decides how a
   * throwing probe should be treated (fatal-but-attributed at dequeue,
   * swallowed on the record-only paths).
   */
  private resolveTarget(args: Record<string, unknown>, ref?: string): JournalTarget {
    const paths = collectPaths(args ?? {});
    if (paths.length === 0) return ref ? { ref } : {};
    return {
      path: paths[0],
      ...(paths.length > 1 ? { paths: paths.slice(0, MAX_JOURNALED_PATHS) } : {}),
    };
  }

  /** `target` plus its uid, for record-only paths — never throws, nothing ran. */
  private withUid(target: JournalTarget): JournalTarget {
    if (!target.path) return target;
    try {
      const uid = this.probe?.uid(target.path);
      return uid !== undefined ? { ...target, uid } : target;
    } catch {
      return target;
    }
  }
}
