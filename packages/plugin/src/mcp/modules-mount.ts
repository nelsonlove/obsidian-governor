// modules-mount.ts — the module host's mount: the two built-in capability
// modules (scope-provider, vocabulary provider) assembled as VaultModules and
// registered THROUGH the ModuleRegistry (ruled decision #2 realized — they
// are settings-toggleable units behind the host's tripwire/collision checks,
// no longer direct registerXTools calls in server.ts).
//
// Pure and headless-testable: no `obsidian` imports — the vault-facing
// dependencies (note listings, the vocab source) arrive injected via
// MountDeps, exactly as tools-scheme/tools-vocab already take them; server.ts
// contributes only the live adapters and the patched registerTool.
//
// ── The hard security gate this file answers (recorded by the orchestrator
//    on the module-host merge; verified by test where testable) ─────────────
//
//  1. HANDLER reachability: every tool either module contributes is
//     `readOnlyHint: true` — a read-only registration cannot reach the write
//     queue, the write primitive, or the accept-guard's territory at all (the
//     guard routes ONLY `readOnlyHint === false` calls to the kernel's
//     mutation path). Pinned by test: the mount's registerAll gate refuses a
//     module tool whose annotations are not read-only (see `mountModules`),
//     so a future module slipping a mutating handler in fails loudly (a
//     `problems` entry, surfaced by server.ts) rather than registering
//     quietly.
//  2. The host ctx handed to modules is MINIMAL: `getSettings` + `visible`
//     and nothing else — no kernel, no raw server, no registerTool, no
//     baseline/accept surface. Pinned by test over `mountHost`'s keys.
//  3. Modules register ONLY through the registry: server.ts no longer calls
//     registerSchemeTools/registerVocabTools directly (pinned by a source
//     scan in the test suite), so the tripwire and collision checks cannot be
//     bypassed for module tools.
//  4. Capability modules only — nothing here declares (or could smuggle) a
//     governance posture; the registry refuses that posture at construction
//     anyway.

import type { GuardSettings } from "../guard.js";
import { visiblePaths } from "../guard.js";
import {
  ModuleRegistry,
  moduleFromRegistrar,
  type ConfigBinding,
  type ConfigField,
  type ModuleHostCtx,
  type ModuleManifest,
  type ModuleSettings,
  type ToolRegistrar,
  type VaultModule,
} from "../kernel/modules/index.js";
import { makeRegistry, DEFAULT_SCHEMES, validateExcludedRoots, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { validateJdConfig, type JdConfig } from "../kernel/scheme/jd.js";
import type { VocabInstanceSettings } from "../kernel/index.js";
import { registerSchemeTools } from "./tools-scheme.js";
import { registerVocabTools, type VocabSource, type VocabToolsCtx } from "./tools-vocab.js";
import { registerSkillsTools, type SkillsBackend, type SkillsToolsCtx } from "./tools-skills.js";
import { DEFAULT_SKILLS_CONFIG, validateSkillsConfig } from "../kernel/skills/index.js";

// ── manifests (#81: config-host — see
//    docs/superpowers/specs/2026-08-10-config-host-design.md) ──────────────
//
// The scheme module's config PREDATES the module host (it lives at
// `settings.schemes[0].config` / `.excludedRoots`, not
// `settings.modules.scheme.config`) — `schemeBinding` below resolves the
// manifest's flat field keys against that existing shape, per design §3
// ("no data migration in v1"). The vocab module gets a manifest too, but
// deliberately NO `config` block: it has no settings-tab UI today (two
// instances, `{id, provider, root, config}` each — a per-instance dynamic
// form is out of scope for this PR, YAGNI until a real UI need shows up),
// so its manifest is a capability-directory-only subscription. This is the
// real-code instance of "a module with no config fields must still render"
// the renderer/tests are built to handle, not a synthetic test fixture.

const SCHEME_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "expandedAreas",
    label: "Expanded areas",
    help:
      'Comma-separated area bands (e.g. "90-99") that use 5-digit sequential ids instead of category/decimal ids. ' +
      "Leave blank to use the provider default (90-99).",
    type: "csv",
  },
  {
    key: "expandedCategories",
    label: "Expanded categories",
    help:
      'Comma-separated categories (e.g. "27") that use 5-digit flat ids instead of category.decimal ids. Leave ' +
      "blank to use the provider default (27).",
    type: "csv",
  },
  {
    key: "contentDecimalFloor",
    label: "Content-decimal floor",
    help:
      "Lowest two-digit decimal (0-99) a category allocates as content — decimals below it are reserved. Leave " +
      "blank for the default (10).",
    type: "number",
  },
  {
    key: "excludedRoots",
    label: "Excluded roots",
    help:
      "Vault-relative folder prefixes (one per line) whose contents this scheme instance never resolves or lists " +
      "addresses for — territory it does not speak for. The excluded notes themselves are unaffected; every other " +
      "tool still reads, writes and finds them normally. Leave blank for no exclusion.",
    type: "lines",
    caveats: [
      "Matching is case-sensitive — macOS's case-insensitive filesystem does not make \"vault archaeology\" match " +
        '"Vault archaeology".',
    ],
  },
];

