// kernel/survey/ask-claude.ts — headless Claude Code invocation, ported from
// the vault's own `claude.js` module (subscription OAuth billing, not an API
// key — the same invariant that module documents).
//
// Reuses `findClaudeBinary`/`spawnEnv` from ../../claude-cli.ts rather than
// re-probing: that file already solves "Obsidian's GUI process inherits a
// minimal PATH" for this exact binary, and duplicating the probe list would
// let the two drift. Everything below that — building argv, spawning with
// stdin, parsing the JSON envelope — claude-cli.ts has no equivalent of, so
// it's ported here rather than reused (checked before assuming; that file is
// entirely about *registering* vault-mcp with the CLI, not invoking it for a
// text reply).
//
// NOT wired into obsidian_survey_slot (code review on this module's first
// cut caught why): the write-queue's WRITE_TIMEOUT_MS is a hard 30s per
// mutating call, and this function's own default timeout is 120s — a real
// Claude Code round trip plausibly exceeds 30s, so a prose-generating write
// would routinely get abandoned by the queue while the subprocess kept
// running unkilled, and every OTHER mutating tool on the server would queue
// behind it for the full 30s first. askClaude stays a standalone kernel
// utility a caller (a skill, a future bulk-refresh command) can call BEFORE
// obsidian_survey_slot, passing the resulting text in as a plain string —
// keeping a slow, non-deterministic external call outside the serialized,
// time-bounded write path entirely, rather than trying to tune around the
// mismatch.
//
// Bounded by the same "no Obsidian API" bar the rest of kernel/ holds to —
// it imports `node:child_process`, which is a Node API, not an Obsidian one;
// kernel/obsidian-probe.ts is the file that carries kernel's one documented
// *Obsidian*-import exception, a different boundary than this one.
//
// The exec function is injected (`AskExec`) rather than calling `execFile`
// directly, matching tools-fileclass.ts's `FileclassExec` / tools-cli.ts's
// `CliExec` precedent: everything except the live subprocess itself —
// argv construction, JSON-envelope parsing, is_error handling — is
// headless-testable this way.

import { execFile } from "node:child_process";
import { findClaudeBinary, spawnEnv } from "../../claude-cli.js";

export interface AskExecResult {
  stdout: string;
  stderr: string;
}

export type AskExec = (bin: string, args: string[], input: string, opts: { cwd?: string; timeoutMs: number }) => Promise<AskExecResult>;

function defaultExec(bin: string, args: string[], input: string, opts: { cwd?: string; timeoutMs: number }): Promise<AskExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { env: spawnEnv(), cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A nonzero exit WITH stdout still resolves: the CLI's own
        // `is_error` envelope field is the authoritative failure signal,
        // checked by the caller — an execFile error code alone (e.g. from
        // --max-turns exhaustion) must not discard a parseable envelope.
        if (error && !stdout) { reject(error); return; }
        resolve({ stdout, stderr: String(stderr ?? "") });
      }
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

export interface AskOptions {
  model?: string;
  /** REPLACES the default agent system prompt — use for a clean text
   *  transform where the agent's own framing must not leak into the output. */
  system?: string;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  /** Injected for tests; production callers omit this and get defaultExec. */
  exec?: AskExec;
  /** Injected for tests; production callers omit this and get findClaudeBinary(). */
  findBinary?: () => string | null;
}

export interface AskResult {
  text: string;
  sessionId: string | null;
  usage: unknown;
  costUsd: number | null;
}

interface ClaudeEnvelope {
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: unknown;
  total_cost_usd?: number;
}

/**
 * Spawn `claude -p` with `prompt` on stdin, parse the JSON envelope, and
 * resolve to its text. Rejects on a CLI-level error (nonzero exit with no
 * stdout) or a session-level error (`is_error` in an otherwise well-formed
 * envelope) — a caller never has to distinguish "the CLI failed" from "the
 * CLI ran and reported failure," both surface as a rejected promise.
 */
export async function askClaude(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) {
    throw new Error("askClaude: prompt is required.");
  }

  const findBinary = opts.findBinary ?? findClaudeBinary;
  const exec = opts.exec ?? defaultExec;
  const bin = findBinary() ?? "claude";
  const args = ["-p", "--output-format", "json", "--max-turns", String(opts.maxTurns ?? 1)];
  // No tool access in this call shape: pure text-in/text-out, so the host's
  // dynamic system-prompt context (CLAUDE.md, memory, env — tens of
  // thousands of tokens, billed as cache creation) is excluded, matching
  // claude.js's own default for the no-tools case.
  args.push("--exclude-dynamic-system-prompt-sections");
  if (opts.model) args.push("--model", opts.model);
  if (opts.system) args.push("--system-prompt", opts.system);

  let result: AskExecResult;
  try {
    result = await exec(bin, args, trimmed, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 120_000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`askClaude: ${msg}`);
  }

  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(result.stdout) as ClaudeEnvelope;
  } catch {
    throw new Error(`askClaude: unparseable CLI output: ${result.stdout.slice(0, 300)}`);
  }
  if (envelope.is_error) {
    throw new Error(`askClaude: session error: ${String(envelope.result).slice(0, 300)}`);
  }
  return {
    text: envelope.result ?? "",
    sessionId: envelope.session_id ?? null,
    usage: envelope.usage ?? null,
    costUsd: envelope.total_cost_usd ?? null,
  };
}
