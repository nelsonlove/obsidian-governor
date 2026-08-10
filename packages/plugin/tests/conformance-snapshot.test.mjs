/**
 * conformance-snapshot.test.mjs — the headless vault reader.
 *
 * Walks a root, reads .md + .fileclass files, parses frontmatter (reusing
 * @vault-mcp/core's parseAllFrontmatter — no new dependency), and produces the
 * VaultSnapshot the packs consume. Vault-relative paths; excludedRoots honored
 * (the seam that keeps archaeology out of the rail, aligned with worker-3's B).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
      const snap = await buildSnapshot({ root });
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
      const snap = await buildSnapshot({ root, excludedRoots: ["Archaeology"] });
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
      const snap = await buildSnapshot({ root });
      assert.equal(snap.paths.some((p) => p.endsWith(".fileclass")), false, "paths (scheme listing) is .md only");
      assert.ok(snap.notes.some((n) => n.path.endsWith(".fileclass")), "notes (vocab listing) has .fileclass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
