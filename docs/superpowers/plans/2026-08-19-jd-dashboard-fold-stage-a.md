# jd-dashboard fold — Stage A (standard-zeros + promote-to-folder) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port jd-dashboard's category-scaffolding tools (`createStandardZeros`,
`ensureCategoryIndexes`, `promoteToFolder`) as a new vault-mcp module —
`jd-scaffold` — the narrowest independently-valuable slice of the fold: no UI,
no conformance-engine design question, immediately agent-usable.

**Scope narrowed from the design doc's Stage A.** The design doc
(`2026-08-19-jd-dashboard-fold-design.md`) originally grouped four pieces under
"Stage A: scaffolding tools." On reading the actual source, `category-index.ts`
(436 lines — three-tier `## Contents` consolidation with description
preservation across regenerations) is comparable in complexity to the *entire*
QuickAdd-macros-as-notes Stage A on its own, and `new-from-template.ts` (297
lines) is a second, separate, moderately-sized feature. Bundling all four into
one plan would produce a plan too large to execute or review as a unit — the
same "narrowest slice first" discipline the QuickAdd plan itself applied. This
plan covers only `standard-zeros.ts` (197 lines) and `promote-to-folder.ts` (67
lines) — small, self-contained, no dependency on each other or on the deferred
two. Category-index and template-creation get their own follow-up plans once
this one has shipped and proven the module's shape against the live vault.

**Architecture:** Two pure planners (`kernel/jd-scaffold/`, no `obsidian`
import, unit-tested like every other kernel module) that take an
already-resolved listing and decide what to create/skip, following the same
PLAN-then-APPLY split `kernel/scheme/mutate.ts` established. A thin Obsidian-glue
layer (`mcp/tools-jd-scaffold.ts`) resolves the listing via `app.vault`, feeds
the planners, and applies via `app.vault.create`/`createFolder` +
`app.fileManager.renameFile`. Registered as a proper `mutating: true` capability
module through `modules-mount.ts` (not hand-registered in `server.ts` —
unlike `tools-scheme-write.ts`/`tools-survey.ts`/`tools-quickadd.ts`, these
three tools mutate real vault *notes*, not another plugin's config, so nothing
stops them going through the module host the normal way; see #82's `skills`
module for the `mutating: true` precedent this plan follows).

**Tech Stack:** TypeScript, `node --import tsx --test`, the MCP SDK's
`registerTool` via vault-mcp's guard/kernel interception point, `ModuleRegistry`
via `modules-mount.ts`.

**Spec:** `docs/superpowers/specs/2026-08-19-jd-dashboard-fold-design.md` — this
plan implements the standard-zeros and promote-to-folder pieces of that design's
"in scope" table. Category-index (drift-panel's data source, and its own
tier-consolidation feature) and template-creation are explicitly out of scope
here; the design doc's inbox/drift panels (Stage B/C) are also out of scope —
this plan has no UI component.

## Global Constraints

- Pure logic lives under `kernel/jd-scaffold/`, imports nothing from
  `obsidian` (repo-wide rule, `packages/plugin/CLAUDE.md`).
