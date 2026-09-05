// settings.ts — the satellite's own settings shape, its field definitions, and
// the ONE-SHOT adoption of the host's `modules.bases.config`.
//
// ── Why adoption exists ──────────────────────────────────────────────────────
//
// Before this extraction the Bases surface was a capability MODULE inside the
// Governor host, and its configuration lived in the host's data.json at
// `modules.bases.config` — the per-query timeout and the row cap. A user who
// upgrades gets a brand-new plugin with a brand-new, EMPTY data.json. Neither
// key is a safety bound (unlike triage's `moveWhitelist`), so an empty config
// is not a hole; but both are values a user tunes to their own vault, and the
// timeout in particular is the one people raise after a slow scan. Silently
// resetting it to 30s would look like a regression in the tool, not like a
// lost setting. So the satellite adopts the host's values once, on first load.
//
// Three rules, all deliberate, and identical to the skills, triage and
// cross-session satellites':
//
//   1. IT NEVER WRITES THE HOST'S SETTINGS. Not to delete the adopted keys, not
//      to mark them migrated, not at all. The host's settings shape is the
//      host's; a satellite reaching into another plugin's data.json to tidy up
//      is exactly the boundary this split exists to draw. The host's copy stays
//      where it is and simply stops being read (the module is gone from the
//      host, so nothing reads it there either).
//   2. IT RUNS ONCE. `adoptedFromHost` latches, so a later host edit does not
//      reach back in and overwrite what the user has since set here.
//   3. THE SATELLITE'S OWN VALUES WIN. If this plugin already has config keys
//      (host installed after the satellite, say), adoption fills only the gaps.
//
// If the host is ABSENT at first load, nothing is adopted and the latch is NOT
// set — the satellite keeps its defaults, and if the host shows up later the
// adoption still gets its one chance. The same is true when the host is present
// but its `settings` is still UNDEFINED: the host declares that field without
// an initializer and assigns it mid-onload, so an instance visible in the
// plugins map before that assignment is HOST NOT READY, not "host with empty
// settings". Treating it as the latter burns the one-shot latch on nothing and
// the user's config never adopts — found by the review of the skills
// extraction, and the reason the check in main.ts is `!== undefined` rather
// than a truthiness test.
//
// ── THERE IS NO SECOND ADOPTION HERE, and that is a checked fact ────────────
//
// The cross-session extraction needed a second, separately-latched adoption
// because it had LIVE OPERATIONAL STATE outside data.json (the per-handle read
// receipts in the host's plugin directory). Bases has none: the whole surface
// is read-only, the capture leaf is constructed and detached inside a single
// call, and nothing in this plugin or in the module it came from ever wrote a
// state file, a cache, or a note. The only thing to carry across is the two
// config keys above. Stated rather than omitted, so the absence is a finding
// and not an oversight.

import { DEFAULT_BASES_CONFIG } from "./kernel/index.js";

/** The satellite's persisted settings (its own data.json). */
export interface BasesPluginSettings {
  /** Config overrides, keyed exactly as the host's `modules.bases.config` was —
   *  same key names, same meanings — so adoption is a straight copy and a
   *  hand-migrated file works too. Missing keys fall back to
   *  DEFAULT_BASES_CONFIG via `basesConfigOf`. */
  config: Record<string, unknown>;
  /** The one-shot config-adoption latch (rule 2 above). */
  adoptedFromHost: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: BasesPluginSettings = {
  config: {},
  adoptedFromHost: false,
};

/** Coerce whatever `loadData()` returned into a settings object. A hand-edited
 *  or corrupt data.json degrades to the defaults rather than throwing during
 *  onload — the same skip-and-report discipline the config coercion uses. */
export function settingsOf(raw: unknown): BasesPluginSettings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const config = r.config && typeof r.config === "object" && !Array.isArray(r.config)
    ? { ...(r.config as Record<string, unknown>) }
    : {};
  return {
    config,
    adoptedFromHost: r.adoptedFromHost === true,
  };
}

/** The config keys adoption carries across — exactly the fields the host's
 *  bases module manifest declared. An unknown key in the host's record is NOT
 *  copied: it was never a bases config field, and copying it would import
 *  someone else's mistake. */
export const ADOPTABLE_KEYS: readonly string[] = Object.keys(DEFAULT_BASES_CONFIG);

/**
 * The pure half of config adoption. Returns the settings to persist, or `null`
 * when there is nothing to do (already adopted, or the host is absent / not
 * ready).
 *
 * `hostSettings` is the host plugin's own settings object, read but never
 * written. A host that is present with no bases config still LATCHES: the
 * question was asked and answered, and re-asking every load would let a much
 * later host edit reach in.
 */
export function adoptHostConfig(
  current: BasesPluginSettings,
  hostSettings: unknown,
): BasesPluginSettings | null {
  if (current.adoptedFromHost) return null;
  if (!hostSettings || typeof hostSettings !== "object") return null; // host absent / not ready — try again next load
  const modules = (hostSettings as { modules?: unknown }).modules;
  const bases = modules && typeof modules === "object"
    ? (modules as Record<string, unknown>).bases
    : undefined;
  const hostConfig = bases && typeof bases === "object"
    ? (bases as { config?: unknown }).config
    : undefined;
  const adopted: Record<string, unknown> = {};
  if (hostConfig && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
    for (const key of ADOPTABLE_KEYS) {
      const value = (hostConfig as Record<string, unknown>)[key];
      // Rule 3: the satellite's own value wins where it already has one.
      if (value !== undefined && !(key in current.config)) adopted[key] = value;
    }
  }
  return { ...current, config: { ...current.config, ...adopted }, adoptedFromHost: true };
}

// ── settings-tab field definitions (pure data; rendered by settings-tab.ts) ──
//
// Ported from BASES_CONFIG_FIELDS in the host's mcp/modules-mount.ts — same
// keys, same labels, same help text, with two edits and no others: the
// `modules.bases.config.` prefixes are gone (they name nothing in this plugin),
// and the tool the help text refers to is spelled `vault_bases_query`, which is
// what the tool is actually called now (`base_query` names nothing either — see
// the rename table in README.md). The host rendered these through its generic
// manifest-driven config tab; this plugin renders them itself. The help text is
// the user-facing documentation of each key, so it moves WITH the keys rather
// than being rewritten.

export type BasesFieldType = "text" | "number";

export interface BasesField {
  key: string;
  label: string;
  type: BasesFieldType;
  help: string;
}

export const BASES_FIELDS: BasesField[] = [
  {
    key: "queryTimeoutMs",
    label: "Query timeout (ms)",
    type: "number",
    help:
      "Hard deadline for one vault_bases_query evaluation. The Bases engine's scan is heavily throttled while the " +
      "Obsidian window is hidden, so slow answers are normal in the background — expiry refuses with a typed, " +
      `retryable base_timeout. Blank ⇒ the default (${DEFAULT_BASES_CONFIG.queryTimeoutMs}).`,
  },
  {
    key: "rowCap",
    label: "Row cap",
    type: "number",
    help:
      "Maximum rows one vault_bases_query returns (the tool's `limit` argument clamps to this). Blank ⇒ the " +
      `default (${DEFAULT_BASES_CONFIG.rowCap}).`,
  },
];
