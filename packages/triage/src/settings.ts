// settings.ts — the satellite's own settings shape, its field definitions, and
// the ONE-SHOT adoption of the host's `modules.triage.config`.
//
// ── Why adoption exists ──────────────────────────────────────────────────────
//
// Before this extraction inbox triage was a capability MODULE inside the
// Governor host, and its configuration lived in the host's data.json at
// `modules.triage.config` — inbox markers, the stamp and escalate patches, the
// move whitelist/blacklist, the declared disposition rows, the built-in
// description overrides, and the named queues. A user who upgrades gets a
// brand-new plugin with a brand-new, EMPTY data.json. For triage that is not
// merely a surprise, it is a SAFETY one: `moveWhitelist` and `moveBlacklist`
// are the human's bound on where a disposition may send a note, and an empty
// config means "any destination". So the satellite adopts the host's values
// once, on first load.
//
// Three rules, all deliberate, and identical to the skills satellite's:
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
// set — the satellite works standalone, and if the host shows up later the
// adoption still gets its one chance. The same is true when the host is present
// but its `settings` is still UNDEFINED: the host declares that field without
// an initializer and assigns it mid-onload, so an instance visible in the
// plugins map before that assignment is HOST NOT READY, not "host with empty
// settings". Treating it as the latter burns the one-shot latch on nothing and
// the user's config never adopts — found by the review of the skills
// extraction, and the reason the check in main.ts is `!== undefined` rather
// than a truthiness test.

import { DEFAULT_TRIAGE_CONFIG } from "./kernel/index.js";

/** The satellite's persisted settings (its own data.json). */
export interface TriagePluginSettings {
  /** Config overrides, keyed exactly as the host's `modules.triage.config` was
   *  — same key names, same meanings — so adoption is a straight copy and a
   *  hand-migrated file works too. Missing keys fall back to
   *  DEFAULT_TRIAGE_CONFIG via `triageConfigOf`. */
  config: Record<string, unknown>;
  /** The one-shot adoption latch (rule 2 above). */
  adoptedFromHost: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: TriagePluginSettings = { config: {}, adoptedFromHost: false };

/** Coerce whatever `loadData()` returned into a settings object. A hand-edited
 *  or corrupt data.json degrades to the defaults rather than throwing during
 *  onload — the same skip-and-report discipline the config coercion uses. */
export function settingsOf(raw: unknown): TriagePluginSettings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const config = r.config && typeof r.config === "object" && !Array.isArray(r.config)
    ? { ...(r.config as Record<string, unknown>) }
    : {};
  return { config, adoptedFromHost: r.adoptedFromHost === true };
}

/** The config keys adoption carries across — exactly the fields the host's
 *  triage module manifest declared. An unknown key in the host's record is NOT
 *  copied: it was never a triage config field, and copying it would import
 *  someone else's mistake. */
export const ADOPTABLE_KEYS: readonly string[] = Object.keys(DEFAULT_TRIAGE_CONFIG);

/**
 * The pure half of adoption. Returns the settings to persist, or `null` when
 * there is nothing to do (already adopted, or the host is absent / not ready).
 *
 * `hostSettings` is the host plugin's own settings object, read but never
 * written. A host that is present with no triage config still LATCHES: the
 * question was asked and answered, and re-asking every load would let a much
 * later host edit reach in.
 */
export function adoptHostConfig(
  current: TriagePluginSettings,
  hostSettings: unknown,
): TriagePluginSettings | null {
  if (current.adoptedFromHost) return null;
  if (!hostSettings || typeof hostSettings !== "object") return null; // host absent / not ready — try again next load
  const modules = (hostSettings as { modules?: unknown }).modules;
  const triage = modules && typeof modules === "object"
    ? (modules as Record<string, unknown>).triage
    : undefined;
  const hostConfig = triage && typeof triage === "object"
    ? (triage as { config?: unknown }).config
    : undefined;
  const adopted: Record<string, unknown> = {};
  if (hostConfig && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
    for (const key of ADOPTABLE_KEYS) {
      const value = (hostConfig as Record<string, unknown>)[key];
      // Rule 3: the satellite's own value wins where it already has one.
      if (value !== undefined && !(key in current.config)) adopted[key] = value;
    }
  }
  return { config: { ...current.config, ...adopted }, adoptedFromHost: true };
}

