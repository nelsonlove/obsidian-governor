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
//     cannot be inspected — DENIED BY DEFAULT via the command policy
//     (cli-policy.ts), re-enabled only per-command through human-only settings.
//   - Command policy (cli-policy.ts): a settings deny list (always wins) plus
//     the deny-by-default opaque-accept set above; refusals are typed
//     Error [cli_denied] and run before the danger gate, which still applies.

import { z } from "zod";
import { execFile } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, okError, codedError } from "./helpers.js";
import { spawnEnv, findBinary } from "../claude-cli.js";
import type { ServerCtx } from "./tools-core.js";
// Reuse the SAME accepted-family rule the MCP note-write primitive uses — no
// second definition of "accepted" on the CLI path (see cliAcceptRefusal below).
import { acceptForbiddenReason } from "./write-notes-compose.js";
import { leadingFrontmatterBlock, stripLeadingBom } from "@vault-mcp/core";
import { cliCommandRefusal, configPathRefusal, OPAQUE_ACCEPT_CLI_COMMANDS } from "./cli-policy.js";

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
// RESIDUAL — CLOSED on both fronts, two mechanisms that compose:
//   • The opaque macro/code commands (`quickadd`/`quickadd:run`/
//     `quickadd:run-template`/`eval`/`command`) can set acceptance where no
//     guard can inspect — DENIED BY DEFAULT by the command policy
//     (cli-policy.ts), re-enabled only per-command through the human-only
//     `cliPolicy.allowOpaque` setting; a re-enabled `eval` still needs
//     allowDangerousCli.
//   • `create template=<t>` draws frontmatter from a template note the params
//     only NAME. The template guard below resolves and reads it and applies
//     the same rule pre-exec (unresolvable fails closed). It refuses a template
//     carrying a literal accepted fence (the STATIC case), AND — the post-scan
//     expansion hole this once left open (#137) — it now FAILS CLOSED on any
//     expansion token in the resolved bytes: a Templater `<%` opener OR a
//     core-Templates `{{` field opener.
//
//     Why the expansion check is needed: Obsidian expands both Templater `<% %>`
//     tags and core Templates `{{date:FMT}}`/`{{time:FMT}}` fields AFTER a byte
//     scan, and BOTH honor moment's `[…]` literal escape — so an expansion could
//     emit both the acceptance assertion and the fence characters from a
//     template that contains neither, and the scanned bytes would not be the
//     landed bytes (the #126 defect shape one level up). The `create template=`
//     path uses the core Templates plugin specifically, so `{{date:FMT}}` is a
//     live arbitrary-emission facility on exactly this surface — carving it out
//     was the flaw. Because the expanded output cannot be inspected pre-render, a
//     template carrying ANY expansion token is refused outright
//     (`templateExpansionRefusal`, below) rather than scanned and trusted. The
//     static scan remains for templates with no expansion token but a literal
//     fence.
//
//     A re-enabled `quickadd:run-template` gets the same checks on its `path=`
//     template. It remains in the policy's default-deny set regardless, because
//     QuickAdd's own runtime-computed frontmatter (distinct from the template
//     file's bytes) stays opaque.

// property:set family — sets one property (documented `name=<prop> value=<val>`)
// or, in shorthand, direct key=value params. `frontmatter:` alias included
// defensively; get/list/remove are not introduces and are not matched.
const PROPERTY_SET_RE = /^(?:property|frontmatter):(?:set|add|update|patch)$/;

// content-writing family — create/append/prepend, the periodic-note variants,
// and base:create (a base item written with the same name=/content= params). All
// take a caller-controlled `content=` that carries the body (and any frontmatter
// fence), so the content THEY ARE HANDED is inspectable pre-exec. (A periodic
// create with NO content= draws its body from the Daily/Periodic Notes plugin
// config's template instead — a documented residual; see TEMPLATE_PARAM.)
const CONTENT_WRITE_RE =
  /^(?:create|append|prepend|base:create|(?:daily|weekly|monthly|quarterly|yearly):(?:create|append|prepend))$/;

