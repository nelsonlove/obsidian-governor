// The accept-forbidden guard — the "the accept verb is in no API" invariant.
//
// Extracted from packages/plugin/src/mcp/write-notes-compose.ts (issue #104):
// this predicate previously lived ONLY in the plugin, so ObsidianBackend was
// guarded but FilesystemBackend (packages/core) passed content straight
// through — meaning packages/server's fs-failover mode (used when Obsidian is
// down) served UNGUARDED writes. Moving the pure decision logic here lets
// every VaultBackend implementation call the SAME predicate: ObsidianBackend
// (via write-notes-compose.ts, which now re-exports from here) and
// FilesystemBackend (fs-backend/filesystem-backend.ts) both reach this one
// implementation. DRY — one predicate, two callers.
//
// Obsidian-free by construction: everything here operates on plain objects
// and an injected YAML-parse function, so it is a real unit-testable module
// with no `obsidian` import, usable from packages/core and packages/server.
//
// ── The invariant this file is the point of ─────────────────────────────────
//
// No write may INTRODUCE or CHANGE a note's acceptance to the accepted-family:
// a payload/result whose frontmatter sets `acceptance-status: accepted` (or an
// `accepted-*` variant) or carries any `accepted` / `accepted-by` /
// `accepted-on` field is REJECTED before any write lands. The transport must
// never persist acceptance — acceptance is a human gesture only, granted
// directly in Obsidian, never through an API.
//
// The one thing the guard must NOT break: a legitimate edit that carries an
// existing (human-granted) accepted value forward UNCHANGED. So the rule is a
// TRANSITION over (before, after) — preserve is allowed, introduce/change is
// not.

/** Typed refusal for the accept-forbidden guard — rendered as `Error [accept_forbidden]`. */
export class AcceptForbiddenError extends Error {
  readonly code = "accept_forbidden";
  constructor(reason: string) {
    super(
      `${reason}. The transport never persists acceptance — the accept verb is in no API. ` +
        `Remove the accepted/accepted-by/accepted-on field and retry; acceptance is a human gesture only.`
    );
    this.name = "AcceptForbiddenError";
  }
}

/**
 * True for a frontmatter VALUE that ASSERTS acceptance (`accepted`, `accepted-*`),
 * across every value-TYPE it can take: a scalar string, an array of them
 * (`[accepted]`), or a map wrapping one (`{value: accepted}`). String-only was
 * the S3 hole — an array/map form asserted acceptance while slipping the guard.
 */
function isAcceptedValue(v: unknown): boolean {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "accepted" || s.startsWith("accepted-") || s.startsWith("accepted ");
  }
  if (Array.isArray(v)) return v.some(isAcceptedValue);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(isAcceptedValue);
  return false;
}

/** A frontmatter KEY that is an acceptance-provenance field: `accepted`, `accepted-by`, `accepted-on`, `accepted_by`, … */
function isAcceptedKey(key: string): boolean {
  return /^accepted([-_ ].*)?$/.test(key.trim().toLowerCase());
}

/** Extract & parse the leading YAML frontmatter of a markdown string; null when there is none. `parseYaml` injected. */
export function frontmatterOf(
  markdown: string,
  parseYaml: (yaml: string) => unknown
): Record<string, unknown> | null {
  // A note's frontmatter counts only when `---` is its very first line
  // (Obsidian's own rule, mirrored here for parity).
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(m[1]);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Stable deep-equal over JSON-serializable frontmatter values (for the preserve-unchanged allowance). */
function fmEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && fmEqual(ao[k], bo[k]));
}

/** Case-insensitive lookup: the presence + value of `key` in `fm`, keys matched by trimmed lowercase. */
function lookupCI(fm: Record<string, unknown> | null | undefined, key: string): { present: boolean; value: unknown } {
  if (fm) {
    const want = key.trim().toLowerCase();
    for (const k of Object.keys(fm)) if (k.trim().toLowerCase() === want) return { present: true, value: fm[k] };
  }
  return { present: false, value: undefined };
}

/**
 * The reason a write is accept-forbidden given the note's RESULTING frontmatter
 * and its BEFORE-on-disk frontmatter, or null when the write is clean.
 *
 * REJECTED when the result INTRODUCES or CHANGES an accepted-family assertion:
 *   • any acceptance-provenance key (`accepted`, `accepted-by`, `accepted-on`,
 *     `accepted_*`) present in the result that was not already present on disk
 *     with an EQUAL value; or
 *   • `acceptance-status` (`acceptance_status`) whose resulting value ASSERTS
 *     accepted (string / array / map) and did not already hold that exact value.
 * Preserving an existing (human-set) value verbatim is ALLOWED.
 */
