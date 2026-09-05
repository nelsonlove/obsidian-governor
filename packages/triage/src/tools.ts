// tools.ts — the vault-triage satellite's tool surface. TWO tools, published to
// the Governor host through `vault-mcp-api` (see main.ts):
//
//   queue   — the agent's view of a triage queue (declared read-only). Default:
//             the inbox-marker queue (notes under a configured inbox folder,
//             oldest first). With `base`/`view` — or a config-named `queue` —
//             the queue would be the EVALUATED rows of a `.base` file; that
//             path needs the bases capture seam, which since S7 lives in the
//             `vault-bases` satellite and is reachable from neither the host
//             nor this plugin, so it refuses typed (`bases_unavailable`). See
//             the base-backed-queue note at the bottom of this file.
//   dispose — the ONE guarded mutating verb, disposition selected from the
//             MERGED table: three built-in primitives (trash / move / stamp)
//             ∪ human-declared config rows (kernel/descriptors.ts + config.ts).
//             DRY-RUN BY DEFAULT for the built-in actions (#214 report-first);
//             a declared `choice` row is opaque and CANNOT dry-run — it refuses
//             typed until the caller passes an explicit `dry_run: false`.
//
// ── The published names DID change, and that is the one thing to know ────────
//
// The host publishes an external tool as `<sanitized publisher id>_<bare name>`.
// This plugin's id is `vault-triage`, which sanitizes to `vault_triage`, so the
// two bare names below go on the wire as `vault_triage_queue` and
// `vault_triage_dispose` — NOT the `triage_queue` / `triage_dispose` the folded
// module shipped. The skills satellite kept its names because `vault-skills`
// sanitizes to exactly the `vault_skills` prefix its tools already carried;
// there is no id that both matches the suite's `vault-*` naming and reproduces
// a bare `triage_` prefix. The plugin id and the tool namespace are the same
// string, so this is a consequence of the id, not an independent decision — see
// CLAUDE.md, which records it as the extraction's one breaking change.
//
// ── The authority axis, applied (#221/#241) ─────────────────────────────────
//
// No disposition confers standing — built-ins are mechanical, reversible
// writes (a link-healing move, processFrontMatter, Obsidian's recoverable
// trash), and a declared `choice` row runs a QuickAdd choice the HUMAN bound in
// plugin config. The agent-facing surface is the disposition id only; the
// binding is config (human-only-mutable), so this does NOT weaken the
// quickadd:*/js-engine:* opaque-execution denies the host applies to
// `obsidian_run_command` — an agent still cannot name a macro, only pick from
// the human's menu. A choice script's effects are not journaled as effects
// (unknown to this tool); they surface in the governance review queue via
// non-human attribution, the existing audit net. NO ACCEPTANCE SEMANTICS
// ANYWHERE: the shared accept-forbidden rule (@vault-mcp/core, a published
// contract — leaving the host did not leave the guard behind) is re-checked
// over every frontmatter patch before it is written, and config validation
// already refuses acceptance-carrying patches loudly.
//
// ── Vault semantics are configuration ───────────────────────────────────────
//
// Inbox recognition (inboxMarkers), the stamp/escalate patches, the move
// whitelist/blacklist, the declared disposition rows, and the named queues are
// all per-vault config (kernel/config.ts); nothing scheme-semantic is hardwired
// here. Config used to live in the host's `modules.triage.config` and now lives
// in this plugin's own data.json — adopted once, see settings.ts.
//
// ── Envelope convention (the satellite contract) ────────────────────────────
//
// A handler returns PLAIN DATA and THROWS on refusal. The host wraps a return
// value in `ok()` and a thrown error in `fail()`; `fail()` reads a lowercase
// snake `code` off the thrown error and renders `Error [code]: message`, the
// same shape the module's `codedError` produced — so every typed refusal an
// agent sees is byte-compatible with the folded era. `ok` / `fail` /
// `codedError` themselves are host-internal and are not imported here.
//
// ONE envelope DID change, and only one: the mid-sequence partial failure. The
// module returned `okError(...)` — ok()'s structured shape PLUS `isError` — so
// a "frontmatter landed, the move did not" outcome carried both the flag and
// the structured effects. A published handler can only return (⇒ no flag) or
// throw (⇒ no structure), and silently reporting a partial write as SUCCESS is
// the worse of the two, so it THROWS `dispose_partially_applied` with the facts
// in the message. The load-bearing property — a mid-sequence failure must NAME
// what already landed and never hide a partially-applied disposition — is kept;
// what is lost is the journal's `effects` field on that one path (the record
// itself still exists, with `outcome: "error"` and the note as its target).
//
// ── Allowlist discipline, as a satellite ────────────────────────────────────
//
// The ENFORCED boundary is the host's, and for a queue tool it is stricter than
// the in-tool filter it replaces; for the dispose tool it is the same boundary
// reached a different way. Precisely:
//
//   * `queue` carries NO recognized path argument (`base` and `queue` are not
//     path keys, and the marker queue takes no path at all). The host distrusts
//     an external tool's `readOnlyHint: true` unless the publisher's raw id is
//     in `trustedReadOnlyPlugins`, so it registers as MUTATING; and a mutating
//     external tool with no recognized path key is BLOCKED OUTRIGHT while a
//     path allowlist is active — trusted or not (the gate was closed to trust
//     on 2026-09-05 by the skills satellite's review). So under an allowlist
//     `queue` is refused WHOLESALE, where the module filtered its listing. That
//     is fail-closed and strictly stricter. With no allowlist configured the
//     `visible` filter was a no-op anyway, so nothing else changes.
//   * `dispose` carries `path`, which IS a recognized path key, so it is scoped
//     normally rather than blocked. Its destination argument was RENAMED
//     `target` → `target_path` at this extraction — `target_path` is in the
//     host's PATH_KEYS and `target` is not, so the guard now checks the
//     destination folder itself. In the module that check was the handler's own
//     (`ctx.visible` over the computed destination); a satellite cannot reach
//     the host's guard settings, so the check had to move to an argument the
//     host can see. The tool was renamed anyway (see above) and the argument is
//     the same shape, so this is the `to_address` / `displace_to_address`
//     precedent applied in the same motion.
//   * WHAT THAT DOES NOT COVER, stated plainly rather than glossed: a declared
//     row with a CONFIGURED `destination` and no `target_path` sends the note
//     somewhere no call argument names, so the host's allowlist never sees it.
//     The bound on that path is the human's own `moveWhitelist` /
//     `moveBlacklist`, enforced at plan time AND re-checked at apply — which is
//     the right bound for it: the session allowlist scopes what the CALLER can
//     name, and a declared row's destination is the human's standing choice,
//     not the agent's. The agent-controlled half is `target_path`, and that
//     half is guard-checked.
//
// `ctx.visible` and `ctx.getSettings` are kept as seams and are NOT supplied in
// the shipped configuration — the same defence-in-depth posture the skills
// satellite keeps for its preview filter. Their tests supply them so they
// cannot rot, and a future `vault-mcp-api` that can carry the caller's scope to
// a publisher (an apiVersion-2 item) will supply them for real with no change
// to the code below.
//
// ── Schema fidelity across the boundary ─────────────────────────────────────
//
// The SDK converts a zod shape to JSON Schema and the host converts it back
// through a deliberately small subset (`json-schema-to-zod.ts`): `type`,
// `description` and STRING `enum` survive; `default`, `min`, `max` and
// `pattern` DO NOT. So every bound this tool relies on is re-applied in the
// handler — the `limit` clamp and the `dry_run` default below. That is the
// `vault_skills_release` semver lesson: a constraint that lives only in the
// declared schema never runs for an MCP caller.
//
// Obsidian-free by construction: the vault arrives through the injected
// TriageSource and every handler is headless-testable. The live adapter is
// `obsidianTriageSource(app)` in obsidian-source.ts.

