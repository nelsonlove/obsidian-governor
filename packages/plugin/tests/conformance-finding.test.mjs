/**
 * conformance-finding.test.mjs — the canonical rail Finding + its 4-tuple key.
 *
 * The key MUST serialize byte-identically to the existing Python ratchet's
 * baseline lines (`script|check|target|kind`, verified against the live
 * `Conformance baseline.md` fence) so the accepted-debt baseline carries over
 * with no re-blessing. The `detail` field is human text and is NOT part of the
 * key.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findingKey, parseKey } from "../src/conformance/finding.ts";

describe("findingKey", () => {
  test("serializes as script|check|target|kind (matches the live baseline)", () => {
    const f = {
      script: "conformance_check",
      check: "DROPPED",
      target: "00-09 System/02 Obsidian/02 Obsidian.md",
      kind: "Category.blueprint",
      detail: "would drop section on apply",
    };
    assert.equal(findingKey(f), "conformance_check|DROPPED|00-09 System/02 Obsidian/02 Obsidian.md|Category.blueprint");
  });

  test("detail is excluded from the key (two findings differing only in detail share a key)", () => {
    const a = { script: "s", check: "c", target: "t", kind: "k", detail: "one" };
    const b = { script: "s", check: "c", target: "t", kind: "k", detail: "two" };
    assert.equal(findingKey(a), findingKey(b));
  });

  test("an empty kind serializes as a trailing empty field", () => {
    assert.equal(findingKey({ script: "scheme_findings", check: "misfiled", target: "N.md", kind: "", detail: "" }), "scheme_findings|misfiled|N.md|");
  });

  test("parseKey round-trips findingKey", () => {
    const line = "vocab_findings|unregistered_tag|Notes/A.md|rogue";
    const k = parseKey(line);
    assert.deepEqual(k, { script: "vocab_findings", check: "unregistered_tag", target: "Notes/A.md", kind: "rogue" });
    assert.equal(findingKey({ ...k, detail: "ignored" }), line);
  });

  test("parseKey tolerates a target containing no pipe and an empty kind", () => {
    assert.deepEqual(parseKey("scheme_findings|misfiled|N.md|"), {
      script: "scheme_findings",
      check: "misfiled",
      target: "N.md",
      kind: "",
    });
  });
});

describe("findingKey pipe guard", () => {
  test("a pipe in script/check/target throws rather than emitting a mis-fielded key", async () => {
    const assert2 = (await import("node:assert/strict")).default;
    const { findingKey } = await import("../src/conformance/finding.ts");
    assert2.throws(() => findingKey({ script: "s", check: "c", target: "a|b", kind: "k" }), /separator/);
    assert2.throws(() => findingKey({ script: "s|x", check: "c", target: "t", kind: "k" }), /separator/);
  });
  test("a pipe in kind (last field) is allowed and round-trips", async () => {
    const assert2 = (await import("node:assert/strict")).default;
    const { findingKey, parseKey } = await import("../src/conformance/finding.ts");
    const line = findingKey({ script: "s", check: "c", target: "t", kind: "a|b" });
    assert2.equal(parseKey(line).kind, "a|b");
  });
});
