/**
 * operations-observation-store.test.mjs — WP2, Gate 0.
 *
 * Where a replayable observation's bytes actually live, and what playback is
 * allowed to return.
 *
 * The single most important property here is negative: **playback returns the
 * stored historical payload, never a fresh read of current state.** A "replay"
 * that re-reads the vault would show a reviewer today's note while claiming to
 * show what the agent was given — which is worse than having no replay at all,
 * because it looks like evidence.
 *
 * The second is that playback is authorized by the CURRENT reviewer's
 * authority, not by the scope that applied when the observation was captured.
 * An observation made under a wide scope must not become a way to read material
 * the person looking at it today may not see.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createObservationStore,
  PayloadCorruptError,
  PayloadMissingError,
  PlaybackUnauthorizedError,
} from "../src/kernel/observations/store.ts";
import { payloadDigest } from "../src/kernel/observations/observation.ts";
import { createLocalBlobStore } from "../src/governance/observations/local-store.ts";

/** An in-memory content-addressed backing store. */
function fakeBlobs() {
  const blobs = new Map();
  return {
    blobs,
    async put(key, data) {
      blobs.set(key, data);
    },
    async get(key) {
      return blobs.has(key) ? blobs.get(key) : null;
    },
    async has(key) {
      return blobs.has(key);
    },
    async remove(key) {
      blobs.delete(key);
    },
    async keys() {
      return [...blobs.keys()];
    },
  };
}

function store(over = {}) {
  const blobs = fakeBlobs();
  const s = createObservationStore({
    blobs,
    now: () => 1_700_000_000_000,
    // Default: the reviewer may see everything. Individual tests narrow it.
    canRead: () => true,
    canReplay: () => true,
    ...over,
  });
  return { store: s, blobs };
}

// ── content addressing ───────────────────────────────────────────────────────

describe("observation store — content addressing", () => {
  test("a payload is stored under its own digest", async () => {
    const { store: s, blobs } = store();
    const ref = await s.put({ body: "hello" }, { sources: ["A.md"] });
    assert.equal(ref, payloadDigest({ body: "hello" }));
    assert.ok(await blobs.has(ref));
  });

  test("the same payload stored twice occupies one object", async () => {
    // Content addressing is what makes the 202-baseline-blob kind of
    // duplication go away, and it is also why a payload cannot be silently
    // replaced: a different payload gets a different address.
    const { store: s, blobs } = store();
    const a = await s.put({ body: "same" }, { sources: ["A.md"] });
    const b = await s.put({ body: "same" }, { sources: ["A.md"] });
    assert.equal(a, b);
    assert.equal((await blobs.keys()).length, 1);
  });

  test("different payloads never share an address", async () => {
    const { store: s } = store();
    assert.notEqual(await s.put({ body: "a" }, { sources: ["A.md"] }), await s.put({ body: "b" }, { sources: ["A.md"] }));
  });
});

// ── the property that matters most ───────────────────────────────────────────

describe("observation store — playback is historical, never a fresh read", () => {
  test("playback returns the STORED payload even after the source changed", async () => {
    // The whole point. A reviewer asking "what was this agent shown?" must get
    // what it was shown, not what the note says now.
    const { store: s } = store();
    const ref = await s.put({ body: "as it was" }, { sources: ["A.md"] });
    // The vault moves on. The store neither knows nor cares.
    const played = await s.playback(ref, { reader: "human-1" });
    assert.deepEqual(played.payload, { body: "as it was" });
    assert.equal(played.historical, true, "playback labels itself historical rather than passing as current state");
  });

  test("the store has no way to read the vault at all", () => {
    // Structural, not conventional: nothing is injected that could re-read
    // current state, so a future edit cannot quietly make playback recompute.
    const { store: s } = store();
    // The real guarantee is compile-time — `ObservationStoreOpts` admits a blob
    // interface, two predicates and a clock, and nothing that could read the
    // vault. What a runtime assertion CAN close is the surface: pinning the
    // exact method set means someone adding a `readCurrent` fails here rather
    // than quietly making playback recompute.
    // `totalBytes` reads the STORE's own disk usage for the capture size cap —
    // it takes no path and returns a number, so it widens nothing this pin
    // protects. It exists because the cap must bound the store across
    // connections, and only the store knows what is already on disk.
    assert.deepEqual(Object.keys(s).sort(), ["export", "playback", "prune", "put", "totalBytes"]);
  });
});

