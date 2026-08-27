// SESSION STORE — durable, append-only, replica-local (WP5).
//
// Sessions group operations, observation and effect references, proposals,
// verification, and receipts DURABLY — a session that exists only in process
// memory evaporates with the process, and everything it grouped becomes
// ungrouped evidence. So the store is an append-only event log (the same
// shape the acceptance log and write journal already use): lifecycle events
// appended, current state folded. Nothing is ever rewritten; a session's
// history of transitions is itself evidence.
//
// IO is injected (the observation store's pattern) so the fold logic is pure
// and the tests need no filesystem. The live wiring appends to
// `governance/sessions.jsonl` in the plugin directory — synced/backed-up
// EVIDENCE, deliberately unlike the observation payloads: a session record
// carries identifiers and digests, never note bodies, so the
// outlives-its-source argument does not apply and auditability wins.

// The session CONTRACT is a published contract since S3 (condition 7 — the
// host mints; see packages/core/src/session.ts). The STORE — the durable
// event log, and the revocation state a human's Revoke gesture writes —
// stays with the provider, and is what the seam's session-refusal hook
// consults.
import { SessionNotLiveError, attachMandate, closeSession, expireSession, revokeSession, type SessionV1 } from "@vault-mcp/core";

export type SessionEvent =
  | { kind: "opened"; at: number; session: SessionV1 }
  | { kind: "closed"; at: number; sessionId: string }
  | { kind: "revoked"; at: number; sessionId: string; reason: string }
  | { kind: "expired"; at: number; sessionId: string }
  /** WP9: mandate activation binds the granted mandate to its delegate session. */
  | { kind: "mandated"; at: number; sessionId: string; mandateId: string };

export interface SessionEventIo {
  /** Atomically append one line. */
  appendLine(line: string): Promise<void>;
  /** All lines, oldest first. Missing store = empty list. */
  readLines(): Promise<string[]>;
}

export interface SessionStore {
  open(session: SessionV1, now: number): Promise<void>;
  close(sessionId: string, now: number): Promise<void>;
  revoke(sessionId: string, reason: string, now: number): Promise<void>;
  /** Record an observed expiry, so the durable state matches what liveness already decided. */
  markExpired(sessionId: string, now: number): Promise<void>;
  /** WP9: bind a granted mandate to its delegate session — refused unless the session is open and unmandated. */
  attachMandate(sessionId: string, mandateId: string, now: number): Promise<void>;
  /** Current folded state of one session, or null. */
  get(sessionId: string): Promise<SessionV1 | null>;
  /** All sessions in their current folded state. */
  all(): Promise<SessionV1[]>;
}

/**
 * Fold events into current state. Pure, total, and forgiving of garbage in
 * the direction of SAFETY: an unparseable line is skipped (a corrupt tail
 * must not take down every prior session), and an event for an unknown
 * session id is ignored rather than inventing a session to apply it to.
 */
export function foldSessionEvents(lines: readonly string[]): Map<string, SessionV1> {
  const out = new Map<string, SessionV1>();
  for (const line of lines) {
    let ev: SessionEvent;
    try {
      ev = JSON.parse(line) as SessionEvent;
    } catch {
      continue;
    }
    if (ev.kind === "opened" && ev.session?.id) {
      // First open wins; a duplicate open for an id never downgrades state.
      if (!out.has(ev.session.id)) out.set(ev.session.id, ev.session);
      continue;
    }
    const cur = "sessionId" in ev ? out.get(ev.sessionId) : undefined;
    if (!cur) continue;
    try {
      if (ev.kind === "closed") out.set(cur.id, closeSession(cur));
      else if (ev.kind === "revoked") out.set(cur.id, revokeSession(cur, ev.reason));
      else if (ev.kind === "expired" && cur.status === "open") out.set(cur.id, expireSession(cur, Math.max(ev.at, cur.expiresAt)));
      else if (ev.kind === "mandated") out.set(cur.id, attachMandate(cur, ev.mandateId));
    } catch {
      // A transition invalid against folded state (close of a revoked
      // session, say) is recorded history colliding with itself — keep the
      // stronger existing state rather than throwing away the fold.
    }
  }
  return out;
}

export function createSessionStore(io: SessionEventIo): SessionStore {
  // The LINES are cached and the fold recomputed from them on demand — one
  // interpretation of events (the fold), not a fold plus a hand-maintained
  // incremental mirror that can drift from it. Session counts are small
  // (one per connection); folding is cheap at this scale, and on restart the
  // on-disk log is the truth.
  let lines: string[] | null = null;

  async function allLines(): Promise<string[]> {
    if (lines === null) lines = await io.readLines();
    return lines;
  }

  async function state(): Promise<Map<string, SessionV1>> {
    return foldSessionEvents(await allLines());
  }

  async function append(ev: SessionEvent): Promise<void> {
    // Cache seeded BEFORE the append — a cold cache read after appendLine
    // would already contain the new line and pushing would double-count.
    // Every public method folds first today, which seeds it; this makes the
    // ordering structural rather than an accident of the callers.
    const cached = await allLines();
    const line = JSON.stringify(ev);
    await io.appendLine(line);
    cached.push(line);
  }

  return {
    async open(session, now) {
      const m = await state();
      if (m.has(session.id)) throw new Error(`session ${session.id} is already recorded`);
      await append({ kind: "opened", at: now, session });
    },
    async close(sessionId, now) {
      const m = await state();
      const cur = m.get(sessionId);
      if (!cur) throw new SessionNotLiveError(sessionId, "closed");
      if (cur.status !== "open") return; // idempotent: already terminal
      await append({ kind: "closed", at: now, sessionId });
    },
    async revoke(sessionId, reason, now) {
      const m = await state();
      if (!m.has(sessionId)) throw new SessionNotLiveError(sessionId, "closed");
      await append({ kind: "revoked", at: now, sessionId, reason });
    },
    async markExpired(sessionId, now) {
      const m = await state();
      const cur = m.get(sessionId);
      if (!cur || cur.status !== "open") return;
      await append({ kind: "expired", at: now, sessionId });
    },
    async attachMandate(sessionId, mandateId, now) {
      const m = await state();
      const cur = m.get(sessionId);
      if (!cur) throw new SessionNotLiveError(sessionId, "closed");
      // Run the kernel transition against folded state BEFORE appending, so a
      // refused attach (not open, already mandated) writes nothing.
      attachMandate(cur, mandateId);
      await append({ kind: "mandated", at: now, sessionId, mandateId });
    },
    async get(sessionId) {
      return (await state()).get(sessionId) ?? null;
    },
    async all() {
      return [...(await state()).values()];
    },
  };
}