import { z } from "zod";
import type { SdkToolSpec } from "vault-mcp-api";
import { acceptForbiddenReason, type GuardSettings } from "@vault-mcp/core";
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
} from "./kernel/index.js";

/** The read tool's SDK flags. `readOnly: true` is a CLAIM the host distrusts by
 * default — see the allowlist note in the header for what that costs. */
const RO = { readOnly: true, destructive: false, idempotent: true } as const;
/** The write tool's SDK flags. */
const RW = { readOnly: false, destructive: false, idempotent: false } as const;

const QUEUE_LIMIT_DEFAULT = 50;
const QUEUE_LIMIT_MAX = 200;

/**
 * A TYPED refusal, thrown. `fail()` in the host reads a lowercase-snake `code`
 * off the error and renders `Error [code]: message` — the identical envelope
 * the module's `codedError` produced.
 */
export class TriageRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TriageRefusal";
    this.code = code;
  }
}

/** Declared as a FUNCTION, not a const arrow: TypeScript only narrows control
 * flow through a `never`-returning call when the callee is a function
 * declaration (or an explicitly annotated const), and every refusal below
 * relies on that narrowing to keep the happy path free of `!` assertions. */
function refuse(code: string, message: string): never {
  throw new TriageRefusal(code, message);
}

/** What the module needs from the vault — structurally typed, no `obsidian`
 * import (the LinkSource/CrosssessionSource discipline). */
