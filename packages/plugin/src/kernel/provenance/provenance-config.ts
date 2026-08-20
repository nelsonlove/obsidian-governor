// provenance-config.ts — the provenance module's configuration shape and the
// pure mapping from a stored `modules.provenance.config` record to a typed
// ProvenanceConfig. Obsidian-free (no imports at all), so it moves with the
// rest of the pure core and is headless-testable.
//
// In the standalone `obsidian-provenance` CLI these were constants in
// `plugins.py` (`DEFAULT_NOTES_DIR`) and `render.py` (the generator +
// derivation-mode strings baked into the rendered audit frontmatter). Here the
// notes-dir becomes a config field (the one thing that varies per vault); the
// generator name and derivation mode stay constants — they identify the audit
// artifact's producer and are not a user knob.

/** The plugin-notes directory the reconcile/regen audit scans, matching the
 *  Python `DEFAULT_NOTES_DIR`. */
export const DEFAULT_NOTES_DIR = "08.10 Obsidian plugins";

/** The `generator:` stamp on the rendered audit note — identifies what produced
 *  the derived artifact. Constant (Python `render.py`). */
export const AUDIT_GENERATOR = "obsidian-plugin-audit";

/** The `derivation-mode:` stamp on the rendered audit note. Constant. A
 *  DERIVATION field — orthogonal to acceptance; the accept-guard never lets a
 *  regen write an `accepted`-family field. */
export const AUDIT_DERIVATION_MODE = "snapshot";

/**
 * The audit note's own `derived-from` entries, for a given notes dir — the ONE
 * definition of what the audit is derived from.
 *
 * `renderAudit` emits this list into the note's frontmatter and `regenerateAudit`
 * resolves the SAME list to count the sources it stamps as
 * `derived-source-count`, so the witness can never describe a different set from
 * the one `provenance_check` will later resolve.
 */
export function auditDerivedFrom(notesDir: string = DEFAULT_NOTES_DIR): string[] {
  return [`${notesDir}/*.md`, ".obsidian/plugins/*/manifest.json", ".obsidian/community-plugins.json"];
}

/** The provenance module's config, stored under `modules.provenance.config` and
 *  merged over the manifest defaults. */
export interface ProvenanceConfig {
  /** The plugin-notes directory reconcile/regen audit. `~`-expansion does NOT
   *  apply — this is a vault-relative path, not a filesystem one. */
  notesDir: string;
}

/** The module's config defaults. Fed to the manifest as `config.defaults`, so
 *  the config tab renders them and `register()` receives them merged under any
 *  user override. */
export const DEFAULT_PROVENANCE_CONFIG: ProvenanceConfig = {
  notesDir: DEFAULT_NOTES_DIR,
};

/** Coerce a merged config record (defaults + user override, as `register()`
 *  receives it) into a typed ProvenanceConfig, falling back to the default for
 *  a value of the wrong shape — a hand-edited data.json must never crash a
 *  tool, only degrade to the default (the skills/vocab/scheme skip-and-report
 *  discipline). A blank notesDir degrades to the default too: an empty vault
 *  path would resolve the audit to the vault root, not what any user means. */
export function provenanceConfigOf(config: Record<string, unknown>): ProvenanceConfig {
  const raw = config.notesDir;
  const picked = typeof raw === "string" && raw.trim() !== "" ? raw : DEFAULT_PROVENANCE_CONFIG.notesDir;
  // Strip trailing slash(es): a `Meta/Plugins/` config value would otherwise
  // make `auditPath` interpolate `Meta/Plugins//Plugins.md`, which Obsidian's
  // getAbstractFileByPath never matches (it stores the single-slash form) —
  // silently breaking human-section preservation and the create-vs-modify
  // branch on `provenance_regen --write`.
  const notesDir = picked.replace(/\/+$/, "") || DEFAULT_PROVENANCE_CONFIG.notesDir;
  return { notesDir };
}

/** Validate a merged config for the config tab (manifest.config.validate).
 *  Loud, never coercing: a blank notes-dir is REPORTED so the user sees the
 *  consequence (it would resolve the audit note to the vault root). An absolute
 *  path is rejected — the notes-dir is vault-relative. */
export function validateProvenanceConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const raw = config.notesDir;
  if (raw !== undefined) {
    if (typeof raw !== "string") {
      problems.push("notesDir must be a string (a vault-relative folder path)");
    } else if (raw.trim() === "") {
      problems.push("notesDir must not be blank — it is the vault-relative plugin-notes folder the audit scans");
    } else if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
      problems.push("notesDir must be vault-relative, not an absolute filesystem path");
    }
  }
  return problems;
}