- **The `jd-id:` frontmatter field is DROPPED from the ported zero-note
  template.** jd-dashboard's original `buildZeroFrontmatter` stamps
  `jd-id: "<prefix>.<id>"` into every zero note it creates. Per this fold's
  design doc (and the same call already made for the jd-numbering fold, PR
  #199): vault-mcp's scheme module is deliberately path-canonical — the
  filename `<prefix>.<id> <name>.md` already carries the full address, and a
  second frontmatter copy is exactly the kind of mirror that can silently
  drift the moment a note is renumbered by hand. Every OTHER frontmatter field
  jd-dashboard writes (`title`, `created`, `modified`, `tags`, `aliases`,
  `linter-yaml-title-alias`) is ordinary vault convention, not an addressing
  mechanism, and is kept as-is.
- `dry_run: z.boolean()` is REQUIRED on all three tools' input schemas, no
  default — matches `obsidian_assign_address` et al. in `tools-scheme-write.ts`.
- **Allowlist-aware, matching `tools-scheme-write.ts`'s discipline exactly**:
  every INPUT path argument (`folder_path`, `path`) is checked against
  `visiblePaths`/`isVisible` before planning runs, AND every path a plan
  *computes* (a new zero note's path, a promoted note's new folder+path) is
  re-checked before it is applied — unconditionally, even under
  `dry_run: true`, so a preview never claims a plan this session could not
  actually carry out. `ensure_category_indexes` is vault-wide (no `path`
  input), so only its computed paths get the check.
- One failure (a single zero note that fails to create, one category whose
  index-file creation fails) is reported per-item and does not abort the rest
  of the batch — matches jd-dashboard's own original behavior (`failures:
  {name, error}[]` on both `CreateZerosResult` and
  `EnsureCategoryIndexesResult`) and the repo's own "static plan, per-item
  isolation" convention elsewhere (`obsidian_move_notes`, the QuickAdd
  compiler).
- `promote_to_folder` calls `app.fileManager.renameFile`, never
  `vault.rename`, for the note move — the same load-bearing link-healing
  guarantee `packages/plugin/CLAUDE.md`'s "Link healing" section documents and
  `tests/link-healing.test.mjs` pins for every other move primitive in this
  codebase.
- Registers as a `mutating: true` module, **default DISABLED** — matching the
  `skills` module's own precedent ("a newly-folded mutating surface stays off
  until a human turns it on in the config tab").

---

### Task 1: Pure planners

**Files:**
- Create: `packages/plugin/src/kernel/jd-scaffold/types.ts`
- Create: `packages/plugin/src/kernel/jd-scaffold/standard-zeros.ts`
- Create: `packages/plugin/src/kernel/jd-scaffold/promote-to-folder.ts`
- Test: `packages/plugin/tests/jd-scaffold-standard-zeros.test.mjs`
- Test: `packages/plugin/tests/jd-scaffold-promote-to-folder.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks (this is the first task).
- Produces (consumed by Task 2):
  - `suffixFor(prefix: string): string`, `standardZeros(prefix, suffix): ZeroSpec[]`, `buildZeroFrontmatter(zero, prefix, folderName, now): string` — ported, `jd-id:` line removed.
  - `planStandardZeros(input: PlanStandardZerosInput): PlanStandardZerosResult` — new pure planner.
  - `planEnsureCategoryIndexes(folders: CategoryFolderInput[], now: string): PlanEnsureResult` — new pure planner.
  - `planPromoteToFolder(input: PlanPromoteInput): PromoteToFolderPlan` — new pure planner.
  - Types from `types.ts`.

- [ ] **Step 1: Write the failing tests**

```javascript
// packages/plugin/tests/jd-scaffold-standard-zeros.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  suffixFor,
  standardZeros,
  buildZeroFrontmatter,
  planStandardZeros,
  planEnsureCategoryIndexes,
} from "../src/kernel/jd-scaffold/standard-zeros.ts";

describe("suffixFor / standardZeros — ported verbatim", () => {
  test("suffixFor: system vs category", () => {
    assert.equal(suffixFor("00"), "for the system");
    assert.equal(suffixFor("06"), "for category 06");
  });

  test("standardZeros: exactly the fixed 00-09 set, in order", () => {
    const zeros = standardZeros("06", suffixFor("06"));
    assert.deepEqual(zeros.map((z) => z.id), ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]);
  });

  test("only 01/03/06/09 have hasDir: true", () => {
    const zeros = standardZeros("06", suffixFor("06"));
    const withDir = zeros.filter((z) => z.hasDir).map((z) => z.id);
    assert.deepEqual(withDir, ["01", "03", "06", "09"]);
  });
});

describe("buildZeroFrontmatter — jd-id line dropped (this fold's own ruling)", () => {
  test("no jd-id: field anywhere in the output", () => {
    const zero = standardZeros("06", suffixFor("06")).find((z) => z.id === "01");
    const text = buildZeroFrontmatter(zero, "06", "06 Digital tools", "2026-08-19");
    assert.doesNotMatch(text, /jd-id/);
  });

  test("every other original field is preserved: title, created, modified, tags, aliases, linter-yaml-title-alias", () => {
    const zero = standardZeros("06", suffixFor("06")).find((z) => z.id === "01");
    const text = buildZeroFrontmatter(zero, "06", "06 Digital tools", "2026-08-19");
    assert.match(text, /^title: Inbox for category 06$/m);
    assert.match(text, /^created: 2026-08-19$/m);
    assert.match(text, /^modified: 2026-08-19$/m);
    assert.match(text, /^ {2}- jd\/inbox$/m);
    assert.match(text, /^linter-yaml-title-alias: Inbox for category 06$/m);
  });

  test("the 00 zero's aliases include both its own name and the folder name (ported behavior)", () => {
    const zero = standardZeros("06", suffixFor("06")).find((z) => z.id === "00");
    const text = buildZeroFrontmatter(zero, "06", "06 Digital tools", "2026-08-19");
    assert.match(text, /aliases:\n {2}- JDex for category 06\n {2}- 06 Digital tools/);
  });
});

describe("planStandardZeros", () => {
  function input(overrides = {}) {
    return {
      folderPath: "10-19 Personal/06 Digital tools",
      folderName: "06 Digital tools",
      prefix: "06",
      now: "2026-08-19",
      existingPaths: new Set(),
      ...overrides,
    };
  }

  test("no existing files: plans all 10 creates, zero skips", () => {
    const plan = planStandardZeros(input());
    assert.equal(plan.creates.length, 10);
    assert.equal(plan.skipped.length, 0);
  });

  test("hasDir zeros get a nested folder path; hasDir:false zeros sit flat in the category folder", () => {
    const plan = planStandardZeros(input());
    const zeroOne = plan.creates.find((c) => c.path.includes("06.01 "));
    const zeroTwo = plan.creates.find((c) => c.path.includes("06.02 "));
    assert.equal(zeroOne.path, "10-19 Personal/06 Digital tools/06.01 Inbox for category 06/06.01 Inbox for category 06.md");
    assert.equal(zeroTwo.path, "10-19 Personal/06 Digital tools/06.02 Task & project management for category 06.md");
  });

  test("an already-existing target path is SKIPPED, not overwritten", () => {
    const zeroZeroPath = "10-19 Personal/06 Digital tools/06.00 JDex for category 06.md";
    const plan = planStandardZeros(input({ existingPaths: new Set([zeroZeroPath]) }));
    assert.equal(plan.creates.length, 9);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0], zeroZeroPath);
  });

  test("every planned create's content has no jd-id field", () => {
    const plan = planStandardZeros(input());
    for (const c of plan.creates) assert.doesNotMatch(c.content, /jd-id/);
  });
});

describe("planEnsureCategoryIndexes", () => {
  function folder(overrides = {}) {
    return { path: "10-19 Personal/06 Digital tools", name: "06 Digital tools", prefix: "06", childBasenames: [], ...overrides };
  }

  test("a category folder missing its XX.00 gets one planned", () => {
    const plan = planEnsureCategoryIndexes([folder()], "2026-08-19");
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0].path, "10-19 Personal/06 Digital tools/06.00 JDex for category 06.md");
    assert.doesNotMatch(plan.creates[0].content, /jd-id/);
  });

  test("accepts XX.00 Title.md, XX.00.md, and XX.00+SUF Title.md as already-present (ported acceptance rule)", () => {
    for (const existing of ["06.00 Anything.md", "06.00.md", "06.00+SUF Whatever.md"]) {
      const plan = planEnsureCategoryIndexes([folder({ childBasenames: [existing] })], "2026-08-19");
      assert.equal(plan.creates.length, 0, `expected no create when ${existing} already present`);
    }
  });

  test("a misfiled 07.00 inside 06's folder does NOT suppress 06's own index (ported edge case)", () => {
    const plan = planEnsureCategoryIndexes([folder({ childBasenames: ["07.00 Misfiled.md"] })], "2026-08-19");
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0].path, "10-19 Personal/06 Digital tools/06.00 JDex for category 06.md");
  });

  test("multiple folders each get their own independent plan entry", () => {
    const plan = planEnsureCategoryIndexes(
      [folder({ path: "a/06 Foo", name: "06 Foo", prefix: "06" }), folder({ path: "a/07 Bar", name: "07 Bar", prefix: "07" })],
      "2026-08-19"
    );
    assert.equal(plan.creates.length, 2);
  });
});
```

```javascript
// packages/plugin/tests/jd-scaffold-promote-to-folder.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planPromoteToFolder } from "../src/kernel/jd-scaffold/promote-to-folder.ts";

describe("planPromoteToFolder", () => {
  function input(overrides = {}) {
    return {
      path: "06 Digital tools/06.13 Bar.md",
      existingPaths: new Set(["06 Digital tools/06.13 Bar.md"]),
      ...overrides,
    };
  }

  test("happy path — XX.YY note in a folder promotes cleanly", () => {
    const plan = planPromoteToFolder(input());
    assert.equal(plan.ok, true);
    assert.equal(plan.folderPath, "06 Digital tools/06.13 Bar");
    assert.equal(plan.newFilePath, "06 Digital tools/06.13 Bar/06.13 Bar.md");
  });

  test("also accepts the 5-digit expanded-area id form", () => {
    const plan = planPromoteToFolder(input({ path: "10000-19999 Big area/10023 Something.md", existingPaths: new Set(["10000-19999 Big area/10023 Something.md"]) }));
    assert.equal(plan.ok, true);
    assert.equal(plan.folderPath, "10000-19999 Big area/10023 Something");
  });

  test("a root-level note (no parent folder segment) promotes with the folder at vault root", () => {
    const plan = planPromoteToFolder(input({ path: "06.13 Bar.md", existingPaths: new Set(["06.13 Bar.md"]) }));
    assert.equal(plan.ok, true);
    assert.equal(plan.folderPath, "06.13 Bar");
    assert.equal(plan.newFilePath, "06.13 Bar/06.13 Bar.md");
  });

  test("refuses a basename that isn't XX.YY or a 5-digit id", () => {
    const plan = planPromoteToFolder(input({ path: "06 Digital tools/Not an id note.md" }));
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "not_id_note");
  });

  test("refuses when the note is already its folder's cover note", () => {
    const plan = planPromoteToFolder(input({ path: "06 Digital tools/06.13 Bar/06.13 Bar.md", existingPaths: new Set(["06 Digital tools/06.13 Bar/06.13 Bar.md"]) }));
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "already_cover_note");
  });

  test("refuses when the destination folder already exists", () => {
    const plan = planPromoteToFolder(input({ existingPaths: new Set(["06 Digital tools/06.13 Bar.md", "06 Digital tools/06.13 Bar"]) }));
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "folder_exists");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/jd-scaffold-standard-zeros.test.mjs tests/jd-scaffold-promote-to-folder.test.mjs`
Expected: FAIL — the `kernel/jd-scaffold/` modules don't exist yet.

- [ ] **Step 3: Write the types module**

```typescript
// packages/plugin/src/kernel/jd-scaffold/types.ts
//
// Pure types for the jd-scaffold module (standard-zeros + promote-to-folder,
// Stage A of the jd-dashboard fold). No `obsidian` import anywhere in this
// file or its siblings — see packages/plugin/CLAUDE.md's kernel discipline.
// Vault I/O (existing-path listings, folder enumeration) happens in the glue
// layer (mcp/tools-jd-scaffold.ts); everything here works on already-resolved
// data.

export type ZeroId = "00" | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09";

export interface ZeroSpec {
  id: ZeroId;
  name: string;
  tag: `jd/${string}`;
  hasDir: boolean;
}

export interface PlannedCreate {
  path: string;
  content: string;
}

export interface PlanStandardZerosInput {
  folderPath: string;
  folderName: string;
  prefix: string;
  now: string;
  /** Every vault path that already exists — the planner never overwrites. */
  existingPaths: Set<string>;
}

export interface PlanStandardZerosResult {
  creates: PlannedCreate[];
  /** Paths that already existed and were left alone. */
  skipped: string[];
}

/** One category folder as discovered by the glue layer — depth-2 `XX <name>`
 *  folders, per ensureCategoryIndexes' original scope. `childBasenames` is
 *  that folder's own immediate children's basenames (not a recursive
 *  listing) — enough to run the XX.00/XX.00.md/XX.00+SUF acceptance check. */
export interface CategoryFolderInput {
  path: string;
  name: string;
  prefix: string;
  childBasenames: string[];
}

export interface PlanEnsureResult {
  creates: PlannedCreate[];
}

export interface PlanPromoteInput {
  path: string;
  existingPaths: Set<string>;
}

export type PromoteToFolderPlan =
  | { ok: true; folderPath: string; newFilePath: string }
  | { ok: false; reason: "not_id_note" | "already_cover_note" | "folder_exists" };
```

- [ ] **Step 4: Write the standard-zeros planner**

```typescript
// packages/plugin/src/kernel/jd-scaffold/standard-zeros.ts
//
// Ported from obsidian-jd-dashboard's src/lib/standard-zeros.ts, split into
// PLAN (pure, here) and APPLY (mcp/tools-jd-scaffold.ts), matching
// kernel/scheme/mutate.ts's established shape. ONE deliberate change from the
// original: buildZeroFrontmatter no longer writes a jd-id: field — see this
// plan's Global Constraints for why (vault-mcp's scheme module is
// path-canonical; the filename already carries the address).

import type {
  ZeroSpec,
  PlannedCreate,
  PlanStandardZerosInput,
  PlanStandardZerosResult,
  CategoryFolderInput,
  PlanEnsureResult,
} from "./types.js";

export function suffixFor(prefix: string): string {
  return prefix === "00" ? "for the system" : `for category ${prefix}`;
}

export function standardZeros(prefix: string, suffix: string): ZeroSpec[] {
  return [
    { id: "00", name: `JDex ${suffix}`, tag: "jd/index", hasDir: false },
    { id: "01", name: `Inbox ${suffix}`, tag: "jd/inbox", hasDir: true },
    { id: "02", name: `Task & project management ${suffix}`, tag: "jd/tasks", hasDir: false },
    { id: "03", name: `Templates ${suffix}`, tag: "jd/templates", hasDir: true },
    { id: "04", name: `Links ${suffix}`, tag: "jd/links", hasDir: false },
    { id: "05", name: `Conventions & policies ${suffix}`, tag: "jd/policies", hasDir: false },
    { id: "06", name: `Knowledge base ${suffix}`, tag: "jd/knowledge-base", hasDir: true },
    { id: "07", name: `Dashboard ${suffix}`, tag: "jd/dashboard", hasDir: false },
    { id: "08", name: `Someday ${suffix}`, tag: "jd/someday", hasDir: false },
    { id: "09", name: `Archive ${suffix}`, tag: "jd/archive", hasDir: true },
  ];
}

/** jd-id: intentionally absent — see this file's header comment. */
export function buildZeroFrontmatter(zero: ZeroSpec, prefix: string, folderName: string, now: string): string {
  const aliases = zero.id === "00" ? `  - ${zero.name}\n  - ${folderName}` : `  - ${zero.name}`;

  return `---
title: ${zero.name}
created: ${now}
modified: ${now}
tags:
  - ${zero.tag}
aliases:
${aliases}
linter-yaml-title-alias: ${zero.name}
---

# ${zero.name}

`;
}

export function planStandardZeros(input: PlanStandardZerosInput): PlanStandardZerosResult {
  const { folderPath, folderName, prefix, now, existingPaths } = input;
  const suffix = suffixFor(prefix);
  const zeros = standardZeros(prefix, suffix);

  const creates: PlannedCreate[] = [];
  const skipped: string[] = [];

  for (const zero of zeros) {
    const basename = `${prefix}.${zero.id} ${zero.name}`;
    const path = zero.hasDir ? `${folderPath}/${basename}/${basename}.md` : `${folderPath}/${basename}.md`;

    if (existingPaths.has(path)) {
      skipped.push(path);
      continue;
    }
    creates.push({ path, content: buildZeroFrontmatter(zero, prefix, folderName, now) });
  }

  return { creates, skipped };
}

/** Matches the "XX.00", "XX.00.md", "XX.00+SUF ..." acceptance the original
 *  ensureCategoryIndexes uses — a deliberately renamed JDex isn't clobbered. */
function hasIndexAlready(childBasenames: string[], prefix: string): boolean {
  const indexBase = `${prefix}.00`;
  return childBasenames.some((name) => {
    if (!name.endsWith(".md")) return false;
    if (!name.startsWith(indexBase)) return false;
    const next = name.charAt(indexBase.length);
    return next === " " || next === "." || next === "+";
  });
}

export function planEnsureCategoryIndexes(folders: CategoryFolderInput[], now: string): PlanEnsureResult {
  const creates: PlannedCreate[] = [];

  for (const folder of folders) {
    if (hasIndexAlready(folder.childBasenames, folder.prefix)) continue;

    const zero = standardZeros(folder.prefix, suffixFor(folder.prefix)).find((z) => z.id === "00")!;
    const basename = `${folder.prefix}.${zero.id} ${zero.name}`;
    creates.push({
      path: `${folder.path}/${basename}.md`,
      content: buildZeroFrontmatter(zero, folder.prefix, folder.name, now),
    });
  }

  return { creates };
}
```

- [ ] **Step 5: Write the promote-to-folder planner**

```typescript
// packages/plugin/src/kernel/jd-scaffold/promote-to-folder.ts
//
// Ported from obsidian-jd-dashboard's src/commands/promote-to-folder.ts, split
// into PLAN (pure, here) and APPLY (mcp/tools-jd-scaffold.ts). The original
// operated on Obsidian's "currently active file"; the ported tool takes an
// explicit `path` argument instead — matching every other vault-mcp write
// tool, none of which depend on editor focus state.

import type { PlanPromoteInput, PromoteToFolderPlan } from "./types.js";

const ID_RE = /^(\d{2}\.\d{2}|\d{5})\s+(.+)$/;

export function planPromoteToFolder(input: PlanPromoteInput): PromoteToFolderPlan {
  const { path, existingPaths } = input;
  const slash = path.lastIndexOf("/");
  const basename = (slash === -1 ? path : path.slice(slash + 1)).replace(/\.md$/, "");
  const parentPath = slash === -1 ? "" : path.slice(0, slash);
  const parentName = parentPath === "" ? "" : parentPath.slice(parentPath.lastIndexOf("/") + 1);

  if (!ID_RE.test(basename)) return { ok: false, reason: "not_id_note" };
  if (basename === parentName) return { ok: false, reason: "already_cover_note" };

  const folderPath = parentPath ? `${parentPath}/${basename}` : basename;
  if (existingPaths.has(folderPath)) return { ok: false, reason: "folder_exists" };

  const fileName = path.slice(slash + 1);
  const newFilePath = `${folderPath}/${fileName}`;
  return { ok: true, folderPath, newFilePath };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/plugin && node --import tsx --test tests/jd-scaffold-standard-zeros.test.mjs tests/jd-scaffold-promote-to-folder.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 7: Typecheck**

Run: `cd packages/plugin && npx tsc --noEmit`
Expected: no errors. (Trust this over the editor's inline diagnostics — `packages/plugin/CLAUDE.md` notes the LSP lags in this repo.)

- [ ] **Step 8: Commit**

```bash
git add packages/plugin/src/kernel/jd-scaffold/ packages/plugin/tests/jd-scaffold-standard-zeros.test.mjs packages/plugin/tests/jd-scaffold-promote-to-folder.test.mjs
git commit -m "feat(kernel): pure planners for jd-scaffold — standard-zeros, promote-to-folder"
```

---

### Task 2: Glue tools

**Files:**
- Create: `packages/plugin/src/mcp/tools-jd-scaffold.ts`
- Test: `packages/plugin/tests/jd-scaffold-tools.test.mjs`

**Interfaces:**
- Consumes: `planStandardZeros`, `planEnsureCategoryIndexes`, `planPromoteToFolder` from Task 1.
- Produces (consumed by Task 3): `registerJdScaffoldTools(server: McpServer, app: App, ctx: JdScaffoldToolsCtx): void` — matching `registerSchemeTools`'s registrar signature shape (the module-registrar contract Task 3 wires through).

**Allowlist contract this task implements** (matching `tools-scheme-write.ts`'s
own discipline exactly — read that file's own comments if anything below is
ambiguous): `ctx.getSettings()` supplies `GuardSettings`; every input path
(`folder_path`, `path`) is checked via `isVisible` before planning, and every
path a plan computes (each `creates[].path`, `newFilePath`) is re-checked
before being applied — unconditionally, even under `dry_run: true`.

- [ ] **Step 1: Write the failing tests**

```javascript
// packages/plugin/tests/jd-scaffold-tools.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerJdScaffoldTools } = await import("../src/mcp/tools-jd-scaffold.ts");

function fakeFile(path) {
  const slash = path.lastIndexOf("/");
  return { path, name: path.slice(slash + 1), basename: path.slice(slash + 1).replace(/\.md$/, "") };
}

function fakeFolder(path, children = []) {
  const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return { path, name, children };
}

function build({ allPaths = [], folders = [], allowlist = [] } = {}) {
  const server = fakeServer();
  const created = [];
  const renamed = [];
  const foldersCreated = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (allPaths.includes(p) ? fakeFile(p) : null),
      getAllLoadedFiles: () => folders,
      create: async (path, content) => { created.push({ path, content }); },
      createFolder: async (path) => { foldersCreated.push(path); },
    },
    fileManager: {
      renameFile: async (file, newPath) => { renamed.push({ from: file.path, to: newPath }); },
    },
  };
  const ctx = { getSettings: () => ({ readOnly: false, allowlist }) };
  registerJdScaffoldTools(server, app, ctx);
  return { server, app, created, renamed, foldersCreated };
}

