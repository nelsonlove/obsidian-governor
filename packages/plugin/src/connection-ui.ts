import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import type VaultMcpPlugin from "./main.js";
import { buildRegisterCommand } from "./register-command.js";
import { bridgeDestPath } from "./paths.js";
import { findClaudeBinary, claudeIsRegistered } from "./claude-cli.js";
import { DANGEROUS_LIST_DESC } from "./mcp/tools-cli.js";
import { OPAQUE_ACCEPT_CLI_COMMANDS, OPAQUE_ACCEPT_COMMAND_IDS } from "./mcp/cli-policy.js";
import { builtinModules } from "./mcp/modules-mount.js";
import {
  ModuleRegistry,
  collect,
  mergeModuleConfig,
  safeValidate,
  type HostedField,
  type HostedModule,
  type VaultModule,
} from "./kernel/modules/index.js";

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

/** Parse the "Excluded roots" textarea (one folder prefix per line) into a
 * trimmed, non-empty string list. Blank lines are dropped; an all-blank
 * input yields `undefined` rather than `[]` — same "blank means nothing to
 * override" convention as `parseCommaList`, so a scheme instance with no
 * excluded territory looks identical to one the field was never touched on
 * (the persisted config never carries a bare `excludedRoots: []`). */
export function parseLineList(value: string): string[] | undefined {
  const items = value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length === 0 ? undefined : items;
}

/** Parse a "number"-typed config field: blank -> undefined (removes the key
 * — "use the provider default"), otherwise the parsed number. Generalizes
 * the old JD-specific `parseFloorField` to any manifest number field (#81's
 * generic renderer replaces the hand-built content-decimal-floor field this
 * was written for, but the parsing rule — and the field-level problem it
 * pairs with below — is the same for every number field). */
