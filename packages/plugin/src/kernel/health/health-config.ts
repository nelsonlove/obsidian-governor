// health-config.ts — the health module's configuration shape and the pure
// mapping from a stored `modules.health.config` record to a typed HealthConfig.
// Obsidian-free (no imports at all), so it moves with the rest of the pure core
// and is headless-testable.
//
// In the standalone `obsidian-vault-health` scanner this was one env var,
// `VAULT_HEALTH_EMPTY_CHARS` (default 40) — the body-character count (frontmatter
// excluded) at/under which a note counts as empty / near-empty. Here it becomes
// the module's single config field. It is also the floor the duplicate-body tier
// uses to skip near-empty twins (identical stubs are not an interesting duplicate
// group), exactly as the standalone's classifier did.

/** The empty-note body-character threshold, matching the Python
 *  `VAULT_HEALTH_EMPTY_CHARS` default. A note whose frontmatter-stripped, trimmed
 *  body is at/under this many characters counts as empty / near-empty. */
export const DEFAULT_EMPTY_CHARS = 40;

/** The health module's config, stored under `modules.health.config` and merged
 *  over the manifest defaults. */
export interface HealthConfig {
  /** Body characters (frontmatter excluded) at/under which a note is empty. */
  emptyChars: number;
}

/** The module's config defaults. Fed to the manifest as `config.defaults`, so
 *  the config tab renders them and `register()` receives them merged under any
 *  user override. */
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  emptyChars: DEFAULT_EMPTY_CHARS,
};

/** Coerce a merged config record (defaults + user override, as `register()`
 *  receives it) into a typed HealthConfig, falling back to the default for a
 *  value of the wrong shape — a hand-edited data.json must never crash a tool,
 *  only degrade to the default (the provenance/skills/vocab skip-and-report
 *  discipline). A non-integer, negative, or non-finite threshold degrades to the
 *  default; a fractional value is floored (a char count is a whole number). */
export function healthConfigOf(config: Record<string, unknown>): HealthConfig {
  const raw = config.emptyChars;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  const emptyChars = Number.isFinite(n) && n >= 0 ? n : DEFAULT_HEALTH_CONFIG.emptyChars;
  return { emptyChars };
}

/** Validate a merged config for the config tab (manifest.config.validate). Loud,
 *  never coercing: a threshold of the wrong type or a negative one is REPORTED so
 *  the user sees the consequence, rather than silently snapping to the default. */
export function validateHealthConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const raw = config.emptyChars;
  if (raw !== undefined) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      problems.push("emptyChars must be a number (body characters at/under which a note counts as empty)");
    } else if (raw < 0) {
      problems.push("emptyChars must not be negative");
    } else if (!Number.isInteger(raw)) {
      problems.push("emptyChars must be a whole number of characters");
    }
  }
  return problems;
}
