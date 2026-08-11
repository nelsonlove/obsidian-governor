import { Plugin, FileSystemAdapter, Modal, Notice } from "obsidian";
import * as fs from "node:fs";
import { UnixSocketListener } from "./socket-transport.js";
import { buildMcpServer } from "./mcp/server.js";
import { vaultSlug, socketPath, stateDir, bridgeDestPath } from "./paths.js";
import { writeDiscovery, removeDiscovery, writeBridge, type Discovery } from "./discovery.js";
import { ConnectionSetupModal, VaultMcpSettingTab } from "./connection-ui.js";
import { findClaudeBinary, claudeIsRegistered, claudeRegister, claudeRemove, claudeEnsureConnectPlugin } from "./claude-cli.js";
import { ExternalToolRegistry, type VaultMcpApi } from "./mcp/external-tools.js";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore, UidIndex, loadInstallId, DEFAULT_VOCABULARIES, type VocabInstanceSettings, type ModuleSettings } from "./kernel/index.js";
import { obsidianProbe, obsidianServerIdentity, obsidianUidSource } from "./kernel/obsidian-probe.js";
import { DEFAULT_SCHEMES, type SchemeInstanceConfig } from "./kernel/scheme/registry.js";
import { wireGovernance } from "./governance/wiring.js";

interface VaultMcpSettings {
  setupAcknowledged: boolean;
  readOnly: boolean;
  allowlist: string[];
  enabled: boolean;
  allowDangerousCli: boolean;
  /**
   * Plugin ids whose tools may declare themselves read-only and be believed.
   * Empty by default: an external tool's `readOnlyHint: true` is otherwise
   * treated as mutating (queued, journaled, allowlist-scoped, blocked in
   * read-only mode) — see mcp/external-tools.ts.
   */
  trustedReadOnlyPlugins: string[];
  /**
   * Controlled-vocabulary sources for the vocab tools (mcp/tools-vocab.ts):
   * `{ id, provider, root, config }` rows, mirroring the scheme settings
   * shape. Defaults to one registry-blueprint instance over the vault's
   * registries slot plus one glossary instance. No settings-tab UI yet —
   * hand-edit data.json (v1).
   */
  vocabularies: VocabInstanceSettings[];
  /**
   * Scope-provider instances (scheme id + provider name + per-provider
   * config). Defaults to DEFAULT_SCHEMES — the single "jd" instance backed by
   * the Johnny Decimal provider with its own default config. Scheme semantics
   * are configuration, not hardwired (Nelson's ruling): only the default
   * instance's JD config gets a settings-tab UI (comma-separated expanded
   * areas/categories + content-decimal floor); additional instances or
   * exotic overrides stay data.json-editable, no UI (YAGNI) — see
   * kernel/scheme/registry.ts for the deep-merge-over-defaults and
   * skip-and-report-on-invalid-config behavior this list feeds.
   */
  schemes: SchemeInstanceConfig[];
  /**
   * The module host's per-module rows (`{ enabled?, config? }` keyed by
   * module id — "scheme", "vocab"). An absent row means the module's default
   * (both built-ins default enabled); `enabled: false` unmounts that module's
   * whole tool surface on the next connection. See kernel/modules/ and
   * mcp/modules-mount.ts.
   */
  modules: ModuleSettings;
  /**
   * Command policy for the arbitrary-execution surfaces (obsidian_cli +
   * obsidian_run_command): a deny list (always wins) and the per-command
   * re-enable list for the deny-by-default opaque-accept set (quickadd/eval/
   * command; quickadd:* run_command ids). Human-only by construction — no MCP
   * surface writes plugin settings, and the surfaces that could reach one
   * indirectly are what this policy denies. See mcp/cli-policy.ts.
   */
  cliPolicy: { deny: string[]; allowOpaque: string[] };
}
const DEFAULT_SETTINGS: VaultMcpSettings = {
  setupAcknowledged: false,
  readOnly: false,
  allowlist: [],
  enabled: true,
  allowDangerousCli: false,
  trustedReadOnlyPlugins: [],
  // Cloned so settings edits can never mutate the module-level default rows
  // (item 6: schemes now clones symmetrically with vocabularies — a shallow
  // `.map((s) => ({...s}))` would miss a nested `config` object were one ever
  // added to DEFAULT_SCHEMES's entries, so this uses structuredClone for a
  // real deep copy rather than assuming the shape stays flat).
  vocabularies: DEFAULT_VOCABULARIES.map((v) => ({ ...v })),
  schemes: structuredClone(DEFAULT_SCHEMES),
  modules: {},
  cliPolicy: { deny: [], allowOpaque: [] },
};

