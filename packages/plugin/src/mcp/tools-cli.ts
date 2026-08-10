// obsidian_cli — proxy to the official Obsidian CLI, closing the breadth gap
// (file history/diff/restore, themes, snippets, plugin install/uninstall,
// publish, …) without hand-writing a native tool per command. The CLI binary
// is Obsidian's single-instance forwarder: it IPCs the command into this very
// Obsidian process, so it only works while Obsidian is running — which is
// guaranteed here, since this plugin *is* Obsidian.
//
// Safety model:
//   - annotations.readOnlyHint: false → read-only mode blocks the tool wholesale
//     (the guard can't know which CLI commands mutate; assume all do).
//   - CLI args can't be path-scoped, so the tool refuses to run while a path
//     allowlist is active — the same policy as unscopable external tools.
//   - Dangerous commands (eval, dev:*, devtools, restart, reload, command,
//     plugins:restrict) are refused unless the "Allow dangerous CLI commands"
//     plugin setting is on. `eval` and `dev:cdp` are full JS execution inside
//     Obsidian's Electron process — the gate defaults off.
//   - The vault is pinned to THIS vault (`vault=<name>` is always the first
//     arg); a caller-supplied vault param is rejected, so a session can never
//     cross into another vault through the proxy.
//   - Accept-forbidden guard (cliAcceptRefusal): the scar "the accept verb goes
//     in no API" is enforced at the MCP note-write primitive, and the CLI proxy
//     would otherwise bypass it. property:set and content writes (create/append/
//     prepend/periodic) are checked with the SAME accepted-family rule before
//     the command runs. quickadd / eval / command run arbitrary macros/code and
//     cannot be inspected — a documented RESIDUAL, not blocked here.

import { z } from "zod";
import { execFile } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, okError, codedError } from "./helpers.js";
import { spawnEnv, findBinary } from "../claude-cli.js";
import type { ServerCtx } from "./tools-core.js";
// Reuse the SAME accepted-family rule the MCP note-write primitive uses — no
// second definition of "accepted" on the CLI path (see cliAcceptRefusal below).
import { acceptForbiddenReason } from "./write-notes-compose.js";

// Mutating + can reach outside the vault (plugin installs fetch the network).
const CLI_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 4 * 1024 * 1024;

// Pure + testable: returns the first existing CLI binary, else null. Probes
// fixed locations (Obsidian's GUI PATH is minimal): the macOS install targets
// plus /usr/bin for Linux packagings. An X_OK probe can't distinguish the CLI
// forwarder from a same-named app launcher (worst case: calls time out) — a
// content probe per connection-build would cost a process spawn, so we accept
// the tradeoff and surface the found path via obsidian_doctor instead.
export function findObsidianBinary(opts?: {
  candidates?: string[];
  fileExists?: (p: string) => boolean;
}): string | null {
  const candidates = opts?.candidates ?? [
    "/usr/local/bin/obsidian",
    "/opt/homebrew/bin/obsidian",
    "/usr/bin/obsidian",
  ];
  return findBinary(candidates, opts?.fileExists);
}

// Commands that execute arbitrary code, restart the app, or weaken the plugin
// sandbox: `command` runs ANY Obsidian command by id; `eval` / `dev:*` are
// JS/CDP access; `plugin:install` loads new third-party code whose onload()
// runs immediately (code-execution-equivalent) and `plugin:uninstall` can
// remove vault-mcp itself out from under every connected session.
const DANGEROUS_EXACT = new Set([
  "eval", "devtools", "restart", "reload", "command",
  "plugins:restrict", "plugin:install", "plugin:uninstall",
]);
export function isDangerousCliCommand(command: string): boolean {
  return DANGEROUS_EXACT.has(command) || command.startsWith("dev:");
}

// Single source for every prose surface that names the gated set (tool
// description, settings toggle) — keep in sync with DANGEROUS_EXACT + `dev:*`.
export const DANGEROUS_LIST_DESC = [...DANGEROUS_EXACT].sort().join(", ") + ", and dev:*";

