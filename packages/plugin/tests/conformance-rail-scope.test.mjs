/**
 * conformance-rail-scope.test.mjs — #112: the rail governs LIVE content, not
 * the frozen archive (@assent's ruling, 2026-08-10).
 *
 * The ruling came with a condition: a **declared exclusion, not a silent
 * debt-clear**. Excluding a root makes every baseline key under it
 * unreproducible, so those keys would report CLEARED and quietly discard
 * accepted debt a human granted — the same failure the pack-coverage refusal
 * exists to stop, one level down (path granularity instead of pack).
 *
 * Measured before building: ZERO baseline keys fall under `Vault archaeology/`
 * today, under every pre-consolidation naming too (`_maybe`, `gen2`, `_keep`,
 * `_hold`, `_decent`). So the guarantee below costs nothing now — which is
 * exactly when it is cheap to add, and exactly the kind of fact that expires
 * silently if only a measurement records it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { excludedRootRefusal, DEFAULT_EXCLUDED_ROOTS } from "../src/conformance/cli.ts";

describe("#112 — an excluded root must never silently clear accepted debt", () => {
  test("a baseline key UNDER an excluded root refuses, naming the key and the root", () => {
    const r = excludedRootRefusal(
      new Set(["ste_lint|editable|Vault archaeology/_maybe/x.md|"]),
      ["Vault archaeology"],
    );
    assert.ok(r, "must refuse");
    assert.match(r, /Vault archaeology/);
    assert.match(r, /CLEARED|clear/i, "names the consequence, not just the fact");
  });

  test("keys outside every excluded root are fine", () => {
    assert.equal(
      excludedRootRefusal(new Set(["ste_lint|editable|00-09 System/x.md|"]), ["Vault archaeology"]),
      null,
    );
  });

  test("prefix matching is on a path SEGMENT, not a substring", () => {
    // "Vault archaeology notes/" is a different folder and must not be swept in.
    assert.equal(
      excludedRootRefusal(new Set(["ste_lint|editable|Vault archaeology notes/x.md|"]), ["Vault archaeology"]),
      null,
    );
  });

  test("a drift key whose target is a MESSAGE, not a path, is unaffected", () => {
    assert.equal(
      excludedRootRefusal(new Set(["drift_audit|A|choice 'X' does not exist in QuickAdd config|"]), ["Vault archaeology"]),
      null,
    );
  });

  test("no excluded roots ⇒ nothing to refuse", () => {
    assert.equal(excludedRootRefusal(new Set(["ste_lint|editable|anything/x.md|"]), []), null);
  });

  test("the archive is excluded by default (the ruling), and it is the only default", () => {
    assert.deepEqual(DEFAULT_EXCLUDED_ROOTS, ["Vault archaeology"]);
  });
});
