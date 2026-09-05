// config.ts — the triage module's typed config (#221 phase 2, reshaped by
// #241 phase 3). VAULT SEMANTICS ARE CONFIGURATION (the project's standing
// rule: a hardwired semantic constant is a defect): how an inbox is
// recognized, what the stamp/escalate patches say, where moves may land
// (whitelist/blacklist), which dispositions exist beyond the three built-in
// primitives (`declaredDispositions` — the module's human-authored verb
// menu), and which Base-backed queues are named (`queues`) are all per-vault
// config. Settings are HUMAN-ONLY-MUTABLE by construction (no MCP surface can
// write plugin settings — the cli-policy config-territory guard pins that),
// which is exactly what makes a declared `choice` row's QuickAdd binding a
// human act rather than an agent-nameable macro.
//
// Composite values are stored as JSON strings (the settings tab's scalar
// field renderer can carry a string; nested structures it cannot).
// `validateTriageConfig` reports malformed values LOUDLY (settings tab +
// registry.problems); `triageConfigOf` then degrades each bad value to its
// default at use time (the health/crosssession degrade-to-default discipline —
// a hand-edited data.json must never crash a tool). Sanitization is
// SINGLE-SOURCED: each composite key has one `…Of(value)` parser returning
// `{value, problems}`, consumed by validation (problems) and coercion (value)
// alike, so the two can never disagree about what a stored value means.
//
// A configured patch may NEVER assert acceptance: every parsed patch —
// stampFrontmatter, escalateFrontmatter, and each declared row's `patch` —
// runs the SHARED accept-forbidden rule (@vault-mcp/core's
// acceptForbiddenReason — no second definition of "accepted"), and the tool
// layer re-checks the effective patch before any write.
//
// MIGRATION (#241): a config carrying the OLD phase-2 shape (the four
// `…Destination` keys and `actionFrontmatter`/`somedayFrontmatter`) is SANE
// here: unknown keys are ignored by validation and coercion, `inboxMarkers`
// and `escalateFrontmatter` keep their exact phase-2 meaning (the latter now
// feeds the default `escalate` declared row's patch, so a customized escalate
// tag carries over), and the retired verbs simply refuse
// `unknown_disposition` until re-declared as rows (docs/triage.md shows how).

import { acceptForbiddenReason } from "@vault-mcp/core";
import {
  TRIAGE_BUILTIN_IDS,
  type DeclaredDispositionRow,
  type TriageAction,
  type TriageBuiltinId,
} from "./descriptors.js";

/** One named Base-backed queue: `triage_queue {queue: "<id>"}` evaluates the
 * declared `.base` (optionally a named view) through the bases module's
 * capture path. */
export interface TriageQueueDecl {
  id: string;
  base: string;
  view?: string;
}

export interface TriageConfig {
  /** Substrings that mark a FOLDER as an inbox: a note is an inbox item when
   * any ancestor folder's name contains one of these (the inbox folder's own
   * folder note is not an item). */
  inboxMarkers: string[];
  /** The built-in `stamp` primitive's patch (parsed from the JSON-string
   * value). Empty ⇒ unconfigured: built-in stamp refuses `patch_unresolved`
   * until it is set or a stamp row is declared. */
  stampFrontmatter: Record<string, unknown>;
  /** The DEFAULT escalate row's patch (parsed). Only consulted while
   * `declaredDispositions` is unset — an explicit declared list carries its
   * own escalate row (or none). */
  escalateFrontmatter: Record<string, unknown>;
  /** Move destination whitelist/blacklist — vault-relative folder PREFIXES
   * (segment-boundary match). Empty whitelist ⇒ any destination; blacklist
   * beats whitelist. Enforced at plan time AND re-checked at apply. */
  moveWhitelist: string[];
  moveBlacklist: string[];
  /** Sanitized declared disposition rows, or null when the config leaves the
   * key unset (⇒ the default escalate row applies). Rows that failed
   * validation (bad shape, id collisions, acceptance-carrying patches) are
   * dropped here — validation already reported them loudly. */
  declared: DeclaredDispositionRow[] | null;
  /** Per-built-in description overrides (the shared description field). */
  builtinDescriptions: Partial<Record<TriageBuiltinId, string>>;
  /** Named Base-backed queues. */
  queues: TriageQueueDecl[];
}

/** The raw (stored) shape: composites as JSON strings, "" = unset. */
export const DEFAULT_TRIAGE_CONFIG: Record<string, unknown> = {
  inboxMarkers: [" Inbox for "],
  stampFrontmatter: "",
  escalateFrontmatter: '{"tags": ["attention/user"]}',
  moveWhitelist: [],
  moveBlacklist: [],
  declaredDispositions: "",
  builtinDescriptions: "",
  queues: "",
};

