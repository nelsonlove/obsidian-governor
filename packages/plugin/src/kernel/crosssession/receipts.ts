// receipts.ts — the read-receipt store (#232): per-handle, per-channel "read
// through <stamp>" attestations, in MODULE STATE — deliberately NOT in any
// note's frontmatter (a receipt is a claim about the reader, not a property of
// the channel; writing it into the note tree would put agent state where vault
// content lives) and NOT in data.json (settings sync/export as config; read
// positions are per-install operational state). The file sits beside the
// journal and install-id.json under the plugin's own directory
// (`<plugin dir>/crosssession-receipts.json`) — the install-id precedent:
// operational state lives with the audit stream, not with settings.
//
// A receipt is a READ-RECEIPT, not authority: it confers nothing, gates only
// the module's own `crosssession_post` staleness check, and touches no
// acceptance field anywhere. Handles are COOPERATIVE (self-declared by the
// caller, per the fleet's fallible-not-adversarial threat model) — the store
// records what a session claimed to have read; it cannot verify the reading.
//
// Failure discipline follows install-id.ts: a corrupt file is treated as empty
// (logged) rather than fatal; an unwritable dir degrades to in-memory state
// for this load rather than failing the operation. Read-modify-write races are
// prevented upstream: every mutating tool call is serialized through the
// plugin-singleton write queue, so two attests never interleave.

/** The Obsidian DataAdapter slice this needs — same duck type as
 * InstallIdAdapter, narrowed for headless tests. */
export interface ReceiptAdapter {
  exists(normalizedPath: string): Promise<boolean>;
  read(normalizedPath: string): Promise<string>;
  mkdir(normalizedPath: string): Promise<void>;
  write(normalizedPath: string, data: string): Promise<void>;
}

/** File name inside the plugin's data directory. */
export const RECEIPTS_FILE = "crosssession-receipts.json";

/** One handle's receipt on one channel. */
export interface Receipt {
  /** The attested stamp, verbatim (opaque ordered string — see entries.ts). */
  through: string;
  /** When the attestation was recorded (informational, ISO). */
  at: string;
}

/** channelKey → handle → receipt. Channel keys are uids when the channel note
 * carries one (a reorg move keeps read state), else `path:`-prefixed paths. */
export type ReceiptsState = Record<string, Record<string, Receipt>>;

/** The store surface the tool layer needs — an interface so tests (and the
 * mount's inert default) can supply a memory-backed stand-in. */
export interface ReceiptStoreLike {
  get(channelKey: string, handle: string): Promise<Receipt | null>;
  set(channelKey: string, handle: string, through: string, at: string): Promise<void>;
  channel(channelKey: string): Promise<Record<string, Receipt>>;
}

function sane(parsed: unknown): ReceiptsState {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: ReceiptsState = {};
  for (const [ck, handles] of Object.entries(parsed as Record<string, unknown>)) {
    if (handles === null || typeof handles !== "object" || Array.isArray(handles)) continue;
    const row: Record<string, Receipt> = {};
    for (const [h, r] of Object.entries(handles as Record<string, unknown>)) {
      const rec = r as { through?: unknown; at?: unknown };
      if (rec && typeof rec.through === "string") {
        row[h] = { through: rec.through, at: typeof rec.at === "string" ? rec.at : "" };
      }
    }
    if (Object.keys(row).length > 0) out[ck] = row;
  }
  return out;
}

/** Disk-backed receipt store. Load-on-every-call: the file is tiny, and per-call
 * freshness means every connection (each per-connection server builds its own
 * store instance) reads the same truth without a shared singleton. */
export class ReceiptStore implements ReceiptStoreLike {
  constructor(
    private readonly adapter: ReceiptAdapter,
    /** The plugin's data directory (`.obsidian/plugins/governor`). */
    private readonly dir: string,
  ) {}

  private get file(): string {
    return `${this.dir}/${RECEIPTS_FILE}`;
  }

  async load(): Promise<ReceiptsState> {
    try {
      if (!(await this.adapter.exists(this.file))) return {};
      const raw = await this.adapter.read(this.file);
      try {
        return sane(JSON.parse(raw));
      } catch {
        console.error(`[governor] ${this.file} is unreadable; treating receipts as empty`);
        return {};
      }
    } catch (e) {
      console.error("[governor] crosssession receipts could not be read", e);
      return {};
    }
  }

  async get(channelKey: string, handle: string): Promise<Receipt | null> {
    const state = await this.load();
    return state[channelKey]?.[handle] ?? null;
  }

  async channel(channelKey: string): Promise<Record<string, Receipt>> {
    const state = await this.load();
    return state[channelKey] ?? {};
  }

  async set(channelKey: string, handle: string, through: string, at: string): Promise<void> {
    const state = await this.load();
    const row = state[channelKey] ?? {};
    row[handle] = { through, at };
    state[channelKey] = row;
    try {
      if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
      await this.adapter.write(this.file, JSON.stringify(state, null, 2) + "\n");
    } catch (e) {
      // A receipt that could not persist is logged and lost on reload — the
      // caller's operation (attest / post) still succeeded; the next delta
      // simply re-serves what the lost receipt would have covered.
      console.error("[governor] crosssession receipt could not be persisted", e);
    }
  }
}

/** In-memory store — the mount's inert default (a mount without injected
 * state), and the tests' harness. Same semantics, no disk. */
export function memoryReceiptStore(): ReceiptStoreLike & { state: ReceiptsState } {
  const state: ReceiptsState = {};
  return {
    state,
    async get(ck, h) {
      return state[ck]?.[h] ?? null;
    },
    async channel(ck) {
      return state[ck] ?? {};
    },
    async set(ck, h, through, at) {
      (state[ck] ??= {})[h] = { through, at };
    },
  };
}
