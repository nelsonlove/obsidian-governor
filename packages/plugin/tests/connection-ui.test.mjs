/**
 * connection-ui.test.mjs — Item 4 of the scope-followups cycle: pure helpers
 * behind the settings tab's JD scheme fields, especially the new
 * `floorFieldProblem`, which lets the tab surface a non-numeric
 * content-decimal-floor entry as a validation problem instead of silently
 * dropping it to the provider default (parseFloorField's existing, and
 * unchanged, behavior).
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
const { parseCommaList, parseFloorField, floorFieldProblem, parseLineList } = await import("../src/connection-ui.ts");

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

// ── parseFloorField (pre-existing) ──────────────────────────────────────────

describe("parseFloorField", () => {
  test("blank yields undefined (provider default applies)", () => {
    assert.equal(parseFloorField(""), undefined);
    assert.equal(parseFloorField("   "), undefined);
  });

  test("a valid integer parses through", () => {
    assert.equal(parseFloorField("5"), 5);
    assert.equal(parseFloorField(" 20 "), 20);
  });

  test("a non-numeric value silently becomes undefined (default) — the exact behavior floorFieldProblem exists to surface", () => {
    assert.equal(parseFloorField("abc"), undefined);
  });
});

// ── floorFieldProblem (Item 4: new) ─────────────────────────────────────────

describe("floorFieldProblem — surfaces what parseFloorField silently drops", () => {
  test("blank is never a problem — it's the documented 'use the default' case", () => {
    assert.equal(floorFieldProblem(""), null);
    assert.equal(floorFieldProblem("   "), null);
  });

  test("a valid integer is never a problem", () => {
    assert.equal(floorFieldProblem("5"), null);
    assert.equal(floorFieldProblem(" 20 "), null);
  });

  test("a non-numeric value is reported, naming the offending text", () => {
    const problem = floorFieldProblem("abc");
    assert.equal(typeof problem, "string");
    assert.match(problem, /abc/);
  });

  test("a value that parses but is out of validateJdConfig's 0-99 range is NOT this function's concern (that's validateJdConfig's job downstream)", () => {
    // 500 is a valid NUMBER (Number("500") is not NaN) — floorFieldProblem
    // only catches "not a number at all"; range checking is validateJdConfig's
    // job on the resulting config, applied separately by the settings tab.
    assert.equal(floorFieldProblem("500"), null);
  });
});
