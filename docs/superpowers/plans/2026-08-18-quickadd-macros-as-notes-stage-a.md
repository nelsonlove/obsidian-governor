# QuickAdd Macros as Notes — Stage A (Macro + UserScript) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Represent QuickAdd `Macro` choices whose steps are all `UserScript` as vault notes, compiled by a new guarded/journaled vault-mcp tool — the narrowest slice that already fixes the actual pain (script-path drift) and proves the pattern before the remaining choice/step types are built.

**Architecture:** A pure transform (`kernel/quickadd/`, no `obsidian` import, unit-tested like every other kernel module) takes already-resolved choice data and produces QuickAdd's native `choices` shape. A thin Obsidian-glue tool (`mcp/tools-quickadd.ts`) discovers choice notes vault-wide by frontmatter, resolves each note's wikilinks via `app.metadataCache`, feeds the transform, and — since vault-mcp runs inside Obsidian with full `app.*` access — applies the result in-process via QuickAdd's own `saveSettings()`. `dry_run` is required-first, matching `obsidian_assign_address` et al. One bad note fails only that note; nothing else is affected.

**Tech Stack:** TypeScript, `node --import tsx --test`, the MCP SDK's `registerTool` via vault-mcp's guard/kernel interception point.

**Spec:** `docs/superpowers/specs/2026-08-18-quickadd-macros-as-notes-design.md` — this plan implements the "Macro" choice type restricted to `userscript` steps only (the spec's other choice/step types are explicitly Stage B+ work, see "Deferred" below).

## Global Constraints

- Pure transform code lives under `kernel/`, imports nothing from `obsidian` (repo-wide rule, packages/plugin/CLAUDE.md).
- Wikilink resolution happens ONLY in the glue layer (`mcp/tools-quickadd.ts`), never in the pure transform — mirrors the vault-skills precedent (`parentPaths` arrives pre-resolved).
- `dry_run: z.boolean()` is REQUIRED on the compile tool's input schema, no default — matches `obsidian_assign_address`/`obsidian_refile_address`/`obsidian_renumber_address` in `tools-scheme-write.ts`.
- The compile tool registers `annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }` (the `RW` constant pattern used throughout `tools-complementary.ts`/`tools-scheme-write.ts`) so it automatically gets the kernel's queue/journal/if_rev treatment at `server.registerTool`'s interception point — no manual wiring needed for that.
- One malformed choice note fails ONLY that choice (reported as an entry in `errors`), never the whole compile — matches `obsidian_move_notes`' "static validation, no half-applied batch" discipline, but scoped per-choice here rather than failing the whole call.
- A compile's write must NEVER touch a choice in `quickadd.settings.choices` that this tool didn't itself generate — non-compiler-owned choices (everything not yet migrated to a note, including the live `sync-quickadd-choices.js`-managed choices — see Task 3's rollout note) are read but never overwritten or removed.
- **Known limitation, inherited from `obsidian_run_command`'s PR #225 (already shipped):** nothing in this plan changes that QuickAdd's `executeChoice` API doesn't return a script's own return value — irrelevant here since this plan only compiles choice DEFINITIONS, never executes them.

---

## Compiler-owned choice identity (load-bearing correctness property)

Every task below depends on this, so it's called out once here rather than repeated per-task: a compiled choice's `id` (and its macro's `id`, and each command's `id`) is **derived deterministically from the choice note's own vault path** — `qan:<notePath>#choice`, `qan:<notePath>#macro`, `qan:<notePath>#step<N>` respectively (`qan:` = "quickadd as notes", used as the compiler-owned marker prefix throughout this plan). This buys two things: (1) recompiling the SAME unchanged note twice produces byte-identical output — no spurious churn on QuickAdd's own config, no needless invalidation of anything (an Obsidian hotkey, a saved `obsidian_run_command` call) bound to that id; (2) the compile tool can identify "which live choices are mine" by checking `id.startsWith("qan:")`, which is exactly the property the merge-write in Task 2 needs.

---

### Task 1: Pure transform module

**Files:**
- Create: `packages/plugin/src/kernel/quickadd/types.ts`
- Create: `packages/plugin/src/kernel/quickadd/transform.ts`
- Test: `packages/plugin/tests/quickadd-transform.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks (this is the first task).
- Produces (consumed by Task 2):
  - `deriveChoiceId(notePath: string): string`, `deriveMacroId(notePath: string): string`, `deriveStepId(notePath: string, index: number): string` — exported from `transform.ts`.
  - `transformChoices(inputs: ChoiceNoteInput[]): TransformResult` — exported from `transform.ts`.
  - Types from `types.ts`: `MacroStepResolved`, `ChoiceNoteInput`, `QuickAddUserScriptCommand`, `QuickAddMacro`, `QuickAddMacroChoice`, `ChoiceError`, `TransformResult`.

- [ ] **Step 1: Write the failing tests**

```javascript
// packages/plugin/tests/quickadd-transform.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  transformChoices,
  deriveChoiceId,
  deriveMacroId,
  deriveStepId,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: FAIL — `Cannot find module '../src/kernel/quickadd/transform.ts'` (the module doesn't exist yet).

- [ ] **Step 3: Write the types module**

```typescript
// packages/plugin/src/kernel/quickadd/types.ts
//
// Pure types for the QuickAdd-macros-as-notes transform (Stage A: Macro
// choices whose steps are all UserScript). No `obsidian` import anywhere in
// this file or transform.ts — see packages/plugin/CLAUDE.md's kernel
// discipline. Wikilink resolution happens in the glue layer
// (mcp/tools-quickadd.ts); everything here works on already-resolved data.

/** A UserScript step whose `script:` wikilink resolved to a real vault path. */
export interface UserScriptStepOk {
  kind: "userscript";
  ok: true;
  scriptPath: string;
  settings: Record<string, unknown>;
}

/** A UserScript step whose `script:` wikilink did NOT resolve (missing,
 *  ambiguous, malformed). `error` is a human-readable reason surfaced
 *  verbatim in the resulting ChoiceError message. */
export interface UserScriptStepFailed {
  kind: "userscript";
  ok: false;
  error: string;
}

/** A step whose declared `kind:` isn't implemented yet (Stage B+: choice,
 *  wait, obsidian-command, nested-choice, editor-command, ai-assistant).
 *  Carried through as a normal per-choice failure rather than a thrown
 *  error, so one note using a not-yet-supported step kind doesn't take
 *  down the whole compile. */
export interface UnsupportedStep {
  kind: "unsupported";
  ok: false;
  declaredKind: string;
}

export type MacroStepResolved = UserScriptStepOk | UserScriptStepFailed | UnsupportedStep;

/** One choice note's data, already resolved by the glue layer. Stage A only
 *  ever constructs `quickaddType: "macro"` — the union grows in later
 *  stages (template/capture/multi), which is why this is a union of one
 *  today rather than a bare object type. */
export interface MacroChoiceNoteInput {
  quickaddType: "macro";
  notePath: string;
  name: string;
  steps: MacroStepResolved[];
}

export type ChoiceNoteInput = MacroChoiceNoteInput;

/** QuickAdd's own native shapes (the Stage A subset — UserScript commands
 *  only) — verified against a real vault's
 *  `.obsidian/plugins/quickadd/data.json`. */
export interface QuickAddUserScriptCommand {
  id: string;
  name: string;
  type: "UserScript";
  path: string;
  settings: Record<string, unknown>;
}

export interface QuickAddMacro {
  name: string;
  id: string;
  commands: QuickAddUserScriptCommand[];
}

export interface QuickAddMacroChoice {
  id: string;
  name: string;
  type: "Macro";
  command: true;
  runOnStartup: false;
  macro: QuickAddMacro;
}

/** One choice note that failed to compile. The choice is OMITTED from
 *  `TransformResult.choices` entirely — never partially included. */
export interface ChoiceError {
  notePath: string;
  message: string;
}

export interface TransformResult {
  choices: QuickAddMacroChoice[];
  errors: ChoiceError[];
}
```

- [ ] **Step 4: Write the transform module**

```typescript
// packages/plugin/src/kernel/quickadd/transform.ts
import type {
  ChoiceNoteInput,
  ChoiceError,
  QuickAddMacroChoice,
  QuickAddUserScriptCommand,
  TransformResult,
} from "./types.js";

/** The compiler-owned id marker — see the plan's "Compiler-owned choice
 *  identity" section. "quickadd as notes", short enough to keep ids
 *  readable in QuickAdd's own settings UI (which the compile tool's Task 2
 *  otherwise treats as read-only, but the id is still visible there). */
const ID_PREFIX = "qan:";

export function deriveChoiceId(notePath: string): string {
  return `${ID_PREFIX}${notePath}#choice`;
}

export function deriveMacroId(notePath: string): string {
  return `${ID_PREFIX}${notePath}#macro`;
}

export function deriveStepId(notePath: string, index: number): string {
  return `${ID_PREFIX}${notePath}#step${index}`;
}

export function transformChoices(inputs: ChoiceNoteInput[]): TransformResult {
  const choices: QuickAddMacroChoice[] = [];
  const errors: ChoiceError[] = [];

  for (const input of inputs) {
    const result = transformOne(input);
    if (result.ok) {
      choices.push(result.choice);
    } else {
      errors.push({ notePath: input.notePath, message: result.message });
    }
  }

  return { choices, errors };
}

type OneResult = { ok: true; choice: QuickAddMacroChoice } | { ok: false; message: string };

function transformOne(input: ChoiceNoteInput): OneResult {
  if (input.steps.length === 0) {
    return { ok: false, message: `Macro "${input.name}" (${input.notePath}) has no steps.` };
  }

  const commands: QuickAddUserScriptCommand[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];

    if (step.kind === "unsupported") {
      return {
        ok: false,
        message:
          `Macro "${input.name}" (${input.notePath}) step ${i + 1} has unsupported step kind ` +
          `"${step.declaredKind}" (only "userscript" is implemented).`,
      };
    }

    if (!step.ok) {
      return {
        ok: false,
        message: `Macro "${input.name}" (${input.notePath}) step ${i + 1}: ${step.error}`,
      };
    }

    commands.push({
      id: deriveStepId(input.notePath, i),
      name: step.scriptPath,
      type: "UserScript",
      path: step.scriptPath,
      settings: step.settings,
    });
  }

  return {
    ok: true,
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Macro",
      command: true,
      runOnStartup: false,
      macro: {
        name: input.name,
        id: deriveMacroId(input.notePath),
        commands,
      },
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 6: Typecheck**

Run: `cd packages/plugin && npx tsc --noEmit`
Expected: no errors. (Trust this over the editor's inline diagnostics — packages/plugin/CLAUDE.md notes the LSP lags in this repo.)

- [ ] **Step 7: Commit**

```bash
git add packages/plugin/src/kernel/quickadd/ packages/plugin/tests/quickadd-transform.test.mjs
git commit -m "feat(kernel): pure transform for QuickAdd Macro/UserScript choice notes"
```

---

### Task 2: Compile tool (`obsidian_quickadd_compile`)

**Files:**
- Create: `packages/plugin/src/mcp/tools-quickadd.ts`
- Test: `packages/plugin/tests/quickadd-compile-tool.test.mjs`

**Interfaces:**
- Consumes: `transformChoices`, `ChoiceNoteInput`, `MacroStepResolved`, `TransformResult` from Task 1's `kernel/quickadd/transform.ts` / `types.ts`.
- Produces (consumed by Task 3): `registerQuickAddTools(server: McpServer, app: App, ctx: ServerCtx): void` — same signature shape as `registerComplementaryTools`/`registerSchemeWriteTools` elsewhere in `mcp/`.

**Note-discovery contract this task implements** (not yet decided by the spec beyond "frontmatter, not a hardcoded folder" — this is the concrete shape):
- A choice note is any markdown file whose frontmatter has `quickadd-type: macro`.
- Its steps come from a frontmatter array field `steps:`, each entry `{ kind: "userscript", script: "[[...]]", settings?: {...} }`.
- `script:`'s wikilink is resolved via `app.metadataCache.getFirstLinkpathDest(linktext, notePath)`, where `linktext` is extracted from the raw `[[...]]` string (strip the brackets; an alias after `|` is dropped — only the link target matters for path resolution).
- The choice's compiled `name` is the note's own `name:` frontmatter field (falling back to the note's basename if absent — matches the vault's own convention elsewhere, e.g. `stamp-title.md`'s `frontmatter.title ||= file.basename` pattern, applied here to `name` instead of `title`).

- [ ] **Step 1: Write the failing tests**

```javascript
// packages/plugin/tests/quickadd-compile-tool.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerQuickAddTools } = await import("../src/mcp/tools-quickadd.ts");

// A minimal fake note: frontmatter + a resolvable-or-not set of wikilinks.
function fakeFile(path) {
  return { path, extension: "md" };
}

function build({ notes = [], links = {}, existingChoices = [] } = {}) {
  const server = fakeServer();
  const files = notes.map((n) => fakeFile(n.path));
  const saveSettingsCalls = [];
  const quickadd = {
    settings: { choices: existingChoices },
    saveSettings: async () => { saveSettingsCalls.push([...quickadd.settings.choices]); },
  };
  const app = {
    vault: { getMarkdownFiles: () => files },
    metadataCache: {
      getFileCache: (file) => {
        const n = notes.find((x) => x.path === file.path);
        return n ? { frontmatter: n.frontmatter } : null;
      },
      // links: { "[linktext]": "resolved/path.md" | null }
      getFirstLinkpathDest: (linktext) => {
        const resolved = links[linktext];
        return resolved ? fakeFile(resolved) : null;
      },
    },
    plugins: { plugins: { quickadd } },
  };
  const ctx = {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "test",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [] }),
  };
  registerQuickAddTools(server, app, ctx);
  return { handler: server.tools.get("obsidian_quickadd_compile").handler, quickadd, saveSettingsCalls };
}

function macroNote(path, name, scriptLink) {
  return {
    path,
    frontmatter: {
      "quickadd-type": "macro",
      name,
      steps: [{ kind: "userscript", script: `[[${scriptLink}]]` }],
    },
  };
}

describe("obsidian_quickadd_compile: dry_run", () => {
  test("dry_run: true reports the compiled result and writes nothing", async () => {
    const { handler, quickadd, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].name, "Stamp title");
    assert.deepEqual(quickadd.settings.choices, []);
    assert.deepEqual(saveSettingsCalls, []);
  });

  test("dry_run: false compiles and calls saveSettings", async () => {
    const { handler, quickadd, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(quickadd.settings.choices.length, 1);
    assert.equal(quickadd.settings.choices[0].name, "Stamp title");
    assert.equal(saveSettingsCalls.length, 1);
  });
});

describe("obsidian_quickadd_compile: scoped merge — never touches non-compiler-owned choices", () => {
  test("an existing hand-authored choice (no qan: id) survives a compile untouched", async () => {
    const handAuthored = { id: "some-uuid", name: "Hand Authored", type: "Macro" };
    const { handler, quickadd } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [handAuthored],
    });
    await handler({ dry_run: false });
    assert.deepEqual(quickadd.settings.choices.find((c) => c.id === "some-uuid"), handAuthored);
    assert.equal(quickadd.settings.choices.length, 2);
  });

  test("a compiler-owned choice whose note no longer declares it is removed on recompile", async () => {
    const stale = { id: "qan:Choices/Gone.md#choice", name: "Gone", type: "Macro" };
    const { handler, quickadd } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [stale],
    });
    await handler({ dry_run: false });
    assert.equal(quickadd.settings.choices.find((c) => c.id === "qan:Choices/Gone.md#choice"), undefined);
    assert.equal(quickadd.settings.choices.length, 1);
  });

  test("recompiling with no choice notes at all removes every compiler-owned choice, leaves the rest", async () => {
    const handAuthored = { id: "some-uuid", name: "Hand Authored", type: "Macro" };
    const stale = { id: "qan:Choices/Gone.md#choice", name: "Gone", type: "Macro" };
    const { handler, quickadd } = build({ notes: [], existingChoices: [handAuthored, stale] });
    await handler({ dry_run: false });
    assert.deepEqual(quickadd.settings.choices, [handAuthored]);
  });
});

describe("obsidian_quickadd_compile: per-choice error isolation", () => {
  test("an unresolvable script link fails only that note; the rest still compile", async () => {
    const { handler } = build({
      notes: [
        macroNote("Choices/Bad.md", "Bad", "nope"),
        macroNote("Choices/Good.md", "Good", "stamp-title"),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md" }, // "nope" deliberately absent
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].name, "Good");
    assert.equal(res.structuredContent.errors.length, 1);
    assert.equal(res.structuredContent.errors[0].notePath, "Choices/Bad.md");
  });

  test("a note with quickadd-type other than macro is ignored (Stage B+ territory), not an error", async () => {
    const { handler } = build({
      notes: [
        { path: "Choices/T.md", frontmatter: { "quickadd-type": "template", name: "T" } },
        macroNote("Choices/Good.md", "Good", "stamp-title"),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.errors.length, 0);
  });

  test("a note with no quickadd-type frontmatter at all is ignored, not an error", async () => {
    const { handler } = build({
      notes: [
        { path: "Some/Other/Note.md", frontmatter: { title: "Unrelated" } },
        macroNote("Choices/Good.md", "Good", "stamp-title"),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.errors.length, 0);
  });
});

describe("obsidian_quickadd_compile: name fallback", () => {
  test("a macro note missing name: falls back to the note's basename", async () => {
    const note = macroNote("Choices/Fallback Name.md", undefined, "stamp-title");
    delete note.frontmatter.name;
    const { handler } = build({ notes: [note], links: { "stamp-title": "Scripts/stamp-title.md" } });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices[0].name, "Fallback Name");
  });
});

describe("obsidian_quickadd_compile: QuickAdd unavailable", () => {
  test("a typed refusal when QuickAdd isn't installed/enabled", async () => {
    const server = fakeServer();
    const app = {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
      plugins: { plugins: {} },
    };
    const ctx = {
      pluginVersion: "0.0.0-test", socketPath: "/tmp/x.sock", vaultName: "test",
      enabledPlugins: () => [], getSettings: () => ({ readOnly: false, allowlist: [] }),
    };
    registerQuickAddTools(server, app, ctx);
    const res = await server.tools.get("obsidian_quickadd_compile").handler({ dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[quickadd_unavailable\]/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: FAIL — `Cannot find module '../src/mcp/tools-quickadd.ts'`.

- [ ] **Step 3: Write the glue tool**

```typescript
// packages/plugin/src/mcp/tools-quickadd.ts
//
// obsidian_quickadd_compile — Stage A of "QuickAdd macros as notes"
// (docs/superpowers/specs/2026-08-18-quickadd-macros-as-notes-design.md).
// Discovers Macro/UserScript choice notes by frontmatter, resolves their
// wikilinks, feeds the pure transform (kernel/quickadd/transform.ts), and
// applies the result via QuickAdd's own saveSettings() — vault-mcp is a
// full Obsidian plugin, so no raw data.json parsing is needed.
//
// The write is a SCOPED MERGE, never a full overwrite: only choices whose
// id carries the qan: compiler-owned prefix (see transform.ts) are
// replaced/added/removed. Every other choice in QuickAdd's live config —
// hand-authored, or managed by another mechanism entirely (e.g. the vault's
// own sync-quickadd-choices.js during the migration window) — passes
// through completely untouched. This is what lets Stage A ship before
// every choice in the vault is migrated to a note.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok, codedError } from "./helpers.js";
import type { ServerCtx } from "./tools-core.js";
import { transformChoices } from "../kernel/quickadd/transform.js";
import type { ChoiceNoteInput, MacroStepResolved, QuickAddMacroChoice } from "../kernel/quickadd/types.js";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const ID_PREFIX = "qan:";

/** Extract the link target from a raw `[[target]]` or `[[target|alias]]`
 *  string. Returns null if the string isn't wikilink-shaped at all — a
 *  malformed `script:` value is a per-choice error, not a resolution
 *  failure, so the caller distinguishes the two. */
function linkTarget(raw: string): string | null {
  const m = /^\[\[([^\]|]+)(\|[^\]]*)?\]\]$/.exec(raw.trim());
  return m ? m[1] : null;
}

function resolveUserScriptStep(app: App, notePath: string, step: any): MacroStepResolved {
  if (step?.kind !== "userscript") {
    return { kind: "unsupported", ok: false, declaredKind: String(step?.kind ?? "undefined") };
  }
  const raw = String(step.script ?? "");
  const target = linkTarget(raw);
  if (target === null) {
    return { kind: "userscript", ok: false, error: `"${raw}" is not a [[wikilink]].` };
  }
  // app.metadataCache is fully typed in obsidian's public API.
  const dest = app.metadataCache.getFirstLinkpathDest(target, notePath);
  if (!dest) {
    return { kind: "userscript", ok: false, error: `could not resolve "[[${target}]]".` };
  }
  return {
    kind: "userscript",
    ok: true,
    scriptPath: dest.path,
    settings: (step.settings && typeof step.settings === "object") ? step.settings : {},
  };
}

/** Reads every markdown note whose frontmatter declares `quickadd-type:
 *  macro` and builds its (unresolved-wikilink-aware) ChoiceNoteInput. Notes
 *  with no quickadd-type, or a quickadd-type other than "macro" (Stage B+
 *  territory — template/capture/multi), are silently skipped: they are
 *  simply out of Stage A's scope, not an error. */
function collectChoiceNotes(app: App): ChoiceNoteInput[] {
  const inputs: ChoiceNoteInput[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter || frontmatter["quickadd-type"] !== "macro") continue;

    const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name
      : file.path.split("/").pop()!.replace(/\.md$/, "");

    const rawSteps = Array.isArray(frontmatter.steps) ? frontmatter.steps : [];
    const steps = rawSteps.map((s) => resolveUserScriptStep(app, file.path, s));

    inputs.push({ quickaddType: "macro", notePath: file.path, name, steps });
  }
  return inputs;
}

export function registerQuickAddTools(server: McpServer, app: App, ctx: ServerCtx): void {
  server.registerTool(
    "obsidian_quickadd_compile",
    {
      title: "Compile QuickAdd choice notes",
      description:
        "Compiles every Macro/UserScript choice note (frontmatter quickadd-type: macro) into QuickAdd's live " +
        "config. `dry_run: true` reports the compiled choices and any per-note errors without touching anything; " +
        "`dry_run: false` applies it via QuickAdd's own saveSettings(). The write is a SCOPED MERGE — only " +
        "choices this tool itself generated (a stable id derived from the note's path) are added/updated/removed; " +
        "every other choice in QuickAdd's config is left completely untouched, whatever manages it. One malformed " +
        "note fails only that note (reported in `errors`), never the whole compile. Stage A: Macro choices whose " +
        "steps are all UserScript. A note with a different quickadd-type, or a step of a different kind, is simply " +
        "out of scope here — silently skipped (quickadd-type notes) or a per-choice error (unsupported step kind).",
      inputSchema: {
        dry_run: z.boolean().describe("If true, report the compiled choices and errors without writing anything."),
      },
      annotations: RW,
    },
    async ({ dry_run }) => {
      // app.plugins is not in the public obsidian types — cast required.
      const quickadd = (app as any).plugins?.plugins?.quickadd;
      if (!quickadd?.settings || typeof quickadd.saveSettings !== "function") {
        return codedError("quickadd_unavailable", "QuickAdd is not installed, not enabled, or its API is unavailable.");
      }

      const inputs = collectChoiceNotes(app);
      const result = transformChoices(inputs);

      if (dry_run) {
        return ok({ dry_run: true, choices: result.choices, errors: result.errors });
      }

      // Scoped merge: drop every PREVIOUSLY compiler-owned choice (id starts
      // with qan:) unconditionally — a stale one whose note is gone or no
      // longer compiles is meant to disappear, not linger — then append this
      // compile's fresh set. Anything never compiler-owned (hand-authored,
      // or managed by another mechanism entirely) never enters this
      // filter's false branch, so it always survives untouched.
      const preserved = (quickadd.settings.choices as QuickAddMacroChoice[]).filter(
        (c: any) => typeof c.id !== "string" || !c.id.startsWith(ID_PREFIX)
      );
      quickadd.settings.choices = [...preserved, ...result.choices];
      await quickadd.saveSettings();

      return ok({ dry_run: false, applied: result.choices.length, choices: result.choices, errors: result.errors });
    }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Typecheck**

Run: `cd packages/plugin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin/src/mcp/tools-quickadd.ts packages/plugin/tests/quickadd-compile-tool.test.mjs
git commit -m "feat(mcp): obsidian_quickadd_compile — Stage A compiler glue tool"
```

---

### Task 3: Register the tool, update the locked inventory, live smoke test

**Files:**
- Modify: `packages/plugin/src/mcp/server.ts`
- Modify: `packages/plugin/TOOL-INVENTORY.md`

**Interfaces:**
- Consumes: `registerQuickAddTools` from Task 2.
- Produces: nothing further consumed in this plan — this is the last task.

- [ ] **Step 1: Register the tool in server.ts**

Find where `registerSchemeWriteTools` (or the nearest similar directly-registered mutating tool group) is called in `packages/plugin/src/mcp/server.ts` and add a call to `registerQuickAddTools` alongside it, following the exact same pattern (same `server`/`app`/`ctx` arguments). This tool mutates plugin config, not a vault note, so — like `registerSchemeWriteTools` — it CANNOT go through `modules-mount.ts` (that host refuses any tool whose `readOnlyHint !== true`); it registers directly in `server.ts`.

```typescript
// near the existing registerSchemeWriteTools(server, app, ctx) call:
import { registerQuickAddTools } from "./tools-quickadd.js";
// ...
registerQuickAddTools(server, app, ctx);
```

- [ ] **Step 2: Update TOOL-INVENTORY.md**

Add a row for `obsidian_quickadd_compile` to the table (find the section listing directly-registered mutating tools, alongside `obsidian_assign_address` etc.) and bump the count summary at the top by 1 (the "always-live" or equivalent bucket `obsidian_quickadd_compile` belongs to — match whichever bucket `obsidian_assign_address` is counted under, since this tool registers the identical way). Read the current file first; the exact count numbers will have moved since this plan was written (multiple other PRs land in this repo daily — verify against `tests/tool-inventory.test.mjs`, don't trust arithmetic by hand).

- [ ] **Step 3: Run the full test suite**

Run: `cd packages/plugin && npm test`
Expected: PASS, including `tests/tool-inventory.test.mjs` (confirms the inventory doc and the actual registered tool set agree in both directions).

- [ ] **Step 4: Live smoke test against the real vault**

Per packages/plugin/CLAUDE.md's "Verifying tools live" section — this tool's handler calls `app.*` (vault, metadataCache, and QuickAdd's own plugin API), so it cannot be verified by the unit tests above alone.

Build and deploy to a real vault for manual verification:
```bash
cd packages/plugin && npm run build
cp main.js manifest.json ~/obsidian/.obsidian/plugins/vault-mcp/
```
Reload the plugin (Advanced URI eval: `app.plugins.disablePlugin('vault-mcp').then(()=>app.plugins.enablePlugin('vault-mcp'))`, or ask the user to toggle it — vault-mcp cannot disable itself through its own MCP connection).

Create one real test choice note in the vault, e.g.:
```markdown
---
quickadd-type: macro
name: Smoke test choice
steps:
  - kind: userscript
    script: "[[some-existing-script-note]]"
    settings: {}
---
```
(Point `script:` at any real, already-existing script note in the vault, so wikilink resolution has something real to resolve.)

Pipe a `dry_run: true` call through the bridge (keep stdin open per CLAUDE.md's async-handler note):
```bash
( printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"obsidian_quickadd_compile","arguments":{"dry_run":true}}}\n'; sleep 4 ) | node ~/.claude/vault-mcp/bridge.mjs --vault <vault-name>
```
Expected: the response's `structuredContent.choices` includes the smoke-test choice, `errors` is empty, and (separately, by re-reading `.obsidian/plugins/quickadd/data.json`) nothing was written yet.

Then repeat with `dry_run: false`, and confirm in the SAME `data.json` read that the smoke-test choice is now present with an id starting `qan:`, and that no other existing choice was touched (spot-check a couple of untouched ids/names against a `data.json` snapshot taken before this step).

Delete the smoke-test note afterward — this step is verification, not a fixture to leave behind.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/mcp/server.ts packages/plugin/TOOL-INVENTORY.md
git commit -m "feat(mcp): register obsidian_quickadd_compile, update tool inventory"
```

---

## Rollout note (not a code task — do this when Stage A ships to the live vault)

Per Nelson's explicit call (cross-session log, 2026-08-18): once `obsidian_quickadd_compile` is verified working end-to-end against the live vault, it becomes canonical and **subsumes** the vault-side `sync-quickadd-choices.js` mechanism (built same-day by a different session, in `00.12 Scripts/QuickAdd choices/` + `00.12 Scripts/sync-quickadd-choices.js`) — the two must never run as simultaneous independent writers against the same `data.json`. This is a deployment-time / vault-content action (disable the js-engine startup script, migrate its 21 existing choice notes' content into Stage A's frontmatter schema — likely via the bootstrap tool once it exists, see "Deferred" below), not a `packages/plugin` code change, and is out of scope for this plan's own tasks.

## Deferred to follow-up plans (per the spec's own "Rollout" section)

This plan covers Stage A only: Macro choices whose steps are all UserScript. The design spec's full scope — Choice/Wait/Obsidian-command/NestedChoice/EditorCommand/AIAssistant step kinds, Template and Capture choice types, Multi (folder) choices, and the one-time bootstrap/reverse-generator tool — is real and specified, but is enough independent work to warrant its own plan(s) once Stage A has shipped and proven the pattern against the live vault. Writing those plans now, before Stage A's actual shape has been exercised against real notes, risks locking in interface details (the exact `MacroStepResolved` variants, the merge-write's scoping rule, the `quickadd-type` discovery convention) before Stage A has had a chance to reveal what, if anything, needs to change.
