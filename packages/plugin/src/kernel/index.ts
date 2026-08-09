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
   * the caller renders as a typed tool error (see mcp/guarded.ts).
   */
  async runMutation<T>(mc: MutationContext, run: () => Promise<T>): Promise<T> {
    const target = this.resolveTarget(mc.args);
    // Sampled before the operation: a delete or move destroys the source's
    // identity, so uid/revBefore have to be read while it still exists.
    const revBefore = target.path ? this.probe?.rev(target.path) : undefined;
    const started = Date.now();

    let outcome: JournalOutcome = "ok";
    let error: string | undefined;
    try {
      const result = await this.queue.run(mc.op, run);
      const text = errorTextOf(result);
      if (text !== undefined) { outcome = "error"; error = text; }
      return result;
    } catch (e) {
      outcome = "error";
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const durationMs = Date.now() - started;
      const revAfter = target.path ? this.probe?.rev(target.path) : undefined;
      // Fire-and-forget: WriteJournal.append never rejects, and the operation's
      // result must not wait on (or be affected by) the audit write.
      void this.journal?.append({
        ts: new Date().toISOString(),
        op: mc.op,
        target,
        actor: mc.actor,
        argsDigest: digestArgs(mc.args),
        outcome,
        ...(error !== undefined ? { error } : {}),
        durationMs,
        ...(revBefore !== undefined ? { revBefore } : {}),
        ...(revAfter !== undefined ? { revAfter } : {}),
      });
    }
  }

  /**
   * Derive the operation's target from its arguments, reusing the guard's
   * recursive path collector so the journal sees exactly the paths the
   * allowlist would scope — a tool the guard can see cannot be invisible here.
   */
  private resolveTarget(args: Record<string, unknown>): JournalTarget {
    const paths = collectPaths(args ?? {});
    if (paths.length === 0) return {};
    const path = paths[0];
    const uid = this.probe?.uid(path);
    return {
      path,
      ...(uid !== undefined ? { uid } : {}),
      ...(paths.length > 1 ? { paths: paths.slice(0, MAX_JOURNALED_PATHS) } : {}),
    };
  }
}
