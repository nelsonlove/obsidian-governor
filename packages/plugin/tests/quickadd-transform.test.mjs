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

function choiceStep(overrides = {}) {
  return { kind: "choice", ok: true, choiceId: "qan:Choices/Target.md#choice", ...overrides };
}

function waitStep(overrides = {}) {
  return { kind: "wait", ok: true, timeMs: 100, ...overrides };
}

function obsidianCommandStep(overrides = {}) {
  return { kind: "obsidian-command", ok: true, commandId: "obsidian-linter:lint-file-unless-ignored", displayName: "Linter: Lint the current file unless ignored", ...overrides };
}

function editorCommandStep(overrides = {}) {
  return { kind: "editor-command", ok: true, editorCommandType: "Copy", ...overrides };
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
        steps: [{ kind: "unsupported", ok: false, declaredKind: "nested-choice" }],
      }),
      macroInput({ notePath: "QuickAdd choices/Good.md", name: "Good" }),
    ]);
    assert.equal(result.choices.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /unsupported step kind "nested-choice"/);
    assert.match(result.errors[0].message, /only "userscript", "choice", "wait", "obsidian-command", "editor-command" are implemented/);
  });

  test("an empty input array produces an empty result, not an error", () => {
    const result = transformChoices([]);
    assert.deepEqual(result, { choices: [], errors: [] });
  });
});

describe("transformChoices — choice step", () => {
  test("compiles to a QuickAdd Choice command with the resolved choiceId", () => {
    const result = transformChoices([macroInput({ steps: [choiceStep()] })]);
    assert.deepEqual(result.errors, []);
    const cmd = result.choices[0].macro.commands[0];
    assert.equal(cmd.type, "Choice");
    assert.equal(cmd.choiceId, "qan:Choices/Target.md#choice");
    assert.equal(cmd.id, deriveStepId("QuickAdd choices/Stamp title.md", 0));
  });

  test("a failed choice-link resolution fails only that note", () => {
    const result = transformChoices([
      macroInput({ notePath: "QuickAdd choices/Bad.md", name: "Bad", steps: [choiceStep({ ok: false, error: 'could not resolve "[[nope]]".', choiceId: undefined })] }),
      macroInput({ notePath: "QuickAdd choices/Good.md", name: "Good" }),
    ]);
    assert.equal(result.choices.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /could not resolve "\[\[nope\]\]"/);
  });
});

describe("transformChoices — wait step", () => {
  test("compiles to a QuickAdd Wait command carrying time", () => {
    const result = transformChoices([macroInput({ steps: [waitStep({ timeMs: 250 })] })]);
    assert.deepEqual(result.errors, []);
    const cmd = result.choices[0].macro.commands[0];
    assert.equal(cmd.type, "Wait");
    assert.equal(cmd.time, 250);
    assert.equal(cmd.name, "Wait");
  });
});

describe("transformChoices — obsidian-command step", () => {
  test("compiles to a QuickAdd Obsidian command with commandId and the resolved display name", () => {
    const result = transformChoices([macroInput({ steps: [obsidianCommandStep()] })]);
    assert.deepEqual(result.errors, []);
    const cmd = result.choices[0].macro.commands[0];
    assert.equal(cmd.type, "Obsidian");
    assert.equal(cmd.commandId, "obsidian-linter:lint-file-unless-ignored");
    assert.equal(cmd.name, "Linter: Lint the current file unless ignored");
  });

  test("an unresolvable command id fails only that note", () => {
    const result = transformChoices([
      macroInput({ notePath: "QuickAdd choices/Bad.md", name: "Bad", steps: [obsidianCommandStep({ ok: false, error: 'no registered command "nope:nothing".', commandId: undefined, displayName: undefined })] }),
      macroInput({ notePath: "QuickAdd choices/Good.md", name: "Good" }),
    ]);
    assert.equal(result.choices.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /no registered command "nope:nothing"/);
  });
});

describe("transformChoices — editor-command step", () => {
  test("compiles to a QuickAdd EditorCommand command", () => {
    const result = transformChoices([macroInput({ steps: [editorCommandStep({ editorCommandType: "Paste with format" })] })]);
    assert.deepEqual(result.errors, []);
    const cmd = result.choices[0].macro.commands[0];
    assert.equal(cmd.type, "EditorCommand");
    assert.equal(cmd.editorCommandType, "Paste with format");
    assert.equal(cmd.name, "Paste with format");
  });
});

describe("transformChoices — mixed multi-step macro (the real motivating case)", () => {
  test("Choice + Wait + Obsidian compiles in order, matching 'Validate UID and lint note'", () => {
    const result = transformChoices([
      macroInput({
        steps: [
          choiceStep({ choiceId: "qan:Choices/Add UID.md#choice" }),
          waitStep({ timeMs: 100 }),
          obsidianCommandStep({ commandId: "obsidian-linter:lint-file-unless-ignored", displayName: "Linter: Lint the current file unless ignored" }),
        ],
      }),
    ]);
    assert.deepEqual(result.errors, []);
    const cmds = result.choices[0].macro.commands;
    assert.deepEqual(cmds.map((c) => c.type), ["Choice", "Wait", "Obsidian"]);
  });
});

describe("transformChoices — nested-choice and ai-assistant stay unsupported (deferred, not regressed)", () => {
  test("a nested-choice step still fails as unsupported", () => {
    const result = transformChoices([
      macroInput({ steps: [{ kind: "unsupported", ok: false, declaredKind: "nested-choice" }] }),
    ]);
    assert.equal(result.choices.length, 0);
    assert.match(result.errors[0].message, /unsupported step kind "nested-choice"/);
  });

  test("an ai-assistant step still fails as unsupported", () => {
    const result = transformChoices([
      macroInput({ steps: [{ kind: "unsupported", ok: false, declaredKind: "ai-assistant" }] }),
    ]);
    assert.equal(result.choices.length, 0);
    assert.match(result.errors[0].message, /unsupported step kind "ai-assistant"/);
  });
});