// ── settings-tab field definitions (pure data; rendered by settings-tab.ts) ──
//
// Ported verbatim from TRIAGE_CONFIG_FIELDS in the host's mcp/modules-mount.ts
// — same keys, same labels, same help text, minus the `modules.triage.config.`
// prefixes that no longer name anything. The host rendered them through its
// generic manifest-driven config tab; this plugin renders them itself. The help
// text is the user-facing documentation of each key, so it moves with the keys
// rather than being rewritten.

export type TriageFieldType = "text" | "lines";

export interface TriageField {
  key: string;
  label: string;
  type: TriageFieldType;
  help: string;
  /** Extra warnings the host's config tab rendered under the help text. */
  caveats?: string[];
}

export const TRIAGE_FIELDS: TriageField[] = [
  {
    key: "inboxMarkers",
    label: "Inbox folder markers",
    type: "lines",
    help:
      "Substrings (one per line) that mark a folder as an inbox: a note is an inbox item when any ancestor " +
      'folder\'s name contains one of these. Blank ⇒ the default (" Inbox for ", the live vault convention — ' +
      'e.g. "03.10 Inbox for 03 Agents"). The inbox folder\'s own folder note is never an item.',
    caveats: ["Matching is case-sensitive, per folder-name segment."],
  },
  {
    key: "stampFrontmatter",
    label: "Built-in stamp patch",
    type: "text",
    help:
      "JSON object the built-in `stamp` disposition applies in place (array values union with the existing " +
      "value; scalars overwrite). Blank ⇒ unconfigured: built-in stamp refuses `patch_unresolved` until this is " +
      "set or a stamp row is declared. It can never carry an acceptance field (validated, and re-checked at " +
      "write time).",
  },
  {
    key: "escalateFrontmatter",
    label: "Escalate patch (default declared row)",
    type: "text",
    help:
      "JSON object the DEFAULT `escalate` declared row stamps in place — this is where the escalate tag is " +
      'configured. Default: {"tags": ["attention/user"]}. Only consulted while "Declared dispositions" below is ' +
      "blank (an explicit declared list carries its own escalate row, or none). Same union/overwrite semantics " +
      "and acceptance ban as every patch.",
  },
  {
    key: "moveWhitelist",
    label: "Move destination whitelist",
    type: "lines",
    help:
      "Vault-relative folder prefixes (one per line) move destinations must fall under. Blank ⇒ any destination. " +
      "Enforced when a disposition plans a move AND re-checked at apply (`move_denied`).",
    caveats: ["Prefix matching is segment-boundary and case-sensitive."],
  },
  {
    key: "moveBlacklist",
    label: "Move destination blacklist",
    type: "lines",
    help:
      "Vault-relative folder prefixes (one per line) move destinations may NEVER fall under. Beats the " +
      "whitelist. Blank ⇒ none.",
    caveats: ["Prefix matching is segment-boundary and case-sensitive."],
  },
  {
    key: "declaredDispositions",
    label: "Declared dispositions",
    type: "text",
    help:
      "JSON array of human-declared disposition rows `{id, label?, description?, action: trash|move|stamp|choice, " +
      "patch?, destination?, inPlace?, choice?}` — the plugin's verb menu beyond the three built-in primitives. " +
      "Blank ⇒ the one default row, escalate (stamp-in-place with the escalate patch above; delete it by setting " +
      "this to a list without it, e.g. []). A `choice` row binds a QuickAdd choice (name or id) the agent can " +
      "invoke ONLY by this row's id — the binding itself is never agent-writable. Rows whose id collides with a " +
      "built-in or an earlier row are refused loudly and ignored.",
  },
  {
    key: "builtinDescriptions",
    label: "Built-in description overrides",
    type: "text",
    help:
      'JSON object overriding the built-ins\' descriptive text, e.g. {"move": "route the note to its scope ' +
      'folder"} — the same description field declared rows carry (descriptions exist to help agents pick the ' +
      "right verb). Blank ⇒ the defaults.",
  },
  {
    key: "queues",
    label: "Named Base-backed queues",
    type: "text",
    help:
      'JSON array of named queues `{id, base, view?}`, e.g. [{"id": "acceptance", "base": ' +
      '"Views/Acceptance.base"}]. NOT CURRENTLY USABLE from this plugin: evaluating a Base needs the Governor ' +
      "host's own Bases capture path, which a separate plugin cannot reach, so the base-backed forms of the " +
      "queue tool refuse `bases_unavailable`. The inbox-marker queue always works; for evaluated Base rows use " +
      "the host's `base_query` tool. Declarations here are preserved for the day the host can hand a publisher " +
      "a Bases service.",
    caveats: ["Base-backed queues are unavailable while triage ships as a separate plugin."],
  },
];
