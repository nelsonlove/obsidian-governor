// cli.ts — the headless conformance rail entry.
//
// `runConformance` is the testable core: build a snapshot, construct the rule
// packs from settings (the module providers/instances), run the engine, and
// ratchet the findings against the accepted-debt baseline. It does NO process
// I/O — root, baseline text, and settings come in; a result + report + a
// ready-to-write rebaseline body come out. `main` is the thin wrapper that
// reads argv/env, loads the baseline note, prints, and sets the exit code.
//
// Phase 1 wires the two module packs (vocab + scheme). The legacy checks
// (drift/blueprint/ste/port) become packs in phase 2 and simply join the list.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VocabRegistry, DEFAULT_VOCABULARIES, type VocabInstanceSettings } from "../kernel/vocab/registry.js";
import { makeRegistry, DEFAULT_SCHEMES, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { buildSnapshot } from "./snapshot.js";
import { runEngine } from "./engine.js";
import { vocabPack, schemePack } from "./packs/index.js";
import { parseBaseline, renderBaseline, ratchet, type RatchetResult } from "./ratchet.js";
import type { Finding } from "./finding.js";
import type { RulePack } from "./rule-pack.js";

export interface RunOpts {
  root: string;
  baselineText: string;
  vocabularies: VocabInstanceSettings[];
  schemes: SchemeInstanceConfig[];
  excludedRoots?: string[];
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

/** Replace (or append) the ratchet-baseline fence body in a baseline note. */
function writeFence(noteText: string, body: string): string {
  const block = `${FENCE}\n${body}\n\`\`\``;
  if (noteText.includes(FENCE)) {
    return noteText.replace(/```ratchet-baseline\n[\s\S]*?\n```/, block);
  }
  return `${noteText.trimEnd()}\n\n${block}\n`;
}

async function main(argv: string[]): Promise<void> {
  const rebaseline = argv.includes("--rebaseline");
  const rootArg = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
  const root = rootArg ? resolve(rootArg) : discoverRoot(process.cwd());
  const baselinePath = argv.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length) ?? join(root, BASELINE_REL);
  const baselineText = existsSync(baselinePath) ? await readFile(baselinePath, "utf8") : "";

  const res = await runConformance({
    root,
    baselineText,
    vocabularies: DEFAULT_VOCABULARIES,
    schemes: DEFAULT_SCHEMES,
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
