// tools-conformance-debt.ts — the conformance-debt tool surface (issue #211).
// TWO tools: `obsidian_conformance_debt` (Part A2, read-only report) reads the
// accepted-debt baseline + the metadata sidecar + a live conformance run and
// returns the carried debt as structured, filterable/groupable data plus the
// burn-down counts and the two teeth (staleness, budget);
// `obsidian_conformance_debt_render` (Part B, mutating) materializes the same
// report as a generated register note in the vault — see its own section
// header below.
//
// ── The REPORT tool: read-only / agent-safe by construction ──────────────────
//
// The report tool NEVER writes. It reads the baseline note, the sidecar JSON, and runs
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

import { posix } from "node:path";
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
  DEFAULT_STALE_AFTER_DAYS,
  type DebtFilter,
  type DebtGroupKey,
} from "../conformance/debt.js";
import { buildRegisterFromRun, registerAcceptRefusal, registerNotePathFor, DEFAULT_REGISTER_MAX_ROWS } from "../conformance/debt-register.js";
import { isVisible } from "../guard.js";
import { codedError } from "./helpers.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Default staleness threshold (days) — now defined in the conformance core
 * (debt.ts) so the headless CLI shares it; re-exported here so existing
 * importers keep working. `staleAfterDays: 0` in config disables it. */
export { DEFAULT_STALE_AFTER_DAYS };

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

// ── the human-facing register render (issue #211, Part B) ────────────────────
//
// `obsidian_conformance_debt_render` MATERIALIZES the debt report into the
// vault as ONE generated note (`Conformance debt.md`, default: beside the
// baseline/sidecar) that Obsidian renders natively — the materialize-to-disk
// pattern: MCP only triggers the write; the artifact lives on disk. It is the
// module's one MUTATING tool: `readOnlyHint: false`, so it inherits the
// guard-patched registrar's queue/journal/read-only-mode/kernel-args
// automatically, and the write itself goes through the injected vault-API
// writer with the shared accept-guard run over the text that will land
// (`registerAcceptRefusal`) — the register's frontmatter is a `generated` +
// `generator` derivation stamp and can never carry an acceptance-family key.
//
// ALLOWLIST: unlike the read tool (whole-vault report, obsidian_health's
// precedent), the render WRITES — so under an active path allowlist it REFUSES
// (`Error [out_of_allowlist]`, the obsidian_cli / Dataview precedent) unless
// the register note's path is inside the allowlist. Its write target is not an
// argument, so guardCall never sees it; this check is the tool's own.

/** The extra seams the render tool needs on top of the read-only DebtSource.
 * Structurally typed and Obsidian-free like everything else here; the live
 * adapter is `obsidianDebtRenderSource` (obsidian-debt-source.ts). */
export interface DebtRegisterSource extends DebtSource {
  /** The vault-relative dir the register renders into when config does not
   * override — by convention the baseline's own folder, where the sidecar and
   * trend log already live. "" = vault root. */
  defaultRegisterDir(): string;
  /** The baseline note's vault-relative path — consulted so the render can
   * REFUSE a collision (a baseline named like the register must never be
   * overwritten by its own report). */
  baselineNotePath(): string;
  /** Write a note at a vault-relative path (creating parent folders). */
  writeNote(path: string, text: string): Promise<void>;
}

/** True when a configured register dir cannot be honored: absolute (the vault
 * API expects vault-relative paths and would let `create` land outside the
 * vault base) or normalizing above the vault root. "" (the vault root) is
 * fine. Mirrors the guard's own normalize-before-compare discipline — the
 * config is user-set, so this is a misconfiguration refusal, not a security
 * boundary (an active allowlist already blocks escaped paths). */
function invalidRegisterDir(dir: string): boolean {
  if (dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)) return true;
  const n = posix.normalize(dir);
  return n === ".." || n.startsWith("../");
}

/** Render-specific config from the raw `modules.conformance-debt.config` bag:
 * `registerDir` (vault-relative; blank ⇒ the source's default — the baseline's
 * folder) and `registerMaxRows` (table cap). Separate from
 * `conformanceDebtConfigOf` so the teeth resolver's shape is untouched. */