// ── integrity ────────────────────────────────────────────────────────────────

describe("observation store — integrity", () => {
  test("a corrupted payload is refused, not returned", async () => {
    const { store: s, blobs } = store();
    const ref = await s.put({ body: "original" }, { sources: ["A.md"] });
    await blobs.put(ref, JSON.stringify({ body: "tampered" }));
    await assert.rejects(() => s.playback(ref, { reader: "human-1" }), PayloadCorruptError);
  });

  test("a missing payload reports unavailable rather than empty", async () => {
    // "Absence is not emptiness." A pruned payload must read as gone, never as
    // an observation that returned nothing.
    const { store: s } = store();
    await assert.rejects(() => s.playback("sha256:nothing", { reader: "human-1" }), PayloadMissingError);
  });
});

// ── authorization is the reviewer's, now ─────────────────────────────────────

describe("observation store — playback authorization is current, not historical", () => {
  test("a reader who may not see the sources is refused", async () => {
    const { store: s } = store({ canRead: () => false });
    const ref = await s.put({ body: "secret" }, { sources: ["A.md"] });
    await assert.rejects(() => s.playback(ref, { reader: "human-2" }), PlaybackUnauthorizedError);
  });

  test("authorization is asked about the READER, not about the original capture scope", async () => {
    // An observation captured under a wide scope must not become a way to read
    // material the person looking at it today may not see.
    const asked = [];
    const { store: s } = store({
      canRead: (ctx) => {
        asked.push(ctx);
        return true;
      },
    });
    const ref = await s.put({ body: "x" }, { sources: ["Secrets/a.md"] });
    await s.playback(ref, { reader: "human-2" });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].reader, "human-2");
    assert.equal(asked[0].source, "Secrets/a.md");
  });

  test("a refused playback does not leak the payload through the error", async () => {
    const { store: s } = store({ canRead: () => false });
    const ref = await s.put({ body: "SENSITIVE" }, { sources: ["A.md"] });
    await s.playback(ref, { reader: "x" }).catch((e) => {
      assert.ok(!String(e.message).includes("SENSITIVE"));
    });
  });
});

// ── retention ────────────────────────────────────────────────────────────────

describe("observation store — retention and deletion", () => {
  test("deleting a payload reports what becomes unavailable", async () => {
    // Pruning evidence does not rewrite an authority claim; it makes the claim
    // locally unverifiable, and the user is told which.
    const { store: s } = store();
    const ref = await s.put({ body: "x" }, { sources: ["A.md"] });
    const report = await s.prune([ref]);
    assert.deepEqual(report.removed, [ref]);
    assert.equal(report.stillReferenced.length, 0);
  });

  test("a payload a live claim depends on is NOT pruned", async () => {
    const { store: s } = store({ dependents: (ref) => (ref.endsWith("keep") ? ["proposal-7"] : []) });
    const ref = await s.put({ body: "x" }, { sources: ["A.md"] });
    const report = await s.prune([ref, "sha256:keep"]);
    assert.deepEqual(report.removed, [ref]);
    assert.deepEqual(report.stillReferenced, [{ ref: "sha256:keep", dependents: ["proposal-7"] }]);
  });

  test("pruning is reported, never silent", async () => {
    const { store: s } = store();
    const report = await s.prune([]);
    assert.ok(Array.isArray(report.removed));
    assert.ok(Array.isArray(report.stillReferenced));
  });
});

// ── export ───────────────────────────────────────────────────────────────────

