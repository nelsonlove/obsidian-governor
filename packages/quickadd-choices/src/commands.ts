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
// WHAT "THE SAME HANDLER" DOES AND DOES NOT MEAN (review of #364): the
// COMPILE logic is identical, but this path calls the handler DIRECTLY,
// while an agent's call arrives wrapped by the host — read-only mode, the
// path-allowlist refusal, the write queue, the journal, and the error
// envelope all live in that wrapper. So under an active allowlist an agent
// is blocked and the human at the keyboard is not. That asymmetry is the
// intent (an allowlist scopes what AGENTS may reach, not what the person
// running Obsidian may do), but it is an asymmetry, and it should be read
// here rather than discovered later.
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
  /**
   * Something went wrong — a refusal, a failure, or a PARTIAL compile (where
   * some notes did apply). Consumed by main.ts, which also logs these to the
   * console so a failure outlives its transient Notice.
   */
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
  // ChoiceError is { notePath, message } (types.ts) — reading `.path` here
  // silently never rendered (review of #364), and the note only stayed
  // visible because transform.ts happens to embed it in the message text.
  const where = typeof first?.notePath === "string" ? `${first.notePath}: ` : "";
  const raw = typeof first?.message === "string" ? first.message : JSON.stringify(first);
  // One long message (a choice-step-target explanation runs ~600 chars) must
  // not turn a Notice into a wall — the full text is in the tool's result.
  const what = raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return ` — ${errors.length} note${errors.length === 1 ? "" : "s"} failed. ${where}${what}${more}`;
}

/** A thrown refusal reads `[code] detail`; show it as `code: detail`, which is what a human parses. */
function refusalText(e: unknown): { text: string; refused: boolean } {
  // String(e) can itself throw (a Symbol.toPrimitive that explodes), and this
  // runs inside the catch that exists to make run() total — so it gets its
  // own guard (review of #364: without it, run() rejected and main.ts's
  // callback had nothing to catch it).
  let raw: string;
  try {
    raw = e instanceof Error ? e.message : String(e);
  } catch {
    raw = "an error that could not be rendered";
  }
  const m = /^\[([a-z_]+)\]\s*(.*)$/s.exec(raw);
  // A `[code]` shape is a REFUSAL — a policy decision, nothing written. Any
  // other throw is a FAILURE, and may well have written something first
  // (saveSettings rejecting after the config object was already replaced).
  // Calling both "refused" would tell the human nothing changed when it may
  // have (review of #364).
  return m ? { text: `${m[1]}: ${m[2]}`, refused: true } : { text: raw, refused: false };
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
          ? " QuickAdd's palette commands could not be updated (its command API was unavailable or failed —" +
            " see the console), so they are stale until QuickAdd reloads."
          : "";
      return {
        text:
          `QuickAdd choices compiled: ${summary} (${applied} compiled choice${applied === 1 ? "" : "s"}; ` +
          `hand-authored choices are untouched).${commandsNote}${tail}`,
        isError: partial,
        durationMs: partial || commandsNote ? 12000 : 6000,
      };
    } catch (e) {
      const { text, refused } = refusalText(e);
      return {
        text: `QuickAdd choices — ${refused ? "refused" : "failed"}. ${text}`,
        isError: true,
        durationMs: 15000,
      };
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
