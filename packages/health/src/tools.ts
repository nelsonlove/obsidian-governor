// tools.ts — the vault-health satellite's tool surface. TWO tools, published to
// the Governor host through `vault-mcp-api` (see main.ts):
//
//   scan — the full tiered health scan → structured findings
//   lint — the same scan, with findings restricted to one folder or note
//
// Both run the pure health core (kernel/*, Obsidian-free over an injected
// HealthSource). There is NO write path anywhere in this plugin: it only emits
// findings, never mutates — the fixing is a separate skill, out of scope. There
// is no mutating registrar, no write guard and no accept/approve verb here, and
// that is the design.
//
// ── The published names changed, and that was a CHOICE ───────────────────────
//
// The host publishes an external tool as `<sanitized publisher id>_<bare name>`
// (`sanitizeOwnerId` in the host's `mcp/external-tools.ts`), so the plugin id IS
// the tool namespace: `vault-health` sanitizes to `vault_health`.
//
//     obsidian_health  →  vault_health_scan
//     obsidian_lint    →  vault_health_lint
//
// The BARE names shed the `obsidian_` prefix, on the grounds the bases satellite
// used for shedding `base_`: `obsidian_` was the HOST's built-in tool namespace,
// never this module's own name, so carrying it into a satellite's namespace would
// publish a tool named after two owners — `vault_health_obsidian_health`.
//
// KEEPING THEM WAS AVAILABLE AND WAS DECLINED. It is worth being exact, because
// the opposite claim is easy to make and wrong: the host's F1 check tests the
// PUBLISHED name, not the bare one (`const toolName = ownerId_name;
// if (toolName.startsWith("obsidian_")) throw`), and `vault_health_obsidian_health`
// does not start with `obsidian_`, so it would have registered fine — just
// stutteringly. `NAME_RE` accepts the bare `obsidian_health` too. Nothing forced
// this rename.
//
// It BREAKS any agent session or saved prompt calling the old names, and the
// host's own locked decision says renaming shipped tool names breaks agent
// sessions for zero semantic gain. What buys it is that the stuttering
// alternative is worse to read and to type, and that the prefix named the wrong
// owner. Recorded in CLAUDE.md and README.md with the one-line reversal.
//
// ── The whole-vault read, and where the boundary moved ──────────────────────
//
// `scanHealth` still reads EVERY note. That is deliberate and unchanged: a
// partial health report is a misleading one — an attachment referenced from
// outside the allowlist would read as orphaned, and a duplicate group would lose
// members it actually has. So `ctx.getSettings` is NOT applied to the scan, the
// same way `provenance_reconcile` runs over its whole notes-dir.
//
// What DID change is where the boundary is enforced. As untrusted external tools
// with no recognized path-key argument, BOTH tools are blocked wholesale by the
// host's F3 gate while a path allowlist is active — see the allowlist section
// below. That is stricter than the in-module non-filtering it replaces, and it is
// why issue #381's concern is resolved for these two tools rather than merely
// documented.
//
// ── Allowlist posture, precisely ────────────────────────────────────────────
//
// The host's F3 gate (`external-tools.ts`) is evaluated at CALL TIME on the
// ACTUAL ARGUMENTS: `if (settings.allowlist.length > 0 && collectPaths(args ??
// {}).length === 0) return fail(...)`. `collectPaths` reads `PATH_KEYS` (`path`,
// `from`, `to`, `target_path`, `template_path`, `subdir`, `file_path`,
// `output_folder`) plus `ARRAY_PATH_KEYS` (`paths`, `refs`). So:
//
//   * `scan` takes NO arguments        ⇒ blocked outright under an allowlist;
//   * `lint` takes `scope`, which is not a path key ⇒ ALSO blocked outright.
//
// Both declare `readOnly: true`, which the host DISTRUSTS unless `vault-health`
// is listed in the user's `trustedReadOnlyPlugins` setting. Untrusted ⇒ both
// register as MUTATING, so read-only mode blocks them and each call takes a
// write-queue slot and a journal record. Trust restores read-only-mode
// availability but does NOT change F3 — trust answers read-only mode, never
// scoping (closed 2026-09-05 by the skills satellite's review).
//
// `scope` was deliberately NOT renamed into a path key, the way triage renamed
// `target` → `target_path`. Three reasons, in order of weight:
//
//   1. It is not the path of anything this tool reads. `scope` is a FOLDER
//      PREFIX and a filter over FINDINGS. The scan reads the whole vault by
//      design and the scope only narrows what is REPORTED, so path-keying it
//      would hand the guard a string that does not describe the read.
//   2. It would be the illusion of a check. The host guard would let a scoped
//      `lint` through while the underlying scan still read every note — exactly
//      the trap the crosssession extraction named when it declined to path-key
//      `channel`.
//   3. The `to` → `to_address` precedent runs the other way: the host renamed
//      AWAY from a path key when the argument was not a path (an address string
//      prefix-matched as a path refused every legitimate call). `scope` is at
//      least path-SHAPED, but `lint` accepts a folder OR a note path and the
//      guard would still be answering the wrong question.
//
// The consequence is that the whole surface is refused wholesale under an active
// allowlist. Fail-closed, and strictly stricter than what the module did.
//
// ── The in-handler scope guard STAYS ────────────────────────────────────────
//
// `resolveScope` (from `@vault-mcp/core`) is redundant *under* an allowlist —
// F3 has already refused the call — but load-bearing WITHOUT one, which is the
// configuration the operator actually runs. It still validates malformed scopes:
// absolute, `..`-escaping, whitespace-padded, backslashed, and ones that
// normalize to nothing. Do not "simplify" it away.
//
// It is also the record of a real bug. Until 2026-08-29 `obsidian_lint` did not
// check `scope` at all — `scope` is a bare string, so it is not in the host
// guard's `PATH_KEYS` and `guardCall` never saw it, and a session allowlisted to
// `Projects/` could lint `Archive/Secrets` and get back that folder's
// dangling-link text, orphan-attachment paths, empty-note paths and
// duplicate-group paths. `ctx.getSettings` sat on the context declared and never
// called. The fix routed lint through the SAME resolver `obsidian_check_links`
// uses, deliberately, rather than a second copy.
//
// A satellite cannot import host internals, so at S7 `resolveScope` was PUBLISHED
// into `@vault-mcp/core` (packages/core/src/scope.ts) rather than copied: a
// forked guard predicate is the drift this repo has paid for three times, and the
// `isVisible` (S4) / `executeQuickAddChoice` (S5) publications are the precedent.
// The move is behaviour-preserving — the host's old call reduced exactly to
// `isVisible` — and gained ONE new refusal, a scope containing a BACKSLASH now
// refusing `invalid_scope`, because every downstream check splits on "/" alone.
// Both callers (the host's `obsidian_check_links` and this `lint`) got stricter
// in the same motion, which is the point of there being one copy.
//
// ── Envelope convention (the satellite contract) ────────────────────────────
//
// A handler returns PLAIN DATA and THROWS on refusal. The host wraps a return
// value in `ok()` and a thrown error in `fail()`; `fail()` reads a lowercase
// snake `code` off the thrown error and renders `Error [code]: message`, the
// same shape the module's `codedError` produced — so every typed refusal an agent
// sees (`invalid_scope`, `out_of_allowlist`, `invalid_argument`) is
// byte-compatible with the folded era. `ok` / `fail` / `codedError` themselves
// are host-internal and are NOT imported here.
//
// ── Schema fidelity across the boundary ─────────────────────────────────────
//
// The SDK converts a zod shape to JSON Schema and the host converts it back
// through a deliberately small subset (`json-schema-to-zod.ts`): `type`,
// `description` and STRING `enum` survive; `default`, `min`, `max` and `pattern`
// DO NOT. `scope`'s `.min(1)` is therefore re-applied in the handler
// (`requireText`) — the `vault_skills_release` semver lesson: a constraint that
// lives only in the declared schema never runs for an MCP caller.
//
// Obsidian-free by construction: the vault arrives through the injected
// HealthSource, so both handlers are headless-testable. The live adapter is in
// obsidian-source.ts and is imported only by main.ts.

