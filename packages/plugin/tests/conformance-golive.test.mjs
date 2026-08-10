/**
 * conformance-golive.test.mjs — #116: the conformance CLI's gate default and
 * its rebaseline guard.
 *
 * Two defects this pins, both measured live on the restored baseline:
 *
 * 1. The legacy gate was INVERTED relative to the baseline it is measured
 *    against. The accepted-debt baseline's keys are exclusively legacy-pack
 *    keys, and the legacy packs defaulted OFF — so the default run cleared the
 *    ENTIRE baseline (124 of 124) on every invocation. A pack set that cannot
 *    produce any of the baseline's keys is not a conservative default, it is a
 *    guaranteed false "everything was fixed" report.
 *
 * 2. `PHASE1_PACKS_INCOMPLETE` was a hardcoded `true` whose stated reason
 *    ("drift_audit is unported") became FALSE when the drift pack landed. A
 *    constant that encodes a fact about the pack set has to be COMPUTED from
 *    the pack set, or it goes stale silently and starts refusing (or, worse,
 *    permitting) for a reason that no longer holds.
 *
 * The refusal is deliberately NOT reduced to pack coverage alone: rebaselining
 * the live baseline re-accepts current findings, and acceptance is human-only.
 * Coverage is an ADDITIONAL check that also protects fixture baselines.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { baselinePackIds, rebaselineRefusal } from "../src/conformance/cli.ts";

const KEYS = (...k) => new Set(k);

describe("baselinePackIds — which packs the accepted debt actually describes", () => {
  test("reads the pack id from each key's first field", () => {
    const ids = baselinePackIds(KEYS("drift_audit|E|uid|dup-uid", "ste_lint|editable|x.md|", "drift_audit|G|y|"));
    assert.deepEqual([...ids].sort(), ["drift_audit", "ste_lint"]);
  });

  test("an empty baseline names no packs", () => {
    assert.deepEqual([...baselinePackIds(new Set())], []);
  });

  test("a malformed key contributes no pack rather than throwing", () => {
    assert.deepEqual([...baselinePackIds(KEYS("no-pipes-here"))], ["no-pipes-here"]);
  });
});

describe("rebaselineRefusal — the computed guard replacing PHASE1_PACKS_INCOMPLETE", () => {
  const covered = { baselinePackIds: KEYS("drift_audit"), registeredPackIds: KEYS("drift_audit", "vocab_findings") };

  test("REFUSES a baseline pack that is not registered, naming it (accepted debt would be erased)", () => {
    const r = rebaselineRefusal({
      targetsLiveBaseline: false,
      baselinePackIds: KEYS("drift_audit", "ste_lint"),
      registeredPackIds: KEYS("drift_audit"),
    });
    assert.ok(r, "must refuse");
    assert.match(r, /ste_lint/, "names the uncovered pack");
    assert.doesNotMatch(r, /drift_audit/, "does not name a covered pack");
  });

  test("the uncovered-pack refusal applies to a FIXTURE baseline too, not just the live one", () => {
    const r = rebaselineRefusal({
      targetsLiveBaseline: false,
      baselinePackIds: KEYS("port_lint"),
      registeredPackIds: new Set(),
    });
    assert.match(r ?? "", /port_lint/);
  });

  test("REFUSES the live baseline even when every pack is covered — rebaselining is an acceptance act", () => {
    const r = rebaselineRefusal({ targetsLiveBaseline: true, ...covered });
    assert.ok(r, "must refuse");
    assert.match(r, /human/i, "states the acceptance-is-human-only reason");
    assert.doesNotMatch(r, /drift_audit is unported|unported/i, "not the stale drift_audit reason");
  });

  test("PERMITS a fixture baseline whose packs are all registered", () => {
    assert.equal(rebaselineRefusal({ targetsLiveBaseline: false, ...covered }), null);
  });

  test("is at least as strict as the old constant: the live baseline is never permitted", () => {
    for (const registered of [new Set(), KEYS("drift_audit"), KEYS("drift_audit", "ste_lint", "port_lint")]) {
      const r = rebaselineRefusal({ targetsLiveBaseline: true, baselinePackIds: KEYS("drift_audit"), registeredPackIds: registered });
      assert.ok(r, "live baseline must be refused for every pack set");
    }
  });
});
