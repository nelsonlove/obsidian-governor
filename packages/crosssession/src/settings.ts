// settings.ts — the satellite's own settings shape, its field definitions, and
// the ONE-SHOT adoption of the host's `modules.crosssession.config`.
//
// ── Why adoption exists ──────────────────────────────────────────────────────
//
// Before this extraction the cross-session channel surface was a capability
// MODULE inside the Governor host, and its configuration lived in the host's
// data.json at `modules.crosssession.config` — the channel fileClass, the
// per-message fileClass, and the delta cap. A user who upgrades gets a
// brand-new plugin with a brand-new, EMPTY data.json. For crosssession an empty
// config is not a safety hole the way triage's empty `moveWhitelist` was (the
// shipped defaults already mirror the live vault's conventions), but a vault
// that renamed its channel fileClass would silently discover ZERO channels —
// which reads as "the coordination log is gone", not as "a setting was lost".
// So the satellite adopts the host's values once, on first load.
//
// Three rules, all deliberate, and identical to the skills and triage
// satellites':
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
// ── THE SECOND ADOPTION: READ RECEIPTS ──────────────────────────────────────
//
// This satellite has something neither of its predecessors had — LIVE
// OPERATIONAL STATE outside data.json. `crosssession-receipts.json` sat in the
// HOST's plugin directory beside the journal, and it records which handles have
// read which channels through which stamp. Losing it is not cosmetic: every
// affected handle's next `delta` re-serves entries it already read, and its
// next `post` refuses `stale_read` on entries it already attested. So main.ts
// adopts that file too, once, by MERGE (own values win per channel+handle),
// under its own latch — and, rule 1 again, never writes the host's copy. The
// merge itself lives in `ReceiptStore.merge`; what lives here is only the
// latch. Two latches rather than one because the two sources can be present
// independently: a host may have receipts and no config, or the reverse.

import { DEFAULT_CROSSSESSION_CONFIG } from "./kernel/index.js";

/** The satellite's persisted settings (its own data.json). */
export interface CrosssessionPluginSettings {
  /** Config overrides, keyed exactly as the host's `modules.crosssession.config`
   *  was — same key names, same meanings — so adoption is a straight copy and a
   *  hand-migrated file works too. Missing keys fall back to
   *  DEFAULT_CROSSSESSION_CONFIG via `crosssessionConfigOf`. */
  config: Record<string, unknown>;
  /** The one-shot config-adoption latch (rule 2 above). */
  adoptedFromHost: boolean;
  /** The one-shot receipt-adoption latch — separate, see the header. */
  adoptedReceiptsFromHost: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: CrosssessionPluginSettings = {
  config: {},
  adoptedFromHost: false,
  adoptedReceiptsFromHost: false,
};

/** Coerce whatever `loadData()` returned into a settings object. A hand-edited
 *  or corrupt data.json degrades to the defaults rather than throwing during
 *  onload — the same skip-and-report discipline the config coercion uses. */
export function settingsOf(raw: unknown): CrosssessionPluginSettings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const config = r.config && typeof r.config === "object" && !Array.isArray(r.config)
    ? { ...(r.config as Record<string, unknown>) }
    : {};
  return {
    config,
    adoptedFromHost: r.adoptedFromHost === true,
    adoptedReceiptsFromHost: r.adoptedReceiptsFromHost === true,
  };
}

/** The config keys adoption carries across — exactly the fields the host's
 *  crosssession module manifest declared. An unknown key in the host's record
 *  is NOT copied: it was never a crosssession config field, and copying it
 *  would import someone else's mistake. */
export const ADOPTABLE_KEYS: readonly string[] = Object.keys(DEFAULT_CROSSSESSION_CONFIG);

/**
 * The pure half of config adoption. Returns the settings to persist, or `null`
 * when there is nothing to do (already adopted, or the host is absent / not
 * ready).
 *
 * `hostSettings` is the host plugin's own settings object, read but never
 * written. A host that is present with no crosssession config still LATCHES:
 * the question was asked and answered, and re-asking every load would let a
 * much later host edit reach in.
 */
export function adoptHostConfig(
  current: CrosssessionPluginSettings,
  hostSettings: unknown,
): CrosssessionPluginSettings | null {
  if (current.adoptedFromHost) return null;
  if (!hostSettings || typeof hostSettings !== "object") return null; // host absent / not ready — try again next load
  const modules = (hostSettings as { modules?: unknown }).modules;
  const crosssession = modules && typeof modules === "object"
    ? (modules as Record<string, unknown>).crosssession
    : undefined;
  const hostConfig = crosssession && typeof crosssession === "object"
    ? (crosssession as { config?: unknown }).config
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
// Ported verbatim from CROSSSESSION_CONFIG_FIELDS in the host's
// mcp/modules-mount.ts — same keys, same labels, same help text, minus the
// `modules.crosssession.config.` prefixes that no longer name anything. The
// host rendered them through its generic manifest-driven config tab; this
// plugin renders them itself. The help text is the user-facing documentation of
// each key, so it moves with the keys rather than being rewritten.

export type CrosssessionFieldType = "text" | "number";

export interface CrosssessionField {
  key: string;
  label: string;
  type: CrosssessionFieldType;
  help: string;
}

export const CROSSSESSION_FIELDS: CrosssessionField[] = [
  {
    key: "channelFileclass",
    label: "Channel fileClass",
    type: "text",
    help:
      "The fileClass a channel's folder note carries. A note with this fileClass AND an `audience:` frontmatter " +
      `value is a channel. Blank ⇒ the default (${DEFAULT_CROSSSESSION_CONFIG.channelFileclass}).`,
  },
  {
    key: "messageFileclass",
    label: "Per-message note fileClass",
    type: "text",
    help:
      "The fileClass a channel's per-message notes carry (filename `<stamp> · <handle>.md`, write-once). Blank ⇒ " +
      `the default (${DEFAULT_CROSSSESSION_CONFIG.messageFileclass}).`,
  },
  {
    key: "deltaCap",
    label: "Delta cap",
    type: "number",
    help:
      "Maximum entries the delta tool returns per channel per call (a `more` marker + `next_stamp` continue a " +
      `truncated read). Blank ⇒ the default (${DEFAULT_CROSSSESSION_CONFIG.deltaCap}).`,
  },
];
