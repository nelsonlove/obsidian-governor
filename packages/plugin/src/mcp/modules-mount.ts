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
//  1. HANDLER reachability: every tool a module contributes is
//     `readOnlyHint: true` UNLESS the module itself declares `mutating: true`
//     — a read-only registration cannot reach the write queue, the write
//     primitive, or the accept-guard's territory at all (the guard routes
//     ONLY `readOnlyHint === false` calls to the kernel's mutation path).
//     `mutating: true` is a real, deliberate escape hatch (three modules use
//     it today: provenance, fileclass, jd-scaffold), not a bypass of this gate
//     — a module that does NOT declare it still gets the
//     original all-read-only enforcement. Pinned by test: the mount's
//     registerAll gate refuses a non-mutating module's tool whose
//     annotations are not read-only (see `mountModules`), so a future module
//     slipping a mutating handler in without the declaration fails loudly (a
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
import { makeRegistry, DEFAULT_SCHEMES, validateExcludedRoots, excludeRoots, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { validateJdConfig, type JdConfig } from "../kernel/scheme/jd.js";
import type { VocabInstanceSettings } from "../kernel/index.js";
import { registerSchemeTools } from "./tools-scheme.js";
import { registerVocabTools, type VocabSource, type VocabToolsCtx } from "./tools-vocab.js";
import { registerProvenanceTools, type ProvenanceToolsCtx } from "./tools-provenance.js";
import { DEFAULT_PROVENANCE_CONFIG, validateProvenanceConfig, DEFAULT_NOTES_DIR, DEFAULT_AUDIT_NOTE, type ProvenanceBackend } from "../kernel/provenance/index.js";
import { registerHealthTools, type HealthToolsCtx } from "./tools-health.js";
import { DEFAULT_HEALTH_CONFIG, validateHealthConfig, DEFAULT_EMPTY_CHARS, type HealthSource } from "../kernel/health/index.js";
import { registerFileclassTools, type FileclassToolsCtx } from "./tools-fileclass.js";
import { DEFAULT_GOVERNANCE_SETTINGS, DEFAULT_ACCEPTANCE_SETTINGS } from "../governor/kernel/settings.js";
import { registerBasesTools, emptyBasesSource, type BasesSource, type BasesToolsCtx } from "./tools-bases.js";
import { registerJdScaffoldTools, emptyJdScaffoldSource, type JdScaffoldSource, type JdScaffoldToolsCtx } from "./tools-jd-scaffold.js";
import { DEFAULT_BASES_CONFIG, validateBasesConfig } from "../kernel/bases/index.js";

// ── manifests (#81: config-host — see
//    docs/superpowers/specs/2026-08-10-config-host-design.md) ──────────────
//
// The scheme module's config PREDATES the module host (it lives at
// `settings.schemes[0].config` / `.excludedRoots`, not
// `settings.modules.scheme.config`) — `schemeBinding` below resolves the
// manifest's flat field keys against that existing shape, per design §3
// ("no data migration in v1"). The vocab module gets a manifest too, but
// deliberately NO manifest `config` block: its settings are a LIST of
// structured instances (`settings.vocabularies`, `{id, provider, root,
// config}` each), which the scalar manifest-field renderer cannot express.
// Its per-instance settings UI is instead a BESPOKE form in connection-ui's
// vocab section (`renderVocabInstances`) — like the top-level allowlist/deny
// textareas — writing straight to `settings.vocabularies` (read
// per-connection by the vocab tool layer's `getVocabularies` thunk). The
// manifest stays a capability-directory-only subscription, so this is also
// the real-code instance of "a module with no config fields must still
// render" the renderer/tests are built to handle.

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
    "validate a filename, and check placement. `jd:` addressing in path arguments is kernel-level and stays " +
    "available even when this module is disabled.",
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
        name: "obsidian_validate_name",
        purpose:
          "Validate a single filename against the scheme grammar: malformed address token, a colon in the name, or " +
          "trailing whitespace.",
        readOnly: true,
        options: [
          { name: "name", what: 'a filename or basename to check, e.g. "06.11 Vault MCP.md"' },
          { name: "scheme", what: "which configured instance's grammar to check against when more than one is configured" },
        ],
        caveats: [
          "Pure grammar check — reads nothing from the vault and needs no allowlist; validates ONE name, not the " +
            "whole vault (whole-vault scheme conformance is the rail's job).",
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
  // No manifest `config` block: the vocab settings are a LIST of structured
  // instances (registry + glossary, each `{id, provider, root, config}`),
  // which the scalar manifest-field renderer cannot express. The per-instance
  // settings UI now ships as a BESPOKE form in connection-ui's vocab section
  // (`renderVocabInstances`) — id / provider / root / config editors plus
  // add- and remove-instance controls, writing straight to
  // `settings.vocabularies`. The module still renders its enable toggle +
  // capability directory generically from this manifest; the bespoke form is
  // appended to that section for this one module.
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

// ── provenance module manifest (the obsidian-provenance CLI fold) ──────────
//
// The second mutating capability module (after skills, which left for its own
// plugin at the S4 satellite extraction). Ported from the
// standalone `obsidian-provenance` Python CLI. Its config is a NEW module (no
// ConfigBinding): it lives at `modules.provenance.config`, so the manifest's
// flat field keys map straight through. One field today — the plugin-notes
// directory the reconcile/regen audit scans, defaulting to the Python
// `DEFAULT_NOTES_DIR`. The directory documents all THREE tools: two read
// (check / reconcile) and one mutating (regen).
//
// DERIVATION ≠ ACCEPTANCE: the module stamps `derived-from` / `generated` /
// `generator` / `derivation-mode` — plus the `derived-source-count` witness that
// lets a later freshness check see DELETED sources — on the audit note it
// regenerates: provenance metadata, orthogonal to acceptance. `provenance_regen`'s write routes through
// the accept-forbidden guard like every write; it contributes no accept verb.
const PROVENANCE_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "notesDir",
    label: "Plugin-notes root",
    type: "text",
    help:
      "Vault-relative folder holding the per-plugin notes the audit reconciles against installed/enabled plugins. " +
      `Blank ⇒ the default (${DEFAULT_NOTES_DIR}).`,
  },
  {
    key: "notesSource",
    label: "Notes layout",
    type: "text",
    help:
      '"jd-slots" (default) — one JD slot per repo under the root, the folder note carrying `github-repo:`. ' +
      '"flat" — one note per plugin directly in the root, each carrying `plugin.id`. ' +
      "An explicit `plugin.id` is authoritative in both layouts; slot matching is deliberately strict and " +
      "reports what it cannot place rather than guessing.",
  },
  {
    key: "auditNote",
    label: "Audit note path",
    type: "text",
    help:
      "Vault-relative path of the audit note itself — a NOTE path including the .md filename, not a folder. " +
      `Blank ⇒ ${DEFAULT_AUDIT_NOTE} in jd-slots mode; in FLAT mode blank derives the name from the notes root instead. ` +
      "It is a path rather than a folder because naming a note " +
      "after its folder is the JD folder-note convention: derived from a slot root it would resolve onto that " +
      "folder's own note and rewrite it.",
  },
];

