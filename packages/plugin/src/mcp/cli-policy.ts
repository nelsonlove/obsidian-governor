// cli-policy.ts — the settings-driven command allow/deny policy for the two
// arbitrary-execution surfaces, closing the accept-scar's last residual.
//
// The accept-forbidden guard (write-notes-compose.ts, cliAcceptRefusal) covers
// every INSPECTABLE write: MCP primitives, CLI property sets, CLI content
// writes. What it cannot cover is opaque execution — `quickadd` macros, `eval`,
// `command`, and `obsidian_run_command` ids — where acceptance could be set
// inside code the guard never sees. Until now that was a documented residual;
// this module closes it by FAILING CLOSED: the opaque-accept set is DENIED by
// default, and re-enabling a specific command is a HUMAN-ONLY act (a plugin
// setting, reachable through the Obsidian settings tab / data.json). The
// human-only property is enforced, not assumed: the MCP write primitives
// refuse non-`.md` paths structurally; the opaque surfaces that could write
// settings from inside (`eval`/`command`/quickadd macros) are what this
// policy denies by default; and the CLI proxy's own param values are barred
// from `.obsidian` territory by `configPathRefusal` below, so the inspectable
// CLI write commands cannot target data.json either — whatever the external
// binary's path handling turns out to be.
//
// Policy semantics, in evaluation order:
//   1. `deny` (settings) — always refused. Deny BEATS allow: a command both
//      denied and re-enabled is refused, so a hand-edited data.json cannot be
//      talked into a contradictory state that fails open.
//   2. The built-in opaque-accept set — refused unless the human re-enabled
//      that specific entry via `allowOpaque`.
//   3. Everything else — allowed by this policy (the existing danger gate and
//      accept guard still apply downstream; this policy COMPOSES with them,
//      it replaces nothing. `eval`/`command` re-enabled here still need the
//      "Allow dangerous CLI commands" toggle — two locks, both human).
//
// Entries are exact command names, or prefix globs written `prefix*` (used as
// `quickadd:*` for run_command ids). Matching is case-sensitive on purpose,
// like the danger gate: the CLI's commands are lowercase, and a
// case-insensitive match here could diverge from the case-sensitive gates
// downstream.
//
// Pure and obsidian-free: unit-tested directly; the tool handlers call the
// two refusal functions with the settings-supplied policy.

/** The opaque-accept set for `obsidian_cli`: commands that execute arbitrary
 * macros/JS/commands and could set acceptance where no guard can inspect.
 * DENIED by default. (Also the tool-description list — one source.) */
export const OPAQUE_ACCEPT_CLI_COMMANDS = [
  "quickadd",
  "quickadd:run",
  "quickadd:run-template",
  "eval",
  "command",
] as const;

/** The opaque-accept set for `obsidian_run_command` ids: QuickAdd's commands
 * run macros (arbitrary user-defined JS); everything else a command id can do
 * is bounded by the plugin that registered it and stays allowed. */
export const OPAQUE_ACCEPT_COMMAND_IDS = ["quickadd:*"] as const;

/** The `cliPolicy` settings row. Absent/empty ⇒ the defaults: opaque-accept
 * set denied, everything else allowed. */
export interface CliCommandPolicy {
  /** Additional denied entries, checked first — deny beats allow. Exact
   * names or `prefix*` globs. */
  deny?: string[];
  /** Opaque-accept entries the human re-enabled. EXACT MATCH ONLY — globs
   * are deliberately not honored here, in either direction: an entry
   * re-enables one command or one run_command id, never a family. (A glob
   * would also leak across surfaces — `quickadd:*` meant for run_command ids
   * would silently re-enable the CLI's `quickadd:run`/`quickadd:run-template`
   * too.) Deny globs stay: over-denying is safe, over-allowing is not. */
  allowOpaque?: string[];
}

/** Does `name` match `pattern` — exact, or prefix glob `foo*` (any trailing
 * `*` makes everything before it a prefix)? No other glob syntax. */
export function matchesCommandPattern(name: string, pattern: string): boolean {
  const p = pattern.trim();
  if (p.length === 0) return false;
  if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
  return name === p;
}

function matchesAny(name: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((p) => matchesCommandPattern(name, p));
}

/** allowOpaque is exact-only (see CliCommandPolicy) — no pattern semantics. */
function allowedOpaque(name: string, policy: CliCommandPolicy | undefined): boolean {
  return (policy?.allowOpaque ?? []).some((p) => p.trim() === name);
}

function refusal(
  name: string,
  policy: CliCommandPolicy | undefined,
  opaqueSet: readonly string[],
  surface: string,
): string | null {
  if (matchesAny(name, policy?.deny)) {
    return `${surface} '${name}' is denied by the vault-mcp command policy (settings › Security › "Denied commands").`;
  }
  if (matchesAny(name, opaqueSet) && !allowedOpaque(name, policy)) {
    return (
      `${surface} '${name}' executes opaque macros/code that the acceptance guard cannot inspect, and is ` +
      `denied by default (fail closed). A human can re-enable this specific command in the vault-mcp ` +
      `settings (Security › "Re-enabled opaque commands") — there is no agent-writable path to that setting.`
    );
  }
  return null;
}

/** The reason an `obsidian_cli` command is refused by policy, or null. */
export function cliCommandRefusal(command: string, policy?: CliCommandPolicy): string | null {
  return refusal(command.trim(), policy, OPAQUE_ACCEPT_CLI_COMMANDS, "CLI command");
}

/**
 * Config-territory guard for CLI param VALUES: the "human-only settings"
 * property assumes no MCP surface can write plugin settings. The MCP write
 * primitives enforce that structurally (they refuse non-`.md` paths), but
 * `obsidian_cli` forwards param values to the external CLI binary unvalidated
 * — whether the binary's `create file=…`/`property:set` would accept a path
 * into `.obsidian/` is the binary's business, not something we can verify
 * from here. So the proxy refuses to forward ANY param value that names
 * `.obsidian` territory or tries to traverse out of the vault (`..`
 * segments), for every command — reads included (the journal lives there
 * too, and no legitimate CLI use targets config through this proxy).
 * Belt-and-suspenders: even if the binary would refuse anyway, the policy's
 * guarantee no longer rests on an unverified assumption about it.
 */
export function configPathRefusal(params?: Record<string, string | number | boolean>): string | null {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value !== "string") continue;
    // Normalize separators; check segment-wise so "x.obsidian.md" stays clean
    // while ".obsidian", "./.obsidian/x", or "a\\.obsidian\\b" refuse.
    const segments = value.trim().replace(/\\/g, "/").split("/");
    if (segments.includes(".obsidian")) {
      return `param '${key}' names .obsidian territory — plugin config and state are not reachable through the CLI proxy.`;
    }
    if (segments.includes("..")) {
      return `param '${key}' contains a '..' path segment — the CLI proxy stays inside the vault.`;
    }
  }
  return null;
}

/** The reason an `obsidian_run_command` id is refused by policy, or null. */
export function runCommandRefusal(commandId: string, policy?: CliCommandPolicy): string | null {
  return refusal(commandId.trim(), policy, OPAQUE_ACCEPT_COMMAND_IDS, "command id");
}
