// Ported from obsidian-stewardship/tests/baseline-store.test.mjs (#83, cycle 1) —
// the per-note baseline blob store, now at src/kernel/governance/baseline-store.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BaselineStore } from "../src/kernel/governance/baseline-store.ts";
import { contentHash } from "../src/kernel/governance/hash.ts";
import { makeTmpFs } from "./governance-helpers.mjs";

test("baseline store round-trips through a fresh load", async () => {
  const { root, blobFs, cleanup } = await makeTmpFs();
  try {
    const dir = `${root}/baselines`;
    const store = new BaselineStore(blobFs, dir);
    await store.load();
    assert.equal(store.size, 0);

    const content = "---\ntitle: A\n---\nhello world";
    const saved = await store.setBaseline("Notes/A.md", content, "tester", "2026-08-09T00:00:00.000Z");
    assert.equal(saved.hash, contentHash(content));
    assert.equal(saved.acceptedBy, "tester");

    // Fresh store instance reading the same dir sees the persisted baseline.
    const store2 = new BaselineStore(blobFs, dir);
    await store2.load();
    assert.equal(store2.size, 1);
    const got = store2.get("Notes/A.md");
    assert.ok(got);
    assert.equal(got.content, content);
    assert.equal(got.hash, contentHash(content));
    assert.equal(got.acceptedAt, "2026-08-09T00:00:00.000Z");
    assert.equal(store2.has("Notes/A.md"), true);
    assert.equal(store2.has("Notes/missing.md"), false);
  } finally {
    await cleanup();
  }
});

test("setBaseline overwrites in place (advances, not appends)", async () => {
  const { root, blobFs, cleanup } = await makeTmpFs();
  try {
    const store = new BaselineStore(blobFs, `${root}/baselines`);
    await store.load();
    await store.setBaseline("A.md", "v1", "x");
    await store.setBaseline("A.md", "v2", "y");
    assert.equal(store.size, 1);
    assert.equal(store.get("A.md").content, "v2");
    assert.equal(store.get("A.md").acceptedBy, "y");
  } finally {
    await cleanup();
  }
});

// D3 — a partial/malformed baseline blob missing `content` must be rejected on load (treated
// as no-baseline), never surfaced as {content: undefined} that would wipe the note on revert.
test("load rejects a content-less baseline blob (treated as no-baseline)", async () => {
  const { root, blobFs, cleanup } = await makeTmpFs();
  try {
    const dir = `${root}/baselines`;
    // A good baseline and a malformed (content-less) one, written directly to the store dir.
    const good = new BaselineStore(blobFs, dir);
    await good.load();
    await good.setBaseline("Good.md", "real content", "x");

    // Hand-craft a content-less blob at a plausible store filename.
    const badPath = `${dir}/${contentHash("Bad.md")}.json`;
    await blobFs.write(badPath, JSON.stringify({ path: "Bad.md", hash: "h", acceptedBy: "x", acceptedAt: "t" }));

    const store2 = new BaselineStore(blobFs, dir);
    await store2.load();
    assert.equal(store2.has("Bad.md"), false, "content-less blob must not load");
    assert.equal(store2.get("Bad.md"), null);
    assert.equal(store2.has("Good.md"), true, "the valid baseline still loads");
    assert.equal(store2.get("Good.md").content, "real content");
  } finally {
    await cleanup();
  }
});

test("paths with slashes and spaces store safely", async () => {
  const { root, blobFs, cleanup } = await makeTmpFs();
  try {
    const store = new BaselineStore(blobFs, `${root}/baselines`);
    await store.load();
    const p = "Assent/Build/Review scratch note.md";
    await store.setBaseline(p, "body", "z");
    const store2 = new BaselineStore(blobFs, `${root}/baselines`);
    await store2.load();
    assert.equal(store2.get(p)?.content, "body");
  } finally {
    await cleanup();
  }
});
