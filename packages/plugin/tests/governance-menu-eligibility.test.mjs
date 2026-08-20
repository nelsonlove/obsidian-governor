// computeAcceptEligiblePaths (kernel/governance/menu-eligibility.ts) — the pure set-union the
// right-click "Accept" context-menu item's eligibility check is built on. Pins that it matches
// the pane's own three Accept-bearing sections (pending / proposed / revising) exactly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeAcceptEligiblePaths } from "../src/kernel/governance/menu-eligibility.ts";

describe("computeAcceptEligiblePaths", () => {
  test("unions all three listings", () => {
    const out = computeAcceptEligiblePaths(
      [{ path: "Notes/Pending.md" }],
      [{ path: "Notes/Proposed.md" }],
      [{ path: "Notes/Revising.md" }],
    );
    assert.deepEqual(
      [...out].sort(),
      ["Notes/Pending.md", "Notes/Proposed.md", "Notes/Revising.md"],
    );
  });

  test("a path appearing in more than one listing is not duplicated (it's a Set)", () => {
    const out = computeAcceptEligiblePaths(
      [{ path: "Notes/Both.md" }],
      [{ path: "Notes/Both.md" }],
      [],
    );
    assert.deepEqual([...out], ["Notes/Both.md"]);
  });

  test("all three empty → empty set", () => {
    const out = computeAcceptEligiblePaths([], [], []);
    assert.equal(out.size, 0);
  });

  test("a path in none of the three is correctly absent", () => {
    const out = computeAcceptEligiblePaths(
      [{ path: "Notes/A.md" }],
      [{ path: "Notes/B.md" }],
      [{ path: "Notes/C.md" }],
    );
    assert.equal(out.has("Notes/Untouched.md"), false);
  });
});
