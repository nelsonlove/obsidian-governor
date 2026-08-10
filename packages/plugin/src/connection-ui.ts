import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import type VaultMcpPlugin from "./main.js";
import { buildRegisterCommand } from "./register-command.js";
import { bridgeDestPath } from "./paths.js";
import { findClaudeBinary, claudeIsRegistered } from "./claude-cli.js";
import { DANGEROUS_LIST_DESC } from "./mcp/tools-cli.js";
import type { JdConfig } from "./kernel/scheme/jd.js";

/** Parse a comma-separated text field into a trimmed, non-empty string list.
 * An all-blank input (or one that trims to nothing) yields `undefined` rather
 * than `[]` — "blank means the provider default", matching the
 * contentDecimalFloor field's "blank = default" convention, not "explicitly
 * override to nothing". Pure so it's usable outside the (obsidian-only,
 * headlessly-untestable) settings tab if ever needed. */
export function parseCommaList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length === 0 ? undefined : items;
}

/** Parse the content-decimal-floor text field: blank -> undefined (provider
 * default applies), otherwise the parsed number (validated server-side by
 * validateJdConfig — this just avoids writing NaN into settings). */
export function parseFloorField(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isNaN(n) ? undefined : n;
}

export function registerCommandFor(app: App): string {
  // Pin the current vault so the command stays unambiguous once a second vault
  // starts serving MCP. To point Claude Code at a different vault, re-run this
  // from that vault (or edit the `--vault <name>` value in the registered config).
  return buildRegisterCommand({ bridgePath: bridgeDestPath(), vaultName: app.vault.getName() });
}

// Shown alongside the manual command so the pinned `--vault` isn't a surprise.
export const SWITCH_VAULT_NOTE =
  "This command pins Claude Code to this vault via `--vault`. To switch vaults later, run Connect from the other vault, or edit the `--vault <name>` value in the config.";

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice("Copied. Paste it in a terminal, then restart any open Claude Code session.");
}

export class ConnectionSetupModal extends Modal {
  constructor(app: App, private onAck?: () => void) { super(app); }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Connect vault-mcp to Claude Code (manual fallback)");
    contentEl.createEl("p", {
      text: "Couldn't auto-register (claude CLI not found or multiple vaults). Run this once in a terminal:",
    });
    const cmd = registerCommandFor(this.app);
    contentEl.createEl("pre").createEl("code", { text: cmd });
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const copyBtn = btns.createEl("button", { text: "Copy command", cls: "mod-cta" });
    copyBtn.onclick = () => copyToClipboard(cmd);
    const ackBtn = btns.createEl("button", { text: "I've run it — don't show again" });
    ackBtn.onclick = () => { this.onAck?.(); this.close(); };
    contentEl.createEl("p", { cls: "mod-warning", text: SWITCH_VAULT_NOTE });
    contentEl.createEl("p", {
      cls: "mod-warning",
      text: "Paste in a terminal where the `claude` CLI is available. Restart any running Claude Code session afterward.",
    });
  }
  onClose() { this.contentEl.empty(); }
}

