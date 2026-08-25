import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import type VaultMcpPlugin from "./main.js";
import { buildRegisterCommand } from "./register-command.js";
import { bridgeDestPath } from "./paths.js";
import { findClaudeBinary, claudeIsRegistered } from "./claude-cli.js";
import { DANGEROUS_LIST_DESC } from "./mcp/tools-cli.js";
import { OPAQUE_ACCEPT_CLI_COMMANDS, OPAQUE_ACCEPT_COMMAND_IDS } from "./mcp/cli-policy.js";
import { CommandSuggest } from "./command-suggest.js";
import { builtinModules } from "./mcp/modules-mount.js";
import { renderGovernanceSettings } from "./governance/wiring.js";
import {
  ModuleRegistry,
  collect,
  mergeModuleConfig,
  safeValidate,
  type HostedField,
  type HostedModule,
  type VaultModule,
} from "./kernel/modules/index.js";
import {
  VOCAB_PROVIDERS,
  isVocabProvider,
  type VocabInstanceSettings,
} from "./kernel/vocab/registry.js";
import { ensureSettingsStyles } from "./settings-styles.js";
import {
  DEFAULT_PROTECTED_PROPERTIES,
  formatProtectedPropertyLines,
  normalizeProtectedProperties,
  parseProtectedPropertyLines,
} from "@vault-mcp/core";

// ── tabbed settings UI: the pure, DOM-free half ─────────────────────────────
//
// The settings tab is one long scroll no more: it's split into a Connection
// tab, a Security tab, and one tab PER registered module (generated from the
// same module set the generic renderer already iterates, so a new module gets
// a tab with zero extra code). The two functions below are the entire
// non-DOM half — tab-list derivation from the module set, and active-tab
// resolution — so they're exported and headless-tested; only the DOM wiring
// and click-switching in `display()` is obsidian-coupled (verified by build +
// reasoning, per the same boundary as every other field in this file).

/** One tab in the settings UI: a stable `id` and the visible `name`. */
export interface SettingsTab {
  id: string;
  name: string;
}

/** The two fixed leading tabs, in order, before the per-module tabs. */
export const STATIC_SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "connection", name: "Connection" },
  { id: "security", name: "Security" },
];

/** Prefix distinguishing a per-module tab id from a static one, so a module
 * whose id happened to be "connection"/"security" could never collide. */
export const MODULE_TAB_PREFIX = "module:";

/** The tab id for a module — its registry id under the module prefix. */
export function moduleTabId(moduleId: string): string {
  return `${MODULE_TAB_PREFIX}${moduleId}`;
}

/** Derive the full ordered tab list from the module set: the fixed Connection
 * and Security tabs, then one tab per module in registry order (id and name
 * both the module's `id`, matching the section header the module renderer
 * already uses). Pure — the derivation is data-driven off the module set, so
 * a newly-registered module automatically yields a new tab. */
export function buildSettingsTabs(modules: ReadonlyArray<{ id: string }>): SettingsTab[] {
  return [
    ...STATIC_SETTINGS_TABS,
    ...modules.map((m) => ({ id: moduleTabId(m.id), name: m.id })),
  ];
}

/** Resolve which tab is active: the `remembered` id if it still exists in the
 * current tab list, else the first tab (the default). An empty tab list yields
 * `undefined` (never happens in practice — the two static tabs are always
 * present). Pure, so the "remember last, but fall back when a remembered
 * module tab disappears" logic is headless-testable. */
export function resolveActiveTab(
  tabs: ReadonlyArray<SettingsTab>,
  remembered: string | undefined,
): string | undefined {
  if (remembered !== undefined && tabs.some((t) => t.id === remembered)) return remembered;
  return tabs.length > 0 ? tabs[0].id : undefined;
}

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

// ── vocab instance settings (Gap B) ─────────────────────────────────────────
//
// The vocab module's settings are a LIST of `{id, provider, root, config}` rows
// (settings.vocabularies), which the scalar manifest-field renderer cannot
// express — so this small set of PURE helpers plus a bespoke per-instance form
// (VaultMcpSettingTab.renderVocabInstances) provide the UI, exactly the way the
// top-level allowlist textareas are bespoke. The logic below is exported and
// headless-testable; only the DOM wiring in renderVocabInstances is
// obsidian-coupled.

/** Result of parsing a config-textarea value. A blank textarea persists NO
 * config key (`config: undefined`); non-object or unparseable JSON is a LOUD
 * problem the form refuses to save — never a silent coerce, matching the
 * number-field discipline above. */