export function acceptTransitionReason(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): string | null {
  if (!after) return null;
  for (const key of Object.keys(after)) {
    const kl = key.trim().toLowerCase();
    if (isAcceptedKey(key)) {
      const prev = lookupCI(before, key);
      if (!(prev.present && fmEqual(prev.value, after[key]))) {
        return `write would ${prev.present ? "change" : "introduce"} the acceptance field '${key}'`;
      }
    } else if (kl === "acceptance-status" || kl === "acceptance_status") {
      if (isAcceptedValue(after[key])) {
        const prev = lookupCI(before, key);
        if (!(prev.present && fmEqual(prev.value, after[key]))) {
          return `write would set ${key} to an accepted value`;
        }
      }
    }
  }
  return null;
}

/**
 * The reason a frontmatter block is accept-forbidden, or null if it is clean.
 * Checks the CALLER's payload — a caller trying to write acceptance through the
 * transport — not the existing on-disk note. Applies whether or not stamping is used.
 */
export function acceptForbiddenReason(fm: Record<string, unknown> | undefined | null): string | null {
  if (!fm) return null;
  for (const key of Object.keys(fm)) {
    if (isAcceptedKey(key)) return `frontmatter carries the acceptance field '${key}'`;
    const k = key.trim().toLowerCase();
    if ((k === "acceptance-status" || k === "acceptance_status") && isAcceptedValue(fm[key])) {
      return `frontmatter sets ${key}='${String(fm[key])}'`;
    }
  }
  return null;
}

// ── A minimal frontmatter parser for callers with no full YAML library ──────
//
// packages/core has no YAML dependency (its own frontmatter editing in
// fs-backend/vault.ts and fs-backend/index-store.ts is line-based and
// best-effort by design). `parseGuardFrontmatter` is a SEPARATE, small
// reader — scoped ONLY to feed this guard — that additionally recognizes an
// inline flow-MAP value (`key: {value: accepted}`), which
// fs-backend/index-store.ts's `parseAllFrontmatter` does not (it has no map
// type in its FrontmatterValue model). Without it, a hand-crafted map-wrapped
// accepted value could slip past the guard on the filesystem backend even
// though `isAcceptedValue` above already knows how to recognize one once
// parsed — this parser exists so that recognition is actually reachable on
// the fs write path (parity with S3 in the original plugin-only guard).
//
// Best-effort, matching the codebase's existing style for this class of
// helper (see fs-backend/vault.ts's `parseSingleKeyFromLines` /
// fs-backend/index-store.ts's `parseAllFrontmatter`): scalars, quoted
// scalars, inline arrays `[a, b]`, block arrays (`key:\n  - a`), and inline
// maps `{k: v}` (one level, scalar values only — enough to detect an
// accepted-family assertion, not a general YAML parser).

function guardScalar(raw: string): string | number | boolean {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const n = parseFloat(s);
    if (Number.isFinite(n)) return n;
  }
  return s.replace(/^['"]|['"]$/g, "");
}

function guardInlineArray(inner: string): Array<string | number | boolean> {
  const s = inner.trim();
  if (s === "") return [];
  return s.split(",").map((x) => guardScalar(x));
}

function guardInlineMap(inner: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const s = inner.trim();
  if (s === "") return out;
  for (const pair of s.split(",")) {
    const i = pair.indexOf(":");
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = guardScalar(pair.slice(i + 1));
  }
  return out;
}

/**
 * Parse the leading `---\n…\n---` frontmatter fence of `markdown` into a plain
 * object suitable for `acceptTransitionReason` / `acceptForbiddenReason`.
 * Returns `null` when there is no leading fence (matching `frontmatterOf`).
 * See the block comment above for scope/limits.
 */
export function parseGuardFrontmatter(markdown: string): Record<string, unknown> | null {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const km = /^([^:\s][^:]*):(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1].trim();
    const rest = km[2].trim();

    if (rest === "" && lines[i + 1] && /^\s*-\s+/.test(lines[i + 1])) {
      const arr: Array<string | number | boolean> = [];
      while (lines[i + 1] && /^\s*-\s+/.test(lines[i + 1])) {
        arr.push(guardScalar(lines[i + 1].replace(/^\s*-\s+/, "")));
        i++;
      }
      out[key] = arr;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = guardInlineArray(rest.slice(1, -1));
      continue;
    }
    if (rest.startsWith("{") && rest.endsWith("}")) {
      out[key] = guardInlineMap(rest.slice(1, -1));
      continue;
    }
    out[key] = guardScalar(rest);
  }
  return out;
}