export interface TriageSource {
  /** Every markdown path in the vault (UNfiltered; the tool layer applies the
   * allowlist filter, when it has one, before anything is read). */
  paths(): string[];
  /** A note's cached frontmatter, or null. */
  frontmatter(path: string): Record<string, unknown> | null;
  /** Creation/modification times (ms epoch), or null when unknown. */
  stat(path: string): { ctime: number | null; mtime: number | null } | null;
  /** Whether a file exists at this exact path. */
  exists(path: string): boolean;
  /** Move a note — MUST route through a link-healing rename
   * (`fileManager.renameFile`, parents created, never overwrites). */
  move(from: string, to: string): Promise<void>;
  /** Trash a note (Obsidian's recoverable trash — never a hard delete). */
  trashNote(path: string): Promise<void>;
  /** Atomically edit a note's frontmatter (processFrontMatter live). */
  updateFrontmatter(path: string, apply: (fm: Record<string, unknown>) => void): Promise<void>;
  /** Execute a human-bound QuickAdd choice (a declared `choice` disposition)
   * with variables — the shared #225 executeChoice seam, published to
   * `@vault-mcp/core` at this extraction so the host's `obsidian_run_command`
   * and this plugin still drive a choice through ONE implementation. Typed
   * refusals for unavailable/unresolved; a throw from the choice's own script
   * propagates. */
  runChoice(
    binding: string,
    variables: Record<string, string>,
  ): Promise<{ ok: true; choice: string } | { ok: false; code: string; message: string }>;
}

/** An inert source — for settings-UI stand-ins and tests: no notes, and every
 * write throws. */
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

/** The shape a base-backed queue would hand back. Kept as a seam type so the
 * feature can be re-lit without reshaping the handler; see the note below. It
 * mirrors the `BaseRowsResult` exported from `packages/bases/src/tools.ts` —
 * which this package cannot import, being a sibling satellite rather than a
 * published `@vault-mcp/core` type. */
export interface BaseRowsResult {
  view: string;
  viewType: string;
  columns: string[];
  rows: Array<{ path: string; values: Record<string, unknown> }>;
  total: number;
  truncated: boolean;
  someRowsHidden: boolean;
}

