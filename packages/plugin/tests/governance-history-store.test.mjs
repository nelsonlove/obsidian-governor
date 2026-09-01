/**
 * governance-history-store.test.mjs — WP4, the local history repository.
 *
 * Two halves. The PURE half (scope, refs, recovery) is contract logic with no
 * I/O. The LIVE half drives the real isomorphic-git adapter against a
 * throwaway directory pair — an outside-"vault" gitdir and a plain-folder
 * worktree — because a Git adapter proven only against mocks proves nothing:
 * D08 promises standard Git object compatibility, and only real objects on a
 * real filesystem can witness it.
 *
 * The properties that matter most, in D10/D11/D06's own terms: history scope
 * is the human's and no connection can widen it; refs move ONLY by
 * compare-and-swap; a disappearance is a recorded fact, not an invented empty
 * file; corruption and absence are typed refusals, never empty results.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isTracked,
  boundaryDisclosure,
  effectiveScope,
  DEFAULT_HISTORY_EXCLUDES,
} from "../src/governor/kernel/history-store/history-scope.ts";
import { EXCLUDED_PREFIXES } from "../../core/src/territories.ts";
import { standingRef, proposalRef, cohortRef, isGovernorRef } from "../src/governor/kernel/history-store/refs.ts";
import {
  RefCasError,
  ObjectMissingError,
  ObjectCorruptError,
  RefNameError,
  isObjectId,
} from "../src/governor/kernel/history-store/types.ts";
import { openGitRepository, EMPTY_TREE_OID } from "../src/governor/wiring/history-store/git-repository.ts";
import { historyDir } from "../src/governor/wiring/history-store/local-data-root.ts";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// ── history scope — the human's policy, not the connection's ─────────────────

describe("history scope — whole-vault mode", () => {
  const scope = { mode: "whole-vault", include: [], exclude: [...DEFAULT_HISTORY_EXCLUDES, "80-89"] };

  test("ordinary content is tracked", () => {
    assert.ok(isTracked(scope, "Notes/A.md"));
    assert.ok(isTracked(scope, "deep/nested/tree/B.md"));
  });

  test("volatile machinery and the trash are excluded by default", () => {
    assert.ok(!isTracked(scope, ".obsidian/workspace.json"));
    assert.ok(!isTracked(scope, ".trash/deleted.md"));
  });

  test("an excluded private root is excluded with territory prefix semantics", () => {
    assert.ok(!isTracked(scope, "80-89 Divorce/evidence.md"), "bare '80-89' matches the JD area");
  });

  test("a path escaping the vault is never tracked", () => {
    assert.ok(!isTracked(scope, "../outside.md"));
    assert.ok(!isTracked(scope, "Notes/../../outside.md"));
    assert.ok(!isTracked(scope, "/absolute/path.md"));
  });

  test("normalization cannot be used to dodge an exclusion", () => {
    assert.ok(!isTracked(scope, "Notes/../80-89 Divorce/x.md"));
    assert.ok(!isTracked(scope, "./.trash/x.md"));
  });
});

describe("history scope — explicit mode", () => {
  const scope = { mode: "explicit", include: ["Notes", "Projects/"], exclude: ["Notes/private/"] };

  test("only included roots are tracked, exclusions win", () => {
    assert.ok(isTracked(scope, "Notes/A.md"));
    assert.ok(isTracked(scope, "Projects/p.md"));
    assert.ok(!isTracked(scope, "Elsewhere/x.md"));
    assert.ok(!isTracked(scope, "Notes/private/secret.md"));
  });

  test("an include is a folder root, never a loose prefix — over-matching would record MORE than chosen", () => {
    assert.ok(!isTracked(scope, "Notes2/x.md"));
    assert.ok(isTracked(scope, "Notes"), "the root itself matches");
  });

  test("boundary disclosure names both sides and flags the crossing", () => {
    const d = boundaryDisclosure(scope, ["Notes/in.md", "Elsewhere/out.md"]);
    assert.deepEqual(d.tracked, ["Notes/in.md"]);
    assert.deepEqual(d.untracked, ["Elsewhere/out.md"]);
    assert.ok(d.crossesBoundary);
    assert.ok(!boundaryDisclosure(scope, ["Notes/a.md", "Notes/b.md"]).crossesBoundary);
  });
});

describe("effective scope — the composition that makes the settings copy true", () => {
  // The settings UI promises "the defaults (.obsidian, .trash) and the
  // guarded territories are always excluded". This function is that promise:
  // consumers record through effectiveScope, never through the raw settings
  // shape — which, consumed as-is with the shipped default (whole-vault,
  // empty excludes), would track .obsidian and record guarded content.
  test("the SHIPPED default scope, composed, excludes machinery and territories", () => {
    const shippedDefault = { mode: "whole-vault", include: [], exclude: [] };
    const eff = effectiveScope(shippedDefault, EXCLUDED_PREFIXES);
    assert.ok(!isTracked(eff, ".obsidian/workspace.json"));
    assert.ok(!isTracked(eff, ".trash/x.md"));
    assert.ok(!isTracked(eff, "80-89 Divorce/evidence.md"));
    assert.ok(!isTracked(eff, "obsidian-old/anything.md"));
    assert.ok(isTracked(eff, "Notes/plain.md"), "ordinary content still tracked");
  });

  test("user exclusions survive composition and add to the floor", () => {
    const eff = effectiveScope({ mode: "whole-vault", include: [], exclude: ["Private/"] }, EXCLUDED_PREFIXES);
    assert.ok(!isTracked(eff, "Private/x.md"));
    assert.ok(!isTracked(eff, ".obsidian/x"));
  });

  test("roots are normalized — an exclude entered as ./Private or with backslashes still matches", () => {
    // Un-normalized roots silently under-exclude, the unsafe direction.
    const eff = effectiveScope(
      { mode: "whole-vault", include: [], exclude: ["./Private", "Other\\Sub"] },
      []
    );
    assert.ok(!isTracked(eff, "Private/x.md"));
    assert.ok(!isTracked(eff, "Other/Sub/x.md"));
  });

  test("roots that normalize away are dropped rather than matching everything", () => {
    const eff = effectiveScope({ mode: "explicit", include: ["."], exclude: [""] }, []);
    assert.ok(!isTracked(eff, "Notes/x.md"), "a '.' include does not become track-everything");
  });
});

// ── refs — one construction point, validated components ──────────────────────

describe("refs — the internal namespace", () => {
  test("names are built only here and live under refs/governor/", () => {
    assert.equal(standingRef(), "refs/governor/standing");
    assert.equal(proposalRef("0190-abc"), "refs/governor/proposals/0190-abc");
    assert.equal(cohortRef("c-1"), "refs/governor/cohorts/c-1");
    assert.ok(isGovernorRef(standingRef()));
    assert.ok(!isGovernorRef("refs/heads/main"));
  });

  test("an id that would traverse or corrupt the ref store is refused", () => {
    for (const evil of ["../escape", "a/b", "a..b", ".hidden", "", "a\0b", "a b"]) {
      assert.throws(() => proposalRef(evil), RefNameError, `should refuse '${evil}'`);
    }
  });

  test("case and git-reserved suffixes are refused — loose refs are files on a case-insensitive disk", () => {
    // On APFS, proposals/ABC and proposals/abc alias ONE loose-ref file, so
    // two ids differing only in case would share a ref. Lowercase-only pins
    // it. Trailing "." and ".lock" are git's own reserved forms; refusing
    // them here keeps the refusal typed instead of leaking the library's.
    for (const evil of ["ABC", "Abc", "a.", "a.lock"]) {
      assert.throws(() => proposalRef(evil), RefNameError, `should refuse '${evil}'`);
    }
    assert.equal(proposalRef("0190a1b2-dead-7000-8000-000000000001"), "refs/governor/proposals/0190a1b2-dead-7000-8000-000000000001");
  });
});

// ── the live adapter, against real files ─────────────────────────────────────

describe("git repository — the live adapter", () => {
  let root, gitdir, worktree, repo;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-history-"));
    gitdir = path.join(root, "outside-vault-gitdir");
    worktree = path.join(root, "vault");
    fs.mkdirSync(worktree, { recursive: true });
    repo = await openGitRepository({ gitdir, worktree });
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the git directory is OUTSIDE the worktree — nothing lands in the vault", async () => {
    await repo.writeBlob(enc("hello"));
    assert.ok(fs.existsSync(path.join(gitdir, "objects")), "objects under the outside gitdir");
    assert.ok(!fs.existsSync(path.join(worktree, ".git")), "no .git inside the vault");
  });

  test("blob round-trip is byte-exact", async () => {
    const oid = await repo.writeBlob(enc("exact bytes — café\n"));
    assert.ok(isObjectId(oid));
    assert.equal(dec(await repo.readBlob(oid)), "exact bytes — café\n");
  });

  test("a missing object is a typed refusal, not an empty result", async () => {
    await assert.rejects(() => repo.readBlob("0".repeat(40)), ObjectMissingError);
  });

  test("a corrupted loose object is a typed refusal naming corruption", async () => {
    const oid = await repo.writeBlob(enc("about to be mangled"));
    const loose = path.join(gitdir, "objects", oid.slice(0, 2), oid.slice(2));
    fs.writeFileSync(loose, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await assert.rejects(
      () => repo.readBlob(oid),
      (e) => e instanceof ObjectCorruptError || e instanceof ObjectMissingError,
      "mangled bytes must refuse with a typed error"
    );
  });

  test("tree and commit round-trip; commits carry the injected timestamp and fixed identity", async () => {
    const blob = await repo.writeBlob(enc("body"));
    const tree = await repo.writeTree([{ mode: "100644", path: "A.md", oid: blob, type: "blob" }]);
    const commit = await repo.writeCommit({ message: "first\n", tree, parents: [], timestamp: 1_700_000_000 });
    const read = await repo.readCommit(commit);
    assert.equal(read.tree, tree);
    assert.equal(read.timestamp, 1_700_000_000);
    assert.deepEqual(read.parents, []);
  });

  test("refs move ONLY by compare-and-swap; a stale writer gets a typed conflict", async () => {
    const blob = await repo.writeBlob(enc("x"));
    const tree = await repo.writeTree([{ mode: "100644", path: "X.md", oid: blob, type: "blob" }]);
    const c1 = await repo.writeCommit({ message: "c1\n", tree, parents: [], timestamp: 1 });
    const c2 = await repo.writeCommit({ message: "c2\n", tree, parents: [c1], timestamp: 2 });

    const ref = proposalRef("cas-test");
    assert.equal(await repo.resolveRef(ref), null);
    await repo.casRef(ref, null, c1);
    assert.equal(await repo.resolveRef(ref), c1);

    // create-if-absent against an existing ref refuses
    await assert.rejects(() => repo.casRef(ref, null, c2), RefCasError);
    // stale expectation refuses and does NOT move the ref
    await repo.casRef(ref, c1, c2);
    await assert.rejects(() => repo.casRef(ref, c1, c1), RefCasError);
    assert.equal(await repo.resolveRef(ref), c2, "the failed CAS moved nothing");
  });

  test("concurrent CAS from one instance serializes — exactly one winner", async () => {
    const blob = await repo.writeBlob(enc("race"));
    const tree = await repo.writeTree([{ mode: "100644", path: "R.md", oid: blob, type: "blob" }]);
    const c1 = await repo.writeCommit({ message: "r1\n", tree, parents: [], timestamp: 3 });
    const c2 = await repo.writeCommit({ message: "r2\n", tree, parents: [], timestamp: 4 });
    const ref = proposalRef("race-test");
    const results = await Promise.allSettled([repo.casRef(ref, null, c1), repo.casRef(ref, null, c2)]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(wins, 1, "exactly one create-if-absent wins");
    const finalValue = await repo.resolveRef(ref);
    assert.ok([c1, c2].includes(finalValue));
  });

  test("diffTrees is path-granular and handles the null (empty) tree", async () => {
    const b1 = await repo.writeBlob(enc("one"));
    const b2 = await repo.writeBlob(enc("two"));
    const t1 = await repo.writeTree([{ mode: "100644", path: "A.md", oid: b1, type: "blob" }]);
    const t2 = await repo.writeTree([
      { mode: "100644", path: "A.md", oid: b2, type: "blob" },
      { mode: "100644", path: "B.md", oid: b1, type: "blob" },
    ]);
    const diff = await repo.diffTrees(t1, t2);
    assert.deepEqual(
      diff.map((d) => d.path).sort(),
      ["A.md", "B.md"]
    );
    const fromEmpty = await repo.diffTrees(null, t1);
    assert.deepEqual(fromEmpty, [{ path: "A.md", before: null, after: b1 }]);
  });

  test("recordSnapshot: visible working-tree bytes land as standard objects; missing files are recorded facts", async () => {
    const ref = proposalRef("snap-1");
    const first = await repo.recordSnapshot({
      ref,
      files: [
        { path: "Notes/A.md", bytes: enc("proposed body\n") },
        { path: "Notes/deep/B.md", bytes: enc("nested\n") },
      ],
      message: "proposal snapshot 1",
      timestamp: 100,
      expectedRef: null,
    });
    assert.equal(await repo.resolveRef(ref), first.oid);

    // The note vanished before the second snapshot (D06): recorded as a fact.
    const second = await repo.recordSnapshot({
      ref,
      files: [
        { path: "Notes/A.md", bytes: enc("edited body\n") },
        { path: "Notes/deep/B.md", bytes: null },
      ],
      message: "proposal snapshot 2",
      timestamp: 200,
      expectedRef: first.oid,
    });
    assert.match(second.message, /missing: Notes\/deep\/B\.md/);
    assert.deepEqual(second.parents, [first.oid]);

    // Restoration with different bytes is a NEW subject — a new blob, a new
    // tree, never a revival of the old object identity.
    const diff = await repo.diffTrees(first.tree, second.tree);
    const paths = diff.map((d) => d.path).sort();
    assert.deepEqual(paths, ["Notes/A.md", "Notes/deep/B.md"]);

    // Log reads back newest-first through the ref.
    const log = await repo.log(ref, 10);
    assert.deepEqual(log.map((c) => c.message.split("\n")[0]), ["proposal snapshot 2", "proposal snapshot 1"]);
  });

  test("a stale snapshot expectation refuses and records nothing on the ref", async () => {
    const ref = proposalRef("snap-2");
    const first = await repo.recordSnapshot({
      ref,
      files: [{ path: "A.md", bytes: enc("v1") }],
      message: "one",
      timestamp: 1,
      expectedRef: null,
    });
    await assert.rejects(
      () =>
        repo.recordSnapshot({
          ref,
          files: [{ path: "A.md", bytes: enc("v2") }],
          message: "stale",
          timestamp: 2,
          expectedRef: null, // stale: the ref exists now
        }),
      RefCasError
    );
    assert.equal(await repo.resolveRef(ref), first.oid, "the ref did not move");
  });

  test("EMPTY_TREE_OID is the real git empty tree", async () => {
    assert.equal(EMPTY_TREE_OID, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  test("pathological snapshot paths are refused — they write trees stock git rejects", async () => {
    // Empirically (review finding): "a//b", "a/", "" produce empty-filename
    // tree entries git fsck calls unparsable, and "../x" writes a literal
    // ".." entry — a traversal primitive for any future materializer.
    const ref = proposalRef("path-validation");
    for (const evil of ["a/", "", "/abs.md", "../evil.md", "..", "."]) {
      await assert.rejects(
        () => repo.recordSnapshot({ ref, files: [{ path: evil, bytes: enc("x") }], message: "m", timestamp: 1, expectedRef: null }),
        (e) => !(e instanceof RefCasError),
        `should refuse path '${evil}'`
      );
    }
    assert.equal(await repo.resolveRef(ref), null, "nothing was recorded");
  });

  test("duplicate snapshot paths (after normalization) are refused, not last-wins", async () => {
    const ref = proposalRef("dup-validation");
    await assert.rejects(() =>
      repo.recordSnapshot({
        ref,
        files: [
          { path: "Notes/A.md", bytes: enc("one") },
          { path: "./Notes/A.md", bytes: enc("two") },
        ],
        message: "m",
        timestamp: 1,
        expectedRef: null,
      })
    );
  });

  test("a normalizable path is accepted in its normalized form", async () => {
    const ref = proposalRef("norm-accept");
    const c = await repo.recordSnapshot({
      ref,
      files: [
        { path: "./Notes/./Clean.md", bytes: enc("ok") },
        // Doubled separators collapse in normalization — the tree gets the
        // clean form, never the empty-filename entry fsck rejects.
        { path: "Notes//Collapsed.md", bytes: enc("ok2") },
      ],
      message: "m",
      timestamp: 1,
      expectedRef: null,
    });
    const diff = await repo.diffTrees(null, c.tree);
    assert.deepEqual(diff.map((d) => d.path).sort(), ["Notes/Clean.md", "Notes/Collapsed.md"]);
  });
});

// ── the data root ────────────────────────────────────────────────────────────

describe("local data root", () => {
  test("the history dir lives under the state namespace, outside any vault", () => {
    const dir = historyDir("my-vault");
    assert.match(dir, /\.claude[/\\]governor[/\\]history[/\\]my-vault$/);
  });

  test("an unusable slug is refused rather than path-joined", () => {
    assert.throws(() => historyDir("../escape"));
    assert.throws(() => historyDir(""));
  });

  test("a vault NAME (not slug) is slugged first", () => {
    assert.match(historyDir("My Vault!"), /history[/\\]my-vault$/);
  });
});
