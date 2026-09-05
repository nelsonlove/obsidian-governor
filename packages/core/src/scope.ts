// scope.ts — `resolveScope`, the shared validator for a bare `scope` STRING
// argument, published as a contract at the read-tier satellite extraction
// (suite split, S7).
//
// ── WHY IT LIVES IN CORE NOW ────────────────────────────────────────────────
//
// A `scope` argument is not a path key. The host's guard collects paths from a
// fixed `PATH_KEYS` list (`path`, `from`, `to`, …); `scope` is on none of them,
// so `guardCall` never sees it and EVERY tool that takes one has to check it by
// hand. That is not hypothetical: until 2026-08-29 `obsidian_lint` did not, and
// a session allowlisted to `Projects/` could lint `Archive/Secrets` and get
// back dangling-link text, orphan-attachment paths, empty-note paths and
// duplicate-group paths for a folder it could not otherwise see. The fix was to
// route `obsidian_lint` through the SAME resolver `obsidian_check_links` uses,
// explicitly rather than a second hand-rolled copy.
//
// At S7 `obsidian_lint` left the host for the `vault-health` satellite, and a
// satellite cannot import host internals. That left exactly two options: copy
// the resolver into the satellite, or publish it. Copying a guard predicate is
// the drift this repo has already paid for three times (the accept-guard
// recognizer, the guarded-territory prefix list, and the `isVisible` fork S4
// pre-empted), and a copy that normalizes differently is a bypass nobody
// notices until it is a leak. So it is published, exactly as `isVisible` was at
// S4 and `executeQuickAddChoice` at S5.
//
// The move is behaviour-preserving by construction. The host's version called
// `guardCall({ isMutating: false, args: { path: prefix }, settings })`, whose
// read-only branch cannot fire for a non-mutating call and whose allowlist
// branch is `collectPaths({path: prefix})` → `[prefix]` → `isVisible(prefix,
// settings)`. So the whole dependency reduced to `isVisible`, which core
// already publishes — the refusal code and message below are reproduced
// verbatim from what `guardCall` produced.
//
// ── ONE THING IS NEW: BACKSLASH IS REFUSED ──────────────────────────────────
//
// Every check downstream of this one splits on "/" alone — `normalizePosix`,
// `isVisible`'s prefix match, and each caller's own `inScope` segment walk. So
// `Projects/x\..\..\Secrets` reads as ONE opaque segment here and as a
// traversal to whatever normalizes it later. Obsidian paths never legitimately
// contain a backslash; refusing outright is free and closes the class rather
// than the instance. This is the same refusal the triage satellite added to its
// `target_path` validator at the 2026-09-05 review, applied at the other place
// this repo validates a path-shaped string by hand. It makes BOTH callers
// (`obsidian_check_links` in the host and the health satellite's lint) stricter
// in the same motion, which is the point of there being one copy.

import { isVisible, normalizePosix, type GuardSettings } from "./visibility.js";

/** A refusal, carrying the machine-readable code the wire shape wants. */
export interface ScopeRefusal {
  code: string;
  message: string;
}

const HOW =
  "give a vault-relative prefix like 'Projects', or omit scope to report on everything you can see. Nothing was reported.";

/**
 * Resolve `scope` to a normalized prefix, or REFUSE it — the same shape and the
 * same code vocabulary `scopeRefusal` uses for an advisory claim
 * (the host's tools-locks.ts), so every scope-taking surface answers a bad
 * scope the same way.
 *
 * Two families of refusal, both typed rather than silently repaired:
 *
 *   • MALFORMED (`invalid_scope`) — one that normalizes to nothing, to `.`, or
 *     above the vault root; one that is absolute; one padded with whitespace;
 *     one containing a backslash (see the header). A caller who wrote `..`
 *     meant to NARROW, and quietly handing back the whole vault is the opposite
 *     of what they asked for; `/Projects` and ` Projects` are equally a mistake
 *     about what a vault-relative prefix is, and repairing them silently
 *     teaches a shape that will not hold elsewhere.
 *   • OUT OF ALLOWLIST (`out_of_allowlist`) — a scope naming an area this
 *     session cannot see. It refuses TYPED rather than returning a zeroed
 *     report, matching the claims surface: a zeroed report for `Archive/` and a
 *     zeroed report for a genuinely clean `Archive/` are indistinguishable, so
 *     the refusal is both the more honest answer and the consistent one. A
 *     scope that merely CONTAINS your allowlist (`Projects` under an allowlist
 *     of `Projects/Alpha`) is out of it too — narrow the scope, or omit it.
 *
 * Omitting `scope` is how you ask for everything visible, and it is unambiguous.
 */
export function resolveScope(
  scope: string | undefined,
  settings?: GuardSettings,
): { prefix?: string; refusal?: ScopeRefusal } {
  const malformed = (raw: string, why: string) => ({
    refusal: { code: "invalid_scope", message: `scope '${raw}' ${why} — ${HOW}` },
  });
  if (scope === undefined) return {};
  if (scope.includes("\\")) return malformed(scope, "contains a backslash");
  if (scope !== scope.trim()) return malformed(scope, "has leading or trailing whitespace");
  if (scope.startsWith("/")) return malformed(scope, "is an absolute path");
  const prefix = normalizePosix(scope).replace(/\/+$/, "");
  if (!prefix || prefix === "." || prefix === ".." || prefix.startsWith("../")) {
    return malformed(scope, "does not name a folder in this vault");
  }
  // The allowlist half. Reproduces `guardCall`'s own refusal verbatim — same
  // code, same message — because that is the envelope callers already ship and
  // an extraction must not reword what an agent parses.
  //
  // Settings are normalized FIELD BY FIELD rather than `settings ?? default`:
  // the host's `guardCall` reads `settings.allowlist.length` unguarded, so a
  // partial settings object (one with no `allowlist` key at all) used to throw
  // rather than allow. `isVisible` is already total over that shape, but the
  // normalization is kept so a caller passing a half-built settings bag gets
  // the documented "absent means unrestricted", not a silent behaviour change.
  const allowlist = settings?.allowlist ?? [];
  if (!isVisible(prefix, { readOnly: settings?.readOnly ?? false, allowlist })) {
    return {
      refusal: {
        code: "out_of_allowlist",
        message: `path '${prefix}' is outside the governor allowlist — narrow the scope, or omit it. Nothing was reported.`,
      },
    };
  }
  return { prefix };
}
