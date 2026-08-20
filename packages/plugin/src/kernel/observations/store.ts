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
//
// That sharing has one sharp edge, and it is worth stating plainly because the
// first draft got it wrong. Two DIFFERENT notes with identical content share an
// address — which is not exotic here, where "standard zeros" creates ten notes
// from one template. The first draft stored the first put's sources and made
// the second put a no-op, so replaying a payload captured from `Secrets/b.md`
// was authorized as if it had come from `Public/a.md`.
//
// Sources are therefore UNIONED across puts, and a reader must be authorized
// for EVERY source in the union. Over-restrictive by design: if a payload is
// shared by a public note and a private one, replaying it requires authority
// over both. Fail-closed is the only safe direction when the question is
// "whose content is this?" and the honest answer is "more than one note's".

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
  /** The one source being asked about. Authorization is asked about material
   * rather than about an opaque id, one source at a time, so a policy never has
   * to decide what an array of mixed-sensitivity paths means. */
  source: string;
  /** Every source this payload is known to have come from, for context. */
  allSources: string[];
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
   *
   * Called ONCE PER SOURCE, and every call must return true. A payload shared
   * by several notes carries all their provenance, and a reader entitled to
   * one of them is not thereby entitled to the rest.
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
    // EVERY source must be permitted. A payload shared by a public note and a
    // private one requires authority over both — see the header.
    //
    // A payload with no recorded sources is refused rather than waved through:
    // "we do not know where this came from" is not a reason to disclose it.
    if (stored.sources.length === 0) throw new PlaybackUnauthorizedError(ref);
    for (const source of stored.sources) {
      if (!opts.canRead({ reader: ctx.reader, ref, source, allSources: stored.sources })) {
        throw new PlaybackUnauthorizedError(ref);
      }
    }
  }

  return {
    async put(payload, meta) {
      const ref = payloadDigest(payload);
      const sources = meta?.sources ?? [];
      const existing = await opts.blobs.get(ref);
      if (existing === null) {
        await opts.blobs.put(ref, JSON.stringify({ payload, sources } satisfies StoredPayload));
        return ref;
      }
      // The payload is already stored — but its PROVENANCE may be new. A second
      // note with identical content contributes its own source, and dropping it
      // would authorize this payload against the wrong note's policy.
      let prior: StoredPayload;
      try {
        prior = JSON.parse(existing) as StoredPayload;
      } catch {
        throw new PayloadCorruptError(ref);
      }
      const union = [...new Set([...prior.sources, ...sources])].sort();
      if (union.length !== prior.sources.length) {
        await opts.blobs.put(ref, JSON.stringify({ payload: prior.payload, sources: union } satisfies StoredPayload));
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
