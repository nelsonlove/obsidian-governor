// cli.ts — the headless conformance rail entry.
//
// `runConformance` is the testable core: build a snapshot, construct the rule
// packs from settings (the module providers/instances), run the engine, and
// ratchet the findings against the accepted-debt baseline. It does NO process
// I/O — root, baseline text, and settings come in; a result + report + a
// ready-to-write rebaseline body come out. `main` is the thin wrapper that
// reads argv/env, loads the baseline note, prints, and sets the exit code.
//
// Phase 1 wired the two module packs (vocab + scheme). Three of the four
// legacy checks (structure+legacy-scope from conformance_check, port, ste) are
// ported and join the list behind the opt-in `legacyPacks` flag
// (`--legacy-packs`), default off until the Phase-3 scope ruling + staged
// rebaseline; drift_audit remains Python-only.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VocabRegistry, DEFAULT_VOCABULARIES, type VocabInstanceSettings } from "../kernel/vocab/registry.js";
import { makeRegistry, DEFAULT_SCHEMES, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { buildSnapshot } from "./snapshot.js";
import { runEngine } from "./engine.js";
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
   * Register the ported legacy checks (structure/port/ste). Default OFF: they
   * reproduce the Python scripts over the governed tree, but the accepted
   * baseline predates the vault consolidation (its non-drift keys are
   * pre-consolidation paths), so a live run would gate NONCONFORMING on ~the
   * full keyset with no sanctioned exit — and the Phase-1 guard correctly
   * refuses rebaselining the live baseline. The packs stay opt-in until the
   * scope ruling + staged baseline migration. The packs are built, tested, and
   * parity-verified regardless; this only controls their inclusion in a run.
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
  // ported legacy checks: native packs over the snapshot's raw sources +
  // blueprint listing (conformance_check / port_lint / ste_lint).
  // Legacy check ports — opt-in until the scope ruling + staged rebaseline.
  if (opts.legacyPacks) {
    packs.push(structurePack());
    packs.push(portPack());
    packs.push(stePack());
    packs.push(driftPack());
  }

  const findings = runEngine(packs, snapshot);
  const result = ratchet(findings, parseBaseline(opts.baselineText));
  return {
    findings,
    ratchet: result,
    report: renderReport(result),
    rebaseline: renderBaseline(findings),
    exitCode: result.exitCode,
  };
}

function renderReport(r: RatchetResult): string {
  const lines: string[] = [];
  lines.push(`conformance: ${r.carried} carried, ${r.newKeys.length} NEW, ${r.clearedKeys.length} cleared`);
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

// Three of the four legacy checks are now ported (structure ← conformance_check,
// port ← port_lint, ste ← ste_lint); drift_audit is still Python-only. Until it
// is ported too, a `--rebaseline` against the LIVE baseline would overwrite its
// 56 accepted drift_audit findings (they no longer appear in a live TS run) —
// destroying accepted debt. So rebaselining the default (live) baseline is
// refused while the pack set is incomplete; a fixture baseline (explicit
// --baseline=) is always allowed.
const PHASE1_PACKS_INCOMPLETE = true;

async function main(argv: string[]): Promise<void> {
  const rebaseline = argv.includes("--rebaseline");
  const rootArg = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
  const root = rootArg ? resolve(rootArg) : discoverRoot(process.cwd());
  const baselineArg = argv.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length);
  const baselinePath = baselineArg ? resolve(baselineArg) : join(root, BASELINE_REL);
  if (rebaseline && !baselineArg && PHASE1_PACKS_INCOMPLETE) {
    throw new Error(
      "refusing to --rebaseline the live baseline while drift_audit is unported — " +
        "it would overwrite the accepted drift_audit debt (absent from a live TS run). Target a fixture with --baseline=<path>, " +
        "or wait for the drift_audit port.",
    );
  }
  const baselineText = existsSync(baselinePath) ? await readFile(baselinePath, "utf8") : "";

  const res = await runConformance({
    root,
    baselineText,
    vocabularies: DEFAULT_VOCABULARIES,
    schemes: DEFAULT_SCHEMES,
    legacyPacks: argv.includes("--legacy-packs"),
  });

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