// ── accept-forbidden guard on the CLI path ────────────────────────────────────
//
// The scar "the accept verb goes in no API" is enforced at the MCP note-write
// primitive (write-notes-compose.ts / obsidian-backend.ts). obsidian_cli proxies
// ~104 CLI commands straight past that primitive, so acceptance could be written
// through the CLI: `property:set name=acceptance-status value=accepted`, or a
// create/append/prepend whose content carries an `accepted` frontmatter fence.
// We reuse the SAME rule (`acceptForbiddenReason`, over the same deep
// accepted-family detector) here, BEFORE the command runs — no second definition
// of "accepted". A CLI property set / content write is always an INTRODUCE (the
// CLI path has no "carry an existing human-granted value forward" expression),
// so the introduce check is exactly right.
//
// RESIDUAL — flagged for a policy decision, connects to the board item
// "obsidian_cli / run_command needs an allowlist/denylist": `quickadd` /
// `quickadd:run` run arbitrary QuickAdd macros, and `eval` / `command` run
// arbitrary code (already behind the danger gate). A macro/script can set
// acceptance opaquely and CANNOT be inspected pre-exec. We deliberately do NOT
// block quickadd — that would break legitimate macro use — so the residual is
// documented here and named in the tool description, not silently closed. A
// `create template=<t>` also draws frontmatter from a template note we cannot
// read pre-exec; a lesser residual, same class.

// property:set family — sets one property (documented `name=<prop> value=<val>`)
// or, in shorthand, direct key=value params. `frontmatter:` alias included
// defensively; get/list/remove are not introduces and are not matched.
const PROPERTY_SET_RE = /^(?:property|frontmatter):(?:set|add|update|patch)$/;

// content-writing family — create/append/prepend and the periodic-note variants.
// `content=` carries the body (and any frontmatter fence).
const CONTENT_WRITE_RE =
  /^(?:create|append|prepend|(?:daily|weekly|monthly|quarterly|yearly):(?:create|append|prepend))$/;

// Arbitrary-macro / code-execution commands that can set acceptance opaquely.
// Named for the tool description + report — NOT blocked here (eval/command are
// already behind the danger gate; quickadd is the live residual).
export const CLI_OPAQUE_ACCEPT_RESIDUAL = ["command", "eval", "quickadd", "quickadd:run"];

/**
 * The reason a CLI invocation would introduce acceptance, or null when it is
 * clean. Reuses the shared accepted-family rule (`acceptForbiddenReason`) — no
 * fork of "accepted". Covers property sets (the property + value the call names)
 * and content writes (any acceptance-asserting frontmatter fence in the written
 * content). Every unrelated command is clean, so legitimate CLI use is untouched.
 */
export function cliAcceptRefusal(
  command: string,
  params: Record<string, string | number | boolean> | undefined,
  parseYaml?: (yaml: string) => unknown
): string | null {
  const cmd = command.trim();

  if (PROPERTY_SET_RE.test(cmd)) {
    // Both param shapes at once: the documented `name=<prop> value=<val>` form
    // (synthesize {prop: val}) AND a direct `acceptance-status=accepted`
    // shorthand (every param keyed as itself). Structural keys (file/path/name/
    // value/type/silent) are not accepted-family, so they never false-positive —
    // e.g. `property:set name=status value=accepted` is a property literally
    // called "status", NOT the acceptance field, and is allowed, matching the
    // MCP write path (which keys only on acceptance-status / accepted-*).
    const fm: Record<string, unknown> = { ...(params ?? {}) };
    if (typeof params?.name === "string") fm[params.name] = params.value;
    return acceptForbiddenReason(fm);
  }

  if (CONTENT_WRITE_RE.test(cmd)) {
    const content = params?.content;
    if (typeof content !== "string" || content.length === 0) return null;
    const reason = contentAcceptRefusal(content, parseYaml);
    return reason ? `content ${reason}` : null;
  }

  return null;
}

/**
 * Scan written content for an acceptance-asserting frontmatter fence. The CLI
 * interprets `\n`/`\t` escapes in a param value, so they are expanded first — an
 * escaped fence must not slip the scan. Every `---`-delimited YAML block (leading
 * or embedded) is parsed and checked with the shared rule. `append` content is
 * not a note's leading frontmatter, but the resulting note cannot be read
 * pre-exec, so acceptance-carrying content is blocked conservatively — nobody
 * legitimately writes an accepted acceptance fence into a body. With no parser
 * injected, we fail CLOSED on any fence at all (defensive; production always
 * injects obsidian.parseYaml).
 */
