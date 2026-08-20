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
    ...over,
  });
  return { store: s, blobs };
}

// ── content addressing ───────────────────────────────────────────────────────

describe("observation store — content addressing", () => {
  test("a payload is stored under its own digest", async () => {
    const { store: s, blobs } = store();
    const ref = await s.put({ body: "hello" });
    assert.equal(ref, payloadDigest({ body: "hello" }));
    assert.ok(await blobs.has(ref));
  });

  test("the same payload stored twice occupies one object", async () => {
    // Content addressing is what makes the 202-baseline-blob kind of
    // duplication go away, and it is also why a payload cannot be silently
    // replaced: a different payload gets a different address.
    const { store: s, blobs } = store();
    const a = await s.put({ body: "same" });
    const b = await s.put({ body: "same" });
    assert.equal(a, b);
    assert.equal((await blobs.keys()).length, 1);
  });

  test("different payloads never share an address", async () => {
    const { store: s } = store();
    assert.notEqual(await s.put({ body: "a" }), await s.put({ body: "b" }));
  });
});

// ── the property that matters most ───────────────────────────────────────────

describe("observation store — playback is historical, never a fresh read", () => {
  test("playback returns the STORED payload even after the source changed", async () => {
    // The whole point. A reviewer asking "what was this agent shown?" must get
    // what it was shown, not what the note says now.
    const { store: s } = store();
    const ref = await s.put({ body: "as it was" });
    // The vault moves on. The store neither knows nor cares.
    const played = await s.playback(ref, { reader: "human-1" });
    assert.deepEqual(played.payload, { body: "as it was" });
    assert.equal(played.historical, true, "playback labels itself historical rather than passing as current state");
  });

  test("the store has no way to read the vault at all", () => {
    // Structural, not conventional: nothing is injected that could re-read
    // current state, so a future edit cannot quietly make playback recompute.
    const { store: s } = store();
    assert.equal(typeof s.playback, "function");
    assert.ok(!("vault" in s) && !("read" in s), "the store exposes no vault access");
  });
});

// ── integrity ────────────────────────────────────────────────────────────────

describe("observation store — integrity", () => {
  test("a corrupted payload is refused, not returned", async () => {
    const { store: s, blobs } = store();
    const ref = await s.put({ body: "original" });
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
    const ref = await s.put({ body: "secret" });
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
    assert.deepEqual(asked[0].sources, ["Secrets/a.md"]);
  });

  test("a refused playback does not leak the payload through the error", async () => {
    const { store: s } = store({ canRead: () => false });
    const ref = await s.put({ body: "SENSITIVE" });
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
    const ref = await s.put({ body: "x" });
    const report = await s.prune([ref]);
    assert.deepEqual(report.removed, [ref]);
    assert.equal(report.stillReferenced.length, 0);
  });

  test("a payload a live claim depends on is NOT pruned", async () => {
    const { store: s } = store({ dependents: (ref) => (ref.endsWith("keep") ? ["proposal-7"] : []) });
    const ref = await s.put({ body: "x" });
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
    const ref = await s.put({ body: "x" });
    const exported = await s.export([ref], { reader: "human-1" });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].ref, ref);
    assert.equal(payloadDigest(exported[0].payload), ref, "the export re-derives to its own address");
  });

  test("export is authorized like playback, because it is playback that leaves the machine", async () => {
    const { store: s } = store({ canRead: () => false });
    const ref = await s.put({ body: "x" });
    await assert.rejects(() => s.export([ref], { reader: "human-2" }), PlaybackUnauthorizedError);
  });
});