/** A destination folder value that can never be honored: absolute, escaping,
 * or whitespace-wrapped. Returns the problem or null. Empty is legal
 * ("unconfigured"). */
export function destinationProblem(value: string): string | null {
  if (value === "") return null;
  // Backslash refused outright — same traversal-class close as plan.ts's
  // targetProblem (2026-09-05): every downstream check splits on "/" alone.
  if (value.includes("\\")) return "contains a backslash";
  if (value !== value.trim()) return "must not have leading/trailing whitespace";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return "must be a vault-relative folder path, not absolute";
  if (value.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return "must not contain empty, '.' or '..' path segments";
  }
  return null;
}

/** Validate one frontmatter-patch OBJECT (already parsed). Returns the
 * problem or null. Shared by the string-valued config patches and each
 * declared row's inline patch — one rule set, no drift. */
export function patchObjectProblem(patch: unknown): string | null {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return 'must be a JSON OBJECT (e.g. {"status": "open"}), not an array or scalar';
  }
  const record = patch as Record<string, unknown>;
  // Reserved object-machinery keys can never behave as frontmatter properties
  // (assigning `__proto__` silently rewires the object instead of writing a
  // key) — refuse them LOUDLY here rather than letting a patch no-op quietly.
  for (const k of Object.keys(record)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      return `contains the reserved key '${k}', which cannot be written as a frontmatter property`;
    }
  }
  const forbidden = acceptForbiddenReason(record);
  if (forbidden) return `would write acceptance and is refused: ${forbidden}`;
  return null;
}

/** Parse one stored frontmatter-patch value (a JSON object string). Returns
 * the patch or a problem string (never both). "" ⇒ the empty patch. */
