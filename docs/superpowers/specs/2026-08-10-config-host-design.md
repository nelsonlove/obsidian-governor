# Config host — design

*2026-08-10 · branch `assent/config-host` (off `main` @ 0.7.0) · author: assent-module-worker-3 · status: DESIGN-FIRST, awaiting review*

## Assignment

Nelson's direction (via orchestrator, 2026-08-10): a proper **host for config that modules
subscribe to**. Each module declares (a) its config/settings schema and (b) its **capability
directory** — a structured listing of everything it does. The settings UI renders a **per-module
page** from that subscription, and that page IS the user-facing directory of everything the
plugin can do: config = discoverability = docs, one source. Extends worker-2's module host
(`kernel/modules/`), whose `VaultModule.settingsSchema` is the seam this grows.

## What exists today (the substrate)

- `VaultModule` (`kernel/modules/module.ts`): `{id, posture, capabilities: string[], enabled,
  settingsSchema?: {defaults?, validate?}, register(reg, host, config)}` — capabilities are
  free-form strings, config validation is a bare problems-list, and everything user-facing
  beyond that lives as prose in tool descriptions or hand-built settings sections.
- `ModuleRegistry` + `modules-mount.ts`: enablement, tripwire, collision checks, `describe()`.
- `connection-ui.ts`: HAND-BUILT sections per feature (Schemes fields from #74/#77, vocab rows,
  the new cli-allowlist Security section) — each with its own bespoke validation-surfacing code.
  This is the pattern the config host replaces: today every new module hand-writes UI; after,
  a module ships a manifest and the UI appears.

## Design

### 1. `ModuleManifest` — the subscription

Grows `settingsSchema` into a full manifest (pure data + one validate function; no handlers,
no UI code, kernel-pure):

```ts
export interface ModuleManifest {
  /** One-paragraph, user-facing: what this module is for. */
  summary: string;

  config?: {
    /** Renderable, typed fields — the UI is generated from these. */
    fields: ConfigField[];
    /** Cross-field validation; problems land in the UI inline AND in
     * ModuleRegistry.problems (skip-and-report unchanged). Subsumes the
     * per-provider validateConfig pattern (jd's validateJdConfig becomes the
     * scheme manifest's validate). */
    validate?(config: Record<string, unknown>): string[];
    defaults?: Record<string, unknown>;
  };

  directory?: {
    tools?: ToolDoc[];             // agent-facing tools
    addressForms?: SurfaceDoc[];   // non-tool surfaces: `jd:<address>` (the extension point
                                   // flagged at the module-interface review — now first-class)
    rulePacks?: SurfaceDoc[];      // unregistered contributions (schemeFindings, vocab findings)
    kernelArgs?: SurfaceDoc[];     // cross-cutting args a module adds (none today; B2's intent
                                   // pattern shows the class exists)
  };
}

export interface ConfigField {
  key: string;                     // path within this module's config namespace (see §3 bindings)
  label: string;
  help?: string;                   // one sentence under the field
  type: "text" | "lines" | "csv" | "number" | "toggle" | "select";
  placeholder?: string;
  options?: string[];              // for "select"
  caveats?: string[];              // rendered as a warning list — e.g. "matching is
                                   // case-sensitive; macOS's case-insensitive filesystem does
                                   // not make 'vault archaeology' match 'Vault archaeology'"
}

export interface ToolDoc {
  name: string;                    // must match a registered tool name (checked, see §5)
  purpose: string;                 // one sentence
  readOnly: boolean;               // must match annotations.readOnlyHint (checked)
  options?: { name: string; what: string }[];   // notable args, not a schema dump
  caveats?: string[];              // structured versions of the prose caveat class
                                   // (hidden-occupant, excluded-territory, computes-only…)
  example?: string;                // one call worth showing
}

export interface SurfaceDoc { name: string; purpose: string; caveats?: string[]; }
```

`VaultModule` gains `manifest?: ModuleManifest`. `settingsSchema` stays as a deprecated alias
for one release (registry reads `manifest.config` first, falls back) so worker-2's mount and
both live modules migrate without a flag-day.

### 2. `ConfigHost` — the collector (pure, `kernel/modules/config-host.ts`)

- `collect(registry): HostedModule[]` — pulls each module's manifest, merges defaults under
  stored config, runs validate, and yields render-ready data:
  `{id, posture, enabled, summary, fields+values+problems, directory, contributedTools}`.
- Owns NO storage: reads through the same `getSettings` thunk everything uses; writes go
  through a caller-supplied `save(patch)` (connection-ui passes the plugin's saveSettings
  path). **No MCP-writable path to config exists or is added — pinned by test** (the host
  exposes no tool; the settings surface stays human-only, same property the cli-allowlist
  build leaned on).