/** Splits the manifest's flat merged config back into the JD provider's own
 * namespace plus the instance-level `excludedRoots`, and runs each half's
 * real validator — subsuming `validateJdConfig` per the design (§1's
 * "jd's validateJdConfig becomes the scheme manifest's validate"). Fails
 * loud: an `excludedRoots` value that isn't even an array is reported
 * directly rather than handed to `validateExcludedRoots` (which assumes
 * `string[] | undefined`, not arbitrary `unknown`). */
function validateSchemeManifestConfig(config: Record<string, unknown>): string[] {
  const { excludedRoots, ...jdConfig } = config;
  const problems = [...validateJdConfig(jdConfig)];
  if (excludedRoots !== undefined && !Array.isArray(excludedRoots)) {
    problems.push("excludedRoots must be an array of strings");
  } else {
    problems.push(...validateExcludedRoots(excludedRoots as string[] | undefined).problems);
  }
  return problems;
}

const SCHEME_MANIFEST: ModuleManifest = {
  summary:
    "Scope resolution and address allocation over the configured scheme (Johnny Decimal today): resolve, allocate, " +
    "and check placement. `jd:` addressing in path arguments is kernel-level and stays available even when this " +
    "module is disabled.",
  config: {
    fields: SCHEME_CONFIG_FIELDS,
    validate: validateSchemeManifestConfig,
    // Deliberately no `defaults` here: the fields render BLANK when unset
    // (not pre-filled with the provider default) — the `help` text says
    // what blank means, matching the pre-existing hand-built section's
    // behavior exactly (a UI regression this migration must not introduce).
  },
  directory: {
    tools: [
      {
        name: "obsidian_schemes",
        purpose: "List every configured scheme instance: id, provider, capabilities, effective config, and example addresses.",
        readOnly: true,
        caveats: [
          "A skipped (misconfigured) instance is listed bare — id and `available: false` only, no config or " +
            "problem detail, to avoid leaking why through a side channel.",
        ],
      },
      {
        name: "obsidian_resolve_address",
        purpose: "Resolve a scheme address to its note's path, or a note's path to its address.",
        readOnly: true,
        options: [
          { name: "address", what: "a scheme address to resolve, e.g. \"jd:06.11\"" },
          { name: "path", what: "a vault-relative path to resolve to its address (the reverse direction)" },
        ],
        caveats: [
          'An instance with `excludedRoots` reports `reason: "excluded"` for a path under one of them, rather ' +
            "than the address it would otherwise carry.",
        ],
      },
      {
        name: "obsidian_next_address",
        purpose: "Compute (never reserve) the next free address within a scope.",
        readOnly: true,
        options: [
          { name: "scope", what: 'a scope token in the scheme\'s grammar, e.g. "06", "90-99", "27"' },
          { name: "scheme", what: "which configured instance to use when more than one is configured" },
        ],
        caveats: [
          "Computes only — pair with obsidian_claim_scope to hold the slot; a competing session can compute the " +
            "identical answer.",
          "`allocatable: false` marks a scope that can never allocate (a plain area, an expanded-item, or a " +
            "category folded into an expanded area's band).",
        ],
      },
      {
        name: "obsidian_list_scope",
        purpose: "List a scope's visible members plus its next free address and up to 20 open slots.",
        readOnly: true,
        options: [
          { name: "scope", what: 'a scope token in the scheme\'s grammar, e.g. "06", "90-99", "27"' },
          { name: "scheme", what: "which configured instance to use when more than one is configured" },
        ],
        caveats: [
          "`members` omits notes outside the allowlist or under an excluded root — a slot listed as free may " +
            "already be held by one of them.",
        ],
      },
      {
        name: "obsidian_expected_location",
        purpose: "Report whether a note (or a not-yet-claimed address) is filed where the scheme expects.",
        readOnly: true,
        options: [
          { name: "path", what: "a vault-relative path to check against its own address" },
          { name: "address", what: 'a scheme address to check directly, e.g. "jd:06.11"' },
          { name: "scheme", what: "which configured instance to use for a bare address" },
        ],
        caveats: [
          "`expected_folder` is null when nothing in the vault establishes the container yet — `placed` is then " +
            "also null.",
        ],
      },
    ],
    addressForms: [
      {
        name: "jd:<address>",
        purpose: "Address a note by its scheme address anywhere a path argument is accepted, e.g. `jd:06.11`.",
        caveats: ["Kernel-level like `uid:` — stays available even if this module itself is disabled."],
      },
    ],
  },
};

