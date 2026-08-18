// config.ts — the triage module's typed config (#221 phase 2). VAULT SEMANTICS
// ARE CONFIGURATION (the project's standing rule: a hardwired semantic
// constant is a defect): how an inbox is recognized, where each disposition
// lands, and what frontmatter it stamps are all per-vault config. The DEFAULTS
// mirror the live vault's conventions — the crosssession module's discipline —
// so a stock install behaves like the legacy `dispose-inbox-item` flow did,
// while another vault's naming never hardcodes this one's.
//
// Frontmatter patches are stored as JSON object strings (the settings tab's
// scalar field renderer can carry a string; a nested object it cannot).
// `validateTriageConfig` reports malformed values LOUDLY (settings tab +
// registry.problems); `triageConfigOf` then degrades each bad value to its
// default at use time (the health/crosssession degrade-to-default discipline —
// a hand-edited data.json must never crash a tool).
//
// A configured patch may NEVER assert acceptance: validation runs the SHARED
// accept-forbidden rule (@vault-mcp/core's acceptForbiddenReason — no second
// definition of "accepted") over every parsed patch, and the tool layer
// re-checks the effective patch before any write.

import { acceptForbiddenReason } from "@vault-mcp/core";
import type { TriageDestinationKey, TriageFrontmatterKey } from "./descriptors.js";

export interface TriageConfig {
  /** Substrings that mark a FOLDER as an inbox: a note is an inbox item when
   * any ancestor folder's name contains one of these (the inbox folder's own
   * folder note is not an item). */
  inboxMarkers: string[];
  /** Fallback destination folders, per config-or-target disposition. Empty ⇒
   * unconfigured (the disposition refuses without an explicit `target`). */
  actionDestination: string;
  knowledgeDestination: string;
  somedayDestination: string;
  archiveDestination: string;
  /** Frontmatter patches (parsed from the JSON-string config values). */
  actionFrontmatter: Record<string, unknown>;
  somedayFrontmatter: Record<string, unknown>;
  escalateFrontmatter: Record<string, unknown>;
}

/** The raw (stored) shape: patches still JSON strings. */
export const DEFAULT_TRIAGE_CONFIG: Record<string, unknown> = {
  inboxMarkers: [" Inbox for "],
  actionDestination: "",
  knowledgeDestination: "",
  somedayDestination: "",
  archiveDestination: "",
  // The legacy flow's stamps, as overridable defaults: convert-to-action
  // tagged note/task and defaulted status/priority; defer-to-someday set
  // status: someday; escalate tagged attention/user and left the note in
  // place. (Its dynamic `projects: [[<scope note>]]` stamp is deliberately
  // NOT ported — a static config cannot express it; see the module docs.)
  actionFrontmatter: '{"tags": ["note/task"], "status": "open", "priority": "normal"}',
  somedayFrontmatter: '{"status": "someday"}',
  escalateFrontmatter: '{"tags": ["attention/user"]}',
};

export const DESTINATION_KEYS: TriageDestinationKey[] = [
  "actionDestination",
  "knowledgeDestination",
  "somedayDestination",
  "archiveDestination",
];

export const FRONTMATTER_KEYS: TriageFrontmatterKey[] = [
  "actionFrontmatter",
  "somedayFrontmatter",
  "escalateFrontmatter",
];

/** A destination folder value that can never be honored: absolute, escaping,
 * or whitespace-wrapped. Returns the problem or null. Empty is legal
 * ("unconfigured"). */
export function destinationProblem(value: string): string | null {
  if (value === "") return null;
  if (value !== value.trim()) return "must not have leading/trailing whitespace";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return "must be a vault-relative folder path, not absolute";
  if (value.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return "must not contain empty, '.' or '..' path segments";
  }
  return null;
}

/** Parse one stored frontmatter-patch value. Returns the patch or a problem
 * string (never both). */
export function parseFrontmatterPatch(value: unknown): { patch: Record<string, unknown> } | { problem: string } {
  if (typeof value !== "string") return { problem: "must be a JSON object string" };
  if (value.trim() === "") return { patch: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return { problem: `is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problem: "must be a JSON OBJECT (e.g. {\"status\": \"open\"}), not an array or scalar" };
  }
  const patch = parsed as Record<string, unknown>;
  // Reserved object-machinery keys can never behave as frontmatter properties
  // (assigning `__proto__` silently rewires the object instead of writing a
  // key) — refuse them LOUDLY here rather than letting a patch no-op quietly.
  for (const k of Object.keys(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      return { problem: `contains the reserved key '${k}', which cannot be written as a frontmatter property` };
    }
  }
  const forbidden = acceptForbiddenReason(patch);
  if (forbidden) return { problem: `would write acceptance and is refused: ${forbidden}` };
  return { patch };
}

/** Manifest `validate` — findings reported to the settings tab and
 * registry.problems, never thrown. Loud about every malformed value. */
export function validateTriageConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const markers = config.inboxMarkers;
  if (markers !== undefined) {
    if (!Array.isArray(markers) || markers.some((m) => typeof m !== "string")) {
      problems.push("inboxMarkers must be an array of strings");
    } else if (markers.length === 0 || markers.every((m) => (m as string).trim() === "")) {
      problems.push("inboxMarkers must contain at least one non-blank marker — with none, no note is ever an inbox item");
    }
  }
  for (const key of DESTINATION_KEYS) {
    const v = config[key];
    if (v === undefined) continue;
    if (typeof v !== "string") {
      problems.push(`${key} must be a string (a vault-relative folder path, or blank for unconfigured)`);
      continue;
    }
    const p = destinationProblem(v);
    if (p) problems.push(`${key} ${p}`);
  }
  for (const key of FRONTMATTER_KEYS) {
    const v = config[key];
    if (v === undefined) continue;
    const r = parseFrontmatterPatch(v);
    if ("problem" in r) problems.push(`${key} ${r.problem}`);
  }
  return problems;
}

/** Coerce a merged config record (defaults ∪ user override, as `register()`
 * receives it) into a typed TriageConfig, degrading each invalid value to its
 * default (validation already reported it loudly). */
export function triageConfigOf(config: Record<string, unknown>): TriageConfig {
  const markersRaw = config.inboxMarkers;
  const markers =
    Array.isArray(markersRaw) && markersRaw.every((m) => typeof m === "string")
      ? (markersRaw as string[]).filter((m) => m.trim() !== "")
      : [];
  const dest = (key: TriageDestinationKey): string => {
    const v = config[key];
    return typeof v === "string" && destinationProblem(v) === null ? v.replace(/\/+$/, "") : "";
  };
  const patch = (key: TriageFrontmatterKey): Record<string, unknown> => {
    const r = parseFrontmatterPatch(config[key]);
    if ("patch" in r) return r.patch;
    const fallback = parseFrontmatterPatch(DEFAULT_TRIAGE_CONFIG[key]);
    return "patch" in fallback ? fallback.patch : {};
  };
  return {
    inboxMarkers: markers.length > 0 ? markers : (DEFAULT_TRIAGE_CONFIG.inboxMarkers as string[]),
    actionDestination: dest("actionDestination"),
    knowledgeDestination: dest("knowledgeDestination"),
    somedayDestination: dest("somedayDestination"),
    archiveDestination: dest("archiveDestination"),
    actionFrontmatter: patch("actionFrontmatter"),
    somedayFrontmatter: patch("somedayFrontmatter"),
    escalateFrontmatter: patch("escalateFrontmatter"),
  };
}