export function parseFrontmatterPatch(value: unknown): { patch: Record<string, unknown> } | { problem: string } {
  if (typeof value !== "string") return { problem: "must be a JSON object string" };
  if (value.trim() === "") return { patch: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return { problem: `is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  const bad = patchObjectProblem(parsed);
  if (bad) return { problem: bad };
  return { patch: parsed as Record<string, unknown> };
}

// ── prefix lists (moveWhitelist / moveBlacklist) ────────────────────────────

/** Sanitize a stored prefix-list value: strings, trimmed of trailing slashes,
 * blanks dropped. Non-array ⇒ problem + empty list. */
export function prefixListOf(key: string, value: unknown): { list: string[]; problems: string[] } {
  if (value === undefined) return { list: [], problems: [] };
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return { list: [], problems: [`${key} must be an array of strings (vault-relative folder prefixes)`] };
  }
  const problems: string[] = [];
  const list: string[] = [];
  for (const raw of value as string[]) {
    const v = raw.replace(/\/+$/, "");
    if (v.trim() === "") continue;
    const p = destinationProblem(v);
    if (p) {
      problems.push(`${key} entry ${JSON.stringify(raw)} ${p}`);
      continue;
    }
    list.push(v);
  }
  return { list, problems };
}

// ── declared disposition rows ───────────────────────────────────────────────

const ACTIONS: TriageAction[] = ["trash", "move", "stamp", "choice"];

/**
 * Parse + sanitize the stored `declaredDispositions` value (a JSON array
 * string; "" ⇒ unset). Single-sourced for validation AND coercion: `rows` is
 * what coercion keeps (bad rows dropped), `problems` is what validation
 * reports. `rows: null` means UNSET (the default escalate row applies) —
 * distinct from an explicit `[]`, which deletes it.
 */
export function declaredRowsOf(value: unknown): { rows: DeclaredDispositionRow[] | null; problems: string[] } {
  if (value === undefined || value === "") return { rows: null, problems: [] };
  if (typeof value !== "string") return { rows: null, problems: ["declaredDispositions must be a JSON array string"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return {
      rows: null,
      problems: [`declaredDispositions is not valid JSON (${e instanceof Error ? e.message : String(e)})`],
    };
  }
  if (!Array.isArray(parsed)) return { rows: null, problems: ["declaredDispositions must be a JSON ARRAY of rows"] };

  const problems: string[] = [];
  const rows: DeclaredDispositionRow[] = [];
  const seen = new Set<string>(TRIAGE_BUILTIN_IDS);
  parsed.forEach((raw, i) => {
    const at = `declaredDispositions[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`${at} must be an object row`);
      return;
    }
    const r = raw as Record<string, unknown>;
    // Ids are TRIMMED before anything else — " move" must collide with the
    // built-in `move`, not slip past as a whitespace-distinct sibling.
    const id = typeof r.id === "string" ? r.id.trim() : r.id;
    if (typeof id !== "string" || id === "") {
      problems.push(`${at} needs a non-empty string id`);
      return;
    }
    // ID COLLISIONS REFUSED LOUDLY: a row may not shadow a built-in primitive
    // nor repeat an earlier row — the colliding row is dropped, never merged.
    if (seen.has(id)) {
      problems.push(
        `${at} id '${id}' collides with ${TRIAGE_BUILTIN_IDS.includes(id as TriageBuiltinId) ? "a built-in primitive" : "an earlier declared row"} — the row is ignored`,
      );
      return;
    }
    const action = r.action;
    if (typeof action !== "string" || !ACTIONS.includes(action as TriageAction)) {
      problems.push(`${at} ('${id}') action must be one of ${ACTIONS.join(" / ")}`);
      return;
    }
    const a = action as TriageAction;
    const rowProblems: string[] = [];
    const has = (k: string) => r[k] !== undefined;

    if (typeof r.label !== "undefined" && typeof r.label !== "string") rowProblems.push("label must be a string");
    if (typeof r.description !== "undefined" && typeof r.description !== "string") {
      rowProblems.push("description must be a string");
    }
    if (has("patch")) {
      const bad = patchObjectProblem(r.patch);
      if (bad) rowProblems.push(`patch ${bad}`);
    }
    if (has("destination")) {
      if (typeof r.destination !== "string" || r.destination === "") rowProblems.push("destination must be a non-empty string");
      else {
        const bad = destinationProblem((r.destination as string).replace(/\/+$/, ""));
        if (bad) rowProblems.push(`destination ${bad}`);
      }
    }
    if (has("inPlace") && typeof r.inPlace !== "boolean") rowProblems.push("inPlace must be a boolean");
    if (has("choice") && (typeof r.choice !== "string" || (r.choice as string).trim() === "")) {
      rowProblems.push("choice must be a non-empty string (a QuickAdd choice name or id)");
    }

    // Per-action shape rules — one way to say each thing:
    if (a === "trash" && (has("patch") || has("destination") || has("inPlace") || has("choice"))) {
      rowProblems.push("a trash row takes no patch/destination/inPlace/choice");
    }
    if (a === "move") {
      if (has("choice")) rowProblems.push("a move row takes no choice");
      if (has("inPlace")) rowProblems.push("a move row takes no inPlace (moves never stay in place)");
    }
    if (a === "stamp") {
      if (has("choice")) rowProblems.push("a stamp row takes no choice");
      if (!has("patch") || Object.keys((r.patch as Record<string, unknown>) ?? {}).length === 0) {
        rowProblems.push("a stamp row needs a non-empty patch (that is what stamping means)");
      }
      if (r.inPlace === true && has("destination")) {
        rowProblems.push("inPlace: true and a destination contradict — pick one");
      }
    }
    if (a === "choice") {
      if (!has("choice")) rowProblems.push("a choice row needs a `choice` binding (a QuickAdd choice name or id)");
      if (has("patch") || has("destination") || has("inPlace")) {
        rowProblems.push("a choice row takes no patch/destination/inPlace — the bound choice does the work");
      }
    }

    if (rowProblems.length > 0) {
      problems.push(...rowProblems.map((p) => `${at} ('${id}') ${p} — the row is ignored`));
      return;
    }
    seen.add(id);
    rows.push({
      id,
      ...(typeof r.label === "string" ? { label: r.label } : {}),
      ...(typeof r.description === "string" ? { description: r.description } : {}),
      action: a,
      ...(has("patch") ? { patch: r.patch as Record<string, unknown> } : {}),
      ...(has("destination") ? { destination: (r.destination as string).replace(/\/+$/, "") } : {}),
      ...(has("inPlace") ? { inPlace: r.inPlace as boolean } : {}),
      ...(has("choice") ? { choice: (r.choice as string).trim() } : {}),
    });
  });
  return { rows, problems };
}

// ── built-in description overrides ──────────────────────────────────────────

