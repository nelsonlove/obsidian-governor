import assert from "node:assert/strict";
import { test } from "node:test";
import { walk } from "../src/kernel/survey/walk.js";

function fakeFs(tree) {
  return (path) => {
    const entries = tree[path];
    if (!entries) throw new Error(`ENOENT: ${path}`);
    return entries;
  };
}

test("walk counts files and empty subdirectories as stubs, at depth 0", () => {
  const list = fakeFs({
    "/root": [
      { name: "a.md", isDirectory: false },
      { name: "b.md", isDirectory: false },
      { name: "sub", isDirectory: true },
    ],
  });
  const result = walk("/root", 0, list);
  // At depth 0 a subdirectory counts as one item (not descended into).
  assert.equal(result.items, 3);
  assert.equal(result.stubs, 0);
});

test("walk descends into subdirectories up to depth, counting an empty one as a stub", () => {
  const list = fakeFs({
    "/root": [
      { name: "a.md", isDirectory: false },
      { name: "sub", isDirectory: true },
    ],
    "/root/sub": [],
  });
  const result = walk("/root", 1, list);
  assert.equal(result.items, 1);
  assert.equal(result.stubs, 1);
});

test("walk skips dotfiles and dot-directories", () => {
  const list = fakeFs({
    "/root": [
      { name: ".DS_Store", isDirectory: false },
      { name: ".git", isDirectory: true },
      { name: "real.md", isDirectory: false },
    ],
  });
  const result = walk("/root", 1, list);
  assert.equal(result.items, 1);
});

test("walk treats an empty root as one stub, not zero items and zero stubs", () => {
  const list = fakeFs({ "/root": [] });
  const result = walk("/root", 2, list);
  assert.equal(result.items, 0);
  assert.equal(result.stubs, 1);
});

test("walk counts a listing failure on a subdirectory as a stub rather than throwing", () => {
  const list = fakeFs({
    "/root": [{ name: "broken", isDirectory: true }],
    // "/root/broken" deliberately absent — fakeFs throws for it.
  });
  const result = walk("/root", 1, list);
  assert.equal(result.stubs, 1);
});

test("walk reports the deepest level actually reached", () => {
  const list = fakeFs({
    "/root": [{ name: "a", isDirectory: true }],
    "/root/a": [{ name: "b", isDirectory: true }],
    "/root/a/b": [{ name: "leaf.md", isDirectory: false }],
  });
  const result = walk("/root", 5, list);
  assert.equal(result.depthReached, 2);
  assert.equal(result.items, 1);
});
