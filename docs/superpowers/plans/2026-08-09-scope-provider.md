# Scope Provider Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement chapter 6's `ScopeProvider` kernel service in vault-mcp — capability-gated scheme providers with Johnny Decimal first — as five read-only MCP tools plus `jd:<address>` universal addressing.

**Architecture:** Pure, Obsidian-free kernel modules under `packages/plugin/src/kernel/scheme/` (the `uid-index.ts` discipline: injected data, headless-tested); one tool module `mcp/tools-scheme.ts` registered per-connection in `server.ts`; scheme addressing intercepted in `mcp/guarded.ts` beside uid addressing. Spec: `docs/superpowers/specs/2026-08-09-scope-provider-design.md`.

**Tech Stack:** TypeScript (strict), esbuild, node:test via `npm test` (`tsc --noEmit && node --import tsx --test 'tests/*.test.mjs'`), zod for tool schemas, MCP SDK.

## Global Constraints

- All work in `packages/plugin/` of the `scope-provider` worktree, branch `assent/scope-provider`.
- Kernel modules import NOTHING from `obsidian` (not even types).
- Every tool is read-only: `annotations` = `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`. No tool mutates a note or kernel state.
- Every path-returning answer filters through `visiblePaths(paths, settings)` from `../guard.js` — no path oracle for allowlisted sessions.
- Result helpers: `ok()` / `fail()` / `codedError()` from `./helpers.js` (mcp dir).
- JD grammar semantics port VERBATIM from `~/repos/obsidian-johnny-decimal/src/core/jdId.ts` (+ its `jdId.test.ts` cases) — do not redesign the grammar; adapt names only where the ScopeProvider interface requires.
- Conventional commits, one per task minimum. `npm test` green before every commit.
- Scheme-audit is NOT a registered tool (Nelson's ruling; Conformance README: "rule packs, never new surface"). `findings.ts` exports pure functions only.

---

### Task 1: Provider types + JD grammar core

**Files:**
- Create: `packages/plugin/src/kernel/scheme/provider.ts`
- Create: `packages/plugin/src/kernel/scheme/jd.ts`
- Test: `packages/plugin/tests/scheme-jd.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (later tasks rely on these exact names):

```ts
// provider.ts
export interface Capabilities { validate: true; itemAddresses: boolean; allocate: boolean; ordered: boolean; }
export interface Address { raw: string; kind: string; levels: string[]; }
export interface Scope { kind: string; token: string; }           // e.g. {kind:"category", token:"06"}
export interface Member { path: string; address: string | null; }
export interface SchemeFinding { code: "misfiled" | "duplicate_address" | "malformed_name" | "unaddressed"; path: string; detail: string; }
export interface ScopeProvider {
  readonly capabilities: Capabilities;
  parse(raw: string): Address | null;
  format(addr: Address): string;
  addressOf(path: string): Address | null;        // extract from basename; null when none
  validateName(filename: string): SchemeFinding[];
  scopeOf(path: string): Scope | null;
  chainOf(scope: Scope): Scope[];                 // self first, root last
  membersOf(scope: Scope, notes: string[]): Member[];
  expectedFolder(addr: Address, notes: string[]): string | null;  // null when not derivable
  nextFree(scope: Scope, notes: string[]): Address | null;        // null when capability absent or scope full
}
```

```ts
// jd.ts
export interface JdConfig { expandedAreas: string[]; expandedCategories: string[]; }
export const DEFAULT_JD_CONFIG: JdConfig = { expandedAreas: ["90-99"], expandedCategories: ["27"] };
export function jdProvider(cfg: JdConfig): ScopeProvider;
```

JD `Address.kind` ∈ `"area" | "category" | "id" | "expanded-item" | "fractal-id"` (the source enum). `levels` for `06.11` = `["00-09","06","11"]` (area, category, decimal); for `92021.10` = `["90-99","92021","10"]`. `capabilities` = `{ validate: true, itemAddresses: true, allocate: true, ordered: true }`.

- [ ] **Step 1: Read the source grammar** — `~/repos/obsidian-johnny-decimal/src/core/jdId.ts` and `src/core/jdId.test.ts` in full. The regexes: `RE_AREA /^([0-9])0-([0-9])9$/` (digits must match), `RE_CATEGORY /^[0-9]{2}$/`, `RE_ID /^([0-9]{2})\.([0-9]{2,3})$/`, `RE_FRACTAL /^([0-9]{5})\.([0-9]{2})$/`, `RE_FIVE /^([0-9]{5})$/`. Port `parseJdId`, `areaOfCategory`, `categoryOf`, `isExpandedCategory`, `isExpandedAreaItem`, `isStandardZero`, `idTokenFromName`, `nextContentDecimal` semantics verbatim.
- [ ] **Step 2: Write failing tests** in `tests/scheme-jd.test.mjs` (node:test, `import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js"`). Port every case from `jdId.test.ts`, expressed against the provider surface, plus:

```js
const p = jdProvider(DEFAULT_JD_CONFIG);
// parse/format round-trips
assert.deepEqual(p.parse("06.11")?.levels, ["00-09", "06", "11"]);
assert.equal(p.parse("06.11")?.kind, "id");
assert.equal(p.parse("06.110")?.kind, "id");            // 3-digit decimal (survey widening)
assert.equal(p.parse("92021")?.kind, "expanded-item");   // 90-99 expanded
assert.equal(p.parse("27001")?.kind, "expanded-item");   // expanded category
assert.equal(p.parse("92021.10")?.kind, "fractal-id");
assert.equal(p.parse("00-09")?.kind, "area");
assert.equal(p.parse("06")?.kind, "category");
assert.equal(p.parse("26 2.18"), null);                  // malformed
assert.equal(p.parse("10-29"), null);                    // digits must match
assert.equal(p.format(p.parse("06.11")), "06.11");
// addressOf: basename token extraction
assert.equal(p.format(p.addressOf("00-09 System/06 Agent tooling/06.11 Foo bar.md")), "06.11");
assert.equal(p.addressOf("Notes/plain note.md"), null);
assert.equal(p.format(p.addressOf("90-99 Projects/92021 Big thing/92021.10 Sub.md")), "92021.10");
```

- [ ] **Step 3: Run tests, verify FAIL** — `npm test` (or targeted: `node --import tsx --test tests/scheme-jd.test.mjs`). Expected: module-not-found.
- [ ] **Step 4: Implement `provider.ts` (types only) and `jd.ts`** — the ported grammar behind the `ScopeProvider` shape. `addressOf` = `idTokenFromName(basename)` (first whitespace-delimited token) → `parse`, null when no parse. Implement `parse`/`format`/`addressOf`/`validateName` in this task; stub `scopeOf`/`chainOf`/`membersOf`/`expectedFolder`/`nextFree` to `throw new Error("task 2")` so the file compiles and Task 1 tests stay scoped. `validateName` findings: `malformed_name` when the leading token LOOKS numeric (`/^[0-9][0-9.\-]*$/`) but does not parse.
- [ ] **Step 5: Run tests, verify PASS** — grammar + addressOf tests green (`npm test` runs tsc too; the throwing stubs satisfy the types).
- [ ] **Step 6: Commit** — `feat(scheme): ScopeProvider types + JD grammar core (ported from obsidian-johnny-decimal)`

### Task 2: JD scope semantics — scopeOf/chainOf/membersOf/expectedFolder/nextFree

**Files:**
- Modify: `packages/plugin/src/kernel/scheme/jd.ts`
- Test: `packages/plugin/tests/scheme-jd-scopes.test.mjs`

**Interfaces:**
- Consumes: Task 1's types and jd internals.
- Produces: the five remaining `ScopeProvider` methods, live.

Semantics (all over supplied `notes: string[]`, vault-relative paths):
- `scopeOf(path)`: deepest scheme scope containing the path, from path segments — a segment parsing as `area` or `category` (or expanded-item folder) claims scope; e.g. `"00-09 System/06 Agent tooling/06.11 Foo.md"` → `{kind:"category", token:"06"}`; a path with only an area segment → `{kind:"area", token:"00-09"}`; no scheme segment → null.
- `chainOf({kind:"category",token:"06"})` → `[{kind:"category",token:"06"},{kind:"area",token:"00-09"}]` (self first; area from `areaOfCategory`).
- `membersOf(scope, notes)`: notes whose `addressOf` falls inside the scope (category `06` ⇒ ids `06.*`; area ⇒ its categories' members; expanded category `27` ⇒ `27001…`), sorted by address (numeric on decimals), `address` formatted; notes physically inside the scope's folder but with no address are EXCLUDED here (they are `unaddressed` findings, Task 4's business).
- `expectedFolder(addr, notes)`: the folder of the note(s) claiming the deepest ancestor scope container — derive from where the category folder actually lives: find the folder segment parsing to `addr`'s category (or area for categories) among `notes` paths; return `null` when the container folder can't be found. For `06.11` with notes under `"00-09 System/06 Agent tooling/…"` ⇒ `"00-09 System/06 Agent tooling"`.
- `nextFree(scope, notes)`: category scope ⇒ lowest unused decimal ≥ 10 (standard-zeros `.00–.09` reserved — `nextContentDecimal` semantics, port verbatim including its exhaustion-returns-null behavior); expanded category/area ⇒ next 5-digit sequential; area scope ⇒ null (allocate ids, not categories, in v1).

- [ ] **Step 1: Write failing tests** in `tests/scheme-jd-scopes.test.mjs` with a synthetic vault listing:

```js
const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "Unfiled/loose.md",
];
const p = jdProvider(DEFAULT_JD_CONFIG);
assert.deepEqual(p.scopeOf(NOTES[2]), { kind: "category", token: "06" });
assert.deepEqual(p.chainOf({ kind: "category", token: "06" }), [
  { kind: "category", token: "06" }, { kind: "area", token: "00-09" }]);
assert.equal(p.scopeOf("Unfiled/loose.md"), null);
const members = p.membersOf({ kind: "category", token: "06" }, NOTES);
assert.deepEqual(members.map(m => m.address), ["06.00", "06.11", "06.12"]);
assert.equal(p.expectedFolder(p.parse("06.13"), NOTES), "00-09 System/06 Agent tooling");
assert.equal(p.format(p.nextFree({ kind: "category", token: "06" }, NOTES)), "06.13");
// .00-.09 reserved: a category with only 06.00 allocates 06.10
// full category (all 10..99 used) ⇒ null
```

- [ ] **Step 2: Run, verify FAIL** (`throw new Error("task 2")` stubs).
- [ ] **Step 3: Implement the five methods** in `jd.ts` per the semantics block above.
- [ ] **Step 4: Run tests, verify PASS** — both scheme test files + whole suite (`npm test`).
- [ ] **Step 5: Commit** — `feat(scheme): JD scope resolution, membership, placement, allocation`

### Task 3: SchemeRegistry + address-string resolution

**Files:**
- Create: `packages/plugin/src/kernel/scheme/registry.ts`
- Test: `packages/plugin/tests/scheme-registry.test.mjs`

**Interfaces:**
- Consumes: `ScopeProvider`, `Address` (Task 1), `jdProvider` (Tasks 1–2).
- Produces:

```ts
export interface SchemeInstanceConfig { id: string; provider: "johnny-decimal"; config?: Partial<JdConfig>; }
export const DEFAULT_SCHEMES: SchemeInstanceConfig[] = [{ id: "jd", provider: "johnny-decimal" }];
export interface SchemeInstance { id: string; providerName: string; provider: ScopeProvider; }
export function makeRegistry(configs: SchemeInstanceConfig[]): SchemeRegistry;
export class SchemeRegistry {
  instances(): SchemeInstance[];
  get(id: string): SchemeInstance | null;
  /** "jd:06.11" → { instance, addr } | null (null = not scheme-shaped / unknown id / unparseable address) */
  parseRef(ref: string): { instance: SchemeInstance; addr: Address } | null;
  /** Paths whose addressOf equals addr, in listing order. */
  resolve(instance: SchemeInstance, addr: Address, notes: string[]): string[];
}
export class AddressUnresolvedError extends Error { code = "address_unresolved"; }
export class AddressAmbiguousError extends Error { code = "address_ambiguous"; constructor(msg: string, readonly candidates: string[]); }
export function requireOneAddress(reg: SchemeRegistry, ref: string, notes: string[]): string; // throws the two above
```

Rules: unknown provider name in a config ⇒ that instance is SKIPPED with a `console.error` (a bad config entry must not break the server); `parseRef` matches `/^([a-z][a-z0-9-]*):(.+)$/`, returns null for `uid:` (reserved) and unregistered ids — callers treat null as "an ordinary path", so a filename containing a colon never breaks; `requireOneAddress` throws `AddressUnresolvedError` on 0 candidates, `AddressAmbiguousError` (naming candidates) on 2+.

- [ ] **Step 1: Write failing tests** — default registry resolves `jd:06.11` against the Task-2 NOTES listing to the one path; `jd:99.99` throws `AddressUnresolvedError`; a listing with two `06.11 *` notes throws `AddressAmbiguousError` naming both; `parseRef("uid:abc")` → null; `parseRef("Notes/a:b.md")` → null; unknown provider config skipped, `instances()` length 0.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement `registry.ts`.**
- [ ] **Step 4: Run tests, verify PASS** (full `npm test`).
- [ ] **Step 5: Commit** — `feat(scheme): scheme registry + address-string resolution`

### Task 4: Conformance findings core (pure, unregistered)

**Files:**
- Create: `packages/plugin/src/kernel/scheme/findings.ts`
- Test: `packages/plugin/tests/scheme-findings.test.mjs`

**Interfaces:**
- Consumes: `SchemeInstance` (Task 3), `SchemeFinding` (Task 1).
- Produces: `export function schemeFindings(instance: SchemeInstance, notes: string[]): SchemeFinding[];`

Rules over the listing: `duplicate_address` (two+ notes, same formatted address — one finding per extra path, detail names the first claimant); `misfiled` (addressed note whose folder ≠ `expectedFolder` when derivable — detail says expected vs actual); `malformed_name` (delegated to `provider.validateName`); `unaddressed` (note inside a scheme scope — `scopeOf` non-null — whose `addressOf` is null; scratch/index conventions are NOT special-cased in v1, the rail's ratchet baselines them). Deterministic order: sorted by path.

- [ ] **Step 1: Write failing tests** — a listing exhibiting each finding class exactly once + a clean listing producing `[]`; NOT-a-tool assertion belongs to Task 6's inventory test, noted there.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Commit** — `feat(scheme): pure conformance findings (rail rule-pack core, unregistered)`

### Task 5: Settings plumbing

**Files:**
- Modify: `packages/plugin/src/main.ts` (`VaultMcpSettings`, `DEFAULT_SETTINGS`, settings tab)
- Test: extend `packages/plugin/tests/scheme-registry.test.mjs`

**Interfaces:**
- Consumes: `SchemeInstanceConfig`, `DEFAULT_SCHEMES`, `DEFAULT_JD_CONFIG`.
- Produces: `settings.schemes: SchemeInstanceConfig[]` reaching `ServerCtx` (tools read it via the existing `ctx.getSettings()` pattern — follow how `trustedReadOnlyPlugins` flows from settings into server build).

- [ ] **Step 1: Add `schemes: SchemeInstanceConfig[]` to `VaultMcpSettings`** with `DEFAULT_SETTINGS.schemes = DEFAULT_SCHEMES`. `Object.assign({}, DEFAULT_SETTINGS, await this.loadData())` already defaults absent keys — verify, don't reimplement.
- [ ] **Step 2: Settings tab** — one section "Schemes"; for the default JD instance two text fields (comma-separated expanded areas, expanded categories) writing `settings.schemes[0].config`; mirror the existing settings-tab field style in main.ts. Multi-instance stays data.json-editable, no UI (YAGNI).
- [ ] **Step 3: Registry-from-settings test** — `makeRegistry(DEFAULT_SCHEMES)` yields a jd instance whose config merges `DEFAULT_JD_CONFIG` under partial overrides (e.g. `{expandedCategories:["27","31"]}` keeps `expandedAreas:["90-99"]`).
- [ ] **Step 4: `npm test` green; build (`npm run build`).**
- [ ] **Step 5: Commit** — `feat(scheme): schemes settings block + JD config fields`

### Task 6: tools-scheme.ts — the five read-only tools

**Files:**
- Create: `packages/plugin/src/mcp/tools-scheme.ts`
- Modify: `packages/plugin/src/mcp/server.ts` (import + register; wire a notes source)
- Test: `packages/plugin/tests/scheme-tools.test.mjs`; Modify: `packages/plugin/tests/tool-inventory.test.mjs`

**Interfaces:**
- Consumes: registry (Task 3), findings NOT consumed (stays unregistered), `visiblePaths`/`GuardSettings` from `../guard.js`, `ok`/`fail`/`codedError` from `./helpers.js`.
- Produces:

```ts
export interface SchemeToolsCtx {
  registry: () => SchemeRegistry;          // rebuilt from settings per call — config edits land live
  notes: () => string[];                    // vault markdown paths; wired in server.ts from app.vault.getMarkdownFiles()
  getSettings?: () => GuardSettings;
}
export function registerSchemeTools(server: McpServer, ctx: SchemeToolsCtx): void;
```

Follow `tools-uid.ts` as the model file (RO annotations, ctx shape, visible() helper, fail() on missing prereqs). The five registrations, exact names and behavior:

1. `obsidian_schemes` — no args. `ok({ schemes: [{id, provider, capabilities, config, examples}] })`; JD examples: `["jd:06.11", "jd:92021.10", "jd:00-09"]`.
2. `obsidian_resolve_address` — `{ address?: string, path?: string }` (exactly one; both/neither ⇒ `fail`). `address` (accepts `jd:06.11` or bare `06.11` when exactly one scheme is configured): parse-only report when it parses but resolves to 0 paths ⇒ `ok({found:false, parsed:{kind, levels}})`; resolves ⇒ `ok({found:true, path, …duplicates/ambiguous when 2+ visible})` — mirror `obsidian_resolve_uid`'s shape verbatim. `path` ⇒ `ok({path, address, scheme})` or `address: null`.
3. `obsidian_next_address` — `{ scope: string, scheme?: string }` (scheme id defaults to the single configured instance; required when several). Scope token parsed by the provider (`"06"`, `"90-99"`, `"27"`). ⇒ `ok({scope, next, exhausted:false})` / `ok({scope, next:null, exhausted:true})`; unparseable scope ⇒ `codedError("invalid_scope", …)`. Description MUST say: computes only, reserves nothing; pair with `obsidian_claim_scope` for exclusivity.
4. `obsidian_list_scope` — `{ scope: string, scheme?: string }` ⇒ `ok({scope, members:[{address, path}], free:{next, gaps:[…≤20]}})`, members visible-filtered, address-ordered.
5. `obsidian_expected_location` — `{ path?: string, address?: string, scheme?: string }` ⇒ `ok({address, expected_folder, actual_folder, placed: boolean})`; `expected_folder: null` when not derivable. A `path` outside every scheme scope with no address ⇒ `ok({address:null, expected_folder:null, placed:null})`.

Allowlist rule (all five): candidate paths through `visiblePaths`; `obsidian_resolve_address` ambiguity counts VISIBLE candidates only (the uid precedent: 0 visible ⇒ not found even when hidden carriers exist). `notes()` output is pre-filtered through `visiblePaths` once per call before reaching the provider, so members/gaps/findings never see hidden paths either.

- [ ] **Step 1: Write failing tests** in `tests/scheme-tools.test.mjs` — register against a fake server (follow `tests/uid-index.test.mjs` / `tests/fake-server.mjs` pattern), synthetic notes listing from Task 2; per tool: happy path, the error branches named above, and an allowlist case (settings `{readOnly:false, allowlist:["00-09 System"]}` hides the `90-99` note from resolve/list/duplicates).
- [ ] **Step 2: Update `tests/tool-inventory.test.mjs`** — the five new names present; assert NO `obsidian_scheme_audit` registration (the not-a-tool ruling, pinned).
- [ ] **Step 3: Run, verify FAIL.**
- [ ] **Step 4: Implement `tools-scheme.ts`; register in `server.ts`** — `registerSchemeTools(server, { registry: () => makeRegistry(ctx.settings().schemes), notes: () => app.vault.getMarkdownFiles().map(f => f.path), getSettings: … })` beside `registerUidTools`; match how existing ctx getters are wired there.
- [ ] **Step 5: Run tests, verify PASS; `npm run build`.**
- [ ] **Step 6: Commit** — `feat(scheme): five read-only scheme tools (schemes/resolve/next/list/expected)`

### Task 7: `jd:` universal addressing in guarded.ts

**Files:**
- Modify: `packages/plugin/src/kernel/scheme/registry.ts` (add `resolveSchemeArgs`)
- Modify: `packages/plugin/src/mcp/guarded.ts` (intercept beside uid), `GuardedOpts` (add `schemes?`, `schemeNotes?`)
- Modify: `packages/plugin/src/mcp/server.ts` (wire the two new opts)
- Test: `packages/plugin/tests/scheme-addressing.test.mjs`

**Interfaces:**
- Consumes: `mapPaths` from `../guard.js` (same walker uid addressing uses — the addressable set and the allowlist-scoped set stay one set by construction), `requireOneAddress`/`parseRef` (Task 3).
- Produces:

```ts
// registry.ts
export function resolveSchemeArgs(
  args: Record<string, unknown>,
  reg: SchemeRegistry | null,
  notes: () => string[],
  settings?: GuardSettings
): { args: Record<string, unknown>; resolved: Array<{ ref: string; path: string }> };
```

Behavior, mirroring `resolveUidArgs` exactly: walk path-bearing values via `mapPaths`; a value whose `parseRef` is non-null resolves through `requireOneAddress` over the allowlist-VISIBLE listing (`visiblePaths(notes(), settings)`), rewriting to the real path; `parseRef` null ⇒ value untouched (same object identity when nothing changed — pinned by test); throws `AddressUnresolvedError`/`AddressAmbiguousError` for the wrapper to render as `codedError(e.code, e.message)`. In `makeGuarded`, run scheme resolution AFTER uid resolution (uid: is reserved and takes precedence), BEFORE `guardCall`; extend `uidSafe`'s fold-back with the scheme `resolved` pairs so refusals disclose `jd:06.11`, not the hidden path it named.

- [ ] **Step 1: Write failing tests** — through `makeGuarded` with a stub handler (follow the uid-addressing cases in `tests/kernel.test.mjs` or `tests/guard.test.mjs`, whichever hosts them — read both first): `path: "jd:06.11"` reaches the handler as the real path; unknown address ⇒ `Error [address_unresolved]`, handler never runs; two claimants ⇒ `Error [address_ambiguous]` naming both; allowlisted session addressing a hidden note ⇒ unresolved (not out_of_allowlist — no existence oracle); `path: "Notes/a:b.md"` passes through untouched (same args object identity); allowlist refusal text shows `jd:…` form, not the resolved path; `uid:` values still resolve through the uid path (no regression — re-run existing suites).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `resolveSchemeArgs` + the guarded.ts interception + server.ts wiring (`schemes: () => makeRegistry(settings.schemes)`, `schemeNotes` same source as Task 6).
- [ ] **Step 4: Run FULL suite, verify PASS** — kernel/guard/uid/read-boundary suites prove no regression at the interception point.
- [ ] **Step 5: Commit** — `feat(scheme): scheme-qualified addressing (jd:<address>) at the guard interception point`

### Task 8: Live smoke, docs, PR

**Files:**
- Modify: `packages/plugin/CLAUDE.md` (kernel bullet for the scheme module), `README.md` (tool list section, follow existing tool-doc style)
- Vault (via vault-mcp write): update `Assent/Build/Scope provider (addressing-allocation).md` status checkboxes

**Interfaces:** consumes everything; produces the shipped branch.

- [ ] **Step 1: `npm test` + `npm run build`** — full suite green, clean build.
- [ ] **Step 2: Deploy to the live vault** — `cp main.js manifest.json ~/obsidian/.obsidian/plugins/vault-mcp/`, reload plugin (CLAUDE.md procedure). NOTE: the live vault currently runs the kernel-v0 deploy; this replaces it — confirm with Nelson in chat BEFORE this step if the Stewardship testing session is still active.
- [ ] **Step 3: Bridge smoke** (keep stdin open — `( printf '…'; sleep 4 ) | node bridge.mjs --vault obsidian`): `obsidian_schemes` lists jd; `obsidian_resolve_address {address:"jd:06.11"}` finds the real note; `obsidian_next_address {scope:"06"}` returns a plausible free id; `obsidian_read_note {path:"jd:06.11"}` round-trips via universal addressing; journal tail (~2s flush) shows no mutating records from any of it.
- [ ] **Step 4: Docs** — CLAUDE.md kernel bullet (scheme module: files, capability flags, not-a-tool findings ruling, addressing precedence uid→scheme); README tool entries.
- [ ] **Step 5: Update the vault coordination note** status section (checkboxes → done, add smoke results line).
- [ ] **Step 6: Push + draft PR** — `git push -u origin assent/scope-provider`; `gh pr create --draft --base assent/kernel-v0 --title "feat(scheme): ScopeProvider kernel service — JD addressing + allocation (read-only v1)"`; body summarizes spec, rulings, tool surface, smoke evidence; standard PR footer.
- [ ] **Step 7: Commit any doc changes** — `docs(scheme): CLAUDE.md + README for the scope provider module`

## Self-review notes

- Spec coverage: primitives→capability flags (T1), JD grammar (T1), scope core (T2), registry/settings (T3/T5), findings-not-a-tool (T4 + T6 inventory pin), five tools (T6), universal addressing (T7), allowlist discipline (T6/T7 tests), live smoke + PR (T8). Governance-plane container resolution: deliberately deferred (spec says so).
- Type names cross-checked: `ScopeProvider`/`Address`/`Scope`/`Member`/`SchemeFinding`/`SchemeInstanceConfig`/`SchemeRegistry`/`requireOneAddress`/`resolveSchemeArgs` used consistently across tasks.
- The one deploy-risk step (T8 step 2) is flagged for chat confirmation — the live vault is Nelson's active Stewardship test bed.