const PROVENANCE_MANIFEST: ModuleManifest = {
  summary:
    "Derived-content provenance, ported from the obsidian-provenance CLI: check whether a note's `derived-from` " +
    "sources changed after it was `generated` (freshness), audit installed vs enabled vs noted Obsidian plugins, and " +
    "regenerate the plugin-audit note. Stamps DERIVATION metadata only (derived-from / generated / generator / " +
    "derivation-mode / derived-source-count) — orthogonal to acceptance; regen's write can never set an acceptance field, routing through " +
    "the accept-forbidden guard like every write.",
  config: {
    fields: PROVENANCE_CONFIG_FIELDS,
    defaults: { ...DEFAULT_PROVENANCE_CONFIG } as Record<string, unknown>,
    validate: validateProvenanceConfig,
  },
  directory: {
    tools: [
      {
        name: "provenance_check",
        purpose: "Report whether a derived note is FRESH or STALE against its own `derived-from:` sources.",
        readOnly: true,
        options: [{ name: "path", what: "vault-relative path of the derived note to check" }],
        caveats: [
          "A source file modified after the note's `generated:` timestamp marks it stale; a missing `derived-from` is an error.",
          "Deletions: a NON-GLOB entry that no longer resolves is always reported (`missing`); deletions inside a GLOB " +
            "entry are seen only when the note stamps the optional `derived-source-count:` witness (a lower count now ⇒ " +
            "`sourcesRemoved`). Without it the result carries `globDeletionsUndetectable: true` rather than implying a clean check.",
        ],
      },
      {
        name: "provenance_reconcile",
        purpose:
          "Compare installed, enabled, and noted Obsidian plugins and report unnoted plugins and note-vs-manifest version drift.",
        readOnly: true,
        caveats: ["Reads .obsidian/plugins/*/manifest.json + .obsidian/community-plugins.json + the configured notes dir; runs over the whole notes dir (not allowlist-scoped)."],
      },
      {
        name: "provenance_regen",
        purpose: "Regenerate the plugin-audit note's text, preserving hand-written `<!-- human:start … -->` sections.",
        readOnly: false,
        options: [{ name: "write", what: "persist the regenerated audit note; omitted/false ⇒ dry-run (return text, write nothing)" }],
        caveats: [
          "DRY-RUN by default. The write routes through the accept-forbidden guard and the guard-patched registrar " +
            "(queue, journal): it stamps DERIVATION metadata only and can never introduce or change an accepted / " +
            "accepted-by / accepted-on field, nor set acceptance-status to an accepted value.",
        ],
      },
    ],
  },
};

// ── health module manifest (the obsidian-vault-health scanner fold) ────────
//
// A READ-ONLY capability module (unlike provenance, which is mutating).
// Ported from the standalone `obsidian-vault-health` Bash+eval scanner. It emits
// tiered findings and NEVER mutates — the fixing is a separate skill, out of
// scope — so both its tools register `readOnlyHint: true`, it declares NO
// `mutating` flag, and it needs no ConfigBinding: config lives at
// `modules.health.config`, so the manifest's flat field keys map straight
// through. One field today — the empty-note char threshold (the Python
// `VAULT_HEALTH_EMPTY_CHARS`, default 40). The directory documents both tools.
//
// Default DISABLED (opt-in): a newly-folded scan surface stays off until a human
// turns it on in the config tab.
const HEALTH_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "emptyChars",
    label: "Empty-note character threshold",
    type: "number",
    help:
      "Body characters (frontmatter excluded) at/under which a note is reported as empty / near-empty. Also the floor " +
      `below which identical stubs are skipped from duplicate grouping. Blank ⇒ the default (${DEFAULT_EMPTY_CHARS}).`,
  },
];