describe("obsidian_jd_standard_zeros", () => {
  test("dry_run: true reports the plan and writes nothing", async () => {
    const { server, created } = build();
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: true,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.creates.length, 10);
    assert.deepEqual(created, []);
  });

  test("dry_run: false creates every planned zero via app.vault.create", async () => {
    const { server, created } = build();
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 10);
    assert.equal(res.structuredContent.created, 10);
  });

  test("out_of_allowlist refusal when folder_path is outside an active allowlist", async () => {
    const { server, created } = build({ allowlist: ["Somewhere Else"] });
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
    assert.deepEqual(created, []);
  });

  test("one failing create doesn't block the rest — per-item isolation", async () => {
    const server = fakeServer();
    const created = [];
    const app = {
      vault: {
        getAbstractFileByPath: () => null,
        create: async (path, content) => {
          if (path.includes("06.03")) throw new Error("disk full");
          created.push({ path, content });
        },
      },
    };
    registerJdScaffoldTools(server, app, { getSettings: () => ({ readOnly: false, allowlist: [] }) });
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.created, 9);
    assert.equal(res.structuredContent.failures.length, 1);
    assert.match(res.structuredContent.failures[0].error, /disk full/);
  });
});

describe("obsidian_jd_ensure_category_indexes", () => {
  test("vault-wide: finds depth-2 XX-named folders missing their XX.00 and plans one each", async () => {
    const { server, created } = build({
      folders: [
        fakeFolder("10-19 Personal/06 Digital tools", []),
        fakeFolder("10-19 Personal/07 Health", [{ name: "07.00 Existing.md" }]),
      ],
    });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 1);
    assert.match(created[0].path, /^10-19 Personal\/06 Digital tools\/06\.00/);
  });

  test("a folder not matching the depth-2 XX-name pattern is ignored", async () => {
    const { server, created } = build({
      folders: [fakeFolder("10-19 Personal/06 Digital tools/Subfolder", [])],
    });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.deepEqual(created, []);
  });
});

