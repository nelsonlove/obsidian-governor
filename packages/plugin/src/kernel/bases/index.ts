// kernel/bases — the Bases module's pure core (#243): evaluated Base rows for
// agents. Obsidian evaluates `.base` files only inside a rendered view, so the
// live half of this module (mcp/obsidian-bases-source.ts) opens the base in a
// hidden background leaf and harvests the engine's own result set — full
// fidelity (filters / formulas / sort / view limit) because Obsidian computes;
// nothing here re-implements the Bases expression language.
//
// This file is the headless-testable remainder, obsidian-free per the kernel
// rule (no `obsidian` import, not even types):
//
//   - `.base` config interpretation: declared views + a view's property
//     columns from the ALREADY-PARSED YAML (parsing itself is Obsidian's
//     `parseYaml`, injected by the live adapter — never re-implemented);
//   - propertyId normalization (the YAML order entry `note["x"]` and the live
//     `getOrder()` form `note.note["x"]` both resolve to the engine's storage
//     key `note.x` — verified live on 1.10 against a real base);
//   - row shaping from harvested entries;
//   - the capture lifecycle scaffold: hard timeout + cleanup that ALWAYS runs
//     exactly once (a timed-out capture must never leak its leaf);
//   - the capture serializer: one capture at a time, FIFO, a rejection never
//     wedges the chain;
//   - the module config (queryTimeoutMs / rowCap) with validation.

// ── module config ───────────────────────────────────────────────────────────

export interface BasesConfig {
  /** Hard deadline for one base_query capture, ms. The engine's scan runs on
   * a batched scheduler that Electron throttles hard when the window is
   * hidden: the same 1.9k-note vault measured 5.7s foregroundish and 64s with
   * the window hidden — hence a default well above the issue's ~5s sketch.
   * Refusal is typed (`base_timeout`) and retryable; nothing is mutated. */
  queryTimeoutMs: number;
  /** Maximum rows one base_query returns (and the cap `limit` clamps to). */
  rowCap: number;
}

export const DEFAULT_BASES_CONFIG: BasesConfig = {
  queryTimeoutMs: 30_000,
  rowCap: 500,
};

const TIMEOUT_MIN = 1_000;
const TIMEOUT_MAX = 120_000;

export function validateBasesConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const t = config.queryTimeoutMs;
  if (t !== undefined && (typeof t !== "number" || !Number.isFinite(t) || t < TIMEOUT_MIN || t > TIMEOUT_MAX)) {
    problems.push(`queryTimeoutMs must be a number between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} (ms)`);
  }
  const c = config.rowCap;
  if (c !== undefined && (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 10_000)) {
    problems.push("rowCap must be an integer between 1 and 10000");
  }
  return problems;
}

/** Merged config → effective values; anything invalid falls back to the
 * default (validation already reported it loudly via the module host). */
export function basesConfigOf(config: Record<string, unknown> | undefined): BasesConfig {
  const out = { ...DEFAULT_BASES_CONFIG };
  if (!config) return out;
  if (validateBasesConfig({ queryTimeoutMs: config.queryTimeoutMs }).length === 0 && config.queryTimeoutMs !== undefined) {
    out.queryTimeoutMs = config.queryTimeoutMs as number;
  }
  if (validateBasesConfig({ rowCap: config.rowCap }).length === 0 && config.rowCap !== undefined) {
    out.rowCap = config.rowCap as number;
  }
  return out;
}

// ── .base config interpretation (over parsed YAML) ─────────────────────────

/** One declared view of a `.base` file, as base_list reports it and as
 * base_query selects it. `order` is the view's declared property columns,
 * RAW as authored (normalize with `normalizePropertyId` before use). */
export interface BaseViewDecl {
  name: string;
  type: string;
  order: string[] | null;
}

/** Interpret an already-parsed `.base` YAML document. Returns the declared
 * views (possibly empty), or null when the document isn't even an object —
 * the caller reports that as a parse/shape problem rather than "no views". */
export function baseViewsOf(parsed: unknown): BaseViewDecl[] | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const views = (parsed as { views?: unknown }).views;
  if (views === undefined || views === null) return [];
  if (!Array.isArray(views)) return null;
  const out: BaseViewDecl[] = [];
  for (const v of views) {
    if (typeof v !== "object" || v === null) continue;
    const name = (v as { name?: unknown }).name;
    const type = (v as { type?: unknown }).type;
    const order = (v as { order?: unknown }).order;
    out.push({
      name: typeof name === "string" ? name : "",
      type: typeof type === "string" ? type : "",
      order: Array.isArray(order) ? order.filter((o): o is string => typeof o === "string") : null,
    });
  }
  return out;
}