export function builtinDescriptionsOf(value: unknown): {
  overrides: Partial<Record<TriageBuiltinId, string>>;
  problems: string[];
} {
  if (value === undefined || value === "") return { overrides: {}, problems: [] };
  if (typeof value !== "string") return { overrides: {}, problems: ["builtinDescriptions must be a JSON object string"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return {
      overrides: {},
      problems: [`builtinDescriptions is not valid JSON (${e instanceof Error ? e.message : String(e)})`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { overrides: {}, problems: ["builtinDescriptions must be a JSON OBJECT mapping built-in id to text"] };
  }
  const problems: string[] = [];
  const overrides: Partial<Record<TriageBuiltinId, string>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TRIAGE_BUILTIN_IDS.includes(k as TriageBuiltinId)) {
      problems.push(`builtinDescriptions key '${k}' is not a built-in disposition (${TRIAGE_BUILTIN_IDS.join(", ")})`);
      continue;
    }
    if (typeof v !== "string" || v.trim() === "") {
      problems.push(`builtinDescriptions['${k}'] must be a non-empty string`);
      continue;
    }
    overrides[k as TriageBuiltinId] = v;
  }
  return { overrides, problems };
}

// ── named queues ────────────────────────────────────────────────────────────

export function queuesOf(value: unknown): { queues: TriageQueueDecl[]; problems: string[] } {
  if (value === undefined || value === "") return { queues: [], problems: [] };
  if (typeof value !== "string") return { queues: [], problems: ["queues must be a JSON array string"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    return { queues: [], problems: [`queues is not valid JSON (${e instanceof Error ? e.message : String(e)})`] };
  }
  if (!Array.isArray(parsed)) return { queues: [], problems: ["queues must be a JSON ARRAY of {id, base, view?} rows"] };
  const problems: string[] = [];
  const queues: TriageQueueDecl[] = [];
  const seen = new Set<string>();
  parsed.forEach((raw, i) => {
    const at = `queues[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`${at} must be an object row {id, base, view?}`);
      return;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.trim() === "") {
      problems.push(`${at} needs a non-empty string id`);
      return;
    }
    if (seen.has(r.id)) {
      problems.push(`${at} id '${r.id}' repeats an earlier queue — the row is ignored`);
      return;
    }
    if (typeof r.base !== "string" || !r.base.endsWith(".base")) {
      problems.push(`${at} ('${r.id}') base must be a vault-relative .base path — the row is ignored`);
      return;
    }
    if (r.view !== undefined && (typeof r.view !== "string" || r.view === "")) {
      problems.push(`${at} ('${r.id}') view must be a non-empty string when present — the row is ignored`);
      return;
    }
    seen.add(r.id);
    queues.push({ id: r.id, base: r.base, ...(r.view !== undefined ? { view: r.view as string } : {}) });
  });
  return { queues, problems };
}

// ── validation + coercion (both defined over the shared parsers) ────────────

const PATCH_KEYS = ["stampFrontmatter", "escalateFrontmatter"] as const;

/** Manifest `validate` — findings reported to the settings tab and
 * registry.problems, never thrown. Loud about every malformed value. Unknown
 * keys — including the retired phase-2 destination/patch keys — are ignored
 * (the documented migration posture). */
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
  for (const key of PATCH_KEYS) {
    const v = config[key];
    if (v === undefined) continue;
    const r = parseFrontmatterPatch(v);
    if ("problem" in r) problems.push(`${key} ${r.problem}`);
  }
  problems.push(...prefixListOf("moveWhitelist", config.moveWhitelist).problems);
  problems.push(...prefixListOf("moveBlacklist", config.moveBlacklist).problems);
  problems.push(...declaredRowsOf(config.declaredDispositions).problems);
  problems.push(...builtinDescriptionsOf(config.builtinDescriptions).problems);
  problems.push(...queuesOf(config.queues).problems);
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
  const patch = (key: (typeof PATCH_KEYS)[number]): Record<string, unknown> => {
    const r = parseFrontmatterPatch(config[key]);
    if ("patch" in r) return r.patch;
    const fallback = parseFrontmatterPatch(DEFAULT_TRIAGE_CONFIG[key]);
    return "patch" in fallback ? fallback.patch : {};
  };
  return {
    inboxMarkers: markers.length > 0 ? markers : (DEFAULT_TRIAGE_CONFIG.inboxMarkers as string[]),
    stampFrontmatter: patch("stampFrontmatter"),
    escalateFrontmatter: patch("escalateFrontmatter"),
    moveWhitelist: prefixListOf("moveWhitelist", config.moveWhitelist).list,
    moveBlacklist: prefixListOf("moveBlacklist", config.moveBlacklist).list,
    declared: declaredRowsOf(config.declaredDispositions).rows,
    builtinDescriptions: builtinDescriptionsOf(config.builtinDescriptions).overrides,
    queues: queuesOf(config.queues).queues,
  };
}
