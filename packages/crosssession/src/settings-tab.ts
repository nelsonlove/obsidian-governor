// settings-tab.ts — the plugin's own settings tab.
//
// While the cross-session surface was a capability module inside the Governor
// host, its configuration was rendered by the host's generic, manifest-driven
// config tab. A satellite has no such host, so it renders its own. The FIELDS
// themselves (keys, labels, help text) live in settings.ts as pure data, so
// they stay headless-testable and the tab is only the rendering.
//
// Validation is LOUD, never coercing: `validateCrosssessionConfig` (the same
// function the host's manifest used) reports a non-string fileClass or an
// out-of-range cap under the fields rather than silently substituting a
// default, so the user sees the consequence of what they typed.

import { PluginSettingTab, Setting, type App } from "obsidian";
import { CROSSSESSION_FIELDS } from "./settings.js";
import { DEFAULT_CROSSSESSION_CONFIG, validateCrosssessionConfig } from "./kernel/index.js";

/** What the tab needs from the plugin — kept structural so the tab never
 *  imports main.ts (and main.ts's import of the tab stays one-directional). */
export interface CrosssessionSettingsHost {
  getConfig(): Record<string, unknown>;
  setConfig(key: string, value: unknown): Promise<void>;
}

export class CrosssessionSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: CrosssessionSettingsHost, pluginRef: import("obsidian").Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const config = this.host.getConfig();
    const defaults = DEFAULT_CROSSSESSION_CONFIG as unknown as Record<string, unknown>;
    /** The effective value: the user's override, else the shipped default. */
    const valueOf = (key: string): unknown => (config[key] !== undefined ? config[key] : defaults[key]);

    for (const field of CROSSSESSION_FIELDS) {
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
            // `validateCrosssessionConfig` then names it under the fields, and
            // `crosssessionConfigOf` falls back to the default at use time. A
            // silent coercion here would hide the typo.
            void this.host.setConfig(field.key, Number.isFinite(n) ? n : raw);
            return;
          }
          void this.host.setConfig(field.key, raw);
        }),
      );
    }

    const problems = validateCrosssessionConfig(config);
    if (problems.length) {
      const box = containerEl.createDiv({ cls: "mod-warning" });
      box.createEl("p", { text: "Configuration problems:" });
      const list = box.createEl("ul");
      for (const problem of problems) list.createEl("li", { text: problem });
    }

    // The host is REQUIRED, as it is for the triage satellite: this plugin's
    // whole surface is the four published tools — there is no pane, no command,
    // no ribbon. Say so rather than leaving a user to wonder why nothing
    // happens.
    const hostLoaded = !!(this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins?.["governor"];
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: hostLoaded
        ? "Governor is installed: the vault_crosssession_channels, _delta, _attest and _post MCP tools are published to it. Note that under an active Governor path allowlist ALL FOUR are refused — none of them carries a path argument to scope by (a channel reference is a uid or a folder, not a path)."
        : "Governor is NOT installed. This plugin's entire surface is the four MCP tools it publishes to the Governor host, so nothing here does anything until Governor is installed and enabled.",
    });
  }
}