const HEALTH_MANIFEST: ModuleManifest = {
  summary:
    "Vault health scan, ported from the obsidian-vault-health scanner: report maintenance issues TIERED BY FIX RISK — " +
    "auto-safe (broken links that uniquely resolve to one existing note), approval-gated (empty / near-empty notes; " +
    "orphan attachments), and report-only (dangling links, duplicate note groups, low-signal tags). READ-ONLY — it " +
    "only emits findings and never mutates the vault; the fixing is a separate skill.",
  config: {
    fields: HEALTH_CONFIG_FIELDS,
    defaults: { ...DEFAULT_HEALTH_CONFIG } as Record<string, unknown>,
    validate: validateHealthConfig,
  },
  directory: {
    tools: [
      {
        name: "obsidian_health",
        purpose: "Full tiered vault health scan → structured findings (auto-safe / approval-gated / report-only) plus summary counts.",
        readOnly: true,
        caveats: [
          "Auto-safe repointable links: a unique-basename match is NOT proof a link should be repointed — a " +
            "`[[core.el]]`-style reference in a vendored / knowledge-base / template tree can coincidentally match an " +
            "unrelated note. Scope auto-safe repoints to authored areas.",
          "Orphan attachments include files referenced ONLY via frontmatter or CSS (those references are not in " +
            "Obsidian's resolvedLinks). Verify before trashing, and protect sensitive trees.",
          "Runs over the whole vault (not allowlist-scoped) — a partial health report would misreport orphans and " +
            "duplicates.",
        ],
      },
      {
        name: "obsidian_lint",
        purpose: "The same health scan restricted to one folder or note.",
        readOnly: true,
        options: [{ name: "scope", what: 'a vault-relative folder or note path to restrict findings to, e.g. "Projects"' }],
        caveats: [
          "Link resolution and the orphan inbound-set are still computed vault-wide, so an attachment referenced from " +
            "outside the scope is correctly not reported as orphaned.",
          "Low-signal tags are omitted from a scoped lint (tags are vault-wide and cannot be attributed to a folder).",
        ],
      },
    ],
  },
};

// ── fileclass module manifest (#188: the fileclass CLI fold) ───────────────
//
// A MUTATING capability module that proxies the standalone `fileclass` CLI
// (github.com/mdelobelle/fileclass-cli — the terminal for the Fileclass
// typed-frontmatter plugin). Unlike provenance, its tools mount ONLY when
// the Fileclass plugin is LOADED and the CLI binary is present — the module's
// registrar (registerFileclassTools) gates on both and registers nothing when
// either is absent, so it degrades cleanly to absent (issue #188). It shells out
// to the CLI via execFile, the obsidian_cli proxy precedent — see
// tools-fileclass.ts's header for why proxy over engine-integration.
//
// Six read tools (readOnlyHint: true) and two write tools (readOnlyHint: false):
// fileclass_set / fileclass_set_where write typed frontmatter, so they route
// through the accept-forbidden guard (a field-write can never assert acceptance)
// and the guard-patched registrar (read-only mode, queue, journal, if_rev,
// path allowlist). set-where is DRY-RUN by default. Default DISABLED (opt-in),
// consistent with provenance/health — a newly-folded surface stays off
// until a human turns it on in the config tab.
//
// One config field: an explicit `binaryPath` override for the `fileclass` CLI
// (blank ⇒ auto-detect on the standard install paths). The vault is pinned to
// THIS vault by the tool layer (`--vault <name>`), so there is deliberately no
// vault-targeting config field — a session can never cross into another vault.
const FILECLASS_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "binaryPath",
    label: "fileclass CLI path",
    type: "text",
    help:
      "Absolute path to the `fileclass` CLI binary. Blank ⇒ auto-detect on the standard install paths " +
      "(/usr/local/bin, /opt/homebrew/bin, ~/.local/bin, ~/.npm-global/bin, /usr/bin). The tools mount only when " +
      "BOTH the Fileclass plugin is installed+enabled AND this binary is found.",
  },
];

export const DEFAULT_FILECLASS_CONFIG: Record<string, unknown> = { binaryPath: "" };

/** Validate the fileclass module config: `binaryPath`, when present, must be a
 * string. (An empty string is the documented "auto-detect" value.) */
export function validateFileclassConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (config.binaryPath !== undefined && typeof config.binaryPath !== "string") {
    problems.push("binaryPath must be a string (an absolute path, or blank to auto-detect)");
  }
  return problems;
}

const FILECLASS_MANIFEST: ModuleManifest = {
  summary:
    "Typed-frontmatter (fileClass) reads and validated writes, proxied from the standalone `fileclass` CLI (the " +
    "terminal for the Fileclass plugin). Read tools list fileClasses, dump a schema, explain a note's fields, query " +
    "rows, get a value, and validate schema violations; the two write tools set a validated field on one note or " +
    "bulk-set across a fileClass (DRY-RUN by default, apply: true to commit). MOUNTS ONLY when the Fileclass plugin " +
    "is installed+enabled and the `fileclass` CLI binary is present — absent either, the tools do not register. " +
    "Writes route through the accept-forbidden guard: a field-write can never introduce or change an accepted / " +
    "accepted-by / accepted-on field, nor set acceptance-status to an accepted value.",
  config: {
    fields: FILECLASS_CONFIG_FIELDS,
    defaults: { ...DEFAULT_FILECLASS_CONFIG },
    validate: validateFileclassConfig,
  },
  directory: {
    tools: [
      { name: "fileclass_list", purpose: "List every fileClass (name, extends, field count, has-Base).", readOnly: true },
      {
        name: "fileclass_schema",
        purpose: "A fileClass's options and resolved fields, with ancestry from extends.",
        readOnly: true,
        options: [{ name: "fileclass", what: "the fileClass name, e.g. 'Book'" }],
      },
      {
        name: "fileclass_explain",
        purpose: "A note's fileClasses, ancestry, and resolved field values.",
        readOnly: true,
        options: [{ name: "path", what: "vault-relative note path" }],
      },
      {
        name: "fileclass_query",
        purpose: "Rows for a fileClass, optionally filtered / columned / limited.",
        readOnly: true,
        options: [
          { name: "fileclass", what: "the fileClass name" },
          { name: "where", what: "a filter expression, e.g. 'status is unread'" },
          { name: "columns", what: "comma-separated columns, e.g. 'title,author'" },
          { name: "limit", what: "maximum rows to return" },
        ],
      },
      {
        name: "fileclass_get",
        purpose: "One field's value on a note.",
        readOnly: true,
        options: [
          { name: "path", what: "vault-relative note path" },
          { name: "field", what: "the field name" },
        ],
      },
      {
        name: "fileclass_validate",
        purpose: "Report schema violations across the vault or one fileClass (exit 1 = violations, returned not errored).",
        readOnly: true,
        options: [{ name: "fileclass", what: "restrict validation to one fileClass" }],
      },
      {
        name: "fileclass_set",
        purpose: "Write one validated field value on a note (the engine validates before writing).",
        readOnly: false,
        options: [
          { name: "path", what: "vault-relative note path" },
          { name: "field", what: "the field name" },
          { name: "value", what: "the value to set" },
        ],
        caveats: [
          "Routes through the accept-forbidden write guard: it can never introduce or change an accepted / " +
            "accepted-by / accepted-on field, nor set acceptance-status to an accepted value.",
        ],
      },
      {
        name: "fileclass_set_where",
        purpose: "Bulk-set a validated field on every matching note of a fileClass. DRY-RUN by default.",
        readOnly: false,
        options: [
          { name: "fileclass", what: "the fileClass name" },
          { name: "field", what: "the field name" },
          { name: "value", what: "the value to set" },
          { name: "where", what: "a filter expression, e.g. 'status isEmpty'" },
          { name: "apply", what: "commit the change; omit/false ⇒ dry-run (report only, write nothing)" },
        ],
        caveats: [
          "DRY-RUN by default — writes nothing until apply: true.",
          "Routes through the accept-forbidden write guard like fileclass_set.",
        ],
      },
    ],
  },
};

