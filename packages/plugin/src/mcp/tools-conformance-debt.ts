// tools-conformance-debt.ts — the read-only conformance-debt report (issue
// #211, Part A2). ONE tool, `obsidian_conformance_debt`, that reads the
// accepted-debt baseline + the metadata sidecar + a live conformance run and
// returns the carried debt as structured, filterable/groupable data plus the
// burn-down counts and the two teeth (staleness, budget).
//
// ── Read-only / agent-safe by construction ───────────────────────────────────
//
// The tool NEVER writes. It reads the baseline note, the sidecar JSON, and runs
// the conformance engine (a disk scan, no mutation). It exposes no accept verb
// and no path that stamps `acceptedOn`/`acceptedBy` — those are minted only at
// the human-run `--rebaseline` (conformance/cli.ts). `readOnlyHint: true`, so
// read-only mode leaves it available and it takes no write-queue slot. This is
// exactly the boundary the acceptance principle requires: agents SEE debt; only
// a human MINTS acceptance.
//
// ── Whole-vault, like obsidian_health ────────────────────────────────────────
//
// The report runs over the whole vault and does NOT apply the path allowlist,
// matching `obsidian_health`'s precedent ("a partial report is a misleading
// one"). It is also the right call here specifically: every target it names is
// already a plaintext line in the committed baseline note (a governed vault
// note), so the paths are not secret to a session that can read the baseline. A
// filtered debt register would silently under-count carried debt and disagree
// with the ratchet's own counts. `getSettings` is retained for parity.
//
// ── Obsidian-free core ───────────────────────────────────────────────────────
//
// Everything arrives through an injected `DebtSource` (structurally typed, like
// HealthSource / LinkSource), so the handler is unit-testable headlessly against
// a fake source. The Obsidian adapter — which runs the real conformance engine
// over the vault's on-disk root — is the one un-headless seam, verified live.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail } from "./helpers.js";
import type { GuardSettings } from "../guard.js";
import type { Finding } from "../conformance/finding.js";
import { parseBaseline } from "../conformance/ratchet.js";
import { parseSidecar, type DebtSidecar } from "../conformance/debt-sidecar.js";
import {
  buildDebtReport,
  filterDebtItems,
  groupDebtItems,
  type DebtFilter,
  type DebtGroupKey,
} from "../conformance/debt.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Default staleness threshold (days). A "sane default" (issue #211 teeth);
 * `staleAfterDays: 0` in config disables it. */
export const DEFAULT_STALE_AFTER_DAYS = 90;

/**
 * The vault state the debt report reads. Obsidian-free (structurally typed) so
 * the handler is headless-testable; the real adapter runs the conformance
 * engine over the on-disk vault.
 */
export interface DebtSource {
  /** The live conformance findings for a fresh run. */
  liveFindings(): Promise<Finding[]>;
  /** The accepted-debt baseline note text (its fenced key block is parsed). */
  baselineText(): Promise<string>;
  /** The metadata sidecar (tolerant: absent/corrupt reads as empty). */
  sidecar(): Promise<DebtSidecar>;
}

export interface ConformanceDebtCtx {
  /** Merged `modules.conformance-debt.config` (defaults ∪ user override):
   * `staleAfterDays`, `debtBudget`, `strictBudget`. Absent ⇒ defaults. */
  config?: Record<string, unknown>;
  /** Guard settings — retained for parity; the allowlist is NOT applied (the
   * report is whole-vault, see the module header). Absent ⇒ unfiltered. */
  getSettings?: () => GuardSettings;
  /** The run's clock, injectable for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/** Resolved teeth config from a raw `modules.conformance-debt.config` bag. */
export function conformanceDebtConfigOf(config: Record<string, unknown> | undefined): {
  staleAfterDays: number;
  debtBudget: number | null;
  strictBudget: boolean;
} {
  const c = config ?? {};
  const stale = typeof c.staleAfterDays === "number" && Number.isFinite(c.staleAfterDays) ? c.staleAfterDays : DEFAULT_STALE_AFTER_DAYS;
  const budget = typeof c.debtBudget === "number" && Number.isFinite(c.debtBudget) && c.debtBudget >= 0 ? c.debtBudget : null;
  const strict = c.strictBudget === true;
  return { staleAfterDays: stale, debtBudget: budget, strictBudget: strict };
}

export function registerConformanceDebtTools(server: McpServer, source: DebtSource, ctx: ConformanceDebtCtx = {}): void {
  const cfg = conformanceDebtConfigOf(ctx.config);
  const clock = ctx.now ?? (() => new Date());

  server.registerTool(
    "obsidian_conformance_debt",
    {
      title: "Report accepted conformance debt (read-only burn-down)",
      description:
        "Read-only conformance-debt register. Reads the accepted-debt baseline, the metadata sidecar (accepted-on/by, " +
        "reason, priority, fix-by), and a live conformance run, and returns the CARRIED debt as structured items — " +
        "each { script, check, target, kind, acceptedOn?, acceptedBy?, reason?, priority?, fixBy?, ageDays? } — plus " +
        "summary counts { carried, cleared, new }, a `stale` list (items older than the configured threshold), and a " +
        "`budget` status (warns when carried exceeds the configured max). Optional args narrow by folder prefix / pack " +
        "/ check / kind and group the counts. Never writes; acceptance is a human act (via --rebaseline), never this " +
        "tool. Runs over the whole vault (not allowlist-scoped, like obsidian_health).",
      inputSchema: {
        folder: z.string().min(1).optional().describe("Keep only items whose target is at/under this folder prefix (segment boundary)."),
        pack: z.string().min(1).optional().describe("Keep only items from this rule pack (the finding's `script`), e.g. \"drift_audit\"."),
        check: z.string().min(1).optional().describe("Keep only items with this check code, e.g. \"unregistered_tag\"."),
        kind: z.string().min(1).optional().describe("Keep only items with this kind discriminant."),
        group_by: z.enum(["folder", "pack", "check", "kind"]).optional().describe("Also return per-group carried counts by this dimension."),
      },
      annotations: RO,
    },
    async (args: { folder?: string; pack?: string; check?: string; kind?: string; group_by?: DebtGroupKey }) => {
      try {
        const [live, baselineText, sidecar] = await Promise.all([
          source.liveFindings(),
          source.baselineText(),
          source.sidecar(),
        ]);
        const report = buildDebtReport({
          baselineKeys: parseBaseline(baselineText),
          live,
          sidecar,
          now: clock(),
          staleAfterDays: cfg.staleAfterDays,
          debtBudget: cfg.debtBudget,
          strictBudget: cfg.strictBudget,
        });
        const filter: DebtFilter = { folder: args.folder, pack: args.pack, check: args.check, kind: args.kind };
        const items = filterDebtItems(report.items, filter);
        const stale = filterDebtItems(report.stale, filter);
        const groups = args.group_by ? groupDebtItems(items, args.group_by) : undefined;
        return ok({
          // Summary is the WHOLE-vault burn-down (never filtered — it must agree
          // with the ratchet's own carried/cleared/new).
          summary: report.summary,
          staleAfterDays: report.staleAfterDays,
          budget: report.budget,
          // `filtered` counts describe the returned, narrowed item set.
          filtered: { carried: items.length, stale: stale.length },
          items,
          stale,
          ...(groups ? { groups } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
