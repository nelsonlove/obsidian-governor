// tools-triage.ts — the inbox-triage module's tool surface (#221, phase 2):
// the disposition substrate's second instance given a real agent surface. TWO
// tools, no pane:
//
//   triage_queue   — the agent's view of the inbox queue: inbox notes
//                    (allowlist-visible only), oldest first, capped
//                    (READ-ONLY). Humans use native Bases over frontmatter —
//                    this duplicates nothing native, and deliberately emits
//                    nothing view-like.
//   triage_dispose — the ONE guarded mutating verb, disposition selected from
//                    the ten-verb table (kernel/triage/descriptors.ts).
//                    DRY-RUN BY DEFAULT (the #214 report-first discipline):
//                    `dry_run: false` is the explicit opt-in to apply.
//
// ── The authority axis, applied (#221) ──────────────────────────────────────
//
// None of the ten dispositions confers standing — each is a mechanical,
// reversible write: a move through the SAME shared move primitive every other
// move tool uses (tools-vault-write.ts's `moveOne`, the link-healing
// fileManager.renameFile path — see obsidian-triage-source.ts), a frontmatter
// transition via processFrontMatter, or Obsidian's recoverable trash (never a
// hard delete). So all ten are `authority: "agent"` and there is NO pane UI
// here at all. NO ACCEPTANCE SEMANTICS ANYWHERE: the module reads no
// acceptance state, writes no acceptance field, and the shared
// accept-forbidden rule (@vault-mcp/core) is re-checked over every
// frontmatter patch before it is written (config validation already refused
// acceptance-carrying patches loudly).
//
// ── Vault semantics are configuration ───────────────────────────────────────
//
// Inbox recognition (inboxMarkers), fallback destinations, and the
// frontmatter patches are all per-vault config (kernel/triage/config.ts);
// defaults mirror the live vault conventions the legacy `dispose-inbox-item`
// flow implemented, and nothing scheme-semantic is hardwired here.
//
// ── Allowlist discipline ────────────────────────────────────────────────────
//
// The queue filters the listing through `host.visible` BEFORE reading any
// stat/frontmatter (read-boundary rule). `triage_dispose`'s `path` argument
// is guard-checked at the interception point; the COMPUTED destination is not
// a call argument, so the handler re-checks it with the same filter before
// planning anything to happen to it (the scheme-write discipline), in dry-run
// and apply alike.
//
// ── Scheme integration (optional, degrades cleanly) ─────────────────────────
//
// When the scheme module is enabled, dispose reports a `scheme` advisory —
// the note's own address and the folder the scheme expects it in
// (obsidian_expected_location's answer) — as a routing hint. With scheme
// disabled or unavailable the field is simply absent; nothing else changes.
//
// Obsidian-free by construction: the vault arrives through the injected
// TriageSource — every handler is headless-testable. The live adapter lives
// in obsidian-triage-source.ts (it imports the shared move primitive, which
// needs the real `obsidian` types).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { acceptForbiddenReason } from "@vault-mcp/core";
import { ok, fail, okError, codedError } from "./helpers.js";
import type { GuardSettings } from "../guard.js";
import {
  applyFrontmatterPatch,
  inboxFolderOf,
  planDispose,
  sortQueue,
  triageConfigOf,
  triageDispositionIds,
  triageDispositionLines,
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
  };
}

export interface TriageToolsCtx {
  /** The merged `modules.triage.config` (defaults ∪ user override). */
  config: Record<string, unknown>;
  /** Guard settings accessor — retained for parity with the other module
   * ctxs (the allowlist arrives pre-applied via `visible`). */
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
  // still lands on the next connect like every module.
  const cfg = (): TriageConfig => triageConfigOf(ctx.config);

  server.registerTool(
    "triage_queue",
    {
      title: "List the inbox triage queue",
      description:
        "List the notes currently sitting in inbox positions — the agent's view of the triage queue (humans use " +
        "native Bases; this emits data, not a view). A note is an inbox item when any ancestor folder's name " +
        "contains one of the configured inbox markers (default \" Inbox for \"); the inbox's own folder note is " +
        "not an item. Returns path, enclosing inbox, created/modified times, age in days, and the note's " +
        "frontmatter `type`/`status`, OLDEST FIRST, capped by `limit` (`truncated: true` + the total when more " +
        "exist). Only allowlist-visible notes are listed or read. Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(QUEUE_LIMIT_MAX)
          .default(QUEUE_LIMIT_DEFAULT)
          .describe(`Maximum rows to return (default ${QUEUE_LIMIT_DEFAULT}, max ${QUEUE_LIMIT_MAX}).`),
      },
      annotations: RO,
    },
    async ({ limit }: { limit?: number }) => {
      try {
        const config = cfg();
        const cap = limit ?? QUEUE_LIMIT_DEFAULT;
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
        "Dispose of one inbox note — the ten-verb successor to the retired dispose-inbox-item flow, every verb an " +
        "ordinary reversible agent write (none confers standing; nothing here touches acceptance). DRY-RUN BY " +
        "DEFAULT: the call reports exactly what would change and writes nothing until `dry_run: false`. " +
        "Dispositions: " +
        triageDispositionLines().join("; ") +
        ". `target` names a destination FOLDER (the note keeps its filename): required for route / " +
        "establish-new-home / register / curate-as-link; optional (overriding the configured destination) for " +
        "convert-to-action / develop-as-knowledge / defer-to-someday / archive-as-record; refused for discard / " +
        "escalate. Moves ride the link-healing move primitive and never overwrite (`destination_occupied`); " +
        "frontmatter patches come from module config (array values union, scalars overwrite). When the scheme " +
        "module is enabled the report includes a `scheme` advisory (the note's address + its expected folder); " +
        "with scheme disabled the field is simply absent.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the inbox note to dispose of."),
        disposition: z
          .enum(triageDispositionIds() as [string, ...string[]])
          .describe("Which disposition to apply — one of the ten declared verbs."),
        target: z
          .string()
          .optional()
          .describe(
            "Destination FOLDER (vault-relative) for the moving dispositions. Required for route / " +
              "establish-new-home / register / curate-as-link; overrides the configured destination for the " +
              "config-backed ones; refused for discard / escalate.",
          ),
        dry_run: z
          .boolean()
          .default(true)
          .describe("DEFAULT TRUE: report what would change without writing. Pass false to apply."),
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
          },
          effect: plan.disposition.effect,
          ...(scheme !== null ? { scheme } : {}),
        };

        if (dry) return ok({ ...base, applied: false });

        // ── apply: frontmatter first (while the path is stable), then the
        //    move/trash — the legacy flow's order ─────────────────────────────
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
