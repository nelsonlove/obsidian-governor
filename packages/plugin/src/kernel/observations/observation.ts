// The OBSERVATION record — Gate 0, WP2 (D16, D17).
//
// What Governor returned, after the read boundary was enforced. Not what the
// model saw, not what the client displayed, not what anyone concluded — D17
// stops the guarantee at Governor's own boundary, and this record is shaped so
// it cannot quietly claim more.
//
// Two properties are structural rather than conventional:
//
//   • an EPHEMERAL observation is not a record at all. `buildObservation`
//     returns null for it. There is no object to accidentally persist, no
//     field to later fill in, and nothing for a dependent claim to cite.
//   • a REPLAYABLE observation names a content-addressed object; it never
//     embeds the payload. The record stays small and the bytes live under the
//     retention and access rules that govern them, which is what lets a
//     payload be pruned without destroying the evidence that it existed.

import { nonAuthoritativeDigest, normalizeInputs } from "../operations/operation.js";
import type { CaptureLevel } from "./capture-policy.js";

export interface ObservationSource {
  identity: string;
  path: string | null;
  revision: string | null;
  contentDigest: string | null;
}

export interface ObservationV1 {
  schema: "governor.observation/v1";
  id: string;
  operationId: string;
  action: { id: string; version: number };
  capturedAt: number;
  /** Never `ephemeral` — an ephemeral observation produces no record. */
  level: Exclude<CaptureLevel, "ephemeral">;
  actorBinding: string;
  sessionId: string | null;
  mandateId: string | null;
  normalizedRequestDigest: string;
  effectiveScopeDigest: string;
  sourceState: ObservationSource[];
  result: {
    digest: string;
    /** Content-addressed reference, for `replayable` only. */
    payloadObject: string | null;
    orderMaterial: boolean;
    truncated: boolean;
    excludedCount: number | null;
    unavailable: string[];
    /** Fields removed before capture, by path. Recorded so a reviewer knows
     * something was withheld rather than absent. */
    redactions: string[];
  };
}

export interface BuildObservationInput {
  id: string;
  operationId: string;
  action: { id: string; version: number };
  capturedAt: number;
  level: CaptureLevel;
  actorBinding: string;
  sessionId?: string | null;
  mandateId?: string | null;
  normalizedRequestDigest: string;
  effectiveScopeDigest: string;
  sourceState: ObservationSource[];
  /** The already-redacted payload. Digested here; never stored here. */
  payload: unknown;
  /** Required when `level` is `replayable`: where the exact bytes were stored. */
  payloadObject?: string | null;
  orderMaterial?: boolean;
  truncated?: boolean;
  excludedCount?: number | null;
  unavailable?: string[];
  redactions?: string[];
}

/**
 * Build the record, or `null` for an ephemeral observation.
 *
 * Refuses a `replayable` level with no stored object. Claiming replayability
 * with nothing to replay is the exact overclaim the level exists to prevent,
 * and it is far better caught here than by a verifier that later cannot find
 * the bytes it was told existed.
 */
export function buildObservation(input: BuildObservationInput): ObservationV1 | null {
  if (input.level === "ephemeral") return null;
  if (input.level === "replayable" && !input.payloadObject) {
    throw new Error(
      "a replayable observation requires a stored payloadObject; capture the payload before building the record, " +
        "or record it as evidence instead of claiming a replayability nothing can satisfy"
    );
  }
  return {
    schema: "governor.observation/v1",
    id: input.id,
    operationId: input.operationId,
    action: { ...input.action },
    capturedAt: input.capturedAt,
    level: input.level,
    actorBinding: input.actorBinding,
    sessionId: input.sessionId ?? null,
    mandateId: input.mandateId ?? null,
    normalizedRequestDigest: input.normalizedRequestDigest,
    effectiveScopeDigest: input.effectiveScopeDigest,
    sourceState: input.sourceState.map((s) => ({ ...s })),
    result: {
      // A digest of the payload, never the payload. Same discipline the write
      // journal already follows for arguments.
      digest: nonAuthoritativeDigest(normalizeInputs(input.payload)),
      payloadObject: input.level === "replayable" ? input.payloadObject! : null,
      orderMaterial: input.orderMaterial ?? false,
      truncated: input.truncated ?? false,
      excludedCount: input.excludedCount ?? null,
      unavailable: input.unavailable ?? [],
      redactions: input.redactions ?? [],
    },
  };
}

export interface RedactionPolicy {
  /** Exact key names to remove, at any depth. */
  redactKeys: string[];
}

/**
 * Remove declared fields BEFORE anything is captured.
 *
 * The order is the control, not a detail. Capturing first and redacting later
 * means the unredacted bytes existed in the store, however briefly, and no
 * retention policy can un-write them.
 *
 * It redacts only DECLARED keys. It does not scan values for things that look
 * secret: a guess that fires wrongly destroys evidence a reviewer needed, and a
 * guess that misses provides false comfort. What is sensitive is a policy
 * decision, made where the policy lives.
 */
export function redactForCapture(payload: unknown, policy: RedactionPolicy): { payload: unknown; redactions: string[] } {
  const keys = new Set(policy.redactKeys);
  if (keys.size === 0) return { payload, redactions: [] };
  const redactions: string[] = [];

  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const here = path ? `${path}.${k}` : k;
        if (keys.has(k)) {
          out[k] = "<redacted>";
          redactions.push(here);
        } else {
          out[k] = walk(val, here);
        }
      }
      return out;
    }
    return v;
  };

  const result = walk(payload, "");
  // Nothing matched: hand back the CALLER'S OWN object, so an unredacted call
  // is byte-identical rather than a structurally equal copy. The same identity
  // discipline `visiblePaths` uses for the no-allowlist case.
  return redactions.length === 0 ? { payload, redactions: [] } : { payload: result, redactions };
}
