import assert from "node:assert/strict";
import { test } from "node:test";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";

const NOTES = [
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "Unfiled/loose note.md",
];
const p = jdProvider(DEFAULT_JD_CONFIG);

test("occupantOf finds the claimant", () => {
  const addr = p.parse("06.11");
  const occ = p.occupantOf(addr, NOTES);
  assert.deepEqual(occ, { path: NOTES[0], address: "06.11" });
});

test("occupantOf returns null when nothing claims the address", () => {
  const addr = p.parse("06.13");
  assert.equal(p.occupantOf(addr, NOTES), null);
});

test("occupantOf: first match wins on a duplicate", () => {
  const dup = [...NOTES, "Somewhere else/06.11 Duplicate.md"];
  const addr = p.parse("06.11");
  assert.equal(p.occupantOf(addr, dup)?.path, NOTES[0]);
});

test("titleOf strips a leading address token", () => {
  assert.equal(p.titleOf("00-09 System/06 Agent tooling/06.11 Vault MCP.md"), "Vault MCP");
});

test("titleOf on a note with no address returns the whole basename", () => {
  assert.equal(p.titleOf("Unfiled/loose note.md"), "loose note");
});

test("titleOf on a malformed-but-numeric-looking token still strips only a real address", () => {
  // "06.1" is not a valid two-or-three-digit decimal — not an address, so
  // nothing is stripped.
  assert.equal(p.titleOf("Somewhere/06.1 Not Quite An Id.md"), "06.1 Not Quite An Id");
});
