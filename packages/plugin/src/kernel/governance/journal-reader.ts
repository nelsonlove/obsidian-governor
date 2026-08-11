// Reads the vault-mcp write journal — the audit stream the governance module consumes as
// its queue source. Every mutating MCP op is one JSONL record:
//   { ts, op, target:{path,uid?,ref?}, actor:{transport,client,connection,server},
//     argsDigest, outcome, revBefore?, revAfter, queueWaitMs, durationMs, effects? }
// We are a READER only — governance never writes to the journal.
//
// Everything here is pure parsing over already-loaded text so it unit-tests headlessly.
// The Obsidian glue (finding + reading the .jsonl files off the adapter) is cycle-2 work.
//
// Ported verbatim from obsidian-stewardship/src/journal-reader.ts (#83, cycle 1).

export interface JournalRecord {
  ts: string;
  op: string;
  target?: { path?: string; uid?: string; ref?: string };
  actor?: {
    transport?: string;
    client?: string;
    connection?: string;
    server?: unknown;
  };
  outcome?: string;
  revBefore?: number;
  revAfter?: number;
  // Optional agent-authored "why I made this change" note. UNTRUSTED free text (up to ~2000
  // chars) — absent on older records. Callers MUST render it as a plain text node only;
  // never as HTML, markdown, or any other interpreted sink.
  intent?: string;
}

// Ops that mutate a single note's content — the ones whose target.path becomes reviewable.
// Moves/renames/link-repoints and scope ops are out of scope for v0 content review.
export const CONTENT_WRITE_OPS = new Set([
  "obsidian_write_note",
  "obsidian_append_note",
  "obsidian_patch_note",
  "obsidian_manage_frontmatter",
]);

export function parseJournal(text: string): JournalRecord[] {
  const out: JournalRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as JournalRecord);
    } catch {
      // A partially-written trailing line (journal is append-only, another process may be
      // mid-write) is skipped rather than throwing — we re-read on the next queue refresh.
    }
  }
  return out;
}

export interface AgentWrite {
  ts: string;
  op: string;
  client: string;
  connection: string;
  // UNTRUSTED agent-authored text, verbatim from the journal record — absent on older records
  // or when the agent didn't supply one. Render as a plain text node only.
  intent?: string;
}

// Agent (MCP-transport) content writes to `path` strictly after `sinceIso`, oldest→newest.
// Human editor edits never appear here (they don't go through MCP), which is exactly why
// the journal is a sound "was this an agent?" oracle.
export function agentWritesSince(
  records: JournalRecord[],
  path: string,
  sinceIso: string,
): AgentWrite[] {
  const since = Date.parse(sinceIso);
  const out: AgentWrite[] = [];
  for (const r of records) {
    if (r.actor?.transport !== "mcp") continue;
    if (r.outcome && r.outcome !== "ok") continue;
    if (!CONTENT_WRITE_OPS.has(r.op)) continue;
    if (r.target?.path !== path) continue;
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t <= since) continue;
    out.push({
      ts: r.ts,
      op: r.op,
      client: r.actor?.client ?? "(unknown agent)",
      connection: r.actor?.connection ?? "",
      intent: typeof r.intent === "string" ? r.intent : undefined,
    });
  }
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return out;
}

// Was there ANY agent content write to `path` within the last `windowMs` up to `nowIso`?
// Used by the modify-classifier as the "this change is attributable to an agent" signal.
export function recentAgentWrite(
  records: JournalRecord[],
  path: string,
  nowIso: string,
  windowMs: number,
): boolean {
  const now = Date.parse(nowIso);
  for (const r of records) {
    if (r.actor?.transport !== "mcp") continue;
    if (r.outcome && r.outcome !== "ok") continue;
    if (!CONTENT_WRITE_OPS.has(r.op)) continue;
    if (r.target?.path !== path) continue;
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && now - t <= windowMs && now - t >= -windowMs) return true;
  }
  return false;
}
