/**
 * governance-queue-invalidation.test.mjs — the PURE half of "a deleted note leaves the queue".
 *
 * The bug: `wireGovernance` registered vault `modify` and `rename` handlers but no `delete`, and
 * the live-refresh poll only recomputes when the vault-mcp write JOURNAL grows. A human deleting a
 * pending note in Obsidian writes no journal record, so the sidebar kept offering Accept on a file
 * that no longer existed until an unrelated agent write landed or the user clicked Refresh.
 *
 * The registration itself (registerEvent / instanceof TFile|TFolder / debounce timers) is not
 * headlessly testable and is verified by build + reasoning — the same split governance-live-mount
 * makes. What IS pure, and carries every edge case worth pinning, is the decision: does THIS
 * deletion invalidate the queue? That is `deleteInvalidatesQueue`, and this file is its contract.
 *
 * The invariant that matters most: this check may only ever NARROW work. A false negative
 * reinstates the stale-row bug, so every uncertain case must answer true.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deleteInvalidatesQueue } from "../src/governor/wiring/queue-invalidation.ts";

const QUEUE = [
  "Records/2026-08.md",
  "Notes/pending idea.md",
  "Projects/alpha/spec.md",
];

describe("deleteInvalidatesQueue — file deletes", () => {
  test("deleting a note that IS in the queue invalidates", () => {
    assert.equal(deleteInvalidatesQueue("Notes/pending idea.md", false, QUEUE), true);
  });

  test("deleting a note that is NOT in the queue does not (the common case stays free)", () => {
    assert.equal(deleteInvalidatesQueue("Notes/unrelated.md", false, QUEUE), false);
  });

  test("an empty queue is never invalidated by a file delete", () => {
    assert.equal(deleteInvalidatesQueue("Notes/pending idea.md", false, []), false);
  });

  test("a file whose path merely PREFIXES a pending path does not invalidate", () => {
    // "Records/2026-08" is a prefix of "Records/2026-08.md" as a string; it is not that note.
    assert.equal(deleteInvalidatesQueue("Records/2026-08", false, QUEUE), false);
  });
});

describe("deleteInvalidatesQueue — folder deletes", () => {
  test("deleting a folder CONTAINING a pending note invalidates", () => {
    assert.equal(deleteInvalidatesQueue("Notes", true, QUEUE), true);
  });

  test("deleting an ancestor folder invalidates (nested pending note)", () => {
    assert.equal(deleteInvalidatesQueue("Projects", true, QUEUE), true);
  });

  test("deleting an unrelated folder does not", () => {
    assert.equal(deleteInvalidatesQueue("Archive", true, QUEUE), false);
  });

  test("folder matching is at a SEGMENT boundary — 'Notes' must not match 'Notes archive/…'", () => {
    // The prefix trap the lock scopes document: string-prefix matching would fire here.
    assert.equal(deleteInvalidatesQueue("Notes", true, ["Notes archive/old.md"]), false);
  });

  test("a folder that only prefixes a SIBLING folder does not invalidate", () => {
    assert.equal(deleteInvalidatesQueue("Project", true, QUEUE), false);
  });

  test("the same path as a folder vs as a file decides differently", () => {
    const queue = ["Notes/x.md"];
    assert.equal(deleteInvalidatesQueue("Notes", true, queue), true, "folder contains it");
    assert.equal(deleteInvalidatesQueue("Notes", false, queue), false, "a FILE named Notes is not that note");
  });
});

describe("deleteInvalidatesQueue — normalization and fail-safe", () => {
  test("leading ./ and / and duplicate slashes compare equal", () => {
    for (const variant of ["./Notes/pending idea.md", "/Notes/pending idea.md", "Notes//pending idea.md"]) {
      assert.equal(deleteInvalidatesQueue(variant, false, QUEUE), true, variant);
    }
  });

  test("a pending path carrying the same noise still matches", () => {
    assert.equal(deleteInvalidatesQueue("Notes/x.md", false, ["./Notes/x.md"]), true);
  });

  test("a trailing slash on a deleted folder still matches its contents", () => {
    assert.equal(deleteInvalidatesQueue("Notes/", true, QUEUE), true);
  });

  test("the vault root (empty path) invalidates — uncertainty answers TRUE", () => {
    assert.equal(deleteInvalidatesQueue("", true, QUEUE), true);
    assert.equal(deleteInvalidatesQueue("   ", true, QUEUE), true);
  });

  test("case is NOT folded — two distinct pending paths must not collapse into one", () => {
    // APFS is case-insensitive, but Obsidian's paths are case-preserving and the queue is data:
    // folding here would let one delete silently claim to cover a different note.
    assert.equal(deleteInvalidatesQueue("notes/pending idea.md", false, QUEUE), false);
  });

  test("accepts any iterable of paths (the caller maps the cached queue)", () => {
    assert.equal(deleteInvalidatesQueue("Records/2026-08.md", false, new Set(QUEUE)), true);
  });
});
