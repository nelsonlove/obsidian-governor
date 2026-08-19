# QuickAdd macros as notes — Stage D (Multi choice type) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `obsidian_quickadd_compile` to discover and compile the fourth and final top-level choice type — `Multi` — completing the design spec's four choice types (Macro #237/#271/#282, Template/Capture #282, Multi this plan). `obsidian_quickadd_bootstrap` (the reverse-direction tool) remains deferred to Stage E.

**Architecture:** Same kernel/glue split as every prior stage — but Multi is architecturally different from Macro/Template/Capture in one load-bearing way: those three are each **one note, independently compiled**; Multi is **one folder-note anchoring its own parent folder**, whose members are *other notes and subfolders inside that folder* (per the design spec: "the choices nested under it are simply the notes and sub-folders inside that folder — membership is read from the folder's actual contents at compile time"). This means:

- Discovery stops being a flat, independent per-note scan. A note that lives directly inside a Multi-anchored folder is a **member** of that Multi and must compile as a NESTED entry inside the Multi's own `choices` array — never ALSO as a separate top-level entry in `data.json`. (Confirmed native behavior, verified during Stage C's research: QuickAdd's own `data.json` has no folder concept at all — a Multi's `choices` array is the ONLY place its members' compiled JSON lives, flattened inline. Two copies of the same choice, one top-level and one nested, is not a shape QuickAdd itself can produce and this compiler must not produce it either.)
- Nesting recurses: a subfolder of a Multi-anchored folder can itself be Multi-anchored (its own folder-note inside it), becoming a **nested Multi** — Multi-in-Multi, arbitrarily deep, exactly mirroring QuickAdd's own folder-organized settings UI.
- Cross-note reference cycles (Stage B/C's `detectChoiceCycles`) must now see the WHOLE compiled tree, not just the top level — a Macro choice that ends up nested inside a Multi can still carry a `choice:` step and participate in a cycle exactly as a top-level Macro can. `resolveChoiceStep`'s target validation has never cared about nesting (it only asks "does this compiler produce a choice for that note"), so this is a real, not hypothetical, interaction.

## Ground truth (verified during Stage C's research against QuickAdd's decompiled `main.js`, class `ng`)

```js
var ng = class extends $l {   // $l = the shared base class (id, name, type, command, onePageInput)
  constructor(t) {
    super(t, "Multi");
    this.choices = [];        // RECURSIVE — any choice type, including another Multi
    this.collapsed = false;   // UI-only: whether the folder is shown collapsed in QuickAdd's settings
  }
};
```

No `runOnStartup`, no `macro` field — the whole native shape is base fields plus `choices` and `collapsed`. **`command` is always `false`** in real usage: QuickAdd's own `ChoiceExecutor` refuses to run a Multi non-interactively (`"Multi choices are interactive and cannot be run via CLI."`), and every real Multi choice in the live vault (13, including 5 top-level) has `command: false` — a Multi's palette command, if ever set `true`, would only ever open an interactive picker, never actually run anything. This compiler always emits `command: false` for Multi, matching reality rather than merely defaulting to it.

**A Multi choice is NOT a valid `choice:` step target**, even though it now compiles. Verified during Stage C: QuickAdd's own macro-builder UI feeds its Choice-step picker every non-Multi choice (Template, Capture, Macro) but deliberately excludes Multi — a Multi choice is something you *open*, not something a Macro step can *invoke*. This plan preserves that restriction exactly (see Task 2's `CHOICE_STEP_TARGET_TYPES` split, below) — it is a genuine, deliberate divergence from "what this compiler discovers/compiles," not an oversight.

## Note schema

```yaml
quickadd-type: multi
name: My Multi Choice   # optional, same displayNameOf convention as every other choice note
```

No other frontmatter is required or read. A Multi note's membership comes entirely from **where the note lives**: it anchors its own parent folder, and every note (with a recognized `quickadd-type`) or anchored subfolder directly inside that same parent folder becomes a member, compiled and nested inline. There is no `folder:` field pointing elsewhere — the note's OWN path is the only signal, matching the spec's "folder is the source of truth" framing exactly (a `folder:` field pointing somewhere else would let a note's location and its declared scope disagree, which is exactly the drift class this whole project exists to close).

## Deliberate scope narrowing (documented, matching Stage B/C precedent)

- **`collapsed` is not exposed via frontmatter** — always compiles `false` (QuickAdd's own default; a fresh Multi choice created through its UI also starts uncollapsed). Purely cosmetic (whether the folder shows expanded or collapsed in QuickAdd's settings pane), and widening this later is a compatible, additive change.
- **Member order is alphabetical by path** — the folder has no other field to express a custom order, and QuickAdd's own settings UI does support manual drag-reordering that this compiler cannot see (drag order lives only in `data.json`, which this tool treats as generated output, never read back except through the existing scoped-merge diff). Alphabetical is deterministic and a function of the vault, which is what matters for `dry_run` to report a stable diff. A future stage could add an optional `order:` frontmatter list; out of scope here.
- **A note's `quickadd-type: multi` frontmatter anchors ONLY its own parent folder** — there is no way to make a note describe a folder other than the one it lives in. This is the spec's own design (folder-is-truth), not a narrowing, but it is worth stating plainly: moving a multi-note to a different folder changes what it anchors, exactly like moving any other choice note changes its own compiled id (`deriveChoiceId` is a pure function of path, unchanged this stage).

