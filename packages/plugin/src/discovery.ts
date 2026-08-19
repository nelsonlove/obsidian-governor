import * as fs from "node:fs";
import {
  stateDir,
  discoveryPath,
  bridgeDestPath,
  legacyStateDir,
  legacyDiscoveryPath,
  legacyBridgeDestPath,
} from "./paths.js";
import { BRIDGE_SOURCE } from "./bridge-asset.js";

export interface Discovery {
  socket_path: string;
  vault_path: string;
  vault_name: string;
  plugin_version: string;
  obsidian_version: string;
  started_at: string;
  /** Protocol features this plugin build supports (e.g. "preamble"). The
   * bridge gates optional wire features on this list instead of guessing from
   * plugin_version, so an older plugin never receives bytes it can't parse. */
  capabilities?: string[];
  /** Present (true) only on the compat copy written into the pre-0.12.0
   * `~/.claude/vault-mcp/` dir during the id-migration grace period. Its
   * `socket_path` points at the NEW socket, so old bridges keep connecting;
   * new bridges skip `legacy` entries when merging the two dirs (the
   * canonical twin is already in `~/.claude/governor/`). */
  legacy?: boolean;
}

export function writeDiscovery(slug: string, d: Discovery): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(discoveryPath(slug), JSON.stringify(d, null, 2), { mode: 0o600 });
  // Grace-period compat (0.12.0 id migration): ALSO write a `legacy: true`
  // copy at the old `~/.claude/vault-mcp/` path, pointing at the NEW socket,
  // so existing `vault-mcp` registrations (old bridge bytes reading the old
  // dir) keep working until the fleet re-registers. Best-effort — a failure
  // here must never take down the canonical discovery.
  try {
    fs.mkdirSync(legacyStateDir(), { recursive: true });
    fs.writeFileSync(
      legacyDiscoveryPath(slug),
      JSON.stringify({ ...d, legacy: true }, null, 2),
      { mode: 0o600 },
    );
  } catch (e) {
    console.error("[governor] legacy discovery write failed (compat copy only)", e);
  }
}

export function removeDiscovery(slug: string): void {
  try { fs.unlinkSync(discoveryPath(slug)); } catch { /* gone */ }
  try { fs.unlinkSync(legacyDiscoveryPath(slug)); } catch { /* gone */ }
}

// Writes the build-time-embedded bridge text to ~/.claude/governor/bridge.mjs,
// and — grace-period compat — to the old ~/.claude/vault-mcp/bridge.mjs, which
// existing Claude Code registrations still point `node` at. Both copies are
// the same bytes; the bridge itself reads discoveries from BOTH dirs (skipping
// `legacy` duplicates), so either entry point reaches the live socket.
export function writeBridge(): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(bridgeDestPath(), BRIDGE_SOURCE, { mode: 0o755 });
  try {
    fs.mkdirSync(legacyStateDir(), { recursive: true });
    fs.writeFileSync(legacyBridgeDestPath(), BRIDGE_SOURCE, { mode: 0o755 });
  } catch (e) {
    console.error("[governor] legacy bridge write failed (compat copy only)", e);
  }
}
