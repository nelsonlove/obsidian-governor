// tools-fileclass.ts — the `fileclass` module's tool surface, folded into
// vault-mcp from the standalone `fileclass` CLI
// (github.com/mdelobelle/fileclass-cli, the terminal for the Fileclass Obsidian
// plugin — a typed-frontmatter / fileClass engine, the successor to Metadata
// Menu). Eight tools:
//
//   READ (readOnlyHint: true)
//     fileclass_list      — every fileClass                       (`fileclasses`)
//     fileclass_schema    — a fileClass's options + resolved fields (`schema <name>`)
//     fileclass_explain   — a note's fileClasses + field values   (`explain <path>`)
//     fileclass_query     — rows for a fileClass, filtered        (`list <class> --where …`)
//     fileclass_get       — one field's value on a note           (`get <path> <field>`)
//     fileclass_validate  — schema violations (exit 1 on violation) (`validate`)
//
//   WRITE (readOnlyHint: false, guarded)
//     fileclass_set       — validated single-note field write     (`set <path> <field> <value>`)
//     fileclass_set_where — validated bulk write; DRY-RUN by default (`set-where <class> <field> <value>`)
//
// ── Proxy, not engine-integration (the design choice) ────────────────────────
//
// This module SHELLS OUT to the `fileclass` CLI binary via execFile — the exact
// obsidian_cli precedent (tools-cli.ts). Rationale:
//   • The fileClass engine is the Fileclass PLUGIN's internal, unexported
//     machinery; the CLI is the plugin author's OWN supported terminal for it,
//     driving the LIVE plugin through Obsidian's `obsidian eval`, so results
//     have full engine fidelity (validation, Bases queries, inheritance) that a
//     re-implementation over the metadata cache could not match.
//   • The proxy keeps this module Obsidian-free and headless-testable: `execFile`
//     is injected (like tools-cli.ts), so arg construction, --json parsing, the
//     accept-guard refusal and the dry-run gate are all unit-tested; only the
//     live subprocess + the plugin-presence probe are un-headless (verified by
//     build + reasoning — see the module doc / PR).
// The plugin's public `app.plugins.plugins.fileclass.api` was the alternative
// (call the API directly). It would avoid a subprocess but couple the tool layer
// to `app` (breaking the module's Obsidian-free contract and its headless tests),
// and re-derive the CLI's argument/JSON surface by hand. The proxy is the
// documented default (issue #188) and is what this module implements.
//
// ── Accept boundary (load-bearing) ───────────────────────────────────────────
//
// `fileclass_set` / `fileclass_set_where` write typed frontmatter, so they MUST
// route through the plugin's accept-forbidden guard like every other vault
// write: a fileclass field-write can NEVER introduce or change an `accepted` /
// `accepted-by` / `accepted-on` field, nor set `acceptance-status` to an
// accepted value. Acceptance is a human gesture only, in no API. The write goes
// out through the CLI (not ObsidianBackend's write primitive), so — exactly as
// tools-cli.ts does for the obsidian CLI — the SAME `acceptForbiddenReason` rule
// (@vault-mcp/core) is applied HERE, before the command runs, over the
// `{ [field]: value }` the call would write (`fileclassSetAcceptRefusal` below).
// This is the correct gating point issue #105 asks for on the fileclass
// field-write surface. Both write tools register `readOnlyHint: false`, so they
// ALSO ride the guard-patched registrar (read-only mode, path allowlist on the
// `path` arg, serialized queue, journal, if_rev / idempotency) like every other
// mutating tool.
//
// This module contributes NO accept/approve verb (the ModuleRegistry name
// tripwire refuses those regardless).

import { z } from "zod";
import { execFile } from "node:child_process";
import * as os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, okError, codedError } from "./helpers.js";
import { acceptForbiddenReason } from "@vault-mcp/core";
import { spawnEnv, findBinary } from "../claude-cli.js";
import { findObsidianBinary } from "./tools-cli.js";
import type { GuardSettings } from "../guard.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
// Mutating; not destructive-by-default (a single validated field write), but a
// set-where --apply can touch many notes — the dry-run default is the safety.
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 4 * 1024 * 1024;

// The fileclass CLI id / plugin id. The Fileclass plugin's manifest declares
// `"id": "fileclass"`, and the CLI installs as the `fileclass` command.
export const FILECLASS_PLUGIN_ID = "fileclass";

