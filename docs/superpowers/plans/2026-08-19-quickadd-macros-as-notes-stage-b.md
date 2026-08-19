# QuickAdd Macros as Notes — Stage B (Choice/Wait/Obsidian-command/Editor-command steps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the already-shipped Stage A compiler (`obsidian_quickadd_compile`) to support four more Macro step kinds — `choice`, `wait`, `obsidian-command`, `editor-command` — so a choice note can express the same step sequences the vault's hand-authored macros already use (e.g. "Validate UID and lint note": Choice → Wait → Obsidian).

**Architecture:** Same split as Stage A — the pure transform (`kernel/quickadd/transform.ts`) grows a per-kind branch instead of assuming every step is `userscript`; the glue layer (`mcp/tools-quickadd.ts`) grows one resolver function per new kind, each following the exact shape `resolveUserScriptStep` already established (parse frontmatter, resolve any reference, return an `Ok`/`Failed` result — never throw).

**Tech Stack:** TypeScript, `node --import tsx --test`, same MCP tool (`obsidian_quickadd_compile`) — this plan extends it, doesn't add a new one.

**Spec:** `docs/superpowers/specs/2026-08-18-quickadd-macros-as-notes-design.md` — this plan implements 4 of the spec's 7 listed Macro step kinds. **Two are deliberately deferred, with reasons discovered while writing this plan (not in the original spec):**

- **`nested-choice`** — the spec assumed "a list of wikilinks, presented as a runtime picker." Checked against QuickAdd's actual source (`main.js`): a `NestedChoice` command carries a single `choice` field holding an **entire embedded choice object** (`t.type==="NestedChoice" ? e(t.choice) : …`), typically an inline `Multi` choice with its own nested `choices` array. That's a recursive sub-tree, not a flat list — modeling it means designing a recursive note-or-inline-embed schema, real scope beyond "one more step kind." Deferred to its own future stage.
- **`ai-assistant`** — a fundamentally different risk profile from the other six: it sends note content to an external AI provider over the network (confirmed in QuickAdd's own source — a UI flag literally reads `"Sends note content to your AI provider over the network"`), carries prompt/model/API-key configuration, and costs money per invocation. Compiling this from a note deserves its own design pass (What gets validated? Is a note allowed to name a model/cost tier? Does compiling silently enable network calls?), not a leaf case folded into a step-kind extension. Deferred to its own future stage.

Both remain listed in `kernel/quickadd/types.ts`'s `UnsupportedStep` path exactly as Stage A left them — a note using either kind still gets a clear per-choice error (`unsupported step kind "nested-choice"` / `"ai-assistant"`), never a silent skip or a crash.

## Global Constraints

- Pure transform code lives under `kernel/`, imports nothing from `obsidian` (repo-wide rule, packages/plugin/CLAUDE.md) — unchanged from Stage A.
- Every new step kind follows the EXACT `Ok`/`Failed` pattern `UserScriptStepOk`/`UserScriptStepFailed` already established in `types.ts` — a `kind` discriminant, `ok: true|false`, and on `ok: false` an `error: string` surfaced verbatim in the resulting `ChoiceError` message. No new error-reporting shape.
- Wikilink resolution (the `choice` step's target) happens ONLY in the glue layer, via the SAME `linkTarget()` + `app.metadataCache.getFirstLinkpathDest()` mechanism `resolveUserScriptStep` already uses — do not reimplement wikilink parsing.
- One malformed step still fails only that choice note (never the whole compile) — unchanged Stage A discipline, `transformOne` returns `{ok: false, message}` for the whole choice on the first bad step, same as today.
- The tool's own description string (in `tools-quickadd.ts`) says "Stage A: Macro choices whose steps are all UserScript" — this plan's Task 2 updates that sentence to name the now-larger supported set, so the tool's self-description stays accurate.
- No changes to the scoped-merge, mass-removal guard, `dry_run` diff shape, or command-registration logic — Stage B only widens what `transformChoices` can compile; everything downstream of `TransformResult` in `tools-quickadd.ts` is untouched.

## Real QuickAdd native shapes (verified against the live vault's `data.json` and QuickAdd's own `main.js` — not guessed)

```json
{"id": "...", "name": "Add UID to current note", "type": "Choice", "choiceId": "e7007618-12df-4fab-91bb-5dbf4c7809d0"}
{"id": "...", "name": "Wait", "type": "Wait", "time": 100}
{"id": "...", "name": "Linter: Lint the current file unless ignored", "type": "Obsidian", "commandId": "obsidian-linter:lint-file-unless-ignored"}
{"id": "...", "name": "Copy", "type": "EditorCommand", "editorCommandType": "Copy"}
```

`editorCommandType`'s full fixed enum (confirmed by reading QuickAdd's `executeEditorCommand` switch statement in full — there is no seventh value):
`"Cut" | "Copy" | "Paste" | "Paste with format" | "Select active line" | "Select link on active line" | "Move cursor to file start" | "Move cursor to file end" | "Move cursor to line start" | "Move cursor to line end"`

## Choice note frontmatter shapes this plan adds

```yaml
steps:
  - kind: choice
    choice: "[[Add UID to current note]]"   # wikilink to another top-level choice note
  - kind: wait
    time: 100                                 # ms; optional, defaults to 100 (QuickAdd's own UI default)
  - kind: obsidian-command
    command_id: "obsidian-linter:lint-file-unless-ignored"
  - kind: editor-command
    editor_command: "Copy"                    # must be one of the 10 known values above
```

---

### Task 1: Extend the pure transform — types and per-kind command building

**Files:**
- Modify: `packages/plugin/src/kernel/quickadd/types.ts`
- Modify: `packages/plugin/src/kernel/quickadd/transform.ts`
- Modify: `packages/plugin/tests/quickadd-transform.test.mjs`

**Interfaces:**
- Consumes: nothing new — extends Stage A's existing `deriveStepId`/`deriveChoiceId`/`deriveMacroId`/`isCompilerOwnedId` (unchanged, reused as-is for the new step kinds' `id` fields).
- Produces (consumed by Task 2): the widened `MacroStepResolved` union (adds `ChoiceStepOk`/`ChoiceStepFailed`/`WaitStepOk`/`WaitStepFailed`/`ObsidianCommandStepOk`/`ObsidianCommandStepFailed`/`EditorCommandStepOk`/`EditorCommandStepFailed`/`EditorCommandType`), and `transformChoices`'s widened output (unchanged signature — `QuickAddMacro.commands` becomes a union type, but the function's own type signature `(inputs: ChoiceNoteInput[]) => TransformResult` is unchanged).

