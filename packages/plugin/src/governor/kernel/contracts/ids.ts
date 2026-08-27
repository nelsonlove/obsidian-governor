// IDS — branded identifiers for governance objects (WP3).
//
// Sessions, mandates, cohorts, vaults, and replicas are DIFFERENT OBJECTS (a
// settled decision), and most of them are represented as strings. Branding
// makes the compiler enforce the difference: a SessionId cannot be passed
// where a MandateId is expected, even though both are UUIDv7 strings at
// runtime. The brands are type-level only — zero runtime cost, zero
// serialization difference.
//
// Minting rules (guide §8): newly minted session, mandate, proposal, cohort,
// replica, and key-registration ids are UUIDv7. Stable NOTE ids remain
// governed by the vault's existing identity contract (the uid frontmatter
// machinery) and are NOT minted here. Identity is never derived from path or
// Git author.

import { uuidv7 } from "@vault-mcp/core";

declare const brand: unique symbol;
type Branded<B extends string> = string & { readonly [brand]: B };

export type VaultId = Branded<"vault">;
export type ReplicaId = Branded<"replica">;
export type SessionId = Branded<"session">;
export type MandateId = Branded<"mandate">;
export type ProposalId = Branded<"proposal">;
export type CohortId = Branded<"cohort">;
export type KeyId = Branded<"key">;
export type PredicateId = Branded<"predicate">;

/** The id kinds this module may MINT. Note ids are deliberately absent. */
export type MintableKind = "replica" | "session" | "mandate" | "proposal" | "cohort" | "key";

interface MintableMap {
  replica: ReplicaId;
  session: SessionId;
  mandate: MandateId;
  proposal: ProposalId;
  cohort: CohortId;
  key: KeyId;
}

/**
 * Mint a new id of the given kind. `ms` is the mint time and `rand` is
 * injectable so tests are deterministic — the same injection contract the
 * vault's note-uid mint already uses (they share one UUIDv7 implementation,
 * @vault-mcp/core's uuidv7.ts, precisely so the two can never drift apart in format).
 */
export function mintId<K extends MintableKind>(kind: K, ms: number, rand?: Uint8Array): MintableMap[K] {
  void kind; // the kind exists to bind the return TYPE; all kinds share the UUIDv7 format
  return uuidv7(ms, rand) as MintableMap[K];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a string is a well-formed UUIDv7 (version and variant bits checked). */
export function isUuidV7(s: string): boolean {
  return UUID.test(s);
}
