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
let seq = 0;
const rec = (settlement, targets, over = {}) =>
  buildEffect({ id: over.id ?? `e-${++seq}`, operationId: "op-1", settlement, at: over.at ?? 1, targets, ...over });

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
    assert.ok(rec("corrected", [target("A.md")], { corrects: "e-1" }));
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
    const u = rec("uncertain", [], { id: "u-1", reason: "write_timeout" });
    const s = summarizeEffects([u, rec("corrected", [target("A.md")], { corrects: "u-1" })]);
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

describe("effects — a correction that says NOTHING changed is still a correction", () => {
  test("an empty-target correction supersedes, rather than falling through to a stale attempt", () => {
    // The late-error path: an operation abandoned at its deadline that turns
    // out to have changed nothing. Testing `targets.length > 0` treated that
    // identically to "no observation exists" and reported the superseded
    // `attempted` claim as if the correction had never happened.
    const attempted = rec("attempted", [target("A.md")], { id: "a-1" });
    const uncertain = rec("uncertain", [], { id: "u-1", reason: "write_timeout" });
    const correction = rec("corrected", [], { id: "c-1", corrects: "u-1" });
    const s = summarizeEffects([attempted, uncertain, correction]);
    assert.equal(s.basis, "observed", "the correction is the authoritative statement");
    assert.deepEqual(s.effects, [], "and what it says is: nothing changed");
  });

  test("correction identity is a stable id, not a timestamp", () => {
    // Two records written in the same millisecond share an `at`. Keying
    // corrections on that would let one correction silently exclude an
    // unrelated record's evidence.
    const a = rec("observed", [target("A.md")], { id: "x", at: 5 });
    const b = rec("attempted", [target("B.md")], { id: "y", at: 5 });
    const c = rec("corrected", [target("C.md")], { id: "z", at: 5, corrects: "y" });
    const s = summarizeEffects([a, b, c]);
    assert.deepEqual(s.effects.map((e) => e.path).sort(), ["A.md", "C.md"], "only 'y' is superseded, despite the shared timestamp");
  });

  test("a superseded handler claim is still shown as something the code said", () => {
    // Deliberately unfiltered: the audit trail of what a tool ever CLAIMED
    // should not depend on how the story ended. It never enters `effects`.
    const reported = rec("reported", [target("A.md")], { id: "r-1" });
    const s = summarizeEffects([reported, rec("corrected", [], { corrects: "r-1" })]);
    assert.equal(s.handlerClaimed.length, 1);
    assert.deepEqual(s.effects, []);
  });
});
