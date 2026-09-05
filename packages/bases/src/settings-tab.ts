// settings-tab.ts — the plugin's own settings tab.
//
// While the Bases surface was a capability module inside the Governor host, its
// configuration was rendered by the host's generic, manifest-driven config tab.
// A satellite has no such host, so it renders its own. The FIELDS themselves
// (keys, labels, help text) live in settings.ts as pure data, so they stay
// headless-testable and the tab is only the rendering.
//
// Validation is LOUD, never coercing: `validateBasesConfig` (the same function
// the host's manifest used) reports an out-of-range timeout or a non-integer
// row cap under the fields rather than silently substituting a default, so the
// user sees the consequence of what they typed.

import { PluginSettingTab, Setting, type App } from "obsidian";
import { BASES_FIELDS } from "./settings.js";
import { DEFAULT_BASES_CONFIG, validateBasesConfig } from "./kernel/index.js";

/** What the tab needs from the plugin — kept structural so the tab never
 *  imports main.ts (and main.ts's import of the tab stays one-directional). */
export interface BasesSettingsHost {
  getConfig(): Record<string, unknown>;
  setConfig(key: string, value: unknown): Promise<void>;
  /** Whether the running Obsidian exposes the public Bases API (1.10+). The
   *  tab says so plainly: an enabled plugin on a pre-1.10 Obsidian publishes
   *  NOTHING, which is otherwise indistinguishable from a broken install. */
  basesApiAvailable(): boolean;
}

export class BasesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: BasesSettingsHost, pluginRef: import("obsidian").Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const config = this.host.getConfig();
    const defaults = DEFAULT_BASES_CONFIG as unknown as Record<string, unknown>;
    /** The effective value: the user's override, else the shipped default. */
    const valueOf = (key: string): unknown => (config[key] !== undefined ? config[key] : defaults[key]);

    for (const field of BASES_FIELDS) {
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
            // `validateBasesConfig` then names it under the fields, and
            // `basesConfigOf` falls back to the default at use time. A silent
            // coercion here would hide the typo.
            void this.host.setConfig(field.key, Number.isFinite(n) ? n : raw);
            return;
          }
          void this.host.setConfig(field.key, raw);
        }),
      );
    }

    const problems = validateBasesConfig(config);
    if (problems.length) {
      const box = containerEl.createDiv({ cls: "mod-warning" });
      box.createEl("p", { text: "Configuration problems:" });
      const list = box.createEl("ul");
      for (const problem of problems) list.createEl("li", { text: problem });
    }

    // The Bases API gate, said out loud. An enabled plugin on a pre-1.10
    // Obsidian is ABSENT, not broken (the fileclass precedent) — and because
    // the gate is now evaluated at publish time rather than per connection, an
    // upgrade needs a plugin reload before the tools appear.
    if (!this.host.basesApiAvailable()) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "This Obsidian does not expose the public Bases API (1.10+), or the Bases core plugin is turned off. No tools are published while that is true. If you have just upgraded or re-enabled Bases, reload this plugin — the check runs when the tools are published, not on every MCP connection.",
      });
    }

    // The host is REQUIRED, as it is for the triage and cross-session
    // satellites: this plugin's whole surface is the two published tools —
    // there is no pane, no command, no ribbon. Say so rather than leaving a
    // user to wonder why nothing happens.
    const hostLoaded = !!(this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins?.["governor"];
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: hostLoaded
        ? "Governor is installed: the vault_bases_list and vault_bases_query MCP tools are published to it. Under an active Governor path allowlist, vault_bases_list is refused outright — it takes no arguments, so there is nothing to scope by — while vault_bases_query is scoped by its `path` argument (a hidden `.base` refuses out_of_allowlist). Result ROWS are not filtered: the host scopes the base you name, not the notes the engine returns. Both tools declare read-only, which Governor distrusts unless `vault-bases` is listed in its trustedReadOnlyPlugins setting; untrusted, read-only mode blocks both."
        : "Governor is NOT installed. This plugin's entire surface is the two MCP tools it publishes to the Governor host, so nothing here does anything until Governor is installed and enabled.",
    });
  }
}
