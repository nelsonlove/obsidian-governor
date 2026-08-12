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
import { leadingFrontmatterBlock, stripLeadingBom, LEADING_FRONTMATTER_RE } from "@vault-mcp/core";

const BOM = "\uFEFF";

/** [name, input, expected block or null, why]. */
const ORACLE = [
  // ── honored ───────────────────────────────────────────────────────────────
  ["plain fence", "---\na: 1\n---\nbody", "a: 1", "the ordinary case"],
  ["CRLF fence", "---\r\na: 1\r\n---\r\nbody", "a: 1", "Obsidian accepts CRLF documents"],
  ["BOM before the fence", `${BOM}---\na: 1\n---\nbody`, "a: 1", "#126 — the parser looks past a BOM"],
  ["trailing spaces on fences", "--- \na: 1\n--- \nbody", "a: 1", "tolerated on the OPENER (it is part of the fence there); on the closer the space is body — see the remainder oracle below"],
  ["tab after the fence", "---\t\na: 1\n---\nbody", "a: 1", "same, with a tab"],
  ["terminated at EOF", "---\na: 1\n---", "a: 1", "a note that is only frontmatter"],
  ["empty block", "---\n\n---\nbody", "", "an empty fence is still a fence"],
  ["multi-line block", "---\na: 1\nb: 2\n---\nbody", "a: 1\nb: 2", "several keys"],
  ["lone CR inside the block", "---\na:\rb\n---\nbody", "a:\rb", "the fence scan treats CR as a line break, but `b` is not a closer so the scan continues and the CR stays in the block — where parseYaml does NOT split on it. Same byte: line break to the fence, content to the value. Both halves pinned here"],
  ["--- inside the block body", "---\na: 1\n---\nbody\n---\nmore", "a: 1", "the FIRST closing fence ends it"],

  // ── closer forms, probed against a live Obsidian ──────────────────────────
  // The opener must be EXACTLY `---`; the closer is prefix-matched, and the
  // remainder of that line is body. Every row below was verified by writing
  // the note into a live vault and reading it back through Obsidian's own
  // parser — not inferred from the opener's rule, which is different.
  // Re-narrowing the closer reopens an accept-guard bypass; see the regex's
  // docstring in packages/core/src/accept-guard.ts.
  ["four-dash CLOSER", "---\na: 1\n----\nbody", "a: 1", "closes on the first three dashes; the vault puts the leftover `-` in the BODY (probed: body was \"-\\nbody\\n\")"],
  ["closer with adjacent text", "---\na: 1\n---x\nbody", "a: 1", "probed: body was \"x\\nbody\\n\" — the closer is not required to be alone on its line"],
  ["closer with spaced text", "---\na: 1\n--- x\nbody", "a: 1", "probed: body was \" x\\nbody\\n\""],
  ["closer with trailing space", "---\na: 1\n--- \nbody", "a: 1", "probed: body was \" \\nbody\\n\" — the vault does NOT trim it, so the space is body, not fence"],
  ["indented closer skipped, real closer found", "---\na: 1\n ---\nb: 2\n---\nbody", "a: 1\n ---\nb: 2", "probed: an indented ` ---` does not close, and Obsidian folded it into the value (frontmatter was {a: \"1 ---\", b: 2})"],
  ["adjacent fences are NOT an empty block", "---\n---\nbody", null, "probed: frontmatter was null — with no line between them this is not a fence at all (contrast the `empty block` row, which has one)"],
  ["lone CR before the closer", "---\nzz: 9\r---\nbody", "zz: 9", "probed: frontmatter was {zz: 9} — a lone CR is a LINE BREAK to the fence scan (found by review of the closer fix)"],
  ["lone CR after the opener", "---\rzz: 9\n---\nbody", "zz: 9", "probed: honored — the CR rule applies to both fences, not just the closer"],
  ["all-CR document", "---\rzz: 9\r---\rbody", "zz: 9", "probed: honored — a classic-Mac note is still a note"],

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

/**
 * The second half of the boundary: where the frontmatter STOPS.
 *
 * The table above pins only the captured block — what the frontmatter *is*.
 * That leaves the other edge unpinned, and it is the edge that moves: every
 * consumer splitting a note into frontmatter + body slices at
 * `match[0].length`, so a pattern that recognizes the identical block but
 * consumes one byte more or less silently relocates the body.
 *
 * Review of this change built exactly that mutant — same recognition, closer
 * swallowing the rest of its line — and the ENTIRE test suite passed while it
 * deleted body bytes from five note shapes. Prose in a `why` string is not an
 * assertion; this table is.
 *
 * `remainder` is the raw text after the fence, before any consumer strips the
 * line terminator. Obsidian's own `body` is this minus one leading line break
 * (probed: a plain note's body is `body\n`, a `----`-closed note's is
 * `-\nbody\n`) — the terminator strip lives in the consumers, so it is stated
 * here rather than baked into the expectation.
 */
const REMAINDER_ORACLE = [
  ["plain", "---\na: 1\n---\nbody\n", "\nbody\n", "the fence ends at the third dash; the line break belongs to the body side"],
  ["four-dash closer", "---\na: 1\n----\nbody\n", "-\nbody\n", "probed: Obsidian's body was \"-\\nbody\\n\" — the leftover dash is CONTENT"],
  ["closer with adjacent text", "---\na: 1\n---x\nbody\n", "x\nbody\n", "probed: body was \"x\\nbody\\n\""],
  ["closer with spaced text", "---\na: 1\n--- x\nbody\n", " x\nbody\n", "probed: body was \" x\\nbody\\n\""],
  ["closer with trailing space", "---\na: 1\n--- \nbody\n", " \nbody\n", "probed: body was \" \\nbody\\n\" — the vault does not trim it, so it is body, not fence"],
  ["CRLF", "---\r\na: 1\r\n---\r\nbody\r\n", "\r\nbody\r\n", "the CR belongs to the terminator the consumer strips, not to the fence"],
  ["CRLF closer carrying text", "---\r\na: 1\r\n---x\r\nbody\r\n", "x\r\nbody\r\n", "same, with a remainder ahead of it"],
  ["terminated at EOF", "---\na: 1\n---", "", "nothing follows the fence"],
];

describe("frontmatter boundary vs the vault (independent oracle, #129 review)", () => {
  for (const [name, input, expected, why] of ORACLE) {
    test(`${expected === null ? "NOT honored" : "honored"} — ${name}`, () => {
      assert.deepEqual(leadingFrontmatterBlock(input), expected, why);
    });
  }

  for (const [name, input, remainder, why] of REMAINDER_ORACLE) {
    test(`fence ENDS where the vault ends it — ${name}`, () => {
      const stripped = stripLeadingBom(input);
      const m = LEADING_FRONTMATTER_RE.exec(stripped);
      assert.notEqual(m, null, `expected a fence in ${JSON.stringify(input)}`);
      assert.equal(stripped.slice(m[0].length), remainder, why);
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
