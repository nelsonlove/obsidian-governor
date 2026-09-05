// VAULT CROSS-SESSION — the fleet's coordination channels as their own Obsidian
// plugin.
//
// Published to the Governor host through vault-mcp-api as four MCP tools:
//
//   vault_crosssession_channels — discover channels by fileClass + `audience:`
//                                 frontmatter (read-only in intent; the host
//                                 distrusts that claim, see below);
//   vault_crosssession_delta    — entries newer than your attested position;
//   vault_crosssession_attest   — record a read receipt (mutating: plugin
//                                 state, journaled by the host);
//   vault_crosssession_post     — append one entry, refused while you are stale.
//
// SATELLITE OF THE SUITE (suite-split design §6). Extracted out of the host at
// S6, following the quickadd-choices-compile pilot, the vault-skills satellite
// (S4) and the vault-triage satellite (S5). Consequences of the publishing
// contract, each deliberate:
//
//   * THE PUBLISHED TOOL NAMES CHANGED — `crosssession_*` became
//     `vault_crosssession_*`. The host publishes an external tool as
//     `<sanitized publisher id>_<bare name>`, so the plugin id IS the tool
//     namespace; `vault-crosssession` sanitizes to `vault_crosssession`. Same
//     rename class as triage. Recorded in CLAUDE.md, not buried here.
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST, and for this surface it closes
//     harder than the in-tool filter it replaces: none of the four tools
//     carries a recognized path key, so under an active path allowlist the host
//     blocks all four outright. Fail-closed. See tools.ts for why `channel` was
//     deliberately not renamed into a path key.
//   * REFUSALS THROW; the host renders a thrown error's lowercase-snake `code`
//     as `Error [code]: message`, the envelope the module already produced.
//   * The host's queue, journal and kernel args still apply — external mutating
//     tools ride the guarded registration path like every built-in. That is
//     also why the record-immutability guard's reachability is unchanged by the
//     move: it always saw these tools, and their arguments still name no path.
//
// THIS PLUGIN NEEDS THE HOST, like the triage satellite and unlike skills. It
// has no pane, no palette command and no ribbon: its entire surface is the four
// published tools. With Governor absent it loads, keeps its settings, adopts
// nothing, and does nothing — `publishTools` waits on the host's ready event
// and registers if one appears. The settings tab says so plainly.
//
// TWO ADOPTIONS, not one. Config adoption is the skills/triage pattern. RECEIPT
// adoption is new here and is the reason this extraction touches live operator
// state at all: `crosssession-receipts.json` sat in the HOST's plugin dir and
// records which handles have read which channels through which stamp. Left
// behind, every affected handle's next delta re-serves what it already read and
// its next post refuses `stale_read` on entries it already attested. Both
// adoptions are one-shot, latched separately, and NEVER write the host's copy.
//
// RE-PUBLISHING ON CONFIG CHANGE, as in the triage satellite. The `channels`
// tool's description renders the configured channel fileClass, and the host
// snapshots a published spec when it registers it — so without a republish the
// description would freeze at plugin load and a renamed fileClass would be
// misreported to every agent that reads the tool list. Disposing and
// re-publishing on every settings write restores the per-connection freshness
// the module had.

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { buildCrosssessionTools } from "./tools.js";
import { obsidianCrosssessionSource, obsidianReceiptStore } from "./obsidian-source.js";
import { CrosssessionSettingTab } from "./settings-tab.js";
import type { ReceiptStore } from "./kernel/index.js";
import {
  adoptHostConfig,
  settingsOf,
  DEFAULT_PLUGIN_SETTINGS,
  type CrosssessionPluginSettings,
} from "./settings.js";

/** The host plugin's ids, newest first — the same pair vault-mcp-api reads, and
 *  for the same reason (Governor renamed `vault-mcp` → `governor` in 0.12.0).
 *  Used ONLY to find the settings and the receipt file to adopt from;
 *  publishing itself is entirely vault-mcp-api's business. */
const HOST_PLUGIN_IDS = ["governor", "vault-mcp"] as const;

interface HostPluginLike {
  settings?: unknown;
  manifest?: { dir?: string };
}

