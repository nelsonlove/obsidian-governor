/**
 * conformance-snapshot.test.mjs — the headless vault reader.
 *
 * Walks a root, reads .md + .fileclass files, parses frontmatter (reusing
 * @vault-mcp/core's parseAllFrontmatter — no new dependency), and produces the
 * VaultSnapshot the packs consume. Vault-relative paths; excludedRoots honored
 * (the seam that keeps archaeology out of the rail, aligned with worker-3's B).
 *
 * `boundary: root` is passed on every legacy fixture call below because
 * buildSnapshot now refuses to walk without a declared boundary (#157) — see
 * the "territory guard" describe blocks at the bottom of this file for the
 * new coverage that motivated it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshot } from "../src/conformance/snapshot.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "conf-snap-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await mkdir(path.join(root, "Reg"), { recursive: true });
  await mkdir(path.join(root, "Archaeology"), { recursive: true });
  await writeFile(path.join(root, "Notes", "A.md"), "---\ntitle: A\ntags:\n  - rogue\n---\n\nbody A\n");
  await writeFile(path.join(root, "Reg", "Default.fileclass"), "---\n---\n");
  await writeFile(path.join(root, "Archaeology", "Old.md"), "---\ntitle: Old\n---\n\nold\n");
  return root;
}

describe("buildSnapshot", () => {
  test("reads .md + .fileclass under root into notes with vault-relative paths + parsed frontmatter", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root });
      const byPath = Object.fromEntries(snap.notes.map((n) => [n.path, n]));
      assert.ok(byPath["Notes/A.md"], "A.md present");
      assert.equal(byPath["Notes/A.md"].frontmatter.title, "A");
      assert.deepEqual(byPath["Notes/A.md"].frontmatter.tags, ["rogue"]);
      assert.ok(byPath["Notes/A.md"].body.includes("body A"));
      assert.ok(byPath["Reg/Default.fileclass"], ".fileclass included (vocab types)");
      assert.ok(snap.paths.includes("Notes/A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("excludedRoots drops a whole subtree (archaeology stays out of the rail)", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root, excludedRoots: ["Archaeology"] });
      assert.equal(snap.notes.some((n) => n.path.startsWith("Archaeology/")), false);
      assert.equal(snap.paths.some((p) => p.startsWith("Archaeology/")), false);
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"), "non-excluded notes still present");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("paths is markdown-only; notes includes .fileclass too", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root });
      assert.equal(snap.paths.some((p) => p.endsWith(".fileclass")), false, "paths (scheme listing) is .md only");
      assert.ok(snap.notes.some((n) => n.path.endsWith(".fileclass")), "notes (vocab listing) has .fileclass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildSnapshot CRLF", () => {
  test("a CRLF-authored note still parses frontmatter (not silently skipped)", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const p = (await import("node:path")).default;
    const { buildSnapshot } = await import("../src/conformance/snapshot.ts");
    const root = await mkdtemp(p.join(tmpdir(), "conf-crlf-"));
    try {
      await mkdir(p.join(root, "N"), { recursive: true });
      await writeFile(p.join(root, "N", "C.md"), "---\r\ntitle: C\r\ntags:\r\n  - rogue\r\n---\r\n\r\nbody\r\n");
      const snap = await buildSnapshot({ root, boundary: root });
      const note = snap.notes.find((n) => n.path === "N/C.md");
      assert.equal(note.frontmatter.title, "C");
      assert.deepEqual(note.frontmatter.tags, ["rogue"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * buildSnapshot territory guard — #157.
 *
 * Filed against a real breach: a corpus measurement commissioned for #143
 * read `~/obsidian-old` (12,072 notes, including 2,998 files under
 * `80-89 Divorce/`) to count frontmatter parse failures. Read-only, but the
 * standing rule is flat: never `~/obsidian-old`, never `80-89` legal
 * material, never anything under a hold. These tests never touch the real
 * `~/obsidian-old` — every case uses a disposable fixture standing in for it,
 * so pinning the regression cannot reproduce the breach it pins.
 */