// ── acceptance module manifest (#83, cycle 2: the accept gesture + pane) ─────────────
//
// Module id `acceptance` since 0.12.0 (historically `governance` — the source dirs
// src/governor/wiring/ + src/governor/kernel/ and the shipped governance_* tool names keep
// the old word; the settings key migrated via migrateLegacyModuleIds).
//
// The acceptance module's enabled-flag gates the Obsidian REVIEW PANE — the human-only
// Accept / Revert / Adopt / auto-accept-allowlist surface (src/governor/wiring/{pane,wiring}.ts,
// wired in main.ts, NOT here). It contributes ZERO tools to the MCP transport: the accept
// gesture never touches the bridge. The one MCP read surface — obsidian_pending_review — is
// registered ALWAYS-ON and read-only in server.ts, DECOUPLED from this toggle (cycle 2 fixed
// the cycle-1 regression that gated the read surface behind this default-off module). So an
// agent can always SEE the pending queue; only a human at the pane can accept. #101 adds ONE
// agent verb — governance_submit_revision — likewise registered always-on in server.ts (an
// ordinary guarded MUTATING tool, never through this module): it resubmits a revising note as
// `proposed`, and it cannot accept anything.
//
// Posture is "capability", NOT "governance": the ModuleRegistry deliberately REFUSES the
// "governance" posture in v1 (it is inert). This module clears that gate by contributing NO
// MCP tools at all — its register() is a no-op on the transport — so it mounts as an ordinary
// (empty) capability module, subject to the same read-only-only registrar gate, the
// accept/baseline-name tripwire, and collision checks as every other module. It ships DISABLED:
// the whole accept pane is opt-in; a human turns it on in the config tab. Because the module
// contributes nothing to MCP, the tripwire's "no accept-shaped tool reaches the surface" holds
// trivially — the accept path lives entirely behind gesture-gated pane buttons.
//
// The config fields below are the accept pane's ONLY MCP-side knobs — display prefs and
// acceptance-convergence parameters, not accept capabilities. They live at
// `modules.acceptance.config.*`, the exact keys the pane wiring reads through
// `governanceDisplaySettings` / `governanceAcceptanceSettings` (governor/kernel/settings.ts):
// the two pending-count badges (default ON), the `acceptedBy` identity the human's own Accept
// gesture stamps into a `proposed` note (#221/#164 convergence — settings are human-only by
// construction, so the identity is human-set), and the OPTIONAL `requiredFrontmatterKeys`
// conformance gate (default EMPTY = no gate; when set, Accept on a `proposed` note REFUSES —
// no stamp, no baseline advance — while any listed key is missing/empty; this is where the
// legacy QuickAdd accept-macro's vault-specific uid/title/description checks live now, as
// per-vault config rather than plugin hardcode). None of these confers accept/revert/adopt
// capability — `acceptedBy` only labels the human's own gesture and `requiredFrontmatterKeys`
// can only make Accept refuse MORE; the human-only accept controls remain gesture-gated pane
// buttons, never settings.
const ACCEPTANCE_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "showRibbonBadge",
    label: "Ribbon pending-count badge",
    type: "toggle",
    help:
      "Show the pending-review count as a badge on the acceptance ribbon icon. Off ⇒ the ribbon icon still " +
      "opens the pane, just without the count badge. Takes effect on the next queue refresh (the badge prefs " +
      "are read live).",
  },
  {
    key: "showViewTabBadge",
    label: "Pane tab pending-count badge",
    type: "toggle",
    help:
      "Show the pending-review count as a badge overlaid on the review pane's tab-header icon. Off ⇒ no tab " +
      "badge; the ribbon badge above is independent. Takes effect on the next queue refresh (the badge prefs " +
      "are read live).",
  },
  {
    key: "acceptedBy",
    label: "Accepted-by identity",
    type: "text",
    placeholder: DEFAULT_ACCEPTANCE_SETTINGS.acceptedBy,
    help:
      "The identity the pane's Accept stamps as `accepted-by` (and records in the acceptance log) when " +
      "accepting a note whose frontmatter is `acceptance-status: proposed`. Human-set by construction — " +
      "this settings tab is not agent-reachable, and agent transports can never write the accepted family.",
  },
  {
    key: "gateMode",
    label: "Conformance-gate response",
    type: "select",
    options: ["soft", "hard", "off"],
    help:
      "How Accept responds when a `proposed` note is missing required frontmatter (below). `soft` (default): " +
      "a modal offers Accept anyway / Open note / Cancel — the override is a second explicit human click. " +
      "`hard`: refuse with a notice (fix, then accept). `off`: the gate is not checked at all. Never an agent " +
      "surface — agents cannot reach Accept in any mode.",
  },
  {
    key: "requiredFrontmatterKeys",
    label: "Required frontmatter for acceptance",
    type: "csv",
    placeholder: "uid, title, description",
    help:
      "Optional conformance gate: comma-separated frontmatter keys that must be present and non-empty " +
      "before a `proposed` note can be Accepted. While any listed key is missing, Accept refuses with no " +
      "partial write (no stamp AND no baseline advance). Empty (the default) ⇒ no gate. The legacy QuickAdd " +
      "accept-macro's vault-specific checks (uuid7 uid, title, description) map onto this setting.",
  },
];

