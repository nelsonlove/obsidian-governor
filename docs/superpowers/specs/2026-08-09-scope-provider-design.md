# Scope provider module — design

*2026-08-09 · branch `assent/scope-provider` (off `assent/kernel-v0`) · session: addressing-allocation*

## What this is

The kernel service chapter 6 of the Assent design names: the **`ScopeProvider` interface** —
scope resolution and placement as the core, addressing and allocation as optional
capabilities — built directly into vault-mcp, with **Johnny Decimal as the first
provider**. Read-only + allocation-compute in v1: no operation in this module mutates a
note.

Rulings from Nelson (2026-08-09, in chat — chat answer is the ruling):

- Module home: **directly in vault-mcp** (not the obsidian-johnny-decimal plugin, not a
  standalone package).
- v1 capability: **addressing + allocation** (no refile/renumber mutations).
- Tool surface: resolve + next + schemes + list_scope + expected_location.
  **Scheme-audit is NOT a tool** — per the Conformance README ("capabilities arrive as
  rule packs, never as new surface"), audit ships as a pure findings function destined
  for the conformance rail.
- Interface must be **capability-based**, shaped by what JD/GTD/PARA/Zettelkasten
  actually share (see next section), so non-addressing schemes fit without contortion.

## The primitives (why the interface looks like this)

Organizational schemes share more than an addressing metaphor, but less than a common
grammar domain:

| Primitive | JD | Zettelkasten | GTD | PARA |
|---|---|---|---|---|
| Scope partition + hierarchy | areas → categories | (flat/links) | lists, contexts | 4 buckets |
| Placement authority | the **address** | none (location-free) | **status** | **status** |
| Grammar ranges over | item identities | item identities | classification tokens | bucket enum |
| Item-level stable addresses | yes | yes | no | no |
| Allocation (mint next id) | next-free decimal | timestamp/folgezettel | — | — |
| Ordering | total | partial | — | — |

Every scheme has a *grammar* (GTD's `@context` tokens parse and validate fine); what
varies is whether the grammar names **item identities** (JD, ZK) or **classification
tokens** (GTD, PARA). Assent routes the latter elsewhere — registered vocabulary is the
registry function (step-5 vocabulary provider), stages are lifecycle statuses, lists are
views. The scope provider owns: partition, placement, and (as capabilities) item
addressing + allocation.

Hence capability flags, finer than one "addressing" boolean:

- `validate` — universal; every provider can check its own tokens.
- `itemAddresses` — grammar assigns per-note stable addresses (JD: yes; PARA: no).
- `allocate` — can mint the next identifier (JD: yes).
- `ordered` — addresses are totally ordered (JD: yes).

## Architecture

Follows the kernel's established discipline (`kernel/uid-index.ts` is the model): pure
TypeScript, **no `obsidian` imports**, headless-testable; the Obsidian glue stays in the
tool layer.

```
packages/plugin/src/kernel/scheme/
  provider.ts     — ScopeProvider interface, Address & Scope types, capability flags
  registry.ts     — SchemeRegistry: instances of {id, provider, config} from settings
  jd.ts           — Johnny Decimal provider (grammar ported verbatim from
                    obsidian-johnny-decimal core/jdId.ts: areas, categories, XX.YY/XX.YYY,
                    5-digit expanded areas/categories, fractal ids; config
                    {expandedAreas, expandedCategories})
  findings.ts     — pure conformance findings over a file listing (misfiled, duplicate
                    address, malformed name, unaddressed-in-territory) — NOT registered
                    as a tool; the rail mounts it later as a rule pack
packages/plugin/src/mcp/
  tools-scheme.ts — the five read-only tools (below)
```

### ScopeProvider interface (chapter 6, made concrete)

```ts
interface ScopeProvider {
  readonly capabilities: { validate: true; itemAddresses: boolean; allocate: boolean; ordered: boolean };
  parse(raw: string): Address | null;            // grammar; Address = { levels: string[], kind: string, raw }
  format(addr: Address): string;
  validateName(filename: string): Finding[];     // token-level check, scheme's own rules
  scopeOf(path: string): Scope | null;           // which scheme scope contains this path
  chainOf(scope: Scope): Scope[];                // scope → root
  membersOf(scope: Scope, files: string[]): Member[];  // address-ordered when `ordered`
  expectedFolder(addr: Address): string;         // placement rule (itemAddresses only)
  nextFree(scope: Scope, used: Set<string>): Address | null;  // allocation (allocate only)
}
```

Providers are pure functions over a supplied file listing — the tool layer feeds them
vault state; the provider never reads the vault itself. Governance-plane container
resolution (registry/records/artifacts/views per ch6) is deferred: nothing in v1
consumes it, and YAGNI rules here.

### Settings

A `schemes` array in plugin settings: `{ id, provider, root, config }`. Default: one JD
instance, `root: ""`, `expandedAreas: ["90-99"]`, `expandedCategories: ["27"]` (Nelson's
vault). Multiple instances may coexist; `id` qualifies addresses when more than one
scheme is configured.

## MCP surface (all read-only, allowlist-filtered)

Every tool filters candidate paths through `visiblePaths` (guard.ts), exactly like the
uid tools — a sandboxed session gets no path oracle for territory it cannot read.

1. **`obsidian_schemes`** — enumerate configured schemes: id, provider, capabilities,
   config, grammar examples. Agent discoverability.
2. **`obsidian_resolve_address`** — `address` → path(s) (duplicates reported, ambiguity
   refuses to pick, like uid resolution); `path` → its address; `parse` → validation
   only.
3. **`obsidian_next_address`** — allocation: given a scope (e.g. category `06`), return
   the next free address. Computes only — reserves nothing; callers wanting exclusivity
   pair it with the existing advisory locks.
4. **`obsidian_list_scope`** — membersOf in address order with free slots/gaps; the
   scheme's view of a scope, not the filesystem's.
5. **`obsidian_expected_location`** — per-note placement report: where the scheme says
   the note should live, and whether it is there.

### Universal addressing

`jd:06.11` (scheme-qualified: `jd:…`; the scheme id is registry-defined) becomes a third
address form beside vault paths and `uid:`, intercepted at the same single point in
`guarded.ts`. Unknown or ambiguous → typed refusal, wording parallel to uid's. This
makes every existing path-taking tool scheme-addressable with one interception change.

## Testing

- Headless unit tests per module (vitest, alongside the kernel's existing suites): the
  JD grammar tests port from obsidian-johnny-decimal's `jdId.test.ts` and extend for
  provider semantics; registry, findings, and each tool handler get their own suites
  with synthetic file listings.
- Live smoke via the bridge JSON-RPC procedure (spawn `bridge.mjs`, speak MCP): resolve
  a real category, allocate against a real scope, `jd:` addressing round-trip on a
  scratch note. Journal flush lag ~2s.

## Delivery

- Branch `assent/scope-provider` off `assent/kernel-v0`; push; **draft PR based on
  `assent/kernel-v0`** (the kernel branch itself stays a never-merge draft, PR #65).
- No note mutations in v1 ⇒ no new Stewardship surface; the tools are read-only and the
  allocation tool computes without reserving.
- Out of scope for v1, recorded for the board: refile/renumber as kernel operations
  (report-first, uid-stable renames), the rail mounting of `findings.ts` (waits on the
  conformance-engine-home board item), PARA/plain-folder providers (drop-ins later),
  governance-plane container resolution.