/**
 * Locate the `fileclass` CLI binary, or null. Probes the standard install
 * targets the CLI's own docs prescribe (npm-global / user bin / Homebrew /
 * system), since Obsidian's GUI PATH is minimal. Pure + testable: `fileExists`
 * and `homedir` are injectable. An explicit config `binaryPath` (resolved by
 * the registrar) always wins over this probe.
 */
export function findFileclassBinary(opts?: {
  candidates?: string[];
  fileExists?: (p: string) => boolean;
  homedir?: string;
}): string | null {
  const home = opts?.homedir ?? os.homedir();
  const candidates =
    opts?.candidates ?? [
      "/usr/local/bin/fileclass",
      "/opt/homebrew/bin/fileclass",
      `${home}/.local/bin/fileclass`,
      `${home}/.npm-global/bin/fileclass`,
      "/usr/bin/fileclass",
    ];
  return findBinary(candidates, opts?.fileExists);
}

// ── accept-forbidden guard on the fileclass field-write path ──────────────────
//
// A fileclass `set` / `set-where` writes ONE field to a value. That reduces to
// the same `{ [field]: value }` frontmatter shape the shared accepted-family
// rule already decides over (`acceptForbiddenReason` — the exact rule the MCP
// write primitive and the obsidian_cli `property:set` path reuse; no second
// definition of "accepted"). It refuses:
//   • an accepted-family KEY (`accepted` / `accepted-by` / `accepted-on`), or
//   • the `acceptance-status` field set to an accepted VALUE.
// A property literally named `status`, or `acceptance-status: proposed`, is
// allowed — matching every other accept-guard surface. This is a WRITE (always
// an introduce on the CLI path — there is no "carry an existing human-granted
// value forward" expression), so `acceptForbiddenReason`'s introduce check is
// exactly right.
/**
 * The reason a fileclass field-write would introduce acceptance, or null when it
 * is clean. `value` is coerced to a string first (the CLI is handed a string),
 * so a numeric/boolean field value can never dodge the check by type.
 */
export function fileclassSetAcceptRefusal(field: string, value: string | number | boolean): string | null {
  return acceptForbiddenReason({ [field]: String(value) });
}

// ── CLI arg construction (pure + testable) ────────────────────────────────────

/** A fileclass subcommand + its positionals + optional flags. `--vault <name>`
 * and `--json` are appended by `buildFileclassArgs`, so the vault is always
 * pinned to THIS vault (a session can never cross into another vault) and every
 * command is machine-readable. */
export interface FileclassCommand {
  command: string;
  positionals?: string[];
  where?: string;
  columns?: string;
  limit?: number;
  fileclass?: string;
  apply?: boolean;
}

// Subcommand names the module issues — closed set, lowercase, so nothing
// caller-derived reaches argv as a command.
const KNOWN_COMMANDS = new Set(["fileclasses", "schema", "explain", "list", "get", "validate", "set", "set-where"]);

/**
 * Argv for `fileclass <command> [positionals…] [--flags…] --vault <name> --json`.
 * execFile makes shell injection impossible (each element is a distinct argv
 * entry), so these checks surface programming mistakes, not shell safety. The
 * vault is pinned LAST via `--vault <name>` (fileclass precedence:
 * `--vault` > FILECLASS_VAULT > persisted default > active vault), so it always
 * wins; a positional or flag can never redirect the target vault.
 */
export function buildFileclassArgs(vaultName: string, cmd: FileclassCommand): string[] {
  const command = cmd.command.trim();
  if (!KNOWN_COMMANDS.has(command)) throw new Error(`unknown fileclass command: '${cmd.command}'`);
  const args: string[] = [command, ...(cmd.positionals ?? [])];
  if (cmd.where !== undefined && cmd.where !== "") args.push("--where", cmd.where);
  if (cmd.columns !== undefined && cmd.columns !== "") args.push("--columns", cmd.columns);
  if (cmd.limit !== undefined) args.push("--limit", String(cmd.limit));
  if (cmd.fileclass !== undefined && cmd.fileclass !== "") args.push("--fileclass", cmd.fileclass);
  if (cmd.apply === true) args.push("--apply");
  args.push("--vault", vaultName, "--json");
  return args;
}

// ── exec seam (injected for tests, like tools-cli.ts's CliExec) ───────────────

export interface FileclassExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorMessage?: string;
}
export type FileclassExec = (bin: string, args: string[], timeoutMs: number) => Promise<FileclassExecResult>;

/** The production exec: execFile with an augmented env. `FILECLASS_QUIET=1`
 * silences the CLI's `vault:` stderr line; `OBSIDIAN_BIN` points the CLI at the
 * obsidian binary (its `obsidian eval` bridge) when one was found, since
 * Obsidian's GUI PATH is minimal. spawnEnv augments PATH the same way the other
 * spawn sites do. */
