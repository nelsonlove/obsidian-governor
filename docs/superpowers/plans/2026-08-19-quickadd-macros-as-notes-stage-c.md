# QuickAdd macros as notes — Stage C (Template, Capture choice types) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `obsidian_quickadd_compile` to discover and compile two more top-level choice types — `Template` and `Capture` — alongside the existing `Macro` type (Stage A/B, shipped in #237/#271). `Multi` (folder-as-truth) and the bootstrap/reverse-generator tool remain out of scope, deferred to Stage D/E.

**Architecture:** Same split as Stage A/B: pure kernel transform (`kernel/quickadd/types.ts` + `transform.ts`, no `obsidian` import) feeding the existing Obsidian-facing glue layer (`mcp/tools-quickadd.ts`). `ChoiceNoteInput` widens from a union of one (`MacroChoiceNoteInput`) to a union of three; `transformOne` gains two new top-level branches keyed on `input.quickaddType`.

**Tech Stack:** TypeScript, `node --import tsx --test`, zod (tool schema), Obsidian plugin API (`app.metadataCache`).

**Spec:** `docs/superpowers/specs/2026-08-18-quickadd-macros-as-notes-design.md`

## Ground truth vs. the spec (read this before writing any code)

The spec's own description of Template/Capture ("plus literal options: destination folder, file-name format, whether to open the created note" / "options: prepend/append, insert-after-heading, create-if-missing") significantly undersells QuickAdd's real field surface. Verified directly against QuickAdd's decompiled source (`main.js`, classes `rd` = Template, `qh` = Capture, base class `$l`) during this plan's own research — NOT assumed from the spec, matching Stage A/B's ground-truth discipline. Real native shapes:

**Base fields shared by every choice type** (class `$l`): `id`, `name`, `type`, `command`, `onePageInput` (undefined by default — omitted from JSON entirely when unset, never emit `null`/`undefined` for it). **`runOnStartup` is Macro-only** — it is NOT on the base class and Template/Capture choices never carry it.

**Template** (class `rd`, defaults shown):
```js
{
  templatePath: "",
  fileNameFormat: { enabled: false, format: "" },
  discoverExistingNotesBeforeCreate: false,
  folder: { enabled: false, folders: [], chooseWhenCreatingNote: false, createInSameFolderAsActiveFile: false, chooseFromSubfolders: false },
  appendLink: false,
  copyLinkToClipboard: false,
  openFile: false,
  fileOpening: { location: "tab", direction: "vertical", mode: "default", focus: true },
  fileExistsBehavior: { kind: "prompt" },
}
```

**Capture** (class `qh`, defaults shown):
```js
{
  appendLink: false,
  copyLinkToClipboard: false,
  captureTo: "",
  captureToActiveFile: false,
  captureToCanvasNodeId: "",
  activeFileWritePosition: "cursor",
  createFileIfItDoesntExist: { enabled: false, createWithTemplate: false, template: "" },
  format: { enabled: false, format: "" },
  insertAfter: { enabled: false, after: "", insertAtEnd: false, considerSubsections: false, createIfNotFound: false, createIfNotFoundLocation: "top", inline: false, replaceExisting: false, blankLineAfterMatchMode: "auto", promptHeading: false },
  insertBefore: { enabled: false, before: "", createIfNotFound: false, createIfNotFoundLocation: "top" },
  newLineCapture: { enabled: false, direction: "below" },
  prepend: false,
  task: false,
  openFile: false,
  fileOpening: { location: "tab", direction: "vertical", mode: "default", focus: true },
  templater: { afterCapture: "none" },
}
```

## Deliberate scope narrowing (documented, matching Stage B's nested-choice/ai-assistant precedent)

Exposing every one of the ~25 combined option fields as frontmatter would be a much larger surface than this stage warrants (YAGNI — most of these are QuickAdd power-user knobs with no vault use case yet). **This plan exposes a curated subset via frontmatter and hard-codes QuickAdd's own class defaults for everything else** — so a compiled choice is a fully well-formed native object, byte-identical to what QuickAdd's own "New Template Choice" / "New Capture Choice" UI button would produce, for every field this stage doesn't expose. Widening the exposed surface later (e.g. `file_exists_behavior:`, `insert_before:`) is a compatible, additive change to `resolveTemplateChoice`/`resolveCaptureChoice` and the two native-shape interfaces — nothing here forecloses it.