/** The live `schemes[0]` instance the binding operates on, falling back to
 * `DEFAULT_SCHEMES` (which always has exactly one entry) when `schemes` is
 * missing OR explicitly empty — an empty `schemes: []` must not turn the
 * ALWAYS-RENDERED scheme section's fields into a silent no-op the way an
 * absent instance would have (the old hand-built section simply hid itself
 * when `jdInstance` was falsy; the generic renderer has no such per-instance
 * visibility, so the binding self-heals instead of failing quietly). */
function currentSchemes(settings: unknown): SchemeInstanceConfig[] {
  const s = (settings as { schemes?: SchemeInstanceConfig[] }).schemes;
  return s && s.length > 0 ? s : DEFAULT_SCHEMES;
}

/** Resolves the scheme manifest's flat field keys against the EXISTING
 * settings shape (`settings.schemes[0].config` / `.excludedRoots`) — no new
 * storage, no migration. Non-mutating: `write` always returns a fresh
 * settings object, never touching the one it was handed (the discipline
 * connection-ui's pre-existing `updateJdConfig`/`updateExcludedRoots`
 * already followed for this exact data).
 *
 * Guarded on `provider === "johnny-decimal"`, mirroring the pre-existing
 * hand-built section's own `jdInstance.provider === "johnny-decimal"` check
 * (deleted from connection-ui.ts, re-homed here): today `SchemeInstanceConfig.provider`
 * is a single-value literal type, so a mismatch is unreachable via anything
 * TypeScript lets you construct — but a hand-edited data.json could still
 * carry a foreign provider name, and this manifest's fields are JD-shaped.
 * `read()` reports blank (nothing to show) and `write()` REFUSES (no-op,
 * settings returned unchanged) rather than splicing JD keys into a config
 * namespace a different provider owns — protecting the other provider's
 * config is worth more here than loud-refusal UI plumbing for a case no
 * shipped config can reach; the alternative (silently "fixing" it into a JD
 * instance) would be the exact silent-coercion this PR's own constraint
 * forbids.
 */
const schemeBinding: ConfigBinding = {
  read(settings) {
    const jd = currentSchemes(settings)[0];
    if (!jd || jd.provider !== "johnny-decimal") return {};
    return {
      ...(jd.config ?? {}),
      ...(jd.excludedRoots !== undefined ? { excludedRoots: jd.excludedRoots } : {}),
    };
  },
  write(settings, patch) {
    const schemes = currentSchemes(settings);
    const jd = schemes[0];
    if (!jd || jd.provider !== "johnny-decimal") return settings;
    const { excludedRoots, ...configPatch } = patch;
    const nextConfig: Record<string, unknown> = { ...(jd.config ?? {}) };
    for (const [k, v] of Object.entries(configPatch)) {
      if (v === undefined) delete nextConfig[k];
      else nextConfig[k] = v;
    }
    const nextInstance: SchemeInstanceConfig = { ...jd, config: nextConfig as Partial<JdConfig> };
    if ("excludedRoots" in patch) {
      if (excludedRoots === undefined) delete nextInstance.excludedRoots;
      else nextInstance.excludedRoots = excludedRoots as string[];
    }
    return { ...(settings as object), schemes: [nextInstance, ...schemes.slice(1)] };
  },
};

