// settings-tab.ts — the plugin's own settings tab.
//
// While the compiler was a capability module inside the Governor host, its
// configuration was rendered by the host's generic, manifest-driven config tab.
// A satellite has no such host, so it renders its own — which is what the
// standalone vault-skills plugin did before the fold. The FIELDS themselves
// (keys, labels, help text) live in settings.ts as pure data, so they stay
// headless-testable and the tab is only the rendering.
//
// Validation is LOUD, never coercing: `validateSkillsConfig` (the same function
// the host's manifest used) reports an empty plugin name or an out-of-range
// value under the fields rather than silently substituting a default, so the
// user sees the consequence of what they typed.

import { PluginSettingTab, Setting, type App } from "obsidian";
import { SKILLS_FIELDS } from "./settings.js";
import { DEFAULT_SKILLS_CONFIG, validateSkillsConfig } from "./kernel/index.js";

/** What the tab needs from the plugin — kept structural so the tab never
 *  imports main.ts (and main.ts's import of the tab stays one-directional). */
export interface SkillsSettingsHost {
  getConfig(): Record<string, unknown>;
  setConfig(key: string, value: unknown): Promise<void>;
}

export class SkillsSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SkillsSettingsHost, private readonly pluginRef: import("obsidian").Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const config = this.host.getConfig();
    /** The effective value: the user's override, else the shipped default. */
    const valueOf = (key: string): unknown =>
      config[key] !== undefined ? config[key] : (DEFAULT_SKILLS_CONFIG as unknown as Record<string, unknown>)[key];

    for (const field of SKILLS_FIELDS) {
      const setting = new Setting(containerEl).setName(field.label).setDesc(field.help);
      const commit = (value: unknown) => void this.host.setConfig(field.key, value);
      if (field.type === "toggle") {
        setting.addToggle((t) => t.setValue(valueOf(field.key) === true).onChange(commit));
      } else if (field.type === "select") {
        setting.addDropdown((d) => {
          for (const option of field.options ?? []) d.addOption(option, option);
          d.setValue(String(valueOf(field.key) ?? "")).onChange(commit);
        });
      } else if (field.type === "number") {
        setting.addText((t) =>
          t.setValue(String(valueOf(field.key) ?? "")).onChange((raw) => {
            const n = Number(raw);
            // A blank box clears the override (back to the default); anything
            // unparseable is left alone rather than persisted as NaN.
            if (raw.trim() === "") commit(undefined);
            else if (Number.isFinite(n)) commit(n);
          }),
        );
      } else {
        setting.addText((t) => t.setValue(String(valueOf(field.key) ?? "")).onChange(commit));
      }
    }

    const problems = validateSkillsConfig(config);
    if (problems.length) {
      const box = containerEl.createDiv({ cls: "mod-warning" });
      box.createEl("p", { text: "Configuration problems:" });
      const list = box.createEl("ul");
      for (const problem of problems) list.createEl("li", { text: problem });
    }

    // The host is optional (see main.ts). Say so here rather than leaving a
    // user to wonder why the tools are missing from an agent session.
    const hostLoaded = !!(this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins?.["governor"];
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: hostLoaded
        ? "Governor is installed: the six vault_skills_* MCP tools are published to it. Note that under an active Governor path allowlist all of them except vault_skills_mark are refused — they carry no path argument to scope."
        : "Governor is not installed. The pane, commands, and export all still work; only the six vault_skills_* MCP tools are unpublished.",
    });
  }
}