- [ ] **Step 1: Write the failing tests**

```javascript
// Append to packages/plugin/tests/quickadd-transform.test.mjs — add these describe blocks
// after the existing ones. Keep the existing imports and helper functions
// (userscriptStep, macroInput) exactly as they are; add these new helpers
// alongside them:

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: FAIL — the new step kinds aren't in `MacroStepResolved` yet, and `transformOne` doesn't build `Choice`/`Wait`/`Obsidian`/`EditorCommand` commands.

- [ ] **Step 3: Extend types.ts**

Add these interfaces to `packages/plugin/src/kernel/quickadd/types.ts`, right after the existing `UserScriptStepFailed` interface (before `UnsupportedStep`):

```typescript
/** A Choice step whose `choice:` wikilink resolved to another choice note.
 *  `choiceId` is that note's OWN compiler-owned id (deriveChoiceId of the
 *  resolved note path) — computed directly by the glue layer without
 *  waiting for that note to be compiled itself, since ids are a pure
 *  function of note path. Whether the referenced note actually compiles
 *  into a valid choice is NOT checked here — same discipline QuickAdd's
 *  own data.json uses (choiceId is just a stored reference; a dangling one
 *  fails at RUN time, not compile time). */
export interface ChoiceStepOk {
  kind: "choice";
  ok: true;
  choiceId: string;
}
export interface ChoiceStepFailed {
  kind: "choice";
  ok: false;
  error: string;
}

/** A Wait step — a bare pause, `timeMs` in milliseconds. */
export interface WaitStepOk {
  kind: "wait";
  ok: true;
  timeMs: number;
}
export interface WaitStepFailed {
  kind: "wait";
  ok: false;
  error: string;
}

/** An Obsidian-command step. `displayName` is the CURRENTLY-registered
 *  command's own name (resolved by the glue layer via
 *  `app.commands.commands[commandId]?.name`), matching what QuickAdd's own
 *  UI does when a human adds this step type — never a separately-typed
 *  frontmatter field that could drift from the real command name. */