class DiagnosticsModal extends Modal {
  constructor(app: any, private readonly lines: string[]) { super(app); }
  onOpen() {
    this.titleEl.setText("vault-mcp diagnostics");
    for (const l of this.lines) this.contentEl.createEl("p", { text: l });
  }
  onClose() { this.contentEl.empty(); }
}

export default class VaultMcpPlugin extends Plugin {
  private listener: UnixSocketListener | null = null;
  private slug = "";
  declare settings: VaultMcpSettings;
  private externalRegistry = new ExternalToolRegistry();
  // Public plugin-to-plugin API: app.plugins.plugins['vault-mcp'].api
  api: VaultMcpApi = {
    apiVersion: 1,
    registerTools: (owner, tools) => this.externalRegistry.registerTools(owner, tools),
    unregisterTools: (owner) => this.externalRegistry.unregisterTools(owner),
  };

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Object.assign is shallow: a hand-edited data.json carrying a PARTIAL
    // cliPolicy (one list, not both) would leave the other undefined and
    // crash the settings tab; a WRONG-TYPED one (a string where a list
    // belongs) would crash the policy matcher mid-call. Normalize to fresh
    // arrays of strings — dropping malformed values, never throwing — and
    // never alias DEFAULT_SETTINGS' own arrays (the schemes structuredClone
    // discipline). Policy semantics are unaffected: a dropped malformed
    // entry can only mean MORE denied, never less.
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    this.settings.cliPolicy = {
      deny: list(this.settings.cliPolicy?.deny),
      allowOpaque: list(this.settings.cliPolicy?.allowOpaque),
    };
  }
  async saveSettings() { await this.saveData(this.settings); }

  private discoveryCount(): number {
    try { return fs.readdirSync(stateDir()).filter((f) => f.endsWith(".json")).length; }
    catch { return 0; }
  }

  async autoRegister(force = false): Promise<void> {
    const bin = findClaudeBinary();
    if (!bin) {
      if (force) new Notice("vault-mcp: `claude` CLI not found. Use the manual command in settings.");
      else this.showFallbackOnce();
      return;
    }
    if (!force && this.discoveryCount() > 1) { this.showFallbackOnce(); return; } // ambiguous: multiple vaults
    try {
      if (await claudeIsRegistered(bin)) {
        // `claude mcp add` errors on a duplicate name, so never re-add.
        if (force) new Notice("vault-mcp: already connected to Claude Code.");
        this.ensureConnectPlugin(bin, force);
        return;
      }
      await claudeRegister(bin, bridgeDestPath(), this.app.vault.getName());
      new Notice("vault-mcp: connected to Claude Code. Restart any open Claude Code session to use it.");
      this.ensureConnectPlugin(bin, force);
    } catch (e) {
      new Notice(`vault-mcp: auto-register failed — ${(e as Error).message}. Use the manual command in settings.`);
      this.showFallbackOnce();
    }
  }

  // #38: fire-and-forget provisioning of the vault-mcp-connect Claude Code
  // plugin (SessionStart health hook + /vault-mcp-status) alongside the MCP
  // registration. Idempotent + quiet: a Notice only on a forced run or when
  // something was actually installed; failures log once, never nag.
  private ensureConnectPlugin(bin: string, force: boolean): void {
    void claudeEnsureConnectPlugin(bin)
      .then((r) => {
        if (r === "installed") new Notice("vault-mcp: installed the vault-mcp-connect Claude Code plugin.");
        else if (force) new Notice("vault-mcp: vault-mcp-connect plugin already installed.");
      })
      .catch((e: unknown) => {
        console.error("vault-mcp: connect-plugin provisioning skipped —", e instanceof Error ? e.message : e);
      });
  }

  async claudeRemoveRegistration(): Promise<void> {
    const bin = findClaudeBinary();
    if (!bin) { new Notice("vault-mcp: `claude` CLI not found."); return; }
    await claudeRemove(bin);
    new Notice("vault-mcp: removed Claude Code registration.");
  }

  private showFallbackOnce(): void {
    if (this.settings.setupAcknowledged) return;
    new ConnectionSetupModal(this.app, async () => { this.settings.setupAcknowledged = true; await this.saveSettings(); }).open();
  }

  /**
   * Keep the uid index fresh off Obsidian's own events — no polling, no timers,
   * no filesystem reads.
   *
   *   • build once when the layout is ready, because before that the metadata
   *     cache is still warming and a build would index a fraction of the vault;
   *   • `metadataCache.changed` covers every uid EDIT — added, changed, removed
   *     — and every newly created note, since the cache parses it on arrival;
   *   • `vault.rename` is the one that matters most: it is precisely the event
   *     a path-keyed store loses to, and the whole reason the index exists;
   *   • `vault.delete` drops the mapping.
   *
   * registerEvent so every handler is detached when the plugin unloads.
   *
   * `onLayoutReady` is the exception: it takes a plain callback and returns no
   * EventRef, so there is nothing for registerEvent to detach. A plugin unloaded
   * before the layout settles would otherwise still run its rebuild — indexing a
   * vault on behalf of an instance that no longer exists — so the callback is
   * gated on a disposed flag that `register` flips at unload. Wired only when
   * the plugin is enabled: a disabled plugin serves no connection, so an index
   * it maintains is upkeep nobody can read.
   */
  private wireUidIndex(index: UidIndex): void {
    let disposed = false;
    this.register(() => { disposed = true; });
    this.app.workspace.onLayoutReady(() => { if (!disposed) index.rebuild(); });
    this.registerEvent(this.app.metadataCache.on("changed", (file) => index.onChanged(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => index.onRenamed(oldPath, file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => index.onDeleted(file.path)));
  }

  async onload() {
    // Load settings FIRST so the enabled gate and guard settings are available.
    await this.loadSettings();

    const vaultName = this.app.vault.getName();
    this.slug = vaultSlug(vaultName);
    const sock = socketPath(this.slug);

    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

    // Write the build-time-embedded bridge into ~/.claude/vault-mcp/.
    try { writeBridge(); }
    catch (e) { console.error("[vault-mcp] writeBridge failed", e); }

    // Kernel v0 — ONE queue and ONE journal per plugin instance, shared by
    // every per-connection server built below. The journal lives beside the
    // plugin's own data (`.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl`),
    // out of the note tree so it can never be mistaken for vault content.
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    // The identity substrate's uid index — one per plugin instance, like the
    // queue: it is a map of the vault, not of a connection.
    const uidIndex = new UidIndex(obsidianUidSource(this.app));
    const kernel = new Kernel(
      new WriteQueue(),
      new WriteJournal(this.app.vault.adapter, `${pluginDir}/journal`),
      obsidianProbe(this.app),
      new IdempotencyStore(),
      new LockStore(),
      uidIndex,
    );

    // Server identity — the transport asserting which vault and which install.
    // The install id is a small file beside the journal (`install-id.json`), so
    // the identity that stamps every record lives with the records; it survives
    // restarts, and a failure to persist degrades to an ephemeral id rather than
    // failing the load.
    const { install } = await loadInstallId(this.app.vault.adapter, pluginDir);
    const serverIdentity = obsidianServerIdentity(this.app, install, this.manifest.version);

    const ctx = {
      pluginVersion: this.manifest.version,
      socketPath: sock,
      vaultName,
      enabledPlugins: () => Array.from((this.app as any).plugins.enabledPlugins as Set<string>),
      getSettings: () => ({
        readOnly: this.settings.readOnly,
        allowlist: this.settings.allowlist,
        allowDangerousCli: this.settings.allowDangerousCli,
        trustedReadOnlyPlugins: this.settings.trustedReadOnlyPlugins,
        schemes: this.settings.schemes,
        modules: this.settings.modules,
        cliPolicy: this.settings.cliPolicy,
      }),
      serverIdentity,
      getExternalTools: () => this.externalRegistry.entries(),
      getVocabularies: () => this.settings.vocabularies,
      kernel,
    };

    if (this.settings.enabled) {
      // The uid index is kept fresh only while the plugin actually serves: with
      // the socket down nothing can address a uid, so an index maintained off
      // every metadata event would be work done for no reader.
      this.wireUidIndex(uidIndex);

      // One MCP server per connection → concurrent Claude Code sessions and
      // background agents share the plugin without evicting each other.
      this.listener = new UnixSocketListener(sock, (transport, connOpts) => {
        const server = buildMcpServer(this.app, ctx, { codeMode: connOpts.codeMode });
        server.connect(transport).catch((e) => console.error("[vault-mcp] connect failed", e));
      });
      await this.listener.listen();

      const discovery: Discovery = {
        socket_path: sock,
        vault_path: basePath,
        vault_name: vaultName,
        plugin_version: this.manifest.version,
        obsidian_version: (this.app as any).appVersion ?? "",
        started_at: new Date().toISOString(),
        capabilities: ["preamble"],
      };
      writeDiscovery(this.slug, discovery);
      console.log(`[vault-mcp] listening on ${sock}`);
    } else {
      console.log("[vault-mcp] disabled in settings; socket not started");
    }

    this.addSettingTab(new VaultMcpSettingTab(this.app, this));

    // ── governance (Acceptance) review pane (#83, cycle 2) ─────────────────────
    // Wired ONLY when the governance module is enabled (default OFF — the module
    // default is `enabled: false`, so an absent settings row means off). This is
    // the human-only Accept surface: an Obsidian review pane whose Accept / Revert
    // / Adopt / auto-accept-allowlist controls are gesture-gated closures — NEVER a
    // command, an MCP tool, or a method on this plugin instance. It is independent
    // of the MCP socket (`settings.enabled`): a human can review even with the
    // transport off. The read-only obsidian_pending_review MCP view is registered
    // always-on in server.ts, separate from this toggle. See src/governance/.
    if (this.settings.modules?.governance?.enabled === true) {
      void wireGovernance(this, {
        getConfig: () => (this.settings.modules?.governance?.config ?? {}) as Record<string, unknown>,
      }).catch((e) => console.error("[vault-mcp] governance pane wiring failed", e));
    }

    this.addCommand({
      id: "connect-claude-code",
      name: "Connect to Claude Code",
      callback: () => this.autoRegister(true),
    });

    void this.autoRegister();

    this.addCommand({
      id: "show-diagnostics",
      name: "Show diagnostics",
      callback: () => {
        const enabled = Array.from((this.app as any).plugins.enabledPlugins as Set<string>);
        const integrations = ["dataview", "templater-obsidian", "omnisearch", "metadata-menu"]
          .map((id) => `${id}: ${enabled.includes(id) ? "yes" : "no"}`);
        new DiagnosticsModal(this.app, [
          `Vault: ${this.app.vault.getName()}`,
          `Socket: ${socketPath(this.slug)}`,
          `Version: ${this.manifest.version}`,
          ...integrations,
        ]).open();
      },
    });

    // Signal publishers (vault-mcp-api SDK) that the api is (re-)available.
    this.app.workspace.trigger("vault-mcp:ready", this.api);
  }

  async onunload() {
    await this.listener?.close();
    removeDiscovery(this.slug);
  }
}