export function parseNumberField(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * What `parseNumberField` cannot express on its own: a non-numeric entry
 * (e.g. "abc") parses to `undefined`, indistinguishable from a deliberately
 * blank field. Unlike the old `floorFieldProblem` (which surfaced this
 * ALONGSIDE still saving the silently-emptied value), the renderer that
 * calls this REFUSES the save outright on a non-null result — loud, not a
 * silent coerce-to-default with a footnote (the task's own constraint: an
 * invalid value must be reported, never dropped to a default with no
 * visible trace). Blank and genuinely-numeric input (any value — RANGE
 * checking is the module's `manifest.config.validate`'s job, applied
 * separately to the built config) are never a problem here. Pure, testable
 * without a Setting tab. */
export function numberFieldProblem(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (Number.isNaN(Number(trimmed))) {
    return `${label}: "${trimmed}" is not a number — not saved; the previous value is kept.`;
  }
  return null;
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

    // Command policy (mcp/cli-policy.ts). The opaque-accept set — quickadd,
    // quickadd:run, quickadd:run-template, eval, command, and quickadd:*
    // run_command ids — is denied by DEFAULT; the re-enable list below is the
    // one human-only way back in. The deny list always wins over a re-enable.
    new Setting(containerEl)
      .setName("Re-enabled opaque commands")
      .setDesc(
        `Opaque macro/code commands (${[...OPAQUE_ACCEPT_CLI_COMMANDS].join(", ")}; ${[...OPAQUE_ACCEPT_COMMAND_IDS].join(", ")} ` +
          "command ids) are denied by default — the acceptance guard cannot inspect what they execute. List a " +
          "specific command or exact command id here (one per line; no wildcards — each entry re-enables exactly " +
          "one) to re-enable it. eval/command additionally require the dangerous-CLI toggle above. Takes effect immediately."
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.cliPolicy.allowOpaque.join("\n"));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.cliPolicy = {
            ...this.plugin.settings.cliPolicy,
            allowOpaque: value.split("\n").map((s) => s.trim()).filter(Boolean),
          };
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Denied commands")
      .setDesc(
        "Additional obsidian_cli commands or obsidian_run_command ids to deny (one per line; a trailing * makes " +
          "a prefix pattern, e.g. templater:*). Deny always wins — including over the re-enable list above."
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.cliPolicy.deny.join("\n"));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.cliPolicy = {
            ...this.plugin.settings.cliPolicy,
            deny: value.split("\n").map((s) => s.trim()).filter(Boolean),
          };
          await this.plugin.saveSettings();
        });
      });

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

    // Modules (#81: config-host). One generic, data-driven section per
    // registered module — no per-module bespoke UI code. Each module's
    // manifest (mcp/modules-mount.ts) supplies the enabled toggle's
    // description, its config fields (if any), and its capability
    // directory; this REPLACES the old hand-built "Modules" toggle-only
    // loop and the hand-built "Schemes" section (JD's expanded areas/
    // categories/floor/excludedRoots fields) — those are now the scheme
    // module's generated section, byte-for-byte the same fields, driven by
    // SCHEME_MANIFEST instead of hardcoded here. Registration is
    // per-connection, so a toggle takes effect on the next session connect.
    this.renderModules(containerEl);

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

  // ── #81: the generic, manifest-driven module renderer ──────────────────
  //
  // One `<h4>` section per registered module, built from `HostedModule`
  // (kernel/modules/config-host.ts's `collect`) — no per-module bespoke UI
  // code anywhere below. A module with no `manifest.config` (the vocab
  // module today) still renders its section in full: enabled toggle,
  // summary, capability directory — just with zero config fields, never
  // skipped and never a crash.

  /** The live module list + a throwaway registry used ONLY for `isEnabled`
   * resolution — no `registerAll` runs here, so no live vault/server is
   * needed to render the tab (the `schemeNotes`/`vocabSource` deps below
   * are unused stand-ins: `builtinModules` closes over them, but nothing in
   * THIS file ever calls a module's `register()`). */
  private moduleList(): VaultModule[] {
    return builtinModules({
      getSettings: () => this.plugin.settings,
      getVocabularies: () => this.plugin.settings.vocabularies,
      schemeNotes: () => [],
      vocabSource: { paths: () => [], frontmatter: () => null, body: async () => null },
      skillsSource: {
        notes: async () => [],
        resolveLink: () => null,
        embed: async () => null,
        basePath: () => null,
        frontmatterOf: () => null,
        exists: () => false,
        applyFrontmatter: async () => {},
      },
      provenanceSource: {
        noteFrontmatter: () => null,
        read: async () => null,
        stat: async () => null,
        glob: async () => [],
        writeNote: async () => {},
      },
    });
  }

  private renderModules(containerEl: HTMLElement): void {
    const modules = this.moduleList();
    const hosted = collect(modules, this.plugin.settings.modules, this.plugin.settings);
    containerEl.createEl("h3", { text: "Modules" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each module is a settings-toggleable unit of the plugin's tool surface, with its own config and the " +
        "directory of what it does. Toggling a module off unmounts its whole tool surface on the next session " +
        "connect.",
    });
    for (const h of hosted) {
      const mod = modules.find((m) => m.id === h.id);
      if (mod) this.renderModuleSection(containerEl, mod, h);
    }
  }

  private renderModuleSection(containerEl: HTMLElement, mod: VaultModule, hosted: HostedModule): void {
    const section = containerEl.createDiv({ cls: "vault-mcp-module" });
    section.createEl("h4", { text: `${mod.id} (${hosted.posture})` });
    if (hosted.summary) section.createEl("p", { cls: "setting-item-description", text: hosted.summary });

    new Setting(section)
      .setName("Enabled")
      .setDesc("Takes effect on the next session connect.")
      .addToggle((t) =>
        t.setValue(hosted.enabled).onChange(async (value) => {
          this.plugin.settings.modules = {
            ...this.plugin.settings.modules,
            [mod.id]: { ...this.plugin.settings.modules[mod.id], enabled: value },
          };
          await this.plugin.saveSettings();
        })
      );

    // Config validation problems (generalizes the old JD-specific
    // jdWarningEl to every module): cleared when the current merged config
    // is valid, listing every `manifest.config.validate` finding otherwise.
    // Saving proceeds unconditionally — config-not-hardwired means the user
    // rules, but they must SEE the consequence.
    const problemsEl = section.createEl("p", { cls: "mod-warning" });
    const renderProblems = (problems: string[]) => problemsEl.setText(problems.length === 0 ? "" : problems.join(" "));
    renderProblems(hosted.problems);

    for (const field of hosted.fields) {
      this.renderConfigField(section, mod, field, renderProblems);
    }

    const dir = hosted.directory;
    if (dir.tools.length > 0) {
      section.createEl("h5", { text: "Tools" });
      const list = section.createEl("ul");
      for (const tool of dir.tools) {
        const li = list.createEl("li");
        li.createEl("strong", { text: tool.name });
        li.appendText(` — ${tool.purpose}${tool.readOnly ? " (read-only)" : ""}`);
        for (const c of tool.caveats ?? []) {
          const cave = li.createEl("div", { cls: "setting-item-description" });
          cave.setText(c);
        }
      }
    }
    for (const [label, docs] of [
      ["Address forms", dir.addressForms],
      ["Rule packs", dir.rulePacks],
      ["Kernel args", dir.kernelArgs],
    ] as const) {
      if (docs.length === 0) continue;
      section.createEl("h5", { text: label });
      const list = section.createEl("ul");
      for (const d of docs) {
        const li = list.createEl("li");
        li.createEl("strong", { text: d.name });
        li.appendText(` — ${d.purpose}`);
      }
    }
  }

  private renderConfigField(
    section: HTMLElement,
    mod: VaultModule,
    field: HostedField,
    renderProblems: (problems: string[]) => void
  ): void {
    const setting = new Setting(section).setName(field.label);
    if (field.help) setting.setDesc(field.help);

    const commit = async (patch: Record<string, unknown>) => {
      await this.saveModuleField(mod, patch);
      renderProblems(this.moduleProblems(mod));
    };

    switch (field.type) {
      case "toggle":
        setting.addToggle((t) => t.setValue(Boolean(field.value)).onChange((value) => commit({ [field.key]: value })));
        break;
      case "select":
        setting.addDropdown((d) => {
          for (const opt of field.options ?? []) d.addOption(opt, opt);
          // Only call setValue for a value that's actually one of the
          // options — never fabricate a "selected" first option for an
          // unset/unrecognized value. A no-op setValue would visually
          // suggest that option is the saved value when nothing was ever
          // committed; leaving the dropdown at its native default (the
          // browser's own "first option" rendering) doesn't claim that.
          if (typeof field.value === "string" && field.options?.includes(field.value)) {
            d.setValue(field.value);
          }
          d.onChange((value) => commit({ [field.key]: value }));
        });
        break;
      case "number": {
        // Loud refusal (the task's own constraint): an unparseable entry is
        // reported inline and NEVER saved — the previous good value (or
        // "unset") survives untouched, rather than silently coercing to
        // undefined the way the old parseFloorField/floorFieldProblem pair
        // did (it saved `undefined` AND showed a footnote; this refuses the
        // save outright).
        const fieldProblemEl = section.createEl("p", { cls: "mod-warning" });
        setting.addText((t) => {
          t.setValue(field.value === undefined || field.value === null ? "" : String(field.value));
          if (field.placeholder) t.setPlaceholder(field.placeholder);
          t.onChange(async (value) => {
            const problem = numberFieldProblem(field.label, value);
            fieldProblemEl.setText(problem ?? "");
            if (problem) return;
            await commit({ [field.key]: parseNumberField(value) });
          });
        });
        break;
      }
      case "csv":
        setting.addText((t) => {
          t.setValue(Array.isArray(field.value) ? (field.value as string[]).join(", ") : "");
          if (field.placeholder) t.setPlaceholder(field.placeholder);
          t.onChange((value) => commit({ [field.key]: parseCommaList(value) }));
        });
        break;
      case "lines":
        setting.addTextArea((t) => {
          t.setValue(Array.isArray(field.value) ? (field.value as string[]).join("\n") : "");
          t.inputEl.rows = 3;
          t.onChange((value) => commit({ [field.key]: parseLineList(value) }));
        });
        break;
      case "text":
      default:
        setting.addText((t) => {
          t.setValue(typeof field.value === "string" ? field.value : "");
          if (field.placeholder) t.setPlaceholder(field.placeholder);
          t.onChange((value) => commit({ [field.key]: value === "" ? undefined : value }));
        });
        break;
    }

    if (field.caveats?.length) {
      const ul = section.createEl("ul", { cls: "setting-item-description" });
      for (const c of field.caveats) ul.createEl("li", { text: c });
    }
  }

  /** Persist `patch` for `mod`: through its `configBinding` when it has one
   * (scheme — writes into `settings.schemes[0]`, never `modules.<id>.config`),
   * else the plain `modules.<id>.config` patch every future module gets by
   * default. Delete-on-undefined either way, matching every textarea
   * field's "blank means use the default" convention. */
  private async saveModuleField(mod: VaultModule, patch: Record<string, unknown>): Promise<void> {
    if (mod.configBinding) {
      this.plugin.settings = mod.configBinding.write(this.plugin.settings, patch) as typeof this.plugin.settings;
    } else {
      const existing = this.plugin.settings.modules[mod.id]?.config ?? {};
      const nextConfig: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete nextConfig[k];
        else nextConfig[k] = v;
      }
      this.plugin.settings.modules = {
        ...this.plugin.settings.modules,
        [mod.id]: { ...this.plugin.settings.modules[mod.id], config: nextConfig },
      };
    }
    await this.plugin.saveSettings();
  }

  /** `mod`'s CURRENT merged config (post-save), re-derived the same way
   * `collect` does for a single module, so a field's problems element can
   * be refreshed in place without a full `display()` re-render (which would
   * lose focus/cursor position mid-edit). */
  private currentModuleConfig(mod: VaultModule): Record<string, unknown> {
    if (mod.configBinding) {
      return mergeModuleConfig(mod.manifest?.config?.defaults, mod.configBinding.read(this.plugin.settings));
    }
    const registry = new ModuleRegistry([mod], this.plugin.settings.modules);
    return registry.configFor(mod.id);
  }

  private moduleProblems(mod: VaultModule): string[] {
    return safeValidate(mod.manifest?.config?.validate, this.currentModuleConfig(mod));
  }
}