function contentAcceptRefusal(content: string, parseYaml?: (yaml: string) => unknown): string | null {
  const expanded = content
    .replace(/\\r\\n|\\n/g, "\n") // literal \n (and \r\n) escapes the CLI expands
    .replace(/\\t/g, "\t") // literal \t escapes
    .replace(/\r\n?/g, "\n"); // real CR / CRLF
  const fenceRe = /(?:^|\n)---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/g;
  let m: RegExpExecArray | null;
  let sawFence = false;
  while ((m = fenceRe.exec(expanded)) !== null) {
    sawFence = true;
    if (!parseYaml) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(m[1]);
    } catch {
      // A fence a real parser cannot read: cannot assert acceptance structurally,
      // but treat one that mentions the acceptance field textually as suspect
      // rather than let it through.
      if (/acceptance[-_]status/i.test(m[1]) && /\baccepted\b|accepted[-_]/i.test(m[1])) {
        return "carries an accepted acceptance-status fence";
      }
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const reason = acceptForbiddenReason(parsed as Record<string, unknown>);
      if (reason) return reason;
    }
  }
  return sawFence && !parseYaml
    ? "carries a frontmatter fence that cannot be verified without a YAML parser"
    : null;
}

// Lowercase-only ON PURPOSE: the CLI's commands are all lowercase, and a
// case-insensitive accept here would let 'Eval' slip past the case-sensitive
// danger gate above while (potentially) still resolving in the CLI.
const COMMAND_RE = /^[a-z][a-z0-9:_-]*$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_-]*$/i;
const FLAG_RE = /^--?[a-z][a-z0-9:_-]*(=.*)?$/i;

// Pure + testable: argv for `obsidian vault=<name> <command> key=value… --flag…`.
// Throws on structurally invalid input; execFile makes injection impossible,
// so these checks are about surfacing mistakes early, not shell safety.
export function buildCliArgs(opts: {
  vaultName: string;
  command: string;
  params?: Record<string, string | number | boolean>;
  flags?: string[];
}): string[] {
  const command = opts.command.trim();
  if (!COMMAND_RE.test(command)) throw new Error(`invalid command name: '${opts.command}'`);
  const args = [`vault=${opts.vaultName}`, command];
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (!PARAM_KEY_RE.test(key)) throw new Error(`invalid param key: '${key}'`);
    if (key.toLowerCase() === "vault")
      throw new Error("the vault is pinned to this vault by the plugin; a vault param is not allowed");
    args.push(`${key}=${String(value)}`);
  }
  for (const flag of opts.flags ?? []) {
    if (!FLAG_RE.test(flag)) throw new Error(`invalid flag (must look like -x or --flag[=value]): '${flag}'`);
    args.push(flag);
  }
  return args;
}

// execFile shaped for injection in tests. Node's execFile error carries the
// child's stdout/stderr and exit code; normalize both outcomes to one shape.
export interface CliExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorMessage?: string;
}
export type CliExec = (bin: string, args: string[], timeoutMs: number) => Promise<CliExecResult>;

const defaultExec: CliExec = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env: spawnEnv(), timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false });
          return;
        }
        const anyErr = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({
          exitCode: typeof anyErr.code === "number" ? anyErr.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut: anyErr.killed === true,
          errorMessage: typeof anyErr.code === "number" ? undefined : anyErr.message,
        });
      }
    );
  });

