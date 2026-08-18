/**
 * protected-properties-fs.test.ts — the declared-property perimeter (#224) on
 * the FILESYSTEM transport (fs-backend/vault.ts, the write primitive both
 * FilesystemBackend and packages/server's fs-failover route through).
 *
 * The per-transport sweep's fs leg: introduce / change / REMOVE of a declared
 * key refuse with the typed accept_forbidden error and NOTHING lands; a
 * byte-identical carry-forward still writes; the frontmatter-edit paths
 * (setFrontmatterField / deleteFrontmatterField) are covered as well as the
 * full-content ones (writeNote / appendNote / patchNote implicitly via
 * guardWrittenContent, which writeNote exercises here).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_PROTECTED_PROPERTIES,
  setDeclaredProtectedProperties,
} from "../src/accept-guard.js";

let tmpRoot: string;
let vault: typeof import("../src/fs-backend/vault.js");
const silent = () => {};

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "vault-protected-test-"));
  process.env.VAULT_PATH = tmpRoot; // must be set before the module import
  vault = await import("../src/fs-backend/vault.js");
});

beforeEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
  setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent);
});

after(async () => {
  setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent);
  await rm(tmpRoot, { recursive: true, force: true });
});

function isAcceptForbidden(e: unknown): boolean {
  return e instanceof Error && (e as { code?: string }).code === "accept_forbidden";
}

const POLICY_NOTE = "---\nauto-accept: appends\ntitle: T\n---\nbody\n";

async function seed(rel: string, content: string): Promise<void> {
  await writeFile(path.join(tmpRoot, rel), content, "utf8");
}
async function raw(rel: string): Promise<string> {
  return readFile(path.join(tmpRoot, rel), "utf8");
}

describe("fs transport — declared protected properties refuse on every write shape", () => {
  test("writeNote INTRODUCING auto-accept refuses; nothing lands", async () => {
    await assert.rejects(
      () => vault.writeNote("n.md", "---\nauto-accept: all\n---\nhi\n", false),
      isAcceptForbidden
    );
    await assert.rejects(() => raw("n.md")); // file was never created
  });

  test("writeNote CHANGING auto-accept refuses; disk unchanged", async () => {
    await seed("n.md", POLICY_NOTE);
    await assert.rejects(
      () => vault.writeNote("n.md", "---\nauto-accept: all\ntitle: T\n---\nbody\n", true),
      isAcceptForbidden
    );
    assert.equal(await raw("n.md"), POLICY_NOTE);
  });

  test("writeNote REMOVING auto-accept (omission on full rewrite) refuses; disk unchanged", async () => {
    await seed("n.md", POLICY_NOTE);
    await assert.rejects(
      () => vault.writeNote("n.md", "---\ntitle: T\n---\nbody\n", true),
      isAcceptForbidden
    );
    assert.equal(await raw("n.md"), POLICY_NOTE);
  });

  test("writeNote REMOVING the whole frontmatter refuses too (result has no fence at all)", async () => {
    await seed("n.md", POLICY_NOTE);
    await assert.rejects(() => vault.writeNote("n.md", "just a body\n", true), isAcceptForbidden);
    assert.equal(await raw("n.md"), POLICY_NOTE);
  });

  test("byte-identical carry-forward is ALLOWED (an ordinary edit on a policy note)", async () => {
    await seed("n.md", POLICY_NOTE);
    await vault.writeNote("n.md", "---\nauto-accept: appends\ntitle: T\n---\nnew body\n", true);
    assert.match(await raw("n.md"), /new body/);
  });

  test("appendNote to a policy note still works (frontmatter untouched)", async () => {
    await seed("n.md", POLICY_NOTE);
    await vault.appendNote("n.md", "appended\n");
    assert.match(await raw("n.md"), /appended/);
    assert.match(await raw("n.md"), /auto-accept: appends/);
  });

  test("setFrontmatterField introducing/changing auto-accept refuses; unrelated field edits pass", async () => {
    await seed("n.md", POLICY_NOTE);
    await assert.rejects(() => vault.setFrontmatterField("n.md", "auto-accept", "all"), isAcceptForbidden);
    await assert.rejects(() => vault.setFrontmatterField("n.md", "AUTO_ACCEPT", "all"), isAcceptForbidden);
    await vault.setFrontmatterField("n.md", "title", "U");
    assert.match(await raw("n.md"), /title: U/);
    assert.match(await raw("n.md"), /auto-accept: appends/);
  });

  test("deleteFrontmatterField on auto-accept refuses (removal is a mutation)", async () => {
    await seed("n.md", POLICY_NOTE);
    await assert.rejects(() => vault.deleteFrontmatterField("n.md", "auto-accept"), isAcceptForbidden);
    assert.match(await raw("n.md"), /auto-accept: appends/);
  });

  test("a second declared key (parametrized) enforces identically", async () => {
    setDeclaredProtectedProperties(
      [...DEFAULT_PROTECTED_PROPERTIES, { key: "review-tier", grade: "agent-forbidden" }],
      silent
    );
    await assert.rejects(
      () => vault.writeNote("m.md", "---\nreview-tier: 3\n---\nhi\n", false),
      isAcceptForbidden
    );
    await seed("m.md", "---\nreview-tier: 3\n---\nhi\n");
    await assert.rejects(() => vault.setFrontmatterField("m.md", "review-tier", "4"), isAcceptForbidden);
    await assert.rejects(() => vault.deleteFrontmatterField("m.md", "review-tier"), isAcceptForbidden);
    // carry-forward still fine
    await vault.writeNote("m.md", "---\nreview-tier: 3\n---\nnew\n", true);
    assert.match(await raw("m.md"), /new/);
  });

  test("with NO declared properties, all of the above writes pass (config-driven, floor untouched)", async () => {
    setDeclaredProtectedProperties([], silent);
    await vault.writeNote("n.md", "---\nauto-accept: all\n---\nhi\n", false);
    await vault.setFrontmatterField("n.md", "auto-accept", "appends");
    await vault.deleteFrontmatterField("n.md", "auto-accept");
    // ...but the accepted-family floor still refuses, unconditionally.
    await assert.rejects(
      () => vault.setFrontmatterField("n.md", "accepted-by", "me"),
      isAcceptForbidden
    );
  });
});
