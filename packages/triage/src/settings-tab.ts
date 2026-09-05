// settings-tab.ts — the plugin's own settings tab.
//
// While triage was a capability module inside the Governor host, its
// configuration was rendered by the host's generic, manifest-driven config tab.
// A satellite has no such host, so it renders its own. The FIELDS themselves
// (keys, labels, help text, caveats) live in settings.ts as pure data, so they
// stay headless-testable and the tab is only the rendering.
//
// Validation is LOUD, never coercing: `validateTriageConfig` (the same function
// the host's manifest used) reports a malformed patch, a colliding declared row
// id or an unusable destination under the fields rather than silently
// substituting a default, so the user sees the consequence of what they typed.
// That matters more here than in most tabs: a silently-dropped `moveBlacklist`
// prefix is a bound that is no longer enforced.
//
// `lines` fields are a textarea, one prefix per line — the shape the host's
// config tab used for the same keys, and the reason ADOPTABLE_KEYS carries
// arrays rather than strings for them.

import { PluginSettingTab, Setting, type App } from "obsidian";
import { TRIAGE_FIELDS } from "./settings.js";
import { DEFAULT_TRIAGE_CONFIG, validateTriageConfig } from "./kernel/index.js";

/** What the tab needs from the plugin — kept structural so the tab never
 *  imports main.ts (and main.ts's import of the tab stays one-directional). */
export interface TriageSettingsHost {
  getConfig(): Record<string, unknown>;
  setConfig(key: string, value: unknown): Promise<void>;
}

export class TriageSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: TriageSettingsHost, pluginRef: import("obsidian").Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const config = this.host.getConfig();
    /** The effective value: the user's override, else the shipped default. */
    const valueOf = (key: string): unknown =>
      config[key] !== undefined ? config[key] : DEFAULT_TRIAGE_CONFIG[key];

    for (const field of TRIAGE_FIELDS) {
      const desc = field.caveats?.length ? `${field.help} ${field.caveats.join(" ")}` : field.help;
      const setting = new Setting(containerEl).setName(field.label).setDesc(desc);
      if (field.type === "lines") {
        const current = valueOf(field.key);
        const text = Array.isArray(current) ? current.join("\n") : String(current ?? "");
        setting.addTextArea((t) =>
          t.setValue(text).onChange((raw) => {
            // A blank box clears the override so the shipped default applies
            // again — persisting an empty array would mean "no markers", which
            // is a different (and, for inboxMarkers, queue-emptying) thing.
            const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "");
            void this.host.setConfig(field.key, raw.trim() === "" ? undefined : lines);
          }),
        );
      } else {
        setting.addText((t) =>
          t.setValue(String(valueOf(field.key) ?? "")).onChange((raw) => {
            void this.host.setConfig(field.key, raw.trim() === "" ? undefined : raw);
          }),
        );
      }
    }

    const problems = validateTriageConfig(config);
    if (problems.length) {
      const box = containerEl.createDiv({ cls: "mod-warning" });
      box.createEl("p", { text: "Configuration problems:" });
      const list = box.createEl("ul");
      for (const problem of problems) list.createEl("li", { text: problem });
    }

    // The host is REQUIRED here, unlike the skills satellite: this plugin's
    // whole surface is the two published tools — there is no pane, no command,
    // no ribbon. Say so rather than leaving a user to wonder why nothing
    // happens.
    const hostLoaded = !!(this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins?.["governor"];
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: hostLoaded
        ? "Governor is installed: the vault_triage_queue and vault_triage_dispose MCP tools are published to it. Note that under an active Governor path allowlist vault_triage_queue is refused — it carries no path argument to scope by — while vault_triage_dispose is scoped by its `path` and `target_path` arguments."
        : "Governor is NOT installed. This plugin's entire surface is the two MCP tools it publishes to the Governor host, so nothing here does anything until Governor is installed and enabled.",
    });
  }
}
