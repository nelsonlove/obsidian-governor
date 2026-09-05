# The module system

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


Capability providers — the [scope provider](scope-provider.md) and the
[vocabulary provider](vocabulary-module.md) — are not hard-wired into the tool surface. They are
**modules**: settings-toggleable units that register their tools **through a registry**, behind
a set of gates that keep the acceptance model intact even as the plugin grows new capabilities.

Files: `packages/plugin/src/kernel/modules/` (the host — pure, Obsidian-free) and
`packages/plugin/src/mcp/modules-mount.ts` (the mount — wires the built-in modules to the live
plugin).

## What a module is

A `VaultModule` (`kernel/modules/module.ts`) is identity + posture + capabilities + a default
enabled state + one verb:

```ts
interface VaultModule {
  id: string;                      // unique; also its key in settings (modules.<id>) 
  posture: "capability" | "governance";
  capabilities: string[];          // e.g. ["addressing","allocation"] or ["vocabulary"]
  enabled: boolean;                // default; settings override per id
  settingsSchema?: ModuleSettingsSchema;
  register(reg, host, config): void;  // called once per built server, only when enabled
}
```

**Posture** distinguishes the two kinds of surface a module could face:

- **`capability`** — faces agents; contributes tools.
- **`governance`** — faces the human; a deliberately one-way, read-only surface (the shape of
  the acceptance module's review pane). **The v1 host
  refuses governance-postured modules outright** at construction. The fold (#83) landed by
  clearing that gate rather than lifting it: the acceptance module (module id `acceptance`;
  the posture name `governance` is unrelated to the retired module id of the same spelling)
  declares posture `capability` and contributes ZERO MCP tools — its whole surface is the
  in-Obsidian pane. The posture exists in the type so the contract models the asymmetry.

## Registration goes *through* the registry — the key property

`server.ts` no longer calls the scope/vocab registrars directly. It calls **`mountModules(...)`**,
which builds a `ModuleRegistry` over the built-in modules and registers each enabled module's
tools through the registry's wrapped registrar. Because the registrar it forwards to is the
**guard-patched `server.registerTool`**, every module tool lands at the **same interception
point** as every hand-registered tool — guarded, queued, journaled, kernel-args-declared, Code
Mode captured — with **no module-specific bypass possible**. A source-scan test pins that the
two registrars are never called outside the mount.

## The gates the registry enforces

`ModuleRegistry` (`kernel/modules/module-registry.ts`) treats module lists and settings as
user-shaped input: every defect — a duplicate id, a settings row naming an unknown module, a
governance posture, a tool-name collision, a forbidden tool name, a throwing `register()` or
`validate()` — is **skipped and reported** via a `problems` array, **never thrown**. One bad
module must not take the tool surface down; a bad tool must not take its module down. (`server.ts`
logs `problems` per connection.)

Two refusals are load-bearing policy, not hygiene:

### 1. The accept / baseline name tripwire

No module may register a tool whose name reads as advancing a baseline or minting acceptance:

```
FORBIDDEN_NAME_FRAGMENTS = ["accept", "approve", "baseline"]   // case-insensitive substring
```

A tool whose name contains any of these is **refused and reported**. This is a **tripwire, not
the security boundary** — the boundary is that no accept-capable code is reachable from any
module the v1 registry will instantiate at all. The tripwire exists so a future module that
*tries* grows a loud, greppable, test-pinned failure instead of a quiet registration.

### 2. The read-only mount gate

`mountModules` passes the registry a **gate**: a module's tool must be **explicitly**
read-only (`readOnlyHint === true`, strict — absent or `false` both refused) **unless the
module itself declares `mutating: true`** in its registration row. A refused tool is **not
registered, not recorded in `describe()`, and does not reserve its name** (the gate runs
*before* the registration is recorded, so bookkeeping stays truthful).

The `mutating: true` declaration is a real, deliberate escape hatch — six of the current
modules use it (see the table below) — not a bypass of any write control: a declared-mutating
module's tools still register through the guard-patched registrar, so they take the full
kernel treatment (read-only mode, path allowlist, write queue, journal, kernel args) exactly
like built-in mutating tools. What the gate refuses is the UNDECLARED case: slipping a
mutating handler into a module that did not declare itself mutating fails the mount loudly
rather than drifting onto the write path. This matches the resolution the status page's
contradiction C-006 records: the module contract distinguishes read-only from declared
mutating actions; no module receives raw accept or baseline authority either way.

## The host context handed to modules is minimal

`mountHost(deps)` returns **exactly** `{ getSettings, visible }` and nothing else
(`modules-mount.ts`) — pinned by a `Object.keys` test:

- `getSettings` — the read-only settings accessor (readOnly / allowlist / …).
- `visible` — the `visiblePaths` allowlist filter (paths in, the visible subset out), so a
  module bounds its answers by the read boundary **exactly** like the built-in tools, without
  importing `guard.ts`.

There is **no raw server, no raw `registerTool`, no baseline/accept primitive**. The only
registrar a module holds is the wrapped `scoped` registrar, which runs the forbidden-name +
collision + gate checks before forwarding — a module cannot walk it to a raw `registerTool`
or to any accept surface. A declared-mutating module's handlers can reach VAULT writes — that
is what the declaration grants — but only through the guarded path with the full kernel
treatment; **no mounted handler, mutating or not, can reach an accept, baseline, or
standing-authority surface** (those primitives are simply never in any module's context).

## Toggling a module

Each module has a row in plugin settings under `modules.<id>`
(`kernel/modules/settings.ts`):

```ts
type ModuleSettings = Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
```

- **`modules.<id>.enabled`** overrides the module's default. The **Modules** section of the
  plugin settings tab (`connection-ui.ts`) renders a GENERATED section per registered module —
  an "Enabled" toggle plus whatever config controls the module's manifest declares — so a new
  module gets its settings surface from its manifest rather than hand-built UI.
- **`modules.<id>.config`** is merged over the module's `settingsSchema.defaults` (shallow).
- **When it takes effect.** Config the *handlers* read (allowlist, scheme rows, vocabularies) is
  a thunk, so those edits land live. But `enabled` is read once **per mount, i.e. per
  connection**, so toggling a module takes effect on the **next session connect** (exactly what
  the settings tab says). This was live-verified: disabling the scheme module dropped the live
  tool count from 56 to 51 on the next connect (the 5 scheme tools gone, vocab intact), and
  re-enabling restored it — while `jd:` addressing kept resolving at the kernel level even with
  the module off.
  - **Exception — the acceptance module's Obsidian surface mounts LIVE.** Acceptance contributes
    zero MCP tools; its `enabled` flag gates an in-Obsidian *review pane + gavel ribbon*, not a
    tool surface. That pane now **mounts/unmounts the moment the toggle flips, with no plugin
    reload** (`main.ts setGovernanceMounted` → `wireGovernance` returns a child `Component` the
    plugin `removeChild`s on disable). Its badge-display config is still read live per refresh.
    The always-on read-only `obsidian_pending_review` MCP view is unaffected by the toggle either
    way. The scheme module's in-Obsidian panes (Inbox/Drift) live-mount the same way. Tool surfaces
    for every module stay next-connect.

## The built-in modules

The authoritative inventory is the [module directory](modules.md); this table is the
mount-registration view (id, default, declared posture). Nine modules register today:

| Module id | Default | Posture | Capabilities |
| --- | --- | --- | --- |
| `scheme` | enabled | read-only | `addressing`, `allocation` — deep ref: [scope-provider.md](scope-provider.md) |
| `vocab` | enabled | read-only | `vocabulary` — deep ref: [vocabulary-module.md](vocabulary-module.md) |
| `bases` | enabled | read-only | `bases` — deep ref: [bases.md](bases.md) |
| `health` | disabled | read-only | `health` |
| `acceptance` | disabled | read-only (zero MCP tools; gates the in-Obsidian review pane) | `acceptance` |
| `provenance` | disabled | **mutating** | `freshness`, `reconcile`, `regen` — deep ref: [provenance.md](provenance.md) |
| `fileclass` | disabled | **mutating** | `fileclass` |
| `crosssession` | disabled | **mutating** | `coordination` — deep ref: [crosssession.md](crosssession.md) |
| `jd-scaffold` | disabled | **mutating** | `scaffolding` |

Skills is no longer a built-in module: it now ships as its own satellite plugin, `vault-skills`, publishing the same six tools through `vault-mcp-api` — see [skills.md](skills.md).

Triage is no longer a built-in module either: it now ships as its own satellite plugin, `vault-triage`, publishing the same two tools through `vault-mcp-api` — see [triage.md](triage.md).

The first two (`scheme`, `vocab`) pre-date the host, so their config rows still live in the top-level `schemes` /
`vocabularies` settings (not `modules.<id>.config`) and their tool layers filter via their own
`getSettings` + guard imports — preserved verbatim so the mount is a pure re-wiring with **zero
behavior change**. A *new* module should instead read `host`/`config` and use `host.visible`,
per the module-host adapters convention.
