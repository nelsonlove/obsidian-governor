// cli.ts — the headless conformance rail entry.
//
// `runConformance` is the testable core: build a snapshot, construct the rule
// packs from settings (the module providers/instances), run the engine, and
// ratchet the findings against the accepted-debt baseline. It does NO process
// I/O — root, baseline text, and settings come in; a result + report + a
// ready-to-write rebaseline body come out. `main` is the thin wrapper that
// reads argv/env, loads the baseline note, prints, and sets the exit code.
//
// The two module packs (vocab + scheme) always run. All four ported legacy
// checks (structure/port/ste/drift) are opt-in behind `legacyPacks` — the full
// legacy rail now lives in TS, but stays gated until the staged rebaseline.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VocabRegistry, DEFAULT_VOCABULARIES, type VocabInstanceSettings } from "../kernel/vocab/registry.js";
import { makeRegistry, DEFAULT_SCHEMES, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { buildSnapshot } from "./snapshot.js";
import { runEngine, ENGINE_ID } from "./engine.js";
import { vocabPack, schemePack, structurePack, portPack, stePack, driftPack } from "./packs/index.js";
import { parseBaseline, renderBaseline, ratchet, type RatchetResult } from "./ratchet.js";
import type { Finding } from "./finding.js";
import type { RulePack } from "./rule-pack.js";

export interface RunOpts {
  root: string;
  baselineText: string;
  vocabularies: VocabInstanceSettings[];
  schemes: SchemeInstanceConfig[];
  excludedRoots?: string[];
  /**
   * Register the four ported legacy checks (structure/port/ste/drift — the
   * whole Python rail, now in TS). **Default ON** (issue #116).
   *
   * It defaulted OFF while the ports were landing, on the reasoning that an
   * unproven pack should not gate a run. Measured against the restored
   * baseline, that default was backwards: the accepted-debt baseline's keys are
   * *exclusively* legacy-pack keys, so a run without these packs cannot
   * reproduce a single one of them and reports the ENTIRE baseline as CLEARED —
   * 124 of 124, on every invocation. That is not a conservative default; it is
   * a guaranteed false "all previously-accepted debt is now fixed" report, and
   * it is the shape most likely to be mistaken for a real result.
   *
   * A pack set and the baseline it is ratcheted against have to describe the
   * same universe. `--no-legacy-packs` still opts out for a module-packs-only
   * run, but the caller then has to mean it.
   */
  legacyPacks?: boolean;
}

export interface RunResult {
  findings: Finding[];
  ratchet: RatchetResult;
  /** Human report for stdout. */
  report: string;
  /** The fenced-block body to write on --rebaseline. */
  rebaseline: string;
  exitCode: 0 | 1;
  /** Ids of every pack registered for this run. */
  packIds: string[];
  /** Registered packs that did NOT throw — the set the baseline was actually measured against. */
  coveredPackIds: string[];
}

export async function runConformance(opts: RunOpts): Promise<RunResult> {
  const snapshot = await buildSnapshot({ root: opts.root, excludedRoots: opts.excludedRoots });

  const packs: RulePack[] = [];
  // vocab providers: built from settings over the snapshot listing (the registry
  // confines each instance to its own root).
  const vocabInstances = new VocabRegistry(opts.vocabularies).build(snapshot.notes);
  packs.push(vocabPack(vocabInstances.map((i) => i.provider)));
  // scheme instances: from settings, independent of the listing.
  packs.push(schemePack(makeRegistry(opts.schemes).instances()));
  // ported legacy checks: native packs over the snapshot's raw sources,
  // blueprint listing, and config/existence inputs (conformance_check /
  // port_lint / ste_lint / drift_audit — the full legacy rail, all in TS).
  // Opt-in until the scope ruling + staged rebaseline.
  if (opts.legacyPacks ?? true) {
    packs.push(structurePack());
    packs.push(portPack());
    packs.push(stePack());
    packs.push(driftPack());
  }

  const findings = runEngine(packs, snapshot);
  const baselineKeys = parseBaseline(opts.baselineText);
  const result = ratchet(findings, baselineKeys);
  const packIds = packs.map((p) => p.id);
  // A pack that THREW is re-attributed by the engine to `conformance_engine /
  // pack_error`, so it contributes none of its own keys — registering it is not
  // the same as measuring it. Counting a crashed pack as "covered" would let a
  // rebaseline drop every accepted key it owns (PR #139 review, Important).
  const errored = new Set(
    findings.filter((f) => f.script === ENGINE_ID && f.check === "pack_error").map((f) => f.target),
  );
  const coveredPackIds = packIds.filter((id) => !errored.has(id));
  return {
    packIds,
    coveredPackIds,
    findings,
    ratchet: result,
    report: renderReport(result, packIds, baselinePackIds(baselineKeys), findings),
    rebaseline: renderBaseline(findings),
    exitCode: result.exitCode,
  };
}

/**
 * The pack ids the accepted-debt baseline actually describes — the first field
 * of each ratchet key (`script|check|target|kind`).
 *
 * This is what makes the rebaseline guard a COMPUTED fact rather than a
 * hardcoded constant that goes stale. A key with no `|` contributes itself, so
 * a malformed baseline degrades to naming a pack that is not registered — which
 * refuses — rather than throwing or silently naming nothing.
 */
export function baselinePackIds(baselineKeys: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const key of baselineKeys) {
    const id = key.split("|")[0];
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The reason a run may not trust this baseline at all, or null when it may.
 *
 * The baseline names accepted debt for a pack that did not run (or ran and
 * THREW — see `coveredPackIds`). Two distinct harms, one cause:
 *
 * - on a plain run, those keys all report CLEARED and nothing reports NEW, so
 *   the run exits 0 / CONFORMING while silently clearing accepted debt — a
 *   false green, which is the exact shape this whole change exists to remove.
 *   Measured with `--no-legacy-packs` against the live baseline: `0 carried,
 *   0 NEW, 2 cleared, CONFORMING`. The live vault masks it because vocab/scheme
 *   force NONCONFORMING anyway, so it looks fine precisely where it is tested.
 * - on `--rebaseline`, the written keyset cannot contain those keys, so the
 *   accepted debt is destroyed.
 *
 * Both are refusals, not warnings: a report nobody can trust must not also be
 * green, and an unreadable/unmeasured input must never read as an empty one.
 */
export function coverageRefusal(
  baselinePackIds: Set<string>,
  coveredPackIds: Set<string>,
  action: "run" | "--rebaseline" = "run",
): string | null {
  const uncovered = [...baselinePackIds].filter((id) => !coveredPackIds.has(id)).sort();
  if (!uncovered.length) return null;
  const consequence =
    action === "--rebaseline"
      ? "Rewriting it now would drop those accepted keys — debt a human granted — because a run cannot reproduce a pack it never measured."
      : "Every one of those keys would report CLEARED while nothing reports NEW, so this run would exit CONFORMING while silently clearing accepted debt.";
  return (
    `refusing to ${action === "--rebaseline" ? "--rebaseline" : "report"}: the baseline holds accepted debt for ` +
    `${uncovered.join(", ")}, which did not run (or threw) in this configuration. ${consequence} ` +
    `Re-run with those packs enabled, target a baseline that does not describe them, or pass --no-baseline to ` +
    `measure from zero deliberately.`
  );
}

/**
 * Does this baseline path name the LIVE accepted-debt record?
 *
 * Decided over **the file that will actually be written**, not over the shape
 * of argv. The earlier `!baselineArg` test was a proxy: passing
 * `--baseline=<the live baseline's own path>` made it false and the live
 * acceptance record was rewritten — reproduced end-to-end, an accepted key
 * erased from the file (PR #139 review, Critical 1).
 *
 * This is the same failure mode as a guard scanning a normalized copy instead
 * of the bytes that land: deciding over a proxy for the thing rather than the
 * thing. Resolved both sides, and through symlinks where they exist, so an
 * alias cannot launder the identity either.
 */
export function isLiveBaseline(baselinePath: string, root: string): boolean {
  const live = join(resolve(root), BASELINE_REL);
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return resolve(baselinePath) === resolve(live) || real(baselinePath) === real(live);
}

/**
 * The reason a `--rebaseline` must be refused, or null when it may proceed.
 *
 * TWO independent reasons, and they are not the same check:
 *
 * 1. **Uncovered packs.** The baseline names a pack that is not in this run's
 *    registered set, so rebaselining would write out a keyset that cannot
 *    contain that pack's keys — silently DESTROYING accepted debt a human
 *    granted. This applies to a fixture baseline as much as the live one; the
 *    old hardcoded guard only protected the live path.
 * 2. **The live baseline is an acceptance record.** Rewriting it re-accepts
 *    whatever the current run found, and acceptance is human-only. That reason
 *    does not expire when the pack set becomes complete, which is exactly why
 *    this must not collapse into check 1 — with every pack registered, a
 *    coverage-only guard would start PERMITTING the live rebaseline, quietly
 *    turning a governance boundary into a pack-completeness detail.
 *
 * Replaces `GUARD_LIVE_REBASELINE`/`PHASE1_PACKS_INCOMPLETE`, whose stated
 * reason ("drift_audit is unported") silently became false when the drift pack
 * landed. A constant encoding a fact about the pack set has to be computed from
 * the pack set.
 */
export function rebaselineRefusal(opts: {
  targetsLiveBaseline: boolean;
  baselinePackIds: Set<string>;
  registeredPackIds: Set<string>;
}): string | null {
  const cov = coverageRefusal(opts.baselinePackIds, opts.registeredPackIds, "--rebaseline");
  if (cov) return cov;
  if (opts.targetsLiveBaseline) {
    return (
      "refusing to --rebaseline the live baseline: it is an acceptance record, and rewriting it accepts every " +
      "current finding. Acceptance is a human gesture only — it is never granted by running a tool. Target a " +
      "fixture with --baseline=<path> instead."
    );
  }
  return null;
}

/** Registered packs contributing findings that the baseline says nothing about. */
function packsWithoutBaseline(
  registered: string[],
  baseline: Set<string>,
  findings: Finding[],
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.script, (counts.get(f.script) ?? 0) + 1);
  return registered
    .filter((id) => !baseline.has(id) && (counts.get(id) ?? 0) > 0)
    .map((id) => ({ id, count: counts.get(id) as number }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function renderReport(
  r: RatchetResult,
  registeredPackIds: string[] = [],
  baselineIds: Set<string> = new Set(),
  findings: Finding[] = [],
): string {
  const lines: string[] = [];
  lines.push(`conformance: ${r.carried} carried, ${r.newKeys.length} NEW, ${r.clearedKeys.length} cleared`);
  // A pack with NO baseline representation reports its entire output as NEW.
  // Undistinguished, that is indistinguishable from a catastrophic regression —
  // the same silent-zero class the engine's pack sentinels and the missing
  // baseline already refuse, at pack granularity. Say which packs those are so
  // the NEW count can be read correctly instead of alarming.
  const uncovered = packsWithoutBaseline(registeredPackIds, baselineIds, findings);
  if (uncovered.length) {
    const total = uncovered.reduce((n, p) => n + p.count, 0);
    lines.push(
      "",
      `NOTE: ${uncovered.length} pack(s) have NO accepted baseline, contributing ${total} of the ${r.newKeys.length} NEW keys:`,
    );
    for (const p of uncovered) lines.push(`  ! ${p.id} — ${p.count} finding(s), 0 accepted`);
    lines.push(
      "  These are unmeasured, not newly broken. Accepting a baseline for them is a human act; no run can grant it.",
    );
  }
  if (r.newKeys.length) {
    lines.push("", "NEW (regressions — run fails):");
    for (const k of r.newKeys) lines.push(`  + ${k}`);
  }
  if (r.clearedKeys.length) {
    lines.push("", "CLEARED (rebaseline to drop):");
    for (const k of r.clearedKeys) lines.push(`  - ${k}`);
  }
  lines.push("", r.failed ? "NONCONFORMING: new findings present" : "CONFORMING within the accepted baseline");
  return lines.join("\n");
}

// ── thin process entry (not unit-tested; the wiring above is) ─────────────────

const BASELINE_REL = "Assent/Build/conformance/Conformance baseline.md";
const FENCE = "```ratchet-baseline";

/** ASSENT_CONTENT_ROOT wins, else walk up from `start` to the `.obsidian`
 * ancestor (the same discovery the Python scripts use), else `start`. */
function discoverRoot(start: string): string {
  const env = process.env.ASSENT_CONTENT_ROOT;
  if (env) return resolve(env);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".obsidian"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

/** Replace (or append) the ratchet-baseline fence body in a baseline note.
 * Throws if the note has an opening fence marker but no complete fence block
 * (truncated/corrupt) — a silent no-op there would report "rebaselined" while
 * leaving the accepted debt untouched. The replacement uses a FUNCTION replacer
 * so `$`-sequences in `body` (vault paths can contain `$&` etc.) are inserted
 * literally, never interpreted as `String.replace` substitution patterns. */
export function writeFence(noteText: string, body: string): string {
  const block = `${FENCE}\n${body}\n\`\`\``;
  if (!noteText.includes(FENCE)) {
    return `${noteText.trimEnd()}\n\n${block}\n`;
  }
  const re = /```ratchet-baseline\n[\s\S]*?\n```/;
  if (!re.test(noteText)) {
    throw new Error("baseline note has an opening ```ratchet-baseline marker but no complete fence block — refusing to rebaseline a corrupt baseline");
  }
  return noteText.replace(re, () => block);
}

/**
 * Refusal text when the baseline is missing, or null when the run may proceed.
 *
 * A MISSING baseline must not silently read as empty: an empty baseline makes
 * every finding NEW and every accepted-debt key CLEARED — a report that looks
 * like catastrophic regression but is really a missing file, and the shape most
 * likely to be mistaken for a real result. This is the same silent-zero class
 * the engine's pack sentinels already refuse (`conformance_engine/pack_error`);
 * the baseline gets the same treatment.
 *
 * `--no-baseline` is the explicit opt-in for a genuine from-zero run (a first
 * run, or a deliberate reset) — the refusal is about the SILENT case, not about
 * forbidding zero baselines.
 */
export function baselineMissingRefusal(baselinePath: string, exists: boolean, noBaseline: boolean): string | null {
  if (noBaseline || exists) return null;
  return (
    `baseline not found at ${baselinePath} — refusing to run against an empty baseline, which would report every ` +
    `finding as NEW and every accepted key as CLEARED. Point at it with --baseline=<path>, or pass --no-baseline ` +
    `to run from zero deliberately.`
  );
}

async function main(argv: string[]): Promise<void> {
  const rebaseline = argv.includes("--rebaseline");
  const rootArg = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
  const root = rootArg ? resolve(rootArg) : discoverRoot(process.cwd());
  const baselineArg = argv.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length);
  const baselinePath = baselineArg ? resolve(baselineArg) : join(root, BASELINE_REL);
  // A MISSING baseline is refused, not silently treated as empty. An empty
  // baseline makes every finding read NEW and every accepted-debt key read
  // CLEARED — a report that looks like catastrophic regression but is really a
  // missing file, and the shape most likely to be mistaken for a real result.
  // This is the silent-zero class the engine's pack sentinels already refuse;
  // the baseline deserves the same treatment. `--no-baseline` is the explicit
  // opt-in for a genuine from-zero run (a first run, or a deliberate reset).
  const noBaseline = argv.includes("--no-baseline");
  const refusal = baselineMissingRefusal(baselinePath, existsSync(baselinePath), noBaseline);
  if (refusal) throw new Error(refusal);
  const baselineText = !noBaseline && existsSync(baselinePath) ? await readFile(baselinePath, "utf8") : "";

  const res = await runConformance({
    root,
    baselineText,
    vocabularies: DEFAULT_VOCABULARIES,
    schemes: DEFAULT_SCHEMES,
    // Default ON — see RunOpts.legacyPacks. The baseline describes these packs
    // and nothing else, so omitting them clears it wholesale.
    legacyPacks: !argv.includes("--no-legacy-packs"),
  });

  // Coverage is checked on EVERY run, not only before a rebaseline: a baseline
  // naming packs this run did not measure makes those keys report CLEARED with
  // nothing NEW, i.e. exit 0 / CONFORMING while silently clearing accepted debt.
  // Green-and-wrong is worse than red. (PR #139 review, Critical 2.)
  const baselineIds = baselinePackIds(parseBaseline(baselineText));
  const covered = new Set(res.coveredPackIds);
  const coverage = coverageRefusal(baselineIds, covered, rebaseline ? "--rebaseline" : "run");
  if (coverage) throw new Error(coverage);

  if (rebaseline) {
    // Computed from the run that just happened, not a hardcoded constant, and
    // keyed on the FILE THIS WILL WRITE rather than on argv shape — pointing
    // --baseline= at the live baseline's own path used to slip this guard
    // entirely. Checked BEFORE the write: a refused rebaseline must leave the
    // accepted debt exactly as it was.
    const refusal = rebaselineRefusal({
      targetsLiveBaseline: isLiveBaseline(baselinePath, root),
      baselinePackIds: baselineIds,
      registeredPackIds: covered,
    });
    if (refusal) throw new Error(refusal);
  }

  if (rebaseline) {
    const next = writeFence(baselineText || "# Conformance baseline\n", res.rebaseline);
    await writeFile(baselinePath, next);
    process.stdout.write(`rebaselined ${baselinePath} (${res.findings.length} findings)\n`);
    return;
  }

  process.stdout.write(res.report + "\n");
  process.exitCode = res.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`conformance: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 3;
  });
}
