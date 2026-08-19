// tools-triage.ts — the inbox-triage module's tool surface (#221 phase 2,
// reshaped by #241 phase 3): the disposition substrate's second instance
// given a real agent surface. TWO tools, no pane:
//
//   triage_queue   — the agent's view of a triage queue (READ-ONLY). Default:
//                    the inbox-marker queue (notes under a configured inbox
//                    folder, oldest first). With `base`/`view` — or a
//                    config-named `queue` — the queue is the EVALUATED rows
//                    of a `.base` file, computed by Obsidian's own Bases
//                    engine through the bases module's shared capture seam
//                    (tools-bases.ts's queryBaseRows): the human authors the
//                    queue predicate in the native Bases UI, and the same
//                    definition drives the human view AND the agent sweep.
//   triage_dispose — the ONE guarded mutating verb, disposition selected from
//                    the MERGED table: three built-in primitives (trash /
//                    move / stamp) ∪ human-declared config rows
//                    (kernel/triage/descriptors.ts + config.ts). DRY-RUN BY
//                    DEFAULT for the built-in actions (#214 report-first);
//                    a declared `choice` row is opaque and CANNOT dry-run —
//                    it refuses typed until the caller passes an explicit
//                    `dry_run: false`.
//
// ── The authority axis, applied (#221/#241) ─────────────────────────────────
//
// No disposition confers standing — built-ins are mechanical, reversible
// writes (the shared link-healing move primitive, processFrontMatter,
// Obsidian's recoverable trash), and a declared `choice` row runs a QuickAdd
// choice the HUMAN bound in module config. The agent-facing surface is the
// disposition id only; the binding is config (human-only-mutable), so this
// does NOT weaken the quickadd:*/js-engine:* opaque-execution denies — an
// agent still cannot name a macro, only pick from the human's menu. A choice
// script's effects are not journaled as effects (unknown to this tool); they
// surface in the governance review queue via non-human attribution, the
// existing audit net. NO ACCEPTANCE SEMANTICS ANYWHERE: the shared
// accept-forbidden rule (@vault-mcp/core) is re-checked over every
// frontmatter patch before it is written (config validation already refused
// acceptance-carrying patches loudly).
//
// ── Vault semantics are configuration ───────────────────────────────────────
//
// Inbox recognition (inboxMarkers), the stamp/escalate patches, the move
// whitelist/blacklist, the declared disposition rows, and the named queues
// are all per-vault config (kernel/triage/config.ts); nothing scheme-semantic
// is hardwired here.
//
// ── Allowlist discipline ────────────────────────────────────────────────────
//
// The marker queue filters the listing through `host.visible` BEFORE reading
// any stat/frontmatter (read-boundary rule); base-backed queues inherit
// base_query's exact discipline through the shared seam (hidden base refused
// `out_of_allowlist`, result rows filtered, boolean-only `some_rows_hidden`).
// `triage_dispose`'s `path` argument is guard-checked at the interception
// point; the COMPUTED destination is not a call argument, so the handler
// re-checks it with the same filter before planning anything to happen to it
// (the scheme-write discipline), in dry-run and apply alike — and the move
// whitelist/blacklist is enforced at plan time AND re-checked at apply.
//
// Obsidian-free by construction: the vault arrives through the injected
// TriageSource and the bases machinery through ctx.baseQuery — every handler
// is headless-testable. The live adapters are obsidian-triage-source.ts and
// (via modules-mount.ts) obsidian-bases-source.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { acceptForbiddenReason } from "@vault-mcp/core";
import { ok, fail, okError, codedError } from "./helpers.js";
import type { GuardSettings } from "../guard.js";
import { allowlistActive, type BaseRowsRefusal, type BaseRowsResult } from "./tools-bases.js";
import {
  applyFrontmatterPatch,
  inboxFolderOf,
  mergedDispositionsOf,
  mergedIds,
  mergedLines,
  moveDenied,
  planDispose,
  sortQueue,
  triageConfigOf,
  type QueueRow,
  type TriageConfig,
} from "../kernel/triage/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const QUEUE_LIMIT_DEFAULT = 50;
const QUEUE_LIMIT_MAX = 200;

/** What the module needs from the vault — structurally typed, no `obsidian`
 * import (the LinkSource/CrosssessionSource discipline). */
