// settings-tab.ts — the plugin's own settings tab.
//
// While the health scan was a capability module inside the Governor host, its
// configuration was rendered by the host's generic, manifest-driven config tab. A
// satellite has no such host, so it renders its own. The FIELDS themselves (key,
// label, help text) live in settings.ts as pure data, so they stay
// headless-testable and the tab is only the rendering.
//
// Validation is LOUD, never coercing: `validateHealthConfig` (the same function
// the host's manifest used) reports a non-numeric, negative or fractional
// threshold under the field rather than silently substituting the default, so the
// user sees the consequence of what they typed.

import { PluginSettingTab, Setting, type App } from "obsidian";
import { HEALTH_FIELDS } from "./settings.js";
import { DEFAULT_HEALTH_CONFIG, validateHealthConfig } from "./kernel/index.js";

/** What the tab needs from the plugin — kept structural so the tab never imports
 *  main.ts (and main.ts's import of the tab stays one-directional). */
export interface HealthSettingsHost {
  getConfig(): Record<string, unknown>;
  setConfig(key: string, value: unknown): Promise<void>;
}

export class HealthSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: HealthSettingsHost, pluginRef: import("obsidian").Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const config = this.host.getConfig();
    const defaults = DEFAULT_HEALTH_CONFIG as unknown as Record<string, unknown>;
    /** The effective value: the user's override, else the shipped default. */
    const valueOf = (key: string): unknown => (config[key] !== undefined ? config[key] : defaults[key]);

    for (const field of HEALTH_FIELDS) {
      const setting = new Setting(containerEl).setName(field.label).setDesc(field.help);
      setting.addText((t) =>
        t.setValue(String(valueOf(field.key) ?? "")).onChange((raw) => {
          // A blank box clears the override so the shipped default applies
          // again — persisting "" or NaN would be a value, not a reset.
          if (raw.trim() === "") {
            void this.host.setConfig(field.key, undefined);
            return;
          }
          if (field.type === "number") {
            const n = Number(raw);
            // A non-numeric entry is stored VERBATIM rather than swallowed:
            // `validateHealthConfig` then names it under the field, and
            // `healthConfigOf` falls back to the default at use time. A silent
            // coercion here would hide the typo.
            void this.host.setConfig(field.key, Number.isFinite(n) ? n : raw);
            return;
          }
          void this.host.setConfig(field.key, raw);
        }),
      );
    }

    const problems = validateHealthConfig(config);
    if (problems.length) {
      const box = containerEl.createDiv({ cls: "mod-warning" });
      box.createEl("p", { text: "Configuration problems:" });
      const list = box.createEl("ul");
      for (const problem of problems) list.createEl("li", { text: problem });
    }

    // The host is REQUIRED, as it is for the triage and crosssession satellites:
    // this plugin's whole surface is the two published tools — there is no pane,
    // no command, no ribbon. Say so rather than leaving a user to wonder why
    // nothing happens.
    const hostLoaded = !!(this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins?.["governor"];
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: hostLoaded
        ? "Governor is installed: the vault_health_scan and vault_health_lint MCP tools are published to it (they were obsidian_health and obsidian_lint while this shipped inside Governor). Note that under an active Governor path allowlist BOTH are refused — neither carries a path argument to scope by, and the scan reads the whole vault by design."
        : "Governor is NOT installed. This plugin's entire surface is the two MCP tools it publishes to the Governor host, so nothing here does anything until Governor is installed and enabled.",
    });
  }
}