export interface ObsidianCommandStepOk {
  kind: "obsidian-command";
  ok: true;
  commandId: string;
  displayName: string;
}
export interface ObsidianCommandStepFailed {
  kind: "obsidian-command";
  ok: false;
  error: string;
}

/** QuickAdd's fixed, closed set of built-in editor actions — verified
 *  exhaustively against QuickAdd's own `executeEditorCommand` switch
 *  statement in main.js. There is no user-extensible variant of this step
 *  kind; a value outside this set is a per-choice error, never passed
 *  through. */
export type EditorCommandType =
  | "Cut"
  | "Copy"
  | "Paste"
  | "Paste with format"
  | "Select active line"
  | "Select link on active line"
  | "Move cursor to file start"
  | "Move cursor to file end"
  | "Move cursor to line start"
  | "Move cursor to line end";

export interface EditorCommandStepOk {
  kind: "editor-command";
  ok: true;
  editorCommandType: EditorCommandType;
}
export interface EditorCommandStepFailed {
  kind: "editor-command";
  ok: false;
  error: string;
}
```

Then widen the `MacroStepResolved` union (replace the existing line):

```typescript
export type MacroStepResolved =
  | UserScriptStepOk
  | UserScriptStepFailed
  | ChoiceStepOk
  | ChoiceStepFailed
  | WaitStepOk
  | WaitStepFailed
  | ObsidianCommandStepOk
  | ObsidianCommandStepFailed
  | EditorCommandStepOk
  | EditorCommandStepFailed
  | UnsupportedStep;
```

Add the new native QuickAdd command shapes, right after `QuickAddUserScriptCommand`:

```typescript
export interface QuickAddChoiceCommand {
  id: string;
  name: string;
  type: "Choice";
  choiceId: string;
}

export interface QuickAddWaitCommand {
  id: string;
  name: string;
  type: "Wait";
  time: number;
}

export interface QuickAddObsidianCommand {
  id: string;
  name: string;
  type: "Obsidian";
  commandId: string;
}

export interface QuickAddEditorCommand {
  id: string;
  name: string;
  type: "EditorCommand";
  editorCommandType: EditorCommandType;
}
```

Widen `QuickAddMacro.commands` (replace the existing field's type):

```typescript
export interface QuickAddMacro {
  name: string;
  id: string;
  commands: Array<
    QuickAddUserScriptCommand | QuickAddChoiceCommand | QuickAddWaitCommand | QuickAddObsidianCommand | QuickAddEditorCommand
  >;
}
```

- [ ] **Step 4: Extend transform.ts's per-step command building**

In `packages/plugin/src/kernel/quickadd/transform.ts`, update the import line to pull in the new types:

```typescript
import type {
  ChoiceNoteInput,
  ChoiceError,
  QuickAddMacroChoice,
  QuickAddUserScriptCommand,
  QuickAddChoiceCommand,
  QuickAddWaitCommand,
  QuickAddObsidianCommand,
  QuickAddEditorCommand,
  TransformResult,
} from "./types.js";
```

Replace the `commands` array's type and the step-processing loop body inside `transformOne` (the `const commands: QuickAddUserScriptCommand[] = [];` line and the `for` loop under it) with:

```typescript
  type Command = QuickAddUserScriptCommand | QuickAddChoiceCommand | QuickAddWaitCommand | QuickAddObsidianCommand | QuickAddEditorCommand;
  const commands: Command[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    const id = deriveStepId(input.notePath, i);

    if (step.kind === "unsupported") {
      return {
        ok: false,
        message:
          `Macro "${input.name}" (${input.notePath}) step ${i + 1} has unsupported step kind ` +
          `"${step.declaredKind}" (only "userscript", "choice", "wait", "obsidian-command", "editor-command" are implemented).`,
      };
    }

    if (!step.ok) {
      return {
        ok: false,
        message: `Macro "${input.name}" (${input.notePath}) step ${i + 1}: ${step.error}`,
      };
    }

    switch (step.kind) {
      case "userscript":
        commands.push({ id, name: step.scriptPath, type: "UserScript", path: step.scriptPath, settings: step.settings });
        break;
      case "choice":
        commands.push({ id, name: "Choice", type: "Choice", choiceId: step.choiceId });
        break;
      case "wait":
        commands.push({ id, name: "Wait", type: "Wait", time: step.timeMs });
        break;
      case "obsidian-command":
        commands.push({ id, name: step.displayName, type: "Obsidian", commandId: step.commandId });
        break;
      case "editor-command":
        commands.push({ id, name: step.editorCommandType, type: "EditorCommand", editorCommandType: step.editorCommandType });
        break;
    }
  }