const VOCAB_MANIFEST: ModuleManifest = {
  summary:
    "Controlled-vocabulary validation and resolution over the configured registries: tags, properties, types, and " +
    "glossary terms. Report-only — nothing here writes to a note.",
  // No `config` block: today's two default instances (registry + glossary,
  // each `{id, provider, root, config}`) have no settings-tab UI at all
  // (see VaultMcpSettings.vocabularies's own doc comment) — a per-instance
  // dynamic form is future work, not this PR's scope. The module still
  // renders fully from its capability directory alone.
  directory: {
    tools: [
      {
        name: "obsidian_vocabularies",
        purpose:
          "Enumerate the configured controlled-vocabulary sources: id, provider, root, capabilities, per-kind " +
          "counts and examples.",
        readOnly: true,
      },
      {
        name: "obsidian_resolve_term",
        purpose: "Resolve a vocabulary token to its canonical entry, or report a note's own vocabulary.",
        readOnly: true,
        options: [
          { name: "token", what: "a tag, property key, type name, or term" },
          { name: "kind", what: "narrow the lookup to tag / property / type / term" },
          { name: "path", what: "report a note's own vocabulary instead of resolving one token" },
          { name: "parse", what: "with `token`: validate only, resolve nothing" },
        ],
        caveats: ["A token with more than one sense refuses to pick, naming every candidate."],
      },
      {
        name: "obsidian_validate_terms",
        purpose: "Check one note's frontmatter against the controlled vocabulary and report findings.",
        readOnly: true,
        options: [{ name: "path", what: "vault-relative note path to validate" }],
        caveats: ["Report-only — findings are returned, never fixed; nothing is written."],
      },
      {
        name: "obsidian_list_vocabulary",
        purpose: "Enumerate the registered vocabulary of one kind, sorted, each entry naming its source.",
        readOnly: true,
        options: [
          { name: "kind", what: "tag / property / type / term" },
          { name: "scope", what: "only entries declared under this vault-relative path prefix" },
        ],
      },
    ],
  },
};

// ── skills module manifest (#82: the vault-skills → vault-mcp fold) ─────────
//
// The FIRST mutating capability module. Its config is a NEW module (no
// ConfigBinding): it lives at `modules.skills.config`, the default location,
// so the manifest's flat field keys map straight through. Fields mirror the
// standalone plugin's settings tab (minus the on-save trigger, which a
// tool-driven module has no use for). The directory documents all SIX tools —
// three read, three mutating — so they render in the config tab + capability
// directory, and the drift checks pin the manifest to what actually registers.
const SKILLS_CONFIG_FIELDS: ConfigField[] = [
  { key: "outputDir", label: "Output plugin directory", type: "text", help: "Where vault_skills_export writes the generated Claude Code plugin (skills/ + agents/). ~ is expanded." },
  { key: "pluginName", label: "Plugin name", type: "text", help: "Claude Code plugin name — also the command/subagent namespace." },
  { key: "typeSource", label: "Type source", type: "select", options: ["frontmatter", "tags"], help: "How a note declares its kind: the `type` frontmatter field, or a kind tag." },
  { key: "tagPrefix", label: "Tag prefix", type: "text", help: "Tags mode: kind tags are #{prefix}skill / #{prefix}agent / … (e.g. agent/ → #agent/skill)." },
  { key: "fieldMode", label: "Frontmatter field mode", type: "select", options: ["prefix", "nested"], help: "How vault-skills fields are namespaced: prefix (bare/prefixed top-level fields) or nested (all under one key)." },
  { key: "fieldPrefix", label: "Field prefix", type: "text", help: "prefix mode: prefixes each field, e.g. vs- → vs-type. Blank ⇒ bare top-level fields (type, parent, …)." },
  { key: "fieldKey", label: "Field key", type: "text", help: "nested mode: nests every field under this one key, e.g. vault-skills." },
  { key: "assetsRoot", label: "Supporting-files tree", type: "text", help: "Root of a parallel filesystem tree of skills' supporting files. Blank ⇒ none. ~ is expanded." },
  { key: "releaseDir", label: "Release repo directory", type: "text", help: "A git checkout vault_skills_release targets. Blank ⇒ release disabled. ~ is expanded." },
];

