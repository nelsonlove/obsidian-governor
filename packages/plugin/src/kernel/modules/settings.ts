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

/** The module's defaults with the user's config layered on top. Shallow by
 * design — a module wanting deep-merge semantics owns them in its own
 * `validate`/`register`; the host stays ignorant of config shapes. */
export function mergeModuleConfig(
  defaults: Record<string, unknown> | undefined,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(defaults ?? {}), ...(config ?? {}) };
}
