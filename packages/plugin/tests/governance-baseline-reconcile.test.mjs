/**
 * governance-baseline-reconcile.test.mjs — baselines follow their note.
 *
 * The defect: a baseline is keyed by `contentHash(path)`, and a path is a LOCATION, not
 * an identity. Rename or move a note and its acceptance is silently orphaned — the note
 * reads as never-accepted with no error anywhere. Measured on the real vault: 158 of 273
 * baselines had drifted.
 *
 * Two halves, both pinned here: `BaselineStore.rekey` (the primitive, exercised against a
 * fake BlobFs) and `planBaselineReconcile` (the pure decision, which is where every edge
 * case lives). The Obsidian wiring — the `vault.on("rename")` registration and the
 * startup pass — is verified by build + reasoning, the same split governance-live-mount
 * makes.
 *
 * The invariant that matters most, and the reason repointing is legitimate at all: a
 * rekey is a RE-ADDRESSING, never an acceptance. `content`, `hash`, `acceptedAt` and
 * `acceptedBy` must survive it byte-for-byte — if they didn't, this machinery would be
 * forging acceptances nobody gave.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BaselineStore } from "../src/kernel/governance/baseline-store.ts";
import {
  planBaselineReconcile,
  uidOfContent,
  summarizePlan,
} from "../src/kernel/governance/baseline-reconcile.ts";
import { contentHash } from "../src/kernel/governance/hash.ts";

/** In-memory BlobFs. */
function fakeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async read(p) { if (!files.has(p)) throw new Error("ENOENT " + p); return files.get(p); },
    async write(p, d) { files.set(p, d); },
    async exists(p) { return files.has(p) || p === "base"; },
    async mkdir() {},
    async list(dir) { return [...files.keys()].filter((k) => k.startsWith(dir + "/")); },
    async remove(p) { files.delete(p); },
  };
}
const noteWithUid = (uid, extra = "") => `---\nuid: ${uid}\n${extra}---\n\n# note\n`;

async function storeWith(baselines) {
  const seed = {};
  for (const b of baselines) seed[`base/${contentHash(b.path)}.json`] = JSON.stringify(b);
  const fs = fakeFs(seed);
  const store = new BaselineStore(fs, "base");
  await store.load();
  return { store, fs };
}

describe("BaselineStore.rekey — re-addressing, not acceptance", () => {
  const b = {
    path: "Old/place.md", content: noteWithUid("uid-1"), hash: "h1",
    acceptedAt: "2026-08-01T00:00:00.000Z", acceptedBy: "local-human",
  };

  test("moves the baseline to the new path", async () => {
    const { store } = await storeWith([b]);
    assert.equal(await store.rekey("Old/place.md", "New/place.md"), "moved");
    assert.equal(store.has("Old/place.md"), false);
    assert.equal(store.get("New/place.md").path, "New/place.md");
  });

  test("preserves the acceptance VERBATIM — the load-bearing invariant", async () => {
    const { store } = await storeWith([b]);
    await store.rekey("Old/place.md", "New/place.md");
    const moved = store.get("New/place.md");
    assert.equal(moved.content, b.content, "content must not change");
    assert.equal(moved.hash, b.hash, "content hash must not be recomputed");
    assert.equal(moved.acceptedAt, b.acceptedAt, "a rekey must never restamp the time");
    assert.equal(moved.acceptedBy, b.acceptedBy, "a rekey must never restamp the actor");
  });

  test("writes the blob under the NEW path hash and drops the old file", async () => {
    const { store, fs } = await storeWith([b]);
    await store.rekey("Old/place.md", "New/place.md");
    assert.ok(fs.files.has(`base/${contentHash("New/place.md")}.json`), "new blob written");
    assert.equal(fs.files.has(`base/${contentHash("Old/place.md")}.json`), false, "old blob removed");
  });

  test("refuses when the destination already has a baseline — a live acceptance outranks a stale one", async () => {
    const other = { ...b, path: "New/place.md", acceptedAt: "2026-08-19T00:00:00.000Z", hash: "h2" };
    const { store } = await storeWith([b, other]);
    assert.equal(await store.rekey("Old/place.md", "New/place.md"), "target-exists");
    assert.equal(store.get("New/place.md").hash, "h2", "the newer baseline survives untouched");
    assert.equal(store.has("Old/place.md"), true, "and the orphan is left for a human");
  });

  test("no baseline at the source is a quiet no-op", async () => {
    const { store } = await storeWith([]);
    assert.equal(await store.rekey("Nope.md", "Also nope.md"), "no-baseline");
  });

  test("a failing remove still leaves the move applied", async () => {
    const { store, fs } = await storeWith([b]);
    fs.remove = async () => { throw new Error("adapter refused"); };
    assert.equal(await store.rekey("Old/place.md", "New/place.md"), "moved");
    assert.equal(store.get("New/place.md").path, "New/place.md");
  });
});

