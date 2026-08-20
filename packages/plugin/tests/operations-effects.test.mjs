/**
 * operations-effects.test.mjs — WP2, Gate 0.
 *
 * Four different facts about one operation: what it MEANT to do, what it TRIED
 * to do, what the handler SAID it did, and what Governor actually SAW change.
 *
 * Collapsing them is how a receipt comes to assert a vault state nobody
 * checked. This repo already learned that the expensive way —
 * `obsidian_repoint_link` names one target and then discovers, rewrites and
 * reports a set of its own, and the journal had to grow an `effects` field
 * because the argument-derived record described a one-file operation that may
 * have changed forty.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildEffect, summarizeEffects, EFFECT_KINDS, SETTLEMENT } from "../src/kernel/effects/effect.ts";

const target = (path, over = {}) => ({ kind: "note-content", path, ...over });
const rec = (settlement, targets, over = {}) =>
  buildEffect({ operationId: "op-1", settlement, at: over.at ?? 1, targets, ...over });

describe("effects — the record", () => {
  test("the kinds and settlements are the documented sets", () => {
    assert.ok(EFFECT_KINDS.includes("note-content"));
    assert.ok(EFFECT_KINDS.includes("standing"));
    assert.deepEqual([...SETTLEMENT], ["intended", "attempted", "reported", "observed", "uncertain", "corrected"]);
  });

  test("a reported effect is LABELLED as the handler's claim", () => {
    const r = rec("reported", [target("A.md")]);
    assert.equal(r.claimedBy, "handler");
  });

  test("an observed effect carries no claim label, because it is not one", () => {
    assert.equal(rec("observed", [target("A.md")]).claimedBy, undefined);
  });

  test("a correction must name what it supersedes", () => {
    // A correction with no antecedent is just another claim.
    assert.throws(() => rec("corrected", [target("A.md")]), /supersedes/);
    assert.ok(rec("corrected", [target("A.md")], { corrects: 1 }));
  });

  test("an uncertain effect must say why", () => {
    assert.throws(() => rec("uncertain", []), /must say why/);
    assert.ok(rec("uncertain", [], { reason: "write_timeout: abandoned at deadline" }));
  });
});

describe("effects — what a receipt may claim", () => {
  test("observed effects win whenever they exist", () => {
    const s = summarizeEffects([rec("attempted", [target("A.md")]), rec("observed", [target("B.md")], { at: 2 })]);
    assert.equal(s.basis, "observed");
    assert.deepEqual(s.effects.map((e) => e.path), ["B.md"]);
  });

  test("a handler's report is NEVER promoted into the effects a receipt states", () => {
    // `filesChanged: 40` is what the code said. The difference between that and
    // forty files having changed is the entire reason these are separate.
    const s = summarizeEffects([rec("reported", [target("A.md"), target("B.md")])]);
    assert.deepEqual(s.effects, [], "a claim is not an effect");
    assert.equal(s.basis, "none");
    assert.equal(s.handlerClaimed.length, 2, "but it is retained, so a reviewer can see what was claimed");
  });

  test("without observation, the answer is what was attempted — and it says so", () => {
    const s = summarizeEffects([rec("attempted", [target("A.md")])]);
    assert.equal(s.basis, "attempted-unverified");
  });

  test("UNCERTAIN dominates everything, including an observation", () => {
    // If the operation may still be running, no earlier evidence entitles
    // anyone to say it did or did not land. Reporting the observation here
    // would invite a retry that duplicates a write which actually succeeded.
    const s = summarizeEffects([
      rec("observed", [target("A.md")]),
      rec("uncertain", [], { at: 2, reason: "write_timeout" }),
    ]);
    assert.equal(s.basis, "uncertain");
    assert.deepEqual(s.effects, []);
    assert.equal(s.reason, "write_timeout");
  });

  test("a correction supersedes the uncertainty it names", () => {
    // The late-settlement path: abandoned at the deadline, then settled.
    const s = summarizeEffects([
      rec("uncertain", [], { at: 2, reason: "write_timeout" }),
      rec("corrected", [target("A.md")], { at: 3, corrects: 2 }),
    ]);
    assert.equal(s.basis, "observed");
    assert.deepEqual(s.effects.map((e) => e.path), ["A.md"]);
  });

  test("nothing at all is `none`, not an empty success", () => {
    const s = summarizeEffects([]);
    assert.equal(s.basis, "none");
    assert.equal(s.handlerClaimed, null);
  });

  test("an intended effect alone claims nothing — a plan is not an outcome", () => {
    const s = summarizeEffects([rec("intended", [target("A.md")])]);
    assert.equal(s.basis, "none");
    assert.deepEqual(s.effects, []);
  });
});
