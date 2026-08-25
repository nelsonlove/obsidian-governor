// SESSIONS — replica-local, durable, expiring (WP5, D01).
//
// A session binds a connection, a local actor, a base state, a scope, and the
// current replica. D01's ruling shapes everything here: **sessions are
// replica-local** — the identifier is globally unique and may be LINKED
// across devices (`continuedFrom`, `relatedSessions`), but a link transfers
// no capability. Another device opens its OWN session with its own actor
// binding, base state, expiry, and receipts. "An attestation or cohort may be
// portable; the live session capability is not."
//
// Status transitions are one-way. There is no resurrect: an expired or
// revoked session is evidence about the past, and a new session is cheap.
// Expiry is decided AT USE (dequeue, admission) against a caller-supplied
// clock — no timers, nothing here reads the wall clock.

import { mintId, type SessionId } from "../contracts/ids.js";

/**
 * How long a session lives without explicit closure. Generous on purpose: the
 * cost of an expired-but-active session is one typed refusal and a reconnect,
 * while the cost of an eternal session is an authority context that outlives
 * anyone's memory of opening it. Mandates (WP9) carry their own, tighter
 * budgets — this is the OUTER bound for ungoverned-posture work.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type SessionStatus = "open" | "closed" | "expired" | "revoked";

export interface SessionV1 {
  schema: "governor.session/v1";
  id: SessionId;
  /** Which vault this session speaks about. */
  vaultId: string;
  /** The install id of THIS replica — sessions never span replicas (D01). */
  replicaId: string;
  /**
   * The transport-established actor. Never client-claimed. `clientClaim` is
   * what was known AT OPEN — for a real MCP connection that is null, because
   * the client's initialize handshake happens after the server (and session)
   * is built. The journal actor resolves the live client per call; the two
   * records deliberately answer different questions ("who opened this" vs
   * "who was speaking when this landed").
   */
  actor: { connection: string; clientClaim: string | null };
  /**
   * Where the vault stood when the session opened — the journal's head
   * position, or null when the journal was empty/unavailable. Evidence for
   * later reconciliation, not a lock.
   */
  baseState: { journalHead: string | null };
  /** Digest of the effective connection scope at open. A session cannot widen it. */
  scopeDigest: string;
  openedAt: number;
  expiresAt: number;
  /** Set only when work runs under a mandate (WP9). */
  mandateId: string | null;
  /**
   * Lineage links. A link is a FACT about relatedness, never a capability:
   * nothing may derive scope, mandate, or liveness through one — the opening
   * input carries no fields to inherit, which is the enforcement.
   */
  continuedFrom: SessionId | null;
  relatedSessions: SessionId[];
  status: SessionStatus;
  /** Present only on revoked sessions. */
  revokedReason?: string;
}

/** A session may not be used after transitioning out of `open`. */
export class SessionNotLiveError extends Error {
  readonly code = "session_not_live";
  constructor(readonly sessionId: string, readonly status: SessionStatus) {
    super(`session ${sessionId} is ${status}; open a new session rather than reviving this one`);
    this.name = "SessionNotLiveError";
  }
}

export interface OpenSessionInput {
  vaultId: string;
  replicaId: string;
  actor: { connection: string; clientClaim: string | null };
  journalHead: string | null;
  scopeDigest: string;
  continuedFrom?: SessionId | null;
  relatedSessions?: SessionId[];
  ttlMs?: number;
}

/**
 * Open a session. Note what the input CANNOT carry: a mandate (activation is
 * a separate human act, WP9), a status, an expiry in the past's favor, or
 * anything inherited from `continuedFrom` — the link is recorded and nothing
 * else is read from it.
 */
export function openSession(input: OpenSessionInput, now: number, rand?: Uint8Array): SessionV1 {
  const ttl = input.ttlMs ?? SESSION_TTL_MS;
  if (!(ttl > 0)) throw new Error(`session ttl must be positive, got ${ttl}`);
  return {
    schema: "governor.session/v1",
    id: mintId("session", now, rand),
    vaultId: input.vaultId,
    replicaId: input.replicaId,
    actor: { connection: input.actor.connection, clientClaim: input.actor.clientClaim },
    baseState: { journalHead: input.journalHead },
    scopeDigest: input.scopeDigest,
    openedAt: now,
    expiresAt: now + ttl,
    mandateId: null,
    continuedFrom: input.continuedFrom ?? null,
    relatedSessions: [...(input.relatedSessions ?? [])],
    status: "open",
  };
}

/**
 * Liveness, decided at use. An open session past its expiry is NOT live —
 * expiry needs no writer to have happened, which is what makes the
 * at-dequeue and at-admission checks meaningful after a crash or a sleep.
 */
export function isLive(session: SessionV1, now: number): boolean {
  return session.status === "open" && now < session.expiresAt;
}

/** Why a session is not live, for typed refusals. */
export function livenessOf(session: SessionV1, now: number): SessionStatus {
  if (session.status !== "open") return session.status;
  return now < session.expiresAt ? "open" : "expired";
}

/**
 * Bind a governing mandate to a live session (WP9). Set ONCE, by mandate
 * activation only — the pane's activation gesture is the sole caller path.
 * A session cannot swap mandates mid-flight: replacing the mandate is
 * amendment-by-replacement on the MANDATE side, and the successor mandate's
 * delegate binding decides which sessions run under it.
 */
export function attachMandate(session: SessionV1, mandateId: string): SessionV1 {
  if (session.status !== "open") throw new SessionNotLiveError(session.id, session.status);
  if (!mandateId) throw new Error("attachMandate requires a mandate id");
  if (session.mandateId !== null) {
    throw new Error(`session ${session.id} already runs under mandate ${session.mandateId}; a session's mandate is set once`);
  }
  return { ...session, mandateId };
}

export function closeSession(session: SessionV1): SessionV1 {
  if (session.status !== "open") throw new SessionNotLiveError(session.id, session.status);
  return { ...session, status: "closed" };
}

export function revokeSession(session: SessionV1, reason: string): SessionV1 {
  // Revoking a closed/expired session is allowed and idempotent in effect —
  // revocation is a human statement of distrust, and "already inert" is not a
  // reason to refuse recording it — but a revoked session stays revoked.
  if (session.status === "revoked") return session;
  return { ...session, status: "revoked", revokedReason: reason };
}

/** The expiry transition, made explicit for the durable record. */
export function expireSession(session: SessionV1, now: number): SessionV1 {
  if (session.status !== "open") return session;
  if (now < session.expiresAt) throw new Error(`session ${session.id} has not expired yet`);
  return { ...session, status: "expired" };
}
