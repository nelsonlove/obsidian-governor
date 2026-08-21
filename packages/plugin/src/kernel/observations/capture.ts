// CAPTURE — Gate 0, WP2's vertical slice (D16).
//
// The point where the observation substrate stops being contracts and starts
// writing note text to disk. Everything here is about the conditions under
// which that happens, because the failure that matters is not "capture broke"
// — it is "capture happened when nobody asked for it".
//
// Three gates, and a read is captured only if all three agree:
//
//   1. the human turned it on. Default off, per vault. Capturing note bodies
//      is a privacy decision, and it is not one a plugin should make for
//      somebody by shipping it enabled.
//   2. the ACTION says its observations are worth keeping. A compatibility
//      action never does, so the 123 pre-existing tools capture nothing even
//      with the setting on — they are not native, and inventing an observation
//      contract for them would be the overclaim the adapter exists to prevent.
//   3. there is room under the size cap.
//
// The cap exists because retention does not, yet. Until a real retention pass
// lands, an uncapped store grows forever, and "it filled the disk" is a worse
// outcome than "it stopped recording and said so". The cap is a stopgap and is
// named as one.
//
// Nothing here may cost a caller their result. A capture failure — a full disk,
// a permissions error, a throwing store — degrades observability and is
// reported on the operation, exactly as the write journal already behaves.

import { buildObservation, redactForCapture, type ObservationV1 } from "./observation.js";
import { decideCapture } from "./capture-policy.js";
import type { ObservationStore } from "./store.js";
import type { ActionDefinition } from "../operations/action.js";

export interface CaptureInput {
  action: ActionDefinition;
  operationId: string;
  actorBinding: string;
  sessionId: string | null;
  mandateId: string | null;
  normalizedRequestDigest: string;
  effectiveScopeDigest: string;
  /** Vault paths the read covered, for playback authorization. */
  sources: string[];
  /** Exactly what the handler returned. */
  payload: unknown;
}

export interface CaptureResult {
  observation: ObservationV1 | null;
  /** Why nothing was captured, when nothing was. Present ONLY on a non-capture,
   * so an empty observation list can be told apart from a read that had
   * nothing to record — "absence is not emptiness" applied to evidence. */
  note?: string;
}

export interface CaptureOpts {
  store: ObservationStore;
  /** Read live, per call: a settings change lands without a reconnect. */
  enabled: () => boolean;
  /** Stopgap ceiling on total stored bytes, pending real retention. */
  maxBytes: number;
  /** Field names removed before anything is written. */
  redactKeys?: string[];
  now?: () => number;
  newId?: () => string;
  onObservation?: (o: ObservationV1) => void;
}

export interface Capture {
  /** Returns the observation, or the reason there is none. Never throws. */
  capture(input: CaptureInput): Promise<CaptureResult>;
}

let seq = 0;

export function createCapture(opts: CaptureOpts): Capture {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? (() => `obs-${Date.now().toString(36)}-${++seq}`);
  /** Running total, so the cap does not need a directory walk per read. */
  let storedBytes = 0;

  return {
    async capture(input) {
      if (!opts.enabled()) return { observation: null, note: "capture disabled in settings" };

      // Gate 2. A compatibility action's declared capture is `ephemeral`, so
      // the policy returns `ephemeral` and there is nothing to build.
      const decision = decideCapture({
        action: input.action,
        session: input.sessionId ? { id: input.sessionId, governed: true } : null,
        // A read whose action declares a durable default is returning
        // substantive content by contract. Sessions arrive in WP5; until then
        // the action's own declaration is the whole signal.
        substantive: input.action.observations.defaultCapture !== "ephemeral",
      });
      if (decision.level === "ephemeral") {
        return { observation: null, note: `ephemeral by policy: ${decision.reason}` };
      }

      // Gate 4, and it was found by a test rather than by design. Without a
      // recorded source the store cannot authorize a replay — it refuses a
      // source-less payload outright — so capturing one writes note text to
      // disk that nobody can ever read back. That is the worst combination
      // available: the whole privacy cost of retention and none of the
      // benefit. If Governor does not know where content came from, it does
      // not keep it.
      if (input.sources.length === 0) {
        return {
          observation: null,
          note: "no source recorded for this read; a payload with unknown provenance can never be authorized for replay, so it is not stored",
        };
      }

      try {
        const { payload, redactions } = redactForCapture(input.payload, { redactKeys: opts.redactKeys ?? [] });
        const serialized = JSON.stringify(payload);
        const size = serialized ? serialized.length : 0;

        // Gate 3. Checked BEFORE writing, so the cap is a limit rather than a
        // description of what already happened.
        if (storedBytes + size > opts.maxBytes) {
          return {
            observation: null,
            note: `size cap reached (${storedBytes}/${opts.maxBytes} bytes); capture stopped rather than growing without bound`,
          };
        }

        const payloadObject =
          decision.level === "replayable" ? await opts.store.put(payload, { sources: input.sources }) : null;
        storedBytes += size;

        const observation = buildObservation({
          id: newId(),
          operationId: input.operationId,
          action: { id: input.action.id, version: input.action.version },
          capturedAt: now(),
          level: decision.level,
          actorBinding: input.actorBinding,
          sessionId: input.sessionId,
          mandateId: input.mandateId,
          normalizedRequestDigest: input.normalizedRequestDigest,
          effectiveScopeDigest: input.effectiveScopeDigest,
          sourceState: input.sources.map((path) => ({ identity: path, path, revision: null, contentDigest: null })),
          payload,
          payloadObject,
          redactions,
        });
        if (observation) opts.onObservation?.(observation);
        return { observation };
      } catch (e) {
        // Never the caller's problem.
        const why = e instanceof Error ? e.message : String(e);
        console.error("[governor] observation capture failed", e);
        return { observation: null, note: `capture failed: ${why}` };
      }
    },
  };
}
