// Connection preamble — how the bridge tells the per-connection server which
// surface to build BEFORE the MCP stream starts. One optional NDJSON line,
// sent as the very first thing on the socket:
//
//   {"vault_mcp_preamble":1,"code_mode":true}
//
// Back-compat is structural: a bridge that wants the default surface sends no
// preamble at all (byte-identical to the pre-preamble protocol), and the
// listener treats a first line that isn't a preamble as a normal MCP message.
// Shared by bridge/bridge.ts (writer) and socket-transport.ts (reader) so the
// two sides can't diverge — same pattern as ndjson.ts.

export interface ConnOptions {
  /** Register the compact search/describe/call meta-tool surface instead of the full tool set. */
  codeMode: boolean;
}

export const DEFAULT_CONN_OPTIONS: ConnOptions = { codeMode: false };

export function buildPreamble(opts: ConnOptions): string {
  return JSON.stringify({ vault_mcp_preamble: 1, code_mode: opts.codeMode });
}

/** Parse a candidate first line. Returns null when it isn't a preamble (i.e. a normal MCP message — deliver it). */
export function parsePreamble(line: string): ConnOptions | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (obj.vault_mcp_preamble !== 1) return null;
  return { codeMode: obj.code_mode === true };
}
