// isAcceptEligible / selectAcceptEligible (kernel/governance/menu-eligibility.ts) — the rule
// behind the right-click "Accept" context-menu item. Pins that it matches the pane's own three
// Accept-bearing sections (pending / proposed / revising), that guarded territory is excluded,
// and that a multi-select is filtered down to exactly its eligible members (the mixed
// eligible/ineligible case the menu registration depends on).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAcceptEligible, selectAcceptEligible } from "../src/kernel/governance/menu-eligibility.ts";

/** A vault fake: pending queue, per-note acceptance-status, and one excluded root. */
function ctx({ pending = [], status = {}, excluded = ["80-89"] } = {}) {
  return {
    pendingPaths: new Set(pending),
    statusOf: (p) => status[p] ?? null,
    isExcluded: (p) => excluded.some((prefix) => p.startsWith(prefix)),
  };
}

describe("isAcceptEligible", () => {
  test("a note in the pending queue is eligible", () => {
    assert.equal(isAcceptEligible("Notes/Pending.md", ctx({ pending: ["Notes/Pending.md"] })), true);
  });

  test("acceptance-status: proposed is eligible", () => {
    assert.equal(
      isAcceptEligible("Notes/P.md", ctx({ status: { "Notes/P.md": "proposed" } })),
      true,
    );
  });

  test("acceptance-status: revising is eligible", () => {
    assert.equal(
      isAcceptEligible("Notes/R.md", ctx({ status: { "Notes/R.md": "revising" } })),
      true,
    );
  });

  test("an ungoverned note (no status, not pending) is NOT eligible", () => {
    assert.equal(isAcceptEligible("Notes/Plain.md", ctx()), false);
  });

  test("an already-accepted note is NOT eligible", () => {
    assert.equal(
      isAcceptEligible("Notes/A.md", ctx({ status: { "Notes/A.md": "accepted" } })),
      false,
    );
  });

  test("a non-string / unexpected status value is NOT eligible (the cache is untrusted data)", () => {
    assert.equal(isAcceptEligible("Notes/W.md", ctx({ status: { "Notes/W.md": ["proposed"] } })), false);
  });

  test("guarded territory is never eligible, whatever its status or queue membership says", () => {
    const c = ctx({ pending: ["80-89 Divorce/X.md"], status: { "80-89 Divorce/Y.md": "proposed" } });
    assert.equal(isAcceptEligible("80-89 Divorce/X.md", c), false);
    assert.equal(isAcceptEligible("80-89 Divorce/Y.md", c), false);
  });
});

describe("selectAcceptEligible", () => {
  test("a MIXED selection keeps only the eligible files, in the caller's order", () => {
    const c = ctx({
      pending: ["Notes/Pending.md"],
      status: { "Notes/Proposed.md": "proposed", "Notes/Accepted.md": "accepted" },
    });
    const selection = [
      { path: "Notes/Accepted.md" },
      { path: "Notes/Pending.md" },
      { path: "Notes/Plain.md" },
      { path: "Notes/Proposed.md" },
      { path: "80-89 Divorce/Guarded.md" },
    ];
    assert.deepEqual(
      selectAcceptEligible(selection, c).map((f) => f.path),
      ["Notes/Pending.md", "Notes/Proposed.md"],
    );
  });

  test("an ALL-INELIGIBLE selection returns empty (the menu item is then not added at all)", () => {
    const out = selectAcceptEligible(
      [{ path: "Notes/A.md" }, { path: "Notes/B.md" }],
      ctx({ status: { "Notes/A.md": "accepted" } }),
    );
    assert.deepEqual(out, []);
  });

  test("an empty selection returns empty", () => {
    assert.deepEqual(selectAcceptEligible([], ctx()), []);
  });

  test("it returns the caller's own objects (identity preserved — the caller needs its TFiles)", () => {
    const file = { path: "Notes/P.md", basename: "P" };
    const out = selectAcceptEligible([file], ctx({ status: { "Notes/P.md": "proposed" } }));
    assert.equal(out[0], file);
  });
});
