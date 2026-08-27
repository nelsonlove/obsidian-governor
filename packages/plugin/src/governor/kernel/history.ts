// ============================================================================
//  HISTORY BROWSER — pure builder + text-node-only renderer  (#135, part 2)
// ----------------------------------------------------------------------------
//  A READ-ONLY view over the acceptance log (governance/acceptance-log.jsonl —
//  the audit stream the plugin already writes): manual accepts, reverts, silent
//  advances and class auto-accepts. Newest first, capped (default 200) with a
//  "+N more" count, optionally filtered to one note path. A record shape this
//  module does not recognize (e.g. from a future mechanism) renders as an
//  "unknown" row rather than being hidden — the history must not silently
//  drop an audit record.
//
//  DISPLAY-ONLY, and it CONFERS NOTHING: this module takes log TEXT in and puts
//  entries into TEXT NODES out. It holds no accept callable, no store, no log
//  writer — reading the log grants no capability (same boundary as
//  obsidian_pending_review). Like intent-view.ts it is obsidian-free (the narrow
//  ElFactory structural interface) so the EXACT render path the pane calls is
//  driven headlessly by tests.
//
//  SECURITY: log records can carry AGENT-INFLUENCED strings — note paths are
//  agent-chosen, and a tampered log line could carry anything. Every string from
//  a record therefore reaches the DOM ONLY through `createSpan({ text })` /
//  `createDiv({ text })` (textContent, never innerHTML) — the renderIntent
//  discipline, pinned behaviorally by tests/governance-history.test.mjs.
// ============================================================================

// Structural element interface (the intent-view ElFactory shape, plus `text` on
// createDiv, which Obsidian's createDiv also accepts). Matching structurally —
// not importing the runtime `obsidian` — keeps this module headless-testable.
export interface HistoryElFactory {
  createDiv(o?: { cls?: string; text?: string }): HistoryElFactory;
  createSpan(o?: { cls?: string; text?: string }): HistoryElFactory;
}

export const HISTORY_DEFAULT_CAP = 200;

export type HistoryKind =
  | "accept"
  | "revert"
  | "request-changes"
  | "withdraw-request"
  | "silent-advance"
  | "auto-accept"
  | "baseline-rekey"
  | "unknown";

export interface HistoryEntry {
  kind: HistoryKind;
  ts: string;
  path: string;
  // Short human-readable qualifier (reason / classes / policy level / by-whom).
  detail: string;
  fromHash?: string;
  toHash?: string;
}

export interface HistoryView {
  entries: HistoryEntry[];
  more: number; // how many older entries the cap hid
  total: number;
}

// Tolerant JSONL parse — same discipline as journal-reader.ts: a partially
// written or garbage line is skipped, never thrown on.
function parseLog(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj as Record<string, unknown>);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Map ONE raw log record to a typed entry. Unrecognized shapes render as
// "unknown" rather than being dropped — the history must not silently hide an
// audit record it doesn't understand.
export function toHistoryEntry(r: Record<string, unknown>): HistoryEntry {
  const ts = str(r.ts);
  // Accept/revert (and the #101 revision dispositions) use `action`; event records use `event`.
  if (r.action === "request-changes" || r.action === "withdraw-request") {
    const by = str(r.by);
    return { kind: r.action, ts, path: str(r.path), detail: by ? `by ${by}` : "" };
  }
  if (r.action === "accept" || r.action === "revert") {
    const by = str(r.by);
    return {
      kind: r.action,
      ts,
      path: str(r.path),
      detail: by ? `by ${by}` : "",
      toHash: str(r.hash) || undefined,
    };
  }
  if (r.event === "silent-advance") {
    return {
      kind: "silent-advance",
      ts,
      path: str(r.path),
      detail: str(r.reason),
      fromHash: str(r.fromHash) || undefined,
      toHash: str(r.toHash) || undefined,
    };
  }
  if (r.event === "baseline-rekey") {
    // A re-addressing, not an advance: one hash, shown on both sides so the history
    // reads as "unchanged" at a glance.
    const hash = str(r.hash) || undefined;
    const from = str(r.from);
    return {
      kind: "baseline-rekey",
      ts,
      path: str(r.path),
      detail: from ? `from ${from}${str(r.reason) ? ` (${str(r.reason)})` : ""}` : str(r.reason),
      fromHash: hash,
      toHash: hash,
    };
  }
  if (r.event === "auto-accept") {
    // Today's records carry `classes` (the class allowlist path). A future auto-accept variant
    // with a different `reason` still surfaces — the reason lands in the detail text.
    const classes = Array.isArray(r.classes) ? r.classes.filter((c) => typeof c === "string").join(", ") : "";
    const reason = str(r.reason);
    const detail = classes ? `classes: ${classes}` : reason && reason !== "auto-accept" ? reason : "";
    return {
      kind: "auto-accept",
      ts,
      path: str(r.path),
      detail,
      fromHash: str(r.fromHash) || undefined,
      toHash: str(r.toHash) || undefined,
    };
  }
  return { kind: "unknown", ts, path: str(r.path), detail: str(r.event) || str(r.action) };
}

