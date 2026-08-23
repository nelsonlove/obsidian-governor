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
  the [acceptance module](README.md#the-acceptance-module)'s review pane). **The v1 host
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

`mountModules` passes the registry a **gate** that refuses any module tool whose annotations are
not **explicitly** read-only:

```ts
gate: (name, def) => def?.annotations?.readOnlyHint === true ? null : "not explicitly read-only …"
```

The check is strict `=== true` (absent or `false` both refused) — stricter than the write guard
itself. A refused tool is **not registered, not recorded in `describe()`, and does not reserve
its name** (the gate runs *before* the registration is recorded, so bookkeeping stays truthful).
The two v1 modules pass because all nine of their tools are `readOnlyHint: true`. A future module
that grows a mutating handler **fails the mount loudly** rather than drifting onto the write path.
The enforcement lives in the mount's gate (a bare `registerAll` with no gate would allow mutating
tools) — but the sole `registerAll` caller is `mountModules`, which always passes it, and the
guard-patched `registerTool` is the backstop underneath.

## The host context handed to modules is minimal

`mountHost(deps)` returns **exactly** `{ getSettings, visible }` and nothing else
(`modules-mount.ts`) — pinned by a `Object.keys` test:

- `getSettings` — the read-only settings accessor (readOnly / allowlist / …).
- `visible` — the `visiblePaths` allowlist filter (paths in, the visible subset out), so a
  module bounds its answers by the read boundary **exactly** like the built-in tools, without
  importing `guard.ts`.

There is **no `kernel`, no raw server, no `registerTool`, no baseline/accept primitive**. (The
`ModuleHostCtx` *type* permits optional `kernel?`/`sources?` for future use, but the mount
populates neither.) The only registrar a module holds is the wrapped `scoped` registrar, which
runs the forbidden-name + collision + read-only checks before forwarding — a module cannot walk
it to a raw `registerTool` or to any write/accept surface. Every mounted handler's own context
carries only read-only closures; no mounted handler can reach a write, accept, or baseline
surface.

## Toggling a module

Each module has a row in plugin settings under `modules.<id>`
(`kernel/modules/settings.ts`):

```ts
type ModuleSettings = Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
```

- **`modules.<id>.enabled`** overrides the module's default. The **Modules** section of the
  plugin settings tab (`connection-ui.ts`) renders a toggle per module ("Scope provider
  module", "Vocabulary provider module") writing this flag.
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
    way. This live behavior is scoped to that one module; every other module stays next-connect.

## The two built-in modules

| Module id | Posture | Capabilities | Tools | Doc |
| --- | --- | --- | --- | --- |
| `scheme` | capability | `addressing`, `allocation` | `obsidian_schemes`, `obsidian_resolve_address`, `obsidian_next_address`, `obsidian_list_scope`, `obsidian_expected_location` | [scope-provider.md](scope-provider.md) |
| `vocab` | capability | `vocabulary` | `obsidian_vocabularies`, `obsidian_resolve_term`, `obsidian_validate_terms`, `obsidian_list_vocabulary` | [vocabulary.md](vocabulary-module.md) |

Both pre-date the host, so their config rows still live in the top-level `schemes` /
`vocabularies` settings (not `modules.<id>.config`) and their tool layers filter via their own
`getSettings` + guard imports — preserved verbatim so the mount is a pure re-wiring with **zero
behavior change**. A *new* module should instead read `host`/`config` and use `host.visible`,
per the module-host adapters convention.
</content>