export interface TriageToolsCtx {
  /** This plugin's own config record (the settings tab's values). Read per
   * CALL, not captured, so a settings change lands on the next call rather
   * than on the next Obsidian reload. */
  config: () => Record<string, unknown>;
  /**
   * The HOST's guard settings, if a caller can supply them. NOTHING SUPPLIES
   * THEM IN THE SATELLITE — see the allowlist note in the header. Gates the
   * `some_rows_hidden` disclosure for base-backed queues.
   */
  getSettings?: () => GuardSettings;
  /** The host's allowlist filter. Absent ⇒ nothing filtered, matching
   * `visiblePaths` with no allowlist. Not supplied in the satellite. */
  visible?: (paths: string[]) => string[];
  /**
   * A scheme module's expected-location read service, when one is available: a
   * note's own address plus the folder the scheme expects it in. Absent (or
   * returning null) ⇒ the `scheme` advisory is simply omitted. Not supplied in
   * the satellite — the scheme module is host-side and there is no published
   * read service for it.
   */
  schemeExpected?: (path: string) => { address: string; expected_folder: string | null } | null;
  /**
   * The evaluated-rows seam for base-backed queues. Absent ⇒ they refuse typed
   * (`bases_unavailable`); the marker queue is unaffected. Not supplied in the
   * satellite — see the note at the bottom of this file.
   */
  baseQuery?: (args: {
    path: string;
    view?: string;
    limit?: number;
  }) => Promise<{ refusal: { code: string; message: string } } | { result: BaseRowsResult }>;
  /** Injectable clock for age computation (tests). Absent ⇒ run clock. */
  now?: () => Date;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Whether a path allowlist is active — gates whether `some_rows_hidden` is
 * disclosed at all (with no allowlist it is a constant false and says nothing).
 * The module imported this from the host's tools-bases.ts; the original is
 * still exported, but it moved with the bases surface at S7 and now lives in
 * `packages/bases/src/tools.ts`, which this package can no more import than it
 * could the host. Three lines over a core type is the right amount to keep
 * local. */
function allowlistActive(ctx: Pick<TriageToolsCtx, "getSettings">): boolean {
  const allow = ctx.getSettings?.()?.allowlist;
  return Array.isArray(allow) && allow.length > 0;
}

/**
 * Build the two tool specs. `config` is a thunk, read per call; the disposition
 * ENUM and the tool descriptions are necessarily snapshots of the config AT
 * BUILD TIME (a published spec's schema is fixed once the host snapshots it),
 * which is why main.ts re-publishes on every settings change. The planner
 * re-resolves per call regardless, so a raced config edit can only make a call
 * refuse `unknown_disposition` — never run a stale row.
 */
export function buildTriageTools(source: TriageSource, ctx: TriageToolsCtx): SdkToolSpec[] {
  const vis = ctx.visible ?? ((p: string[]) => p);
  const now = ctx.now ?? (() => new Date());
  const cfg = (): TriageConfig => triageConfigOf(ctx.config());
  const registrationTable = mergedDispositionsOf(cfg());
  const choiceIds = registrationTable.filter((d) => d.action === "choice").map((d) => d.id);

  const queue: SdkToolSpec = {
    name: "queue",
    description:
      "List a triage queue for the agent sweep (humans use native Bases; this emits data, not a view). " +
      "DEFAULT (no base/queue): the inbox-marker queue — notes with any ancestor folder whose name contains a " +
      "configured inbox marker (default \" Inbox for \"; the inbox's own folder note is not an item), with " +
      "path, enclosing inbox, created/modified times, age in days, and frontmatter `type`/`status`, OLDEST " +
      "FIRST. Capped by `limit` (`truncated: true` + the total when more exist). `base`/`view`/`queue` select a " +
      "Base-backed queue, which needs the Bases capture path owned by the separate `vault-bases` plugin: this " +
      "plugin cannot reach it, so those forms refuse typed (`bases_unavailable`) and the marker queue is the " +
      "working surface (for evaluated Base rows call `vault_bases_query`). Read-only in " +
      "intent; the host treats an external tool's read-only claim as untrusted, so under a path allowlist this " +
      "tool is blocked outright (it carries no path argument to scope by).",
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
        .describe("A config-declared named queue id (config.queues). Mutually exclusive with `base`."),
    },
    ...RO,
    handler: async (args: Record<string, unknown>) => {
      const limit = args.limit as number | undefined;
      const base = args.base as string | undefined;
      const view = args.view as string | undefined;
      const queueId = args.queue as string | undefined;
      const config = cfg();
      // The declared min/max/default do NOT survive the JSON-Schema round trip
      // (see the header) — clamp here, where it actually runs.
      const cap =
        typeof limit === "number" && Number.isFinite(limit)
          ? Math.min(Math.max(Math.trunc(limit), 1), QUEUE_LIMIT_MAX)
          : QUEUE_LIMIT_DEFAULT;

      // ── argument shape ────────────────────────────────────────────────
      if (queueId !== undefined && base !== undefined) {
        refuse("invalid_arguments", "pass `queue` OR `base`, not both");
      }
      if (view !== undefined && base === undefined) {
        refuse(
          "invalid_arguments",
          "`view` rides the `base` argument — a named queue's view is declared in its config row",
        );
      }

      // ── base-backed queue (explicit base, or a config-named queue) ────
      let basePath = base;
      let baseView = view;
      if (queueId !== undefined) {
        const decl = config.queues.find((q) => q.id === queueId);
        if (!decl) {
          const known = config.queues.map((q) => q.id);
          refuse(
            "unknown_queue",
            `no declared queue '${queueId}'` +
              (known.length ? ` — declared: ${known.join(", ")}` : " — config.queues declares none"),
          );
        }
        basePath = decl.base;
        baseView = decl.view;
      }
      if (basePath !== undefined) {
        if (!ctx.baseQuery) {
          refuse(
            "bases_unavailable",
            "base-backed queues evaluate a .base through the Bases capture path owned by the separate " +
              "`vault-bases` plugin, which is internal to it and not reachable from this plugin — use the " +
              "inbox-marker queue (omit `base`/`queue`), or read the Base with the `vault_bases_query` tool",
          );
        }
        const outcome = await ctx.baseQuery({ path: basePath, view: baseView, limit: cap });
        if ("refusal" in outcome) refuse(outcome.refusal.code, outcome.refusal.message);
        const r = outcome.result;
        return {
          ...(queueId !== undefined ? { queue: queueId } : {}),
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
        };
      }

      // ── the marker queue ──────────────────────────────────────────────
      const rows: QueueRow[] = [];
      // Visible-filter BEFORE any stat/frontmatter read (read-boundary rule).
      // Dormant in the satellite: under an allowlist the host blocks this tool
      // outright, so there is no configuration in which it filters rather than
      // refuses. Kept because it is the correct shape for the day a publisher
      // can be handed the caller's scope.
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
      return {
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
      };
    },
  };