**Exposed for `template`:**
| frontmatter field | required | native field(s) |
|---|---|---|
| `template: [[note]]` | yes | `templatePath` (resolved wikilink → note path) |
| `folder: "<literal path>"` | no | `folder.enabled = true, folder.folders = ["<path>"]` (omitted → `folder.enabled = false, folder.folders = []`) |
| `file_name_format: "<literal string>"` | no | `fileNameFormat.enabled = true, fileNameFormat.format = "<string>"` (omitted → `enabled: false, format: ""`) |
| `open_file: <bool>` | no, default `false` | `openFile` |

**Exposed for `capture`:**
| frontmatter field | required | native field(s) |
|---|---|---|
| `target: [[note]]` OR `target: "<literal path/format string>"` | yes | `captureTo` (wikilink → resolved note path; non-wikilink string → used verbatim, QuickAdd's own dynamic-path syntax is not this compiler's concern) |
| `prepend: <bool>` | no, default `false` | `prepend` |
| `task: <bool>` | no, default `false` | `task` |
| `insert_after_heading: "<literal string>"` | no | `insertAfter.enabled = true, insertAfter.after = "<string>"` (omitted → `enabled: false, after: ""`) |
| `create_if_missing: <bool>` | no, default `false` | `createFileIfItDoesntExist.enabled = <bool>` (`createWithTemplate`/`template` stay at their defaults — no template-on-create support yet) |

`folder:` is a **literal string**, not a wikilink — a vault folder isn't a note you can wikilink to, and this matches Capture's own `target:` precedent of accepting a plain path string. `template:` and the wikilink form of `target:` reuse the exact same `linkTarget()` + `getFirstLinkpathDest()` resolution pattern already used by `script:`/`choice:` in Stage A/B — read that code before writing this task's resolvers.

**Compiled choices are always `command: true`** (never configurable), matching `QuickAddMacroChoice`'s existing fixed `command: true` — these are choices the compiler manages precisely so they're runnable, and Stage A already established this as a fixed value, not a frontmatter option.

## Global Constraints

- No `obsidian` import in `kernel/quickadd/types.ts` or `transform.ts` — see `packages/plugin/CLAUDE.md`'s kernel discipline. Verify with `grep -n '"obsidian"' packages/plugin/src/kernel/quickadd/*.ts` after each task — it must return nothing.
- Every native shape field not listed in the "Exposed" tables above must be emitted with QuickAdd's own exact default value from the ground-truth blocks above — never omit a field QuickAdd's own class sets, and never invent a different default.
- `deriveChoiceId(notePath)` (existing, in `transform.ts`) is reused unchanged for Template/Capture choices too — id derivation is already type-agnostic (pure function of note path), do not add a second id scheme.
- One malformed note fails only that one choice (`ChoiceError`, omitted from `choices`) — the existing per-note error-isolation discipline, unchanged, applies to Template/Capture exactly as it already does to Macro.
- `collectChoiceNotes`'s existing silent-skip behavior for any `quickadd-type` it doesn't recognize stays intact for `multi` and any future value — Stage C only adds recognition for `"template"` and `"capture"`, it does not touch the skip-unknown fallthrough.
- Run `npx tsc --noEmit` and the full `npm test` from `packages/plugin/` after each task — both must be clean.

---

### Task 1: kernel types + transform for Template/Capture choice types

**Files:**
- Modify: `packages/plugin/src/kernel/quickadd/types.ts`
- Modify: `packages/plugin/src/kernel/quickadd/transform.ts`
- Test: `packages/plugin/tests/quickadd-transform.test.mjs`

**Interfaces:**
- Consumes: nothing new from outside this task — this task defines the new types Task 2 will produce instances of.
- Produces: `TemplateChoiceNoteInput`, `TemplateFieldOk`/`TemplateFieldFailed` (the resolved `template:` wikilink), `CaptureChoiceNoteInput`, `CaptureTargetOk`/`CaptureTargetFailed` (the resolved `target:` field), `QuickAddTemplateChoice`, `QuickAddCaptureChoice` — all exported from `types.ts`. Widened `ChoiceNoteInput` (now a union of three) and widened `TransformResult.choices` (now `Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice>`). Task 2's resolvers construct `TemplateChoiceNoteInput`/`CaptureChoiceNoteInput` and pass them into `transformChoices` exactly like Task 2 of Stage B did for macro steps.