export default class VaultCrosssessionPlugin extends Plugin {
  settings: CrosssessionPluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };

  /** The live `publishTools` disposer, or null when nothing is published.
   *  Held rather than handed straight to `this.register` because a config
   *  change has to revoke and re-publish — see the header. */
  private unpublish: (() => void) | null = null;

  /** This plugin's own receipt store, built once: `manifest.dir` does not
   *  change for the life of the instance, and the store itself is stateless
   *  (it reads the file on every call). */
  private receipts!: ReceiptStore;

  async onload(): Promise<void> {
    this.settings = settingsOf(await this.loadData());
    this.receipts = obsidianReceiptStore(this.app as never, this.manifest.dir);

    await this.adoptFromHostOnce();
    await this.adoptReceiptsFromHostOnce();

    this.addSettingTab(
      new CrosssessionSettingTab(
        this.app,
        {
          getConfig: () => this.settings.config,
          setConfig: async (key, value) => {
            // `undefined` clears the override so the shipped default applies
            // again — persisting `undefined` would be a JSON hole, not a reset.
            if (value === undefined) delete this.settings.config[key];
            else this.settings.config[key] = value;
            await this.saveData(this.settings);
            this.republish();
          },
        },
        this,
      ),
    );

    // Unpublish on unload however we got here — including a republish that
    // never happened because publishing threw.
    this.register(() => {
      this.unpublish?.();
      this.unpublish = null;
    });

    this.republish();
  }

  /**
   * Revoke whatever is published and publish a freshly built set of specs.
   *
   * `publishTools` is internally defensive (it registers now or on the host's
   * ready event and never throws out of onload), but a failure here must not be
   * able to take down the settings tab either, so it is caught and reported.
   */
  private republish(): void {
    try {
      this.unpublish?.();
      this.unpublish = null;
      this.unpublish = publishTools(
        this,
        buildCrosssessionTools(obsidianCrosssessionSource(this.app as never), {
          // Read per call, never captured: the host holds a spec snapshot per
          // connection, so a captured config would freeze the settings tab's
          // values at plugin load. (The descriptions are necessarily build-time
          // snapshots regardless, which is why this method exists.)
          config: () => this.settings.config,
          receipts: this.receipts,
          // `getSettings` and `visible` are deliberately NOT supplied — a
          // satellite cannot reach the host's guard settings, and the host's
          // external-tool gate is the enforced boundary. See tools.ts.
        }),
      );
    } catch (e) {
      console.error("[vault-crosssession] publishing the tool surface failed", e);
    }
  }

  /** The host plugin instance, newest id first, or undefined. */
  private hostPlugin(): HostPluginLike | undefined {
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, HostPluginLike> };
    }).plugins?.plugins;
    for (const id of HOST_PLUGIN_IDS) {
      const host = plugins?.[id];
      if (host) return host;
    }
    return undefined;
  }

  /**
   * One-shot settings adoption from the host's `modules.crosssession.config`.
   *
   * The host's copy is READ and never written — see settings.ts for the three
   * rules.
   */
  private async adoptFromHostOnce(): Promise<void> {
    if (this.settings.adoptedFromHost) return;
    // `settings` is declared without an initializer on the host and only
    // assigned mid-onload — a plugin instance can be visible in the map before
    // that assignment runs. Treating that as "host present, empty settings"
    // would burn the one-shot latch on nothing and the user's config would
    // never adopt. An undefined settings bag reads as HOST NOT READY, exactly
    // like an absent host: adoption retries next load.
    const host = this.hostPlugin();
    const hostSettings = host && host.settings !== undefined ? host.settings : undefined;
    const adopted = adoptHostConfig(this.settings, hostSettings);
    if (!adopted) return;
    this.settings = adopted;
    await this.saveData(this.settings);
    console.info("[vault-crosssession] adopted the Governor host's modules.crosssession.config (one shot; the host's copy is untouched)");
  }

  /**
   * One-shot READ-RECEIPT adoption from the host's plugin directory.
   *
   * Separate latch from the config adoption: the two sources are independently
   * present (a host may carry receipts and no config override, which is exactly
   * the live operator's case). The host's `manifest.dir` is preferred over an
   * id-derived path for the same reason this plugin prefers its own — an
   * in-place id migration leaves folder and id diverged — with the id-derived
   * path as the fallback for a host reporting no dir.
   *
   * The host's file is READ ONLY. There is no write counterpart taking a
   * directory (`ReceiptStore.loadFrom` has no `saveTo`), so "never write the
   * host's copy" is structural here rather than merely intended.
   */
  private async adoptReceiptsFromHostOnce(): Promise<void> {
    if (this.settings.adoptedReceiptsFromHost) return;
    const host = this.hostPlugin();
    if (!host) return; // host absent — try again next load, like config adoption
    const configDir = (this.app as unknown as { vault: { configDir: string } }).vault.configDir;
    const dirs = host.manifest?.dir
      ? [host.manifest.dir]
      : HOST_PLUGIN_IDS.map((id) => `${configDir}/plugins/${id}`);
    let adopted = 0;
    // Failure paths hold the latch OPEN so the next load retries — and since
    // the review (2026-09-05) that promise is implemented rather than merely
    // written down: `loadFrom` returns NULL for an unreadable/corrupt host
    // file (only a genuinely absent one reads as "nothing to adopt"), and
    // `merge` reports whether the union actually reached disk. Before that,
    // both failures were swallowed into their happy-path shapes, the latch
    // burned, and the host's live receipts were permanently dropped while the
    // log said they were adopted.
    for (const dir of dirs) {
      const incoming = await this.receipts.loadFrom(dir);
      if (incoming === null) {
        console.error(`[vault-crosssession] could not read the host's receipt file in ${dir}; will retry next load`);
        return;
      }
      if (Object.keys(incoming).length === 0) continue;
      const result = await this.receipts.merge(incoming);
      if (!result.persisted) {
        console.error("[vault-crosssession] adopted receipts could not be persisted; will retry next load");
        return;
      }
      adopted = result.adopted;
      break;
    }
    // Latch even when nothing was adopted: the question was asked and answered
    // (a host with no receipt file has none to give), and re-asking every load
    // would let a much later host write reach in.
    this.settings = { ...this.settings, adoptedReceiptsFromHost: true };
    await this.saveData(this.settings);
    if (adopted > 0) {
      console.info(`[vault-crosssession] adopted ${adopted} read receipt(s) from the Governor host (one shot; the host's copy is untouched)`);
    }
  }
}
