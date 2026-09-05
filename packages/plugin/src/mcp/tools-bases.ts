// tools-bases.ts — the Bases module's tool surface (#243): evaluated Base
// result sets for agents. TWO read-only tools:
//
//   base_list                     — enumerate `.base` files + each file's
//                                   declared views (allowlist-filtered)
//   base_query {path,view,limit}  — the SELECTED view's evaluated rows,
//                                   harvested from Obsidian's own Bases
//                                   engine via a hidden background leaf
//
// ── Why a capture, and what it buys ─────────────────────────────────────────
//
// Obsidian's public Bases API (1.10+) evaluates a `.base` query ONLY into a
// rendered view: `BasesQueryResult` rows flow to a `BasesView` the engine
// instantiates inside a Bases container; `QueryController` is opaque and
// offers no headless evaluation. So base_query opens the base in a leaf that
// is real to the engine but invisible to the human (see
// obsidian-bases-source.ts for the mechanism and the live findings that shaped
// it), waits for the engine's first COMPLETED data push, materializes the rows
// (paths + per-column values via `BasesEntry.getValue`), and detaches the leaf
// in a finally. Full engine fidelity — base filters, view filters, formulas,
// sort, the view's own limit — because Obsidian computes; this module never
// parses the Bases expression language.
//
// ── Discipline ──────────────────────────────────────────────────────────────
//
//   - READ-ONLY module: both tools readOnlyHint: true, no write path, no
//     accept verb, nothing here mutates the vault or the base file.
//   - Feature-gated: the registrar registers NOTHING when the running
//     Obsidian lacks the public Bases API (`source.available()` — the
//     fileclass precedent: an enabled module degrades cleanly to absent).
//   - Allowlist: base_list filters the `.base` paths through `host.visible`
//     BEFORE reading any file; base_query refuses `out_of_allowlist` for a
//     hidden base (belt to the guard's own path-arg check) and filters result
//     ROWS (a hidden note's row drops silently; the response carries a
//     BOOLEAN `some_rows_hidden`, never a count — the visible-totals
//     precedent that closes cardinality oracles).
//   - Bounded: one capture at a time (module-level serializer — the hidden
//     leaf is a global resource), a hard per-query timeout with a TYPED
//     refusal (`base_timeout`) so the bridge can never wedge behind a stuck
//     scan, and a row cap (`limit` clamps to config rowCap) with `truncated`.
//
// Obsidian-free by construction: the vault and the engine arrive through the
// injected BasesSource; every handler is headless-testable. The live adapter
// is obsidian-bases-source.ts (only server.ts imports it).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, codedError } from "./helpers.js";
import type { GuardSettings } from "../guard.js";
import {
  basesConfigOf,
  baseViewsOf,
  boundRows,
  makeSerializer,
  normalizePropertyId,
  selectView,
  BaseTimeoutError,
  type CapturedRow,
} from "../kernel/bases/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** What one capture hands back: fully materialized — no live engine object
 * survives past the leaf's detach. */
export interface CaptureResult {
  /** The columns actually harvested (normalized propertyIds). */
  columns: string[];
  rows: CapturedRow[];
}

/** What the module needs from the vault + engine — structurally typed, no
 * `obsidian` import. The live adapter is obsidianBasesSource(app). */
export interface BasesSource {
  /** Whether the running Obsidian exposes the public Bases API (1.10+).
   * False ⇒ the registrar registers nothing. */
  available(): boolean;
  /** Every `.base` file's vault-relative path. */
  listBasePaths(): string[];
  /** Read + YAML-parse one `.base` file. `exists: false` for a missing file;
   * `parseError` set (and `config` absent) when the YAML does not parse. */
  readBaseConfig(path: string): Promise<{ exists: boolean; config?: unknown; parseError?: string }>;
  /**
   * Evaluate the base's named view via the hidden capture leaf and harvest
   * rows for `columns` (normalized propertyIds; null ⇒ derive from the
   * engine's own visible-properties answer). MUST settle within `timeoutMs`
   * (reject with BaseTimeoutError) and MUST release the leaf however it
   * settles. `viewName` undefined ⇒ the file's first declared view.
   */
  capture(path: string, viewName: string | undefined, columns: string[] | null, timeoutMs: number): Promise<CaptureResult>;
}

/** Inert source for hosts with no adapter wired (settings-UI stand-ins,
 * pre-bases callers): the module registers nothing (unavailable). */
export function emptyBasesSource(): BasesSource {
  return {
    available: () => false,
    listBasePaths: () => [],
    readBaseConfig: async () => ({ exists: false }),
    capture: async () => ({ columns: [], rows: [] }),
  };
}

export interface BasesToolsCtx {
  /** The merged `modules.bases.config` (defaults ∪ user override). */
  config: Record<string, unknown>;
  /** The guard's settings — parity with the other modules. */
  getSettings?: () => GuardSettings;
  /** The module host's allowlist filter (paths in → visible subset out).
   * Absent ⇒ nothing filtered. */
  visible?: (paths: string[]) => string[];
}

