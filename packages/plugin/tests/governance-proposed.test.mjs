// The Proposed-section builder (#221/#164 acceptance convergence) — pure derivation over a
// metadata-cache fake (kernel/governance/proposed.ts), exactly the #228 Revising-section
// discipline. Pins the three listing rules:
//   1. `acceptance-status: proposed` notes with NO pending delta are listed;
//   2. proposed notes that ARE pending are deduped OUT (their queue row already carries the
//      same context-aware Accept — one note must never render two Accept rows);
//   3. excluded roots (guarded territories / hold zones) are respected.
// Plus: the config coercion for the convergence settings (acceptedBy + the conformance-gate
// key list) in kernel/governance/settings.ts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildProposedList } from "../src/kernel/governance/proposed.ts";
import {
  governanceAcceptanceSettings,
  DEFAULT_ACCEPTANCE_SETTINGS,
} from "../src/kernel/governance/settings.ts";

// The same exclusion predicate shape wiring.ts uses (EXCLUDED_PREFIXES).
const EXCLUDED = ["obsidian-old/", "80-89", "_keep/", "holds/"];
const isExcluded = (p) => EXCLUDED.some((x) => p.startsWith(x));

// A metadata-cache fake: path/status/mtime triples, as listProposed derives them. mtime
// defaults to 0 when omitted — fine for tests that don't care about order (a single result,
// or an empty one); tests that DO care about order pass explicit, distinct mtimes.
const cache = (entries) =>
  entries.map(([path, status, mtime = 0]) => ({
    path,
    title: path.split("/").pop().replace(/\.md$/, ""),
    status,
    mtime,
  }));

describe("buildProposedList — the Proposed section's dedupe/exclusion rules", () => {
  test("proposed notes with no pending delta are listed, sorted by mtime DESCENDING (most recently touched first)", () => {
    const out = buildProposedList(
      cache([
        ["Notes/A.md", "proposed", 1000],
        ["Notes/B.md", "proposed", 2000],
      ]),
      [],
      isExcluded,
    );
    assert.deepEqual(out, [
      { path: "Notes/B.md", title: "B" }, // newer mtime first
      { path: "Notes/A.md", title: "A" },
    ]);
  });

  test("a proposed note WITH a pending delta is deduped into the pending queue only", () => {
    const out = buildProposedList(
      cache([
        ["Notes/A.md", "proposed"], // pending — must NOT be double-listed
        ["Notes/B.md", "proposed"],
      ]),
      ["Notes/A.md"],
      isExcluded,
    );
    assert.deepEqual(out.map((i) => i.path), ["Notes/B.md"]);
  });

  test("excluded roots are respected (guarded territories never surface)", () => {
    const out = buildProposedList(
      cache([
        ["obsidian-old/Old.md", "proposed"],
        ["80-89 Divorce/X.md", "proposed"],
        ["_keep/K.md", "proposed"],
        ["holds/H.md", "proposed"],
        ["Notes/Live.md", "proposed"],
      ]),
      [],
      isExcluded,
    );
    assert.deepEqual(out.map((i) => i.path), ["Notes/Live.md"]);
  });

  test("only the exact string 'proposed' matches — other statuses and non-string cache junk are ignored", () => {
    const out = buildProposedList(
      cache([
        ["Notes/A.md", "revising"],
        ["Notes/B.md", "accepted"],
        ["Notes/C.md", undefined],
        ["Notes/D.md", ["proposed"]], // untrusted cache shape — not a scalar match
        ["Notes/E.md", "proposed"],
      ]),
      [],
      isExcluded,
    );
    assert.deepEqual(out.map((i) => i.path), ["Notes/E.md"]);
  });

  test("empty in, empty out", () => {
    assert.deepEqual(buildProposedList([], [], isExcluded), []);
  });
});

describe("governanceAcceptanceSettings — the convergence config coercion", () => {
  test("defaults: acceptedBy 'local-human', empty gate", () => {
    assert.deepEqual(governanceAcceptanceSettings({}), DEFAULT_ACCEPTANCE_SETTINGS);
    assert.deepEqual(governanceAcceptanceSettings(undefined), DEFAULT_ACCEPTANCE_SETTINGS);
    assert.equal(DEFAULT_ACCEPTANCE_SETTINGS.acceptedBy, "local-human");
    assert.deepEqual(DEFAULT_ACCEPTANCE_SETTINGS.requiredFrontmatterKeys, []);
  });

  test("acceptedBy: non-blank string wins (trimmed); blank/malformed falls back to the default", () => {
    assert.equal(governanceAcceptanceSettings({ acceptedBy: "nelson" }).acceptedBy, "nelson");
    assert.equal(governanceAcceptanceSettings({ acceptedBy: "  nelson  " }).acceptedBy, "nelson");
    assert.equal(governanceAcceptanceSettings({ acceptedBy: "   " }).acceptedBy, "local-human");
    assert.equal(governanceAcceptanceSettings({ acceptedBy: 42 }).acceptedBy, "local-human");
  });

  test("requiredFrontmatterKeys: accepts the renderer's string[] AND a raw CSV string, normalized", () => {
    assert.deepEqual(
      governanceAcceptanceSettings({ requiredFrontmatterKeys: ["uid", " title ", ""] }).requiredFrontmatterKeys,
      ["uid", "title"],
    );
    assert.deepEqual(
      governanceAcceptanceSettings({ requiredFrontmatterKeys: "uid, title, description" }).requiredFrontmatterKeys,
      ["uid", "title", "description"],
    );
    assert.deepEqual(governanceAcceptanceSettings({ requiredFrontmatterKeys: "" }).requiredFrontmatterKeys, []);
    assert.deepEqual(governanceAcceptanceSettings({ requiredFrontmatterKeys: 42 }).requiredFrontmatterKeys, []);
    assert.deepEqual(
      governanceAcceptanceSettings({ requiredFrontmatterKeys: ["uid", 42, null] }).requiredFrontmatterKeys,
      ["uid"],
    );
  });
});