function makeDefaultExec(obsidianBin: string | null): FileclassExec {
  return (bin, args, timeoutMs) =>
    new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...spawnEnv(), FILECLASS_QUIET: "1" };
      if (obsidianBin) env.OBSIDIAN_BIN = obsidianBin;
      execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
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
      });
    });
}

// ── the report shaper ─────────────────────────────────────────────────────────

/** Parse the CLI's --json stdout into structured data, falling back to raw text
 * when it is not JSON (a diagnostic the CLI printed plainly). */
function parseJsonOut(stdout: string): { data?: unknown; raw?: string } {
  const trimmed = stdout.trim();
  if (trimmed === "") return {};
  try {
    return { data: JSON.parse(trimmed) };
  } catch {
    return { raw: stdout };
  }
}

export interface FileclassToolsCtx {
  /** The merged `modules.fileclass.config` (defaults ∪ user override). Carries
   * the optional `binaryPath`. */
  config: Record<string, unknown>;
  /** The guard's settings — for the allowlist refusal (the CLI output cannot be
   * path-scoped, so fileclass tools refuse while an allowlist is active, the
   * obsidian_cli / Dataview precedent). */
  getSettings: () => GuardSettings;
  /** This vault's name, pinned into every CLI call via `--vault`. */
  vaultName: string;
  /** Whether the Fileclass plugin is LOADED (`app.plugins.plugins.fileclass`).
   * The gate: no plugin ⇒ no tools this session. */
  present: () => boolean;
  /** Injected exec (tests). Absent ⇒ the production execFile. */
  exec?: FileclassExec;
  /** Injected binary (tests) or an explicit override. `undefined` ⇒ resolve from
   * config.binaryPath, else probe the filesystem; `null` ⇒ no binary. */
  binary?: string | null;
  /** Injected obsidian-binary resolver result (tests). Absent ⇒ probe. */
  obsidianBinary?: string | null;
}

/** fileclass tools are disabled while a path allowlist is active: the CLI runs
 * over the whole vault through its engine and its output cannot be path-scoped,
 * so — like obsidian_cli and the Dataview query tools — the whole surface
 * refuses rather than return an unenforceably-partial answer. */
function allowlistRefusal(settings: GuardSettings): { code: string; message: string } | null {
  if (settings.allowlist && settings.allowlist.length > 0) {
    return {
      code: "out_of_allowlist",
      message:
        "fileclass tools are disabled while a path allowlist is active: the fileclass CLI runs over the whole vault " +
        "through its engine, so its output cannot be path-scoped to the allowlist.",
    };
  }
  return null;
}

/**
 * Register the eight fileclass tools — gated on the Fileclass plugin being
 * LOADED and the CLI binary being present. Conditional registration at build
 * time is the plugin's dynamic-registration mechanism (a fresh server per
 * connection), so a session that connects with the plugin/binary absent simply
 * has no fileclass tools — the module degrades cleanly to absent.
 */