// Arbitrary-macro / code-execution commands that can set acceptance opaquely.
// The authoritative deny-by-default set now lives in cli-policy.ts
// (OPAQUE_ACCEPT_CLI_COMMANDS); this re-export keeps the historical name for
// the tool description + report surfaces. `quickadd:run-template` STAYS in
// the set even though the template guard below now scans its template file:
// the static scan catches a literal accepted fence, but QuickAdd format
// syntax can COMPUTE frontmatter at run time, which no pre-exec scan can see
// — the scan is belt, the opacity is real.
export const CLI_OPAQUE_ACCEPT_RESIDUAL: readonly string[] = OPAQUE_ACCEPT_CLI_COMMANDS;

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

// ── the CLI content path decides over EVERY plausible reading (#153) ──────────
//
// The CLI un-escapes a param value's backslash escapes before the vault sees
// them, so — unlike every other accept-guard caller — this one cannot inspect
// the bytes it was handed. It must RECONSTRUCT the document that will land, and
// a reconstruction models another program's escape semantics. #146's review
// found that model incomplete: it had no notion of an ESCAPED BACKSLASH (`\\`),
// so a crafted payload could make the guard perceive the frontmatter fence
// ending in a different place than the honored document has it — hiding an
// acceptance assertion inside the real fence from the guard's view.
//
// Settling "which escape semantics does the shipped CLI use?" is a property of
// an external binary and was left unsettled (#153). Rather than bet the crown-
// jewel accept boundary on guessing right, we DO NOT PICK a reading. We enumerate
// the plausible readings, expand under EACH, and REFUSE (fail closed) if ANY
// reading yields an acceptance assertion inside a frontmatter fence. The guard's
// property becomes: *no plausible reading of these bytes asserts acceptance* —
// no reliance on modelling the external program correctly (issue #153, option 3).
//
// The escaped-backslash ambiguity leaves exactly three COHERENT readings. Two
// binary choices generate them — (a) is `\\` an escaped escape? (b) is an
// unrecognized `\X` kept literal or is its backslash dropped? — but the fourth
// combination (drop `\X` yet NOT treat `\\` as an escape) is incoherent: dropping
// the backslash on an arbitrary `\X` IS treating `\\`→`\` for X=`\`. So:
//
//   R1 — no escaped escape. Recognize only `\n`/`\r\n`/`\t`, greedily, anywhere;
//        every other byte (a lone `\`, a `\\` pair) is literal. This is exactly
//        what the shipped regex did, so R1 preserves every refusal main already
//        made — it is kept verbatim, not re-derived. Note its artifact: in `\\n`
//        the regex finds `\n` at the SECOND backslash, so R1 emits `\`+newline.
//   R2 — escaped escape, unknown escape kept literal. `\\`→`\`, `\n`/`\r\n`→LF,
//        `\t`→tab; any other `\X` stays the two bytes `\X` (JSON/shell-ish).
//   R3 — escaped escape, unknown escape DROPPED. As R2 but `\X`→`X` (drop the
//        backslash) — the reading under which `\-\-\-` collapses to a bare `---`
//        fence and `accept\ed` to `accepted`, the escaped-escape family's sharp
//        edge.
//
// R2 is a coherent plausible reading even where a given payload happens to be
// caught only by R1 or R3 — the guarantee quantifies over ALL plausible
// readings, not the one we guess is likeliest, so it is scanned regardless.
// Unlike the template path, the raw caller bytes are NOT a plausible reading:
// they are provably not what lands (the CLI un-escapes), so scanning them raw
// would model a program the CLI is not.