const SKILLS_MANIFEST: ModuleManifest = {
  summary:
    "Compile the vault's skill / agent / policy / command notes into a Claude Code plugin and materialize it to " +
    "disk. Read tools inspect and preview the compile; the mutating tools export to the configured output dir, " +
    "package a versioned release into a repo, and mark a note's kind in its frontmatter. Mark can never write an " +
    "acceptance field — like every write, it routes through the accept-forbidden guard.",
  config: {
    fields: SKILLS_CONFIG_FIELDS,
    defaults: { ...DEFAULT_SKILLS_CONFIG } as Record<string, unknown>,
    validate: validateSkillsConfig,
  },
  directory: {
    tools: [
      { name: "vault_skills_validate", purpose: "Collect skill/agent/policy/command notes and run the transform without writing; report errors, warnings, and counts.", readOnly: true },
      { name: "vault_skills_tree", purpose: "Return the current agent/skill hierarchy (name, kind, parent, level, owned skills, children).", readOnly: true },
      {
        name: "vault_skills_preview",
        purpose: "Run the transform without writing and diff it against the current export.",
        readOnly: true,
        options: [
          { name: "name", what: "return one entry (by generated name, output path, or source note path) in full" },
          { name: "content", what: "include full compiled content for every entry (large)" },
        ],
      },
      { name: "vault_skills_export", purpose: "Write skills/agents to the configured output dir (then /reload-plugins in Claude Code).", readOnly: false },
      {
        name: "vault_skills_release",
        purpose: "Export the full plugin into a git checkout and stamp a version into .claude-plugin/plugin.json (no commit/tag/push).",
        readOnly: false,
        options: [
          { name: "version", what: "release version (semver, e.g. 1.2.0)" },
          { name: "dir", what: "target repo directory; defaults to the release repo dir from config" },
        ],
      },
      {
        name: "vault_skills_mark",
        purpose: "Mark an existing note skill/agent/policy/command in its frontmatter, honoring the detection + field mode.",
        readOnly: false,
        options: [
          { name: "path", what: "vault-relative path of the note to mark" },
          { name: "type", what: "skill / agent / policy / command" },
          { name: "parent", what: "parent agent basename or [[wikilink]]; omit for root, ignored for commands" },
          { name: "description", what: "written to the note's description field" },
        ],
        caveats: [
          "Routes through the accept-forbidden write guard: it can never introduce or change an accepted / " +
            "accepted-by / accepted-on field, nor set acceptance-status to an accepted value.",
        ],
      },
    ],
  },
};

/** What the mount needs from the live plugin (server.ts supplies the Obsidian
 * adapters; tests supply fakes). The same per-call freshness discipline as
 * the direct registrations it replaces: config the HANDLERS read (allowlist,
 * scheme rows, vocabularies) is a thunk, so those edits land live — but
 * `modules.<id>.enabled` is read once per mount, i.e. per connection, so a
 * module toggle takes effect on the next session connect (exactly what the
 * settings tab says). */
export interface MountDeps {
  getSettings: () => GuardSettings & {
    schemes?: SchemeInstanceConfig[];
    modules?: ModuleSettings;
  };
  /** The `vocabularies` settings array. Absent ⇒ the vocab module's defaults. */
  getVocabularies?: () => VocabInstanceSettings[];
  /** Vault markdown paths, for the scheme module's placement/membership answers. */
  schemeNotes: () => string[];
  /** The vocab module's injected vault reader (obsidianVocabSource live). */
  vocabSource: VocabSource;
  /** The skills module's injected backend (obsidianSkillsBackend live) — the
   * exporter read seam plus the mark write primitive. */
  skillsSource: SkillsBackend;
}

/** The ModuleHostCtx modules receive — deliberately minimal (gate point 2).
 * Exported so the test suite can pin its exact key set: a key added here is a
 * key handed to every module, and must survive the same review this shape
 * did. */
export function mountHost(deps: MountDeps): ModuleHostCtx {
  return {
    getSettings: deps.getSettings,
    visible: (paths: string[]) => visiblePaths(paths, deps.getSettings()),
  };
}

/** The built-in capability modules, adapted without touching their tool
 * layers (module-host adapters doc): scope-provider in its exact
 * `register(server, ctx)` shape, vocab via the documented one-line closure
 * for its injected-source middle parameter.
 *
 * Both `ctxOf` closures deliberately ignore the `host`/`config` parameters
 * and build from `deps` instead: these two modules PRE-DATE the host, so
 * their config rows live in the top-level `schemes`/`vocabularies` settings
 * (not `modules.<id>.config`) and their tool layers filter via their own
 * `getSettings` + guard imports (not `host.visible`) — preserved verbatim so
 * the mount is a pure re-wiring, zero behavior change. A NEW module should
 * do the opposite: read `host`/`config` and use `host.visible`, per the
 * adapters doc. */