const ACCEPTANCE_MANIFEST: ModuleManifest = {
  summary:
    "Acceptance: the human-only review pane. When enabled, the plugin registers an Obsidian " +
    "review pane where a human reviews agent changes and Accepts / Reverts / Requests changes / Adopts a " +
    "baseline, plus a Proposed section (the context-aware Accept: accepting a proposed note also stamps " +
    "the accepted family into its frontmatter — the ONE accept across both lifecycles), a Revising section " +
    "(withdraw a revision request) and — pre-cutover only — an auto-accept allowlist for " +
    "provably-mechanical changes (retired with the legacy era; the per-note policies are deleted, WP10c). Every state-changing control is a real-click gesture in the pane — never " +
    "a command, never an MCP tool, never a method on any object reachable from `app`. This module " +
    "contributes ZERO tools to the MCP transport: the read-only obsidian_pending_review view and the " +
    "guarded governance_submit_revision resubmit verb (which can never accept) are registered always-on in " +
    "server.ts, independent of this toggle. Ships disabled — a human enables the accept pane here.",
  // The `config` block ships the two badge-DISPLAY toggles plus the two acceptance-convergence
  // fields (ACCEPTANCE_CONFIG_FIELDS) — the accept
  // pane's only MCP-side knobs, read at pane-wire time from `modules.acceptance.config` (no
  // ConfigBinding — the default location, exactly where the pane wiring reads them). They confer
  // NO accept capability. The auto-accept ALLOWLIST and adopt-baseline are NOT
  // manifest config fields (they are not scalar knobs) — they are gesture-gated, human-only-mutable
  // controls the acceptance module RENDERS itself, into BOTH the review pane and the settings tab
  // (connection-ui.ts calls the module's renderGovernanceSettings, which builds them from its own
  // module-private accept-capable controller — never surfaced as data here).
  config: {
    fields: ACCEPTANCE_CONFIG_FIELDS,
    defaults: { ...DEFAULT_GOVERNANCE_SETTINGS, ...DEFAULT_ACCEPTANCE_SETTINGS } as Record<string, unknown>,
  },
  //
  // The directory is deliberately EMPTY — the module adds no MCP tool, address form, rule pack, or
  // kernel arg. The capability it provides (the review pane) is an Obsidian UI surface, described
  // in the summary, not an MCP capability. An empty directory renders a section with no tool rows.
  directory: {
    tools: [],
  },
};

// ── bases module manifest (#243: evaluated Base rows for agents) ────────────
//
// A READ-ONLY capability module (like health): both tools readOnlyHint: true,
// no `mutating` flag, no write path anywhere. Unlike health it ships DEFAULT
// ENABLED — it is a pure read surface over content the session could already
// read note-by-note (the scheme/vocab precedent for read-only default-on),
// and its rows are allowlist-filtered like every other read. Feature-gated
// like fileclass: the registrar registers NOTHING when the running Obsidian
// lacks the public Bases API (pre-1.10), so an enabled module on an old
// Obsidian is absent, not broken. Config lives at `modules.bases.config`
// (a new module, no ConfigBinding).
const BASES_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "queryTimeoutMs",
    label: "Query timeout (ms)",
    type: "number",
    help:
      "Hard deadline for one base_query evaluation. The Bases engine's scan is heavily throttled while the " +
      "Obsidian window is hidden, so slow answers are normal in the background — expiry refuses with a typed, " +
      `retryable base_timeout. Blank ⇒ the default (${DEFAULT_BASES_CONFIG.queryTimeoutMs}).`,
  },
  {
    key: "rowCap",
    label: "Row cap",
    type: "number",
    help:
      "Maximum rows one base_query returns (the tool's `limit` argument clamps to this). Blank ⇒ the default " +
      `(${DEFAULT_BASES_CONFIG.rowCap}).`,
  },
];

