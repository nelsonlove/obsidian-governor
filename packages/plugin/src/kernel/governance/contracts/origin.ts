// ORIGIN — the four origin classes and their confidence (WP3, D12).
//
// Governor records where a change came from "without claiming more certainty
// than the runtime provides" (git-and-sync.md). That sentence is the contract:
// each origin class carries a FIXED confidence describing what kind of
// evidence backs it, and nothing may promote a weaker origin to a stronger
// one because the change "looks" human. Classification behavior arrives in
// WP5; these are the types every classifier and journal entry share.

/**
 * The four origins, exactly as the normative doc names them:
 *
 * - `governor-originated` — bound to the connection and replica-local session
 *   that produced the operation.
 * - `local-human-observed` — an editor-buffer change observed with recent
 *   trusted human input; may establish immediate local human standing under
 *   the configured policy, but remains OBSERVED rather than proven.
 * - `sync-attributed` — delivered through replica reconciliation; authority
 *   follows matching portable evidence and is never inferred from arrival.
 * - `external-unattributed` — another plugin, filesystem process, or
 *   indeterminate source; recorded, marked stale, routed for reconciliation.
 */
export type OriginClass = "governor-originated" | "local-human-observed" | "sync-attributed" | "external-unattributed";

export const ORIGIN_CLASSES: readonly OriginClass[] = [
  "governor-originated",
  "local-human-observed",
  "sync-attributed",
  "external-unattributed",
];

/**
 * What kind of evidence backs an origin claim. Fixed per class — the mapping
 * IS the "no more certainty than the runtime provides" rule, made structural:
 *
 * - `bound` — tied to a live connection and session Governor itself holds;
 * - `observed` — witnessed behavior (trusted editor input) without proof;
 * - `attributed` — asserted by matching portable evidence from another replica;
 * - `indeterminate` — nothing attributable; the honest floor.
 */
export type OriginConfidence = "bound" | "observed" | "attributed" | "indeterminate";

export const ORIGIN_CONFIDENCE: Readonly<Record<OriginClass, OriginConfidence>> = {
  "governor-originated": "bound",
  "local-human-observed": "observed",
  "sync-attributed": "attributed",
  "external-unattributed": "indeterminate",
};

/** An origin as recorded on operations, journal entries, and reconciliation queues. */
export interface OriginRecord {
  origin: OriginClass;
  /** Always ORIGIN_CONFIDENCE[origin]; carried explicitly so a record is readable alone. */
  confidence: OriginConfidence;
}

export function isOriginClass(v: unknown): v is OriginClass {
  return typeof v === "string" && (ORIGIN_CLASSES as readonly string[]).includes(v);
}

export function originRecord(origin: OriginClass): OriginRecord {
  return { origin, confidence: ORIGIN_CONFIDENCE[origin] };
}
