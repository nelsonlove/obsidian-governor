// plan.ts — the triage instance's pure PLANNING core (#221 phase 2, reshaped
// by #241 phase 3), the scheme-mutations shape (#214): the tool layer never
// recomputes "what should happen to this note" — it asks `planDispose` for
// either a typed refusal or a plan, then (only on `dry_run: false`) executes
// the plan's steps through the injected source. Pure over its inputs: no
// vault, no Obsidian, no clock.
//
// Phase 3: the planner runs over the MERGED disposition table (built-in
// primitives ∪ human-declared rows — descriptors.ts's `mergedDispositionsOf`)
// and enforces the configured move whitelist/blacklist on every planned move
// destination (`moveDenied`, exported so the tool layer can RE-CHECK it at
// apply time, per the ruling). A `choice` row plans to run its human-bound
// QuickAdd choice — the planner marks it, and the TOOL layer owns the
// cannot-dry-run refusal (dry_run is a tool argument, not a plan input).

import { mergedById, mergedDispositionsOf, type MergedDisposition } from "./descriptors.js";
import type { TriageConfig } from "./config.js";
import { inboxFolderOf } from "./inbox.js";

export interface DisposeRefusal {
  code:
    | "unknown_disposition"
    | "not_inbox"
    | "target_required"
    | "target_unsupported"
    | "invalid_target"
    | "patch_unresolved"
    | "move_denied";
  message: string;
}

/** What a disposition will do — at most one frontmatter patch, then at most
 * one move or trash, OR one bound-choice execution. Order is load-bearing and
 * mirrors the legacy flow: frontmatter first (while the path is stable), then
 * the move. */
export interface DisposePlan {
  disposition: MergedDisposition;
  /** The nearest enclosing inbox folder the note qualifies under. */
  inbox: string;
  /** The frontmatter patch to apply, or null when the disposition has none /
   * the configured patch is empty. */
  patch: Record<string, unknown> | null;
  /** The move destination (full note path), or null for trash / in-place /
   * choice. */
  moveTo: string | null;
  /** Trash instead of move. */
  trash: boolean;
  /** The QuickAdd choice binding to execute (choice rows), or null. */
  choice: string | null;
}

export interface DisposeInput {
  path: string;
  disposition: string;
  target?: string;
  config: TriageConfig;
}

function basenameOf(path: string): string {
  const segs = path.split("/");
  return segs[segs.length - 1];
}

/** A `target_path` argument that cannot name a destination folder. (The plan
 * input's field is `target`; the WIRE name is `target_path` — a guard-recognized
 * path key, see tools.ts. Messages use the wire name, which is what a caller
 * can act on.) */
function targetProblem(target: string): string | null {
  if (target.trim() === "") return "target_path must be a non-empty folder path";
  if (target !== target.trim()) return "target_path must not have leading/trailing whitespace";
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return "target_path must be a vault-relative folder path, not absolute";
  const trimmed = target.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return "target_path must not contain empty, '.' or '..' path segments";
  }
  return null;
}

/** Segment-boundary prefix test: `folder` is `prefix` itself or inside it. */
function underPrefix(folder: string, prefix: string): boolean {
  return folder === prefix || folder.startsWith(`${prefix}/`);
}

/**
 * The configured move whitelist/blacklist verdict for a destination FOLDER —
 * the reason it is denied, or null. Blacklist beats whitelist (over-denying
 * is safe; the cli-policy precedent); an empty whitelist means "any".
 * Enforced at PLAN time by `planDispose` and RE-CHECKED at APPLY time by the
 * tool layer, alongside the existing allowlist re-check.
 */
export function moveDenied(destFolder: string, config: TriageConfig): string | null {
  const hit = config.moveBlacklist.find((p) => underPrefix(destFolder, p));
  if (hit !== undefined) {
    return `destination '${destFolder}' is under the configured moveBlacklist prefix '${hit}'`;
  }
  if (config.moveWhitelist.length > 0 && !config.moveWhitelist.some((p) => underPrefix(destFolder, p))) {
    return (
      `destination '${destFolder}' is outside every configured moveWhitelist prefix ` +
      `(${config.moveWhitelist.map((p) => JSON.stringify(p)).join(", ")})`
    );
  }
  return null;
}

/**
 * Plan one disposition over the merged table. Refusals are TYPED and computed
 * identically for dry-run and apply — a dry-run that would refuse reports the
 * same refusal the apply would. (The one tool-layer-owned refusal is the
 * choice-row dry-run block: whether the caller asked to preview is not a
 * property of the plan.)
 */