## Global Constraints

- No `obsidian` import in `kernel/quickadd/types.ts` or `transform.ts` — verify with `grep -n '"obsidian"' packages/plugin/src/kernel/quickadd/*.ts` after each task, must return nothing.
- `deriveChoiceId(notePath)` is reused unchanged for Multi choices too — id derivation stays a pure function of note path, no new id scheme.
- One malformed note fails only that one choice — for Multi specifically, this now has two layers: (a) the Multi note ITSELF can fail (only one way: an ambiguous folder claimed by 2+ multi-notes), and (b) an individual MEMBER can fail without failing the whole Multi (the Multi still compiles with its other, good members; the bad member's failure is reported in `errors` exactly like a top-level failure would be).
- **`CHOICE_STEP_TARGET_TYPES` (what a Macro `choice:` step may reference) and the discovery/compile gate (what `quickadd-type` this tool recognizes at all) are DELIBERATELY DIFFERENT SETS as of this stage** — `multi` is discoverable/compilable but NOT a valid choice-step target. Do not merge these back into one constant; see Task 2.
- Cycle detection (`detectChoiceCycles`) must run over the FULL compiled tree (top-level ∪ every nested descendant, recursively unpacked from every Multi's own `choices`), and cycle pruning must remove a cyclic choice from wherever it lives in that tree (top-level array or nested inside any Multi's `choices`) — see Task 1.
- Run `npx tsc --noEmit` and the full `npm test` from `packages/plugin/` after each task — both must be clean.

---

### Task 1: kernel types + recursive transform for Multi (including cycle detection over the full tree)

**Files:**
- Modify: `packages/plugin/src/kernel/quickadd/types.ts`
- Modify: `packages/plugin/src/kernel/quickadd/transform.ts`
- Test: `packages/plugin/tests/quickadd-transform.test.mjs`

**Interfaces:**
- Consumes: nothing new from outside this task.
- Produces: `MultiFolderOk`, `MultiFolderFailed`, `MultiChoiceNoteInput`, `QuickAddMultiChoice` — exported from `types.ts`. Widened `ChoiceNoteInput` (now a union of four) and widened `TransformResult.choices` element type (now includes `QuickAddMultiChoice`). Task 2's glue layer constructs `MultiChoiceNoteInput` (recursively, with resolved `members`) and passes it into the existing `transformChoices` exactly like every prior stage's inputs.

- [ ] **Step 1: Add the Multi types to `types.ts`**

Read the file first (it currently ends with `ChoiceError`/`TransformResult` after the Capture-related types). Insert the following **immediately after** the existing `CaptureChoiceNoteInput` interface, and replace the existing line
```typescript
export type ChoiceNoteInput = MacroChoiceNoteInput | TemplateChoiceNoteInput | CaptureChoiceNoteInput;
```
with the block below (the widened union moves to the end of this new block):

```typescript
/** A `quickadd-type: multi` note's folder, resolved by the glue layer (see
 *  mcp/tools-quickadd.ts's folder-anchoring discovery). `MultiFolderOk`
 *  carries the recursively-resolved membership: every note directly inside
 *  the multi note's OWN parent folder that this compiler claims — sibling
 *  notes with a recognized quickadd-type, and sibling SUBFOLDERS that are
 *  themselves anchored by their own multi-note (nested Multi-in-Multi,
 *  arbitrarily deep — folders cannot cycle, so this recursion always
 *  terminates). `MultiFolderFailed` covers the one way a Multi note itself
 *  can fail: another quickadd-type: multi note claims the SAME folder —
 *  ambiguous, so neither compiles (their sibling notes are unaffected and
 *  stay top-level, since an authoring mistake in one note's frontmatter
 *  must not make unrelated notes vanish). */
export interface MultiFolderOk {
  ok: true;
  members: ChoiceNoteInput[];
}
export interface MultiFolderFailed {
  ok: false;
  error: string;
}

/** One `quickadd-type: multi` choice note's data, already resolved by the
 *  glue layer. Unlike Macro/Template/Capture, a Multi note carries no
 *  required companion frontmatter field of its own — its members come
 *  entirely from folder membership, not from anything written in the note. */
export interface MultiChoiceNoteInput {
  quickaddType: "multi";
  notePath: string;
  name: string;
  folder: MultiFolderOk | MultiFolderFailed;
}

export type ChoiceNoteInput = MacroChoiceNoteInput | TemplateChoiceNoteInput | CaptureChoiceNoteInput | MultiChoiceNoteInput;
```

- [ ] **Step 2: Add the native `QuickAddMultiChoice` shape to `types.ts`, and widen `TransformResult`**

Add immediately after the existing `QuickAddCaptureChoice` interface:

```typescript
/** QuickAdd's native Multi-choice shape — verified against QuickAdd's
 *  decompiled source (class `ng`). The whole shape: base fields plus
 *  `choices` (RECURSIVE — any choice type, including another Multi) and
 *  `collapsed` (UI-only; not exposed via frontmatter this stage, always
 *  false). `command` is always `false`, matching real QuickAdd's own
 *  restriction that a Multi choice cannot run non-interactively — never a
 *  configurable field on this type. */
export interface QuickAddMultiChoice {
  id: string;
  name: string;
  type: "Multi";
  command: false;
  choices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice>;
  collapsed: false;
}
```

Then change:
```typescript
export interface TransformResult {
  choices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice>;
  errors: ChoiceError[];
}
```
to:
```typescript
export interface TransformResult {
  choices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice>;
  errors: ChoiceError[];
}
```

- [ ] **Step 3: Write the failing tests for the new transform behavior**

Read `packages/plugin/tests/quickadd-transform.test.mjs` in full first — it has `test`/`describe` from `node:test`, `assert` from `node:assert/strict` (`assert.equal`/`assert.deepEqual` are already strict; match this, not `assert.strictEqual`), and existing `macroInput`/`templateInput`/`captureInput` helpers (all defaulting to a minimal valid shape via `overrides = {}`). Add a matching `multiInput` helper right after `captureInput`:

```javascript
function multiInput(overrides = {}) {
  return {
    notePath: "QuickAdd choices/My Multi/My Multi.md",
    quickaddType: "multi",
    name: "My Multi",
    folder: { ok: true, members: [] },
    ...overrides,
  };
}
```

Then add these describe blocks:

```javascript
describe("transformChoices — Multi", () => {
  test("compiles an empty Multi (no members) using QuickAdd's own defaults", () => {
    const result = transformChoices([multiInput()]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.choices.length, 1);
    const choice = result.choices[0];
    assert.equal(choice.type, "Multi");
    assert.equal(choice.command, false);
    assert.deepEqual(choice.choices, []);
    assert.equal(choice.collapsed, false);
  });

  test("compiles a Multi with Macro/Template/Capture members, nested inline", () => {
    const result = transformChoices([
      multiInput({
        folder: {
          ok: true,
          members: [
            macroInput({ notePath: "QuickAdd choices/My Multi/A Macro.md", name: "A Macro" }),
            templateInput({ notePath: "QuickAdd choices/My Multi/B Template.md", name: "B Template" }),
            captureInput({ notePath: "QuickAdd choices/My Multi/C Capture.md", name: "C Capture" }),
          ],
        },
      }),
    ]);
    assert.equal(result.errors.length, 0);
    // The Multi is the ONE top-level entry — its members do not ALSO appear
    // top-level, matching native QuickAdd's own data.json shape (no folder
    // concept; a Multi's choices array is the only place members live).
    assert.equal(result.choices.length, 1);
    const multi = result.choices[0];
    assert.equal(multi.choices.length, 3);
    assert.deepEqual(multi.choices.map((c) => c.type), ["Macro", "Template", "Capture"]);
  });

  test("Multi-in-Multi nests correctly, arbitrarily deep", () => {
    const inner = multiInput({
      notePath: "QuickAdd choices/Outer/Inner/Inner.md",
      name: "Inner",
      folder: { ok: true, members: [macroInput({ notePath: "QuickAdd choices/Outer/Inner/Leaf.md", name: "Leaf" })] },
    });
    const outer = multiInput({
      notePath: "QuickAdd choices/Outer/Outer.md",
      name: "Outer",
      folder: { ok: true, members: [inner] },
    });
    const result = transformChoices([outer]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.choices.length, 1);
    const outerChoice = result.choices[0];
    assert.equal(outerChoice.choices.length, 1);
    const innerChoice = outerChoice.choices[0];
    assert.equal(innerChoice.type, "Multi");
    assert.equal(innerChoice.choices.length, 1);
    assert.equal(innerChoice.choices[0].name, "Leaf");
  });

  test("an ambiguous folder (glue layer's MultiFolderFailed) fails only that Multi note", () => {
    const result = transformChoices([
      multiInput({ folder: { ok: false, error: "ambiguous — 2 multi notes claim this folder" } }),
    ]);
    assert.equal(result.choices.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /ambiguous/);
  });

  test("a broken MEMBER fails only that member — the Multi still compiles with its other members", () => {
    const result = transformChoices([
      multiInput({
        folder: {
          ok: true,
          members: [
            captureInput({ notePath: "QuickAdd choices/My Multi/Good.md", name: "Good" }),
            templateInput({
              notePath: "QuickAdd choices/My Multi/Bad.md",
              name: "Bad",
              template: { ok: false, error: "could not resolve" },
            }),
          ],
        },
      }),
    ]);
    assert.equal(result.choices.length, 1); // the Multi itself still compiles
    assert.equal(result.choices[0].choices.length, 1); // only the good member
    assert.equal(result.choices[0].choices[0].name, "Good");
    assert.equal(result.errors.length, 1); // the bad member's failure IS reported
    assert.match(result.errors[0].message, /could not resolve/);
  });
});

describe("transformChoices — cycle detection sees nested choices", () => {
  test("a cycle between a NESTED Macro (inside a Multi) and a TOP-LEVEL Macro is caught, and only the cyclic pair is pruned", () => {
    const nestedMacro = macroInput({
      notePath: "QuickAdd choices/My Multi/Nested.md",
      name: "Nested",
      steps: [choiceStep({ choiceId: "qan:QuickAdd choices/TopLevel.md#choice", displayName: "TopLevel" })],
    });
    const survivingSibling = captureInput({ notePath: "QuickAdd choices/My Multi/Survivor.md", name: "Survivor" });
    const multi = multiInput({ folder: { ok: true, members: [nestedMacro, survivingSibling] } });
    const topLevelMacro = macroInput({
      notePath: "QuickAdd choices/TopLevel.md",
      name: "TopLevel",
      steps: [choiceStep({ choiceId: "qan:QuickAdd choices/My Multi/Nested.md#choice", displayName: "Nested" })],
    });
    const result = transformChoices([multi, topLevelMacro]);
    // The top-level Macro is dropped entirely (it WAS the cyclic choice).
    assert.equal(result.choices.length, 1);
    assert.equal(result.choices[0].type, "Multi");
    // The Multi survives, but its NESTED cyclic member is pruned — only the
    // surviving sibling remains inside it.
    assert.equal(result.choices[0].choices.length, 1);
    assert.equal(result.choices[0].choices[0].name, "Survivor");
    // Both cyclic notes are reported as errors, by their real note paths.
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.some((e) => e.notePath === "QuickAdd choices/My Multi/Nested.md"));
    assert.ok(result.errors.some((e) => e.notePath === "QuickAdd choices/TopLevel.md"));
  });
});
```

(`choiceStep` is the file's existing helper, shown in the file's own header — reuse it, do not redefine.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: FAIL — `transformOne` doesn't yet handle `quickaddType: "multi"`, and cycle detection doesn't yet see nested choices.

- [ ] **Step 5: Add `transformMulti`, widen `OneResult` with `nestedErrors`, and update every existing `OneResult`-returning function**

Read `packages/plugin/src/kernel/quickadd/transform.ts` in full first. The current `OneResult` type is:
```typescript
type OneResult =
  | { ok: true; choice: QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice }
  | { ok: false; message: string };
```
Widen it to:
```typescript
type OneResult =
  | { ok: true; choice: QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice; nestedErrors: ChoiceError[] }
  | { ok: false; message: string };
```
`nestedErrors` carries failures from a Multi's OWN members that must NOT fail the Multi itself but DO need to end up in the overall `TransformResult.errors` — always `[]` for Macro/Template/Capture (they have no children of their own). Add `nestedErrors: []` to the THREE existing `{ ok: true, choice: {...} }` return sites in `transformTemplate`, `transformCapture`, and `transformMacro` (do not otherwise change those functions).

Add `transformMulti`, and wire it into `transformOne`'s switch:

```typescript
function transformMulti(input: MultiChoiceNoteInput): OneResult {
  if (!input.folder.ok) {
    return { ok: false, message: `Multi "${input.name}" (${input.notePath}): ${input.folder.error}` };
  }
  const memberChoices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice> = [];
  const nestedErrors: ChoiceError[] = [];
  for (const member of input.folder.members) {
    const r = transformOne(member);
    if (r.ok) {
      memberChoices.push(r.choice);
      nestedErrors.push(...r.nestedErrors);
    } else {
      nestedErrors.push({ notePath: member.notePath, message: r.message });
    }
  }
  return {
    ok: true,
    nestedErrors,
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Multi",
      command: false,
      choices: memberChoices,
      collapsed: false,
    },
  };
}
```

Update `transformOne`'s switch:
```typescript
function transformOne(input: ChoiceNoteInput): OneResult {
  switch (input.quickaddType) {
    case "macro":
      return transformMacro(input);
    case "template":
      return transformTemplate(input);
    case "capture":
      return transformCapture(input);
    case "multi":
      return transformMulti(input);
  }
}
```

Update the file's imports at the top to add `MultiChoiceNoteInput`, `QuickAddMultiChoice` from `./types.js`.

- [ ] **Step 6: Update `transformChoices` — consume `nestedErrors`, and make cycle detection/pruning see the full tree**

Read the current `transformChoices` and `detectChoiceCycles` in full first (they are the two functions this step touches; `detectChoiceCycles`'s OWN internal Tarjan logic is NOT changed — only what gets passed into it, and what happens after it returns).

Add two new pure helper functions, placed near `detectChoiceCycles` (after `deriveStepId`, before `transformChoices`, matching this file's existing top-to-bottom order of helpers-before-their-caller):

```typescript
/** The union every compiled choice shape belongs to — named here once so
 *  `flattenAll`/`pruneCyclic`/`transformChoices` don't each re-spell it. */
type QuickAddChoice = QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice;

/** Recovers the original note path from a compiler-owned choice id — the
 *  exact reverse of `deriveChoiceId`. Always exact (not a search — undoing a
 *  known prefix+suffix concatenation), regardless of what characters appear
 *  in the note path itself. Used for cycle-error messages so they name the
 *  note a human edits, not the compiler-owned id. */
function notePathOfChoiceId(id: string): string {
  return id.slice(ID_PREFIX.length, id.length - "#choice".length);
}

/** Recursively walks a compiled choice tree (a Multi's own `choices` array,
 *  arbitrarily deep) into one flat list. Cycle detection must see this full
 *  set, not just the top level: a Macro choice nested inside a Multi is
 *  exactly as capable of participating in a choice-step reference cycle as
 *  a top-level one — resolveChoiceStep's target validation never
 *  distinguishes nested from top-level, only "does this compiler produce a
 *  choice for that note." */
function flattenAll(choices: QuickAddChoice[]): QuickAddChoice[] {
  const out: QuickAddChoice[] = [];
  for (const c of choices) {
    out.push(c);
    if (c.type === "Multi") out.push(...flattenAll(c.choices));
  }
  return out;
}

/** Recursively rebuilds a compiled choice tree with every id in `cyclic`
 *  removed, wherever it lives — the top-level array, or nested inside any
 *  Multi's own `choices` array at any depth. A Multi that loses a cyclic
 *  MEMBER simply has a smaller `choices` array; the Multi itself is only
 *  removed if the Multi's OWN id is in `cyclic` (which cannot happen today,
 *  since Multi choices carry no `macro.commands` and so can never be a node
 *  in detectChoiceCycles' graph — this function stays correct regardless,
 *  rather than assuming that invariant). */
function pruneCyclic(choices: QuickAddChoice[], cyclic: Set<string>): QuickAddChoice[] {
  const out: QuickAddChoice[] = [];
  for (const c of choices) {
    if (cyclic.has(c.id)) continue;
    out.push(c.type === "Multi" ? { ...c, choices: pruneCyclic(c.choices, cyclic) } : c);
  }
  return out;
}
```

Then replace the body of `transformChoices` with:

```typescript
export function transformChoices(inputs: ChoiceNoteInput[]): TransformResult {
  const compiled: QuickAddChoice[] = [];
  const errors: ChoiceError[] = [];

  for (const input of inputs) {
    const result = transformOne(input);
    if (result.ok) {
      compiled.push(result.choice);
      errors.push(...result.nestedErrors);
    } else {
      errors.push({ notePath: input.notePath, message: result.message });
    }
  }

  // Multi-note reference cycles (A → B → A, and longer). QuickAdd's
  // executeChoice has NO cycle detection — no visited set, no depth cap — so
  // running any choice in a cycle loops forever in Obsidian. The glue layer
  // already rejects the DIRECT case (a choice step pointing at its own note)
  // with a more specific message, but it can only see one step of one note
  // at a time; a cycle spanning two or more notes is only visible over the
  // whole compiled set — and as of Stage D that set includes choices NESTED
  // inside a Multi, not just top-level ones, since nesting has no bearing
  // on whether a Macro's choice: step can form a cycle.
  const allCompiled = flattenAll(compiled);
  const byId = new Map(allCompiled.map((c) => [c.id, c]));
  const macroChoices = allCompiled.filter((c): c is QuickAddMacroChoice => c.type === "Macro");
  const cycles = detectChoiceCycles(macroChoices);
  const cyclic = new Set<string>();
  for (const cycle of cycles) {
    const paths = cycle.map((id) => notePathOfChoiceId(id));
    for (const id of cycle) {
      cyclic.add(id);
      const choice = byId.get(id);
      if (!choice) continue;
      errors.push({
        notePath: notePathOfChoiceId(id),
        message:
          `Macro "${choice.name}" (${notePathOfChoiceId(id)}) is part of a choice-step reference cycle involving: ` +
          `${paths.join(", ")}. QuickAdd has no cycle guard, so running any choice in the cycle would loop ` +
          "forever at run time — every note in the cycle is dropped from this compile. Break the cycle by " +
          "removing one of the choice steps.",
      });
    }
  }

  const choices = cyclic.size === 0 ? compiled : pruneCyclic(compiled, cyclic);

  return { choices, errors };
}
```

Also update `detectChoiceCycles`'s own parameter type annotation from `QuickAddMacroChoice[]` — it already only accepts that type and its internal logic is unchanged; no edit needed there beyond what Step 5/6 already require via the wider imports.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-transform.test.mjs`
Expected: PASS, including every pre-existing Macro/Template/Capture test unchanged (compare the pre-existing test count against this task's BASE commit, not just "no failures").

- [ ] **Step 8: Typecheck and commit**

Run: `cd packages/plugin && npx tsc --noEmit` — must be clean.

```bash
git add packages/plugin/src/kernel/quickadd/types.ts packages/plugin/src/kernel/quickadd/transform.ts packages/plugin/tests/quickadd-transform.test.mjs
git commit -m "feat(kernel): Stage D — Multi choice type, recursive nesting, tree-wide cycle detection"
```

---

### Task 2: glue-layer folder-anchoring discovery for Multi

**Files:**
- Modify: `packages/plugin/src/mcp/tools-quickadd.ts`
- Test: `packages/plugin/tests/quickadd-compile-tool.test.mjs`

**Interfaces:**
- Consumes: `MultiChoiceNoteInput`, `MultiFolderOk`/`MultiFolderFailed`, `QuickAddMultiChoice` (Task 1, `../kernel/quickadd/types.js`).
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Read the existing discovery code first**

Read `packages/plugin/src/mcp/tools-quickadd.ts` in full — specifically `collectChoiceNotes`, `COMPILED_QUICKADD_TYPES`/`COMPILED_QUICKADD_TYPE_SET`, `displayNameOf`, and `resolveChoiceStep` (the `COMPILED_QUICKADD_TYPE_SET.has(...)` check inside it — this is the SET THAT MUST NOT GAIN `"multi"`, per this stage's whole point: a Multi choice compiles now, but a Macro `choice:` step still may not target one).

**This step is important to get right — read `COMPILED_QUICKADD_TYPES`' own doc comment first.** It currently says "the ONE list, shared by collectChoiceNotes... and resolveChoiceStep... because the two answer the same question." As of this stage that is no longer true — "what does this compiler discover/compile" and "what may a choice: step target" are two DIFFERENT questions for the first time (Multi answers yes to the first, no to the second). This step splits the one constant into two.

- [ ] **Step 2: Split `COMPILED_QUICKADD_TYPES` into two constants**

Replace:
```typescript
/** The `quickadd-type` values this compiler actually compiles into a choice.
 *  The ONE list, shared by `collectChoiceNotes` (what gets discovered) and
 *  `resolveChoiceStep` (what a `choice:` step may reference), because the two
 *  answer the same question: does this compile produce a choice for that
 *  note? `multi` is deliberately absent — Stage D territory, so a reference
 *  to one is still permanently dangling. */
const COMPILED_QUICKADD_TYPES = ["macro", "template", "capture"] as const;
const COMPILED_QUICKADD_TYPE_SET: ReadonlySet<unknown> = new Set(COMPILED_QUICKADD_TYPES);
```
with:
```typescript
/** Every `quickadd-type` this compiler discovers and compiles into a
 *  choice — used by `collectChoiceNotes`'s discovery gate. Widened in
 *  Stage D to include `multi`. */
const DISCOVERABLE_QUICKADD_TYPES = ["macro", "template", "capture", "multi"] as const;
const DISCOVERABLE_QUICKADD_TYPE_SET: ReadonlySet<unknown> = new Set(DISCOVERABLE_QUICKADD_TYPES);

/** The `quickadd-type` values a Macro `choice:` step may reference —
 *  DELIBERATELY NARROWER than `DISCOVERABLE_QUICKADD_TYPES` as of Stage D.
 *  `multi` is discoverable/compilable but is NOT a valid choice-step target:
 *  verified against QuickAdd's own source, its macro-builder UI's Choice-
 *  step picker excludes Multi choices entirely (you open a Multi, you don't
 *  invoke it from a Macro step), and its runtime refuses to run a Multi
 *  choice non-interactively. Do not widen this to match
 *  DISCOVERABLE_QUICKADD_TYPES without re-verifying that restriction — the
 *  two constants answering DIFFERENT questions is the point, not a gap. */
const CHOICE_STEP_TARGET_TYPES = ["macro", "template", "capture"] as const;
const CHOICE_STEP_TARGET_TYPE_SET: ReadonlySet<unknown> = new Set(CHOICE_STEP_TARGET_TYPES);
```

Then update every existing use:
- In `resolveChoiceStep`: `COMPILED_QUICKADD_TYPE_SET.has(...)` → `CHOICE_STEP_TARGET_TYPE_SET.has(...)`, and `COMPILED_QUICKADD_TYPES.join(", ")` in its error message → `CHOICE_STEP_TARGET_TYPES.join(", ")` (this message's meaning is unchanged in substance — it still lists exactly `macro, template, capture` — but now sourced from the correctly-scoped constant name).
- In `collectChoiceNotes` (rewritten fully in Step 4 below, but note the constant name change here for clarity): every `COMPILED_QUICKADD_TYPE_SET` reference becomes `DISCOVERABLE_QUICKADD_TYPE_SET`.

- [ ] **Step 3: Write the failing tests for Multi discovery**

Read `packages/plugin/tests/quickadd-compile-tool.test.mjs` in full first. Its `build({notes, links, ...})` helper's `notes` array items are `{path, frontmatter}` (see the existing `macroNote`/`templateNote`/`captureNote` fixture helpers — match that shape exactly). Add a matching fixture helper right after `captureNote`:

```javascript
function multiNote(path, name, extra = {}) {
  return { path, frontmatter: { "quickadd-type": "multi", name, ...extra } };
}
```

Then add these describe blocks (using `test(...)`, matching the file's own convention):

```javascript
describe("obsidian_quickadd_compile — Multi discovery", () => {
  test("a sibling capture/template/macro note directly in a Multi's folder nests, not top-level", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/My Multi/My Multi.md", "My Multi"),
        captureNote("Choices/My Multi/A Capture.md", "A Capture", { target: "some/path.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    // ONE top-level choice — the Multi. The Capture note does NOT ALSO
    // appear top-level.
    assert.equal(res.structuredContent.choices.length, 1);
    const multi = res.structuredContent.choices[0];
    assert.equal(multi.type, "Multi");
    assert.equal(multi.choices.length, 1);
    assert.equal(multi.choices[0].name, "A Capture");
  });

  test("multiple siblings nest in alphabetical order by path", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/My Multi/My Multi.md", "My Multi"),
        captureNote("Choices/My Multi/Zebra.md", "Zebra", { target: "z.md" }),
        captureNote("Choices/My Multi/Apple.md", "Apple", { target: "a.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    const multi = res.structuredContent.choices[0];
    assert.deepEqual(multi.choices.map((c) => c.name), ["Apple", "Zebra"]);
  });

  test("Multi-in-Multi: a subfolder anchored by its own multi-note nests as a nested Multi", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/Outer/Outer.md", "Outer"),
        multiNote("Choices/Outer/Inner/Inner.md", "Inner"),
        captureNote("Choices/Outer/Inner/Leaf.md", "Leaf", { target: "leaf.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices.length, 1);
    const outer = res.structuredContent.choices[0];
    assert.equal(outer.choices.length, 1);
    const inner = outer.choices[0];
    assert.equal(inner.type, "Multi");
    assert.equal(inner.choices.length, 1);
    assert.equal(inner.choices[0].name, "Leaf");
  });

  test("a note in a folder with NO multi-note stays top-level (regression check)", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Plain/A Capture.md", "A Capture", { target: "x.md" })],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].type, "Capture");
  });

  test("an ambiguous folder (2 multi-notes claiming the same folder) fails BOTH notes; siblings stay top-level", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/Ambiguous/First.md", "First"),
        multiNote("Choices/Ambiguous/Second.md", "Second"),
        captureNote("Choices/Ambiguous/Sibling.md", "Sibling", { target: "s.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 2);
    assert.ok(res.structuredContent.errors.every((e) => /ambiguous/i.test(e.message)));
    // The sibling capture note is unaffected — it's neither an ambiguous
    // multi-note nor claimed by one (an ambiguous folder is treated as
    // UNCLAIMED for membership purposes), so it stays top-level.
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].name, "Sibling");
  });

  test("a Macro choice: step CANNOT target a Multi choice — still a dangling-reference error", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/My Multi/My Multi.md", "My Multi"),
        macroNoteWithSteps("Choices/Referrer.md", "Referrer", [{ kind: "choice", choice: "[[My Multi]]" }]),
      ],
      links: { "My Multi": "Choices/My Multi/My Multi.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /does not declare a quickadd-type this compiler compiles/);
  });

  test("an empty Multi folder (no members) compiles a Multi with an empty choices array", async () => {
    const { handler } = build({ notes: [multiNote("Choices/Empty/Empty.md", "Empty")] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.deepEqual(res.structuredContent.choices[0].choices, []);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: FAIL — `collectChoiceNotes` doesn't yet recognize `quickadd-type: "multi"`, so these notes are silently skipped.

- [ ] **Step 5: Rewrite `collectChoiceNotes` for folder-anchoring discovery**

Read the existing `collectChoiceNotes` in full first. Replace the whole function with:

```typescript
/** The folder a note lives directly inside — vault-root notes (no `/` in
 *  their path) return `""`. Pure path math; no `obsidian` folder API is
 *  needed anywhere in this file, because "does folder F have an anchored
 *  subfolder" reduces to "is some anchored folder's OWN parent === F",
 *  computable entirely from the flat markdown-file listing this function
 *  already has. */
function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Reads every markdown note whose frontmatter declares a recognized
 *  `quickadd-type` (`macro`, `template`, `capture`, `multi`) and builds its
 *  (unresolved-wikilink-aware) ChoiceNoteInput. Notes with no quickadd-type,
 *  or one this compiler doesn't recognize, are silently skipped: simply out
 *  of scope, not an error.
 *
 *  As of Stage D this is no longer a flat, independent per-note walk. A
 *  `quickadd-type: multi` note ANCHORS its own parent folder — every OTHER
 *  recognized note directly inside that same folder, and every direct
 *  SUBFOLDER that is itself anchored by its own multi-note, becomes a
 *  MEMBER of that Multi (compiled nested inside it) rather than a top-level
 *  entry. This function returns only the TOP-LEVEL inputs; membership is
 *  resolved recursively via `buildInput` below and lives inside each
 *  Multi's own `folder.members`. */
function collectChoiceNotes(app: App): ChoiceNoteInput[] {
  type Typed = { path: string; frontmatter: Record<string, unknown>; quickaddType: string };
  const typed: Typed[] = [];
  const multiNotesByFolder = new Map<string, string[]>();

  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) continue;
    const quickaddType = frontmatter["quickadd-type"];
    if (!DISCOVERABLE_QUICKADD_TYPE_SET.has(quickaddType)) continue;
    typed.push({ path: file.path, frontmatter, quickaddType: quickaddType as string });
    if (quickaddType === "multi") {
      const folder = parentFolder(file.path);
      const list = multiNotesByFolder.get(folder) ?? [];
      list.push(file.path);
      multiNotesByFolder.set(folder, list);
    }
  }

  // A folder with exactly one multi-note is cleanly anchored. A folder with
  // 2+ is ambiguous — neither compiles, but this does NOT remove the folder
  // from consideration for its OTHER (non-multi) siblings, which stay
  // top-level (an authoring mistake in one note must not disappear unrelated
  // notes).
  const anchoredFolders = new Map<string, string>();
  const ambiguousFolders = new Map<string, string[]>();
  for (const [folder, notes] of multiNotesByFolder) {
    if (notes.length === 1) anchoredFolders.set(folder, notes[0]);
    else ambiguousFolders.set(folder, notes);
  }

  // `claimedBy` maps a CLAIMED note's path to the folder that claims it —
  // not just a Set, because the "claiming folder" is NOT always the note's
  // own parent (see below), and `buildInput` needs to filter "which notes
  // does THIS SPECIFIC anchored folder own" without re-deriving that
  // relationship from scratch.
  //
  // A plain note (macro/template/capture) is claimed by its own parent
  // folder, when that folder is anchored — straightforward.
  //
  // A MULTI-note is different: it anchors its OWN parent folder (call it
  // F), so `anchoredFolders.get(F)` is trivially itself — checking F for
  // anchoring would never determine whether the multi-note is ALSO nested
  // under some ANCESTOR Multi. The right question is one level further out:
  // is F's own parent (F's grandparent relative to the note) anchored by a
  // DIFFERENT multi-note? If so, F itself is a subfolder-member of that
  // outer anchor, and the note that anchors F (this multi-note) is what
  // ends up nested inside the outer Multi's `choices` — compiled recursively
  // via its own `folder.members`, which is unaffected by any of this.
  const claimedBy = new Map<string, string>();
  for (const t of typed) {
    if (t.quickaddType === "multi") {
      const ownFolder = parentFolder(t.path);
      const grandparent = parentFolder(ownFolder);
      if (anchoredFolders.has(grandparent)) claimedBy.set(t.path, grandparent);
    } else {
      const folder = parentFolder(t.path);
      if (anchoredFolders.has(folder)) claimedBy.set(t.path, folder);
    }
  }

  const byPath = new Map(typed.map((t) => [t.path, t]));

  function buildInput(path: string): ChoiceNoteInput {
    const t = byPath.get(path)!;
    const name = displayNameOf(t.frontmatter, path);
    if (t.quickaddType === "macro") {
      const rawSteps = Array.isArray(t.frontmatter.steps) ? t.frontmatter.steps : [];
      const steps = rawSteps.map((s) => resolveStep(app, path, s));
      return { quickaddType: "macro", notePath: path, name, steps };
    }
    if (t.quickaddType === "template") return resolveTemplateChoice(app, path, name, t.frontmatter);
    if (t.quickaddType === "capture") return resolveCaptureChoice(app, path, name, t.frontmatter);

    // multi
    const folder = parentFolder(path); // == the folder this note anchors
    const ambiguous = ambiguousFolders.get(folder);
    if (ambiguous) {
      return {
        quickaddType: "multi",
        notePath: path,
        name,
        folder: {
          ok: false,
          error:
            `${ambiguous.length} quickadd-type: multi notes claim the same folder "${folder}" (${ambiguous.join(", ")}) ` +
            "— ambiguous, so none of them compiled. Move one to a different folder or remove the duplicate marking.",
        },
      };
    }
    // A member of THIS folder is exactly a note claimedBy THIS folder — not
    // `parentFolder(p) === folder`, which is only true for plain-note
    // members. A nested multi-note's own path lives one level DEEPER than
    // `folder` (inside the subfolder it itself anchors), so its claim was
    // recorded against `folder` (its grandparent-relative anchor) above,
    // not against its own immediate parent — `claimedBy` is exactly the
    // lookup that already encodes which is which.
    const memberPaths = [...byPath.keys()]
      .filter((p) => p !== path && claimedBy.get(p) === folder)
      .sort();
    return {
      quickaddType: "multi",
      notePath: path,
      name,
      folder: { ok: true, members: memberPaths.map((p) => buildInput(p)) },
    };
  }

  return typed.filter((t) => !claimedBy.has(t.path)).map((t) => buildInput(t.path));
}
```

- [ ] **Step 6: Update the tool's own description string**

Find the `description:` string in the `obsidian_quickadd_compile` tool registration. Read it in full first (it has accumulated Stage A/B/C caveats — this is an ADDITIVE update, do not lose any of them). Add, after the existing Template/Capture paragraph:

Add a sentence stating: Multi choice notes (`quickadd-type: multi`) are now also compiled — a Multi note anchors its own parent folder, and every other recognized choice note (or anchored subfolder, itself a nested Multi) directly inside that same folder becomes a member, compiled NESTED inside the Multi rather than as a separate top-level entry; two or more multi-notes claiming the same folder is a per-note error for each of them (their unrelated siblings are unaffected); a Multi choice is discoverable and compilable but is NOT a valid `choice:` step target (matching native QuickAdd's own restriction — a Multi is opened, not invoked from a Macro step).

Also update the sentence "A note with an unrecognized quickadd-type (e.g. multi) is simply out of scope here — silently skipped." — `multi` is no longer an example of an unrecognized type; remove it from that sentence (leave the sentence's general claim about truly-unrecognized types intact, just drop the now-wrong example).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/quickadd-compile-tool.test.mjs`
Expected: PASS, including every pre-existing Stage A/B/C test unchanged.

- [ ] **Step 8: Typecheck, full suite, and commit**

Run: `cd packages/plugin && npx tsc --noEmit && npm test` — both clean, confirm the actual full-suite pass count.

```bash
git add packages/plugin/src/mcp/tools-quickadd.ts packages/plugin/tests/quickadd-compile-tool.test.mjs
git commit -m "feat(mcp): Stage D glue — folder-anchoring discovery for Multi choices"
```

- [ ] **Step 9: Live verification (best-effort, matching Stage A/B/C's precedent)**

Per `packages/plugin/CLAUDE.md`'s "Verifying tools live" section: build (`npm run build`), and attempt to deploy to a real vault's `.obsidian/plugins/governor/` and pipe a `dry_run: true` compile through `bridge.mjs` against a real Multi choice note (create a throwaway folder+note under the vault's QuickAdd-choices root if none exists) — ONLY if this session has its own live MCP connection to verify a reload actually picked up the new bytes (per the fleet practice settled 2026-08-19: a session with no live connection to the target install must not swap bytes under it). If that's not available, or BRAT re-syncs from the published release before this can complete (the known issue from every prior stage), degrade gracefully to the unit/integration coverage above and note this in the report — do not block the plan on it, and do not deploy unverifiably to shared infrastructure other sessions may be using.

---

## Out of scope for this plan (carried forward, unchanged)

- `obsidian_quickadd_bootstrap` (the reverse-direction, `data.json` → notes tool) — Stage E.
- `nested-choice`/`ai-assistant` Macro step kinds — still deferred from Stage B.
- Every Multi native field not listed above (`collapsed` exposure via frontmatter, a manual `order:` field) — compiles to QuickAdd's own literal default, not configurable via frontmatter yet. Widening this is a compatible follow-up, not a redesign.
- A Multi choice as a `choice:` step target — deliberately, permanently out of scope (matches native QuickAdd's own restriction, not a gap this compiler should close).