describe("observation store — export carries its own integrity", () => {
  test("an export includes the digest so a consumer can verify it independently", async () => {
    const { store: s } = store();
    const ref = await s.put({ body: "x" }, { sources: ["A.md"] });
    const exported = await s.export([ref], { reader: "human-1" });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].ref, ref);
    assert.equal(payloadDigest(exported[0].payload), ref, "the export re-derives to its own address");
  });

  test("export is authorized like playback, because it is playback that leaves the machine", async () => {
    const { store: s } = store({ canRead: () => false });
    const ref = await s.put({ body: "x" }, { sources: ["A.md"] });
    await assert.rejects(() => s.export([ref], { reader: "human-2" }), PlaybackUnauthorizedError);
  });
});

// ── the sharp edge of content addressing ─────────────────────────────────────

describe("observation store — a shared payload carries every source's provenance", () => {
  test("two DIFFERENT notes with identical content do not lose the second's source", async () => {
    // Not exotic here: "standard zeros" creates ten notes from one template.
    // The first draft made the second put a no-op, so a payload captured from
    // Secrets/b.md was authorized as if it had come from Public/a.md.
    const asked = [];
    const { store: s } = store({
      canRead: (ctx) => {
        asked.push(ctx.source);
        return true;
      },
    });
    const a = await s.put({ body: "# Template\n" }, { sources: ["Public/a.md"] });
    const b = await s.put({ body: "# Template\n" }, { sources: ["Secrets/b.md"] });
    assert.equal(a, b, "identical content still shares one object");
    await s.playback(b, { reader: "x" });
    assert.deepEqual(asked.sort(), ["Public/a.md", "Secrets/b.md"], "both notes' provenance is carried");
  });

  test("a reader entitled to ONE source is not thereby entitled to the payload", async () => {
    // Fail-closed by design. If a payload is shared by a public note and a
    // private one, replaying it requires authority over both — over-restrictive
    // rather than over-permissive, which is the only safe direction when the
    // honest answer to "whose content is this?" is "more than one note's".
    const { store: s } = store({ canRead: (ctx) => ctx.source.startsWith("Public/") });
    await s.put({ body: "shared" }, { sources: ["Public/a.md"] });
    const ref = await s.put({ body: "shared" }, { sources: ["Secrets/b.md"] });
    await assert.rejects(() => s.playback(ref, { reader: "x" }), PlaybackUnauthorizedError);
  });

  test("a payload with NO recorded source is refused, not waved through", async () => {
    // "We do not know where this came from" is not a reason to disclose it.
    const { store: s } = store();
    const ref = await s.put({ body: "orphan" });
    await assert.rejects(() => s.playback(ref, { reader: "x" }), PlaybackUnauthorizedError);
  });

  test("re-putting with an already-known source does not rewrite the object", async () => {
    const { store: s, blobs } = store();
    const ref = await s.put({ body: "x" }, { sources: ["A.md"] });
    const before = await blobs.get(ref);
    await s.put({ body: "x" }, { sources: ["A.md"] });
    assert.equal(await blobs.get(ref), before, "an unchanged source set is not a write");
  });
});

// ── the oracle the first draft left open ─────────────────────────────────────

describe("observation store — a reader with no replay authority learns nothing", () => {
  test("missing, corrupt and forbidden are INDISTINGUISHABLE to an ungated reader", async () => {
    // `ref` is a content digest, so without a coarse gate a caller could
    // compute digest(P) for content it merely suspects was captured and learn
    // whether it exists — with `canRead` never invoked. That is a confirmation
    // oracle over the whole store, callable by anyone.
    const { store: s, blobs } = store({ canReplay: () => false });
    const real = await store().store.put({ body: "x" }, { sources: ["A.md"] });
    void blobs;
    const errors = [];
    for (const ref of [real, "sha256:definitely-not-stored"]) {
      await s.playback(ref, { reader: "nobody" }).catch((e) => errors.push(e.constructor.name));
    }
    assert.deepEqual(errors, ["PlaybackUnauthorizedError", "PlaybackUnauthorizedError"]);
  });

  test("canRead is never even consulted for a reader who may replay nothing", async () => {
    let consulted = false;
    const { store: s } = store({
      canReplay: () => false,
      canRead: () => {
        consulted = true;
        return true;
      },
    });
    const ref = await store().store.put({ body: "x" }, { sources: ["A.md"] });
    await s.playback(ref, { reader: "nobody" }).catch(() => {});
    assert.equal(consulted, false, "the gate runs before the store is touched");
  });

  test("export is gated identically — it must not be the weaker door", async () => {
    const { store: s } = store({ canReplay: () => false });
    await assert.rejects(() => s.export(["sha256:anything"], { reader: "nobody" }), PlaybackUnauthorizedError);
  });

  test("an ENTITLED reader still gets the honest distinction", async () => {
    // The residual, and it is deliberate: closing this too would mean refusing
    // to report corruption to people entitled to know about it.
    const { store: s } = store();
    await assert.rejects(() => s.playback("sha256:not-stored", { reader: "human-1" }), PayloadMissingError);
  });
});