export interface TriageSource {
  /** Every markdown path in the vault (UNfiltered; the tool layer applies the
   * allowlist before anything is read). */
  paths(): string[];
  /** A note's cached frontmatter, or null. */
  frontmatter(path: string): Record<string, unknown> | null;
  /** Creation/modification times (ms epoch), or null when unknown. */
  stat(path: string): { ctime: number | null; mtime: number | null } | null;
  /** Whether a file exists at this exact path. */
  exists(path: string): boolean;
  /** Move a note — MUST route through the shared link-healing move primitive
   * (tools-vault-write.ts's moveOne: fileManager.renameFile, parents created,
   * never overwrites). */
  move(from: string, to: string): Promise<void>;
  /** Trash a note (Obsidian's recoverable trash — never a hard delete). */
  trashNote(path: string): Promise<void>;
  /** Atomically edit a note's frontmatter (processFrontMatter live). */
  updateFrontmatter(path: string, apply: (fm: Record<string, unknown>) => void): Promise<void>;
  /** Execute a human-bound QuickAdd choice (a declared `choice` disposition)
   * with variables — the shared #225 executeChoice seam
   * (mcp/quickadd-choice.ts live). Typed refusals for unavailable/unresolved;
   * a throw from the choice's own script propagates. */
  runChoice(
    binding: string,
    variables: Record<string, string>,
  ): Promise<{ ok: true; choice: string } | { ok: false; code: string; message: string }>;
}

/** An inert source — the mount's default when no vault is injected
 * (settings-UI stand-ins, bare embeds): no notes, and every write throws. */
export function emptyTriageSource(): TriageSource {
  const noVault = () => {
    throw new Error("no vault source injected");
  };
  return {
    paths: () => [],
    frontmatter: () => null,
    stat: () => null,
    exists: () => false,
    move: async () => noVault(),
    trashNote: async () => noVault(),
    updateFrontmatter: async () => noVault(),
    runChoice: async () => ({
      ok: false,
      code: "quickadd_unavailable",
      message: "no vault source injected — choice dispositions need the live adapter",
    }),
  };
}

