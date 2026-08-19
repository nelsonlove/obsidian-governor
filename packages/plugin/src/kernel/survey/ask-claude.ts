// kernel/survey/ask-claude.ts — headless Claude Code invocation for survey's
// prose step, ported from the vault's own `claude.js` module (subscription
// OAuth billing, not an API key — the same invariant that module documents).
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
// Not Obsidian-free by the strict "no imports" bar the rest of kernel/ holds
// to — it imports `node:child_process` — but it never touches `obsidian`,
// which is the boundary that actually matters (kernel = no Obsidian API, not
// no Node API; kernel/obsidian-probe.ts already carries the one documented
// exception to "no Node API" either way).

import { execFile } from "node:child_process";
import { findClaudeBinary, spawnEnv } from "../../claude-cli.js";

export interface AskOptions {
  model?: string;
  /** REPLACES the default agent system prompt — use for a clean text
   *  transform where the agent's own framing must not leak into the output. */
  system?: string;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
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
export function askClaude(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) {
    return Promise.reject(new Error("askClaude: prompt is required."));
  }

  const bin = findClaudeBinary() ?? "claude";
  const args = ["-p", "--output-format", "json", "--max-turns", String(opts.maxTurns ?? 1)];
  // No tool access in this call shape: survey's prose step is pure
  // text-in/text-out, so the host's dynamic system-prompt context (CLAUDE.md,
  // memory, env — tens of thousands of tokens, billed as cache creation) is
  // excluded, matching claude.js's own default for the no-tools case.
  args.push("--exclude-dynamic-system-prompt-sections");
  if (opts.model) args.push("--model", opts.model);
  if (opts.system) args.push("--system-prompt", opts.system);

  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { env: spawnEnv(), cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(`askClaude: ${error.message}${stderr ? ` — ${String(stderr).slice(0, 300)}` : ""}`));
          return;
        }
        let envelope: ClaudeEnvelope;
        try {
          envelope = JSON.parse(stdout) as ClaudeEnvelope;
        } catch {
          reject(new Error(`askClaude: unparseable CLI output: ${String(stdout).slice(0, 300)}`));
          return;
        }
        if (envelope.is_error) {
          reject(new Error(`askClaude: session error: ${String(envelope.result).slice(0, 300)}`));
          return;
        }
        resolve({
          text: envelope.result ?? "",
          sessionId: envelope.session_id ?? null,
          usage: envelope.usage ?? null,
          costUsd: envelope.total_cost_usd ?? null,
        });
      }
    );
    child.stdin?.write(trimmed);
    child.stdin?.end();
  });
}