const BASES_MANIFEST: ModuleManifest = {
  summary:
    "Evaluated Base result sets for agents: enumerate the vault's `.base` files and their declared views, and " +
    "evaluate a view — Obsidian's own Bases engine computes the rows (base + view filters, formulas, sort) in a " +
    "hidden background leaf that is detached whatever happens; this module never parses the Bases expression " +
    "language and never writes anything. Registers only when the running Obsidian exposes the public Bases API " +
    "(1.10+); queries are serialized (one capture at a time) and time-boxed with a typed base_timeout refusal.",
  config: {
    fields: BASES_CONFIG_FIELDS,
    defaults: { ...DEFAULT_BASES_CONFIG } as Record<string, unknown>,
    validate: validateBasesConfig,
  },
  directory: {
    tools: [
      {
        name: "base_list",
        purpose: "Enumerate every visible `.base` file with its declared views (name, type, column count).",
        readOnly: true,
        caveats: ["A base outside the path allowlist is invisible — absent from the answer, not refused."],
      },
      {
        name: "base_query",
        purpose:
          "Evaluate one declared view of a `.base` file via the engine and return its rows: note path + the view's " +
          "columns' values.",
        readOnly: true,
        options: [
          { name: "path", what: 'vault-relative `.base` path, e.g. "Views/Tasks.base"' },
          { name: "view", what: "declared view name (default: the file's first view)" },
          { name: "limit", what: "maximum rows to return (clamped to the module's rowCap)" },
        ],
        caveats: [
          "Full engine fidelity — Obsidian computes filters/formulas/sort; nothing is re-implemented — but the " +
            "scan is throttled while the window is hidden, so a busy vault can take tens of seconds (typed " +
            "base_timeout on expiry, retryable).",
          "Rows for notes outside the path allowlist are dropped silently; the response then carries " +
            "`some_rows_hidden: true` (a boolean, never a count).",
          "Residual under an allowlist, inherent to \"Obsidian computes\" (the check_links resolution-oracle " +
            "class): the engine evaluates over the WHOLE vault before rows are filtered, so a formula value on a " +
            "visible row can be computed from hidden notes, and a view's own `limit` consumes slots on hidden " +
            "rows — visible rows past that limit silently never appear.",
        ],
      },
    ],
  },
};