export interface TriageToolsCtx {
  /** The merged `modules.triage.config` (defaults ∪ user override). */
  config: Record<string, unknown>;
  /** Guard settings accessor — gates the `some_rows_hidden` disclosure for
   * base-backed queues (the tools-bases rule) and keeps parity with the
   * other module ctxs. */
  getSettings?: () => GuardSettings;
  /** The host's allowlist filter (`host.visible`). Absent ⇒ nothing filtered,
   * matching visiblePaths with no allowlist. */
  visible?: (paths: string[]) => string[];
  /**
   * The scheme module's expected-location read service, when available: a
   * note's own address plus the folder the scheme expects it in. MUST return
   * null (or be absent) when the scheme module is disabled or cannot answer —
   * the module degrades cleanly, it never depends on scheme.
   */
  schemeExpected?: (path: string) => { address: string; expected_folder: string | null } | null;
  /**
   * The bases module's evaluated-rows seam (tools-bases.ts's queryBaseRows,
   * bound to the live BasesSource + the bases module config by
   * modules-mount.ts). Absent ⇒ base-backed queues refuse typed
   * (`bases_unavailable`); the marker queue is unaffected.
   */
  baseQuery?: (args: {
    path: string;
    view?: string;
    limit?: number;
  }) => Promise<{ refusal: BaseRowsRefusal } | { result: BaseRowsResult }>;
  /** Injectable clock for age computation (tests). Absent ⇒ run clock. */
  now?: () => Date;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function registerTriageTools(server: McpServer, source: TriageSource, ctx: TriageToolsCtx): void {
  const vis = ctx.visible ?? ((p: string[]) => p);
  const now = ctx.now ?? (() => new Date());
  // Config is resolved per call (the per-call freshness discipline every tool
  // layer follows) — but from the ctx's merged record, so a module toggle
  // still lands on the next connect like every module. The disposition ENUM
  // and description are necessarily registration-time snapshots of the same
  // config (the SDK fixes a tool's schema at registration); the planner
  // re-resolves per call, so a raced config edit can only make a call refuse
  // `unknown_disposition`, never run a stale row.
  const cfg = (): TriageConfig => triageConfigOf(ctx.config);
  const registrationTable = mergedDispositionsOf(cfg());
  const choiceIds = registrationTable.filter((d) => d.action === "choice").map((d) => d.id);

  server.registerTool(
    "triage_queue",
    {
      title: "List a triage queue",
      description:
        "List a triage queue for the agent sweep (humans use native Bases; this emits data, not a view). " +
        "DEFAULT (no base/queue): the inbox-marker queue — notes with any ancestor folder whose name contains a " +
        "configured inbox marker (default \" Inbox for \"; the inbox's own folder note is not an item), with " +
        "path, enclosing inbox, created/modified times, age in days, and frontmatter `type`/`status`, OLDEST " +
        "FIRST. With `base` (a vault-relative .base path, optionally `view`) — or `queue`, a config-declared " +
        "named queue (modules.triage.config.queues) — the queue is the EVALUATED rows of that Base, computed by " +
        "Obsidian's own Bases engine (full fidelity: filters, formulas, sort) through the bases module's capture " +
        "path, in the Base's own order: each row's note path plus the view's columns' values. Base-backed queues " +
        "refuse typed (`bases_unavailable`) when the Bases API is absent or the bases module is disabled; the " +
        "marker queue still works. Only allowlist-visible notes are listed or read (base rows are filtered; a " +
        "hidden `.base` refuses `out_of_allowlist`). Capped by `limit` (`truncated: true` + the total when more " +
        "exist). Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(QUEUE_LIMIT_MAX)
          .default(QUEUE_LIMIT_DEFAULT)
          .describe(`Maximum rows to return (default ${QUEUE_LIMIT_DEFAULT}, max ${QUEUE_LIMIT_MAX}).`),
        base: z
          .string()
          .min(1)
          .optional()
          .describe('Vault-relative `.base` path to evaluate as the queue, e.g. "Views/Acceptance.base".'),
        view: z
          .string()
          .min(1)
          .optional()
          .describe("Declared view name within `base` (default: the file's first view). Requires `base`."),
        queue: z
          .string()
          .min(1)
          .optional()
          .describe("A config-declared named queue id (modules.triage.config.queues). Mutually exclusive with `base`."),
      },
      annotations: RO,
    },
    async ({ limit, base, view, queue }: { limit?: number; base?: string; view?: string; queue?: string }) => {
      try {
        const config = cfg();
        const cap = limit ?? QUEUE_LIMIT_DEFAULT;

        // ── argument shape ────────────────────────────────────────────────
        if (queue !== undefined && base !== undefined) {
          return codedError("invalid_arguments", "pass `queue` OR `base`, not both");
        }
        if (view !== undefined && base === undefined) {
          return codedError(
            "invalid_arguments",
            "`view` rides the `base` argument — a named queue's view is declared in its config row",
          );
        }

        // ── base-backed queue (explicit base, or a config-named queue) ────
        let basePath = base;
        let baseView = view;
        if (queue !== undefined) {
          const decl = config.queues.find((q) => q.id === queue);
          if (!decl) {
            const known = config.queues.map((q) => q.id);
            return codedError(
              "unknown_queue",
              `no declared queue '${queue}'` +
                (known.length ? ` — declared: ${known.join(", ")}` : " — modules.triage.config.queues declares none"),
            );
          }
          basePath = decl.base;
          baseView = decl.view;
        }
        if (basePath !== undefined) {
          if (!ctx.baseQuery) {
            return codedError(
              "bases_unavailable",
              "base-backed queues need the bases module's capture path, which this host did not wire",
            );
          }
          const outcome = await ctx.baseQuery({ path: basePath, view: baseView, limit: cap });
          if ("refusal" in outcome) return codedError(outcome.refusal.code, outcome.refusal.message);
          const r = outcome.result;
          return ok({
            ...(queue !== undefined ? { queue } : {}),
            base: basePath,
            view: r.view,
            view_type: r.viewType,
            columns: r.columns,
            // The Base's own order IS the queue order — the human declared it.
            notes: r.rows.map((row) => ({ path: row.path, properties: row.values })),
            total: r.total,
            returned: r.rows.length,
            truncated: r.truncated,
            ...(allowlistActive(ctx) ? { some_rows_hidden: r.someRowsHidden } : {}),
          });
        }

        // ── the marker queue (unchanged phase-2 behavior) ─────────────────
        const rows: QueueRow[] = [];
        // Visible-filter BEFORE any stat/frontmatter read (read-boundary rule).
        for (const path of vis(source.paths())) {
          const inbox = inboxFolderOf(path, config.inboxMarkers);
          if (inbox === null) continue;
          const st = source.stat(path);
          const fm = source.frontmatter(path);
          rows.push({
            path,
            inbox,
            created: st?.ctime ?? null,
            modified: st?.mtime ?? null,
            type: typeof fm?.type === "string" ? (fm.type as string) : null,
            status: typeof fm?.status === "string" ? (fm.status as string) : null,
          });
        }
        const sorted = sortQueue(rows);
        const served = sorted.slice(0, cap);
        const nowMs = now().getTime();
        return ok({
          total: sorted.length,
          returned: served.length,
          truncated: sorted.length > served.length,
          inbox_markers: config.inboxMarkers,
          notes: served.map((r) => ({
            path: r.path,
            inbox: r.inbox,
            created: iso(r.created),
            modified: iso(r.modified),
            age_days: r.created === null ? null : Math.max(0, Math.floor((nowMs - r.created) / 86_400_000)),
            type: r.type,
            status: r.status,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "triage_dispose",
    {
      title: "Dispose of an inbox item",
      description:
        "Dispose of one inbox note using the MERGED disposition table — three built-in primitives (trash / move / " +
        "stamp) plus the human-declared rows in modules.triage.config.declaredDispositions (default: one declared " +
        "row, escalate). Every disposition is an ordinary agent write (none confers standing; nothing here touches " +
        "acceptance). DRY-RUN BY DEFAULT for built-in actions: the call reports exactly what would change and " +
        "writes nothing until `dry_run: false`. Dispositions: " +
        mergedLines(registrationTable).join("; ") +
        ". `target` names a destination FOLDER (the note keeps its filename): required for the built-in move (and " +
        "declared moving rows without a configured destination), an override for rows with one, refused for " +
        "trash / in-place stamps / choice rows. Move destinations are checked against the configured " +
        "moveWhitelist/moveBlacklist (`move_denied`), enforced at plan time and re-checked at apply. Moves ride " +
        "the link-healing move primitive and never overwrite (`destination_occupied`); frontmatter patches come " +
        "from module config or the declared row (array values union, scalars overwrite) and can never write " +
        "acceptance. A declared `choice` row executes its human-bound QuickAdd choice" +
        (choiceIds.length ? ` (here: ${choiceIds.join(", ")})` : "") +
        " — opaque, so it CANNOT dry-run: it refuses until you pass an explicit `dry_run: false`, and its " +
        "script's effects are not itemized here (they surface in the governance review queue via non-human " +
        "attribution). When the scheme module is enabled the report includes a `scheme` advisory (the note's " +
        "address + its expected folder); with scheme disabled the field is simply absent.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the inbox note to dispose of."),
        disposition: z
          .enum(mergedIds(registrationTable) as [string, ...string[]])
          .describe("Which disposition to apply — one of the merged (built-in ∪ declared) table's ids."),
        target: z
          .string()
          .optional()
          .describe(
            "Destination FOLDER (vault-relative) for the moving dispositions. Required for the built-in move " +
              "(and declared moving rows without a configured destination); overrides a row's configured " +
              "destination; refused for trash / in-place stamps / choice rows.",
          ),
        dry_run: z
          .boolean()
          .default(true)
          .describe(
            "DEFAULT TRUE: report what would change without writing. Pass false to apply. A declared `choice` " +
              "disposition cannot be previewed and refuses until this is explicitly false.",
          ),
      },
      annotations: RW,
    },
    async ({
      path,
      disposition,
      target,
      dry_run,
    }: {
      path: string;
      disposition: string;
      target?: string;
      dry_run?: boolean;
    }) => {
      try {
        const config = cfg();
        const dry = dry_run !== false;
        const planned = planDispose({ path, disposition, target, config });
        if ("refusal" in planned) return codedError(planned.refusal.code, planned.refusal.message);
        const { plan } = planned;

        if (!source.exists(path)) return codedError("not_found", `not a note: ${path}`);

        // A choice row is opaque — no preview exists. Refuse typed until the
        // caller explicitly opts out of the dry-run default.
        if (plan.choice !== null && dry) {
          return codedError(
            "choice_dry_run_unsupported",
            `disposition '${plan.disposition.id}' runs a human-bound QuickAdd choice and cannot be previewed — ` +
              "pass an explicit dry_run: false to execute it",
          );
        }

        // The computed destination is not a call argument, so the guard never
        // saw it — re-check it against the allowlist ourselves, dry-run and
        // apply alike (the scheme-write discipline), and refuse an occupied
        // destination rather than ever overwriting.
        if (plan.moveTo !== null) {
          if (vis([plan.moveTo]).length === 0) {
            return codedError("out_of_allowlist", `computed destination '${plan.moveTo}' is outside the path allowlist`);
          }
          if (source.exists(plan.moveTo)) {
            return codedError(
              "destination_occupied",
              `destination already exists: '${plan.moveTo}' — pick another target or resolve the collision first`,
            );
          }
        }

        // Belt-and-suspenders: the shared accept-forbidden rule over the
        // effective patch (config validation already refuses these loudly;
        // a patch that somehow carries acceptance still never reaches a note).
        if (plan.patch) {
          const forbidden = acceptForbiddenReason(plan.patch);
          if (forbidden) return codedError("accept_forbidden", forbidden);
        }

        // Optional scheme advisory — absent when the scheme module is
        // disabled/unavailable (clean degradation), never load-bearing.
        let scheme: { address: string; expected_folder: string | null } | null = null;
        try {
          scheme = ctx.schemeExpected?.(path) ?? null;
        } catch {
          scheme = null;
        }

        const base = {
          path,
          disposition: plan.disposition.id,
          inbox: plan.inbox,
          dry_run: dry,
          plan: {
            action: plan.disposition.action,
            ...(plan.moveTo !== null ? { move_to: plan.moveTo } : {}),
            ...(plan.patch !== null ? { frontmatter_patch: plan.patch } : {}),
            ...(plan.choice !== null ? { choice_binding: plan.choice } : {}),
          },
          description: plan.disposition.description,
          ...(scheme !== null ? { scheme } : {}),
        };

        if (dry) return ok({ ...base, applied: false });

        // ── apply: a choice row hands off to the human-bound QuickAdd choice
        //    through the shared #225 seam ──────────────────────────────────
        if (plan.choice !== null) {
          const run = await source.runChoice(plan.choice, {
            path,
            disposition: plan.disposition.id,
          });
          if (!run.ok) return codedError(run.code, run.message);
          return ok({
            ...base,
            applied: true,
            choice: run.choice,
            // The script's writes are not visible from here: no effects claim
            // (the journal records the disposition id; script writes surface
            // in the governance review queue via non-human attribution).
            effects_unknown: true,
          });
        }

        // ── apply: frontmatter first (while the path is stable), then the
        //    move/trash — the legacy flow's order ─────────────────────────────
        // The move whitelist/blacklist RE-CHECK at apply time (the ruling's
        // "enforced at plan time AND re-checked at apply"), against a FRESH
        // config read, beside the allowlist re-check above.
        if (plan.moveTo !== null) {
          const folder = plan.moveTo.split("/").slice(0, -1).join("/");
          const denied = moveDenied(folder, cfg());
          if (denied) return codedError("move_denied", denied);
        }
        let patchApplied = false;
        if (plan.patch !== null) {
          const patch = plan.patch;
          await source.updateFrontmatter(path, (fm) => applyFrontmatterPatch(fm, patch));
          patchApplied = true;
        }
        try {
          if (plan.trash) await source.trashNote(path);
          else if (plan.moveTo !== null) await source.move(path, plan.moveTo);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // A mid-sequence failure must name what already landed, never hide a
          // partially-applied disposition (the renumber-address discipline).
          return okError({
            ...base,
            applied: false,
            frontmatter_applied: patchApplied,
            error: patchApplied
              ? `frontmatter patch was applied but the ${plan.trash ? "trash" : "move"} failed: ${msg}`
              : msg,
            ...(patchApplied ? { filesChanged: 1, files: [path] } : {}),
          });
        }

        const finalPath = plan.moveTo ?? path;
        // An in-place disposition whose configured patch is empty writes
        // nothing at all — report zero effects honestly rather than claiming
        // a file changed.
        const wrote = patchApplied || plan.trash || plan.moveTo !== null;
        return ok({
          ...base,
          applied: true,
          ...(plan.moveTo !== null ? { moved_to: plan.moveTo } : {}),
          ...(plan.trash ? { trashed: true } : {}),
          ...(patchApplied ? { frontmatter_applied: true } : {}),
          // The reportedEffects convention (guarded.ts): the file actually
          // touched — at its final path — lands in the journal's `effects`.
          filesChanged: wrote ? 1 : 0,
          files: wrote ? [finalPath] : [],
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