import { z } from "zod";
import type { SdkToolSpec } from "vault-mcp-api";
import { resolveScope, type GuardSettings } from "@vault-mcp/core";
import {
  scanHealth,
  filterFindingsToScope,
  summarize,
  healthConfigOf,
  type HealthConfig,
  type HealthSource,
} from "./kernel/index.js";

/** Both tools' SDK flags. `readOnly: true` is a CLAIM the host distrusts unless
 * `vault-health` is in `trustedReadOnlyPlugins` — see the allowlist note in the
 * header for what that costs. */
const RO = { readOnly: true, destructive: false, idempotent: true } as const;

/**
 * A TYPED refusal, thrown. `fail()` in the host reads a lowercase-snake `code`
 * off the error and renders `Error [code]: message` — the identical envelope the
 * module's `codedError` produced.
 */
export class HealthRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HealthRefusal";
    this.code = code;
  }
}

/** Declared as a FUNCTION, not a const arrow: TypeScript only narrows control
 * flow through a `never`-returning call when the callee is a function
 * declaration (or an explicitly annotated const). */
function refuse(code: string, message: string): never {
  throw new HealthRefusal(code, message);
}

export interface HealthToolsCtx {
  /** The config overrides (this plugin's own settings). A THUNK, read per call.
   *
   * This is the S7 bug fix, not a stylistic change. `registerHealthTools`
   * computed `healthConfigOf(ctx.config)` ONCE at registration and both handlers
   * closed over it. As a MODULE that was per-connection, so a settings edit
   * landed on the next agent connect. As a SATELLITE there is no per-connection
   * rebuild at all, so a captured config would freeze at plugin load — forever.
   * (The tool DESCRIPTIONS below are necessarily build-time snapshots of it,
   * which is why main.ts re-publishes on every settings write.) */
  config: () => Record<string, unknown>;
  /** Guard settings accessor, used ONLY to validate the `lint` scope argument
   * through `resolveScope`. It is NOT applied to the scan: the scan reads the
   * whole vault by design (a partial health report misreports orphans and
   * duplicates), exactly as `provenance_reconcile` runs over its whole notes-dir.
   *
   * In the SHIPPED configuration nothing supplies it — a satellite cannot reach
   * the host's guard settings, and the host's external-tool gate is the enforced
   * boundary. Absent ⇒ `resolveScope` still refuses a MALFORMED scope and skips
   * only the allowlist half. Kept as a live seam (and supplied by the tests, so
   * it cannot rot) for the day `vault-mcp-api` can carry the caller's scope to a
   * publisher. */
  getSettings?: () => GuardSettings;
}