  const dispose: SdkToolSpec = {
    name: "dispose",
    description:
      "Dispose of one inbox note using the MERGED disposition table — three built-in primitives (trash / move / " +
      "stamp) plus the human-declared rows in this plugin's `declaredDispositions` config (default: one declared " +
      "row, escalate). Every disposition is an ordinary agent write (none confers standing; nothing here touches " +
      "acceptance). DRY-RUN BY DEFAULT for built-in actions: the call reports exactly what would change and " +
      "writes nothing until `dry_run: false`. Dispositions: " +
      mergedLines(registrationTable).join("; ") +
      ". `target_path` names a destination FOLDER (the note keeps its filename): required for the built-in move " +
      "(and declared moving rows without a configured destination), an override for rows with one, refused for " +
      "trash / in-place stamps / choice rows. Move destinations are checked against the configured " +
      "moveWhitelist/moveBlacklist (`move_denied`), enforced at plan time and re-checked at apply. Moves ride a " +
      "link-healing rename and never overwrite (`destination_occupied`); frontmatter patches come from config or " +
      "the declared row (array values union, scalars overwrite) and can never write acceptance. A declared " +
      "`choice` row executes its human-bound QuickAdd choice" +
      (choiceIds.length ? ` (here: ${choiceIds.join(", ")})` : "") +
      " — opaque, so it CANNOT dry-run: it refuses until you pass an explicit `dry_run: false`, and its " +
      "script's effects are not itemized here (they surface in the governance review queue via non-human " +
      "attribution).",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path of the inbox note to dispose of."),
      disposition: z
        .enum(mergedIds(registrationTable) as [string, ...string[]])
        .describe("Which disposition to apply — one of the merged (built-in ∪ declared) table's ids."),
      target_path: z
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
    ...RW,
    handler: async (args: Record<string, unknown>) => {
      const path = args.path as string;
      const disposition = args.disposition as string;
      const targetPath = args.target_path as string | undefined;
      // The declared `default: true` does NOT survive the round trip (see the
      // header). Dry-run is the default HERE, where it runs: anything that is
      // not an explicit `false` is a preview.
      const dry = args.dry_run !== false;

      const config = cfg();
      const planned = planDispose({ path, disposition, target: targetPath, config });
      if ("refusal" in planned) refuse(planned.refusal.code, planned.refusal.message);
      const { plan } = planned;

      if (!source.exists(path)) refuse("not_found", `not a note: ${path}`);

      // A choice row is opaque — no preview exists. Refuse typed until the
      // caller explicitly opts out of the dry-run default.
      if (plan.choice !== null && dry) {
        refuse(
          "choice_dry_run_unsupported",
          `disposition '${plan.disposition.id}' runs a human-bound QuickAdd choice and cannot be previewed — ` +
            "pass an explicit dry_run: false to execute it",
        );
      }

      // The computed destination is not a call argument, so the host's guard
      // never saw it. Re-check it against the allowlist ourselves, dry-run and
      // apply alike, and refuse an occupied destination rather than ever
      // overwriting. The allowlist half is dormant in the satellite (`visible`
      // is unsupplied) — what covers the caller-named half instead is the
      // `target_path` ARGUMENT, which the host's guard does check. See the
      // allowlist note in the header, including what that leaves uncovered.
      if (plan.moveTo !== null) {
        if (vis([plan.moveTo]).length === 0) {
          refuse("out_of_allowlist", `computed destination '${plan.moveTo}' is outside the path allowlist`);
        }
        if (source.exists(plan.moveTo)) {
          refuse(
            "destination_occupied",
            `destination already exists: '${plan.moveTo}' — pick another target_path or resolve the collision first`,
          );
        }
      }

      // Belt-and-suspenders: the shared accept-forbidden rule over the
      // effective patch (config validation already refuses these loudly;
      // a patch that somehow carries acceptance still never reaches a note).
      if (plan.patch) {
        const forbidden = acceptForbiddenReason(plan.patch);
        if (forbidden) refuse("accept_forbidden", forbidden);
      }

      // Optional scheme advisory — absent in the satellite (no published
      // scheme read service), never load-bearing.
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

      if (dry) return { ...base, applied: false };

      // ── apply: a choice row hands off to the human-bound QuickAdd choice
      //    through the shared #225 seam ──────────────────────────────────
      if (plan.choice !== null) {
        const run = await source.runChoice(plan.choice, {
          path,
          disposition: plan.disposition.id,
        });
        if (!run.ok) refuse(run.code, run.message);
        return {
          ...base,
          applied: true,
          choice: run.choice,
          // The script's writes are not visible from here: no effects claim
          // (the journal records the disposition; script writes surface in the
          // governance review queue via non-human attribution).
          effects_unknown: true,
        };
      }

      // ── apply: frontmatter first (while the path is stable), then the
      //    move/trash — the legacy flow's order ─────────────────────────────
      // The move whitelist/blacklist RE-CHECK at apply time (the ruling's
      // "enforced at plan time AND re-checked at apply"), against a FRESH
      // config read, beside the allowlist re-check above.
      if (plan.moveTo !== null) {
        const folder = plan.moveTo.split("/").slice(0, -1).join("/");
        const denied = moveDenied(folder, cfg());
        if (denied) refuse("move_denied", denied);
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
        const what = plan.trash ? "trash" : "move";
        // A mid-sequence failure must NAME what already landed, never hide a
        // partially-applied disposition (the renumber-address discipline). As a
        // published tool the only way to say "this failed" is to throw, so the
        // facts go in the message — see the envelope note in the header.
        if (patchApplied) {
          refuse(
            "dispose_partially_applied",
            `disposition '${plan.disposition.id}' is PARTIALLY APPLIED to '${path}': the frontmatter patch ` +
              `${JSON.stringify(plan.patch)} was written, then the ${what} failed (${msg}). The note is still ` +
              `at '${path}' with the patch applied — re-run once the ${what} can succeed, or undo the patch.`,
          );
        }
        refuse("dispose_failed", `the ${what} failed and nothing was written: ${msg}`);
      }

      const finalPath = plan.moveTo ?? path;
      // An in-place disposition whose configured patch is empty writes nothing
      // at all — report zero effects honestly rather than claiming a file
      // changed.
      const wrote = patchApplied || plan.trash || plan.moveTo !== null;
      return {
        ...base,
        applied: true,
        ...(plan.moveTo !== null ? { moved_to: plan.moveTo } : {}),
        ...(plan.trash ? { trashed: true } : {}),
        ...(patchApplied ? { frontmatter_applied: true } : {}),
        // The reportedEffects convention (the host's guarded.ts): the file
        // actually touched — at its final path — lands in the journal's
        // `effects`.
        filesChanged: wrote ? 1 : 0,
        files: wrote ? [finalPath] : [],
      };
    },
  };

