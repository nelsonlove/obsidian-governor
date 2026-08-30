// CAPTURE — Gate 0, WP2's vertical slice (D16).
//
// The point where the observation substrate stops being contracts and starts
// writing note text to disk. Everything here is about the conditions under
// which that happens, because the failure that matters is not "capture broke"
// — it is "capture happened when nobody asked for it".
//
// Five gates, and a read is captured only if ALL of them agree:
//
//   1. the human turned it on. Default off, per vault. Capturing note bodies
//      is a privacy decision, and it is not one a plugin should make for
//      somebody by shipping it enabled.
//   2. the ACTION says its observations are worth keeping. A compatibility
//      action never does, so the 123 pre-existing tools capture nothing even
//      with the setting on — they are not native, and inventing an observation
//      contract for them would be the overclaim the adapter exists to prevent.
//   3. the read's provenance is known — a payload whose source is unrecorded
//      can never be authorized for replay, so storing it is pure cost.
//   4. no source lies in a guarded territory. Reads there are legal and must
//      stay legal; CAPTURE is what turns a read into a durable copy somewhere
//      else, which is exactly what a guarded territory forbids (issue #322).
//   5. there is room under the size cap.
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
  /**
   * Whether a source path lies in a guarded territory (governance/territories).
   * A payload with ANY guarded source is refused whole — a mixed read is not
   * split, because the payload is one object and partial retention of it would
   * still retain the guarded part.
   */
  excludedSource?: (path: string) => boolean;
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
  /**
   * Running total, seeded ONCE from what is actually on disk.
   *
   * The first draft started this at zero, which quietly turned a store-wide cap
   * into a per-connection one: the capture path is built per connection, so
   * every reconnect got another capful. A 50 MB cap across twenty sessions is a
   * gigabyte, and the setting would have been describing something other than
   * what it did.
   *
   * Seeded lazily rather than at construction so an unused connection never
   * pays for the walk.
   */
  let storedBytes: number | null = null;
  /**
   * The seed happens exactly once even under concurrency. Two overlapping
   * captures that each saw `null`, each walked the disk, and each assigned the
   * result would have the later assignment silently erase the earlier one's
   * increment — so the walk is memoized as a promise both await.
   */
  let seeding: Promise<number> | null = null;

  return {
    async capture(input) {
      if (!opts.enabled()) return { observation: null, note: "capture disabled in settings" };

      // Gate 2. A compatibility action's declared capture is `ephemeral`, so
      // the policy returns `ephemeral` and there is nothing to build.
      const decision = decideCapture({
        action: input.action,
        // HAVING a session is not BEING governed. Every connection now opens
        // a replica-local session (WP5), so a non-null id merely means "a
        // connection exists" — while `governed` in D16's sense means working
        // in a proposing or mandated posture, which arrives with WP6/WP9.
        // Passing true here would silently promote every future
        // evidence-default action to full-payload retention the moment it
        // shipped, on the strength of nothing but a connection.
        session: input.sessionId ? { id: input.sessionId, governed: false } : null,
        // A read whose action declares a durable default is returning
        // substantive content by contract. Sessions arrive in WP5; until then
        // the action's own declaration is the whole signal.
        substantive: input.action.observations.defaultCapture !== "ephemeral",
      });
      if (decision.level === "ephemeral") {
        return { observation: null, note: `ephemeral by policy: ${decision.reason}` };
      }

      // Gate 3, and it was found by a test rather than by design. Without a
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

      // Gate 4. The territory list forbids RETENTION, not reading: the read
      // itself already happened and stays legal. What may not happen is this
      // module writing a durable copy of guarded content outside the territory
      // — so any guarded source refuses the whole payload, before redaction or
      // the size cap ever see it.
      if (opts.excludedSource) {
        const guarded = input.sources.filter(opts.excludedSource);
        if (guarded.length > 0) {
          // This note carries the guarded PATHS (not bodies) on the in-memory
          // operation envelope — same posture the write journal takes for
          // paths today. If a durable operations sink is ever wired, whether
          // guarded paths may flow into it is a decision to make THEN, on
          // purpose, not to inherit from this string.
          return {
            observation: null,
            note: `source in a guarded territory (${guarded.join(", ")}); guarded content is never retained outside its territory`,
          };
        }
      }

      try {
        const { payload, redactions } = redactForCapture(input.payload, { redactKeys: opts.redactKeys ?? [] });
        const serialized = JSON.stringify(payload);
        const size = serialized ? serialized.length : 0;

        // Gate 5. Checked BEFORE writing, so the cap is a limit rather than a
        // description of what already happened.
        if (storedBytes === null) {
          seeding ??= opts.store.totalBytes();
          const seeded = await seeding;
          // First resolver wins; a concurrent capture that already incremented
          // past the seed must not be rewound to it.
          if (storedBytes === null) storedBytes = seeded;
        }
        if (storedBytes + size > opts.maxBytes) {
          return {
            observation: null,
            note: `size cap reached (${storedBytes}/${opts.maxBytes} bytes on disk); capture stopped rather than growing without bound`,
          };
        }

        // RESERVED BEFORE THE WRITE, not after it. Reads deliberately never
        // queue, so several captures can be in flight at once; incrementing
        // after `await store.put(...)` meant each of them checked the cap
        // against the same stale count and they all passed, overshooting by
        // roughly the concurrency. Reserving first makes the check-and-claim
        // atomic with respect to other captures, since nothing awaits between
        // the comparison above and this line.
        //
        // Failure direction is deliberate: if the put below throws, the bytes
        // stay counted. That over-counts, which stops capture EARLIER — the
        // safe way for a cap to be wrong. The next connection reseeds from
        // disk truth anyway.
        storedBytes = (storedBytes ?? 0) + size;

        const payloadObject =
          decision.level === "replayable" ? await opts.store.put(payload, { sources: input.sources }) : null;
        // The counter remains deliberately approximate for the reasons it
        // always was: a deduplicated put adds no disk yet still increments
        // (reads high); this increment measures the payload while the stored
        // envelope also carries provenance (reads low by that small overhead).
        // Neither drift compounds, and the cap is a stopgap against unbounded
        // growth, not an accounting system.

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