export function debtRenderConfigOf(config: Record<string, unknown> | undefined): {
  registerDir: string | null;
  maxRows: number;
} {
  const c = config ?? {};
  const rawDir = typeof c.registerDir === "string" ? c.registerDir.trim().replace(/\/+$/, "") : "";
  const rawRows = c.registerMaxRows;
  const maxRows =
    typeof rawRows === "number" && Number.isFinite(rawRows) && rawRows >= 1
      ? Math.floor(rawRows)
      : DEFAULT_REGISTER_MAX_ROWS;
  return { registerDir: rawDir || null, maxRows };
}

export function registerConformanceDebtRenderTool(
  server: McpServer,
  source: DebtRegisterSource,
  ctx: ConformanceDebtCtx = {},
): void {
  const cfg = conformanceDebtConfigOf(ctx.config);
  const renderCfg = debtRenderConfigOf(ctx.config);
  const clock = ctx.now ?? (() => new Date());

  server.registerTool(
    "obsidian_conformance_debt_render",
    {
      title: "Render the conformance-debt register into the vault",
      description:
        "Regenerate the human-facing conformance-debt register: runs the conformance engine, diffs against the " +
        "accepted-debt baseline + metadata sidecar, and writes `Conformance debt.md` (default: beside the baseline) " +
        "— a summary header, a table of carried debt with each row wikilinked to the offending note (stale + " +
        "high-priority first), and a 'cleared — prune these from the baseline' section. DERIVED content: the note " +
        "carries only `generated`/`generator` frontmatter and never any acceptance field (the accept-guard is run " +
        "over the rendered text before writing). Mutating — it writes the register note; it never touches the " +
        "baseline or the sidecar. Refuses under an active path allowlist unless the register path is inside it.",
      inputSchema: {},
      annotations: RW,
    },
    async () => {
      try {
        const registerDir = renderCfg.registerDir ?? source.defaultRegisterDir();
        if (invalidRegisterDir(registerDir)) {
          return codedError(
            "invalid_register_dir",
            `registerDir (${registerDir}) must be a vault-relative folder — not absolute, not escaping the vault root.`,
          );
        }
        // Normalized before use, so the path checked (allowlist, collision) is
        // the path written.
        const notePath = registerNotePathFor(registerDir === "" ? "" : posix.normalize(registerDir));
        // A baseline named like the register must never be overwritten by its
        // own report — the CLI's collision refusal, mirrored here (case-folded:
        // the default macOS filesystem treats case variants as one file).
        if (notePath.toLowerCase() === source.baselineNotePath().toLowerCase()) {
          return codedError(
            "register_baseline_collision",
            `the register path (${notePath}) is the baseline note itself — rendering would overwrite the ` +
              "acceptance record. Configure `registerDir` elsewhere or rename the baseline.",
          );
        }
        const settings = ctx.getSettings?.();
        if (settings?.allowlist?.length && !isVisible(notePath, settings)) {
          return codedError(
            "out_of_allowlist",
            `the register note (${notePath}) is outside this session's path allowlist — the render writes there. ` +
              "Widen the allowlist to cover it, or configure `registerDir` inside the allowlisted area.",
          );
        }
        const [live, baselineText, sidecar] = await Promise.all([
          source.liveFindings(),
          source.baselineText(),
          source.sidecar(),
        ]);
        const { text, report, clearedKeys } = buildRegisterFromRun({
          baselineKeys: parseBaseline(baselineText),
          live,
          sidecar,
          now: clock(),
          staleAfterDays: cfg.staleAfterDays,
          debtBudget: cfg.debtBudget,
          strictBudget: cfg.strictBudget,
          maxRows: renderCfg.maxRows,
        });
        // The accept-guard over the text that will land — load-bearing
        // invariant, not a filter the renderer expects to trip.
        registerAcceptRefusal(text);
        await source.writeNote(notePath, text);
        return ok({
          written: notePath,
          summary: report.summary,
          budget: report.budget,
          staleAfterDays: report.staleAfterDays,
          stale: report.stale.length,
          rows: Math.min(report.items.length, renderCfg.maxRows),
          truncated: report.items.length > renderCfg.maxRows,
          cleared: clearedKeys.length,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