// ONE capture at a time across the whole plugin process: the serializer is
// module-scoped, not per-connection, because the hidden leaf is a global
// resource and buildMcpServer constructs a fresh source per connection.
const captureSerializer = makeSerializer();

// Belt over the source's own deadline: `BasesSource.capture` MUST settle
// within timeoutMs, but that contract is the adapter's to honor — and a
// future non-conforming source would otherwise wedge the module-wide chain
// permanently, for every connection (independent-review finding). The race
// settles the SERIALIZER TASK at deadline + grace even if the capture
// promise never settles, so the chain always moves on; a zombie capture's
// own cleanup remains the adapter's responsibility.
const BELT_GRACE_MS = 5_000;
function withBeltDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BaseTimeoutError(timeoutMs + BELT_GRACE_MS)), timeoutMs + BELT_GRACE_MS);
    }),
  ]);
}

/** True iff the allowlist filter passes this single path through. */
function pathVisible(visible: BasesToolsCtx["visible"], path: string): boolean {
  return !visible || visible([path]).length === 1;
}

/** Whether a path allowlist is active — gates whether `some_rows_hidden` is
 * disclosed at all (with no allowlist it is a constant false and says
 * nothing). Exported alongside `queryBaseRows` below: the two travel together
 * for any consumer of the seam, and the seam's test suite drives both. */
export function allowlistActive(ctx: Pick<BasesToolsCtx, "getSettings">): boolean {
  const s = ctx.getSettings?.();
  const allow = (s as { allowlist?: string[] } | undefined)?.allowlist;
  return Array.isArray(allow) && allow.length > 0;
}

// ── the shared evaluated-rows seam (#241) ───────────────────────────────────
//
// The WHOLE base_query evaluation path — validation, view selection, the
// serialized + belt-deadlined capture, and the allowlist row bound — as one
// reusable function. `base_query`'s own handler is a thin shell over this.
//
// It was factored out for a SECOND consumer: the triage module's base-backed
// queues, which needed the same machinery (same serializer, same hidden-leaf
// capture, same typed refusals) rather than a duplicate of it. That consumer
// left this plugin at the suite split's S5 and did NOT take the seam with it —
// the capture drives a hidden Bases leaf, which is a GLOBAL resource that the
// module-scoped `captureSerializer` below exists to hold to one capture at a
// time, and a copy of the serializer in a second plugin would race the one in
// this one. So `vault_triage_queue`'s base-backed forms refuse
// `bases_unavailable` and callers use `base_query` directly. The factored shape
// stays, both because base_query reads better as a shell over it and because it
// is what a published bases service would expose if apiVersion 2 ever offers
// one.

export type BaseRowsRefusal = {
  code:
    | "bases_unavailable"
    | "not_a_base"
    | "out_of_allowlist"
    | "not_found"
    | "base_parse_error"
    | "view_not_found"
    | "base_timeout";
  message: string;
};

export interface BaseRowsResult {
  view: string;
  viewType: string;
  columns: string[];
  rows: CapturedRow[];
  total: number;
  truncated: boolean;
  someRowsHidden: boolean;
}

export async function queryBaseRows(
  source: BasesSource,
  ctx: { config: Record<string, unknown>; visible?: (paths: string[]) => string[] },
  args: { path: string; view?: string; limit?: number },
): Promise<{ refusal: BaseRowsRefusal } | { result: BaseRowsResult }> {
  const refuse = (code: BaseRowsRefusal["code"], message: string) => ({ refusal: { code, message } });
  // The feature gate, callable-level: registerBasesTools checks this before
  // registering, but a direct caller of this function (as the triage module
  // was) must get a TYPED refusal, not a hang, on a pre-Bases Obsidian.
  if (!source.available()) {
    return refuse(
      "bases_unavailable",
      "the running Obsidian does not expose the public Bases API (1.10+) — base-backed queries are unavailable",
    );
  }
  const cfg = basesConfigOf(ctx.config);
  const { path, view, limit } = args;
  if (!path.endsWith(".base")) return refuse("not_a_base", `base queries evaluate .base files; got: ${path}`);
  // Belt to the guard's own path-arg allowlist check: the handler is also
  // reachable through module-host tests with no guard in front, and a direct
  // caller may pass a `base` under an argument name the guard does not
  // recognize as a path key.
  if (!pathVisible(ctx.visible, path)) {
    return refuse("out_of_allowlist", `path is outside the configured allowlist: ${path}`);
  }
  const read = await source.readBaseConfig(path);
  if (!read.exists) return refuse("not_found", `no such base: ${path}`);
  if (read.parseError !== undefined) {
    return refuse("base_parse_error", `${path} is not valid YAML: ${read.parseError}`);
  }
  const views = baseViewsOf(read.config);
  if (views === null) return refuse("base_parse_error", `${path} does not look like a Bases config (not a YAML mapping)`);
  const selected = selectView(views, view);
  if (!selected) {
    const names = views.map((v) => v.name).filter(Boolean);
    return refuse(
      "view_not_found",
      view === undefined
        ? `${path} declares no views`
        : `${path} has no view named "${view}" — declared: ${names.length ? names.join(", ") : "(none)"}`,
    );
  }
  const columns = selected.order ? selected.order.map(normalizePropertyId) : null;
  let captured: CaptureResult;
  try {
    captured = await captureSerializer(() =>
      withBeltDeadline(
        source.capture(path, view === undefined ? undefined : selected.name, columns, cfg.queryTimeoutMs),
        cfg.queryTimeoutMs,
      ),
    );
  } catch (e) {
    if (e instanceof BaseTimeoutError) return refuse("base_timeout", e.message);
    throw e;
  }
  const cap = Math.min(limit ?? cfg.rowCap, cfg.rowCap);
  const bounded = boundRows(captured.rows, ctx.visible, cap);
  return {
    result: {
      view: selected.name,
      viewType: selected.type,
      columns: captured.columns,
      rows: bounded.rows,
      total: bounded.total,
      truncated: bounded.truncated,
      someRowsHidden: bounded.someRowsHidden,
    },
  };
}