  return [queue, dispose];
}

// ── Base-backed queues: the one capability the extraction costs ──────────────
//
// While triage was a host module, `triage_queue {base}` evaluated a `.base`
// file through the bases module's shared capture seam (`queryBaseRows`, then
// in the host's `mcp/tools-bases.ts`) — Obsidian's own Bases engine, so one
// human-authored Base definition drove the human view AND the agent sweep.
//
// That seam did NOT come along, and copying it would have been the wrong call
// rather than merely a big one. The capture drives a hidden Bases leaf, which
// is a GLOBAL resource, and its owner guards it with a module-scoped serializer
// — "one capture at a time across the whole plugin process". A second copy in a
// second plugin means two serializers with no knowledge of each other racing on
// the one leaf, which is exactly the invariant the serializer exists to hold.
// The seam also reaches the bases surface's own config (row cap, query timeout)
// and its typed-refusal vocabulary, none of which is published.
//
// S7 REINFORCED that reasoning rather than overturning it. When bases itself
// left the host, `queryBaseRows`, `makeSerializer`, the module-scoped
// `captureSerializer`, `withBeltDeadline` and `captureWithCleanup` MOVED into
// `packages/bases/src/tools.ts` — a move, with no copy left behind (nothing in
// `packages/plugin/src` references any of them). One serializer over the one
// leaf still, owned now by the `vault-bases` plugin rather than by the host. A
// copy HERE would still be wrong for exactly the reason above: two plugins each
// holding a serializer over the one leaf is the same race whichever two plugins
// they are. What changed is only the seam's address, never the argument.
//
// So `ctx.baseQuery` is left unsupplied and the base/queue forms refuse typed,
// through the SAME feature-gate branch they always had for a pre-Bases
// Obsidian. Callers that want evaluated Base rows have the `vault-bases`
// satellite's `vault_bases_query` tool — the same evaluation path, under the
// name publication gave it (`<sanitized publisher id>_<bare name>`, with the
// module's redundant `base_` prefix stripped so it is not
// `vault_bases_base_query`; `base_list` likewise became `vault_bases_list`).
// The seam stays in the ctx (and its tests keep exercising it) so the feature
// re-lights the day a publisher can be handed a bases service — an
// apiVersion-2 item, alongside carrying the caller's scope.
//
// `GuardSettings` comes from `@vault-mcp/core`, never a local copy — the same
// rule the skills satellite records: the host's `guard.ts` and this plugin must
// ask ONE question about visibility, and a second copy of a guard predicate is
// the drift this repo has already paid for twice.