export function registerCliTools(
  server: McpServer,
  ctx: ServerCtx,
  deps?: { binary?: string | null; exec?: CliExec; parseYaml?: (yaml: string) => unknown }
) {
  // Conditional registration at build time is the dynamic-registration
  // mechanism (same as integration tools): no binary → no tool this session.
  const binary = deps?.binary !== undefined ? deps.binary : findObsidianBinary();
  if (!binary) return;
  const exec = deps?.exec ?? defaultExec;
  // Injected so this module stays obsidian-free (obsidian is types-only in node,
  // and the CLI handler is unit-tested). Production wires obsidian.parseYaml from
  // server.ts; the accept guard's content-fence scan needs a real YAML parser.
  const parseYaml = deps?.parseYaml;

  server.registerTool(
    "obsidian_cli",
    {
      title: "Run an official Obsidian CLI command",
      description:
        "Run any official Obsidian CLI command against this vault (the vault is pinned; a vault param is rejected). " +
        "Covers everything the CLI exposes that has no dedicated obsidian_* tool: file history (history, history:list, history:restore, diff), " +
        "themes (themes, theme:set, theme:install), snippets, plugin management (plugin:install, plugin:uninstall), bases, publish, and more. " +
        "Discover commands with {command:'help'}; get a command's parameters with {command:'help', params:{command:'<name>'}}. " +
        "Params become key=value CLI arguments; flags are passed verbatim (e.g. ['--json']). " +
        "Output is the CLI's raw stdout/stderr plus exit_code — non-zero exits return isError with the same structure. " +
        "Requires the Obsidian CLI feature (Settings → General → Command line interface). " +
        `Dangerous commands (${DANGEROUS_LIST_DESC}) are blocked unless enabled in plugin settings. ` +
        "Acceptance is human-only: a property:set or content write that would introduce acceptance-status: accepted (or accepted-by/accepted-on) is refused with Error [accept_forbidden] — agents write only acceptance-status: proposed. " +
        "On timeout, the command may still have completed inside Obsidian (only the CLI forwarder is killed) — verify state before retrying a mutation. " +
        "Prefer a dedicated obsidian_* tool when one exists — those return structured data.",
      inputSchema: {
        command: z.string().min(1).describe("CLI command name, e.g. 'help', 'history:list', 'theme:set'."),
        params: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("key=value arguments, e.g. {file: 'Inbox/Note.md'}. 'vault' is not allowed (pinned)."),
        flags: z.array(z.string()).optional().describe("Verbatim flags, e.g. ['--json']."),
        timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
          .describe(`Time budget for the command (default ${DEFAULT_TIMEOUT_MS}).`),
      },
      annotations: CLI_ANNOTATIONS,
    },
    async (args: { command: string; params?: Record<string, string | number | boolean>; flags?: string[]; timeout_ms?: number }) => {
      try {
        const settings = ctx.getSettings();
        if (settings.allowlist.length > 0) {
          return fail(
            "obsidian_cli is disabled while a path allowlist is active: CLI arguments cannot be path-scoped, so the allowlist cannot be enforced on them."
          );
        }
        const command = args.command.trim();
        if (isDangerousCliCommand(command) && !settings.allowDangerousCli) {
          return fail(
            `CLI command '${command}' is dangerous (code execution / app control) and is blocked. Enable "Allow dangerous CLI commands" in the vault-mcp settings to permit it.`
          );
        }
        // Accept-forbidden guard — the scar "the accept verb goes in no API",
        // enforced on the CLI path with the SAME accepted-family rule as the MCP
        // write primitive. Refused BEFORE the command runs, so nothing executes.
        const acceptReason = cliAcceptRefusal(command, args.params, parseYaml);
        if (acceptReason) {
          return codedError(
            "accept_forbidden",
            `${acceptReason}. Acceptance is a human gesture, in no API — the CLI proxy will not persist it. ` +
              `Agents write only acceptance-status: proposed; never accepted / accepted-by / accepted-on.`
          );
        }
        const argv = buildCliArgs({ vaultName: ctx.vaultName, command, params: args.params, flags: args.flags });
        const started = Date.now();
        const res = await exec(binary, argv, args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
        const report = {
          command,
          argv,
          exit_code: res.exitCode,
          timed_out: res.timedOut,
          duration_ms: Date.now() - started,
          stdout: res.stdout,
          stderr: res.stderr,
          ...(res.errorMessage ? { error: res.errorMessage } : {}),
          // The CLI binary is a forwarder into the running Obsidian; killing it
          // on timeout does NOT cancel the in-app command.
          ...(res.timedOut
            ? { note: "the command may still have completed inside Obsidian — verify state before retrying" }
            : {}),
        };
        // Non-zero exit: keep the structured report (stdout often carries the
        // CLI's own diagnostic) but flag the call as an error.
        return res.exitCode === 0 ? ok(report) : okError(report);
      } catch (e) {
        return fail(e);
      }
    }
  );
}
