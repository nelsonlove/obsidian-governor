// settings-styles.ts — the tabbed settings tab's stylesheet, shipped as an
// injected <style> element rather than a standalone styles.css.
//
// Why injected, not a styles.css file: this plugin has no CSS-loading path
// today (no styles.css, no <style> injection) and its build/install flow is
// `cp main.js manifest.json …` — esbuild emits only main.js, so a sibling
// styles.css would never reach the installed plugin dir. Bundling the CSS into
// main.js via this module is the one way the styling is guaranteed to ship with
// the plugin. The CSS is theme-aware (leans entirely on Obsidian's own CSS
// variables, so it follows the active light/dark theme) and scoped under the
// top-level `.vault-mcp-settings` wrapper so nothing leaks to the rest of the
// app. Class names mirror the TaskNotes settings-tab convention
// (`settings-tab-*` + `settings-view__tab-*`, plus Obsidian's native
// `vertical-tab-nav-item`) so the tabs read as native.

/** Stable id of the single injected <style>; the injector is idempotent on it,
 * so re-opening the settings tab never stacks duplicate stylesheets. */
export const SETTINGS_STYLE_ID = "vault-mcp-settings-styles";

/** The plugin stylesheet: the tabbed settings tab (scoped under
 * `.vault-mcp-settings`) plus the dev tool-runner's modal styles (scoped by
 * the `vault-mcp-runner-` class prefix — modals render outside the settings
 * wrapper, so they carry their own prefix instead). */
export const SETTINGS_STYLES = `
.vault-mcp-settings .settings-view__tab-nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-1, 4px);
  margin-bottom: var(--size-4-4, 16px);
  padding-bottom: var(--size-4-2, 8px);
  border-bottom: 1px solid var(--background-modifier-border);
}
.vault-mcp-settings .settings-view__tab-button {
  background: transparent;
  color: var(--text-muted);
  border: none;
  box-shadow: none;
  border-radius: var(--radius-s, 4px);
  padding: var(--size-4-1, 4px) var(--size-4-3, 12px);
  font-size: var(--font-ui-small, 13px);
  cursor: pointer;
}
.vault-mcp-settings .settings-view__tab-button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.vault-mcp-settings .settings-view__tab-button--active,
.vault-mcp-settings .settings-view__tab-button.is-active {
  background: var(--background-primary);
  color: var(--text-normal);
}
.vault-mcp-settings .settings-view__tab-content {
  display: none;
}
.vault-mcp-settings .settings-view__tab-content--active {
  display: block;
  animation: vault-mcp-settings-fade-in 0.2s ease-in-out;
}
@keyframes vault-mcp-settings-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .vault-mcp-settings .settings-view__tab-content--active {
    animation: none;
  }
}

/* ── dev tool-runner modals (src/tool-runner.ts) ─────────────────────────────
   Scoped by the vault-mcp-runner-* prefix; theme-aware via Obsidian's own CSS
   variables, like the tab styles above. */
.vault-mcp-runner-item-head {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-2, 8px);
}
.vault-mcp-runner-item-name {
  font-family: var(--font-monospace);
  font-size: var(--font-ui-small, 13px);
}
.vault-mcp-runner-item-title {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller, 12px);
}
.vault-mcp-runner-badge {
  font-size: var(--font-ui-smaller, 12px);
  border-radius: var(--radius-s, 4px);
  padding: 0 var(--size-4-1, 4px);
}
.vault-mcp-runner-badge--read {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}
.vault-mcp-runner-badge--write {
  background: var(--background-modifier-error);
  color: var(--text-on-accent, var(--text-normal));
}
.vault-mcp-runner-item-desc {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller, 12px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vault-mcp-runner-desc {
  color: var(--text-muted);
}
.vault-mcp-runner-warning {
  border: 1px solid var(--background-modifier-error);
  border-radius: var(--radius-s, 4px);
  padding: var(--size-4-2, 8px);
  margin: var(--size-4-2, 8px) 0;
  color: var(--text-error);
}
.vault-mcp-runner-error-banner {
  border: 1px solid var(--background-modifier-error);
  background: var(--background-modifier-error-hover, transparent);
  border-radius: var(--radius-s, 4px);
  padding: var(--size-4-2, 8px);
  margin-bottom: var(--size-4-2, 8px);
  color: var(--text-error);
  font-family: var(--font-monospace);
  font-size: var(--font-ui-small, 13px);
  word-break: break-word;
}
.vault-mcp-runner-error-line {
  color: var(--text-error);
  font-size: var(--font-ui-small, 13px);
}
.vault-mcp-runner-meta {
  color: var(--text-faint);
  font-size: var(--font-ui-smaller, 12px);
}
.vault-mcp-runner-section {
  margin-top: var(--size-4-3, 12px);
  font-weight: 600;
  font-size: var(--font-ui-small, 13px);
}
.vault-mcp-runner-pre {
  max-height: 12em;
  overflow: auto;
  background: var(--background-secondary);
  border-radius: var(--radius-s, 4px);
  padding: var(--size-4-2, 8px);
  font-size: var(--font-ui-smaller, 12px);
  user-select: text;
}
.vault-mcp-runner-pre--result {
  max-height: 24em;
}
.vault-mcp-runner-json {
  width: 100%;
  font-family: var(--font-monospace);
}
`;

/** Inject the stylesheet once into `doc.head`. Idempotent by `SETTINGS_STYLE_ID`
 * — a no-op if it's already present, so re-rendering the settings tab never
 * duplicates it. Kept out of module scope (no `document` access at import time)
 * so `connection-ui.ts` stays loadable under the headless obsidian stub. */
export function ensureSettingsStyles(doc: Document = document): void {
  if (doc.getElementById(SETTINGS_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SETTINGS_STYLE_ID;
  style.textContent = SETTINGS_STYLES;
  doc.head.appendChild(style);
}
