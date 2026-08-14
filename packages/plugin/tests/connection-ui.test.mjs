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
const {
  parseCommaList,
  parseNumberField,
  numberFieldProblem,
  parseLineList,
  parseVocabConfig,
  stringifyVocabConfig,
  coerceVocabInstances,
  validateVocabInstances,
  addVocabInstance,
  removeVocabInstanceAt,
  updateVocabInstanceAt,
} = await import("../src/connection-ui.ts");

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

// ── Gap B: vocab-instance form helpers (parse / validate / coerce / mutate) ──

describe("parseVocabConfig", () => {
  test("blank yields no config key (the 'no config' case), never an error", () => {
    assert.deepEqual(parseVocabConfig(""), { ok: true, config: undefined });
    assert.deepEqual(parseVocabConfig("   \n "), { ok: true, config: undefined });
  });

  test("a valid JSON object parses through", () => {
    assert.deepEqual(parseVocabConfig('{"termsRoot": "Assent"}'), { ok: true, config: { termsRoot: "Assent" } });
  });

  test("unparseable JSON is a loud problem — refused, never coerced", () => {
    const r = parseVocabConfig("{not json");
    assert.equal(r.ok, false);
    assert.match(r.error, /not valid JSON/);
  });

  test("valid JSON that is NOT an object (array / scalar / null) is refused", () => {
    assert.equal(parseVocabConfig("[1,2,3]").ok, false);
    assert.equal(parseVocabConfig('"a string"').ok, false);
    assert.equal(parseVocabConfig("42").ok, false);
    assert.equal(parseVocabConfig("null").ok, false);
  });
});

describe("stringifyVocabConfig", () => {
  test("absent or empty config is the empty string (the no-config textarea)", () => {
    assert.equal(stringifyVocabConfig(undefined), "");
    assert.equal(stringifyVocabConfig({}), "");
  });

  test("a config object round-trips through parseVocabConfig", () => {
    const cfg = { termsRoot: "Assent", nested: { a: 1 } };
    const parsed = parseVocabConfig(stringifyVocabConfig(cfg));
    assert.deepEqual(parsed, { ok: true, config: cfg });
  });
});

describe("coerceVocabInstances — degrade gracefully, never throw on malformed data.json", () => {
  test("a non-array yields [] (no crash)", () => {
    assert.deepEqual(coerceVocabInstances(undefined), []);
    assert.deepEqual(coerceVocabInstances("garbage"), []);
    assert.deepEqual(coerceVocabInstances(null), []);
    assert.deepEqual(coerceVocabInstances({}), []);
  });

  test("non-object entries are dropped; object entries are coerced field-by-field", () => {
    const raw = [
      null,
      42,
      "x",
      { id: "a", provider: "blueprint", root: "Root" },
      { id: "b", provider: "glossary", root: "", config: { termsRoot: "T" } },
    ];
    assert.deepEqual(coerceVocabInstances(raw), [
      { id: "a", provider: "blueprint", root: "Root" },
      { id: "b", provider: "glossary", root: "", config: { termsRoot: "T" } },
    ]);
  });

  test("missing / wrong-typed fields fall back to empty strings; a non-object config is dropped", () => {
    const raw = [{ id: 5, provider: null, config: "nope" }];
    assert.deepEqual(coerceVocabInstances(raw), [{ id: "", provider: "", root: "" }]);
  });

  test("an unknown provider is PRESERVED (so the form shows it and validate flags it), not rewritten", () => {
    const raw = [{ id: "a", provider: "mystery", root: "R" }];
    assert.deepEqual(coerceVocabInstances(raw), [{ id: "a", provider: "mystery", root: "R" }]);
  });
});

describe("validateVocabInstances", () => {
  test("a clean list has no problems", () => {
    assert.deepEqual(
      validateVocabInstances([
        { id: "registry", provider: "blueprint", root: "R" },
        { id: "glossary", provider: "glossary", root: "" },
      ]),
      [],
    );
  });

  test("blank id is flagged", () => {
    const p = validateVocabInstances([{ id: "  ", provider: "blueprint", root: "R" }]);
    assert.equal(p.length, 1);
    assert.match(p[0], /id is required/);
  });

  test("duplicate id is flagged (mirrors VocabRegistry's skip-and-report)", () => {
    const p = validateVocabInstances([
      { id: "dup", provider: "blueprint", root: "R" },
      { id: "dup", provider: "glossary", root: "R2" },
    ]);
    assert.equal(p.length, 1);
    assert.match(p[0], /duplicate id 'dup'/);
  });

  test("unknown provider is flagged, naming the allowed set", () => {
    const p = validateVocabInstances([{ id: "a", provider: "mystery", root: "R" }]);
    assert.equal(p.length, 1);
    assert.match(p[0], /unknown provider 'mystery'/);
    assert.match(p[0], /blueprint, glossary/);
  });

  test('empty root ("" = whole vault) is VALID — the shipping glossary default uses it', () => {
    assert.deepEqual(validateVocabInstances([{ id: "g", provider: "glossary", root: "" }]), []);
  });

  test("a whitespace-only root (neither blank nor a real path) is flagged", () => {
    const p = validateVocabInstances([{ id: "a", provider: "blueprint", root: "   " }]);
    assert.equal(p.length, 1);
    assert.match(p[0], /whitespace-only/);
  });
});

describe("vocab instance array mutations (pure)", () => {
  test("addVocabInstance appends a blank instance with the first provider preselected", () => {
    const before = [{ id: "a", provider: "blueprint", root: "R" }];
    const after = addVocabInstance(before);
    assert.equal(after.length, 2);
    assert.deepEqual(after[1], { id: "", provider: "blueprint", root: "" });
    assert.equal(before.length, 1, "input is not mutated");
  });

  test("removeVocabInstanceAt removes exactly the indexed instance", () => {
    const before = [
      { id: "a", provider: "blueprint", root: "R" },
      { id: "b", provider: "glossary", root: "" },
      { id: "c", provider: "blueprint", root: "R3" },
    ];
    assert.deepEqual(
      removeVocabInstanceAt(before, 1).map((i) => i.id),
      ["a", "c"],
    );
    assert.equal(before.length, 3, "input is not mutated");
  });

  test("updateVocabInstanceAt patches only the indexed instance", () => {
    const before = [
      { id: "a", provider: "blueprint", root: "R" },
      { id: "b", provider: "glossary", root: "" },
    ];
    const after = updateVocabInstanceAt(before, 0, { provider: "glossary", root: "R2" });
    assert.deepEqual(after[0], { id: "a", provider: "glossary", root: "R2" });
    assert.deepEqual(after[1], before[1]);
  });

  test("a patch value of undefined REMOVES the key (blank config drops config)", () => {
    const before = [{ id: "a", provider: "glossary", root: "", config: { termsRoot: "T" } }];
    const after = updateVocabInstanceAt(before, 0, { config: undefined });
    assert.deepEqual(after[0], { id: "a", provider: "glossary", root: "" });
    assert.ok(!("config" in after[0]), "config key is removed, not set to undefined");
  });

  test("setting config through a patch adds the key", () => {
    const before = [{ id: "a", provider: "glossary", root: "" }];
    const after = updateVocabInstanceAt(before, 0, { config: { termsRoot: "Assent" } });
    assert.deepEqual(after[0].config, { termsRoot: "Assent" });
  });
});