/**
 * Re-apply the `.min(1)` the publishing boundary drops, and the string type with
 * it.
 *
 * The host reconstructs `type: "string"` from the JSON Schema, so a non-string
 * would normally be rejected upstream — but the SDK also accepts a hand-written
 * JSON Schema, and a bare `{}` property degrades to `z.unknown()`. Checking here
 * means the bound holds however the spec reached the host.
 *
 * Note the deliberate asymmetry with `resolveScope`: an EMPTY or non-string
 * scope is an `invalid_argument` (the caller sent the wrong type), while a
 * whitespace-padded or traversing one is `invalid_scope` (the caller sent a
 * string that is not a vault-relative prefix). Both are typed; neither is
 * silently repaired.
 */
function requireText(value: unknown, argument: string): string {
  if (typeof value !== "string" || value.length === 0) {
    refuse("invalid_argument", `'${argument}' must be a non-empty string`);
  }
  return value;
}

export function buildHealthTools(source: HealthSource, ctx: HealthToolsCtx): SdkToolSpec[] {
  /** The effective config, resolved PER CALL so a settings edit lands live. */
  const cfgNow = (): HealthConfig => healthConfigOf(ctx.config());
  /** The config as it stands while the SPECS are built — DESCRIPTIONS only. The
   * host snapshots a published spec's schema and description when it registers
   * it, so this is necessarily frozen at publish time; main.ts re-publishes on
   * every settings write so the number an agent reads is the number in force. */
  const cfgAtBuild = cfgNow();

  return [
    {
      name: "scan",
      description:
        "Read-only vault health scan. Returns findings TIERED BY FIX RISK: auto-safe (broken links whose target " +
        "uniquely resolves to exactly one existing note), approval-gated (empty / near-empty notes — body at or under " +
        `${cfgAtBuild.emptyChars} characters, frontmatter excluded; orphan attachments), and report-only (dangling ` +
        "links with no safe target, exact-duplicate note groups, low-signal used-once tags), plus summary counts. " +
        "Reads Obsidian's live resolver (metadataCache) and note bodies on disk — nothing is written; the fixing is a " +
        "separate skill. Runs over the WHOLE vault, never a subset: a partial health report would misreport orphans " +
        "(an attachment referenced from outside the subset reads as orphaned) and lose duplicate-group members. It " +
        "takes no arguments, so the Governor host blocks it outright while a path allowlist is active.",
      inputSchema: {},
      ...RO,
      handler: async () => {
        const cfg = cfgNow();
        const findings = await scanHealth(source, cfg.emptyChars);
        return { emptyChars: cfg.emptyChars, summary: summarize(findings), ...findings };
      },
    },

    {
      name: "lint",
      description:
        "The same read-only health scan as the scan tool, but with findings restricted to a single vault-relative " +
        "folder (or note). Link resolution and the orphan inbound-set are still computed VAULT-WIDE, so an attachment " +
        "referenced from OUTSIDE the scope is correctly not reported as orphaned. Broken links are attributed to the " +
        "note that contains them; empty notes (body at or under " + `${cfgAtBuild.emptyChars}` + " characters) and " +
        "orphan attachments to their own path; a duplicate group is kept whole if any member is in scope. Low-signal " +
        "TAGS are omitted from a scoped lint (tags are vault-wide and cannot be attributed to a folder — use the scan " +
        "tool for those). A malformed scope (absolute, `..`-escaping, whitespace-padded, or containing a backslash) is " +
        "REFUSED rather than repaired. `scope` is not a path argument the host can scope by, so this tool too is " +
        "blocked outright while a Governor path allowlist is active.",
      inputSchema: {
        scope: z
          .string()
          .min(1)
          .describe("Vault-relative folder or note path to restrict findings to, e.g. \"Projects\" or \"Projects/Note.md\"."),
      },
      ...RO,
      handler: async (args: Record<string, unknown>) => {
        const cfg = cfgNow();
        const raw = requireText(args.scope, "scope");
        // The hand-guard the host's own guard cannot perform — see the header.
        // Refusals are TYPED (`invalid_scope` / `out_of_allowlist`), never a
        // zeroed report: a zeroed report for a hidden folder and a zeroed report
        // for a genuinely clean one are indistinguishable.
        const { prefix, refusal } = resolveScope(raw, ctx.getSettings?.());
        if (refusal) refuse(refusal.code, refusal.message);
        // Filter and echo the NORMALIZED prefix, not the raw argument: the guard
        // decided over the normalized form, so filtering over the raw one could
        // check a different string than it reported on. `resolveScope` returns a
        // prefix or a refusal for any DEFINED scope (only `undefined` yields
        // neither, and `requireText` has already excluded that) — the branch
        // below is the type-level backstop, not a reachable path.
        if (prefix === undefined) refuse("invalid_scope", `scope '${raw}' could not be resolved`);
        const scope = prefix;
        const findings = await scanHealth(source, cfg.emptyChars);
        const scoped = filterFindingsToScope(findings, scope);
        return { scope, emptyChars: cfg.emptyChars, summary: summarize(scoped), ...scoped };
      },
    },
  ];
}