// jd-scaffold, Stage A + Stage A2 + Stage A3 of the jd-dashboard fold
// (docs/superpowers/specs/2026-08-19-jd-dashboard-fold-design.md): seven
// mutating tools ported from obsidian-jd-dashboard's standard-zeros.ts,
// promote-to-folder.ts, category-index.ts, and templates.ts/
// new-from-template.ts. No config fields yet — templates_folder is an
// explicit argument on each of the three template-creation tools instead of
// a module-level setting (agents pass it per call; a human UI would want a
// setting, but nothing here needs one yet), so jd-scaffold still has no
// per-vault knobs at the MODULE level (unlike scheme's prefix/area config).
const JD_SCAFFOLD_MANIFEST: ModuleManifest = {
  summary:
    "Johnny Decimal category scaffolding, ported from obsidian-jd-dashboard: create the fixed standard-zeros set " +
    "(XX.00-XX.09) in a category, self-heal a vault-wide missing XX.00, promote a leaf id note into a " +
    "same-named folder, rebuild an XX.00 index file's Contents section from vault truth, and create standard-" +
    "zero/generic-id/stem notes from templates classified by their own jd-id frontmatter. This module never " +
    "SYNTHESIZES jd-id: frontmatter itself (standard-zeros' own notes carry none — vault-mcp's scheme module is " +
    "path-canonical, the filename already carries the address, same call already made for the jd-numbering " +
    "fold); a template-created note's frontmatter is whatever the user's own template file contains, copied " +
    "through substitution like every other placeholder in the file.",
  directory: {
    tools: [
      {
        name: "obsidian_jd_standard_zeros",
        purpose:
          "Create the fixed 10-note standard-zeros set (JDex, Inbox, Task & project management, Templates, " +
          "Links, Conventions & policies, Knowledge base, Dashboard, Someday, Archive) inside a category folder.",
        readOnly: false,
        options: [
          { name: "folder_path", what: "vault path of the category folder" },
          { name: "prefix", what: "the category's two-digit prefix" },
        ],
        caveats: ["An already-existing target is SKIPPED, never overwritten — safe to re-run."],
      },
      {
        name: "obsidian_jd_ensure_category_indexes",
        purpose:
          "Vault-wide: walk every depth-2 `XX <name>` category folder and create a minimal `XX.00` JDex index for " +
          "any that lack one.",
        readOnly: false,
        caveats: ["Accepts `XX.00 Title.md`, `XX.00.md`, or `XX.00+SUF Title.md` as already-present."],
      },
      {
        name: "obsidian_jd_promote_to_folder",
        purpose:
          "Convert an XX.YY (or 5-digit expanded-area id) note into a same-named folder with the note moved " +
          "inside as the folder's cover note, via link-healing rename.",
        readOnly: false,
        options: [{ name: "path", what: "vault path of the note to promote" }],
        caveats: ["Refuses (not_id_note / already_cover_note / folder_exists) rather than guessing."],
      },
      {
        name: "obsidian_jd_reindex_category",
        purpose:
          "Rebuild an XX.00 index file's `## Contents` section from vault truth (not jd-index.yaml), at whichever " +
          "of the three tiers its own prefix dispatches to (ordinary per-category / area-management / system).",
        readOnly: false,
        options: [{ name: "path", what: "vault path of the XX.00 index file to reindex" }],
        caveats: [
          "Descriptions written as `[[link]] *(note)*` are preserved across every regen, at every tier.",
          "Area-management and system tiers read every sibling XX.00 file's current content to consolidate them; " +
            "the ordinary tier reads only the target's own content.",
        ],
      },
      {
        name: "obsidian_jd_new_standard_zero",
        purpose: "Create a single standard-zero note (e.g. the `06.01 Inbox` slot) from a template classified `jd-id: \"{{category}}.NN\"`.",
        readOnly: false,
        options: [
          { name: "folder_path", what: "vault path of the category folder" },
          { name: "prefix", what: "the category's two-digit prefix" },
          { name: "zero_id", what: "which standard-zero slot to create" },
          { name: "templates_folder", what: "vault path of the folder containing template notes" },
        ],
        caveats: ["Refuses if the slot already exists or no matching template is found."],
      },
      {
        name: "obsidian_jd_new_generic_id",
        purpose: "Create an `XX.YY Title` note from a template classified `jd-id: \"{{category}}.{{id}}\"`.",
        readOnly: false,
        options: [
          { name: "folder_path", what: "vault path of the category folder" },
          { name: "prefix", what: "the category's two-digit prefix" },
          { name: "id", what: "two-digit id for the new note" },
          { name: "title", what: "title for the new note — sanitized before use" },
          { name: "templates_folder", what: "vault path of the folder containing template notes" },
        ],
      },
      {
        name: "obsidian_jd_new_stem",
        purpose: "Create an `XX.00+CODE Name` note from a template classified `jd-id: \"XX.00+CODE\"`.",
        readOnly: false,
        options: [
          { name: "folder_path", what: "vault path of the category folder" },
          { name: "prefix", what: "the category's two-digit prefix" },
          { name: "stem_code", what: "the stem code (e.g. DRAFT)" },
          { name: "name", what: "name for the new note — sanitized before use" },
          { name: "templates_folder", what: "vault path of the folder containing template notes" },
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
  /** The provenance module's injected backend (obsidianProvenanceBackend live)
   * — the freshness/reconcile read seam plus the regen write primitive. */
  provenanceSource: ProvenanceBackend;
  /** The health module's injected source (obsidianHealthBackend live) — the
   * read-only resolver + on-disk-body seam the tiered scan runs over. */
  healthSource: HealthSource;
  /** This vault's name — pinned into every fileclass CLI call via `--vault`.
   * Optional so the settings-UI's stand-in deps and pre-fileclass callers still
   * satisfy MountDeps (the fileclass module only reads it when it registers). */
  vaultName?: string;
  /** Whether the Fileclass plugin is LOADED (`app.plugins.plugins.fileclass`).
   * Absent ⇒ treated as not present, so the fileclass module registers nothing
   * (the settings UI passes no probe and never calls register()). */
  fileclassPresent?: () => boolean;
  /** Injected exec for the fileclass CLI (tests). Absent ⇒ the production execFile. */
  fileclassExec?: FileclassToolsCtx["exec"];
  /** Injected fileclass CLI binary (tests / explicit override). Absent ⇒ the
   * registrar resolves from config.binaryPath, else probes the filesystem. */
  fileclassBinary?: string | null;
  /** The bases module's injected vault/engine adapter (obsidianBasesSource
   * live — the hidden-leaf capture). Absent ⇒ an inert unavailable source, so
   * the settings-UI's stand-in deps and pre-bases callers still satisfy
   * MountDeps (the module's registrar then registers nothing, exactly like a
   * pre-1.10 Obsidian). */
  basesSource?: BasesSource;
  /** The jd-scaffold module's injected vault reader/writer
   *  (obsidianJdScaffoldSource live — standard-zeros creation, category-index
   *  self-heal, promote-to-folder). Absent ⇒ emptyJdScaffoldSource(): reads
   *  answer empty, writes refuse with a clear error rather than a silent
   *  no-op — same "registers, degrades cleanly" shape as bases. */
  jdScaffoldSource?: JdScaffoldSource;
  /** Feeds jd-scaffold's template-creation tools' accept-forbidden content
   *  scan (same `{parseYaml}` shape `registerCliTools` already takes) —
   *  without it, a template-created note's frontmatter fence can never be
   *  verified and every such call refuses. Absent ⇒ every fence-carrying
   *  template refuses (fails closed, not open — matches the guard's own
   *  documented "unverifiable = refuse" contract). */
  jdScaffoldParseYaml?: (yaml: string) => unknown;
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
    // THE SKILLS MODULE IS GONE FROM HERE (suite split, S4). It was the FIRST
    // mutating capability module and it is the precedent several comments below
    // still cite; it now ships as its own plugin, `packages/skills` (plugin id
    // `vault-skills`), publishing the same six `vault_skills_*` tools through
    // vault-mcp-api like any third-party publisher. Its config left with it —
    // a stale `modules.skills` row in an existing data.json is simply an
    // unknown module id now, and the satellite adopts a copy of
    // `modules.skills.config` once, on its own first load, without writing
    // anything here.
    //
    // The provenance module (the obsidian-provenance CLI fold): the second
    // mutating capability module. Like skills was, it declares `mutating: true`,
    // which the mount gate honors to let its one write tool (regen) register
    // with `readOnlyHint: false` — still through the guard-patched registrar
    // (read-only mode, allowlist, queue, journal) and the accept-forbidden
    // write guard. Default DISABLED: a newly-folded mutating surface stays off
    // until a human turns it on in the config tab. Config lives at
    // `modules.provenance.config` (a new module, no ConfigBinding), so `config`
    // here is that record merged over the manifest defaults.
    moduleFromRegistrar(
      { id: "provenance", capabilities: ["freshness", "reconcile", "regen"], enabled: false, mutating: true, manifest: PROVENANCE_MANIFEST },
      (server: any, ctx: ProvenanceToolsCtx) => registerProvenanceTools(server, deps.provenanceSource, ctx),
      (_host, config) => ({ config, getSettings: deps.getSettings }),
    ),
    // The health module (the obsidian-vault-health scanner fold): a READ-ONLY
    // capability module. Unlike provenance it declares NO `mutating` flag
    // — both its tools (obsidian_health / obsidian_lint) register with
    // `readOnlyHint: true`, so the mount's read-only-only registrar gate passes
    // them without any exemption, and there is no write tool, write guard, or
    // accept verb anywhere in the module. Default DISABLED (opt-in): the scan
    // surface stays off until a human turns it on in the config tab. Config lives
    // at `modules.health.config` (a new module, no ConfigBinding), so `config`
    // here is that record merged over the manifest defaults.
    moduleFromRegistrar(
      { id: "health", capabilities: ["health"], enabled: false, manifest: HEALTH_MANIFEST },
      (server: any, ctx: HealthToolsCtx) => registerHealthTools(server, deps.healthSource, ctx),
      (_host, config) => ({ config, getSettings: deps.getSettings }),
    ),
    // The fileclass module (#188: the fileclass CLI fold): a MUTATING capability
    // module that PROXIES the standalone `fileclass` CLI (execFile, the
    // obsidian_cli precedent). Like provenance it declares `mutating:
    // true`, so its two write tools (set / set_where) register with
    // `readOnlyHint: false` — through the guard-patched registrar (read-only
    // mode, path allowlist, queue, journal, if_rev) and the accept-forbidden
    // guard applied in the tool layer. UNIQUELY among the modules, its registrar
    // ALSO gates on the Fileclass plugin being LOADED and the CLI binary being
    // present: `present()`/`binary` absent ⇒ it registers zero tools (degrades
    // cleanly to absent), so an enabled module with the plugin uninstalled is a
    // no-op rather than a broken surface. Default DISABLED (opt-in). Config lives
    // at `modules.fileclass.config` (a new module, no ConfigBinding), so `config`
    // here is that record merged over the manifest defaults.
    moduleFromRegistrar(
      { id: "fileclass", capabilities: ["fileclass"], enabled: false, mutating: true, manifest: FILECLASS_MANIFEST },
      (server: any, ctx: FileclassToolsCtx) => registerFileclassTools(server, ctx),
      (_host, config) => ({
        config,
        getSettings: deps.getSettings,
        vaultName: deps.vaultName ?? "",
        present: deps.fileclassPresent ?? (() => false),
        ...(deps.fileclassExec ? { exec: deps.fileclassExec } : {}),
        ...(deps.fileclassBinary !== undefined ? { binary: deps.fileclassBinary } : {}),
      }),
    ),
    // The acceptance module (#83, cycle 2; id `acceptance` since 0.12.0, historically
    // `governance`): the accept pane's toggle. It
    // contributes ZERO MCP tools — its registrar is a NO-OP on the transport. Its
    // enabled-flag is read by main.ts (NOT here) to decide whether to wire the Obsidian
    // review pane (src/governor/wiring/wiring.ts). Deliberately NOT `mutating`: it registers no
    // tool at all, so the mount's read-only-only registrar gate is satisfied vacuously and
    // the accept/baseline-name tripwire has nothing to catch (the accept path lives entirely
    // behind gesture-gated pane buttons, never on the MCP surface). Default DISABLED: the
    // accept pane is opt-in (a human enables it in the config tab). The read-only
    // obsidian_pending_review view is registered always-on in server.ts, independent of this.
    moduleFromRegistrar(
      { id: "acceptance", capabilities: ["acceptance"], enabled: false, manifest: ACCEPTANCE_MANIFEST },
      // No-op registrar: the acceptance capability is an Obsidian UI pane (wired in main.ts),
      // not an MCP tool. Contributing nothing keeps the transport read-only by construction.
      () => { /* contributes no MCP tools */ },
      () => ({}),
    ),
    // The bases module (#243): evaluated Base rows for agents. A READ-ONLY
    // capability module — both tools readOnlyHint: true, so the mount's
    // read-only-only registrar gate passes them without any exemption, and
    // there is no write tool, write guard, or accept verb anywhere in the
    // module. DEFAULT ENABLED (the scheme/vocab precedent: a pure read
    // surface over rows the session could already assemble note-by-note,
    // allowlist-filtered like every other read); feature-gated like fileclass
    // (its registrar registers nothing when the public Bases API is absent).
    // A NEW module, so it follows the adapters doc: it reads `host`/`config`
    // and filters with `host.visible`. Config lives at `modules.bases.config`
    // (no ConfigBinding).
    moduleFromRegistrar(
      { id: "bases", capabilities: ["bases"], enabled: true, manifest: BASES_MANIFEST },
      (server: any, ctx: BasesToolsCtx) => registerBasesTools(server, deps.basesSource ?? emptyBasesSource(), ctx),
      (host, config) => ({
        config,
        getSettings: deps.getSettings,
        visible: host.visible,
      }),
    ),
    // jd-scaffold (Stage A + A2 + A3 of the jd-dashboard fold): another
    // MUTATING capability module (skills' own reasoning applies here too) —
    // it declares `mutating: true` so its seven write tools (standard_zeros,
    // ensure_category_indexes, promote_to_folder, reindex_category,
    // new_standard_zero, new_generic_id, new_stem) register with
    // `readOnlyHint: false`, still through the guard-patched registrar
    // (queue, journal, allowlist, read-only mode). Default DISABLED, matching
    // the skills module's own precedent ("a newly-folded mutating surface
    // stays off until a human turns it on"). No MODULE-level config yet (see
    // JD_SCAFFOLD_MANIFEST's own comment). ctxOf DOES carry parseYaml
    // (deps.jdScaffoldParseYaml) alongside getSettings — the template-
    // creation tools' accept-forbidden scan needs it to verify a
    // frontmatter fence at all; without it every such call fails closed.
    moduleFromRegistrar(
      { id: "jd-scaffold", capabilities: ["scaffolding"], enabled: false, mutating: true, manifest: JD_SCAFFOLD_MANIFEST },
      (server: any, ctx: JdScaffoldToolsCtx) =>
        registerJdScaffoldTools(server, deps.jdScaffoldSource ?? emptyJdScaffoldSource(), ctx),
      () => ({ getSettings: deps.getSettings, parseYaml: deps.jdScaffoldParseYaml }),
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
  // The modules that have EARNED the right to contribute mutating tools
  // (provenance, fileclass and jd-scaffold today; skills, triage and
  // cross-session each set the precedent before leaving for their own
  // plugins), by declaring `mutating` — see VaultModule.mutating.
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