```

(The error message's "only ... are implemented" list changed to name all 5 now-supported kinds — update the string exactly as shown, since a test may reasonably match against it later, and it's user-facing.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: PASS — all tests green, including the pre-existing Stage A tests (unchanged, must still pass).

- [ ] **Step 6: Typecheck**

Run: `cd packages/plugin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin/src/kernel/quickadd/ packages/plugin/tests/quickadd-transform.test.mjs
git commit -m "feat(kernel): Stage B step kinds — choice, wait, obsidian-command, editor-command"
```

---

### Task 2: Extend the glue layer — resolvers for the 4 new step kinds

**Files:**
- Modify: `packages/plugin/src/mcp/tools-quickadd.ts`
- Modify: `packages/plugin/tests/quickadd-compile-tool.test.mjs`

**Interfaces:**
- Consumes: the widened `MacroStepResolved` union from Task 1 (`ChoiceStepOk/Failed`, `WaitStepOk/Failed`, `ObsidianCommandStepOk/Failed`, `EditorCommandStepOk/Failed`, `EditorCommandType`).
- Produces: nothing new consumed elsewhere — `registerQuickAddTools`'s exported signature is unchanged; this task only widens what `collectChoiceNotes` can resolve.

- [ ] **Step 1: Write the failing tests**

```javascript
// Add to packages/plugin/tests/quickadd-compile-tool.test.mjs. The existing
// `macroNote(path, name, scriptLink)` helper builds a single userscript
// step; add this more general helper alongside it (keep macroNote as-is,
// other existing tests depend on it):

function macroNoteWithSteps(path, name, steps) {
  return { path, frontmatter: { "quickadd-type": "macro", name, steps } };
}

// The existing `build()` helper's fake `app` needs `app.commands.commands`
// for the obsidian-command resolver to look up a display name. Find the
// `build({ notes = [], links = {}, existingChoices = [] } = {})` function
// and extend its destructured options to accept a `commands` map (id ->
// name), defaulting to `{}`, then add `commands: { commands }` to the
// returned fake `app` object (alongside the existing `vault`,
// `metadataCache`, `plugins` keys) — e.g. `app.commands.commands = {
// "obsidian-linter:lint-file-unless-ignored": { name: "Linter: Lint the
// current file unless ignored" } }`. This mirrors the real Obsidian shape
// (`app.commands.commands` is a plain id-keyed object of `{name, ...}`).

describe("obsidian_quickadd_compile: choice step", () => {
  test("resolves a choice: wikilink to the target note's derived choiceId", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Outer.md", "Outer", [{ kind: "choice", choice: "[[Inner]]" }]),
        macroNote("Choices/Inner.md", "Inner", "some-script"),
      ],
      links: { "Inner": "Choices/Inner.md", "some-script": "Scripts/some-script.md" },
    });
    const res = await handler({ dry_run: true });
    const outer = res.structuredContent.choices.find((c) => c.name === "Outer");
    assert.equal(outer.macro.commands[0].type, "Choice");
    assert.match(outer.macro.commands[0].choiceId, /^qan:Choices\/Inner\.md#choice$/);
  });

  test("an unresolvable choice: link is a per-note error", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/Bad.md", "Bad", [{ kind: "choice", choice: "[[Nope]]" }])],
      links: {},
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /could not resolve/);
  });
});

describe("obsidian_quickadd_compile: wait step", () => {
  test("time: defaults to 100 when omitted", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait" }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 100);
  });

  test("an explicit time: is used as-is", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: 500 }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 500);
  });

  test("a negative or non-numeric time: is a per-note error", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: -5 }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /time/i);
  });
});

describe("obsidian_quickadd_compile: obsidian-command step", () => {
  test("resolves command_id to the currently-registered command's display name", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/O.md", "O", [{ kind: "obsidian-command", command_id: "obsidian-linter:lint-file-unless-ignored" }])],
      commands: { "obsidian-linter:lint-file-unless-ignored": "Linter: Lint the current file unless ignored" },
    });
    const res = await handler({ dry_run: true });
    const cmd = res.structuredContent.choices[0].macro.commands[0];
    assert.equal(cmd.type, "Obsidian");
    assert.equal(cmd.commandId, "obsidian-linter:lint-file-unless-ignored");
    assert.equal(cmd.name, "Linter: Lint the current file unless ignored");
  });

  test("an unregistered command_id is a per-note error", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/O.md", "O", [{ kind: "obsidian-command", command_id: "nope:nothing" }])],
      commands: {},
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /nope:nothing/);
  });
});