describe("uidOfContent", () => {
  test("reads the uid out of stored frontmatter", () => {
    assert.equal(uidOfContent(noteWithUid("01a0-abc")), "01a0-abc");
  });
  test("tolerates quotes", () => {
    assert.equal(uidOfContent('---\nuid: "01a0-abc"\n---\n'), "01a0-abc");
  });
  test("no frontmatter, no uid, empty uid → null", () => {
    assert.equal(uidOfContent("# just a body\n"), null);
    assert.equal(uidOfContent("---\nname: x\n---\n"), null);
    assert.equal(uidOfContent("---\nuid:\n---\n"), null);
  });
  test("does not read a uid out of the BODY", () => {
    assert.equal(uidOfContent("---\nname: x\n---\n\nuid: not-frontmatter\n"), null);
  });
});

describe("planBaselineReconcile", () => {
  const base = (path, uid, acceptedAt = "2026-08-01T00:00:00.000Z") => ({
    path, content: noteWithUid(uid), hash: "h", acceptedAt, acceptedBy: "local-human",
  });
  const plan = (baselines, live, existing = []) =>
    planBaselineReconcile({
      baselines,
      noteExists: (p) => Object.values(live).flat().includes(p) && !baselines.some((b) => b.path === p && !Object.values(live).flat().includes(p)),
      pathsForUid: (uid) => live[uid] ?? [],
      hasBaseline: (p) => existing.includes(p),
    });

  test("a moved note is repointed by uid", () => {
    const p = plan([base("Old/a.md", "u1")], { u1: ["New/a.md"] });
    assert.equal(p.repoint.length, 1);
    assert.deepEqual(
      { from: p.repoint[0].from, to: p.repoint[0].to, uid: p.repoint[0].uid },
      { from: "Old/a.md", to: "New/a.md", uid: "u1" }
    );
  });

  test("a RENAMED note is repointed — the case basename matching cannot follow", () => {
    // The real one: "10 10 experience.md" became "TRMNL.md". No shared basename at all.
    const p = plan([base("Links/10 10 experience.md", "u1")], { u1: ["Links/TRMNL.md"] });
    assert.equal(p.repoint[0].to, "Links/TRMNL.md");
  });

  test("a baseline whose note is still in place is untouched", () => {
    const p = plan([base("Here/a.md", "u1")], { u1: ["Here/a.md"] });
    assert.deepEqual(p, { repoint: [], unresolved: [] });
  });

  test("no uid in the stored content → left alone, reason recorded", () => {
    const b = { path: "Old/a.md", content: "# no frontmatter\n", hash: "h", acceptedAt: "", acceptedBy: "x" };
    const p = plan([b], {});
    assert.deepEqual(p.unresolved, [{ path: "Old/a.md", reason: "no-uid" }]);
    assert.equal(p.repoint.length, 0);
  });

  test("uid matches nothing live → left alone, never deleted", () => {
    const p = plan([base("Gone/a.md", "u1")], {});
    assert.deepEqual(p.unresolved, [{ path: "Gone/a.md", reason: "uid-not-found" }]);
  });

  test("duplicated uid → ambiguous, never a guess", () => {
    const p = plan([base("Old/a.md", "u1")], { u1: ["A.md", "B.md"] });
    assert.equal(p.unresolved[0].reason, "uid-ambiguous");
    assert.equal(p.repoint.length, 0);
  });

  test("destination already has a baseline → refused, target reported", () => {
    const p = plan([base("Old/a.md", "u1")], { u1: ["New/a.md"] }, ["New/a.md"]);
    assert.deepEqual(p.unresolved, [{ path: "Old/a.md", reason: "target-has-baseline", target: "New/a.md" }]);
  });

  test("two drifted baselines onto one note: newest acceptance wins, loser reported", () => {
    // Real case: three old notes had collapsed into 00.12 Scripts.md.
    const older = base("Old/a.md", "u1", "2026-08-01T00:00:00.000Z");
    const newer = base("Old/b.md", "u1", "2026-08-18T00:00:00.000Z");
    const p = plan([older, newer], { u1: ["Merged.md"] });
    assert.equal(p.repoint.length, 1);
    assert.equal(p.repoint[0].from, "Old/b.md", "the more recent acceptance is the one kept");
    assert.deepEqual(p.unresolved, [{ path: "Old/a.md", reason: "superseded", target: "Merged.md" }]);
  });

  test("the plan is deterministic for the same store", () => {
    const bs = [base("Old/z.md", "u2"), base("Old/a.md", "u1")];
    const live = { u1: ["New/a.md"], u2: ["New/z.md"] };
    assert.deepEqual(plan(bs, live).repoint.map((r) => r.to), plan([...bs].reverse(), live).repoint.map((r) => r.to));
  });

  test("NOTHING is ever planned for deletion — repair is additive", () => {
    const p = plan(
      [base("Gone/a.md", "u1"), base("Old/b.md", "u2")],
      { u2: ["New/b.md"] }
    );
    assert.equal(Object.keys(p).sort().join(","), "repoint,unresolved", "no delete/prune channel exists");
    assert.ok(p.unresolved.some((u) => u.reason === "uid-not-found"), "a vanished note is REPORTED, not pruned");
  });

  test("summary is legible for the console", () => {
    const p = plan([base("Old/a.md", "u1"), base("Gone/b.md", "u9")], { u1: ["New/a.md"] });
    assert.match(summarizePlan(p), /1 repointed/);
    assert.match(summarizePlan(p), /uid-not-found: 1/);
  });
});
