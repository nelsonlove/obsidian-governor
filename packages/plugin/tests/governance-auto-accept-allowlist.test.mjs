// Ported from obsidian-stewardship/tests/auto-accept-allowlist.test.mjs (#83, cycle 1) —
// the frozen authorized change-class registry + UNTRUSTED-allowlist normalization, now at
// src/kernel/governance/auto-accept/classes.ts. The default is Nelson's four; a tampered
// list can at most enable/disable AMONG the four; it can NEVER introduce a new class.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORIZED_CLASSES,
  DEFAULT_ALLOWLIST,
  normalizeAllowlist,
  serializeAllowlist,
  deserializeAllowlist,
  isAuthorizedClass,
} from "../src/kernel/governance/auto-accept/classes.ts";

test("the authorized universe is EXACTLY Nelson's four (frozen)", () => {
  assert.deepEqual(AUTHORIZED_CLASSES.map((s) => s.id), ["uid-stamp", "timestamp", "canonical-order", "link-heal"]);
  assert.ok(Object.isFrozen(AUTHORIZED_CLASSES));
});

test("default allowlist = the four authorized classes", () => {
  assert.deepEqual([...DEFAULT_ALLOWLIST], ["uid-stamp", "timestamp", "canonical-order", "link-heal"]);
});

test("normalizeAllowlist keeps only authorized ids, dedupes, canonical order", () => {
  assert.deepEqual(normalizeAllowlist(["link-heal", "uid-stamp", "uid-stamp"]), ["uid-stamp", "link-heal"]);
});

test("normalizeAllowlist DROPS an injected/unknown class id (can never become eligible)", () => {
  assert.deepEqual(normalizeAllowlist(["uid-stamp", "arbitrary-body-edit", "exec"]), ["uid-stamp"]);
  assert.equal(isAuthorizedClass("arbitrary-body-edit"), false);
});

test("normalizeAllowlist on malformed input → default four (never broadens authority)", () => {
  assert.deepEqual(normalizeAllowlist(null), [...DEFAULT_ALLOWLIST]);
  assert.deepEqual(normalizeAllowlist("uid-stamp"), [...DEFAULT_ALLOWLIST]);
  assert.deepEqual(normalizeAllowlist(42), [...DEFAULT_ALLOWLIST]);
});

test("serialize/deserialize round-trips through the normalized set", () => {
  const text = serializeAllowlist(["timestamp", "uid-stamp"]);
  assert.deepEqual(deserializeAllowlist(text), ["uid-stamp", "timestamp"]);
});

test("deserialize a tampered file with an injected class → the injection is dropped", () => {
  const tampered = JSON.stringify({ enabled: ["uid-stamp", "run-shell-command", "accept-anything"] });
  assert.deepEqual(deserializeAllowlist(tampered), ["uid-stamp"]);
});

test("deserialize garbage → default four (fail toward the authorized set)", () => {
  assert.deepEqual(deserializeAllowlist("{not json"), [...DEFAULT_ALLOWLIST]);
  assert.deepEqual(deserializeAllowlist(""), [...DEFAULT_ALLOWLIST]);
});

test("an empty enabled list deserializes to empty (disabling all is allowed — the SAFE direction)", () => {
  assert.deepEqual(deserializeAllowlist(JSON.stringify({ enabled: [] })), []);
});