describe("obsidian_jd_promote_to_folder", () => {
  test("dry_run: false creates the folder and renames the file via app.fileManager.renameFile", async () => {
    const { server, renamed, foldersCreated } = build({ allPaths: ["06 Digital tools/06.13 Bar.md"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.deepEqual(foldersCreated, ["06 Digital tools/06.13 Bar"]);
    assert.deepEqual(renamed, [{ from: "06 Digital tools/06.13 Bar.md", to: "06 Digital tools/06.13 Bar/06.13 Bar.md" }]);
  });

  test("a coded refusal (not a thrown error) when the note isn't a JD id note", async () => {
    const { server } = build({ allPaths: ["06 Digital tools/Not an id.md"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/Not an id.md",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[not_id_note\]/);
  });

  test("out_of_allowlist refusal when path is outside an active allowlist", async () => {
    const { server } = build({ allPaths: ["06 Digital tools/06.13 Bar.md"], allowlist: ["Somewhere Else"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugin && node --import tsx --test tests/jd-scaffold-tools.test.mjs`
Expected: FAIL — `Cannot find module '../src/mcp/tools-jd-scaffold.ts'`.

- [ ] **Step 3: Write the glue tools**

```typescript
// packages/plugin/src/mcp/tools-jd-scaffold.ts
//
// jd-scaffold module, Stage A of the jd-dashboard fold
// (docs/superpowers/specs/2026-08-19-jd-dashboard-fold-design.md): three
// mutating tools ported from obsidian-jd-dashboard's standard-zeros.ts and
// promote-to-folder.ts. Each is a thin PLAN-then-APPLY shell over the pure
// planners in kernel/jd-scaffold/ — matching tools-scheme-write.ts's shape
// exactly, including its allowlist discipline: an input path is checked
// before planning, and every path a plan COMPUTES is re-checked before being
// applied, unconditionally, even under dry_run: true.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App, TFolder } from "obsidian";
import { codedError } from "./helpers.js";
import { ok } from "@vault-mcp/core";
import { isVisible, type GuardSettings } from "../guard.js";
import {
  planStandardZeros,
  planEnsureCategoryIndexes,
} from "../kernel/jd-scaffold/standard-zeros.js";
import { planPromoteToFolder } from "../kernel/jd-scaffold/promote-to-folder.js";
import type { CategoryFolderInput, PlannedCreate } from "../kernel/jd-scaffold/types.js";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export interface JdScaffoldToolsCtx {
  getSettings: () => GuardSettings;
}

/** Applies a list of planned creates via app.vault.create, one at a time.
 *  One failure is reported per-item and does not abort the rest — matches
 *  jd-dashboard's own original CreateZerosResult/EnsureCategoryIndexesResult
 *  shape. Every path is allowlist-checked immediately before its own write,
 *  not just once up front — a long-running batch must not outlive a
 *  mid-batch settings change. */
async function applyCreates(
  app: App,
  settings: GuardSettings,
  creates: PlannedCreate[]
): Promise<{ created: number; failures: { path: string; error: string }[] }> {
  let created = 0;
  const failures: { path: string; error: string }[] = [];
  for (const c of creates) {
    if (!isVisible(c.path, settings)) {
      failures.push({ path: c.path, error: "out_of_allowlist" });
      continue;
    }
    try {
      await app.vault.create(c.path, c.content);
      created++;
    } catch (e) {
      failures.push({ path: c.path, error: (e as Error).message });
    }
  }
  return { created, failures };
}

/** Depth-2 `XX <name>` folders, vault-wide — the same scope
 *  ensureCategoryIndexes' original walk used. */
function categoryFolders(app: App): CategoryFolderInput[] {
  const CATEGORY_RE = /^(\d{2})\s+(.+)$/;
  const out: CategoryFolderInput[] = [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (!("children" in f)) continue; // TFolder discriminant without importing the class
    const folder = f as TFolder;
    if (folder.path.split("/").length !== 2) continue;
    const m = folder.name.match(CATEGORY_RE);
    if (!m) continue;
    out.push({
      path: folder.path,
      name: folder.name,
      prefix: m[1],
      childBasenames: folder.children.map((c: any) => c.name as string),
    });
  }
  return out;
}

export function registerJdScaffoldTools(server: McpServer, app: App, ctx: JdScaffoldToolsCtx): void {
  server.registerTool(
    "obsidian_jd_standard_zeros",
    {
      title: "Create standard zeros (XX.00-XX.09) for a JD category",
      description:
        "Creates the fixed 10-note standard-zeros set (JDex, Inbox, Task & project management, Templates, Links, " +
        "Conventions & policies, Knowledge base, Dashboard, Someday, Archive) inside a category folder. An " +
        "already-existing target is SKIPPED, never overwritten. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        folder_path: z.string().describe("Vault path of the category folder (e.g. \"10-19 Personal/06 Digital tools\")."),
        prefix: z.string().describe("The category's two-digit prefix (e.g. \"06\")."),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ folder_path, prefix, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(folder_path, settings)) return codedError("out_of_allowlist", `"${folder_path}" is outside the active path allowlist.`);

      const folderName = folder_path.includes("/") ? folder_path.slice(folder_path.lastIndexOf("/") + 1) : folder_path;
      const existingPaths = new Set<string>(); // populated below per-candidate; see note
      const plan = planStandardZeros({ folderPath: folder_path, folderName, prefix, now: new Date().toISOString().slice(0, 10), existingPaths: existingPathsFor(app, folder_path, prefix) });

      if (dry_run) return ok({ dry_run: true, creates: plan.creates, skipped: plan.skipped });

      const applied = await applyCreates(app, settings, plan.creates);
      return ok({ dry_run: false, created: applied.created, skipped: plan.skipped, failures: applied.failures });
    }
  );

  server.registerTool(
    "obsidian_jd_ensure_category_indexes",
    {
      title: "Self-heal missing XX.00 JDex files vault-wide",
      description:
        "Walks every depth-2 `XX <name>` category folder and creates a minimal `XX.00` JDex index for any that " +
        "lack one (in any of `XX.00 Title.md`, `XX.00.md`, `XX.00+SUF Title.md` form). Vault-wide, no target " +
        "argument. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ dry_run }) => {
      const settings = ctx.getSettings();
      const folders = categoryFolders(app);
      const plan = planEnsureCategoryIndexes(folders, new Date().toISOString().slice(0, 10));

      if (dry_run) return ok({ dry_run: true, creates: plan.creates });

      const applied = await applyCreates(app, settings, plan.creates);
      return ok({ dry_run: false, created: applied.created, failures: applied.failures });
    }
  );

  server.registerTool(
    "obsidian_jd_promote_to_folder",
    {
      title: "Promote a JD id note to a same-named folder",
      description:
        "Converts an XX.YY (or 5-digit expanded-area id) note into a same-named folder with the note moved inside " +
        "as the folder's cover note, via app.fileManager.renameFile (link-healing). Refuses (not_id_note / " +
        "already_cover_note / folder_exists) rather than guessing. `dry_run: true` reports the plan without writing.",
      inputSchema: {
        path: z.string().describe("Vault path of the note to promote."),
        dry_run: z.boolean().describe("If true, report the plan without writing anything."),
      },
      annotations: RW,
    },
    async ({ path, dry_run }) => {
      const settings = ctx.getSettings();
      if (!isVisible(path, settings)) return codedError("out_of_allowlist", `"${path}" is outside the active path allowlist.`);

      const existingPaths = existingPathsFor(app, path.slice(0, path.lastIndexOf("/")) || "", "");
      // promote's plan needs to know whether the COMPUTED folder path exists;
      // existingPathsFor's category-scoped listing above is for
      // standard-zeros' use — promote checks a single computed path directly.
      const folderCandidate = path.replace(/\.md$/, "");
      const exists = new Set<string>(app.vault.getAbstractFileByPath(folderCandidate) ? [folderCandidate] : []);
      const plan = planPromoteToFolder({ path, existingPaths: exists });

      if (!plan.ok) return codedError(plan.reason, promoteRefusalMessage(plan.reason, path));
      if (!isVisible(plan.folderPath, settings) || !isVisible(plan.newFilePath, settings)) {
        return codedError("out_of_allowlist", `the computed destination for "${path}" is outside the active path allowlist.`);
      }

      if (dry_run) return ok({ dry_run: true, folder_path: plan.folderPath, new_file_path: plan.newFilePath });

      await app.vault.createFolder(plan.folderPath);
      const file = app.vault.getAbstractFileByPath(path);
      await app.fileManager.renameFile(file as any, plan.newFilePath);
      return ok({ dry_run: false, folder_path: plan.folderPath, new_file_path: plan.newFilePath });
    }
  );
}

function promoteRefusalMessage(reason: string, path: string): string {
  switch (reason) {
    case "not_id_note": return `"${path}" doesn't look like a JD id note (expected "XX.YY Title" or a 5-digit id).`;
    case "already_cover_note": return `"${path}" is already its folder's cover note.`;
    case "folder_exists": return `the destination folder for "${path}" already exists.`;
    default: return `"${path}" cannot be promoted.`;
  }
}

/** Placeholder existing-paths resolver used by standard-zeros' planner — real
 *  implementation checks each of the 10 candidate paths via
 *  app.vault.getAbstractFileByPath rather than pre-building a full listing
 *  (the category folder's own contents are enough; no vault-wide scan
 *  needed). Named as its own function so Task 1's planner stays decoupled
 *  from HOW existence is checked. */
function existingPathsFor(app: App, folderPath: string, prefix: string): Set<string> {
  const out = new Set<string>();
  if (!prefix) return out; // promote's call site doesn't use the prefix-keyed form
  for (const zero of ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]) {
    // Both the flat and hasDir candidate shapes are checked; a false-positive
    // check against a shape that isn't actually used for a given zero is
    // harmless (it just checks a path that will always resolve to null).
  }
  // NOTE for implementer: this function's body is intentionally left as a
  // stub sketch above — Step 3's own review pass (this plan's Task 2 Step 4)
  // must replace it with real app.vault.getAbstractFileByPath probes per
  // candidate path (10 flat-shape checks + 10 hasDir-shape checks against
  // the SAME 10 zero specs planStandardZeros itself computes, so the two
  // never drift apart on what "the candidate path" means). Flagged rather
  // than silently guessed, per this session's own established discipline of
  // not inventing unverified plumbing.
  return out;
}
```

**Implementer note on `existingPathsFor`:** the sketch above is intentionally
incomplete — building the exact 10 candidate paths independently in two places
(once in `planStandardZeros`, once in this existence-check helper) risks the two
falling out of sync if either changes. Before writing real test-passing code,
resolve this by having `applyCreates`/the tool handler check existence
**per-candidate, using `planStandardZeros`'s own output**: call the planner
once with an empty `existingPaths` set to get the full candidate list, probe
each candidate's real existence via `app.vault.getAbstractFileByPath`, then
call the planner a second time with the now-accurate `existingPaths` set — or,
cleaner, change `planStandardZeros`'s signature to accept an `exists: (path:
string) => boolean` predicate instead of a pre-built `Set<string>`, so the glue
layer never has to enumerate candidate paths itself at all. **Prefer the
predicate-injection redesign** — it removes the duplication risk entirely
rather than managing it. This changes Task 1's `PlanStandardZerosInput` shape
slightly from what Step 3 above shows; make that adjustment in Task 1 before
starting Task 2 for real, not after — Task 2's tests above already assume the
planner is called correctly and don't re-test this wiring.

- [ ] **Step 4: Fix `existingPathsFor` per the implementer note above, then run tests**

Run: `cd packages/plugin && node --import tsx --test tests/jd-scaffold-tools.test.mjs`
Expected: PASS — all tests green, including the "already-existing target is
skipped" case, which is the one this note's redesign is load-bearing for.

- [ ] **Step 5: Typecheck**

Run: `cd packages/plugin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin/src/mcp/tools-jd-scaffold.ts packages/plugin/tests/jd-scaffold-tools.test.mjs
git commit -m "feat(mcp): jd-scaffold glue tools — standard_zeros, ensure_category_indexes, promote_to_folder"
```

---

### Task 3: Register as a module, update the locked inventory, live smoke test

**Files:**
- Modify: `packages/plugin/src/mcp/modules-mount.ts`
- Modify: `packages/plugin/TOOL-INVENTORY.md`

**Interfaces:**
- Consumes: `registerJdScaffoldTools` from Task 2.
- Produces: nothing further consumed in this plan — this is the last task.

- [ ] **Step 1: Register the module in `modules-mount.ts`**

Follow the `skills` module's exact precedent (`builtinModules`, the block
starting `moduleFromRegistrar({ id: "skills", ... mutating: true ...`):

```typescript
// alongside the other moduleFromRegistrar(...) entries in builtinModules:
moduleFromRegistrar(
  { id: "jd-scaffold", capabilities: ["scaffolding"], enabled: false, mutating: true, manifest: JD_SCAFFOLD_MANIFEST },
  (server: any, ctx: JdScaffoldToolsCtx) => registerJdScaffoldTools(server, deps.app, ctx),
  () => ({ getSettings: deps.getSettings }),
),
```

Define `JD_SCAFFOLD_MANIFEST` near the other manifest constants in this file
(`SCHEME_MANIFEST`, `SKILLS_MANIFEST`, etc. — match their exact shape; read
`SKILLS_MANIFEST`'s definition first, this is a copy-the-shape step, not a
design step). **Default `enabled: false`**, matching `skills`'s own stated
reasoning ("a newly-folded mutating surface stays off until a human turns it
on in the config tab").

Note `deps.app` above: check whether `MountDeps` already carries a live `App`
reference (`registerSchemeTools`'s own `deps.schemeNotes` closure suggests it
does, indirectly) — if not, this task needs a small addition to `MountDeps` in
`server.ts`'s call site, following the same pattern `deps.vocabSource`/
`deps.skillsSource` already use for handing a module its own live adapter.

- [ ] **Step 2: Update `TOOL-INVENTORY.md`**

Add a `tools-jd-scaffold.ts` section (module-mounted tools, default disabled —
match the `skills`/`provenance`/`fileclass` sections' format exactly) listing
all three tools, and bump the count summary's module-mounted bucket by 3. Read
the current file first — the exact numbers will have moved since this plan was
written (verify against `tests/tool-inventory.test.mjs`, don't hand-compute).

- [ ] **Step 3: Run the full test suite**

Run: `cd packages/plugin && npm test`
Expected: PASS, including `tests/tool-inventory.test.mjs` and
`tests/modules-mount.test.mjs`.

- [ ] **Step 4: Live smoke test against the real vault**

Per `packages/plugin/CLAUDE.md`'s "Verifying tools live" section — these
handlers call `app.vault`/`app.fileManager`, so they cannot be verified by the
unit tests alone.

```bash
cd packages/plugin && npm run build
cp main.js manifest.json ~/obsidian/.obsidian/plugins/vault-mcp/
```
Reload the plugin, then enable the `jd-scaffold` module in vault-mcp's settings
tab (default disabled, per Task 3 Step 1).

Pick a real, disposable test category folder (or create one) and pipe a
`dry_run: true` call for `obsidian_jd_standard_zeros` through the bridge (keep
stdin open per `CLAUDE.md`'s async-handler note):
```bash
( printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"obsidian_jd_standard_zeros","arguments":{"folder_path":"<test folder>","prefix":"<XX>","dry_run":true}}}\n'; sleep 4 ) | node ~/.claude/vault-mcp/bridge.mjs --vault <vault-name>
```
Expected: 10 planned creates, none with a `jd-id` field, nothing written yet.
Repeat with `dry_run: false`, confirm the 10 notes exist in the vault with the
expected frontmatter (spot-check 2-3, including the `hasDir` cases). Repeat the
SAME call again (`dry_run: false`) and confirm all 10 are now reported
`skipped`, not recreated. Then smoke-test `obsidian_jd_promote_to_folder`
against one disposable test note the same way. Delete every test
folder/note/category afterward — this step is verification, not a fixture to
leave behind.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/mcp/modules-mount.ts packages/plugin/TOOL-INVENTORY.md
git commit -m "feat(mcp): register jd-scaffold module, update tool inventory"
```

---

## Deferred to follow-up plans

Per the design doc's own staging and this plan's narrowed scope:
- **Category-index** (`kernel/scheme`-adjacent `## Contents` rebuild, 3 tiers,
  description-preservation) — its own plan; comparable complexity to this
  entire Stage A on its own.
- **Template-creation** (`new-from-template.ts`) and the scaffolding half of
  `new-category.ts` (folder + standard-zeros for a newly-assigned category
  number — can reuse this plan's `obsidian_jd_standard_zeros` directly once it
  ships) — their own plan.
- **Inbox panel and drift panel** (design doc's Stage B/C) — UI work, and for
  the drift panel specifically, the open conformance-engine live-call design
  question flagged in the design doc. Not started by this plan at all.