- [ ] **Step 1: Add the Template and Capture types to `types.ts`**

Add after the existing `ChoiceError`/`TransformResult` region is NOT where these go — add these new interfaces **right after** the existing `MacroChoiceNoteInput`/`ChoiceNoteInput` block (currently ending at the line `export type ChoiceNoteInput = MacroChoiceNoteInput;`), replacing that one line with the widened union below:

```typescript
/** The `template:` wikilink resolved to a real vault path. */
export interface TemplateFieldOk {
  ok: true;
  templatePath: string;
}
/** The `template:` wikilink did NOT resolve, or the frontmatter field is
 *  missing/not wikilink-shaped. `error` is human-readable, surfaced
 *  verbatim in the resulting ChoiceError message. */
export interface TemplateFieldFailed {
  ok: false;
  error: string;
}

/** One `quickadd-type: template` choice note's data, already resolved by
 *  the glue layer. `folder`/`fileNameFormat`/`openFile` are the curated
 *  subset this stage exposes — see the plan's "Deliberate scope narrowing"
 *  section for the full field-default rationale. `folder` and
 *  `fileNameFormat` are `undefined` when the note's frontmatter omits them
 *  (compiles to QuickAdd's own `enabled: false` default), never an empty
 *  string standing in for "not set". */
export interface TemplateChoiceNoteInput {
  quickaddType: "template";
  notePath: string;
  name: string;
  template: TemplateFieldOk | TemplateFieldFailed;
  folder: string | undefined;
  fileNameFormat: string | undefined;
  openFile: boolean;
}

/** The `target:` field resolved. `captureTo` is either the resolved
 *  wikilink's note path (when `target:` was wikilink-shaped) or the raw
 *  literal string verbatim (QuickAdd's own dynamic-path format syntax —
 *  this compiler does not interpret it, only passes it through). */
export interface CaptureTargetOk {
  ok: true;
  captureTo: string;
}
/** The `target:` field is missing, or was wikilink-shaped but did not
 *  resolve. A non-wikilink-shaped string is ALWAYS `CaptureTargetOk` —
 *  there is no way for a literal string to "fail" resolution, since it is
 *  never resolved, only passed through. */
export interface CaptureTargetFailed {
  ok: false;
  error: string;
}

/** One `quickadd-type: capture` choice note's data, already resolved by
 *  the glue layer. `prepend`/`task`/`insertAfterHeading`/`createIfMissing`
 *  are the curated subset this stage exposes. `insertAfterHeading`
 *  `undefined` means the note's frontmatter omitted `insert_after_heading:`
 *  (compiles to `insertAfter.enabled: false`). */
export interface CaptureChoiceNoteInput {
  quickaddType: "capture";
  notePath: string;
  name: string;
  target: CaptureTargetOk | CaptureTargetFailed;
  prepend: boolean;
  task: boolean;
  insertAfterHeading: string | undefined;
  createIfMissing: boolean;
}

export type ChoiceNoteInput = MacroChoiceNoteInput | TemplateChoiceNoteInput | CaptureChoiceNoteInput;
```

- [ ] **Step 2: Add the native `QuickAddTemplateChoice`/`QuickAddCaptureChoice` shapes to `types.ts`**

Add immediately after the existing `QuickAddMacroChoice` interface, and widen `TransformResult`:

```typescript
/** QuickAdd's native Template-choice shape — verified against QuickAdd's
 *  decompiled source (class `rd`), not assumed from the design spec (see
 *  the plan's "Ground truth vs. the spec" section). Every field this stage
 *  doesn't expose via frontmatter carries QuickAdd's own literal default,
 *  so a compiled choice is byte-identical to a freshly-created one for
 *  anything Stage C doesn't author. */
export interface QuickAddTemplateChoice {
  id: string;
  name: string;
  type: "Template";
  command: true;
  templatePath: string;
  fileNameFormat: { enabled: boolean; format: string };
  discoverExistingNotesBeforeCreate: false;
  folder: {
    enabled: boolean;
    folders: string[];
    chooseWhenCreatingNote: false;
    createInSameFolderAsActiveFile: false;
    chooseFromSubfolders: false;
  };
  appendLink: false;
  copyLinkToClipboard: false;
  openFile: boolean;
  fileOpening: { location: "tab"; direction: "vertical"; mode: "default"; focus: true };
  fileExistsBehavior: { kind: "prompt" };
}

/** QuickAdd's native Capture-choice shape — verified against QuickAdd's
 *  decompiled source (class `qh`). Same "unexposed fields carry QuickAdd's
 *  own default" discipline as QuickAddTemplateChoice above. */
export interface QuickAddCaptureChoice {
  id: string;
  name: string;
  type: "Capture";
  command: true;
  appendLink: false;
  copyLinkToClipboard: false;
  captureTo: string;
  captureToActiveFile: false;
  captureToCanvasNodeId: "";
  activeFileWritePosition: "cursor";
  createFileIfItDoesntExist: { enabled: boolean; createWithTemplate: false; template: "" };
  format: { enabled: false; format: "" };
  insertAfter: {
    enabled: boolean;
    after: string;
    insertAtEnd: false;
    considerSubsections: false;
    createIfNotFound: false;
    createIfNotFoundLocation: "top";
    inline: false;
    replaceExisting: false;
    blankLineAfterMatchMode: "auto";
    promptHeading: false;
  };
  insertBefore: { enabled: false; before: ""; createIfNotFound: false; createIfNotFoundLocation: "top" };
  newLineCapture: { enabled: false; direction: "below" };
  prepend: boolean;
  task: boolean;
  openFile: false;
  fileOpening: { location: "tab"; direction: "vertical"; mode: "default"; focus: true };
  templater: { afterCapture: "none" };
}
```

Then change:
```typescript
export interface TransformResult {
  choices: QuickAddMacroChoice[];
  errors: ChoiceError[];
}
```
to:
```typescript
export interface TransformResult {
  choices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice>;
  errors: ChoiceError[];
}
```

- [ ] **Step 3: Write the failing tests for the new transform branches**

