import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  transformChoices,
  detectChoiceCycles,
  deriveChoiceId,
  deriveMacroId,
  deriveStepId,
  isCompilerOwnedId,
} from "../src/kernel/quickadd/transform.ts";

function userscriptStep(overrides = {}) {
  return { kind: "userscript", ok: true, scriptPath: "Scripts/stamp-title.md", settings: {}, ...overrides };
}

function choiceStep(overrides = {}) {
  return { kind: "choice", ok: true, choiceId: "qan:Choices/Target.md#choice", displayName: "Target", ...overrides };
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

function templateInput(overrides = {}) {
  return {
    notePath: "QuickAdd choices/Daily Note.md",
    quickaddType: "template",
    name: "Daily Note",
    template: { ok: true, templatePath: "Templates/Daily.md" },
    folder: undefined,
    fileNameFormat: undefined,
    openFile: false,
    ...overrides,
  };
}

function captureInput(overrides = {}) {
  return {
    notePath: "QuickAdd choices/Log entry.md",
    quickaddType: "capture",
    name: "Log entry",
    target: { ok: true, captureTo: "Journal/Log.md" },
    prepend: false,
    task: false,
    insertAfterHeading: undefined,
    createIfMissing: false,
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

  test("the command's name is the TARGET choice's display name, never the literal \"Choice\"", () => {
    const result = transformChoices([
      macroInput({ steps: [choiceStep({ choiceId: "qan:Choices/Add UID.md#choice", displayName: "Add UID to current note" })] }),
    ]);
    assert.deepEqual(result.errors, []);
    const cmd = result.choices[0].macro.commands[0];
    // QuickAdd logs `choice '<name>' could not be found.` on a dangling
    // reference — a generic label would name nothing useful there.
    assert.equal(cmd.name, "Add UID to current note");
    assert.notEqual(cmd.name, "Choice");
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

describe("transformChoices — multi-note reference cycles", () => {
  const cyclePair = () => [
    macroInput({
      notePath: "Choices/A.md",
      name: "A",
      steps: [choiceStep({ choiceId: deriveChoiceId("Choices/B.md"), displayName: "B" })],
    }),
    macroInput({
      notePath: "Choices/B.md",
      name: "B",
      steps: [choiceStep({ choiceId: deriveChoiceId("Choices/A.md"), displayName: "A" })],
    }),
  ];

  test("a two-note cycle (A → B → A) fails BOTH notes and compiles neither", () => {
    const result = transformChoices(cyclePair());
    assert.equal(result.choices.length, 0);
    assert.equal(result.errors.length, 2);
    assert.deepEqual(result.errors.map((e) => e.notePath).sort(), ["Choices/A.md", "Choices/B.md"]);
    for (const e of result.errors) {
      // Distinguishable from the single-note self-reference message.
      assert.match(e.message, /reference cycle/i);
      assert.doesNotMatch(e.message, /same note/i);
      assert.match(e.message, /Choices\/A\.md/);
      assert.match(e.message, /Choices\/B\.md/);
      assert.match(e.message, /loop forever/i);
    }
  });

  test("an unrelated note still compiles while a cycle beside it fails", () => {
    const result = transformChoices([
      ...cyclePair(),
      macroInput({ notePath: "Choices/Fine.md", name: "Fine" }),
    ]);
    assert.deepEqual(result.choices.map((c) => c.name), ["Fine"]);
    assert.equal(result.errors.length, 2);
  });

  test("a three-note cycle (A → B → C → A) fails all three", () => {
    const link = (from, to) =>
      macroInput({
        notePath: `Choices/${from}.md`,
        name: from,
        steps: [choiceStep({ choiceId: deriveChoiceId(`Choices/${to}.md`), displayName: to })],
      });
    const result = transformChoices([link("A", "B"), link("B", "C"), link("C", "A")]);
    assert.equal(result.choices.length, 0);
    assert.deepEqual(result.errors.map((e) => e.notePath).sort(), [
      "Choices/A.md",
      "Choices/B.md",
      "Choices/C.md",
    ]);
  });

  test("a chain with no cycle (A → B → C) compiles all three", () => {
    const result = transformChoices([
      macroInput({ notePath: "Choices/A.md", name: "A", steps: [choiceStep({ choiceId: deriveChoiceId("Choices/B.md") })] }),
      macroInput({ notePath: "Choices/B.md", name: "B", steps: [choiceStep({ choiceId: deriveChoiceId("Choices/C.md") })] }),
      macroInput({ notePath: "Choices/C.md", name: "C" }),
    ]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.choices.length, 3);
  });

  test("a dangling reference (target never compiled) is not a cycle and still compiles", () => {
    const result = transformChoices([
      macroInput({ notePath: "Choices/A.md", name: "A", steps: [choiceStep({ choiceId: deriveChoiceId("Choices/Nowhere.md") })] }),
    ]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.choices.length, 1);
  });
});

describe("detectChoiceCycles", () => {
  const choice = (path, targets = []) => ({
    id: deriveChoiceId(path),
    name: path,
    type: "Macro",
    command: true,
    runOnStartup: false,
    macro: {
      name: path,
      id: deriveMacroId(path),
      commands: targets.map((t, i) => ({
        id: deriveStepId(path, i),
        name: t,
        type: "Choice",
        choiceId: deriveChoiceId(t),
      })),
    },
  });

  test("no edges at all ⇒ no cycles", () => {
    assert.deepEqual(detectChoiceCycles([choice("A.md"), choice("B.md")]), []);
  });

  test("a two-node cycle is reported as one group naming both ids", () => {
    const cycles = detectChoiceCycles([choice("A.md", ["B.md"]), choice("B.md", ["A.md"])]);
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0].sort(), [deriveChoiceId("A.md"), deriveChoiceId("B.md")]);
  });

  test("a self-edge is a cycle of one", () => {
    const cycles = detectChoiceCycles([choice("A.md", ["A.md"])]);
    assert.deepEqual(cycles, [[deriveChoiceId("A.md")]]);
  });

  test("two disjoint cycles are reported as two groups", () => {
    const cycles = detectChoiceCycles([
      choice("A.md", ["B.md"]),
      choice("B.md", ["A.md"]),
      choice("C.md", ["D.md"]),
      choice("D.md", ["C.md"]),
    ]);
    assert.equal(cycles.length, 2);
    assert.equal(cycles.flat().length, 4);
  });

  test("a node pointing INTO a cycle without being in it is not reported", () => {
    const cycles = detectChoiceCycles([
      choice("Entry.md", ["A.md"]),
      choice("A.md", ["B.md"]),
      choice("B.md", ["A.md"]),
    ]);
    assert.deepEqual(cycles.flat().sort(), [deriveChoiceId("A.md"), deriveChoiceId("B.md")]);
  });

  test("output is stable regardless of input order", () => {
    const a = choice("A.md", ["B.md"]);
    const b = choice("B.md", ["A.md"]);
    assert.deepEqual(detectChoiceCycles([a, b]), detectChoiceCycles([b, a]));
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

describe("transformChoices — Template", () => {
  test("compiles a minimal Template choice using QuickAdd's own defaults for every unexposed field", () => {
    const result = transformChoices([templateInput()]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.choices.length, 1);
    const choice = result.choices[0];
    assert.equal(choice.type, "Template");
    assert.equal(choice.command, true);
    assert.equal(choice.templatePath, "Templates/Daily.md");
    assert.deepEqual(choice.folder, {
      enabled: false, folders: [], chooseWhenCreatingNote: false,
      createInSameFolderAsActiveFile: false, chooseFromSubfolders: false,
    });
    assert.deepEqual(choice.fileNameFormat, { enabled: false, format: "" });
    assert.equal(choice.openFile, false);
    assert.equal(choice.discoverExistingNotesBeforeCreate, false);
    assert.equal(choice.appendLink, false);
    assert.deepEqual(choice.fileOpening, { location: "tab", direction: "vertical", mode: "default", focus: true });
    assert.deepEqual(choice.fileExistsBehavior, { kind: "prompt" });
  });

  test("compiles folder/fileNameFormat/openFile when the note sets them", () => {
    const result = transformChoices([templateInput({ folder: "Journal/Daily", fileNameFormat: "{{DATE}} note", openFile: true })]);
    const choice = result.choices[0];
    assert.deepEqual(choice.folder.folders, ["Journal/Daily"]);
    assert.equal(choice.folder.enabled, true);
    assert.deepEqual(choice.fileNameFormat, { enabled: true, format: "{{DATE}} note" });
    assert.equal(choice.openFile, true);
  });

  test("a Template note whose template: wikilink failed to resolve fails only that note", () => {
    const result = transformChoices([
      templateInput({ template: { ok: false, error: 'could not resolve "[[Missing]]".' } }),
    ]);
    assert.equal(result.choices.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /could not resolve/);
  });
});

describe("transformChoices — Capture", () => {
  test("compiles a minimal Capture choice using QuickAdd's own defaults for every unexposed field", () => {
    const result = transformChoices([captureInput()]);
    assert.equal(result.errors.length, 0);
    const choice = result.choices[0];
    assert.equal(choice.type, "Capture");
    assert.equal(choice.command, true);
    assert.equal(choice.captureTo, "Journal/Log.md");
    assert.equal(choice.prepend, false);
    assert.equal(choice.task, false);
    assert.deepEqual(choice.insertAfter, {
      enabled: false, after: "", insertAtEnd: false, considerSubsections: false,
      createIfNotFound: false, createIfNotFoundLocation: "top", inline: false,
      replaceExisting: false, blankLineAfterMatchMode: "auto", promptHeading: false,
    });
    assert.deepEqual(choice.createFileIfItDoesntExist, { enabled: false, createWithTemplate: false, template: "" });
    assert.equal(choice.activeFileWritePosition, "cursor");
    assert.deepEqual(choice.templater, { afterCapture: "none" });
  });

  test("compiles prepend/task/insertAfterHeading/createIfMissing when the note sets them", () => {
    const result = transformChoices([
      captureInput({ prepend: true, task: true, insertAfterHeading: "## Inbox", createIfMissing: true }),
    ]);
    const choice = result.choices[0];
    assert.equal(choice.prepend, true);
    assert.equal(choice.task, true);
    assert.equal(choice.insertAfter.enabled, true);
    assert.equal(choice.insertAfter.after, "## Inbox");
    assert.equal(choice.createFileIfItDoesntExist.enabled, true);
  });

  test("a dynamic (non-wikilink) target: string is used verbatim as captureTo", () => {
    const result = transformChoices([
      captureInput({ target: { ok: true, captureTo: "Journal/{{DATE:YYYY-MM-DD}}.md" } }),
    ]);
    assert.equal(result.choices[0].captureTo, "Journal/{{DATE:YYYY-MM-DD}}.md");
  });

  test("a Capture note whose target: failed to resolve fails only that note", () => {
    const result = transformChoices([
      captureInput({ target: { ok: false, error: 'could not resolve "[[Missing]]".' } }),
    ]);
    assert.equal(result.choices.length, 0);
    assert.equal(result.errors.length, 1);
  });
});

describe("transformChoices — mixed Macro/Template/Capture in one compile", () => {
  test("a failure in one choice type doesn't affect the others", () => {
    const result = transformChoices([
      macroInput(),
      templateInput({ notePath: "Choices/Broken.md", name: "Broken", template: { ok: false, error: "boom" } }),
      captureInput({ notePath: "Choices/Good.md", name: "Good" }),
    ]);
    assert.equal(result.choices.length, 2);
    assert.equal(result.errors.length, 1);
    assert.ok(result.choices.some((c) => c.type === "Macro"));
    assert.ok(result.choices.some((c) => c.type === "Capture"));
  });
});