export class VaultMcpSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultMcpPlugin) { super(app, plugin); }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Claude Code connection" });

    // Async status line: render placeholder then update after await.
    const statusEl = containerEl.createEl("p", { text: "Checking registration status…" });
    const bin = findClaudeBinary();
    if (!bin) {
      statusEl.setText("Registered with Claude Code: claude CLI not found — use the manual command below.");
    } else {
      claudeIsRegistered(bin).then((registered) => {
        statusEl.setText(`Registered with Claude Code: ${registered ? "yes" : "no"}`);
      }).catch(() => {
        statusEl.setText("Registered with Claude Code: (error checking status)");
      });
    }

    // Connect / Disconnect buttons.
    new Setting(containerEl)
      .setName("Registration")
      .setDesc("Connect or disconnect this vault's MCP server from Claude Code.")
      .addButton((b) =>
        b.setButtonText("Connect to Claude Code").setCta().onClick(() => this.plugin.autoRegister(true))
      )
      .addButton((b) =>
        b.setButtonText("Disconnect").onClick(() => this.plugin.claudeRemoveRegistration())
      );

    // Manual fallback command.
    containerEl.createEl("h4", { text: "Manual setup (fallback)" });
    containerEl.createEl("p", {
      text: "If auto-register didn't work, run this once in a terminal:",
    });
    const cmd = registerCommandFor(this.app);
    containerEl.createEl("pre").createEl("code", { text: cmd });
    containerEl.createEl("p", { cls: "setting-item-description", text: SWITCH_VAULT_NOTE });
    new Setting(containerEl)
      .addButton((b) => b.setButtonText("Copy command").setCta().onClick(() => copyToClipboard(cmd)))
      .addButton((b) => b.setButtonText("Open setup popup").onClick(() => new ConnectionSetupModal(this.app).open()));

    // Security settings.
    containerEl.createEl("h3", { text: "Security" });

    new Setting(containerEl)
      .setName("Read-only mode")
      .setDesc("Block all mutating tools (write, move, delete, patch, etc.). Read and search tools remain available.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readOnly).onChange(async (value) => {
          this.plugin.settings.readOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Allow dangerous CLI commands")
      .setDesc(
        `Let obsidian_cli run ${DANGEROUS_LIST_DESC}. These execute arbitrary code or control the app — leave off unless you need them.`
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowDangerousCli).onChange(async (value) => {
          this.plugin.settings.allowDangerousCli = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Trusted read-only plugins")
      .setDesc(
        "Plugin ids (one per line) whose published tools may declare themselves read-only and be believed. " +
          "Every other publisher's read-only claim is treated as mutating: queued, journaled, allowlist-scoped, " +
          "and blocked while read-only mode is on. Takes effect on the next session connect."
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.trustedReadOnlyPlugins.join("\n"));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.trustedReadOnlyPlugins = value.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Path allowlist")
      .setDesc("Restrict file operations to these vault-relative prefixes (one per line). Leave empty to allow the whole vault.")
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.allowlist.join("\n"));
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.allowlist = value.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    // Schemes. Scheme semantics are configuration, not hardwired (Nelson's
    // ruling): only the default "jd" instance's config gets a UI here —
    // additional instances or exotic overrides stay data.json-editable, no
    // UI (YAGNI; see kernel/scheme/registry.ts and VaultMcpSettings.schemes).
    containerEl.createEl("h3", { text: "Schemes" });
    const jdInstance = this.plugin.settings.schemes[0];
    if (jdInstance && jdInstance.provider === "johnny-decimal") {
      const jdConfig: Partial<JdConfig> = jdInstance.config ?? {};

      new Setting(containerEl)
        .setName("Expanded areas")
        .setDesc(
          "Comma-separated area bands (e.g. \"90-99\") that use 5-digit sequential ids instead of category/decimal ids. " +
            "Leave blank to use the provider default (90-99)."
        )
        .addText((t) => {
          t.setValue((jdConfig.expandedAreas ?? []).join(", "));
          t.onChange(async (value) => {
            await this.updateJdConfig({ expandedAreas: parseCommaList(value) });
          });
        });

      new Setting(containerEl)
        .setName("Expanded categories")
        .setDesc(
          "Comma-separated categories (e.g. \"27\") that use 5-digit flat ids instead of category.decimal ids. " +
            "Leave blank to use the provider default (27)."
        )
        .addText((t) => {
          t.setValue((jdConfig.expandedCategories ?? []).join(", "));
          t.onChange(async (value) => {
            await this.updateJdConfig({ expandedCategories: parseCommaList(value) });
          });
        });

      new Setting(containerEl)
        .setName("Content-decimal floor")
        .setDesc(
          "Lowest two-digit decimal (0-99) a category allocates as content — decimals below it are reserved. " +
            "Leave blank for the default (10)."
        )
        .addText((t) => {
          t.setValue(jdConfig.contentDecimalFloor === undefined ? "" : String(jdConfig.contentDecimalFloor));
          t.onChange(async (value) => {
            await this.updateJdConfig({ contentDecimalFloor: parseFloorField(value) });
          });
        });
    }

    new Setting(containerEl)
      .setName("Socket enabled")
      .setDesc(
        this.plugin.settings.enabled
          ? "The MCP socket is enabled. Toggle to disable (reload required)."
          : "The MCP socket is disabled. Toggle to re-enable (reload required)."
      )
      .addButton((b) => {
        b.setButtonText(this.plugin.settings.enabled ? "Disable socket" : "Enable socket");
        b.onClick(async () => {
          this.plugin.settings.enabled = !this.plugin.settings.enabled;
          await this.plugin.saveSettings();
          new Notice("vault-mcp: reload the plugin (or restart Obsidian) for this change to take effect.");
          this.display();
        });
      });
  }

  /**
   * Merge `partial` into schemes[0].config and save. Deliberately
   * non-mutating at every level it touches: `this.plugin.settings.schemes`
   * defaults to the module-level DEFAULT_SCHEMES constant (main.ts
   * DEFAULT_SETTINGS.schemes = DEFAULT_SCHEMES) until the first save writes
   * data.json, so an in-place `schemes[0].config = …` or `schemes[0] = …`
   * would mutate that shared array/object and silently contaminate every
   * OTHER instance (and test) that still expects the untouched default.
   * Building fresh objects and a fresh array here, rather than mutating in
   * place, keeps DEFAULT_SCHEMES byte-identical no matter how many times a
   * user edits these fields.
   */
  private async updateJdConfig(partial: Partial<JdConfig>): Promise<void> {
    const schemes = this.plugin.settings.schemes;
    const jd = schemes[0];
    if (!jd) return;
    const nextConfig: Record<string, unknown> = { ...(jd.config ?? {}) };
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) delete nextConfig[key];
      else nextConfig[key] = value;
    }
    this.plugin.settings.schemes = [{ ...jd, config: nextConfig as Partial<JdConfig> }, ...schemes.slice(1)];
    await this.plugin.saveSettings();
  }
}