Read `packages/plugin/tests/quickadd-transform.test.mjs` in full first. It imports `{ test, describe }` from `node:test` and `assert` from `node:assert/strict` (so `assert.equal`/`assert.deepEqual` are already strict — use those, matching the file's existing style, not `assert.strictEqual`/`assert.deepStrictEqual`). It has an existing `macroInput(overrides = {})` helper (shown above, defaults to one `userscriptStep()`) — add matching `templateInput`/`captureInput` helpers in the same style, placed right after `macroInput`:

```javascript
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
```

Then add these describe blocks (using `test(...)`, matching the file's own convention — NOT `it(...)`):

```javascript
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
```

(The `macroInputExample` placeholder above must be replaced with whatever the file's own existing minimal-Macro-input fixture/helper already is — read the file first, this task must not invent a second Macro fixture shape.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: FAIL — `transformChoices` doesn't yet branch on `quickaddType: "template"`/`"capture"`, so these will either throw or produce wrong output.

- [ ] **Step 5: Restructure `transformOne` to branch on `input.quickaddType`**

Read `packages/plugin/src/kernel/quickadd/transform.ts` in full first. The existing `transformOne` function assumes every input is a Macro (it goes straight into the steps loop). Restructure it so the Macro logic becomes one branch of a top-level switch, and add the Template/Capture branches:

```typescript
function transformOne(input: ChoiceNoteInput): OneResult {
  switch (input.quickaddType) {
    case "macro":
      return transformMacro(input);
    case "template":
      return transformTemplate(input);
    case "capture":
      return transformCapture(input);
  }
}

function transformTemplate(input: TemplateChoiceNoteInput): OneResult {
  if (!input.template.ok) {
    return { ok: false, message: `Template "${input.name}" (${input.notePath}): ${input.template.error}` };
  }
  return {
    ok: true,
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Template",
      command: true,
      templatePath: input.template.templatePath,
      fileNameFormat: input.fileNameFormat !== undefined
        ? { enabled: true, format: input.fileNameFormat }
        : { enabled: false, format: "" },
      discoverExistingNotesBeforeCreate: false,
      folder: input.folder !== undefined
        ? { enabled: true, folders: [input.folder], chooseWhenCreatingNote: false, createInSameFolderAsActiveFile: false, chooseFromSubfolders: false }
        : { enabled: false, folders: [], chooseWhenCreatingNote: false, createInSameFolderAsActiveFile: false, chooseFromSubfolders: false },
      appendLink: false,
      copyLinkToClipboard: false,
      openFile: input.openFile,
      fileOpening: { location: "tab", direction: "vertical", mode: "default", focus: true },
      fileExistsBehavior: { kind: "prompt" },
    },
  };
}

function transformCapture(input: CaptureChoiceNoteInput): OneResult {
  if (!input.target.ok) {
    return { ok: false, message: `Capture "${input.name}" (${input.notePath}): ${input.target.error}` };
  }
  return {
    ok: true,
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Capture",
      command: true,
      appendLink: false,
      copyLinkToClipboard: false,
      captureTo: input.target.captureTo,
      captureToActiveFile: false,
      captureToCanvasNodeId: "",
      activeFileWritePosition: "cursor",
      createFileIfItDoesntExist: { enabled: input.createIfMissing, createWithTemplate: false, template: "" },
      format: { enabled: false, format: "" },
      insertAfter: input.insertAfterHeading !== undefined
        ? { enabled: true, after: input.insertAfterHeading, insertAtEnd: false, considerSubsections: false, createIfNotFound: false, createIfNotFoundLocation: "top", inline: false, replaceExisting: false, blankLineAfterMatchMode: "auto", promptHeading: false }
        : { enabled: false, after: "", insertAtEnd: false, considerSubsections: false, createIfNotFound: false, createIfNotFoundLocation: "top", inline: false, replaceExisting: false, blankLineAfterMatchMode: "auto", promptHeading: false },
      insertBefore: { enabled: false, before: "", createIfNotFound: false, createIfNotFoundLocation: "top" },
      newLineCapture: { enabled: false, direction: "below" },
      prepend: input.prepend,
      task: input.task,
      openFile: false,
      fileOpening: { location: "tab", direction: "vertical", mode: "default", focus: true },
      templater: { afterCapture: "none" },
    },
  };
}
```

Rename the existing Macro-only body of `transformOne` to `transformMacro(input: MacroChoiceNoteInput): OneResult` (same body, just the function name and parameter type change — the logic is unchanged) and update its internal early-return guards (`input.steps.length === 0`, etc.) unchanged. Update the `OneResult`/`Command` local types' choice field type if needed so `OneResult`'s `ok: true` branch accepts any of the three native choice shapes (widen `{ ok: true; choice: QuickAddMacroChoice }` to `{ ok: true; choice: QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice }`), and update the corresponding imports at the top of the file to include `TemplateChoiceNoteInput`, `CaptureChoiceNoteInput`, `QuickAddTemplateChoice`, `QuickAddCaptureChoice`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: PASS, including all pre-existing Macro tests (unchanged behavior — verify by diffing test output count against this task's BASE commit, not just "no failures").

- [ ] **Step 7: Typecheck and commit**

Run: `cd packages/plugin && npx tsc --noEmit` — must be clean.

```bash
git add packages/plugin/src/kernel/quickadd/types.ts packages/plugin/src/kernel/quickadd/transform.ts packages/plugin/tests/quickadd-transform.test.mjs
git commit -m "feat(kernel): Stage C — Template and Capture choice types"
```

---

### Task 2: glue-layer discovery/resolution for Template/Capture

**Files:**
- Modify: `packages/plugin/src/mcp/tools-quickadd.ts`
- Test: `packages/plugin/tests/quickadd-compile-tool.test.mjs`

**Interfaces:**
- Consumes: `TemplateChoiceNoteInput`, `CaptureChoiceNoteInput`, `TemplateFieldOk`/`Failed`, `CaptureTargetOk`/`Failed` (Task 1, `../kernel/quickadd/types.js`).
- Produces: nothing new consumed elsewhere — this is the outermost layer.

- [ ] **Step 1: Read the existing discovery/resolution code first**

Read `packages/plugin/src/mcp/tools-quickadd.ts` in full, specifically: `collectChoiceNotes` (currently only recognizes `quickadd-type: "macro"` and silently skips everything else via its `if (!frontmatter || frontmatter["quickadd-type"] !== "macro") continue;` guard), `linkTarget` (the wikilink-string parser shared by every wikilink-resolving field), and `resolveChoiceStep` (the closest existing precedent for resolving a wikilink field with a self-reference / non-md / not-a-choice-note set of guards — Template/Capture's `template:`/`target:` fields need the same unresolved/non-md checks, but NOT the self-reference or `quickadd-type: macro` checks, since a template/capture target is an ordinary note, not another compiler-managed choice).

- [ ] **Step 2: Write the failing tests for Template/Capture discovery**

Read `packages/plugin/tests/quickadd-compile-tool.test.mjs` in full first. Its `build({notes, links, existingChoices, settings, commandApi, commands})` helper (top of the file) returns `{ handler, quickadd, saveSettingsCalls, addedCommands, removedCommands, getMarkdownFilesCalls }` — `handler` is the tool's own handler function, called directly as `await handler({ dry_run })`. The result's `structuredContent` carries `choices` (the compiled array — populated under `dry_run: true` too, not just after applying) and `errors` (`{notePath, message}[]`). `links` maps a bare link-text string (not a full `[[...]]`) to a resolved path, or omit the key entirely for an unresolvable link — see the existing `getFirstLinkpathDest` fake in `build()`. Add these note-fixture helpers right after the existing `macroNoteWithSteps`:

```javascript
function templateNote(path, name, extra = {}) {
  return { path, frontmatter: { "quickadd-type": "template", name, ...extra } };
}

function captureNote(path, name, extra = {}) {
  return { path, frontmatter: { "quickadd-type": "capture", name, ...extra } };
}
```

Then add these describe blocks (using `test(...)`, matching the file's own `test`/`describe` convention — this file does NOT use `it`):

```javascript
describe("obsidian_quickadd_compile — Template discovery", () => {
  test("compiles a Template note with a resolved template: wikilink", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", { template: "[[Daily Template]]" })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const compiled = res.structuredContent.choices.find((c) => c.name === "Daily");
    assert.equal(compiled.type, "Template");
    assert.equal(compiled.templatePath, "Templates/Daily.md");
  });

  test("a template: wikilink that fails to resolve fails only that note", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Broken.md", "Broken", { template: "[[Missing]]" })],
      links: {},
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
    assert.equal(res.structuredContent.choices.length, 0);
  });

  test("a missing template: field fails with a clear error", async () => {
    const { handler } = build({ notes: [templateNote("Choices/NoTemplate.md", "NoTemplate")] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /template/i);
  });

  test("folder/file_name_format/open_file frontmatter fields are threaded through", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", {
        template: "[[Daily Template]]", folder: "Journal/Daily", file_name_format: "{{DATE}}", open_file: true,
      })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Daily");
    assert.deepEqual(compiled.folder.folders, ["Journal/Daily"]);
    assert.equal(compiled.openFile, true);
  });
});

describe("obsidian_quickadd_compile — Capture discovery", () => {
  test("compiles a Capture note with a resolved target: wikilink", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Log.md", "Log", { target: "[[Journal Log]]" })],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const compiled = res.structuredContent.choices.find((c) => c.name === "Log");
    assert.equal(compiled.type, "Capture");
    assert.equal(compiled.captureTo, "Journal/Log.md");
  });

  test("a non-wikilink target: string is used verbatim (dynamic path)", async () => {
    const { handler } = build({ notes: [captureNote("Choices/Log.md", "Log", { target: "Journal/{{DATE}}.md" })] });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Log");
    assert.equal(compiled.captureTo, "Journal/{{DATE}}.md");
  });

  test("a target: wikilink that fails to resolve fails only that note", async () => {
    const { handler } = build({ notes: [captureNote("Choices/Broken.md", "Broken", { target: "[[Missing]]" })] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
  });

  test("a missing target: field fails with a clear error", async () => {
    const { handler } = build({ notes: [captureNote("Choices/NoTarget.md", "NoTarget")] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
  });

  test("prepend/task/insert_after_heading/create_if_missing frontmatter fields are threaded through", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Log.md", "Log", {
        target: "[[Journal Log]]", prepend: true, task: true,
        insert_after_heading: "## Inbox", create_if_missing: true,
      })],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Log");
    assert.equal(compiled.prepend, true);
    assert.equal(compiled.task, true);
    assert.equal(compiled.insertAfter.after, "## Inbox");
    assert.equal(compiled.createFileIfItDoesntExist.enabled, true);
  });
});

describe("obsidian_quickadd_compile — mixed choice types in one compile", () => {
  test("Macro, Template, and Capture notes all compile together", async () => {
    const { handler } = build({
      notes: [
        macroNote("Choices/M.md", "M", "stamp-title"),
        templateNote("Choices/T.md", "T", { template: "[[Tmpl]]" }),
        captureNote("Choices/C.md", "C", { target: "[[Cap]]" }),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md", "Tmpl": "Templates/Tmpl.md", "Cap": "Capture/Cap.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices.length, 3);
    assert.ok(res.structuredContent.choices.some((c) => c.type === "Macro"));
    assert.ok(res.structuredContent.choices.some((c) => c.type === "Template"));
    assert.ok(res.structuredContent.choices.some((c) => c.type === "Capture"));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: FAIL — `collectChoiceNotes` doesn't yet recognize `quickadd-type: "template"`/`"capture"`, so these notes are silently skipped and the new tests' assertions on compiled output fail.

- [ ] **Step 4: Extend `collectChoiceNotes` to discover Template/Capture notes**

The existing function's guard `if (!frontmatter || frontmatter["quickadd-type"] !== "macro") continue;` currently makes every non-macro note invisible. Change it to dispatch on the recognized set instead of gating on one value:

```typescript
function collectChoiceNotes(app: App): ChoiceNoteInput[] {
  const inputs: ChoiceNoteInput[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    const quickaddType = frontmatter?.["quickadd-type"];
    if (quickaddType !== "macro" && quickaddType !== "template" && quickaddType !== "capture") continue;

    const name = displayNameOf(frontmatter, file.path);

    if (quickaddType === "macro") {
      const rawSteps = Array.isArray(frontmatter.steps) ? frontmatter.steps : [];
      const steps = rawSteps.map((s) => resolveStep(app, file.path, s));
      inputs.push({ quickaddType: "macro", notePath: file.path, name, steps });
    } else if (quickaddType === "template") {
      inputs.push(resolveTemplateChoice(app, file.path, name, frontmatter));
    } else {
      inputs.push(resolveCaptureChoice(app, file.path, name, frontmatter));
    }
  }
  return inputs;
}
```

(The Macro branch body above is copied verbatim from the existing function — `rawSteps`/`resolveStep(app, file.path, s)` — unchanged logic, just moved inside the new `if`.)

- [ ] **Step 5: Write `resolveTemplateChoice` and `resolveCaptureChoice`**

Add these new functions near `resolveChoiceStep` (the closest existing precedent for wikilink resolution with a non-md guard):

```typescript
/** Resolves a `quickadd-type: template` note's frontmatter into a
 *  TemplateChoiceNoteInput. `template:` is required and must be a
 *  [[wikilink]] resolving to a markdown note — unlike `choice:` steps,
 *  there is no `quickadd-type` check on the target: a template is an
 *  ordinary vault note, not another compiler-managed choice. */
function resolveTemplateChoice(app: App, notePath: string, name: string, frontmatter: Record<string, unknown>): TemplateChoiceNoteInput {
  const raw = String(frontmatter?.["template"] ?? "");
  const target = linkTarget(raw);
  let template: TemplateFieldOk | TemplateFieldFailed;
  if (target === null) {
    template = { ok: false, error: `template: "${raw}" is not a [[wikilink]].` };
  } else {
    const dest = app.metadataCache.getFirstLinkpathDest(target, notePath);
    if (!dest) {
      template = { ok: false, error: `template: could not resolve "${raw}".` };
    } else if (dest.extension !== "md") {
      template = { ok: false, error: `template: "${raw}" resolves to a non-markdown file (${dest.path}).` };
    } else {
      template = { ok: true, templatePath: dest.path };
    }
  }
  const folder = typeof frontmatter?.["folder"] === "string" && frontmatter["folder"].trim() !== "" ? frontmatter["folder"] : undefined;
  const fileNameFormat = typeof frontmatter?.["file_name_format"] === "string" && frontmatter["file_name_format"].trim() !== "" ? frontmatter["file_name_format"] : undefined;
  const openFile = frontmatter?.["open_file"] === true;
  return { quickaddType: "template", notePath, name, template, folder, fileNameFormat, openFile };
}

/** Resolves a `quickadd-type: capture` note's frontmatter into a
 *  CaptureChoiceNoteInput. `target:` is required. If it's [[wikilink]]-
 *  shaped, it resolves like `template:` above (must be markdown). If it's
 *  NOT wikilink-shaped, the raw string is used verbatim as `captureTo` —
 *  QuickAdd's own dynamic-path format syntax, never interpreted here. */
function resolveCaptureChoice(app: App, notePath: string, name: string, frontmatter: Record<string, unknown>): CaptureChoiceNoteInput {
  const raw = frontmatter?.["target"];
  let target: CaptureTargetOk | CaptureTargetFailed;
  if (typeof raw !== "string" || raw.trim() === "") {
    target = { ok: false, error: `target: is required and must be a [[wikilink]] or a literal path string.` };
  } else {
    const linkedTarget = linkTarget(raw);
    if (linkedTarget === null) {
      // Not wikilink-shaped — a literal dynamic-path string, used as-is.
      target = { ok: true, captureTo: raw };
    } else {
      const dest = app.metadataCache.getFirstLinkpathDest(linkedTarget, notePath);
      if (!dest) {
        target = { ok: false, error: `target: could not resolve "${raw}".` };
      } else if (dest.extension !== "md") {
        target = { ok: false, error: `target: "${raw}" resolves to a non-markdown file (${dest.path}).` };
      } else {
        target = { ok: true, captureTo: dest.path };
      }
    }
  }
  const prepend = frontmatter?.["prepend"] === true;
  const task = frontmatter?.["task"] === true;
  const insertAfterHeading = typeof frontmatter?.["insert_after_heading"] === "string" && frontmatter["insert_after_heading"].trim() !== "" ? frontmatter["insert_after_heading"] : undefined;
  const createIfMissing = frontmatter?.["create_if_missing"] === true;
  return { quickaddType: "capture", notePath, name, target, prepend, task, insertAfterHeading, createIfMissing };
}
```

Update the file's imports at the top to include `TemplateChoiceNoteInput`, `CaptureChoiceNoteInput`, `TemplateFieldOk`, `TemplateFieldFailed`, `CaptureTargetOk`, `CaptureTargetFailed` from `../kernel/quickadd/types.js`.

- [ ] **Step 6: Update the tool's description string**

Find the `description:` string in the `obsidian_quickadd_compile` tool registration (currently says something like "Compiles every Macro/UserScript choice note... quickadd-type is simply out of scope here — silently skipped"). Update it to state that `quickadd-type: template` and `quickadd-type: capture` notes are now also compiled, alongside `macro`, and that `multi` remains unsupported (silently skipped, same as any other unrecognized value) — read the existing string fully first so the update is additive, not a rewrite that loses Stage A/B's own accumulated caveats (the mass-removal guard, the allowlist refusal, the cycle-detection note).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: PASS, including every pre-existing Stage A/B test (unchanged behavior).

- [ ] **Step 8: Typecheck, full suite, and commit**

Run: `cd packages/plugin && npx tsc --noEmit && npm test` — both clean, confirm the actual full-suite pass count (not just the two quickadd files).

```bash
git add packages/plugin/src/mcp/tools-quickadd.ts packages/plugin/tests/quickadd-compile-tool.test.mjs
git commit -m "feat(mcp): Stage C glue — discover and resolve Template/Capture choice notes"
```

- [ ] **Step 9: Live verification (best-effort, matching Stage A/B's precedent)**

Per `packages/plugin/CLAUDE.md`'s "Verifying tools live" section: build (`npm run build`), deploy to a real vault's `.obsidian/plugins/vault-mcp/`, reload, and pipe a `dry_run: true` compile through `bridge.mjs` against a real Template/Capture choice note (create a throwaway one under the vault's QuickAdd-choices root if none exists). If BRAT re-syncs from the published release before this can complete (the known issue flagged in Stage A's final review and reconfirmed in Stage B's), degrade gracefully to the unit/integration coverage above and note this in the report — do not block the plan on it.

---

## Out of scope for this plan (carried forward from the design spec, unchanged)

- `Multi` choice type (folder-as-truth) — Stage D.
- `obsidian_quickadd_bootstrap` (the reverse-direction, `data.json` → notes tool) — Stage E.
- `nested-choice`/`ai-assistant` Macro step kinds — still deferred from Stage B, unaffected by this plan.
- Every Template/Capture native field not listed in the "Deliberate scope narrowing" tables above (`fileOpening`, `fileExistsBehavior`, `insertBefore`, `newLineCapture`, `templater`, `discoverExistingNotesBeforeCreate`, `appendLink`, `copyLinkToClipboard`, `activeFileWritePosition`, `captureToActiveFile`, `captureToCanvasNodeId`, `format`, the "choose folder from a list" Template mode) — all compile to QuickAdd's own literal defaults, not configurable via frontmatter yet. Widening this is a compatible follow-up, not a redesign.
