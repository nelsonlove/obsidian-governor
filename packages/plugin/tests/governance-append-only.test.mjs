// The append-only detector (#135) — byte-prefix semantics, conservative fail-safe discipline
// (same as the per-class detectors: any doubt → false → the change stays PENDING).
//
// THE SEMANTICS UNDER TEST (documented in append-only.ts): isAppendOnly(base, cur) is true iff
// cur is STRICTLY longer than base AND base is a byte-for-byte prefix of cur. No trimming, no
// unicode normalization, no line-ending forgiveness — bytes or nothing.
//
// Eligibility substrate only: nothing consults this detector yet (the per-note "appends" policy
// arrives with the protected-frontmatter-properties mechanism). These tests pin the semantics so
// that wiring lands on a proven detector.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAppendOnly } from "../src/kernel/governance/auto-accept/append-only.ts";

describe("isAppendOnly — genuine appends", () => {
  test("a pure append at the end is an append", () => {
    assert.equal(isAppendOnly("# Log\n\n- one\n", "# Log\n\n- one\n- two\n"), true);
  });
  test("an append needs no trailing newline on the baseline", () => {
    assert.equal(isAppendOnly("abc", "abcdef"), true);
  });
  test("empty baseline: first content on an accepted-empty note is an append", () => {
    assert.equal(isAppendOnly("", "anything at all"), true);
  });
  test("the appended text may itself contain CRLF / BOM bytes (existing content untouched)", () => {
    assert.equal(isAppendOnly("a\nb\n", "a\nb\nnew\r\nline﻿\n"), true);
  });
});

describe("isAppendOnly — refusals (fail-safe)", () => {
  test("byte-identical content is NOT an append (a no-op never qualifies)", () => {
    assert.equal(isAppendOnly("same\n", "same\n"), false);
    assert.equal(isAppendOnly("", ""), false);
  });
  test("a write that appends AND modifies existing content is NOT an append", () => {
    // baseline's "one" became "one!" — the prefix is broken even though text was also appended.
    assert.equal(isAppendOnly("# Log\n- one\n", "# Log\n- one!\n- two\n"), false);
  });
  test("a prepend is NOT an append", () => {
    assert.equal(isAppendOnly("body\n", "prefix\nbody\n"), false);
  });
  test("a deletion (current shorter) is NOT an append", () => {
    assert.equal(isAppendOnly("a\nb\nc\n", "a\nb\n"), false);
  });
  test("a same-length rewrite is NOT an append", () => {
    assert.equal(isAppendOnly("abc", "abd"), false);
  });
  test("an insertion in the middle is NOT an append", () => {
    assert.equal(isAppendOnly("a\nc\n", "a\nb\nc\n"), false);
  });
  test("CRLF edge: normalizing EXISTING line endings is a modification, not an append", () => {
    // "a\nb" → "a\r\nb…" — the byte-prefix breaks at the inserted \r, even though the
    // current content is longer and 'looks appended' after normalization.
    assert.equal(isAppendOnly("a\nb\n", "a\r\nb\r\nnew\r\n"), false);
  });
  test("BOM edge: a BOM added at the FRONT is a prepend, not an append", () => {
    assert.equal(isAppendOnly("content\n", "﻿content\nmore\n"), false);
  });
  test("non-string inputs are refused (fail safe)", () => {
    assert.equal(isAppendOnly(null, "abc"), false);
    assert.equal(isAppendOnly("abc", undefined), false);
    assert.equal(isAppendOnly(42, "42x"), false);
    assert.equal(isAppendOnly(undefined, undefined), false);
  });
});
