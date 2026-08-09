// Install identity — the durable half of kernel v0's server identity.
//
// The journal's actor says which transport, which client and which connection
// produced an operation. Server identity says which VAULT and which INSTALL:
// the transport asserting what it is, rather than the caller claiming it. Vault
// name and plugin version are already known at load; the install id is the one
// piece that has to survive a restart, so it lives in a file.
//
// Beside the journal (`<plugin data dir>/install-id.json`), not in the plugin's
// settings blob and emphatically not in localStorage: settings get exported,
// reset and hand-edited, and localStorage is per-Electron-profile state the user
// has no reason to expect to be durable. A tiny file next to the audit stream is
// the right shape — the identity that stamps every record sits with the records.
//
// Failing to read or write it is never fatal: an ephemeral id is minted, the
// failure is logged, and the journal still says which install it came from —
// just not stably across restarts. An audit stream with a slightly weaker actor
// beats no vault operations at all.

/** File name inside the plugin's data directory. */
export const INSTALL_ID_FILE = "install-id.json";

/**
 * The slice of Obsidian's DataAdapter this needs. Narrowed to a duck type for
 * the same reason JournalAdapter is: headless tests, and no accidental reach
 * for a delete API.
 */
export interface InstallIdAdapter {
  exists(normalizedPath: string): Promise<boolean>;
  read(normalizedPath: string): Promise<string>;
  mkdir(normalizedPath: string): Promise<void>;
  write(normalizedPath: string, data: string): Promise<void>;
}

/** Stable identity of one plugin installation, stamped on every journal record. */
export interface ServerIdentity {
  /** `app.vault.getName()` — which vault this transport speaks for. */
  vault: string;
  /** Persistent per-install id (see loadInstallId). */
  install: string;
  /** Plugin manifest version. */
  version: string;
}

/**
 * A fresh install id. `crypto.randomUUID` where the runtime has it (Node 19+,
 * Electron); otherwise time + randomness, which is more than enough to keep two
 * installs apart in an audit stream.
 */
export function mintInstallId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** What was on disk, when there was anything usable there. */
interface InstallIdFile {
  install?: unknown;
  createdAt?: unknown;
}

export interface LoadedInstallId {
  install: string;
  /**
   * False when the id could not be read OR written — the id is live for this
   * session but will differ after a restart, and the caller may want to say so.
   */
  persisted: boolean;
}

/**
 * Read the install id from `<dir>/install-id.json`, minting and persisting one
 * on first run.
 *
 * A file that exists but doesn't parse (truncated write, hand-edit) is
 * REPLACED rather than respected: the alternative is an identity that changes on
 * every load, which is worse than one that changes once.
 */
export async function loadInstallId(
  adapter: InstallIdAdapter,
  dir: string,
  mint: () => string = mintInstallId
): Promise<LoadedInstallId> {
  const file = `${dir}/${INSTALL_ID_FILE}`;
  try {
    if (await adapter.exists(file)) {
      const raw = await adapter.read(file);
      let parsed: InstallIdFile | undefined;
      try {
        parsed = JSON.parse(raw) as InstallIdFile;
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed.install === "string" && parsed.install) {
        return { install: parsed.install, persisted: true };
      }
      console.error(`[vault-mcp] ${file} is unreadable; minting a new install id`);
    }
    const install = mint();
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(file, JSON.stringify({ install, createdAt: new Date().toISOString() }, null, 2) + "\n");
    return { install, persisted: true };
  } catch (e) {
    console.error("[vault-mcp] install id could not be persisted; using an ephemeral one", e);
    return { install: mint(), persisted: false };
  }
}