export type VocabConfigParse =
  | { ok: true; config: Record<string, unknown> | undefined }
  | { ok: false; error: string };

export function parseVocabConfig(text: string): VocabConfigParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, config: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `Config is not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'Config must be a JSON object, e.g. {"termsRoot": "Assent"}.' };
  }
  return { ok: true, config: parsed as Record<string, unknown> };
}

/** Render an instance's `config` object as pretty JSON for the textarea; an
 * absent or empty config is the empty string (the "no config" case). */
export function stringifyVocabConfig(config: Record<string, unknown> | undefined): string {
  if (!config || Object.keys(config).length === 0) return "";
  return JSON.stringify(config, null, 2);
}

/** Coerce hand-edited `settings.vocabularies` into a safe array the form can
 * render — NEVER throws on malformed data.json (the degrade-gracefully
 * requirement). A non-array becomes `[]`; each entry is coerced field-by-field
 * with string fallbacks; a non-object `config` is dropped. An unknown provider
 * (or blank id/root) is PRESERVED verbatim so the form shows it and
 * `validateVocabInstances` flags it — coercion never hides a problem by
 * rewriting it, it only prevents a crash. Non-object entries are dropped. */
export function coerceVocabInstances(raw: unknown): VocabInstanceSettings[] {
  if (!Array.isArray(raw)) return [];
  const out: VocabInstanceSettings[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const inst: VocabInstanceSettings = {
      id: typeof e.id === "string" ? e.id : "",
      provider: typeof e.provider === "string" ? e.provider : "",
      root: typeof e.root === "string" ? e.root : "",
    };
    if (e.config !== null && typeof e.config === "object" && !Array.isArray(e.config)) {
      inst.config = e.config as Record<string, unknown>;
    }
    out.push(inst);
  }
  return out;
}

/** Human-readable validation problems for the current instance list — empty ⇒
 * valid. Mirrors VocabRegistry's own skip-and-report rules (unknown provider,
 * duplicate id) so the form warns about exactly what the runtime would skip,
 * plus the ones the form can prevent (blank id; whitespace-only root). NOTE on
 * root: `""` is a FIRST-CLASS value meaning "whole vault" (the shipping
 * glossary default uses it), so root is NOT required non-empty — only a
 * whitespace-ONLY root (neither "" nor a real path) is flagged. */
export function validateVocabInstances(list: VocabInstanceSettings[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((inst, i) => {
    const label = `Instance ${i + 1}`;
    if (inst.id.trim() === "") {
      problems.push(`${label}: id is required.`);
    } else if (seen.has(inst.id)) {
      problems.push(`${label}: duplicate id '${inst.id}' — the first wins; later duplicates are skipped at runtime.`);
    } else {
      seen.add(inst.id);
    }
    if (!isVocabProvider(inst.provider)) {
      problems.push(
        `${label}: unknown provider '${inst.provider}' — must be one of ${VOCAB_PROVIDERS.join(", ")}; skipped at runtime.`,
      );
    }
    if (inst.root !== "" && inst.root.trim() === "") {
      problems.push(`${label}: root is whitespace-only — use blank for the whole vault, or a real vault-relative path.`);
    }
  });
  return problems;
}

/**
 * Append `value` to the allowOpaque re-enable list, from the "Add a command"
 * picker. Pure; returns the SAME array (not a copy) when nothing changes, so
 * a caller can tell "added" from "no-op" by reference — same convention the
 * kernel's mapPaths/visiblePaths use elsewhere in this repo. Two guards
 * beyond plain dedup: `value` must be a key of `validCommandIds` (this is
 * what keeps the picker strictly additive convenience rather than a laxer
 * path than the free-text textarea below it, which still accepts anything
 * typed), and `value` must not contain a newline — allowOpaque round-trips
 * through a one-per-line textarea (join("\n") / split("\n")), so a stored id
 * containing "\n" would silently split into two independent entries the next
 * time the textarea re-parses on any unrelated edit.
 */
export function addAllowOpaqueEntry(
  current: string[],
  value: string,
  validCommandIds: Record<string, unknown>
): string[] {
  if (!(value in validCommandIds) || value.includes("\n") || current.includes(value)) return current;
  return [...current, value];
}

/** Append a new, blank instance (first provider preselected). Pure. */
export function addVocabInstance(list: VocabInstanceSettings[]): VocabInstanceSettings[] {
  return [...list, { id: "", provider: VOCAB_PROVIDERS[0], root: "" }];
}

/** Remove the instance at `index`. Pure; out-of-range index is a no-op copy. */
export function removeVocabInstanceAt(list: VocabInstanceSettings[], index: number): VocabInstanceSettings[] {
  return list.filter((_, i) => i !== index);
}

/** Apply `patch` to the instance at `index`, returning a NEW array. A patch
 * value of `undefined` REMOVES that key (the "blank config means no config key"
 * convention, matching the manifest fields' delete-on-undefined). Pure. */
export function updateVocabInstanceAt(
  list: VocabInstanceSettings[],
  index: number,
  patch: Partial<VocabInstanceSettings>,
): VocabInstanceSettings[] {
  return list.map((inst, i) => {
    if (i !== index) return inst;
    const next: VocabInstanceSettings = { ...inst, ...patch };
    for (const k of Object.keys(patch) as Array<keyof VocabInstanceSettings>) {
      if (patch[k] === undefined) delete next[k];
    }
    return next;
  });
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
    titleEl.setText("Connect Governor to Claude Code (manual fallback)");
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

  /** Last-selected tab id, remembered across re-renders on the tab INSTANCE
   * (not persisted to settings — a deliberately lightweight persistence per
   * the task). A remembered tab that no longer exists (module removed) falls
   * back to the first tab, resolved by `resolveActiveTab`. */
  private activeTab?: string;

  display() {
    const { containerEl } = this;
    containerEl.empty();
    ensureSettingsStyles();

    // Everything lives under a single plugin-scoped wrapper so the tab CSS
    // (settings-styles.ts) can never leak to the rest of the app.
    const wrapper = containerEl.createDiv({ cls: "vault-mcp-settings" });

    // Data-driven tab set: the two fixed tabs plus one per registered module,
    // derived from the SAME module list the generic renderer iterates — a new
    // module yields a new tab with no extra code here.
    const modules = this.moduleList();
    const tabs = buildSettingsTabs(modules);
    const active = resolveActiveTab(tabs, this.activeTab) ?? tabs[0]?.id;
    this.activeTab = active;

    // Toolbar with the horizontal, wrap-friendly tab-nav row.
    const toolbar = wrapper.createDiv({ cls: "vault-mcp-settings__toolbar" });
    const nav = toolbar.createDiv({ cls: "settings-tab-nav settings-view__tab-nav" });

    const buttons = new Map<string, HTMLElement>();
    const panes = new Map<string, HTMLElement>();

    for (const tab of tabs) {
      const btn = nav.createEl("button", {
        text: tab.name,
        cls: "settings-tab-button settings-view__tab-button vertical-tab-nav-item",
      });
      btn.id = `tab-button-${tab.id}`;
      buttons.set(tab.id, btn);
      const pane = wrapper.createDiv({ cls: "settings-tab-content settings-view__tab-content" });
      panes.set(tab.id, pane);
      btn.onclick = () => this.selectTab(tab.id, tabs, buttons, panes);
    }

    // Render each tab's content into its own pane. The Connection and Security
    // panes are the former top-of-scroll and Security sections verbatim; the
    // module panes are the same generic, manifest-driven sections as before —
    // one per module instead of a single stacked list.
    this.renderConnectionTab(panes.get("connection")!);
    this.renderSecurityTab(panes.get("security")!);

    const hosted = collect(modules, this.plugin.settings.modules, this.plugin.settings);
    for (const tab of tabs) {
      if (!tab.id.startsWith(MODULE_TAB_PREFIX)) continue;
      const modId = tab.id.slice(MODULE_TAB_PREFIX.length);
      const mod = modules.find((m) => m.id === modId);
      const h = hosted.find((x) => x.id === modId);
      if (mod && h) {
        const pane = panes.get(tab.id)!;
        this.renderModulesIntro(pane);
        this.renderModuleSection(pane, mod, h);
      }
    }

    this.applyActiveTab(active, tabs, buttons, panes);
  }

  /** Show only the `active` tab's pane and mark only its button active —
   * toggling the TaskNotes-style `active`/`--active`/`is-active` classes on the
   * buttons and both `settings-tab-content--active` (the base variant) and
   * `settings-view__tab-content--active` (the variant the stylesheet keys the
   * `display: block` flip on) on the panes. Both are added so the DOM carries
   * the base BEM class AND the CSS's `view__` selector matches — mirroring how
   * the buttons carry a stack of active classes. */
  private applyActiveTab(
    active: string | undefined,
    tabs: ReadonlyArray<SettingsTab>,
    buttons: Map<string, HTMLElement>,
    panes: Map<string, HTMLElement>,
  ): void {
    for (const tab of tabs) {
      const on = tab.id === active;
      const btn = buttons.get(tab.id);
      const pane = panes.get(tab.id);
      if (btn) {
        btn.classList.toggle("active", on);
        btn.classList.toggle("settings-view__tab-button--active", on);
        btn.classList.toggle("is-active", on);
      }
      if (pane) {
        pane.classList.toggle("settings-tab-content--active", on);
        pane.classList.toggle("settings-view__tab-content--active", on);
      }
    }
  }

  /** Remember and switch to `id`, updating the active classes in place (no full
   * re-render, so a click never disturbs the other panes' field state). */
  private selectTab(
    id: string,
    tabs: ReadonlyArray<SettingsTab>,
    buttons: Map<string, HTMLElement>,
    panes: Map<string, HTMLElement>,
  ): void {
    this.activeTab = id;
    this.applyActiveTab(id, tabs, buttons, panes);
  }

  /** The Connection tab: registration status, connect/disconnect, the manual
   * fallback command, and the socket enable/disable toggle. Verbatim the former
   * top-of-scroll connection block plus the trailing "Socket enabled" control,
   * only retargeted from `containerEl` to this tab's pane. */
  private renderConnectionTab(containerEl: HTMLElement): void {
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
      .setDesc(
        "Connect or disconnect this vault's MCP server from Claude Code (server name 'governor'; tools appear " +
          "as mcp__governor__*). Registrations made before 0.12.0 under the old 'vault-mcp' name should be " +
          "removed: claude mcp remove vault-mcp.",
      )
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
          new Notice("governor: reload the plugin (or restart Obsidian) for this change to take effect.");
          this.display();
        });
      });
  }

  /** The Security tab: read-only mode, dangerous-CLI toggle, the command
   * policy (re-enabled opaque / denied), trusted read-only plugins, and the
   * path allowlist. Verbatim the former Security section, retargeted to this
   * tab's pane. */
  private renderSecurityTab(containerEl: HTMLElement): void {
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
      .setName("Raw CLI proxy")
      .setDesc(
        "Register obsidian_cli, the free-text pass-through to the official Obsidian CLI. Off by default: the " +
          "dedicated tools (obsidian_note_history, obsidian_note_diff, obsidian_base_create, the snippet tools, " +
          "obsidian_plugin_install/uninstall) cover the common jobs with typed arguments and path scoping. When on, " +
          "the proxy keeps all of its guards (command policy, danger gate, accept guard, deny lists). Takes effect " +
          "on the next session connect."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.rawCliProxy).onChange(async (value) => {
          this.plugin.settings.rawCliProxy = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Allow dangerous CLI commands")
      .setDesc(
        `Let the CLI surfaces run ${DANGEROUS_LIST_DESC}. These execute arbitrary code or control the app — leave off ` +
          "unless you need them. Also gates the dedicated obsidian_plugin_install / obsidian_plugin_uninstall tools " +
          "(same plugin:install / plugin:uninstall commands, same gate)."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowDangerousCli).onChange(async (value) => {
          this.plugin.settings.allowDangerousCli = value;
          await this.plugin.saveSettings();
        })
      );

    // Command policy (mcp/cli-policy.ts). The opaque-accept set — quickadd,
    // quickadd:run, quickadd:run-template, eval, command, and the quickadd:*
    // / js-engine:* run_command id families — is denied by DEFAULT; the re-enable list below is the
    // one human-only way back in. The deny list always wins over a re-enable.
    //
    // allowOpaque holds run_command IDs, not CLI command names — a picker
    // over app.commands (registered Obsidian commands, e.g. a QuickAdd
    // choice's quickadd:choice:<name> id) covers exactly that half. The CLI
    // side (quickadd/quickadd:run-template/eval/command) still has to be
    // typed by hand below: those aren't registered Obsidian commands, so
    // there's nothing to pick from.
    let allowOpaqueTextarea: HTMLTextAreaElement | undefined;
    new Setting(containerEl)
      .setName("Add a command")
      .setDesc(
        "Search registered Obsidian commands by name or id (e.g. a QuickAdd choice) and pick one to add it to " +
          "the re-enable list below. Adds the moment the box holds a real, currently-registered command id — " +
          "whether that came from picking a suggestion or typing the id out in full."
      )
      .addText((text) => {
        new CommandSuggest(this.app, text.inputEl);
        text.setPlaceholder("Search commands…");
        text.onChange(async (value) => {
          // app.commands.commands is not in the public obsidian types — cast
          // required (same cast the CommandSuggest / obsidian_get_command_ids
          // use).
          const commands = (this.app as any).commands.commands as Record<string, unknown>;
          const current = this.plugin.settings.cliPolicy.allowOpaque;
          const next = addAllowOpaqueEntry(current, value, commands);
          if (next !== current) {
            this.plugin.settings.cliPolicy = { ...this.plugin.settings.cliPolicy, allowOpaque: next };
            await this.plugin.saveSettings();
            if (allowOpaqueTextarea) {
              allowOpaqueTextarea.value = next.join("\n");
            }
          }
          // Clear whenever the box holds a real, currently-registered command
          // id — whether that pick just got added OR was already in the list.
          // Gating the clear on `next !== current` alone (addAllowOpaqueEntry's
          // no-op-by-reference treats "duplicate" and "invalid" identically)
          // left a picked duplicate sitting in the box with no feedback that
          // anything happened. Gating on validity directly instead matches the
          // pre-refactor behavior (an early `return` on invalid input, an
          // unconditional clear otherwise) without losing the keystroke fix.
          if (value in commands) {
            text.setValue("");
          }
        });
      });

    new Setting(containerEl)
      .setName("Re-enabled opaque commands")
      .setDesc(
        `Opaque macro/code commands (${[...OPAQUE_ACCEPT_CLI_COMMANDS].join(", ")}; ${[...OPAQUE_ACCEPT_COMMAND_IDS].join(", ")} ` +
          "command ids) are denied by default — the acceptance guard cannot inspect what they execute. List a " +
          "specific command or exact command id here (one per line; no wildcards — each entry re-enables exactly " +
          "one) to re-enable it, or use the picker above for a registered command id. eval/command additionally " +
          "require the dangerous-CLI toggle above. Takes effect immediately."
      )
      .addTextArea((ta) => {
        allowOpaqueTextarea = ta.inputEl;
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

    // ── Protected frontmatter properties (#224) ───────────────────────────
    // Human-only-mutable declaration list for the generalized accept-guard
    // perimeter. Saving routes through plugin.saveSettings, which re-syncs the
    // core guard registry (normalizing: floor keys / unknown grades dropped
    // loudly) — so edits land live on the next guarded write.
    new Setting(containerEl)
      .setName("Protected frontmatter properties")
      .setDesc(
        "One per line, as `key: grade`. Grade `agent-forbidden`: no agent transport may introduce, change, or " +
          "remove the property (byte-identical carry-forward is allowed). Grade `authority-conferring`: " +
          "additionally, the value only takes effect once the write that set it is human-attributed or accepted " +
          "in review. The accepted family (accepted / accepted-by / accepted-on / acceptance-status: accepted) " +
          "is a hardcoded floor underneath — it is always enforced and cannot be declared, removed, or downgraded " +
          `here. Default: ${formatProtectedPropertyLines(DEFAULT_PROTECTED_PROPERTIES)} (the RETIRED per-note ` +
          "auto-accept policy — it confers nothing since WP10c (appends propose for review like all content), " +
          "but the key stays protected: historical notes carry it, and agents must not toggle it)."
      )
      .addTextArea((ta) => {
        ta.setValue(formatProtectedPropertyLines(this.plugin.settings.protectedProperties));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          const raw = parseProtectedPropertyLines(value);
          this.plugin.settings.protectedProperties = raw;
          await this.plugin.saveSettings();
          // Surface what actually took effect (normalization may have dropped
          // floor keys or unknown grades) without fighting the user mid-typing.
          const effective = normalizeProtectedProperties(raw, () => {});
          if (effective.length < raw.length) {
            new Notice(
              `governor: ${raw.length - effective.length} protected-property line(s) ignored ` +
                `(floor keys and unknown grades cannot be declared) — see the console for details.`
            );
          }
        });
      });

    // Record immutability (#264) — the write-perimeter sibling of the
    // protected-property list above: a whole-note rule rather than a per-key
    // one. Default ON; the toggle exists as the escape hatch for the check's
    // deliberate over-inclusiveness (it refuses on any NAMED path).
    new Setting(containerEl)
      .setName("Enforce record immutability")
      .setDesc(
        "Refuse non-append writes to notes whose frontmatter carries `record: true` — historical, byte-verified " +
          "archives are extended by a dated end-of-file append (obsidian_append_note) and never edited, moved, or " +
          "deleted. Refusals are typed (record_immutable) and journaled. Turn OFF only to unblock a legitimate " +
          "operation the check over-blocks; it refuses on any path a call names, including one it only reads. " +
          "Takes effect immediately."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enforceRecordImmutability).onChange(async (value) => {
          this.plugin.settings.enforceRecordImmutability = value;
          await this.plugin.saveSettings();
        })
      );

    // ── observation capture ─────────────────────────────────────────────────
    //
    // DEFAULT OFF, and the copy says plainly what turning it on does. Capturing
    // note bodies writes vault content outside the vault; a user should be able
    // to decide that from the toggle's own description without reading a doc.
    new Setting(containerEl)
      .setName("Record what agents were shown")
      .setDesc(
        "Off by default. When on, Governor keeps the exact text it returns from a note read, so you can later see what an agent was actually shown rather than what it says it saw. " +
          "The text is stored outside your vault, at ~/.claude/governor/observations/, and is never synced. " +
          "Only tools with a reviewed contract are recorded — today that is reading a note. Nothing is deleted automatically yet, so recording stops at the size limit below."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.captureObservations === true).onChange(async (value) => {
          this.plugin.settings.captureObservations = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Recording size limit (MB)")
      .setDesc(
        "How much recorded text to keep before Governor stops adding more. It stops and says so rather than filling the disk. Deleting old recordings is not automatic yet."
      )
      .addText((t) =>
        t
          .setPlaceholder("50")
          .setValue(String(Math.round((this.plugin.settings.captureMaxBytes ?? 50 * 1024 * 1024) / (1024 * 1024))))
          .onChange(async (value) => {
            const mb = Number(value);
            // A blank or nonsense value leaves the setting alone rather than
            // becoming zero — a zero limit would silently disable a feature the
            // user just switched on.
            if (!Number.isFinite(mb) || mb <= 0) return;
            this.plugin.settings.captureMaxBytes = Math.round(mb * 1024 * 1024);
            await this.plugin.saveSettings();
          })
      );

    // ── local history (WP4, D10) ────────────────────────────────────────────
    //
    // DEFAULT OFF. Git retains HISTORICAL bytes: once recorded, an edit or a
    // deletion in the vault does not remove what history holds. D10 makes
    // enabling that a disclosed human decision, and makes the scope a human
    // choice separate from any connection allowlist.
    containerEl.createEl("h4", { text: "Local history" });
    new Setting(containerEl)
      .setName("Record vault history")
      .setDesc(
        "Off by default. When on, Governor keeps a Git history of your notes at ~/.claude/governor/history/ — outside your vault, never synced. " +
          "History RETAINS old bytes: editing or deleting a note later does not remove what was already recorded. " +
          "Guarded territories are never recorded regardless of the scope below. Nothing is recorded until proposals ship; choosing the scope now means the first recorded byte already respects it."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.historyEnabled === true).onChange(async (value) => {
          this.plugin.settings.historyEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("History scope")
      .setDesc(
        "Whole vault records everything except the exclusions; explicit roots records only the folders you list below. Connection allowlists never change this — what one agent may see and what history records are different decisions."
      )
      .addDropdown((dd) =>
        dd
          .addOption("whole-vault", "Whole vault (minus exclusions)")
          .addOption("explicit", "Only explicit roots")
          .setValue(this.plugin.settings.historyScope.mode)
          .onChange(async (value) => {
            this.plugin.settings.historyScope.mode = value === "explicit" ? "explicit" : "whole-vault";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Included roots")
      .setDesc("One folder per line. Used only when the scope is explicit. A root names the folder and everything under it.")
      .addTextArea((t) =>
        t
          .setPlaceholder("Notes\nProjects")
          .setValue(this.plugin.settings.historyScope.include.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.historyScope.include = value
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded roots")
      .setDesc(
        "One prefix per line, always subtracted in either mode. The defaults (.obsidian, .trash) and the guarded territories are always excluded — listing more here narrows history further."
      )
      .addTextArea((t) =>
        t
          .setPlaceholder("Private notes/")
          .setValue(this.plugin.settings.historyScope.exclude.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.historyScope.exclude = value
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // Developer affordances. The tool-runner defaults ON because it grants no
    // capability beyond the MCP surface itself: it invokes the same guarded
    // captured tools a code-mode connection gets (read-only mode, allowlist,
    // queue, journal and the accept guard all bind identically), so hiding it
    // is a UI-tidiness choice, not a security boundary.
    containerEl.createEl("h4", { text: "Developer" });
    new Setting(containerEl)
      .setName("In-app tool runner")
      .setDesc(
        'Enable the "Run tool…" command: pick any MCP tool, fill its arguments in a form, and see the result in a ' +
          "modal. Runs go through the exact guarded pipeline an agent call takes (and are journaled as " +
          "client: tool-runner). Takes effect immediately."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.devToolRunner).onChange(async (value) => {
          this.plugin.settings.devToolRunner = value;
          await this.plugin.saveSettings();
        })
      );
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
      healthSource: {
        resolvedLinks: () => ({}),
        unresolvedLinks: () => ({}),
        tags: () => ({}),
        markdownFiles: () => [],
        allFiles: () => [],
        aliases: () => ({}),
        noteBody: async () => null,
      },
    });
  }

  /** The shared "what a module is" help text, rendered at the top of each
   * module tab's pane. Verbatim the paragraph that headed the former single
   * stacked "Modules" section — preserved (not reworded) now that each module
   * has its own tab; the collective `<h3>Modules</h3>` heading it sat under is
   * dropped because the tab nav now labels each module. */
  private renderModulesIntro(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each module is a settings-toggleable unit of the plugin's tool surface, with its own config and the " +
        "directory of what it does. Toggling a module off unmounts its whole tool surface on the next session " +
        "connect.",
    });
  }

  private renderModuleSection(containerEl: HTMLElement, mod: VaultModule, hosted: HostedModule): void {
    const section = containerEl.createDiv({ cls: "vault-mcp-module" });
    section.createEl("h4", { text: `${mod.id} (${hosted.posture})` });
    if (hosted.summary) section.createEl("p", { cls: "setting-item-description", text: hosted.summary });

    new Setting(section)
      .setName("Enabled")
      // Acceptance's Obsidian surface (review pane + gavel ribbon) mounts/unmounts LIVE from this
      // toggle — no reload. Every other module is tool-only: its surface mounts per connection, so
      // its toggle takes effect on the next session connect.
      .setDesc(
        mod.id === "acceptance"
          ? "Mounts or unmounts the review pane and gavel ribbon live — no plugin reload needed."
          : "Takes effect on the next session connect."
      )
      .addToggle((t) =>
        t.setValue(hosted.enabled).onChange(async (value) => {
          this.plugin.settings.modules = {
            ...this.plugin.settings.modules,
            [mod.id]: { ...this.plugin.settings.modules[mod.id], enabled: value },
          };
          await this.plugin.saveSettings();
          // Let modules whose in-app surface follows this toggle mount/unmount live (acceptance's
          // pane + ribbon). Tool-only modules are unaffected — they take effect on the next connect.
          await this.plugin.onModuleEnabledChanged(mod.id, value);
          // Acceptance's live mount also decides whether its settings-tab section (adopt-baseline +
          // auto-accept) can render its gesture-gated controls vs. a hint — so re-render the tab now
          // that the mount has settled, mirroring the socket-toggle re-render. (Other modules are
          // tool-only: nothing in their section changes on toggle, so no re-render is needed.)
          if (mod.id === "acceptance") this.display();
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

    // Gap B: the vocab module's settings are a LIST of structured instances
    // (settings.vocabularies), which the generic scalar-field renderer above
    // cannot express — so the vocab section gets a bespoke per-instance form
    // appended here. This is the ONE module-specific branch in the otherwise
    // generic renderer; every other module renders from its manifest alone.
    if (mod.id === "vocab") this.renderVocabInstances(section);

    // Acceptance's second bespoke branch: the module EXPOSES a render function that builds its
    // gesture-gated adopt-baseline + auto-accept controls internally, from its own module-private
    // accept-capable controller. We only hand it a container — connection-ui never receives, holds,
    // or can walk the accept-capable deps (that is what keeps the accept boundary intact across
    // this new surface). It renders the live controls only when acceptance is mounted, else a hint.
    if (mod.id === "acceptance") renderGovernanceSettings(this.plugin, section);

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

  // ── Gap B: the vocab module's bespoke per-instance form ─────────────────
  //
  // Renders settings.vocabularies as an editable list — each row an
  // id / provider / root / config editor — plus add- and remove-instance
  // controls, writing straight to settings.vocabularies (read per-connection by
  // the vocab tool layer's getVocabularies thunk, so edits land on the next
  // session connect like every other module config). All state derives from
  // settings.vocabularies through coerceVocabInstances, so malformed
  // hand-edited data.json degrades gracefully (renders what it can, drops
  // non-object garbage) instead of throwing and taking the tab down. Only this
  // DOM wiring is obsidian-coupled; the parse/validate/coerce/mutation logic is
  // the exported pure helpers above (headless-tested).
  private renderVocabInstances(section: HTMLElement): void {
    section.createEl("h5", { text: "Vocabulary instances" });
    section.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each row is a controlled-vocabulary source the vocab tools read. Edits take effect on the next " +
        "session connect. A row with a blank id, an unknown provider, or a duplicate id is skipped at runtime " +
        "(the warnings below say which).",
    });
    const listEl = section.createDiv({ cls: "vault-mcp-vocab-list" });
    const problemsEl = section.createEl("p", { cls: "mod-warning" });

    const current = (): VocabInstanceSettings[] => coerceVocabInstances(this.plugin.settings.vocabularies);
    const persist = async (next: VocabInstanceSettings[]): Promise<void> => {
      this.plugin.settings.vocabularies = next;
      await this.plugin.saveSettings();
    };
    const renderProblems = (): void => {
      const problems = validateVocabInstances(current());
      problemsEl.setText(problems.length === 0 ? "" : problems.join(" "));
    };
    const paint = (): void => {
      listEl.empty();
      const instances = current();
      if (instances.length === 0) {
        listEl.createDiv({
          cls: "setting-item-description",
          text: "No vocabulary instances configured — the vocab tools fall back to the built-in defaults. Add one below to override.",
        });
      }
      instances.forEach((inst, index) =>
        this.renderVocabInstanceRow(listEl, inst, index, current, persist, renderProblems, paint),
      );
      renderProblems();
    };

    paint();

    new Setting(section)
      .setName("Add vocabulary instance")
      .setDesc("Append a new, blank vocabulary source to configure.")
      .addButton((b) =>
        b.setButtonText("Add instance").setCta().onClick(async () => {
          await persist(addVocabInstance(current()));
          paint();
        }),
      );
  }

  private renderVocabInstanceRow(
    listEl: HTMLElement,
    inst: VocabInstanceSettings,
    index: number,
    current: () => VocabInstanceSettings[],
    persist: (next: VocabInstanceSettings[]) => Promise<void>,
    renderProblems: () => void,
    paint: () => void,
  ): void {
    const row = listEl.createDiv({ cls: "vault-mcp-vocab-instance" });
    row.createEl("h6", { text: `Instance ${index + 1}${inst.id ? `: ${inst.id}` : ""}` });

    // Field edits patch just this instance and re-derive the warning list in
    // place — no full repaint, so typing keeps focus (the manifest fields'
    // convention). Add/remove DO repaint (a button click, not mid-edit).
    const commit = async (patch: Partial<VocabInstanceSettings>): Promise<void> => {
      await persist(updateVocabInstanceAt(current(), index, patch));
      renderProblems();
    };

    new Setting(row)
      .setName("Id")
      .setDesc("Unique identifier for this source (shown by obsidian_vocabularies). Required.")
      .addText((t) => {
        t.setValue(inst.id);
        t.onChange((value) => commit({ id: value }));
      });

    new Setting(row)
      .setName("Provider")
      .setDesc("blueprint = registry grammar (tags / properties / types); glossary = ## Terms definitions.")
      .addDropdown((d) => {
        for (const p of VOCAB_PROVIDERS) d.addOption(p, p);
        // Only preselect a recognized provider — an unknown (hand-edited) value
        // leaves the dropdown at its native default rather than fabricating a
        // selection, the same discipline the generic select field uses.
        if (isVocabProvider(inst.provider)) d.setValue(inst.provider);
        d.onChange((value) => commit({ provider: value }));
      });

    new Setting(row)
      .setName("Root")
      .setDesc("Vault-relative path prefix this vocabulary reads from. Blank = the whole vault.")
      .addText((t) => {
        t.setValue(inst.root);
        t.onChange((value) => commit({ root: value }));
      });

    const configProblemEl = row.createEl("p", { cls: "mod-warning" });
    new Setting(row)
      .setName("Config (JSON)")
      .setDesc('Provider-specific options as a JSON object, e.g. {"termsRoot": "Assent"}. Blank = none.')
      .addTextArea((t) => {
        t.setValue(stringifyVocabConfig(inst.config));
        t.inputEl.rows = 3;
        t.inputEl.style.width = "100%";
        t.onChange(async (value) => {
          const parsed = parseVocabConfig(value);
          // Loud refusal on unparseable / non-object JSON — the bad value is
          // NOT saved (the previous good config survives), matching the
          // number-field contract. A valid parse (or blank ⇒ remove) commits.
          if (!parsed.ok) {
            configProblemEl.setText(parsed.error);
            return;
          }
          configProblemEl.setText("");
          await commit({ config: parsed.config });
        });
      });

    new Setting(row).addButton((b) =>
      b.setButtonText("Remove instance").setWarning().onClick(async () => {
        await persist(removeVocabInstanceAt(current(), index));
        paint();
      }),
    );
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