describe("observation store — pruning says what stops being verifiable", () => {
  test("a removed payload reports what it backed", async () => {
    // `dependents` gates removal, so by construction it is empty for everything
    // actually removed — which left the report unable to answer the question it
    // exists to answer.
    const { store: s } = store({ explains: (ref) => [`proposal-3 cited ${ref.slice(0, 12)}`] });
    const ref = await s.put({ body: "x" }, { sources: ["A.md"] });
    const report = await s.prune([ref]);
    assert.deepEqual(report.removed, [ref]);
    assert.equal(report.nowUnverifiable.length, 1);
    assert.match(report.nowUnverifiable[0].explanations[0], /proposal-3/);
  });

  test("a payload that backed nothing reports nothing, rather than an empty entry", async () => {
    const { store: s } = store();
    const ref = await s.put({ body: "x" }, { sources: ["A.md"] });
    const report = await s.prune([ref]);
    assert.deepEqual(report.nowUnverifiable, []);
  });
});

// ── the two layers, together ─────────────────────────────────────────────────

describe("observation store — over the REAL local adapter", () => {
  // The gap that let a critical bug land: every test above uses an in-memory
  // blob map, and every local-adapter test uses a fake payload. Neither
  // exercises the call pattern that actually matters — the same digest re-put
  // with different data, which is how a second note's provenance reaches disk.
  function localFs() {
    const files = new Map();
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return {
      files,
      async mkdir() {},
      async writeFile(p, d) { files.set(p, d); },
      async readFile(p) { if (!files.has(p)) throw enoent(); return files.get(p); },
      async access(p) { if (!files.has(p)) throw enoent(); },
      async unlink(p) { if (!files.has(p)) throw enoent(); files.delete(p); },
      async readdir() { return [...files.keys()]; },
      async rename(a, b) { files.set(b, files.get(a)); files.delete(a); },
    };
  }

  test("a second note's provenance reaches DISK, not just the in-memory layer", async () => {
    const s = createObservationStore({
      blobs: createLocalBlobStore({ vaultSlug: "v", fsImpl: localFs() }),
      canReplay: () => true,
      canRead: (ctx) => ctx.source.startsWith("Public/"),
    });
    await s.put({ body: "# Template\n" }, { sources: ["Public/a.md"] });
    const ref = await s.put({ body: "# Template\n" }, { sources: ["Secrets/b.md"] });
    // If the adapter had short-circuited on "the file already exists", the
    // second source would never have reached disk and this would REPLAY — a
    // reader entitled only to Public/ reading content captured from Secrets/.
    await assert.rejects(() => s.playback(ref, { reader: "x" }), PlaybackUnauthorizedError);
  });

  test("a round trip through the real adapter replays what was stored", async () => {
    const s = createObservationStore({
      blobs: createLocalBlobStore({ vaultSlug: "v", fsImpl: localFs() }),
      canReplay: () => true,
      canRead: () => true,
    });
    const ref = await s.put({ body: "as it was" }, { sources: ["A.md"] });
    const played = await s.playback(ref, { reader: "human-1" });
    assert.deepEqual(played.payload, { body: "as it was" });
  });
});
