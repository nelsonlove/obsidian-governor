// governance-rename-records.test.mjs — #261: the link-heal oracle's durable half.
// Pure (de)serialization + pruning at src/kernel/governance/rename-records.ts. The wiring
// persists rename captures to governance/rename-records.json and reloads them at mount, so
// Obsidian's rename-driven wikilink rewrites stay CONFIRMABLE across a plugin reload — the
// in-memory-only oracle was half of the live #261 wedge (a rename's confirmation died with
// the plugin instance while the rewritten notes still awaited review).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pruneRenameRecords,
  serializeRenameRecords,
  deserializeRenameRecords,
  RENAME_RECORDS_CAP,
  RENAME_RECORD_TTL_MS,
} from "../src/kernel/governance/rename-records.ts";

const NOW = Date.parse("2026-08-19T12:00:00Z");
const rec = (overrides = {}) => ({
  old: ["Vault machinery", "Vault machinery/Vault machinery"],
  new: ["00.16 Vault machinery"],
  at: NOW - 1000,
  ...overrides,
});

describe("round-trip", () => {
  test("serialize → deserialize preserves records exactly", () => {
    const records = [rec(), rec({ old: ["A"], new: ["B"], at: NOW - 2000 })];
    assert.deepEqual(deserializeRenameRecords(serializeRenameRecords(records)), records);
  });

  test("empty list round-trips", () => {
    assert.deepEqual(deserializeRenameRecords(serializeRenameRecords([])), []);
  });
});

describe("tolerant load — malformed input reads as NO records (detector then cannot confirm: safe)", () => {
  test("non-JSON / non-object / missing records array → []", () => {
    assert.deepEqual(deserializeRenameRecords("not json"), []);
    assert.deepEqual(deserializeRenameRecords("42"), []);
    assert.deepEqual(deserializeRenameRecords(JSON.stringify({ version: 1 })), []);
    assert.deepEqual(deserializeRenameRecords(JSON.stringify({ records: "soon" })), []);
  });

  test("malformed entries are dropped individually", () => {
    const text = JSON.stringify({
      version: 1,
      records: [
        rec(),
        null,
        { old: ["x"], new: ["y"] }, // no at
        { old: "x", new: ["y"], at: NOW }, // old not an array
        { old: [""], new: ["y"], at: NOW }, // empty string target
        { old: ["x"], new: ["y"], at: "yesterday" }, // non-numeric at
      ],
    });
    assert.deepEqual(deserializeRenameRecords(text), [rec()]);
  });
});

describe("pruning — bounded file, bounded confirmation lifetime", () => {
  test("expired records (past TTL) are dropped; recent kept", () => {
    const fresh = rec();
    const stale = rec({ at: NOW - RENAME_RECORD_TTL_MS - 1 });
    assert.deepEqual(pruneRenameRecords([stale, fresh], NOW), [fresh]);
  });

  test("future-dated and non-finite timestamps are dropped (never trust a bad clock)", () => {
    assert.deepEqual(pruneRenameRecords([rec({ at: NOW + 60_000 }), rec({ at: NaN })], NOW), []);
  });

  test("cap keeps only the NEWEST records (list order is oldest-first)", () => {
    const many = Array.from({ length: RENAME_RECORDS_CAP + 10 }, (_, i) => rec({ at: NOW - 100_000 + i }));
    const pruned = pruneRenameRecords(many, NOW);
    assert.equal(pruned.length, RENAME_RECORDS_CAP);
    assert.deepEqual(pruned[pruned.length - 1], many[many.length - 1], "newest survives");
    assert.deepEqual(pruned[0], many[10], "oldest overflow dropped");
  });
});
