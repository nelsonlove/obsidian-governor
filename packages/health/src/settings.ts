// settings.ts — the satellite's own settings shape, its field definitions, and
// the ONE-SHOT adoption of the host's `modules.health.config`.
//
// ── Why adoption exists ──────────────────────────────────────────────────────
//
// Before this extraction the health scan was a capability MODULE inside the
// Governor host, and its configuration lived in the host's data.json at
// `modules.health.config` — one field, the empty-note character threshold. A user
// who upgrades gets a brand-new plugin with a brand-new, EMPTY data.json. An
// empty config here is not a safety hole the way triage's empty `moveWhitelist`
// was, and it is not silent the way a renamed crosssession fileClass would be:
// the worst case is a vault that raised the threshold to 200 quietly dropping
// back to 40 and reporting a pile of "empty" notes that the user had already
// decided were not empty. That is a lost setting rather than a lost boundary, but
// it is still the user's setting, so the satellite adopts it once, on first load.
//
// Three rules, all deliberate, and identical to the skills, triage and
// crosssession satellites':
//
//   1. IT NEVER WRITES THE HOST'S SETTINGS. Not to delete the adopted key, not
//      to mark it migrated, not at all. The host's settings shape is the host's;
//      a satellite reaching into another plugin's data.json to tidy up is exactly
//      the boundary this split exists to draw. The host's copy stays where it is
//      and simply stops being read (the module is gone from the host, so nothing
//      reads it there either).
//   2. IT RUNS ONCE. `adoptedFromHost` latches, so a later host edit does not
//      reach back in and overwrite what the user has since set here.
//   3. THE SATELLITE'S OWN VALUES WIN. If this plugin already has config keys
//      (host installed after the satellite, say), adoption fills only the gaps.
//
// If the host is ABSENT at first load, nothing is adopted and the latch is NOT
// set — the satellite keeps its defaults, and if the host shows up later the
// adoption still gets its one chance. The same is true when the host is present
// but its `settings` is still UNDEFINED: the host declares that field without an
// initializer and assigns it mid-onload, so an instance visible in the plugins
// map before that assignment is HOST NOT READY, not "host with empty settings".
// Treating it as the latter burns the one-shot latch on nothing and the user's
// config never adopts — found by the review of the skills extraction, and the
// reason the check in main.ts is `!== undefined` rather than a truthiness test.
//
// ── There is NO second adoption here ────────────────────────────────────────
//
// Unlike the crosssession satellite, this one has NO live operator state to
// migrate. The health module kept nothing on disk — no receipts, no baseline, no
// cursor: every call recomputes the whole scan from Obsidian's live metadata
// cache and the notes themselves. So `modules.health.config` is the entire
// migration surface. That absence is a checked fact, not an omission.

import { DEFAULT_HEALTH_CONFIG } from "./kernel/index.js";

/** The satellite's persisted settings (its own data.json). */
export interface HealthPluginSettings {
  /** Config overrides, keyed exactly as the host's `modules.health.config` was —
   *  same key names, same meanings — so adoption is a straight copy and a
   *  hand-migrated file works too. Missing keys fall back to
   *  DEFAULT_HEALTH_CONFIG via `healthConfigOf`. */
  config: Record<string, unknown>;
  /** The one-shot config-adoption latch (rule 2 above). */
  adoptedFromHost: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: HealthPluginSettings = {
  config: {},
  adoptedFromHost: false,
};

/** Coerce whatever `loadData()` returned into a settings object. A hand-edited
 *  or corrupt data.json degrades to the defaults rather than throwing during
 *  onload — the same skip-and-report discipline the config coercion uses. */
export function settingsOf(raw: unknown): HealthPluginSettings {
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
 *  health module manifest declared. An unknown key in the host's record is NOT
 *  copied: it was never a health config field, and copying it would import
 *  someone else's mistake. */
export const ADOPTABLE_KEYS: readonly string[] = Object.keys(DEFAULT_HEALTH_CONFIG);

/**
 * The pure half of config adoption. Returns the settings to persist, or `null`
 * when there is nothing to do (already adopted, or the host is absent / not
 * ready).
 *
 * `hostSettings` is the host plugin's own settings object, read but never
 * written. A host that is present with no health config still LATCHES: the
 * question was asked and answered, and re-asking every load would let a much
 * later host edit reach in.
 */
export function adoptHostConfig(
  current: HealthPluginSettings,
  hostSettings: unknown,
): HealthPluginSettings | null {
  if (current.adoptedFromHost) return null;
  if (!hostSettings || typeof hostSettings !== "object") return null; // host absent / not ready — try again next load
  const modules = (hostSettings as { modules?: unknown }).modules;
  const health = modules && typeof modules === "object"
    ? (modules as Record<string, unknown>).health
    : undefined;
  const hostConfig = health && typeof health === "object"
    ? (health as { config?: unknown }).config
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
// Ported VERBATIM from HEALTH_CONFIG_FIELDS in the host's mcp/modules-mount.ts —
// same key, same label, same help text, same interpolated default. The host
// rendered it through its generic manifest-driven config tab; this plugin renders
// it itself. The help text is the user-facing documentation of the key, so it
// moves with the key rather than being rewritten.

export type HealthFieldType = "text" | "number";

export interface HealthField {
  key: string;
  label: string;
  type: HealthFieldType;
  help: string;
}

export const HEALTH_FIELDS: HealthField[] = [
  {
    key: "emptyChars",
    label: "Empty-note character threshold",
    type: "number",
    help:
      "Body characters (frontmatter excluded) at/under which a note is reported as empty / near-empty. Also the floor " +
      `below which identical stubs are skipped from duplicate grouping. Blank ⇒ the default (${DEFAULT_HEALTH_CONFIG.emptyChars}).`,
  },
];
