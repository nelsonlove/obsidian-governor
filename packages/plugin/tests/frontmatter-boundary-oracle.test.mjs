/**
 * frontmatter-boundary-oracle.test.mjs — pins `leadingFrontmatterBlock` against
 * an INDEPENDENT ORACLE: a golden table of what the vault does and does not
 * honor as leading frontmatter.
 *
 * Why this file exists, and why the parity suite is not enough. The security
 * review of #129 made the point exactly: `accept-fence-parity.test.mjs` asserts
 * *write path honors ⟹ guard refuses*, but both sides now call the SAME
 * recognizer — so any loosening of that recognizer moves both sides together
 * and parity stays green while the guard silently drifts away from the vault.
 * Demonstrated: relaxing the anchor to `^[ \t]*---` leaves the entire parity
 * suite passing while this file fails.
 *
 * Be precise about what that loosening actually costs, because the imprecise
 * version ("it reopens #126") is wrong and was corrected in review: with a
 * shared recognizer, a guard that recognizes MORE is not the #126 bypass —
 * #126 was the guard recognizing LESS than the write path. The hazard of
 * over-recognition runs the other way: the write path starts honoring
 * frontmatter the vault does not, and that reaches the accept guard through
 * `acceptTransitionReason`'s preserve-unchanged allowance, where a fabricated
 * "before" can make an introduce look like a carry-forward. Different
 * mechanism, same reason to pin the recognizer to reality rather than to
 * itself.
 *
 * Parity pins the two implementations to EACH OTHER. This file pins the shared
 * implementation to REALITY. Both are needed; neither substitutes.
 *
 * Each row is an assertion about Obsidian's behavior, with the reason stated.
 * A change to the recognizer that flips any row fails here — which is the
 * point: the table is the spec, the regex is the implementation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { leadingFrontmatterBlock } from "@vault-mcp/core";

const BOM = "\uFEFF";

/** [name, input, expected block or null, why]. */
const ORACLE = [
  // ── honored ───────────────────────────────────────────────────────────────
  ["plain fence", "---\na: 1\n---\nbody", "a: 1", "the ordinary case"],
  ["CRLF fence", "---\r\na: 1\r\n---\r\nbody", "a: 1", "Obsidian accepts CRLF documents"],
  ["BOM before the fence", `${BOM}---\na: 1\n---\nbody`, "a: 1", "#126 — the parser looks past a BOM"],
  ["trailing spaces on fences", "--- \na: 1\n--- \nbody", "a: 1", "trailing whitespace on the fence line is tolerated"],
  ["tab after the fence", "---\t\na: 1\n---\nbody", "a: 1", "same, with a tab"],
  ["terminated at EOF", "---\na: 1\n---", "a: 1", "a note that is only frontmatter"],
  ["empty block", "---\n\n---\nbody", "", "an empty fence is still a fence"],
  ["multi-line block", "---\na: 1\nb: 2\n---\nbody", "a: 1\nb: 2", "several keys"],
  ["lone CR inside the block", "---\na:\rb\n---\nbody", "a:\rb", "a CR inside a scalar is CONTENT, not a line break — the byte the guard used to fold away"],
  ["--- inside the block body", "---\na: 1\n---\nbody\n---\nmore", "a: 1", "the FIRST closing fence ends it"],

  // ── NOT honored (the rows a loosening would break) ────────────────────────
  ["space before the fence", " ---\na: 1\n---\nbody", null, "frontmatter must start at byte 0 — this is the row that fails if the anchor is relaxed to ^[ \\t]*---"],
  ["tab before the fence", "\t---\na: 1\n---\nbody", null, "same"],
  ["blank line before the fence", "\n---\na: 1\n---\nbody", null, "a leading newline means the note starts with a blank line, not frontmatter"],
  ["double BOM", `${BOM}${BOM}---\na: 1\n---\nbody`, null, "one mark is transparent; a second is content"],
  ["four dashes", "----\na: 1\n---\nbody", null, "not a fence opener"],
  ["text on the opening fence line", "--- yaml\na: 1\n---\nbody", null, "the opener carries no content"],
  ["no closing fence", "---\na: 1\nbody", null, "unterminated is not frontmatter"],
  ["closing fence indented", "---\na: 1\n ---\nbody", null, "the closer must start its line"],
  ["prose only", "just a note\n\nwith text", null, "no fence at all"],
  ["empty document", "", null, "nothing to honor"],
  ["fence not at the start", "intro\n\n---\na: 1\n---\n", null, "an embedded fence is not LEADING frontmatter (the guard still refuses it, separately and deliberately — see the parity suite)"],
];

describe("frontmatter boundary vs the vault (independent oracle, #129 review)", () => {
  for (const [name, input, expected, why] of ORACLE) {
    test(`${expected === null ? "NOT honored" : "honored"} — ${name}`, () => {
      assert.deepEqual(leadingFrontmatterBlock(input), expected, why);
    });
  }

  test("the oracle is load-bearing: it covers both directions", () => {
    // A table of only-positive rows would pass under an ever-broader
    // recognizer, which is precisely the drift direction that is dangerous in
    // the write path (over-honoring) and safe in the guard. Keep both.
    const honored = ORACLE.filter(([, , e]) => e !== null).length;
    const rejected = ORACLE.length - honored;
    assert.ok(honored >= 8, "positive rows");
    assert.ok(rejected >= 8, "negative rows — these are what catch a loosened anchor");
  });
});
