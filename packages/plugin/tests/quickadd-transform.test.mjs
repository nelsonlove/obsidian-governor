import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  transformChoices,
  deriveChoiceId,
  deriveMacroId,
  deriveStepId,
  isCompilerOwnedId,
} from "../src/kernel/quickadd/transform.ts";

function userscriptStep(overrides = {}) {
  return { kind: "userscript", ok: true, scriptPath: "Scripts/stamp-title.md", settings: {}, ...overrides };
}

function macroInput(overrides = {}) {
  return {
    notePath: "QuickAdd choices/Stamp title.md",
    quickaddType: "macro",
    name: "Stamp title",
    steps: [userscriptStep()],
    ...overrides,
  };
}

describe("deriveChoiceId / deriveMacroId / deriveStepId", () => {
  test("deterministic — same note path produces the same id every time", () => {
    assert.equal(deriveChoiceId("a/b.md"), deriveChoiceId("a/b.md"));
    assert.equal(deriveMacroId("a/b.md"), deriveMacroId("a/b.md"));
    assert.equal(deriveStepId("a/b.md", 2), deriveStepId("a/b.md", 2));
  });

  test("distinct notes never collide", () => {
    assert.notEqual(deriveChoiceId("a/b.md"), deriveChoiceId("a/c.md"));
  });

  test("all three carry the qan: compiler-owned marker prefix", () => {
    assert.match(deriveChoiceId("a/b.md"), /^qan:/);
    assert.match(deriveMacroId("a/b.md"), /^qan:/);
    assert.match(deriveStepId("a/b.md", 0), /^qan:/);
  });
});

describe("isCompilerOwnedId", () => {
  test("returns true for a derived id", () => {
    assert.equal(isCompilerOwnedId(deriveChoiceId("a/b.md")), true);
  });

  test("returns false for an arbitrary string", () => {
    assert.equal(isCompilerOwnedId("some-uuid"), false);
  });
});

describe("transformChoices — happy path", () => {
  test("one macro, one userscript step, compiles to QuickAdd's native shape", () => {
    const result = transformChoices([macroInput()]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.choices.length, 1);
    const c = result.choices[0];
    assert.equal(c.name, "Stamp title");
    assert.equal(c.type, "Macro");
    assert.equal(c.command, true);
    assert.equal(c.runOnStartup, false);
    assert.equal(c.id, deriveChoiceId("QuickAdd choices/Stamp title.md"));
    assert.equal(c.macro.name, "Stamp title");
    assert.equal(c.macro.id, deriveMacroId("QuickAdd choices/Stamp title.md"));
    assert.equal(c.macro.commands.length, 1);
    const cmd = c.macro.commands[0];
    assert.equal(cmd.type, "UserScript");
    assert.equal(cmd.path, "Scripts/stamp-title.md");
    assert.equal(cmd.id, deriveStepId("QuickAdd choices/Stamp title.md", 0));
    assert.deepEqual(cmd.settings, {});
  });

  test("multiple steps compile in order with distinct ids", () => {
    const result = transformChoices([
      macroInput({
        steps: [
          userscriptStep({ scriptPath: "Scripts/a.md" }),
          userscriptStep({ scriptPath: "Scripts/b.md" }),
        ],
      }),
    ]);
    assert.deepEqual(result.errors, []);
    const cmds = result.choices[0].macro.commands;
    assert.equal(cmds[0].path, "Scripts/a.md");
    assert.equal(cmds[1].path, "Scripts/b.md");
    assert.notEqual(cmds[0].id, cmds[1].id);
  });

  test("script settings pass through unchanged", () => {
    const result = transformChoices([
      macroInput({ steps: [userscriptStep({ settings: { snippet: "hi" } })] }),
    ]);
    assert.deepEqual(result.choices[0].macro.commands[0].settings, { snippet: "hi" });
  });

  test("recompiling the same unchanged input twice is byte-identical", () => {
    const a = transformChoices([macroInput()]);
    const b = transformChoices([macroInput()]);
    assert.deepEqual(a, b);
  });

  test("multiple notes each produce their own choice, independent of each other", () => {
    const result = transformChoices([
      macroInput({ notePath: "QuickAdd choices/One.md", name: "One" }),
      macroInput({ notePath: "QuickAdd choices/Two.md", name: "Two" }),
    ]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.choices.length, 2);
    assert.deepEqual(result.choices.map((c) => c.name).sort(), ["One", "Two"]);
  });
});

describe("transformChoices — per-choice error isolation", () => {
  test("a note with zero steps fails only that note", () => {
    const result = transformChoices([
      macroInput({ notePath: "QuickAdd choices/Empty.md", name: "Empty", steps: [] }),
      macroInput({ notePath: "QuickAdd choices/Good.md", name: "Good" }),
    ]);
    assert.equal(result.choices.length, 1);
    assert.equal(result.choices[0].name, "Good");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].notePath, "QuickAdd choices/Empty.md");
    assert.match(result.errors[0].message, /no steps/i);
  });

  test("an unresolved wikilink step fails only that note, with the resolver's own error surfaced", () => {
    const result = transformChoices([
      macroInput({
        notePath: "QuickAdd choices/Broken.md",
        name: "Broken",
        steps: [{ kind: "userscript", ok: false, error: "could not resolve \"[[nope]]\"" }],
      }),
      macroInput({ notePath: "QuickAdd choices/Good.md", name: "Good" }),
    ]);
    assert.equal(result.choices.length, 1);
    assert.equal(result.choices[0].name, "Good");
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /could not resolve "\[\[nope\]\]"/);
  });

  test("a step of an unsupported kind (Stage B+ territory) fails only that note with a clear message", () => {
    const result = transformChoices([
      macroInput({
        notePath: "QuickAdd choices/NotYet.md",
        name: "NotYet",
        steps: [{ kind: "unsupported", ok: false, declaredKind: "wait" }],
      }),
      macroInput({ notePath: "QuickAdd choices/Good.md", name: "Good" }),
    ]);
    assert.equal(result.choices.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /unsupported step kind "wait"/);
    assert.match(result.errors[0].message, /only "userscript" is implemented/);
  });

  test("an empty input array produces an empty result, not an error", () => {
    const result = transformChoices([]);
    assert.deepEqual(result, { choices: [], errors: [] });
  });
});