describe("buildSnapshot territory guard (#157) — no declared boundary", () => {
  test("refuses rather than defaulting when no boundary is declared anywhere", async () => {
    const root = await fixture();
    const savedContent = process.env.ASSENT_CONTENT_ROOT;
    const savedVault = process.env.ASSENT_VAULT_ROOT;
    delete process.env.ASSENT_CONTENT_ROOT;
    delete process.env.ASSENT_VAULT_ROOT;
    try {
      await assert.rejects(() => buildSnapshot({ root }), /no content-root boundary declared/);
    } finally {
      if (savedContent !== undefined) process.env.ASSENT_CONTENT_ROOT = savedContent;
      if (savedVault !== undefined) process.env.ASSENT_VAULT_ROOT = savedVault;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ASSENT_CONTENT_ROOT alone is a sufficient declared boundary (no opts.boundary needed)", async () => {
    const root = await fixture();
    const savedContent = process.env.ASSENT_CONTENT_ROOT;
    const savedVault = process.env.ASSENT_VAULT_ROOT;
    delete process.env.ASSENT_VAULT_ROOT;
    process.env.ASSENT_CONTENT_ROOT = root;
    try {
      const snap = await buildSnapshot({ root });
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"));
    } finally {
      if (savedContent === undefined) delete process.env.ASSENT_CONTENT_ROOT;
      else process.env.ASSENT_CONTENT_ROOT = savedContent;
      if (savedVault !== undefined) process.env.ASSENT_VAULT_ROOT = savedVault;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildSnapshot territory guard (#157) — outside the declared boundary", () => {
  test("a legitimate root under the declared boundary still works", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root });
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a subdirectory of the declared boundary is permitted", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root: path.join(root, "Notes"), boundary: root });
      assert.ok(snap.notes.some((n) => n.path === "A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a plain sibling directory (lexically outside) is refused", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-"));
    try {
      const boundary = path.join(parent, "vault");
      const outside = path.join(parent, "vault-2"); // shares "vault" as a string PREFIX, not a path parent
      await mkdir(boundary, { recursive: true });
      await mkdir(outside, { recursive: true });
      await assert.rejects(
        () => buildSnapshot({ root: outside, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("'..' traversal out of the declared boundary is refused", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-dotdot-"));
    try {
      const boundary = path.join(parent, "vault");
      const outside = path.join(parent, "outside");
      await mkdir(boundary, { recursive: true });
      await mkdir(outside, { recursive: true });
      const escapee = path.join(boundary, "..", "outside");
      await assert.rejects(
        () => buildSnapshot({ root: escapee, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a trailing-slash variant of an outside sibling is still refused (not fooled by string prefix)", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-slash-"));
    try {
      const boundary = path.join(parent, "vault") + "/";
      const outside = path.join(parent, "vault-2") + "/";
      await mkdir(path.join(parent, "vault"), { recursive: true });
      await mkdir(path.join(parent, "vault-2"), { recursive: true });
      await assert.rejects(
        () => buildSnapshot({ root: outside, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a trailing-slash variant of the boundary itself still permits the same root", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root + "/" });
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlink inside the boundary pointing OUTSIDE it is refused (real path, not the link's location)", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-symlink-"));
    try {
      const boundary = path.join(parent, "vault");
      const secret = path.join(parent, "secret");
      await mkdir(boundary, { recursive: true });
      await mkdir(secret, { recursive: true });
      await writeFile(path.join(secret, "S.md"), "---\ntitle: S\n---\n\nsecret\n");
      const escapeLink = path.join(boundary, "escape");
      await symlink(secret, escapeLink);
      await assert.rejects(
        () => buildSnapshot({ root: escapeLink, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("buildSnapshot territory guard (#157) — deny-list overrides an explicit request", () => {
  test("REGRESSION: a walk rooted at a fixture standing in for ~/obsidian-old refuses, even inside a declared boundary", async () => {
    // Fixture, never the real ~/obsidian-old — reproducing the breach while
    // testing its fix would be exactly the mistake this issue exists to close.
    const homeStandIn = await mkdtemp(path.join(tmpdir(), "conf-homestandin-"));
    try {
      const oldVault = path.join(homeStandIn, "obsidian-old");
      const divorce = path.join(oldVault, "80-89 Divorce");
      await mkdir(divorce, { recursive: true });
      await writeFile(path.join(divorce, "D.md"), "---\ntitle: D\n---\n\nprivate\n");
      // The boundary EXPLICITLY includes the denied tree — proving the deny
      // list overrides an explicit request rather than merely a wide-open one.
      await assert.rejects(
        () => buildSnapshot({ root: oldVault, boundary: homeStandIn }),
        /permanently denied territory.*obsidian-old/i,
      );
    } finally {
      await rm(homeStandIn, { recursive: true, force: true });
    }
  });

  test("a '80-89*' segment is refused even when the boundary is set to permit it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-8089-"));
    try {
      const legal = path.join(root, "80-89 Divorce");
      await mkdir(legal, { recursive: true });
      await assert.rejects(
        () => buildSnapshot({ root: legal, boundary: root }),
        /permanently denied territory.*80-89/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a path segment containing 'hold' as a whole word is refused even when the boundary is set to permit it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-hold-"));
    try {
      const legalHold = path.join(root, "Legal Hold");
      await mkdir(legalHold, { recursive: true });
      await assert.rejects(
        () => buildSnapshot({ root: legalHold, boundary: root }),
        /permanently denied territory.*hold/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a directory that merely CONTAINS 'hold' as a substring (not a whole word) is NOT denied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-household-"));
    try {
      const benign = path.join(root, "Household budget");
      await mkdir(benign, { recursive: true });
      const snap = await buildSnapshot({ root: benign, boundary: root });
      assert.deepEqual(snap.notes, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
