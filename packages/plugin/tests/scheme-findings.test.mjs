/**
 * scheme-findings.test.mjs — Task 4 of the scope-provider module: the pure
 * conformance findings core (`schemeFindings`). NOT a registered tool — this
 * is the rule-pack core a later task wraps as a read-only tool.
 *
 * Every rule delegates its judgment to the provider (`jdProvider`): nothing
 * here hardcodes JD-specific knowledge beyond building a fixture listing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";
import { schemeFindings } from "../src/kernel/scheme/findings.js";

const instance = { id: "jd", providerName: "johnny-decimal", provider: jdProvider(DEFAULT_JD_CONFIG) };

// A listing exhibiting each finding class exactly once, plus one clean
// control note establishing "00-09 System/06 Agent tooling" as category 06's
// real folder (so expectedFolder has something correct to compare against).
const NOTES = [
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md", // clean — establishes 06's real folder
  "00-09 System/06 Agent tooling/06.11 Duplicate.md", // duplicate_address (extra claimant)
  "00-09 System/06 Agent tooling/06.5 Bad.md", // malformed_name — "06.5" looks numeric, doesn't parse
  "00-09 System/06 Agent tooling/scratch no address.md", // unaddressed — in-scope, no address
  "00-09 System/06 Misfiled/06.20 Oops.md", // misfiled — valid address, wrong folder
];

describe("schemeFindings — one of each class", () => {
  const findings = schemeFindings(instance, NOTES);

  test("exactly four findings, one per class", () => {
    assert.equal(findings.length, 4);
    const codes = findings.map((f) => f.code).sort();
    assert.deepEqual(codes, ["duplicate_address", "malformed_name", "misfiled", "unaddressed"]);
  });

  test("deterministic order: sorted by path", () => {
    assert.deepEqual(
      findings.map((f) => f.path),
      [
        "00-09 System/06 Agent tooling/06.11 Duplicate.md",
        "00-09 System/06 Agent tooling/06.5 Bad.md",
        "00-09 System/06 Agent tooling/scratch no address.md",
        "00-09 System/06 Misfiled/06.20 Oops.md",
      ],
    );
  });

  test("duplicate_address: flagged on the EXTRA path, detail names the first claimant", () => {
    const f = findings.find((f) => f.code === "duplicate_address");
    assert.equal(f.path, "00-09 System/06 Agent tooling/06.11 Duplicate.md");
    assert.match(f.detail, /06\.11/);
    assert.match(f.detail, /06\.11 Vault MCP\.md/);
  });

  test("malformed_name: delegated to provider.validateName", () => {
    const f = findings.find((f) => f.code === "malformed_name");
    assert.equal(f.path, "00-09 System/06 Agent tooling/06.5 Bad.md");
    assert.match(f.detail, /06\.5/);
  });

  test("unaddressed: in-scope note with no recognizable address", () => {
    const f = findings.find((f) => f.code === "unaddressed");
    assert.equal(f.path, "00-09 System/06 Agent tooling/scratch no address.md");
  });

  test("misfiled: addressed note whose actual folder differs from expectedFolder", () => {
    const f = findings.find((f) => f.code === "misfiled");
    assert.equal(f.path, "00-09 System/06 Misfiled/06.20 Oops.md");
    assert.match(f.detail, /00-09 System\/06 Agent tooling/);
    assert.match(f.detail, /00-09 System\/06 Misfiled/);
  });

  test("the clean control note produces no finding of its own", () => {
    assert.ok(!findings.some((f) => f.path === "00-09 System/06 Agent tooling/06.11 Vault MCP.md"));
  });
});

describe("schemeFindings — clean listing", () => {
  test("a fully conformant listing (plus an out-of-scheme note) produces no findings", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
      "00-09 System/06 Agent tooling/06.12 Bridge.md",
      "Unfiled/loose.md", // no scheme scope at all — not flagged unaddressed
    ];
    assert.deepEqual(schemeFindings(instance, notes), []);
  });
});

describe("schemeFindings — malformed_name and unaddressed are mutually exclusive per note", () => {
  test("a numeric-looking-but-unparseable name is malformed_name only, never also unaddressed", () => {
    const notes = ["00-09 System/06 Agent tooling/06.5 Bad.md"];
    const findings = schemeFindings(instance, notes);
    assert.deepEqual(
      findings.map((f) => f.code),
      ["malformed_name"],
    );
  });
});