export function registerFileclassTools(server: McpServer, ctx: FileclassToolsCtx): void {
  // Plugin-presence gate: the LOADED instance (app.plugins.plugins[id]), not
  // enabledPlugins — a configured-but-uninstalled plugin lingers there.
  if (!ctx.present()) return;
  // Binary gate: config.binaryPath wins, else probe the filesystem.
  const configBin = typeof ctx.config?.binaryPath === "string" && ctx.config.binaryPath.trim() ? ctx.config.binaryPath.trim() : null;
  const binary = ctx.binary !== undefined ? ctx.binary : configBin ?? findFileclassBinary();
  if (!binary) return;

  const obsidianBin = ctx.obsidianBinary !== undefined ? ctx.obsidianBinary : findObsidianBinary();
  const exec = ctx.exec ?? makeDefaultExec(obsidianBin);

  /** Run a fileclass command and shape the report. `validateExit` lets
   * `fileclass_validate` treat exit 1 (violations found) as a successful run
   * (not a tool error) while every other command flags a non-zero exit. */
  const run = async (cmd: FileclassCommand, timeoutMs: number, opts?: { okExitCodes?: number[] }) => {
    const argv = buildFileclassArgs(ctx.vaultName, cmd);
    const started = Date.now();
    const res = await exec(binary, argv, timeoutMs);
    const parsed = parseJsonOut(res.stdout);
    const okExit = opts?.okExitCodes ?? [0];
    const succeeded = res.exitCode !== null && okExit.includes(res.exitCode);
    const report = {
      command: cmd.command,
      argv,
      exit_code: res.exitCode,
      timed_out: res.timedOut,
      duration_ms: Date.now() - started,
      ...(parsed.data !== undefined ? { result: parsed.data } : {}),
      ...(parsed.raw !== undefined ? { stdout: parsed.raw } : {}),
      ...(res.stderr ? { stderr: res.stderr } : {}),
      ...(res.errorMessage ? { error: res.errorMessage } : {}),
      ...(res.timedOut
        ? { note: "the fileclass CLI forwards into the running Obsidian; killing it on timeout does not cancel an in-app write — verify state before retrying" }
        : {}),
    };
    return succeeded ? ok(report) : okError(report);
  };

  const timeoutSchema = z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Time budget for the command (default ${DEFAULT_TIMEOUT_MS}).`);

  // ── fileclass_list ─────────────────────────────────────────────────────────
  server.registerTool(
    "fileclass_list",
    {
      title: "List every fileClass",
      description:
        "List every fileClass defined in the vault (name, extends, field count, whether it has a Base view). " +
        "Proxies the Fileclass CLI `fileclasses --json`. Read-only. Disabled while a path allowlist is active.",
      inputSchema: { timeout_ms: timeoutSchema },
      annotations: RO,
    },
    async ({ timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      return run({ command: "fileclasses" }, timeout_ms ?? DEFAULT_TIMEOUT_MS);
    }
  );

  // ── fileclass_schema ───────────────────────────────────────────────────────
  server.registerTool(
    "fileclass_schema",
    {
      title: "A fileClass's schema",
      description:
        "Return a fileClass's options and resolved fields (with ancestry from extends). " +
        "Proxies the Fileclass CLI `schema <name> --json`. Read-only. Disabled while a path allowlist is active.",
      inputSchema: {
        fileclass: z.string().min(1).describe("FileClass name, e.g. 'Book'."),
        timeout_ms: timeoutSchema,
      },
      annotations: RO,
    },
    async ({ fileclass, timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      return run({ command: "schema", positionals: [fileclass] }, timeout_ms ?? DEFAULT_TIMEOUT_MS);
    }
  );

  // ── fileclass_explain ──────────────────────────────────────────────────────
  server.registerTool(
    "fileclass_explain",
    {
      title: "Explain a note's fileClasses",
      description:
        "Explain a note: its fileClasses, ancestry, and resolved field values. " +
        "Proxies the Fileclass CLI `explain <path> --json`. Read-only. Disabled while a path allowlist is active.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path, e.g. 'Books/Dune.md'."),
        timeout_ms: timeoutSchema,
      },
      annotations: RO,
    },
    async ({ path: p, timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      return run({ command: "explain", positionals: [p] }, timeout_ms ?? DEFAULT_TIMEOUT_MS);
    }
  );

  // ── fileclass_query ────────────────────────────────────────────────────────
  server.registerTool(
    "fileclass_query",
    {
      title: "Query notes of a fileClass",
      description:
        "List rows for a fileClass, optionally filtered/columned/limited. " +
        "Proxies the Fileclass CLI `list <class> [--where …] [--columns …] [--limit …] --json`. " +
        "Read-only. Disabled while a path allowlist is active.",
      inputSchema: {
        fileclass: z.string().min(1).describe("FileClass name, e.g. 'Book'."),
        where: z.string().optional().describe("Filter expression, e.g. 'status is unread'."),
        columns: z.string().optional().describe("Comma-separated columns, e.g. 'title,author'."),
        limit: z.number().int().min(1).optional().describe("Maximum rows to return."),
        timeout_ms: timeoutSchema,
      },
      annotations: RO,
    },
    async ({ fileclass, where, columns, limit, timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      return run({ command: "list", positionals: [fileclass], where, columns, limit }, timeout_ms ?? DEFAULT_TIMEOUT_MS);
    }
  );

  // ── fileclass_get ──────────────────────────────────────────────────────────
  server.registerTool(
    "fileclass_get",
    {
      title: "Get a field value on a note",
      description:
        "Get one field's value on a note. " +
        "Proxies the Fileclass CLI `get <path> <field> --json`. Read-only. Disabled while a path allowlist is active.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path."),
        field: z.string().min(1).describe("Field name."),
        timeout_ms: timeoutSchema,
      },
      annotations: RO,
    },
    async ({ path: p, field, timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      return run({ command: "get", positionals: [p, field] }, timeout_ms ?? DEFAULT_TIMEOUT_MS);
    }
  );

  // ── fileclass_validate ─────────────────────────────────────────────────────
  server.registerTool(
    "fileclass_validate",
    {
      title: "Validate typed frontmatter",
      description:
        "Report schema violations (missing required fields, wrong types) across the vault or one fileClass. " +
        "Proxies the Fileclass CLI `validate [--fileclass <name>] --json`. The CLI exits 1 when it finds a " +
        "violation (CI-friendly); this tool treats that as a successful run and returns the violations, not a tool " +
        "error. Read-only. Disabled while a path allowlist is active.",
      inputSchema: {
        fileclass: z.string().optional().describe("Restrict validation to one fileClass, e.g. 'Book'."),
        timeout_ms: timeoutSchema,
      },
      annotations: RO,
    },
    async ({ fileclass, timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      // exit 1 = violations found (a successful run, not a tool failure).
      return run({ command: "validate", fileclass }, timeout_ms ?? DEFAULT_TIMEOUT_MS, { okExitCodes: [0, 1] });
    }
  );

  // ── fileclass_set (guarded write) ──────────────────────────────────────────
  server.registerTool(
    "fileclass_set",
    {
      title: "Set a validated field on a note",
      description:
        "Write one validated field value on a note (the fileClass engine validates before writing and refuses an " +
        "invalid value). Proxies the Fileclass CLI `set <path> <field> <value> --json`. " +
        "Acceptance is human-only: a field-write that would introduce acceptance-status: accepted (or " +
        "accepted-by / accepted-on) is refused with Error [accept_forbidden] — agents write only " +
        "acceptance-status: proposed. Routes through the guarded write path (read-only mode, path allowlist on " +
        "the note path, serialized queue, journal, if_rev/idempotency). Disabled while a path allowlist is active.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path."),
        field: z.string().min(1).describe("Field name."),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set (passed to the CLI as a string)."),
        timeout_ms: timeoutSchema,
      },
      annotations: RW,
    },
    async ({ path: p, field, value, timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      const acceptReason = fileclassSetAcceptRefusal(field, value);
      if (acceptReason) {
        return codedError(
          "accept_forbidden",
          `${acceptReason}. Acceptance is a human gesture, in no API — the fileclass proxy will not persist it. ` +
            `Agents write only acceptance-status: proposed; never accepted / accepted-by / accepted-on.`
        );
      }
      return run({ command: "set", positionals: [p, field, String(value)] }, timeout_ms ?? DEFAULT_TIMEOUT_MS);
    }
  );

  // ── fileclass_set_where (guarded bulk write; dry-run by default) ────────────
  server.registerTool(
    "fileclass_set_where",
    {
      title: "Bulk-set a field (dry-run by default)",
      description:
        "Set a validated field on every note of a fileClass matching an optional filter. " +
        "DRY-RUN BY DEFAULT — reports what would change and writes nothing; pass apply: true to commit. " +
        "Proxies the Fileclass CLI `set-where <class> <field> <value> [--where …] [--apply] --json`. " +
        "Acceptance is human-only: a field-write that would introduce acceptance-status: accepted (or " +
        "accepted-by / accepted-on) is refused with Error [accept_forbidden]. When apply: true, routes through the " +
        "guarded write path (read-only mode, serialized queue, journal, if_rev/idempotency). " +
        "Disabled while a path allowlist is active.",
      inputSchema: {
        fileclass: z.string().min(1).describe("FileClass name, e.g. 'Book'."),
        field: z.string().min(1).describe("Field name."),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set (passed to the CLI as a string)."),
        where: z.string().optional().describe("Filter expression, e.g. 'status isEmpty'."),
        apply: z.boolean().optional().describe("Commit the change. Omit/false ⇒ dry-run (report only, write nothing)."),
        timeout_ms: timeoutSchema,
      },
      annotations: RW,
    },
    async ({ fileclass, field, value, where, apply, timeout_ms }) => {
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);
      const acceptReason = fileclassSetAcceptRefusal(field, value);
      if (acceptReason) {
        return codedError(
          "accept_forbidden",
          `${acceptReason}. Acceptance is a human gesture, in no API — the fileclass proxy will not persist it. ` +
            `Agents write only acceptance-status: proposed; never accepted / accepted-by / accepted-on.`
        );
      }
      return run(
        { command: "set-where", positionals: [fileclass, field, String(value)], where, apply: apply === true },
        timeout_ms ?? DEFAULT_TIMEOUT_MS
      );
    }
  );
}
