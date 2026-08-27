// THE IN-OBSIDIAN COMMANDS — the human's own way to compile.
//
// The tool (tool.ts) is agent-facing: an MCP client calls it over the host's
// socket. But a human who hand-edits a choice note in Obsidian had no way to
// say "apply that" without asking an agent — the affordance gap Nelson named
// (2026-08-26). These two palette commands close it, over the SAME handler:
// one code path decides what compiles, whoever asks.
//
// Deliberately NOT gesture-gated (unlike the governance perimeter's
// controls): compiling writes ANOTHER PLUGIN'S CONFIG, never vault content
// and never acceptance — the reachability doctrine that governs standing
// does not reach here. The real protection is the tool's own mass-removal
// guard, which refuses a suspicious emptying whoever triggered it.
//
// Pure by construction: this module never imports `obsidian` and never
// touches the DOM. It returns the TEXT a Notice should show; main.ts does
// the showing. So the summary formatting and the refusal paths are testable
// headlessly, which is the half most likely to be wrong.

import type { App } from "obsidian";
import { buildCompileTool } from "./tool.js";

export interface CompileCommand {
  id: string;
  name: string;
  /** Runs the compile and returns what to show the human. Never throws. */
  run(): Promise<CommandOutcome>;
}

export interface CommandOutcome {
  /** Notice text — always says what happened, never just "done". */
  text: string;
  /** True when nothing was applied because something refused or errored. */
  isError: boolean;
  /** How long the Notice should linger (ms) — longer when there is detail to read. */
  durationMs: number;
}

/** `3 added, 1 changed, 2 removed` — omitting the zeroes, because a summary that always shows every axis stops being read. */
function diffSummary(data: Record<string, any>): string {
  const parts: string[] = [];
  for (const axis of ["added", "changed", "removed"] as const) {
    const n = Array.isArray(data[axis]) ? data[axis].length : 0;
    if (n > 0) parts.push(`${n} ${axis}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

/** The per-note error tail: how many, and the first one, so the Notice is actionable without opening a console. */
function errorTail(data: Record<string, any>): string {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  if (errors.length === 0) return "";
  const first = errors[0];
  const where = typeof first?.path === "string" ? `${first.path}: ` : "";
  const what = typeof first?.message === "string" ? first.message : JSON.stringify(first);
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return ` — ${errors.length} note${errors.length === 1 ? "" : "s"} failed. ${where}${what}${more}`;
}

/** A thrown refusal reads `[code] detail`; show it as `code: detail`, which is what a human parses. */
function refusalText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = /^\[([a-z_]+)\]\s*(.*)$/s.exec(raw);
  return m ? `${m[1]}: ${m[2]}` : raw;
}

export function buildCommands(app: App): CompileCommand[] {
  const spec = buildCompileTool(app);

  const compile = async (dryRun: boolean): Promise<CommandOutcome> => {
    try {
      const data = (await spec.handler({ dry_run: dryRun })) as Record<string, any>;
      const summary = diffSummary(data);
      const tail = errorTail(data);
      // `partial: true` is the apiVersion-1 signal that some notes failed
      // while others compiled — the Notice must say so, or a partial compile
      // reads as a clean one (the failure mode this whole program keeps
      // finding: absence rendering as success).
      const partial = data.partial === true;
      if (dryRun) {
        return {
          text: `QuickAdd choices — dry run: ${summary}${tail}` + (partial ? " Nothing was applied (dry run)." : ""),
          isError: partial,
          durationMs: partial ? 12000 : 6000,
        };
      }
      const applied = typeof data.applied === "number" ? data.applied : 0;
      const commandsNote =
        data.commandsRegistered === false
          ? " QuickAdd's command API was unavailable, so palette commands are stale until QuickAdd reloads."
          : "";
      return {
        text: `QuickAdd choices compiled: ${summary} (${applied} choice${applied === 1 ? "" : "s"} now live).${commandsNote}${tail}`,
        isError: partial,
        durationMs: partial || commandsNote ? 12000 : 6000,
      };
    } catch (e) {
      return { text: `QuickAdd choices — refused. ${refusalText(e)}`, isError: true, durationMs: 15000 };
    }
  };

  return [
    {
      id: "compile-dry-run",
      name: "Compile choice notes (dry run — report only)",
      run: () => compile(true),
    },
    {
      id: "compile-apply",
      name: "Compile choice notes (apply to QuickAdd)",
      run: () => compile(false),
    },
  ];
}