/** Select the view base_query evaluates: by name when given (exact match),
 * else the file's FIRST declared view — the same default the Bases container
 * itself applies when its state names no view. */
export function selectView(views: BaseViewDecl[], name: string | undefined): BaseViewDecl | null {
  if (name === undefined) return views[0] ?? null;
  return views.find((v) => v.name === name) ?? null;
}

// ── propertyId normalization ────────────────────────────────────────────────

/**
 * Normalize any property spelling to the engine's storage key — the form
 * `BasesEntry.getValue` actually resolves (verified live: for a YAML order
 * entry `note["acceptance-status"]`, `getOrder()` reports
 * `note.note["acceptance-status"]` and getValue on THAT returns null, while
 * `note.acceptance-status` returns the real value).
 *
 *   file.* / formula.*        → unchanged
 *   note.note["x"] (live)     → note.x
 *   note["x"] (YAML order)    → note.x
 *   note.x                    → note.x
 *   bare `x` (YAML shorthand) → note.x
 */
export function normalizePropertyId(raw: string): string {
  let s = raw.trim();
  if (/^(file|formula)\./.test(s)) return s;
  if (s.startsWith("note.")) s = s.slice("note.".length);
  const m = s.match(/^note\[("|')(.+)\1\]$/);
  if (m) s = m[2];
  return `note.${s}`;
}

// ── row shaping / bounds ────────────────────────────────────────────────────

/** One harvested row as the live adapter materializes it (values already
 * serialized — nothing live crosses this boundary). */
export interface CapturedRow {
  path: string;
  values: Record<string, string | null>;
}

export interface BoundedRows {
  rows: CapturedRow[];
  /** Rows the query produced that the session may see (pre-cap). */
  total: number;
  truncated: boolean;
  /** Whether an allowlist filter dropped anything. Deliberately a boolean,
   * not a count: the visible-filtered-totals precedent (tools-uid.ts) closes
   * cardinality oracles, and a hidden-match COUNT would reopen one here. */
  someRowsHidden: boolean;
}

/** Allowlist-filter then cap the harvested rows. `visible` is the module
 * host's filter (paths in → visible subset out); absent ⇒ nothing filtered. */
export function boundRows(
  rows: CapturedRow[],
  visible: ((paths: string[]) => string[]) | undefined,
  cap: number,
): BoundedRows {
  let kept = rows;
  if (visible) {
    const allowed = new Set(visible(rows.map((r) => r.path)));
    kept = rows.filter((r) => allowed.has(r.path));
  }
  const total = kept.length;
  const out = kept.slice(0, Math.max(0, cap));
  return { rows: out, total, truncated: out.length < total, someRowsHidden: kept.length < rows.length };
}

// ── capture lifecycle: hard timeout + cleanup-always ────────────────────────

export class BaseTimeoutError extends Error {
  code = "base_timeout" as const;
  constructor(ms: number) {
    super(`base query did not produce data within ${ms}ms — the Bases engine's scan is throttled hard when the Obsidian window is hidden; retry, or raise the module's queryTimeoutMs`);
    this.name = "BaseTimeoutError";
  }
}

export interface CaptureTimers {
  set(fn: () => void, ms: number): unknown;
  clear(t: unknown): void;
}

/**
 * Run `start` under a hard deadline. Whatever happens — resolve, reject, or
 * timeout — `cleanup` runs exactly once, in `finally`, and a cleanup throw
 * never masks the outcome. On expiry the returned promise rejects with
 * `BaseTimeoutError`; a late settlement of `start`'s promise after that is a
 * no-op (Promise semantics — the first settle wins), so the live adapter's
 * still-running poll cannot resurrect a timed-out capture.
 */
export async function captureWithCleanup<T>(
  fns: { start: () => Promise<T>; cleanup: () => void },
  timeoutMs: number,
  timers: CaptureTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]) },
): Promise<T> {
  let timer: unknown;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = timers.set(() => reject(new BaseTimeoutError(timeoutMs)), timeoutMs);
      fns.start().then(resolve, reject);
    });
  } finally {
    timers.clear(timer);
    try {
      fns.cleanup();
    } catch {
      // a broken cleanup must not mask the capture's own outcome
    }
  }
}

// ── capture serializer ──────────────────────────────────────────────────────

/**
 * One capture at a time, FIFO. The hidden capture leaf is a global resource
 * (one Obsidian window), so two concurrent base_query calls must not fight
 * over it — the second waits for the first to settle, success or failure
 * alike, and a rejection never wedges the chain.
 */
export function makeSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
