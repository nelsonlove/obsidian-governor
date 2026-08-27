// SESSIONS — the host's minting logic (WP5, D01).
//
// The session CONTRACT — `SessionV1`, its status transitions, and its
// clock-expiry floor — moved to `@vault-mcp/core` at the suite split's S3
// (condition 7, ruled 2026-08-27: "the HOST keeps minting... SessionV1
// therefore becomes a published contract, not provider-internal"). See
// `packages/core/src/session.ts` for the type and its rationale.
//
// What STAYS here is the host's own minting logic, `openSession`. It stays
// because condition 7 RULED that minting is a host responsibility — a session
// is transport state, and the host is the only thing that knows a connection
// began. The reason is the ruling, not a dependency: `uuidv7` was promoted
// into `@vault-mcp/core` in the same S3 step (the provider mints ids too), so
// nothing about the import graph forces `openSession` to live here any more.
// Do not "simplify" it into core on the strength of that — moving the mint
// would move the responsibility, which is a ruling to revisit, not a refactor.
//
// This module re-exports the contract alongside it so existing local imports
// keep working unchanged.
//
// HOST-SIDE since the suite split's S2 (condition 7): the host is the only
// thing that knows a connection began, it computes the connection's scope
// digest, and it closes the session when the socket drops.
//
// What the PROVIDER owns is REFUSAL: revocation state, answered through the
// seam's refusal-shaped session hook (`registerSessionRefusal`, mcp/seam.ts).
// The host never asks a provider for permission — only whether it wants to
// refuse — and an absent provider constrains nothing.

import { SESSION_TTL_MS, uuidv7 } from "@vault-mcp/core";
import type { SessionId, SessionV1 } from "@vault-mcp/core";

export {
  SESSION_TTL_MS,
  SessionNotLiveError,
  isLive,
  livenessOf,
  expiryRefusal,
  attachMandate,
  closeSession,
  revokeSession,
  expireSession,
} from "@vault-mcp/core";
export type { SessionId, SessionStatus, SessionV1 } from "@vault-mcp/core";

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
    id: uuidv7(now, rand) as SessionId,
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