export function planDispose(input: DisposeInput): { refusal: DisposeRefusal } | { plan: DisposePlan } {
  const table = mergedDispositionsOf(input.config);
  const d = mergedById(table, input.disposition);
  if (!d) {
    return {
      refusal: {
        code: "unknown_disposition",
        message:
          `unknown disposition '${input.disposition}' — the merged table declares: ` +
          table.map((t) => t.id).join(", "),
      },
    };
  }

  const inbox = inboxFolderOf(input.path, input.config.inboxMarkers);
  if (inbox === null) {
    return {
      refusal: {
        code: "not_inbox",
        message:
          `'${input.path}' is not an inbox item — no ancestor folder matches the configured inbox markers ` +
          `(${input.config.inboxMarkers.map((m) => JSON.stringify(m)).join(", ")}), or the note is the inbox's own folder note`,
      },
    };
  }

  // ── target policy ─────────────────────────────────────────────────────────
  let destFolder: string | null = null;
  if (d.targetPolicy === "none") {
    if (input.target !== undefined) {
      const does =
        d.action === "trash" ? "trashes" : d.action === "choice" ? "runs its bound choice on" : "edits";
      return {
        refusal: {
          code: "target_unsupported",
          message: `disposition '${d.id}' takes no target_path — it ${does} the note where it is`,
        },
      };
    }
  } else if (input.target !== undefined) {
    const bad = targetProblem(input.target);
    if (bad) return { refusal: { code: "invalid_target", message: bad } };
    destFolder = input.target.replace(/\/+$/, "");
  } else if (d.targetPolicy === "required") {
    return {
      refusal: {
        code: "target_required",
        message: `disposition '${d.id}' requires a target_path folder — it moves the note somewhere only the caller can name`,
      },
    };
  } else {
    // config-or-target: fall back to the row's declared destination.
    destFolder = d.destination;
  }

  // ── the effective patch ───────────────────────────────────────────────────
  // A declared row carries its own patch; the built-in `stamp` resolves from
  // config. EVERY stamp with an empty effective patch refuses typed — an
  // empty stamp writes nothing, and that call is a mistake, not a no-op
  // success. (Declared stamp rows are guaranteed a non-empty patch by
  // config-time validation; the empty case reaches here only through the
  // built-in's stampFrontmatter or the DEFAULT escalate row's blanked
  // escalateFrontmatter.)
  let patch: Record<string, unknown> | null = d.patch;
  if (d.builtin && d.action === "stamp") {
    patch = Object.keys(input.config.stampFrontmatter).length > 0 ? input.config.stampFrontmatter : null;
  }
  if (d.action === "stamp" && patch === null) {
    return {
      refusal: {
        code: "patch_unresolved",
        message: d.builtin
          ? "built-in 'stamp' has no configured patch — set modules.triage.config.stampFrontmatter, or declare " +
            "a stamp disposition row with its own patch"
          : `disposition '${d.id}' has an empty patch — nothing would change; configure its patch ` +
            "(for the default escalate row: modules.triage.config.escalateFrontmatter)",
      },
    };
  }

  // ── the plan ──────────────────────────────────────────────────────────────
  let moveTo: string | null = null;
  if (destFolder !== null) {
    // Move whitelist/blacklist — plan-time enforcement (re-checked at apply).
    const denied = moveDenied(destFolder, input.config);
    if (denied) return { refusal: { code: "move_denied", message: denied } };
    moveTo = `${destFolder}/${basenameOf(input.path)}`;
    if (moveTo === input.path) {
      return {
        refusal: { code: "invalid_target", message: `the note is already in '${destFolder}' — nothing to move` },
      };
    }
  }
  return {
    plan: {
      disposition: d,
      inbox,
      patch,
      moveTo,
      trash: d.action === "trash",
      choice: d.action === "choice" ? d.choice : null,
    },
  };
}

/**
 * Apply a frontmatter patch to a live frontmatter object, in place (the shape
 * `processFrontMatter` hands over). Semantics — documented in the module doc
 * and the tool description:
 *
 *   - an ARRAY value UNIONS with the existing value (existing scalars are
 *     promoted to a one-element array; duplicates are not re-added) — the
 *     legacy flow's tags-append behavior;
 *   - any other value SETS the key, overwriting an existing value.
 */
export function applyFrontmatterPatch(fm: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    // Defense in depth beside config.ts's loud refusal: object-machinery keys
    // are never written (assigning `__proto__` would silently rewire the
    // frontmatter object rather than set a property).
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (Array.isArray(value)) {
      const existing = fm[key];
      const arr = Array.isArray(existing) ? existing : existing === undefined || existing === null ? [] : [existing];
      for (const item of value) if (!arr.includes(item)) arr.push(item);
      fm[key] = arr;
    } else {
      fm[key] = value;
    }
  }
}
