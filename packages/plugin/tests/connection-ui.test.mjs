/**
 * connection-ui.test.mjs — pure helpers behind the settings tab's
 * manifest-driven config fields (#81: config-host), including the
 * generalized `numberFieldProblem`, which lets the generic renderer refuse
 * (loudly, never silently) an unparseable "number"-typed field instead of
 * saving `undefined` with only a footnote — the old `parseFloorField`/
 * `floorFieldProblem` pair this generalizes did save the silently-emptied
 * value; `parseNumberField`/`numberFieldProblem` are used together
 * differently (see connection-ui.ts's `renderConfigField`, "number" case):
 * a non-null problem now means the save is SKIPPED, not merely footnoted.
 *
 * connection-ui.ts imports classes from "obsidian" at module scope (Modal,
 * PluginSettingTab, Setting, Notice — used as base classes / constructed at
 * runtime, not just as types), so it can't load in plain node. Same pattern
 * link-healing.test.mjs uses: installObsidianStub() points the "obsidian"
 * specifier at minimal stand-ins, then this file await-imports the real
 * module. Only the pure, exported helpers are exercised — display()'s DOM
 * wiring is untested, same boundary as every other field in that file today.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { parseCommaList, parseNumberField, numberFieldProblem, parseLineList } = await import("../src/connection-ui.ts");

// ── parseCommaList (pre-existing, pinned here since it had no test file yet) ──

describe("parseCommaList", () => {
  test("splits, trims, and drops blanks", () => {
    assert.deepEqual(parseCommaList(" 90-99 , 27 ,,  "), ["90-99", "27"]);
  });

  test("all-blank input yields undefined (provider default), not []", () => {
    assert.equal(parseCommaList("   "), undefined);
    assert.equal(parseCommaList(""), undefined);
  });
});

// ── parseLineList (new: the excludedRoots textarea) ─────────────────────────

describe("parseLineList", () => {
  test("splits on newlines, trims, and drops blank lines", () => {
    assert.deepEqual(parseLineList(" Vault archaeology \n\nOther root \n  "), ["Vault archaeology", "Other root"]);
  });

  test("all-blank input yields undefined, not [] — field is removed, not persisted empty", () => {
    assert.equal(parseLineList(""), undefined);
    assert.equal(parseLineList("   \n  \n"), undefined);
  });
});

// ── parseNumberField (generalized from the old JD-specific parseFloorField) ─

describe("parseNumberField", () => {
  test("blank yields undefined (removes the key — 'use the default')", () => {
    assert.equal(parseNumberField(""), undefined);
    assert.equal(parseNumberField("   "), undefined);
  });

  test("a valid integer parses through", () => {
    assert.equal(parseNumberField("5"), 5);
    assert.equal(parseNumberField(" 20 "), 20);
  });

  test("a non-numeric value silently becomes undefined — the exact behavior numberFieldProblem exists to surface, and why the renderer checks numberFieldProblem BEFORE calling this", () => {
    assert.equal(parseNumberField("abc"), undefined);
  });
});

// ── numberFieldProblem ───────────────────────────────────────────────────────

describe("numberFieldProblem — surfaces what parseNumberField cannot express on its own", () => {
  test("blank is never a problem — it's the documented 'use the default' case", () => {
    assert.equal(numberFieldProblem("Content-decimal floor", ""), null);
    assert.equal(numberFieldProblem("Content-decimal floor", "   "), null);
  });

  test("a valid integer is never a problem", () => {
    assert.equal(numberFieldProblem("Content-decimal floor", "5"), null);
    assert.equal(numberFieldProblem("Content-decimal floor", " 20 "), null);
  });

  test("a non-numeric value is reported, naming the field label and the offending text", () => {
    const problem = numberFieldProblem("Content-decimal floor", "abc");
    assert.equal(typeof problem, "string");
    assert.match(problem, /Content-decimal floor/);
    assert.match(problem, /abc/);
  });

  test("the message says the value was NOT saved — the loud-refusal contract the renderer relies on (never a silent coerce-to-default)", () => {
    assert.match(numberFieldProblem("X", "abc"), /not saved/);
  });

  test("different fields get their own label in the message, so two fields' problems are distinguishable", () => {
    assert.match(numberFieldProblem("Retry limit", "abc"), /Retry limit/);
  });

  test("a value that parses but is out of a module's own range is NOT this function's concern (that's manifest.config.validate's job downstream)", () => {
    // 500 is a valid NUMBER (Number("500") is not NaN) — numberFieldProblem
    // only catches "not a number at all"; range checking is the module's
    // own validate()'s job on the resulting config.
    assert.equal(numberFieldProblem("Content-decimal floor", "500"), null);
  });
});