export function builtinModules(deps: MountDeps): VaultModule[] {
  return [
    moduleFromRegistrar(
      { id: "scheme", capabilities: ["addressing", "allocation"], enabled: true, manifest: SCHEME_MANIFEST, configBinding: schemeBinding },
      registerSchemeTools,
      () => ({
        registry: () => makeRegistry(deps.getSettings().schemes ?? DEFAULT_SCHEMES),
        notes: deps.schemeNotes,
        getSettings: deps.getSettings,
      }),
    ),
    moduleFromRegistrar(
      { id: "vocab", capabilities: ["vocabulary"], enabled: true, manifest: VOCAB_MANIFEST },
      // The documented closure form for a registrar with an injected middle
      // parameter — `server` is `any` per the adapter contract, so the
      // McpServer-typed signature needs no cast.
      (server: any, ctx: VocabToolsCtx) => registerVocabTools(server, deps.vocabSource, ctx),
      () => ({
        getSettings: deps.getSettings,
        ...(deps.getVocabularies ? { getVocabularies: deps.getVocabularies } : {}),
      }),
    ),
    // The skills module (#82): the first MUTATING capability module. It
    // declares `mutating: true`, which the mount gate honors to let its three
    // write tools (export / release / mark) register with `readOnlyHint:
    // false` — still through the guard-patched registrar (read-only mode,
    // allowlist, queue, journal) and, for mark, the accept-forbidden write
    // guard. Default DISABLED: a newly-folded mutating surface stays off until
    // a human turns it on in the config tab (this is acceptance-adjacent —
    // flagged for review). Config lives at `modules.skills.config` (a new
    // module, no ConfigBinding), so `config` here is that record merged over
    // the manifest defaults.
    moduleFromRegistrar(
      { id: "skills", capabilities: ["compile", "export", "authoring"], enabled: false, mutating: true, manifest: SKILLS_MANIFEST },
      (server: any, ctx: SkillsToolsCtx) => registerSkillsTools(server, deps.skillsSource, ctx),
      (_host, config) => ({ config, getSettings: deps.getSettings }),
    ),
  ];
}

/**
 * Mount the built-in modules through a fresh ModuleRegistry and register the
 * enabled ones' tools via `registerTool` — which, from server.ts, is the
 * PATCHED `server.registerTool`, so every module tool lands at the same
 * guard/queue/journal interception point as every hand-registered tool
 * (kernel args declared, allowlist enforced, Code Mode captured alike).
 *
 * The registrar handed to the registry additionally REFUSES any module tool
 * whose annotations are not explicitly read-only (gate point 1): the two v1
 * modules are read-only by design, and a module that stops being so must
 * fail this mount loudly and re-earn it through review, not drift in.
 * Refusals land in `problems` (and the tool is not registered) — the
 * registry's own skip-and-report discipline.
 *
 * Returns the registry so the caller (settings UI, diagnostics) can read
 * `describe()` and `problems`.
 */
export function mountModules(registerTool: ToolRegistrar, deps: MountDeps): ModuleRegistry {
  const modules = builtinModules(deps);
  const registry = new ModuleRegistry(modules, deps.getSettings().modules ?? {});
  // The modules that have EARNED the right to contribute mutating tools (the
  // skills module today), by declaring `mutating` — see VaultModule.mutating.
  // Every other module is still held to read-only, so a mutating handler
  // cannot drift into a read-only module unreviewed.
  const mutatingModules = new Set(modules.filter((m) => m.mutating).map((m) => m.id));
  registry.registerAll(registerTool, mountHost(deps), {
    // The read-only-only rule rides registerAll's gate so a refused tool is
    // never recorded as contributed and never reserves its name — describe()
    // stays truthful and a later, legitimate same-name registration is not
    // blackholed by a refusal. A module that declares `mutating` is exempt (its
    // write tools still go through the guard-patched registrar and, for a
    // frontmatter write, the accept-forbidden guard).
    gate: (name, def, moduleId) =>
      def?.annotations?.readOnlyHint === true || mutatingModules.has(moduleId)
        ? null
        : `not explicitly read-only — a read-only capability module (readOnlyHint: true) may not contribute a ` +
          `mutating tool; a module needs to declare \`mutating\` (accept-reachability review) to do so`,
  });
  return registry;
}
