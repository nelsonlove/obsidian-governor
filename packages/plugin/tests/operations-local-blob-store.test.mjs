/**
 * operations-local-blob-store.test.mjs — WP2, Gate 0.
 *
 * The one file in the observation stack that touches a filesystem.
 *
 * Two properties are worth more than the rest: payloads live OUTSIDE the vault
 * (so Obsidian Sync never carries note text a user never chose to sync), and
 * the store refuses to be addressed by anything that is not a digest — because
 * a blob directory addressed by caller-influenced strings is a path-traversal
 * surface, and sanitizing is how that becomes a subtle one rather than an
 * obvious one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { createLocalBlobStore, observationDir } from "../src/governance/observations/local-store.ts";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

/** An in-memory stand-in for `fs.promises`. */
function fakeFs() {
  const files = new Map();
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    files,
    async mkdir() {},
    async writeFile(p, data) {
      files.set(p, data);
    },
    async readFile(p) {
      if (!files.has(p)) throw enoent();
      return files.get(p);
    },
    async access(p) {
      if (!files.has(p)) throw enoent();
    },
    async unlink(p) {
      if (!files.has(p)) throw enoent();
      files.delete(p);
    },
    async readdir(p) {
      const prefix = `${p}${path.sep}`;
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
    async rename(from, to) {
      if (!files.has(from)) throw enoent();
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

const store = (fsImpl = fakeFs()) => ({ store: createLocalBlobStore({ vaultSlug: "my-vault", fsImpl }), fsImpl });

// ── where the bytes go ───────────────────────────────────────────────────────

describe("local blob store — location", () => {
  test("payloads live outside the vault, under the plugin's own state namespace", () => {
    const dir = observationDir("my-vault");
    assert.match(dir, /\.claude[\\/]governor[\\/]observations[\\/]my-vault$/);
    assert.ok(!dir.includes(".obsidian"), "never under .obsidian — Sync would carry note text nobody chose to sync");
  });

  test("two vaults never share a payload directory", () => {
    // A content digest alone would happily collide two vaults' identical notes,
    // and the authorization policy governing one is not the other's.
    assert.notEqual(observationDir("vault-a"), observationDir("vault-b"));
  });
});

// ── addressing ───────────────────────────────────────────────────────────────

describe("local blob store — only a digest may address it", () => {
  for (const bad of ["../escape", "sha256:short", "not-a-digest", "sha256:" + "A".repeat(64), "", "sha256:../../x"]) {
    test(`refuses '${bad || "(empty)"}'`, async () => {
      const { store: s } = store();
      await assert.rejects(() => s.get(bad), /not a sha256 digest/);
    });
  }

  test("a valid digest is accepted", async () => {
    const { store: s } = store();
    await s.put(A, "payload");
    assert.equal(await s.get(A), "payload");
  });

  test("the file is named for the digest, so the filename IS the checksum", async () => {
    const { store: s, fsImpl } = store();
    await s.put(A, "x");
    const names = [...fsImpl.files.keys()].map((p) => path.basename(p));
    assert.deepEqual(names, [`${"a".repeat(64)}.json`]);
  });
});

// ── durability ───────────────────────────────────────────────────────────────

describe("local blob store — a partial write never lands at a real digest", () => {
  test("writes go through a temp name and are renamed into place", async () => {
    const seen = [];
    const base = fakeFs();
    const spy = { ...base, async writeFile(p, d) { seen.push(p); return base.writeFile(p, d); } };
    const { store: s } = store(spy);
    await s.put(A, "x");
    assert.match(seen[0], /\.tmp-/, "the payload is written to a temp name first");
    assert.equal(await s.get(A), "x");
  });

  test("a failed rename leaves no stray temp file behind", async () => {
    const base = fakeFs();
    const failing = { ...base, async rename() { throw new Error("disk full"); } };
    const { store: s } = store(failing);
    await assert.rejects(() => s.put(A, "x"), /disk full/);
    assert.equal(base.files.size, 0, "the temp file is cleaned up rather than accumulating silently");
  });

  test("re-putting an existing payload is a no-op, not a rewrite", async () => {
    const base = fakeFs();
    let writes = 0;
    const counting = { ...base, async writeFile(p, d) { writes++; return base.writeFile(p, d); } };
    const { store: s } = store(counting);
    await s.put(A, "x");
    await s.put(A, "x");
    assert.equal(writes, 1);
  });
});

// ── absence versus failure ───────────────────────────────────────────────────

describe("local blob store — absence is not the same fact as failure", () => {
  test("a missing payload reads as null", async () => {
    const { store: s } = store();
    assert.equal(await s.get(A), null);
  });

  test("a PERMISSIONS error is NOT laundered into 'absent'", async () => {
    // A payload you cannot read is not a payload that was pruned, and the
    // layer above turns `null` into exactly that claim.
    const base = fakeFs();
    const denied = { ...base, async readFile() { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
    const { store: s } = store(denied);
    await assert.rejects(() => s.get(A), /EACCES/);
  });

  test("an absent directory lists as empty rather than throwing", async () => {
    const base = fakeFs();
    const noDir = { ...base, async readdir() { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } };
    const { store: s } = store(noDir);
    assert.deepEqual(await s.keys(), []);
  });

  test("keys only reports digest-named files, so a stray temp file is never a payload", async () => {
    const base = fakeFs();
    const { store: s } = store(base);
    await s.put(A, "x");
    await s.put(B, "y");
    base.files.set(path.join(observationDir("my-vault"), "leftover.tmp-1234"), "junk");
    assert.deepEqual((await s.keys()).sort(), [A, B].sort());
  });
});
