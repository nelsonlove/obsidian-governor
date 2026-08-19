import * as os from "node:os";
import * as path from "node:path";

export function vaultSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The state namespace: `~/.claude/governor/` holds `bridge.mjs`,
 * `<vault-slug>.sock`, `<vault-slug>.json`. Renamed from `~/.claude/vault-mcp/`
 * in 0.12.0 (the plugin-id migration); the old dir remains a grace-period
 * compat surface — see `legacyStateDir` and discovery.ts. */
export function stateDir(): string {
  return path.join(os.homedir(), ".claude", "governor");
}

/** The pre-0.12.0 state namespace (`~/.claude/vault-mcp/`). Existing Claude
 * Code registrations point `node` at the bridge here, and old bridges read
 * discovery jsons from here — so during the grace period the plugin ALSO
 * writes the bridge and a `legacy: true` discovery copy (whose `socket_path`
 * points at the NEW socket) into this dir. Removed after the fleet
 * re-registers under the `governor` server name. */
export function legacyStateDir(): string {
  return path.join(os.homedir(), ".claude", "vault-mcp");
}

export function socketPath(slug: string): string {
  return path.join(stateDir(), `${slug}.sock`);
}

export function discoveryPath(slug: string): string {
  return path.join(stateDir(), `${slug}.json`);
}

export function legacyDiscoveryPath(slug: string): string {
  return path.join(legacyStateDir(), `${slug}.json`);
}

export function bridgeDestPath(): string {
  return path.join(stateDir(), "bridge.mjs");
}

export function legacyBridgeDestPath(): string {
  return path.join(legacyStateDir(), "bridge.mjs");
}