export function registerBasesTools(server: McpServer, source: BasesSource, ctx: BasesToolsCtx): void {
  // Feature gate (the fileclass precedent): no public Bases API ⇒ the whole
  // surface is absent, not broken. Checked once per connection build, like
  // every other conditional registration.
  if (!source.available()) return;

  server.registerTool(
    "base_list",
    {
      title: "List the vault's Bases (.base files) and their declared views",
      description:
        "Enumerate every visible `.base` file with its declared views (name, type, column count). Read-only; reads " +
        "each base's YAML, evaluates nothing. Use base_query to evaluate a view's result set. A base outside the " +
        "path allowlist is invisible — absent from the answer, not refused.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const paths = ctx.visible ? ctx.visible(source.listBasePaths()) : source.listBasePaths();
        const bases = [];
        for (const path of paths.slice().sort()) {
          const read = await source.readBaseConfig(path);
          if (!read.exists) continue; // raced a delete — simply absent
          if (read.parseError !== undefined) {
            bases.push({ path, views: null, error: "parse_error" });
            continue;
          }
          const views = baseViewsOf(read.config);
          if (views === null) {
            bases.push({ path, views: null, error: "invalid_shape" });
            continue;
          }
          bases.push({
            path,
            views: views.map((v) => ({ name: v.name, type: v.type, columns: v.order ? v.order.length : null })),
          });
        }
        return ok({ total: bases.length, bases });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "base_query",
    {
      title: "Evaluate a Base view and return its result rows",
      description:
        "Open the named `.base` file in a hidden background leaf, let Obsidian's own Bases engine evaluate it " +
        "(base + view filters, formulas, sort, the view's own limit — full engine fidelity), and return the rows: " +
        "each row's note path plus the view's declared columns' values (stringified). `view` selects among the " +
        "base's declared views (default: the first); `limit` caps rows (clamped to the module's rowCap). Read-only " +
        "— nothing is written, and the leaf is detached whatever happens. Queries are serialized (one capture at a " +
        "time) and time-boxed: a scan that outlives the module's queryTimeoutMs refuses with `base_timeout` " +
        "(retryable; the engine's scan is heavily throttled while the Obsidian window is hidden). Rows for notes " +
        "outside the path allowlist are dropped silently (`some_rows_hidden: true`).",
      inputSchema: {
        path: z.string().min(1).describe('Vault-relative path of the `.base` file, e.g. "Views/Tasks.base".'),
        view: z.string().min(1).optional().describe("Declared view name to evaluate (default: the file's first view)."),
        limit: z.number().int().min(1).optional().describe("Maximum rows to return (clamped to the module's rowCap)."),
      },
      annotations: RO,
    },
    async ({ path, view, limit }: { path: string; view?: string; limit?: number }) => {
      try {
        // The whole evaluation path lives in queryBaseRows — the seam factored
        // out for the triage module's base-backed queues (#241), which left for
        // its own plugin at S5 without taking it. See the seam's own note.
        const outcome = await queryBaseRows(source, { config: ctx.config, visible: ctx.visible }, { path, view, limit });
        if ("refusal" in outcome) return codedError(outcome.refusal.code, outcome.refusal.message);
        const r = outcome.result;
        return ok({
          path,
          view: r.view,
          view_type: r.viewType,
          columns: r.columns,
          rows: r.rows.map((row) => ({ path: row.path, properties: row.values })),
          total: r.total,
          truncated: r.truncated,
          // Only meaningful (and only disclosed) when an allowlist is active:
          // with no allowlist the field is a constant false and says nothing.
          ...(allowlistActive(ctx) ? { some_rows_hidden: r.someRowsHidden } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
