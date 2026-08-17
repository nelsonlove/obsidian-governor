# Scheme Mutations (assign / refile / renumber) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three agent-callable, report-first mutating MCP tools — `obsidian_assign_address`, `obsidian_refile_address`, `obsidian_renumber_address` — completing the write half of the ScopeProvider kernel service that v1 deliberately deferred.

**Architecture:** Two new pure kernel additions (a new `ScopeProvider.occupantOf`/`titleOf` pair on `provider.ts` + `jd.ts`, and a new `kernel/scheme/mutate.ts` planning module — both Obsidian-free, unit-tested headlessly) compose with the existing `moveNote`/`moveOne` move primitive at a new tool-handler layer, `mcp/tools-scheme-write.ts`, registered directly in `server.ts` exactly like `registerVaultWriteTools` — **not** through the module-host (`modules-mount.ts`), whose mount gate refuses any non-`readOnlyHint:true` tool by construction (verified in source; see Task 4 note).

**Tech Stack:** TypeScript (strict), esbuild, `node:test` via `npm test` (`tsc --noEmit && node --import tsx --test 'tests/*.test.mjs'`), zod for tool schemas, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-08-17-scheme-mutations-design.md`

## Global Constraints

- All work happens in this worktree, branch `worktree-jd-mutations-fold`.
- Kernel modules (`kernel/scheme/*.ts`) import NOTHING from `obsidian`, not even types.
- Every new tool is mutating: `annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }` (the `RW` constant already defined in `tools-vault-write.ts` — reuse it, don't redefine).
- Every tool requires an explicit `dry_run` boolean (no default-to-write); `dry_run: true` never touches the vault.
- Registered DIRECTLY in `server.ts` (`registerSchemeWriteTools(server, app, ctx)`, called beside `registerVaultWriteTools`), never through `modules-mount.ts` — that module host's `registerAll` gate refuses any tool whose `annotations.readOnlyHint !== true` (`modules-mount.ts` header comment, point 1; pinned by its own test suite). Do not attempt to add these to the existing scheme module's manifest.
- Reuse the existing move primitive (`moveOne` in `tools-vault-write.ts`) rather than reimplementing `renameFile`/folder-creation/overwrite logic — export it from that file instead of duplicating it (DRY).
- Result helpers: `ok()` / `fail()` / `okError()` / `codedError()` from `./helpers.js` (mcp dir) — same as every other tool file.
- Conventional commits, one per task minimum. `npm test` green before every commit.
- No note mutation logic lives in `kernel/scheme/mutate.ts` — it only PLANS (`{steps: MoveStep[]}` or an error), never calls `app.*`. The tool handler is the only place a plan becomes a real move.
- Uid stability: none of these tools may touch frontmatter. `moveNote`/`renameFile` already don't — Task 5 pins this with a real test rather than trusting it by construction.

---

### Task 1: `occupantOf` + `titleOf` on ScopeProvider

**Files:**
- Modify: `packages/plugin/src/kernel/scheme/provider.ts`
- Modify: `packages/plugin/src/kernel/scheme/jd.ts`
- Test: `packages/plugin/tests/scheme-jd-mutations.test.mjs` (new file)

**Interfaces:**
- Consumes: `ScopeProvider`, `Address`, `Member`, `jdProvider`, `DEFAULT_JD_CONFIG` (all existing, `provider.ts`/`jd.ts`).
- Produces (later tasks rely on these exact names):

```ts
// provider.ts — two new methods on ScopeProvider
occupantOf(addr: Address, notes: string[]): Member | null;
titleOf(path: string): string;
```

`occupantOf`: the note (if any) among `notes` whose own address equals `addr` (compared via `format`) — the "what's *there*" counterpart to `nextFree`'s "what's *free*". First match wins on the pathological case of two notes claiming the same address (that's a `duplicate_address` finding, not this method's job to flag). Null when nothing claims it.

`titleOf`: the note's own title with any leading address token stripped, `.md` removed — the inverse of `addressOf` (which extracts the token; this extracts what's left). A note with no address at all ⇒ its whole basename minus `.md` (nothing to strip). Used by `mutate.ts` to build a new filename: `` `${provider.format(newAddr)} ${provider.titleOf(path)}.md` ``.

- [ ] **Step 1: Write failing tests** in `tests/scheme-jd-mutations.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";

const NOTES = [
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "Unfiled/loose note.md",
];
const p = jdProvider(DEFAULT_JD_CONFIG);

test("occupantOf finds the claimant", () => {
  const addr = p.parse("06.11");
  const occ = p.occupantOf(addr, NOTES);
  assert.deepEqual(occ, { path: NOTES[0], address: "06.11" });
});

test("occupantOf returns null when nothing claims the address", () => {
  const addr = p.parse("06.13");
  assert.equal(p.occupantOf(addr, NOTES), null);
});

test("occupantOf: first match wins on a duplicate", () => {
  const dup = [...NOTES, "Somewhere else/06.11 Duplicate.md"];
  const addr = p.parse("06.11");
  assert.equal(p.occupantOf(addr, dup)?.path, NOTES[0]);
});

test("titleOf strips a leading address token", () => {
  assert.equal(p.titleOf("00-09 System/06 Agent tooling/06.11 Vault MCP.md"), "Vault MCP");
});

test("titleOf on a note with no address returns the whole basename", () => {
  assert.equal(p.titleOf("Unfiled/loose note.md"), "loose note");
});

test("titleOf on a malformed-but-numeric-looking token still strips only a real address", () => {
  // "06.1" is not a valid two-or-three-digit decimal — not an address, so
  // nothing is stripped.
  assert.equal(p.titleOf("Somewhere/06.1 Not Quite An Id.md"), "06.1 Not Quite An Id");
});
```

- [ ] **Step 2: Run, verify FAIL** — `node --import tsx --test tests/scheme-jd-mutations.test.mjs`. Expected: `occupantOf`/`titleOf` are not functions (the interface doesn't have them yet, so `jdProvider`'s returned object won't either).
- [ ] **Step 3: Add both methods to the `ScopeProvider` interface** in `provider.ts`, with doc comments matching the style of the existing methods (see `expectedFolder`'s doc comment for the level of detail expected — this interface is the contract other future providers must fill in too).
- [ ] **Step 4: Implement both in `jd.ts`**, inside the `jdProvider(cfg)` factory's returned object, using the SAME internal helpers the rest of the factory already uses (`parsedFromPath`, `toAddress`, `format`, `basename`, `idTokenFromName`, `parseJdId` — all already defined earlier in the file; do not reimplement any of them):

```ts
occupantOf(addr: Address, notes: string[]): Member | null {
  const target = format(addr);
  for (const path of notes) {
    const p = parsedFromPath(path, cfg);
    if (p && format(toAddress(p)) === target) return { path, address: target };
  }
  return null;
},

titleOf(path: string): string {
  const name = basename(path).replace(/\.md$/, "");
  const token = idTokenFromName(basename(path));
  if (token && parseJdId(token, cfg)) {
    return name.slice(token.length).trimStart();
  }
  return name;
},
```

  Add both to the object literal returned by `jdProvider` (alongside `scopeOf`/`chainOf`/`membersOf`/etc. — see the existing `return { capabilities, parse, format, ... }` block).
- [ ] **Step 5: Run tests, verify PASS** — `npm test` (full suite — confirms nothing else broke from the interface change; every future `ScopeProvider` implementer will need to add these two, but `jd.ts` is the only one that exists today).
- [ ] **Step 6: Commit** — `feat(scheme): occupantOf + titleOf on ScopeProvider (the "what's there" and "strip the address" primitives mutations need)`

---

### Task 2: `kernel/scheme/mutate.ts` — pure planning logic

**Files:**
- Create: `packages/plugin/src/kernel/scheme/mutate.ts`
- Test: `packages/plugin/tests/scheme-mutate.test.mjs`

**Interfaces:**
- Consumes: `ScopeProvider`, `Address`, `Scope` (Task 1's provider + existing types).
- Produces (Task 4 relies on these exact names):

```ts
export interface MoveStep { from: string; to: string; }

export interface AssignResult { address: string; step: MoveStep; }
export type AssignOutcome = { ok: true; result: AssignResult } | { ok: false; error: string };
export function planAssign(provider: ScopeProvider, scope: Scope, notePath: string, notes: string[]): AssignOutcome;

export interface RefileResult { address: string; step: MoveStep | null; alreadyCorrect: boolean; }
export type RefileOutcome = { ok: true; result: RefileResult } | { ok: false; error: string };
export function planRefile(provider: ScopeProvider, notePath: string, notes: string[]): RefileOutcome;

export type OnOccupied = "auto" | "manual" | "fail";
export interface RenumberResult { steps: MoveStep[]; displaced: string | null; }
export type RenumberOutcome = { ok: true; result: RenumberResult } | { ok: false; error: string };
export function planRenumber(
  provider: ScopeProvider,
  notePath: string,
  to: Address,
  notes: string[],
  onOccupied: OnOccupied,
  displaceTo?: Address
): RenumberOutcome;
```

Every function returns a discriminated `{ok: true, result}` / `{ok: false, error}` — never throws — so the tool handler (Task 4) turns `ok:false` into `fail()`/`codedError()` without a try/catch around planning logic itself (only the actual move calls need one, since those are the only part that touches the filesystem).

**`planAssign`** — `provider.nextFree(scope, notes)`; null ⇒ `{ok:false, error:"scope exhausted or not allocatable"}` (check `provider.allocatable(scope).allocatable` first to distinguish the two in the message, mirroring `tools-scheme.ts`'s `computeFree` pattern — you don't need `computeFree` itself, just the same allocatable-vs-exhausted distinction it draws). Otherwise: destination = `` `${provider.expectedFolder(addr, notes)}/${provider.format(addr)} ${provider.titleOf(notePath)}.md` ``; `expectedFolder` returning null ⇒ `{ok:false, error:"cannot determine the expected folder for the newly-assigned address"}`.

**`planRefile`** — `provider.addressOf(notePath)`; null ⇒ `{ok:false, error:"note has no address to refile against"}`. Otherwise compute `expectedFolder`/expected filename the same way as `planAssign`; if the note's OWN current folder (derive via a plain `path.slice(0, path.lastIndexOf("/"))`-equivalent — do NOT import Node's `path` module, this is a pure string op, same as `tools-scheme.ts`'s existing `folderOf` helper does it, which you should mirror inline here since `mutate.ts` doesn't import from `tools-scheme.ts`) already equals the expected folder AND the basename already matches ⇒ `{ok:true, result:{address, step:null, alreadyCorrect:true}}`. Otherwise a single `MoveStep`.

**`planRenumber`** — parse-independent (caller already resolved `to: Address`). `provider.occupantOf(to, notes)`:
- No occupant ⇒ single step `{from: notePath, to: <expectedFolder(to)>/<format(to)> <titleOf(notePath)>.md}`, `displaced: null`.
- Occupant exists, `onOccupied === "fail"` ⇒ `{ok:false, error:"<to> is occupied by <occupant.path> — pass on_occupied to auto-displace or specify displace_to"}`.
- Occupant exists, `onOccupied === "manual"`:
  - `displaceTo` missing ⇒ `{ok:false, error:"on_occupied is 'manual' but displace_to was not given"}`.
  - `provider.occupantOf(displaceTo, notes)` non-null (and not the occupant itself — a no-op displacement) ⇒ `{ok:false, error:"displace_to <address> is also occupied"}`.
  - Otherwise two steps, occupant-first: `[{from: occupant.path, to: <expectedFolder(displaceTo)>/...}, {from: notePath, to: <expectedFolder(to)>/...}]`.
- Occupant exists, `onOccupied === "auto"`:
  - Compute `provider.nextFree(occupant's own scope, notes)`. Occupant's scope: reuse the occupant's OWN category — `provider.scopeOf(occupant.path)` (already exists, Task 1 doesn't touch it). Null ⇒ `{ok:false, error:"could not find a free slot to auto-displace the occupant to"}`.
  - Otherwise same two-step shape as manual, using the computed displacement address.

Order matters and is always **occupant-first, source-second** — moving the occupant out of the way before the source moves in, so an intermediate filesystem state never has two notes at the same address (the same ordering `renumberCommand` used interactively, now made unconditional rather than relying on the UI's confirm-prompt sequencing).

- [ ] **Step 1: Write failing tests** in `tests/scheme-mutate.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";
import { planAssign, planRefile, planRenumber } from "../src/kernel/scheme/mutate.js";

const p = jdProvider(DEFAULT_JD_CONFIG);
const NOTES = [
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
];

test("planAssign computes the next free id and a move into the category folder", () => {
  const scope = { kind: "category", token: "06" };
  const out = planAssign(p, scope, "Unfiled/New thing.md", NOTES);
  assert.equal(out.ok, true);
  assert.equal(out.result.address, "06.13");
  assert.deepEqual(out.result.step, {
    from: "Unfiled/New thing.md",
    to: "00-09 System/06 Agent tooling/06.13 New thing.md",
  });
});

test("planAssign reports exhaustion distinctly from never-allocatable", () => {
  const full = Array.from({ length: 90 }, (_, i) => `X/06.${10 + i} Filler.md`).concat(NOTES);
  const out = planAssign(p, { kind: "category", token: "06" }, "Unfiled/New.md", full);
  assert.equal(out.ok, false);
  assert.match(out.error, /exhaust/i);
});

test("planRefile is a no-op when already correctly filed", () => {
  const out = planRefile(p, NOTES[0], NOTES);
  assert.equal(out.ok, true);
  assert.equal(out.result.alreadyCorrect, true);
  assert.equal(out.result.step, null);
});

test("planRefile moves a misfiled note to its expected folder", () => {
  const misfiled = [...NOTES, "Wrong Place/06.13 Misfiled.md"];
  const out = planRefile(p, "Wrong Place/06.13 Misfiled.md", misfiled);
  assert.equal(out.ok, true);
  assert.equal(out.result.alreadyCorrect, false);
  assert.deepEqual(out.result.step, {
    from: "Wrong Place/06.13 Misfiled.md",
    to: "00-09 System/06 Agent tooling/06.13 Misfiled.md",
  });
});

test("planRefile refuses a note with no address", () => {
  const out = planRefile(p, "Unfiled/loose.md", [...NOTES, "Unfiled/loose.md"]);
  assert.equal(out.ok, false);
  assert.match(out.error, /no address/i);
});

test("planRenumber: target free, single step", () => {
  const to = p.parse("06.13");
  const out = planRenumber(p, NOTES[0], to, NOTES, "fail");
  assert.equal(out.ok, true);
  assert.equal(out.result.steps.length, 1);
  assert.equal(out.result.displaced, null);
  assert.deepEqual(out.result.steps[0], {
    from: NOTES[0],
    to: "00-09 System/06 Agent tooling/06.13 Vault MCP.md",
  });
});

test("planRenumber: target occupied, onOccupied 'fail' refuses", () => {
  const to = p.parse("06.12");
  const out = planRenumber(p, NOTES[0], to, NOTES, "fail");
  assert.equal(out.ok, false);
  assert.match(out.error, /occupied/i);
});

test("planRenumber: target occupied, 'auto' displaces occupant first then moves source", () => {
  const to = p.parse("06.12");
  const out = planRenumber(p, NOTES[0], to, NOTES, "auto");
  assert.equal(out.ok, true);
  assert.equal(out.result.steps.length, 2);
  assert.equal(out.result.steps[0].from, NOTES[1]); // occupant moves first
  assert.equal(out.result.steps[1].from, NOTES[0]); // source moves second, into the now-vacant slot
  assert.equal(out.result.displaced, out.result.steps[0].to);
});

test("planRenumber: target occupied, 'manual' without displace_to refuses", () => {
  const to = p.parse("06.12");
  const out = planRenumber(p, NOTES[0], to, NOTES, "manual");
  assert.equal(out.ok, false);
  assert.match(out.error, /displace_to/);
});

test("planRenumber: target occupied, 'manual' with a taken displace_to refuses", () => {
  const to = p.parse("06.12");
  const displaceTo = p.parse("06.11"); // NOTES[0] itself — occupied
  const out = planRenumber(p, NOTES[0], to, NOTES, "manual", displaceTo);
  assert.equal(out.ok, false);
  assert.match(out.error, /also occupied/);
});
```

- [ ] **Step 2: Run, verify FAIL** — module doesn't exist yet.
- [ ] **Step 3: Implement `mutate.ts`** per the behavior spelled out above. Import ONLY `ScopeProvider`, `Address`, `Scope` types from `./provider.js` — nothing from `obsidian`, nothing from `./jd.js` (must stay scheme-agnostic — every operation goes through the `provider` parameter, never assumes JD).
- [ ] **Step 4: Run tests, verify PASS** — `npm test`.
- [ ] **Step 5: Commit** — `feat(scheme): mutate.ts — pure assign/refile/renumber planning`

---

### Task 3: Export `moveOne` from tools-vault-write.ts

**Files:**
- Modify: `packages/plugin/src/mcp/tools-vault-write.ts` (one-line change)
- Test: none new — existing `tests/tool-inventory.test.mjs`/vault-write tests must still pass unchanged, proving this is a pure export addition with no behavior change.

**Interfaces:**
- Produces: `export async function moveOne(app: App, from: string, to: string, overwrite: boolean): Promise<void>` (same signature, now exported for Task 4 to import).

- [ ] **Step 1: Change `async function moveOne(` to `export async function moveOne(`** in `tools-vault-write.ts`. Nothing else in the file changes.
- [ ] **Step 2: Run `npm test`, verify still PASS** — no test should reference `moveOne` directly yet (that's Task 4); this step just proves the export didn't break the module's existing behavior or types.
- [ ] **Step 3: Commit** — `refactor(vault-write): export moveOne for reuse by the scheme-mutations tools`

---

### Task 4: `tools-scheme-write.ts` — the three mutating tools

**Files:**
- Create: `packages/plugin/src/mcp/tools-scheme-write.ts`
- Modify: `packages/plugin/src/mcp/server.ts` (import + register)
- Test: `packages/plugin/tests/scheme-write-tools.test.mjs`; Modify: `packages/plugin/tests/tool-inventory.test.mjs`

**Interfaces:**
- Consumes: `planAssign`/`planRefile`/`planRenumber`/`MoveStep` (Task 2), `moveOne` (Task 3), `pickInstance`/`parseScopeToken` (export both from `tools-scheme.ts` — currently unexported module-private functions; adding `export` to their declarations is the only change needed there, same pattern as Task 3), `ok`/`fail`/`codedError` (`./helpers.js`), `visiblePaths`/`GuardSettings` (`../guard.js`), `SchemeRegistry`/`SchemeInstanceConfig` (`../kernel/scheme/registry.js`).
- Produces:

```ts
export interface SchemeWriteToolsCtx {
  registry: () => SchemeRegistry;
  notes: () => string[];
  getSettings?: () => GuardSettings;
}
export function registerSchemeWriteTools(server: McpServer, app: App, ctx: SchemeWriteToolsCtx): void;
```

Registration in `server.ts`: call `registerSchemeWriteTools(server, app, { registry: () => makeRegistry(ctx.getSettings().schemes ?? DEFAULT_SCHEMES), notes: () => app.vault.getMarkdownFiles().map(f => f.path), getSettings: () => ctx.getSettings() })` immediately after the existing `registerVaultWriteTools(server, app, ctx)` call — same `registry()`/`notes()` construction the guarded scheme-addressing wiring already uses a few lines above (`guardedOpts.schemes`/`.schemeNotes`), so don't invent a third copy of that expression; import `makeRegistry`/`DEFAULT_SCHEMES` if not already imported in `server.ts` (they already are, for `guardedOpts`).

**Why NOT the module host:** `modules-mount.ts`'s own header comment (point 1) states its `registerAll` gate refuses any module tool whose `annotations.readOnlyHint !== true`, pinned by that file's own test suite. These three tools are mutating by design (`readOnlyHint: false`) — they cannot go through that gate, so they register directly in `server.ts`, exactly like `obsidian_move_notes`/`obsidian_repoint_link` in `registerVaultWriteTools` already do. This is not a workaround; it's the same shape the existing write tools already use.

**Allowlist:** every tool filters `ctx.notes()` through `visiblePaths(notes, ctx.getSettings?.())` before it ever reaches `pickInstance`/`planAssign`/etc. — same discipline as `tools-scheme.ts`'s read tools (a hidden note must be as invisible to "what's free"/"what's there" on the write side as it already is on the read side). The note being OPERATED ON (`path` argument) is checked individually the same way `tools-uid.ts`'s reverse lookup does (per that file's existing precedent, referenced in `tools-scheme.ts`'s own header comment) — reject with `codedError("out_of_allowlist", ...)` if the target path itself isn't visible, before any planning runs.

**The three tools, exact args/behavior:**

1. **`obsidian_assign_address`** — `{ path: string, scope: string, scheme?: string, dry_run: boolean }`.
   - Resolve `scheme`/pick instance via `pickInstance(ctx.registry(), scheme_arg)` (imported from `tools-scheme.ts`); `{error}` ⇒ `fail()`, `{unavailable}` ⇒ `codedError("scheme_unavailable", ...)`.
   - Parse `scope` via `parseScopeToken(instance, scope)` (imported); null ⇒ `codedError("invalid_scope", ...)`.
   - `path` not in visible notes ⇒ `codedError("out_of_allowlist", ...)`.
   - `planAssign(instance.provider, parsedScope, path, visibleNotes)`; `ok:false` ⇒ `fail(new Error(result.error))`.
   - `dry_run: true` ⇒ `ok({ dry_run: true, address: result.address, moves: [result.step] })`.
   - `dry_run: false` ⇒ `await moveOne(app, result.step.from, result.step.to, false)` (never overwrite — the whole point of `planAssign` picking a FREE address is that nothing should be there); on success `ok({ dry_run: false, address: result.address, moves: [result.step] })`; a thrown error from `moveOne` (e.g. a race where something now occupies the computed path) ⇒ `fail(e)`.

2. **`obsidian_refile_address`** — `{ path: string, dry_run: boolean }`. No `scope`/`scheme` argument — the note's OWN address (via `instance.provider.addressOf`, needing the instance the note's address belongs to: loop `ctx.registry().instances()`, use the first whose `addressOf(path)` is non-null, matching how a note can only sensibly belong to one configured scheme in v1's single-default-instance reality; multi-instance ambiguity here is out of scope, same YAGNI boundary the spec drew).
   - `path` not visible ⇒ `codedError("out_of_allowlist", ...)`.
   - No instance's `addressOf(path)` is non-null ⇒ `fail(new Error("note has no address in any configured scheme"))`.
   - `planRefile(instance.provider, path, visibleNotes)`; `ok:false` ⇒ `fail(...)`.
   - `result.alreadyCorrect` ⇒ `ok({ dry_run, address: result.address, moves: [], already_correct: true })` regardless of `dry_run` (nothing to preview or do).
   - Otherwise same dry_run/apply split as `obsidian_assign_address`, `moves: [result.step]`.

3. **`obsidian_renumber_address`** — `{ path: string, to: string, scheme?: string, dry_run: boolean, on_occupied: "auto" | "manual" | "fail", displace_to?: string }`, `on_occupied` default `"fail"`.
   - Resolve instance via `pickInstance` (same as tool 1) — `to`/`displace_to` are parsed through THAT instance's `provider.parse`, not a bare-address guess, since renumber always operates within one named or singly-configured scheme's grammar.
   - `to` fails to parse ⇒ `fail(new Error(...))`; `on_occupied === "manual"` and `displace_to` given but fails to parse ⇒ same.
   - `path` not visible ⇒ `codedError("out_of_allowlist", ...)`.
   - `planRenumber(instance.provider, path, parsedTo, visibleNotes, on_occupied, parsedDisplaceTo)`; `ok:false` ⇒ `fail(...)`.
   - `dry_run: true` ⇒ `ok({ dry_run: true, moves: result.steps, displaced: result.displaced })`.
   - `dry_run: false` ⇒ run `result.steps` **in order** (occupant-first, already guaranteed by `planRenumber`) via `moveOne(app, step.from, step.to, false)`, awaited sequentially, not `Promise.all` — a partial failure after the first step must not race the second. If step 2 throws after step 1 succeeded, return `fail(new Error(...))` whose message says step 1 already landed and names both paths (mirror `renumberCommand`'s own "vault is in inconsistent state" wording — same failure shape, now returned as text instead of a `Notice`). On full success: `ok({ dry_run: false, moves: result.steps, displaced: result.displaced })`.

- [ ] **Step 1: Write failing tests** in `tests/scheme-write-tools.test.mjs`. Follow `tests/scheme-tools.test.mjs`'s fake-server harness pattern exactly (same imports, same fake app/server shape — read that file first to copy its setup verbatim rather than inventing a new harness). Per tool: a dry-run case (asserts `moves` computed, nothing "applied" — the fake app records no rename calls), an apply case (asserts the fake app's rename call log has the expected from/to), the `out_of_allowlist` case, and — for renumber specifically — one `auto`-displacement apply case asserting BOTH moves happened in occupant-first order (check the fake app's call log ordering, not just its final contents).
- [ ] **Step 2: Update `tests/tool-inventory.test.mjs`** — the three new tool names present, `readOnlyHint: false` for all three (the inventory test presumably already asserts read/write annotations per tool the same way it does for existing tools — follow its existing pattern for `obsidian_repoint_link`/`obsidian_move_notes`).
- [ ] **Step 3: Run, verify FAIL.**
- [ ] **Step 4: Implement `tools-scheme-write.ts`**; add `export` to `pickInstance`/`parseScopeToken` in `tools-scheme.ts`; wire `registerSchemeWriteTools` into `server.ts` per the Interfaces block above.
- [ ] **Step 5: Run tests, verify PASS; `npm run build`.**
- [ ] **Step 6: Commit** — `feat(scheme): three write tools — assign/refile/renumber address`

---

### Task 5: Real-Obsidian move verification + uid stability

**Files:**
- Test: `packages/plugin/tests/scheme-write-live-move.test.mjs`

**Interfaces:** consumes `registerSchemeWriteTools` (Task 4), `installObsidianStub` (`tests/obsidian-stub.mjs`, existing — same helper `tests/link-healing.test.mjs` already uses for exactly this reason: a move handler is one of the few things worth testing against a REAL (stubbed) `TFile`/`renameFile`, not a fully fake app, because "a move renames link-aware" is a property of the real handler).

Per `packages/plugin/CLAUDE.md`'s own documentation of this pattern: "The move handlers are the one exception that IS reached headlessly... `tests/obsidian-stub.mjs` registers a synchronous `node:module` resolve hook... and `tests/link-healing.test.mjs` then `await import()`s the real handlers... Use it sparingly." This task is exactly that sparing, justified use — the same property (a rename that goes through `renameFile` never touches frontmatter) is what "uid-stable renames" in the spec is asserting, and it deserves a real test, not an assumption.

- [ ] **Step 1: Read `tests/link-healing.test.mjs` in full** to copy its `installObsidianStub()` setup pattern exactly (import order matters — the stub must install before the real handler module is imported).
- [ ] **Step 2: Write a failing test** — set up a stubbed vault with one note carrying `uid: <fixed-value>` in frontmatter and an address-bearing filename; call `obsidian_renumber_address` (or `obsidian_refile_address` — pick whichever is simpler to set up against the stub) through the real handler with `dry_run: false`; after the move, read the note's frontmatter back through the stub and assert `uid` is byte-identical to before. Also assert the file's actual path changed (proving the move really happened, not a no-op that would make the uid assertion trivially true).
- [ ] **Step 3: Run, verify FAIL** (module/tool doesn't exist yet if this task is done before Task 4 lands — sequence this AFTER Task 4 in execution even though it's listed last-but-one; if execution is subagent-per-task in dependency order, this task depends on Task 4's output, not just its own new file).
- [ ] **Step 4: Run against the real Task 4 implementation, verify PASS.** No new production code — this task is pure test, proving a property Task 4 already has by construction (moveOne goes through `renameFile`, which never touches frontmatter).
- [ ] **Step 5: Commit** — `test(scheme): live-stub verification that scheme mutations preserve uid`

---

### Task 6: Live smoke, docs, PR

**Files:**
- Modify: `packages/plugin/CLAUDE.md` (kernel bullet — extend the existing "Scope-provider module" bullet with the three write tools, following the density/style of that bullet and its neighbors)
- Modify: `README.md` (tool list section, follow existing tool-doc style — see how `obsidian_repoint_link`/the five scheme read tools are documented there)

**Interfaces:** consumes everything from Tasks 1-5; produces the shipped branch + PR.

- [ ] **Step 1: `npm test` + `npm run build`** — full suite green, clean build.
- [ ] **Step 2: Deploy to the live vault for smoke** — `cp main.js manifest.json ~/obsidian/.obsidian/plugins/vault-mcp/`, then reload the plugin (disable/enable via Advanced URI eval, or ask Nelson to reload manually — confirm in chat before this step, same caution the precedent plan's Task 8 flagged, since this replaces whatever build is currently live).
- [ ] **Step 3: Bridge smoke** (keep stdin open — `( printf '…'; sleep 4 ) | node bridge.mjs --vault obsidian`): `obsidian_assign_address` with `dry_run:true` against a real category, then `dry_run:false` on a genuine scratch note and confirm the file actually moved; `obsidian_refile_address` on a deliberately misfiled scratch note; `obsidian_renumber_address` with `on_occupied:"auto"` against two scratch notes, confirming both moved in the right order; journal tail (~2s flush) shows three mutating records with the expected `op`/`target`/`effects`. Clean up every scratch note created for the smoke afterward.
- [ ] **Step 4: Docs** — CLAUDE.md kernel bullet extension; README tool entries for the three new tools, matching the existing five/six scheme tools' doc style.
- [ ] **Step 5: Commit docs** — `docs(scheme): CLAUDE.md + README for the three write tools`
- [ ] **Step 6: Push + PR** — `git push -u origin worktree-jd-mutations-fold`; `gh pr create --base main --title "feat(scheme): assign/refile/renumber mutations — write half of the scope-provider kernel service"` with a body summarizing the spec, the plan's task list, and smoke-test evidence; standard PR footer.
- [ ] **Step 7: Auto-review** — invoke `/code-review high` on the PR per the standing workflow; fix anything it surfaces with focused commits; self-merge only once that review is clean or fixes are pushed (never on the strength of this plan's own reasoning alone).

## Self-review notes

- **Spec coverage:** three tools (Task 4) ✓, dry-run required on all three (Task 4's per-tool behavior) ✓, occupant-displacement with explicit `on_occupied` choice replacing the interactive prompt (Task 2 + Task 4 tool 3) ✓, reuse of existing `nextFree`/`expectedFolder`/`moveOne` rather than a port (Tasks 1-3) ✓, registration outside the module host (Task 4's "Why NOT the module host" note, verified against actual source rather than assumed) ✓, uid stability (Task 5) ✓. Explicitly out of scope per the spec (dashboard, survey, full lint parity, promote-id/demote-id) — no task touches any of them.
- **Type consistency check:** `MoveStep`/`AssignOutcome`/`RefileOutcome`/`RenumberOutcome`/`OnOccupied` (Task 2) are the exact names Task 4 imports and destructures (`result.address`, `result.step`, `result.steps`, `result.displaced`, `result.alreadyCorrect`) — cross-checked against Task 2's own interface block, no renaming across tasks.
- **One correction from the spec during planning:** the spec's Testing section said "vitest" — this repo's actual test runner (confirmed from the precedent plan and `package.json`'s `npm test` script) is Node's built-in `node:test` via `tsx`, not vitest. Every task above uses the correct runner; the spec has a stale assumption worth fixing there too but doesn't block this plan.
- **Task 5's sequencing note:** flagged inline (Step 3) because it's a real dependency-ordering subtlety for whichever execution mode runs this plan — Task 5 needs Task 4's tool registered before its test can pass, even though it's "just a test file" with no production-code step of its own.