/**
 * Expand a CLI param value under an escaped-backslash reading (R2/R3), left to
 * right in a single pass: `\\`→`\` (escaped escape), `\r\n`/`\n`→LF, `\t`→tab.
 * An unrecognized `\X` is kept as the literal two bytes `\X` when
 * `unknownEscape` is "keep" (R2) or collapsed to `X` when "drop" (R3). Exported
 * for the escape-semantics fixture suite. R1 is NOT expressed here — it is the
 * verbatim shipped regex in `contentAcceptRefusal`, so its behavior cannot drift.
 */
export function expandCliEscapes(content: string, unknownEscape: "keep" | "drop"): string {
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "\\" && i + 1 < n) {
      const next = content[i + 1];
      // `\r\n` (four source bytes) before the two-byte escapes, so a CRLF escape
      // folds to one LF rather than leaving a stray `\r` behind.
      if (next === "r" && content[i + 2] === "\\" && content[i + 3] === "n") { out += "\n"; i += 4; continue; }
      if (next === "\\") { out += "\\"; i += 2; continue; } // escaped escape — the byte R1 has no notion of
      if (next === "n") { out += "\n"; i += 2; continue; }
      if (next === "t") { out += "\t"; i += 2; continue; }
      // unrecognized `\X`
      if (unknownEscape === "drop") { out += next; i += 2; continue; }
      out += ch; i += 1; continue; // keep the backslash literal; reconsider `next` normally
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Scan written content for an acceptance-asserting frontmatter fence. The CLI
 * interprets a param value's backslash escapes before the vault sees them, so
 * the guard must decide over a RECONSTRUCTION of the honored document, not the
 * bytes it was handed. Because the exact escape semantics of the external binary
 * are unsettled, it expands under EVERY plausible reading (R1/R2/R3 above) and
 * refuses if ANY of them yields an acceptance assertion inside a `---` fence —
 * so no reading can smuggle acceptance past it (#153). Every `---`-delimited YAML
 * block (leading or embedded) in each expansion is parsed and checked with the
 * shared rule. `append` content is not a note's leading frontmatter, but the
 * resulting note cannot be read pre-exec, so acceptance-carrying content is
 * blocked conservatively — nobody legitimately writes an accepted acceptance
 * fence into a body. With no parser injected, we fail CLOSED on any fence at all
 * (defensive; production always injects obsidian.parseYaml).
 */
export function contentAcceptRefusal(content: string, parseYaml?: (yaml: string) => unknown): string | null {
  // R1 — the shipped model, kept byte-for-byte so no current refusal weakens.
  const r1 = content
    .replace(/\\r\\n|\\n/g, "\n") // literal \n (and \r\n) escapes the CLI expands
    .replace(/\\t/g, "\t"); // literal \t escapes
  const readings = [
    r1,
    expandCliEscapes(content, "keep"), // R2 — escaped escape, unknown kept literal
    expandCliEscapes(content, "drop"), // R3 — escaped escape, unknown dropped
  ];
  // Fail closed if ANY plausible reading asserts acceptance in a fence. Distinct
  // expansions only (identical readings — the common escape-free case — scan once).
  const seen = new Set<string>();
  for (const honored of readings) {
    if (seen.has(honored)) continue;
    seen.add(honored);
    const reason = scanForAcceptFence(honored, parseYaml);
    if (reason) return reason;
  }
  return null;
}

// ── fail closed on a Templater expansion token (#137) ────────────────────────
//
// The template guards above scan a template's RESOLVED BYTES for an accept
// fence pre-exec. That is a floor, not a proof: the vault expands Templater's
// `<% %>` tags AFTER the guard has looked, and Templater's own facilities
// (notably a date-format string that honors a literal-escape construct) can
// emit ARBITRARY characters — including an `acceptance-status: accepted`
// assertion AND the `---` fence delimiters around it — from a template whose
// bytes contain neither. So a template that scans clean can still land a note
// asserting acceptance. This is the #126 defect shape one level up: the bytes
// inspected are not the bytes that land.
//
// Nelson's ruling (Option 2): fail CLOSED on expansion tokens. A template
// whose resolved content carries ANY Templater expansion token cannot be
// inspected before it lands, so refuse the create rather than scan a document
// that is not the one the vault will honor. The escape hatch — expand it in
// Obsidian first, or use a template without expansion tokens — is named in the
// refusal so a legitimate caller is not merely stonewalled.
//
// Token set: the guard is deliberately conservative and refuses on TWO opener
// families, each matched as a SUBSTRING (not a parse — being broader than either
// grammar is the point, fail closed):
//   • ANY `<%` opener — the union of every Templater tag form (`<% %>`
//     interpolation, `<%* %>` execution, `<%~ %>` / `<%+ %>`, and the
//     `<%_`/`-%>`/`_%>` whitespace-control variants).
//   • ANY `{{` opener — the core Templates plugin's fields (`{{title}}`,
//     `{{date}}`, `{{time}}`, and the format forms `{{date:FMT}}`/`{{time:FMT}}`).
// The `{{ }}` family is NOT exempt, and the earlier claim that it "expands a
// fixed, closed set of values with no arbitrary-emission facility" was FALSE and
// is the exact hole this correction closes: `{{date:FMT}}`/`{{time:FMT}}` run FMT
// through moment, which honors the `[…]` literal escape — so a single field can
// emit an `acceptance-status: accepted` assertion AND the `---` fence around it,
// through the plain `create template=` path, from a template whose bytes carry
// neither. That is the same arbitrary-emission facility as Templater's date
// format, so the whole `{{ … }}` class fails closed, not a carved-out subset.
// Per Nelson's Option-2 ruling this refuses dated/titled templates (the common
// case) — that cost IS the ruling; the carve-out was the deviation. The escape
// hatch (expand in Obsidian first, or use a template with no expansion token) is
// named in the refusal, so a legitimate caller is not merely stonewalled.

/** A Templater expansion token: any `<%`-opened tag. Substring, not a parse — being broader than Templater's grammar is the point (fail closed). */
const TEMPLATER_EXPANSION_TOKEN = "<%";
/** A core-Templates field opener: any `{{`. Substring, not a parse — deliberately broader than the `{{title}}`/`{{date}}`/`{{time}}` set the plugin expands, and refusing the whole class is the point (fail closed). The `{{date:FMT}}` moment literal-escape IS an arbitrary-emission facility, so no bare form is "safe" to carve out. */
const CORE_TEMPLATE_FIELD_TOKEN = "{{";

/**
 * The reason a template must not be created from because its RESOLVED content
 * carries a template expansion token whose output cannot be inspected before it
 * lands (#137), or null when it carries none. Refuses on EITHER a Templater `<%`
 * opener OR a core-Templates `{{` field opener — the whole expansion-token class,
 * no carve-out. Names the escape hatch.
 */
export function templateExpansionRefusal(content: string): string | null {
  if (content.includes(TEMPLATER_EXPANSION_TOKEN) || content.includes(CORE_TEMPLATE_FIELD_TOKEN)) {
    return (
      "contains a template expansion token (Templater `<% %>` or a core-Templates `{{ }}` field) whose expanded output the guard cannot inspect before it lands — " +
      "expand it in Obsidian and retry, or use a template without expansion tokens"
    );
  }
  return null;
}

/**
 * The reason a create-from-template must be refused given the template's REAL
 * FILE BYTES, or null when it is clean. Two fail-closed checks, in order:
 *
 *  1. **Expansion tokens (#137)** — refuse ANY `<%`-opened Templater tag OR any
 *     `{{`-opened core-Templates field first: the expanded output is not the
 *     bytes the fence scan can see, so a clean scan is not a clean note. Both
 *     token families carry an arbitrary-emission facility (Templater's date
 *     format and core Templates' `{{date:FMT}}` both honor moment's `[…]`
 *     literal escape), so the whole class fails closed. This is the floor Nelson
 *     ruled (Option 2).
 *  2. **The static accept-fence scan** — the same accepted-family rule direct
 *     content gets, over the raw file bytes (no CLI escape expansion: the
 *     `content=` un-escaping above would MANUFACTURE a fence out of prose
 *     containing literal `\n` text, a false positive; templates come off disk,
 *     so only real newlines are normalized).
 *
 * Both create-from-template surfaces route through this ONE predicate (the CLI
 * `templateAcceptRefusal` and the MCP `obsidian_create_note_from_template`
 * handler), so neither twin can be left unguarded — the shape #105 was.
 */
export function templateContentAcceptRefusal(content: string, parseYaml?: (yaml: string) => unknown): string | null {
  const expansion = templateExpansionRefusal(content);
  if (expansion) return expansion;
  // Template bytes come off disk unmodified — they are already the honored
  // document.
  return scanForAcceptFence(content, parseYaml);
}

/**
 * Two checks, deliberately different in kind:
 *
 *  1. **The leading fence** — decided by `leadingFrontmatterBlock`, the SAME
 *     recognizer the write path uses, applied to the SAME BYTES the vault will
 *     honor. Parity is structural here, not a matter of two normalizations
 *     happening to agree: #126 was a BOM asymmetry, and scanning a
 *     CRLF-folded copy re-opened the identical class on `\r` (a lone CR inside
 *     a scalar is content to the write path, a line break to a folded scan).
 *     Deciding over the raw document removes the whole class rather than its
 *     latest instance.
 *  2. **Embedded fences** — a deliberately BROADER, conservative sweep over a
 *     line-ending-folded copy. `append` content is not a note's leading
 *     frontmatter, and the resulting note cannot be read pre-exec, so an
 *     acceptance-asserting block anywhere in written content is refused.
 *     Broader than the write path is fine; narrower is the bypass.
 */
function scanForAcceptFence(honored: string, parseYaml?: (yaml: string) => unknown): string | null {
  const leading = leadingFrontmatterBlock(honored);
  if (leading !== null) {
    const reason = acceptReasonForBlock(leading, parseYaml);
    if (reason) return reason;
  }
  const folded = stripLeadingBom(honored).replace(/\r\n?/g, "\n");
  const fenceRe = /(?:^|\n)---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/g;
  let m: RegExpExecArray | null;
  let sawFence = leading !== null;
  while ((m = fenceRe.exec(folded)) !== null) {
    sawFence = true;
    const reason = acceptReasonForBlock(m[1], parseYaml);
    if (reason) return reason;
  }
  return sawFence && !parseYaml
    ? "carries a frontmatter fence that cannot be verified without a YAML parser"
    : null;
}

/**
 * Does one YAML block assert acceptance? Shared by both checks above so they
 * cannot disagree about a block's meaning either — the same reasoning that
 * put the boundary itself in one place.
 *
 * With no parser injected the caller fails closed on the presence of any fence
 * (defensive; production always injects obsidian.parseYaml). A block a real
 * parser cannot read cannot be judged structurally, so one that mentions the
 * acceptance field textually is treated as suspect rather than let through.
 */
function acceptReasonForBlock(block: string, parseYaml?: (yaml: string) => unknown): string | null {
  if (!parseYaml) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    if (/acceptance[-_]status/i.test(block) && /\baccepted\b|accepted[-_]/i.test(block)) {
      return "carries an accepted acceptance-status fence";
    }
    return null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return acceptForbiddenReason(parsed as Record<string, unknown>);
  }
  return null;
}

// ── template guard: the create-from-template closure ─────────────────────────
//
// `create template=<name>` copies a TEMPLATE NOTE's content — frontmatter
// included — into the new note, and `quickadd:run-template path=<p>` creates
// from a template file directly. Neither's payload appears in the call's
// params, so the content scan above never sees it: an agent could park an
// `accepted` fence in an innocent note and launder it into a new note through
// the template path. Both templates ARE inspectable, though — they are vault
// files — so the closure is to resolve + read the template pre-exec (via the
// injected `readTemplate`; obsidian-free here, wired from server.ts) and run
// the SAME templateContentAcceptRefusal rule over it — which refuses both a
// static accepted fence AND any Templater expansion token (#137: the expanded
// output is not the scanned bytes, so an inspectable-only floor is not enough).
//
// Fail-closed discipline, matching the guard's own precedents: an
// unresolvable/unreadable template refuses (an uninspectable write must not
// fail open — the `if_rev`-without-kernel rule), and a missing `readTemplate`
// dep refuses any template-carrying call outright (the no-parser rule).
// Resolution here may be STRICTER than the CLI's own (we try the templates
// folder and the literal path; the CLI may accept fuzzier names) — a
// legitimate call refused by strictness gets a clear message naming the
// template; it can be retried with the exact name. Conservative by design.

/** Commands that draw content from a template the params don't carry: the
 * param that names the template, and HOW the CLI resolves it — so the guard
 * scans the SAME file the CLI will copy, never a same-named decoy elsewhere.
 * Sources (live `obsidian help` capture, CLI v1.13.x):
 *   create: `template=<name> - Template to use` — a template NAME, resolved
 *     by the core Templates plugin within its configured folder;
 *   quickadd:run-template: `path=<vault-path> - Path to a template file in
 *     the vault` — a literal vault path.
 * NOT here, documented residual: the periodic creates (daily:create etc.)
 * with no `content=` draw their body from the Daily/Periodic Notes PLUGIN
 * CONFIG's template — no param names it, and resolving another plugin's
 * settings pre-exec is the same class as the obsidian_periodic_note write
 * residual this codebase already documents as deliberately open. */
const TEMPLATE_PARAM: Record<string, { param: string; resolve: "templates-folder" | "literal-path" }> = {
  create: { param: "template", resolve: "templates-folder" },
  "quickadd:run-template": { param: "path", resolve: "literal-path" },
};

/** How obsidianTemplateReader should resolve a reference. */
export type TemplateResolveMode = "templates-folder" | "literal-path";

/**
 * The reason a template-carrying invocation is refused, or null. Non-template
 * calls (no entry in TEMPLATE_PARAM, or the param absent/empty) are always
 * clean — the guard adds nothing to ordinary creates. A non-string param
 * value is COERCED, not skipped: `buildCliArgs` forwards `template=123` to
 * the CLI as a string, so the guard must see what the CLI sees.
 */
export async function templateAcceptRefusal(
  command: string,
  params: Record<string, string | number | boolean> | undefined,
  readTemplate: ((name: string, mode: TemplateResolveMode) => Promise<string | null>) | undefined,
  parseYaml?: (yaml: string) => unknown,
): Promise<string | null> {
  const entry = TEMPLATE_PARAM[command.trim()];
  if (!entry) return null;
  const raw = params?.[entry.param];
  if (raw === undefined || raw === "") return null;
  const name = String(raw);
  if (!readTemplate) {
    return `template '${name}' cannot be inspected in this build (no template reader) — an uninspectable template must not fail open`;
  }
  let body: string | null;
  try {
    body = await readTemplate(name, entry.resolve);
  } catch {
    body = null;
  }
  if (body === null) {
    return `template '${name}' could not be resolved for pre-exec inspection — an uninspectable template must not fail open (use the template's exact name or vault path)`;
  }
  const reason = templateContentAcceptRefusal(body, parseYaml);
  return reason ? `template '${name}' ${reason}` : null;
}

/**
 * The live template reader (server.ts injects it), resolving PER MODE so the
 * guard scans the same file the CLI will use — never a same-named decoy:
 *   "templates-folder" (create template=<name>): candidates ONLY inside the
 *     core Templates plugin's configured folder. No folder configured ⇒ null
 *     (fail closed upstream) — a literal-path fallback here would let a
 *     root-level `Foo.md` be scanned clean while the CLI copies
 *     `Templates/Foo.md`.
 *   "literal-path" (quickadd:run-template path=<vault-path>): the exact path
 *     (and path.md), nothing else.
 * Structurally typed — no `obsidian` import. Returns null when nothing
 * resolves and never throws (the whole probe is inside the try — a hostile
 * name must not turn resolution into a rejection).
 */
export function obsidianTemplateReader(app: {
  vault: {
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
  };
}): (name: string, mode: TemplateResolveMode) => Promise<string | null> {
  return async (name: string, mode: TemplateResolveMode) => {
    try {
      const folder = (app as any).internalPlugins?.plugins?.templates?.instance?.options?.folder;
      const candidates =
        mode === "templates-folder"
          ? typeof folder === "string" && folder.length > 0
            ? [`${folder}/${name}`, `${folder}/${name}.md`]
            : []
          : [name, `${name}.md`];
      for (const p of candidates) {
        const f = app.vault.getAbstractFileByPath(p);
        // A folder has `children`; a file does not — the same discriminant the
        // backend uses. Skip non-files.
        if (!f || typeof f !== "object" || "children" in (f as object)) continue;
        return await app.vault.cachedRead(f);
      }
      return null;
    } catch {
      return null;
    }
  };
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
  deps?: {
    binary?: string | null;
    exec?: CliExec;
    parseYaml?: (yaml: string) => unknown;
    /** Resolve+read a template reference per mode (template guard). Absent ⇒
     * any template-carrying call fails closed. */
    readTemplate?: (name: string, mode: TemplateResolveMode) => Promise<string | null>;
  }
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
        `Opaque macro/code commands (${[...OPAQUE_ACCEPT_CLI_COMMANDS].join(", ")}) are DENIED by default — the acceptance guard cannot inspect what they execute — and return Error [cli_denied]; a human can re-enable a specific one in settings. ` +
        "Acceptance is human-only: a property:set or content write that would introduce acceptance-status: accepted (or accepted-by/accepted-on) is refused with Error [accept_forbidden] — agents write only acceptance-status: proposed. " +
        "Template-drawing calls (create template=<name>, quickadd:run-template path=<p>) have the referenced template resolved and scanned with the same rule pre-exec; an acceptance-carrying, expansion-token-carrying (Templater <% %> OR a core-Templates {{ }} field, whose expanded output cannot be inspected before it lands), OR unresolvable template refuses accept_forbidden (fail closed — use the template's exact name/path, or expand the template in Obsidian first). " +
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
        // Command policy — the deny list and the deny-by-default opaque-accept
        // set (cli-policy.ts). Checked FIRST: a policy-denied command is
        // refused whatever the danger gate would say, and re-enabling an
        // opaque command via settings does not skip the danger gate below —
        // the two compose, both human-controlled.
        const policyReason = cliCommandRefusal(command, settings.cliPolicy);
        if (policyReason) {
          return codedError("cli_denied", policyReason);
        }
        // Config territory is unreachable through the proxy whatever the
        // external binary's own path handling — the human-only settings
        // property must not rest on an unverified assumption about it.
        const configReason = configPathRefusal(args.params, args.flags);
        if (configReason) {
          return codedError("cli_denied", configReason);
        }
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
        // Template guard — same rule, applied to the template the params only
        // NAME: create-from-template copies a vault note's frontmatter the
        // content scan above never sees. Unresolvable ⇒ fail closed.
        const templateReason = await templateAcceptRefusal(command, args.params, deps?.readTemplate, parseYaml);
        if (templateReason) {
          return codedError(
            "accept_forbidden",
            `${templateReason}. Acceptance is a human gesture, in no API — the CLI proxy will not persist it.`
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