export function buildHistory(
  logText: string,
  opts: { cap?: number; path?: string | null } = {},
): HistoryView {
  const cap = opts.cap ?? HISTORY_DEFAULT_CAP;
  const all = parseLog(logText).map((r) => toHistoryEntry(r));
  const filtered = opts.path ? all.filter((e) => e.path === opts.path) : all;
  // Newest first. The log is append-ordered, but sort by ts anyway (stable for
  // equal/unparseable ts) so a merged or hand-recovered log still reads sanely.
  const entries = filtered.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
  const total = entries.length;
  const shown = entries.slice(0, Math.max(0, cap));
  return { entries: shown, more: total - shown.length, total };
}

// ---------------------------------------------------------------------------
//  Rendering — text nodes ONLY (the renderIntent discipline). No listeners, no
//  callables in, no capability out.
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<HistoryKind, string> = {
  accept: "accepted",
  revert: "reverted",
  "request-changes": "changes requested",
  "withdraw-request": "request withdrawn",
  "baseline-rekey": "baseline re-keyed",
  "silent-advance": "silent advance",
  "auto-accept": "auto-accepted",
  unknown: "record",
};

function shortHash(h: string | undefined): string {
  return h ? h.slice(0, 8) : "";
}

export function renderHistoryEntries(container: HistoryElFactory, view: HistoryView): void {
  const root = container.createDiv({ cls: "governance-history" });
  // "No recorded decisions" only when there truly are none — a capped-to-zero view still shows
  // its "+N more" marker below rather than masquerading as an empty log.
  if (view.total === 0) {
    root.createDiv({ cls: "governance-empty", text: "No recorded decisions." });
    return;
  }
  for (const e of view.entries) {
    const row = root.createDiv({ cls: `governance-history-row history-${e.kind}` });
    const head = row.createDiv({ cls: "governance-history-head" });
    head.createSpan({ cls: "governance-history-kind", text: KIND_LABEL[e.kind] ?? "record" });
    // UNTRUSTED/agent-influenced strings (path, detail, hashes) — text nodes only.
    head.createSpan({ cls: "governance-history-path", text: e.path });
    const meta = row.createDiv({ cls: "governance-history-meta" });
    if (e.detail) meta.createSpan({ cls: "governance-history-detail", text: e.detail });
    if (e.fromHash || e.toHash) {
      meta.createSpan({
        cls: "governance-history-hash",
        text: `${shortHash(e.fromHash) || "∅"} → ${shortHash(e.toHash) || "∅"}`,
      });
    }
    meta.createSpan({ cls: "governance-history-ts", text: e.ts });
  }
  if (view.more > 0) {
    root.createDiv({ cls: "governance-history-more", text: `+${view.more} more (older)` });
  }
}
