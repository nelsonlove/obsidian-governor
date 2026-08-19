// settings.ts — the `modules` section of plugin settings: per-module enabled
// override + config, keyed by module id. Pure data + a merge helper; the
// interpretation (which ids exist, what config means) belongs to
// ModuleRegistry and to each module's own settingsSchema.

/** One module's row in plugin settings. Both halves optional: an absent row
 * means "module defaults apply". */
export interface ModuleInstanceSettings {
  /** Overrides the module's default `enabled` when present. */
  enabled?: boolean;
  /** User configuration, merged OVER the module's `settingsSchema.defaults`. */
  config?: Record<string, unknown>;
}

/** The whole `modules` settings section: module id → its row. */
export type ModuleSettings = Record<string, ModuleInstanceSettings>;

export const DEFAULT_MODULE_SETTINGS: ModuleSettings = {};

/**
 * 0.12.0 module-id rename (`governance` → `acceptance`): a data.json written
 * by ≤0.11.x stores the acceptance module's row under the historical id
 * `governance`. Adopt that row under the new id exactly once — only when no
 * `acceptance` row exists yet (a present new row always wins; the legacy row
 * may never overwrite newer config) — and drop the legacy key from the
 * returned object, so the next settings save persists the new shape and the
 * migration never re-runs. Live config (enabled, acceptedBy, gateMode,
 * requiredFrontmatterKeys, badge prefs) rides across verbatim: the row object
 * is adopted as-is, not rebuilt field by field. Returns the SAME object when
 * there is nothing to migrate, so a post-rename load stays byte-identical.
 */
export function migrateLegacyModuleIds(modules: ModuleSettings | undefined): ModuleSettings {
  const m = modules ?? {};
  if (m.acceptance === undefined && m.governance !== undefined) {
    const { governance, ...rest } = m;
    return { ...rest, acceptance: governance };
  }
  return m;
}

/** The module's defaults with the user's config layered on top. Shallow by
 * design — a module wanting deep-merge semantics owns them in its own
 * `validate`/`register`; the host stays ignorant of config shapes. */
export function mergeModuleConfig(
  defaults: Record<string, unknown> | undefined,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(defaults ?? {}), ...(config ?? {}) };
}
