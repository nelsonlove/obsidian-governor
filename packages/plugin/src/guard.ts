import { posix } from "node:path";

export interface GuardSettings { readOnly: boolean; allowlist: string[]; }

// Path-bearing argument keys across the tool surface.
// `output_folder` is obsidian_import_apple_notes' landing folder (every file
// that import creates lands under it) — recognized here so the kernel journals
// it as the operation's target and consults advisory locks over it, exactly
// like any other named path.
const PATH_KEYS = ["path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder"];
// Keys whose ARRAY values carry paths (refs = obsidian_resolve's batch input).
const ARRAY_PATH_KEYS = ["paths", "refs"];
// Defensive depth cap: MCP args arrive as parsed JSON, so nesting is bounded in
// practice and a cycle is impossible.
const MAX_DEPTH = 8;

// Recursively walk the args, applying `fn` to any non-empty string under a
// PATH_KEYS-named key (and string members of a `paths` array) at ANY depth, and
// returning args with those strings replaced by what `fn` returned.
//
// This is the ONE place the tool surface's path-argument shapes are known. It
// replaces per-shape clauses (flat keys, paths[], moves[{from,to}]): a future
// batch tool with a new nesting can't silently bypass the allowlist — or uid
// addressing — just because nobody added its shape here (#18). Over-collection
// is safe: worst case the guard over-blocks; silent under-collection is the
// failure mode this eliminates.
//
// Structurally sharing: any object or array none of whose descendants changed is
// returned BY REFERENCE, so a call that rewrites nothing hands back the very
// args it was given and callers can test for a no-op with `===`.
export function mapPaths(
  args: Record<string, unknown>,
  fn: (path: string) => string
): Record<string, unknown> {
  const seen = new Set<object>();

  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const mapped = walk(item, depth + 1);
        if (mapped !== item) changed = true;
        return mapped;
      });
      return changed ? out : value;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isPathKey = PATH_KEYS.includes(k) || ARRAY_PATH_KEYS.includes(k);
      let mapped: unknown;
      if (isPathKey && typeof v === "string" && v) {
        mapped = fn(v);
      } else if (isPathKey && Array.isArray(v)) {
        // Arrays under path keys: map string members, recurse the rest —
        // {path: [...]}, paths: [...], refs: [...], and paths: [{path}] all land.
        let inner = false;
        const arr = v.map((p) => {
          if (typeof p === "string" && p) {
            const m = fn(p);
            if (m !== p) inner = true;
            return m;
          }
          const m = walk(p, depth + 1);
          if (m !== p) inner = true;
          return m;
        });
        mapped = inner ? arr : v;
      } else {
        mapped = walk(v, depth + 1);
      }
      if (mapped !== v) changed = true;
      out[k] = mapped;
    }
    return changed ? out : value;
  }

  return walk(args, 0) as Record<string, unknown>;
}

/**
 * Every path the arguments name, in the order the walk meets them. Defined over
 * mapPaths so the collected set and the rewritable set can never drift apart.
 */
export function collectPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  mapPaths(args ?? {}, (p) => {
    out.push(p);
    return p;
  });
  return out;
}

/**
 * The subset of `paths` this session may be TOLD ABOUT — the allowlist applied
 * to disclosure rather than to action.
 *
 * It lives here, beside guardCall, because every disclosing surface needs the
 * identical rule and a second copy of it is a second thing to forget:
 * `obsidian_resolve_uid` filters the candidates AND the totals it reports (an
 * unfiltered index is a path — and cardinality — oracle for the area a
 * sandboxed session is excluded from), uid ADDRESSING decides
 * unresolved/ambiguous over the same visible set (a `uid_ambiguous` naming every
 * carrier disclosed exactly the paths the filter exists to hide), and
 * `obsidian_check_links` filters both halves of its drift report. One rule, so
 * the lookup, the addressing and the report can never disagree about what a
 * session can see.
 *
 * It is ALSO the read boundary for every tool that enumerates the vault without
 * being told where (slice 3.0). `guardCall` checks the paths an operation NAMES,
 * so an argument-less read — search, list, find-by-tag, a plugin's own query —
 * never met it: a session allowlisted to `Projects` could search the whole vault
 * and read a hidden note's contents out of the snippets. Those handlers now bound
 * their own iteration through this function, filtering BEFORE they read, exactly
 * as `obsidian_repoint_link` bounds its scan.
 *
 * No allowlist ⇒ everything is visible, and the SAME ARRAY comes back — callers
 * lean on that identity to skip building a filter set at all, so a call made
 * without an allowlist behaves byte-for-byte as it did before.
 */
export function visiblePaths(paths: string[], settings?: GuardSettings | null): string[] {
  if (!settings?.allowlist?.length) return paths;
  return paths.filter((path) => isVisible(path, settings));
}

/**
 * `visiblePaths` for ONE path — for the surfaces whose disclosure is a single
 * name rather than a list (the active note, a link's resolved destination).
 * Defined over the same guardCall so the one-path and many-path answers cannot
 * disagree.
 */
export function isVisible(path: string, settings?: GuardSettings | null): boolean {
  if (!settings?.allowlist?.length) return true;
  return !guardCall({ isMutating: false, args: { path }, settings });
}

// Returns a blocking reason, or null if the call is allowed.
export function guardCall(opts: {
  isMutating: boolean;
  args: Record<string, unknown>;
  settings: GuardSettings;
}): { code: string; message: string } | null {
  const { isMutating, args, settings } = opts;
  if (settings.readOnly && isMutating) {
    return { code: "read_only", message: "governor is in read-only mode; mutating tools are blocked. Turn it off in the plugin settings." };
  }
  if (settings.allowlist.length) {
    const norm = settings.allowlist.map((p) => p.replace(/\/+$/, "")).filter(Boolean);
    for (const raw of collectPaths(args)) {
      // Normalize first: collapse "." / ".." so a path like
      // "20-29 People/../00-09 System/x.md" can't pass the prefix check and
      // then resolve elsewhere inside Obsidian (allowlist traversal bypass).
      const p = posix.normalize(raw);
      const allowed =
        !p.startsWith("..") && norm.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
      if (!allowed) return { code: "out_of_allowlist", message: `path '${raw}' is outside the governor allowlist` };
    }
  }
  return null;
}