describe("obsidian_quickadd_compile: editor-command step", () => {
  test("a known editor_command value compiles", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/E.md", "E", [{ kind: "editor-command", editor_command: "Copy" }])] });
    const res = await handler({ dry_run: true });
    const cmd = res.structuredContent.choices[0].macro.commands[0];
    assert.equal(cmd.type, "EditorCommand");
    assert.equal(cmd.editorCommandType, "Copy");
  });

  test("an unknown editor_command value is a per-note error naming the value", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/E.md", "E", [{ kind: "editor-command", editor_command: "Not A Real One" }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /Not A Real One/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: FAIL — `collectChoiceNotes` doesn't recognize the new `kind` values yet (they fall through to `resolveUserScriptStep`'s `"unsupported"` path).

- [ ] **Step 3: Add the 4 new resolver functions**

In `packages/plugin/src/mcp/tools-quickadd.ts`, update the type import to include the new step types:

```typescript
import type { ChoiceNoteInput, MacroStepResolved, QuickAddMacroChoice, EditorCommandType } from "../kernel/quickadd/types.js";
```

Add this constant right after the `linkTarget` function (the known, closed set of editor command values — verified exhaustively against QuickAdd's source, see the plan's Global Constraints section):

```typescript
const EDITOR_COMMAND_TYPES: ReadonlySet<EditorCommandType> = new Set([
  "Cut", "Copy", "Paste", "Paste with format",
  "Select active line", "Select link on active line",
  "Move cursor to file start", "Move cursor to file end",
  "Move cursor to line start", "Move cursor to line end",
]);
```

Add these 4 resolver functions right after `resolveUserScriptStep`:

```typescript
function resolveChoiceStep(app: App, notePath: string, step: any): MacroStepResolved {
  const raw = String(step.choice ?? "");
  const target = linkTarget(raw);
  if (target === null) {
    return { kind: "choice", ok: false, error: `"${raw}" is not a [[wikilink]].` };
  }
  const dest = app.metadataCache.getFirstLinkpathDest(target, notePath);
  if (!dest) {
    return { kind: "choice", ok: false, error: `could not resolve "${raw}".` };
  }
  // The referenced note's compiled id is a pure function of its path — no
  // need to wait for that note to be compiled in this same run. Whether it
  // actually compiles into a valid choice is unchecked (see types.ts's
  // ChoiceStepOk doc comment).
  return { kind: "choice", ok: true, choiceId: `qan:${dest.path}#choice` };
}

function resolveWaitStep(_app: App, _notePath: string, step: any): MacroStepResolved {
  const raw = step.time;
  const timeMs = raw === undefined ? 100 : Number(raw);
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    return { kind: "wait", ok: false, error: `"time" must be a non-negative number, got ${JSON.stringify(raw)}.` };
  }
  return { kind: "wait", ok: true, timeMs };
}

function resolveObsidianCommandStep(app: App, _notePath: string, step: any): MacroStepResolved {
  const commandId = String(step.command_id ?? "");
  if (!commandId) {
    return { kind: "obsidian-command", ok: false, error: `"command_id" is missing or empty.` };
  }
  // app.commands is not in the public obsidian types — cast required.
  const registered = (app as any).commands?.commands?.[commandId];
  const displayName = registered?.name;
  if (typeof displayName !== "string") {
    return { kind: "obsidian-command", ok: false, error: `no registered command "${commandId}".` };
  }
  return { kind: "obsidian-command", ok: true, commandId, displayName };
}

function resolveEditorCommandStep(_app: App, _notePath: string, step: any): MacroStepResolved {
  const value = String(step.editor_command ?? "");
  if (!EDITOR_COMMAND_TYPES.has(value as EditorCommandType)) {
    return {
      kind: "editor-command",
      ok: false,
      error: `"${value}" is not a recognized editor_command (expected one of: ${[...EDITOR_COMMAND_TYPES].join(", ")}).`,
    };
  }
  return { kind: "editor-command", ok: true, editorCommandType: value as EditorCommandType };
}
```

Replace `resolveUserScriptStep`'s dispatch: find the line `const steps = rawSteps.map((s) => resolveUserScriptStep(app, file.path, s));` inside `collectChoiceNotes` and replace it with:

```typescript
    const steps = rawSteps.map((s) => resolveStep(app, file.path, s));