- Also the docs emitter's input: `renderDirectoryMarkdown(hosted)` produces the per-module
  tool-section markdown used by §5.

### 3. Config bindings — no data migration in v1

Scheme instances live at top-level `settings.schemes[]`, vocab at `settings.vocabularies`,
module rows at `settings.modules.<id>`. Moving them under `modules.<id>.config` would be a
churny migration mid-fleet. Instead a manifest's `config.fields[].key` resolves through a
per-module **binding** declared by the module (`bindings: {root: "schemes[0]"}`-style, one
line in the mount) so the generated UI reads/writes the EXISTING settings shape. A later
consolidation of storage shape is then a data move behind a stable UI, not a UI rewrite.

### 4. The rendered page (connection-ui)

One generic renderer, zero per-module UI code:

- The settings tab gains a **module nav** (Obsidian settings tabs are single-page: a
  section-per-module layout with a sticky module list, matching how large plugins do it).
- Per module: title + posture badge + enabled toggle (existing `modules.<id>.enabled`
  semantics: applies on next connect — the existing honest wording moves into the generated
  header), then generated config fields with inline problem surfacing (the #74/#77 pattern,
  generalized once instead of re-implemented per section), then the **capability directory**:
  tools with purpose/options/caveats, address forms, rule packs.
- Existing hand-built sections (Schemes, vocab rows) are REPLACED by their manifest-generated
  equivalents in the same PR that introduces each manifest — no parallel duplicate UI.
  Non-module surfaces (Security/cli-allowlist, connection basics) stay hand-built until §6.

### 5. Single-source docs (the docs track)

- A build-time emitter (`npm run docs:modules`, tsx script) writes the per-module tool
  sections of README.md from the same manifests (fenced generated blocks, like the JDex
  sentinel-comment pattern). Drift between manifest and registration is CHECKED in tests:
  every `ToolDoc.name` must be a tool the module actually contributed, `readOnly` must match
  the annotation, and every contributed tool must carry a ToolDoc — the manifest can't rot.
- Tool descriptions themselves stay authoritative for agents; ToolDoc.purpose is the human
  layer. Where they'd duplicate, the description's first sentence IS the purpose (convention,
  checked loosely — same first sentence — to keep one voice).

### 6. Phasing

1. **Phase 1 (build on +1):** manifest types + ConfigHost + scheme & vocab manifests +
   generic renderer replacing their hand-built sections + generalized problem surfacing +
   drift tests. Headless throughout (renderer logic pure; only the thin Setting-element glue
   touches Obsidian, following connection-ui's existing split).
2. **Phase 2:** docs emitter + README generation; a `core` pseudo-module manifest covering the
   built-in (non-module) tool surface so the directory really is "everything the plugin does";
   Security/cli-allowlist section migrates onto a manifest.
3. **Phase 3 (needs disclosure review):** agent-facing discoverability — an
   `obsidian_capabilities` read-only tool serving the directory. Explicitly NOT in phase 1:
   what config is disclosed to agents needs the same oracle discipline as everything else
   (precedent: `obsidian_schemes` deliberately under-discloses `excludedRoots` because config
   values can name allowlist-hidden territory). Ships only after that review.

### 7. Security invariants (carried, pinned)

- Manifests are data; the renderer never evaluates module-supplied strings as code/HTML
  (text nodes only — the Stewardship intent-display precedent).
- No new write path: config writes remain the human settings surface; the host adds no tool
  and no MCP-reachable setter (test-pinned).
- The tripwire/collision/posture checks are untouched; the manifest adds enumeration, not
  authority. Governance posture stays refused at the registry; a governance module's future
  manifest renders its page with the same machinery but contributes no tools (the asymmetry
  survives in data).

### Coordination

- **worker-2 (module host):** additive extension of your contract — `manifest?` beside
  `settingsSchema`, registry fallback, mount passes manifests through. Flag objections.
- **worker-1 (conformance engine):** your pack registry subscribes here rather than inventing
  its own config; `rulePacks` SurfaceDocs are where the packs' directory entries land.
- **cli-allowlist (worker-2):** your Security section is the phase-2 migration candidate; the
  human-only property is preserved by construction (§2).

### Open questions for review

1. Section-per-module with nav vs. a module dropdown — taste call, cheap to swap (renderer is
   data-driven either way).
2. Should `modules.<id>.enabled` move into the generated header only, or also stay in a
   compact all-modules overview row at the top? (I lean: both — overview grid + per-page.)
3. The `core` pseudo-module (phase 2): one manifest for ~47 built-in tools is a big authoring
   lift — propose generating its ToolDocs from registration metadata + hand-written purpose
   lines only, not full caveat curation in one pass.
