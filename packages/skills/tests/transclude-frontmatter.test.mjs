/**
 * transclude-frontmatter.test.mjs — site 4 of issue #189, moved here with its
 * code at the suite split's S4.
 *
 * #189 found five READ sites that parsed raw note text with their own narrow
 * `/^---\n/` frontmatter regexes instead of the shared recognizer in
 * @vault-mcp/core (`leadingFrontmatterBlock` / `stripLeadingFrontmatter`, the
 * #150 pair). A narrow local copy reads a BOM- or CRLF-authored note as having
 * NO frontmatter at all — a silent mis-read, not a bypass. Here that meant a
 * transcluded note's `---` fence riding into the compiled output.
 *
 * The other four sites are still pinned by
 * packages/plugin/tests/frontmatter-read-sites.test.mjs. This block is verbatim
 * from that file, so neutering `stripFrontmatter` still fails its own site's
 * tests — which is the per-site non-vacuity the issue's definition-of-done asks
 * for, preserved across the package boundary.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stripFrontmatter } from "../src/kernel/transclude.ts";

// U+FEFF by code point, never a literal BOM byte in source (accept-guard.ts's
// own convention — stripLeadingBom compares 0xfeff the same way).
const BOM = String.fromCharCode(0xfeff);

describe("transclude.ts stripFrontmatter binds to the shared recognizer (#189)", () => {
  test("LF note strips as before (regression)", () => {
    assert.equal(stripFrontmatter("---\na: 1\n---\nbody\n"), "body\n");
    assert.equal(stripFrontmatter("---\na: 1\n---\n\n\nbody\n"), "body\n"); // ^\s+ trim preserved
  });

  test("CRLF note strips as before (the old regex already handled CRLF — regression)", () => {
    assert.equal(stripFrontmatter("---\r\na: 1\r\n---\r\nbody\r\n"), "body\r\n");
  });

  test("BOM note strips its frontmatter (pre-fix the fence rode into transcluded output)", () => {
    assert.equal(stripFrontmatter(BOM + "---\na: 1\n---\nbody\n"), "body\n");
  });

  test("no frontmatter: leading-whitespace trim unchanged; a leading BOM is dropped", () => {
    assert.equal(stripFrontmatter("\n\nhello\n"), "hello\n");
    // Same either way: stripLeadingBom drops it now; the old `^\s+` trim
    // happened to swallow it too (JS \s matches U+FEFF). Pinned as regression.
    assert.equal(stripFrontmatter(BOM + "hello\n"), "hello\n");
  });
});
