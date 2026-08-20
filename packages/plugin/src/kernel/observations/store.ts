// The REPLAYABLE PAYLOAD STORE — Gate 0, WP2 (D16, D17).
//
// Where a replayable observation's bytes live, and what playback may return.
//
// The most important property here is a NEGATIVE one, and it is enforced
// structurally rather than by convention: **this module has no way to read the
// vault.** Nothing is injected that could. A "replay" that re-read current
// state would show a reviewer today's note while claiming to show what the
// agent was given — which is worse than having no replay at all, because it
// looks like evidence. Making that impossible to write is stronger than
// promising not to.
//
// The second property is that playback is authorized by the CURRENT reader's
// authority, not by the scope that applied at capture. An observation made
// under a wide scope must not become a way to read material the person looking
// at it today may not see. The historical scope is preserved on the record for
// interpretation; it is not a key to the payload.
//
// Content addressing does the rest: a payload is stored under its own digest,
// so identical payloads occupy one object and a different payload can never
// silently replace one.

import { payloadDigest } from "./observation.js";

/** The bytes behind the store. Injected, so the kernel stays free of both
 * `obsidian` and any particular filesystem. */
export interface BlobStore {
  put(key: string, data: string): Promise<void>;
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class PayloadMissingError extends Error {
  readonly code = "payload_missing";
  constructor(ref: string) {
    // "Absence is not emptiness": a pruned payload reads as GONE, never as an
    // observation that returned nothing.
    super(`observation payload '${ref}' is not stored; it was pruned, never captured, or belongs to another replica`);
    this.name = "PayloadMissingError";
  }
}

export class PayloadCorruptError extends Error {
  readonly code = "payload_corrupt";
  constructor(ref: string) {
    super(`observation payload '${ref}' does not match its address; it has been altered and cannot be replayed`);
    this.name = "PayloadCorruptError";
  }
}

export class PlaybackUnauthorizedError extends Error {
  readonly code = "playback_unauthorized";
  constructor(ref: string) {
    // Deliberately says nothing about the payload — not its size, not its
    // sources, not whether it exists in a form the reader could infer from.
    super(`not authorized to replay observation '${ref}'`);
    this.name = "PlaybackUnauthorizedError";
  }
}

export interface PlaybackContext {
  /** Who is asking, now. */
  reader: string;
}

export interface ReadAuthorizationInput {
  reader: string;
  ref: string;
  /** The sources the payload covers, so authorization is asked about material
   * rather than about an opaque id. */
  sources: string[];
}

export interface ObservationStoreOpts {
  blobs: BlobStore;
  /**
   * May this reader replay this payload, NOW?
   *
   * Asked per playback rather than resolved at capture, because the answer can
   * change: scope narrows, a mandate is revoked, a folder becomes private. The
   * historical effective scope is evidence about the past; it is not a
   * standing entitlement.
   */
  canRead: (input: ReadAuthorizationInput) => boolean;
  /** Claims that currently depend on a payload, so pruning can refuse to
   * destroy evidence something still rests on. */
  dependents?: (ref: string) => string[];
  now?: () => number;
}

export interface PlaybackResult {
  ref: string;
  payload: unknown;
  /** Always true. Playback is historical inspection; the flag exists so a UI
   * cannot render it as current state without having ignored a field. */
  historical: true;
  playedAt: number;
}

export interface PruneReport {
  removed: string[];
  /** Payloads left in place because something still depends on them, with what
   * depends on them — a prune that silently skipped would look like a prune
   * that worked. */
  stillReferenced: Array<{ ref: string; dependents: string[] }>;
}

export interface ObservationStore {
  /** Store a payload; returns its content address. */
  put(payload: unknown, meta?: { sources?: string[] }): Promise<string>;
  playback(ref: string, ctx: PlaybackContext): Promise<PlaybackResult>;
  export(refs: string[], ctx: PlaybackContext): Promise<Array<{ ref: string; payload: unknown }>>;
  prune(refs: string[]): Promise<PruneReport>;
}

/** Sources are kept beside the payload so authorization can be asked about
 * material. Stored in the same object, so they cannot drift apart. */
interface StoredPayload {
  payload: unknown;
  sources: string[];
}

export function createObservationStore(opts: ObservationStoreOpts): ObservationStore {
  const now = opts.now ?? (() => Date.now());

  async function load(ref: string): Promise<StoredPayload> {
    const raw = await opts.blobs.get(ref);
    if (raw === null) throw new PayloadMissingError(ref);
    let stored: StoredPayload;
    try {
      stored = JSON.parse(raw) as StoredPayload;
    } catch {
      throw new PayloadCorruptError(ref);
    }
    // Verify against the address. Content addressing only means something if
    // the content is checked against it — otherwise the address is a filename.
    if (payloadDigest(stored.payload) !== ref) throw new PayloadCorruptError(ref);
    return stored;
  }

  async function authorized(ref: string, stored: StoredPayload, ctx: PlaybackContext): Promise<void> {
    if (!opts.canRead({ reader: ctx.reader, ref, sources: stored.sources })) {
      throw new PlaybackUnauthorizedError(ref);
    }
  }

  return {
    async put(payload, meta) {
      const ref = payloadDigest(payload);
      // Idempotent by construction: the same payload maps to the same address,
      // so a second put is a no-op rather than a duplicate.
      if (!(await opts.blobs.has(ref))) {
        await opts.blobs.put(ref, JSON.stringify({ payload, sources: meta?.sources ?? [] } satisfies StoredPayload));
      }
      return ref;
    },

    async playback(ref, ctx) {
      // Integrity BEFORE authorization, so a corrupt payload is reported as
      // corrupt to anyone entitled to know the observation exists — and
      // authorization before RETURNING anything, so an unauthorized reader
      // learns nothing either way.
      const stored = await load(ref);
      await authorized(ref, stored, ctx);
      return { ref, payload: stored.payload, historical: true, playedAt: now() };
    },

    async export(refs, ctx) {
      const out: Array<{ ref: string; payload: unknown }> = [];
      for (const ref of refs) {
        const stored = await load(ref);
        // Export is playback that leaves the machine, so it is authorized the
        // same way. Anything else would make export the way around playback.
        await authorized(ref, stored, ctx);
        out.push({ ref, payload: stored.payload });
      }
      return out;
    },

    async prune(refs) {
      const removed: string[] = [];
      const stillReferenced: Array<{ ref: string; dependents: string[] }> = [];
      for (const ref of refs) {
        const deps = opts.dependents?.(ref) ?? [];
        if (deps.length > 0) {
          stillReferenced.push({ ref, dependents: deps });
          continue;
        }
        await opts.blobs.remove(ref);
        removed.push(ref);
      }
      return { removed, stillReferenced };
    },
  };
}
