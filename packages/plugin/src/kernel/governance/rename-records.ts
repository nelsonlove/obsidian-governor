// ============================================================================
//  RENAME RECORDS — durable confirmations for the link-heal oracle (#261)
// ----------------------------------------------------------------------------
//  The governance wiring captures vault "rename" events into an in-memory list
//  the link-heal detector consults (`RenameIndex.confirms`). In-memory only was
//  a live defect (#261's wedge): Obsidian's OWN link-updating rename rewrites
//  wikilinks in OTHER notes, and when the plugin reloads before those rewrites
//  are reviewed, the confirmation is gone forever — the rewritten links can
//  never be attributed to link-heal again and the note wedges pending.
//
//  This module is the PURE persistence half: (de)serialize + prune. The wiring
//  writes `<plugin dir>/governance/rename-records.json` on every capture and
//  loads it at mount. Records expire (TTL) and are capped (newest kept), so the
//  file is bounded and a confirmation cannot bless a coincidental rewrite years
//  later. Plain data: a record confers nothing by itself — it only lets the
//  conservative link-heal detector CONFIRM a target rewrite that must still
//  pass every other eligibility rule.
//
//  Fail-safe like every governance parser: a malformed file, entry, or field
//  reads as NO records (the detector then simply cannot confirm — the change
//  stays pending, the safe direction).
// ============================================================================

/** One persisted rename capture: the link-target aliases of the old and new paths. */
export interface RenameRecordData {
  old: string[];
  new: string[];
  /** Capture time, epoch ms — for TTL pruning. */
  at: number;
}

export const RENAME_RECORDS_CAP = 500;
export const RENAME_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Drop expired records and keep only the newest CAP (order preserved, oldest first). */
export function pruneRenameRecords(records: RenameRecordData[], nowMs: number): RenameRecordData[] {
  const live = records.filter((r) => Number.isFinite(r.at) && nowMs - r.at <= RENAME_RECORD_TTL_MS && nowMs - r.at >= 0);
  return live.length > RENAME_RECORDS_CAP ? live.slice(live.length - RENAME_RECORDS_CAP) : live;
}

export function serializeRenameRecords(records: RenameRecordData[]): string {
  return JSON.stringify({ version: 1, records }, null, 2);
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

/** Tolerant load: anything malformed — the whole file or any one entry — is dropped. */
export function deserializeRenameRecords(text: string): RenameRecordData[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const list = (doc as { records?: unknown }).records;
  if (!Array.isArray(list)) return [];
  const out: RenameRecordData[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (!isStringArray(rec.old) || !isStringArray(rec.new)) continue;
    if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) continue;
    out.push({ old: rec.old, new: rec.new, at: rec.at });
  }
  return out;
}