```

Then add this dispatcher function right after `resolveUserScriptStep` (before the 4 new resolvers, or after — order doesn't matter, just keep it out of `collectChoiceNotes`):

```typescript
function resolveStep(app: App, notePath: string, step: any): MacroStepResolved {
  switch (step?.kind) {
    case "userscript": return resolveUserScriptStep(app, notePath, step);
    case "choice": return resolveChoiceStep(app, notePath, step);
    case "wait": return resolveWaitStep(app, notePath, step);
    case "obsidian-command": return resolveObsidianCommandStep(app, notePath, step);
    case "editor-command": return resolveEditorCommandStep(app, notePath, step);
    default: return { kind: "unsupported", ok: false, declaredKind: String(step?.kind ?? "undefined") };
  }
}
```

`resolveUserScriptStep` itself keeps its existing internal `if (step?.kind !== "userscript")` guard — harmless dead code now that the dispatcher only calls it for `"userscript"`, not worth removing (removing it would be an unrelated cleanup outside this task's scope).

- [ ] **Step 4: Update the tool's description string**

In the same file, find the tool registration's `description:` string (the one starting `"Compiles every Macro/UserScript choice note..."`). Replace the sentence `"Stage A: Macro choices whose steps are all UserScript. A note with a different quickadd-type, or a step of a different kind, is simply out of scope here — silently skipped (quickadd-type notes) or a per-choice error (unsupported step kind)."` with:

```
"Supports Macro choices with userscript, choice, wait, obsidian-command, and editor-command steps. nested-choice and ai-assistant steps are not yet supported (per-choice error). A note with a different quickadd-type is simply out of scope here — silently skipped."
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: PASS — all tests green, including every pre-existing Stage A test (unchanged, must still pass).

- [ ] **Step 6: Typecheck**

Run: `cd packages/plugin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full suite**

Run: `cd packages/plugin && npm test`
Expected: 100% pass, no regressions anywhere else in the repo.

- [ ] **Step 8: Live verification attempt**

Per packages/plugin/CLAUDE.md's "Verifying tools live" section. Build and deploy:

```bash
cd packages/plugin && npm run build
cp main.js manifest.json ~/obsidian/.obsidian/plugins/vault-mcp/
```

Try to trigger a real Obsidian-side plugin reload (NOT a Claude Code `/mcp reconnect` — that only reconnects the client to whatever's already running, per the finding recorded in this session's history). If a live reload is available, create one throwaway test choice note combining all 4 new step kinds plus a userscript step (mirroring "Validate UID and lint note"'s real shape), run `obsidian_quickadd_compile` with `dry_run: true`, confirm the compiled command sequence matches, then delete the test note.

**Known risk, carried over from Stage A's own plan**: BRAT may re-sync this plugin from the latest published release on any reload attempt, silently overwriting an unreleased build with zero error — this fought Stage A's live verification for over an hour. If that happens (check: does `grep -c "editor-command" main.js` still show the deployed build has this work, after any reload?), do not keep fighting it — report live verification as not completed and rely on the unit/integration coverage from Tasks 1–2, exactly as Stage A's final report did. This is an accepted, documented limitation of this repo's current dev loop, not a gap specific to this plan.

- [ ] **Step 9: Commit**

```bash
git add packages/plugin/src/mcp/tools-quickadd.ts packages/plugin/tests/quickadd-compile-tool.test.mjs
git commit -m "feat(mcp): Stage B glue — resolve choice/wait/obsidian-command/editor-command steps"
```

---

## Deferred (per this plan's own scope-narrowing, not the original spec's staging)

`nested-choice` (recursive embedded sub-choice — needs its own schema design) and `ai-assistant` (network/AI risk surface — needs its own design pass on what a note is allowed to configure) stay unimplemented after this plan, same as after Stage A. Both are Stage C+ candidates once someone designs their specific shape — this plan deliberately does not attempt either.

Template, Capture, and Multi choice types, and the bootstrap/reverse-generator tool, remain entirely out of scope here too — unchanged from Stage A's own "Deferred" section.
