// plan.ts — the triage instance's pure PLANNING core (#221 phase 2), the
// scheme-mutations shape (#214): the tool layer never recomputes "what should
// happen to this note" — it asks `planDispose` for either a typed refusal or
// a plan, then (only on `dry_run: false`) executes the plan's steps through
// the injected source. Pure over its inputs: no vault, no Obsidian, no clock.

import {
  triageDispositionById,
  type TriageDispositionDescriptor,
  type TriageDispositionId,
} from "./descriptors.js";
import type { TriageConfig } from "./config.js";
import { inboxFolderOf } from "./inbox.js";

export interface DisposeRefusal {
  code:
    | "unknown_disposition"
    | "not_inbox"
    | "target_required"
    | "target_unsupported"
    | "destination_unresolved"
    | "invalid_target";
  message: string;
}

/** What a disposition will do — at most one frontmatter patch, then at most
 * one move or trash. Order is load-bearing and mirrors the legacy flow:
 * frontmatter first (while the path is stable), then the move. */
export interface DisposePlan {
  disposition: TriageDispositionDescriptor;
  /** The nearest enclosing inbox folder the note qualifies under. */
  inbox: string;
  /** The frontmatter patch to apply, or null when the disposition has none /
   * the configured patch is empty. */
  patch: Record<string, unknown> | null;
  /** The move destination (full note path), or null for trash / in-place. */
  moveTo: string | null;
  /** Trash instead of move ("discard"). */
  trash: boolean;
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

/** A `target` argument that cannot name a destination folder. */
function targetProblem(target: string): string | null {
  if (target.trim() === "") return "target must be a non-empty folder path";
  if (target !== target.trim()) return "target must not have leading/trailing whitespace";
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return "target must be a vault-relative folder path, not absolute";
  const trimmed = target.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return "target must not contain empty, '.' or '..' path segments";
  }
  return null;
}

/**
 * Plan one disposition. Refusals are TYPED and computed identically for
 * dry-run and apply — a dry-run that would refuse reports the same refusal
 * the apply would.
 */
export function planDispose(input: DisposeInput): { refusal: DisposeRefusal } | { plan: DisposePlan } {
  const d = triageDispositionById(input.disposition);
  if (!d) {
    return {
      refusal: {
        code: "unknown_disposition",
        message: `unknown disposition '${input.disposition}' — the set is closed (see the tool description)`,
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
      return {
        refusal: {
          code: "target_unsupported",
          message: `disposition '${d.id}' takes no target — it ${d.action === "trash" ? "trashes" : "edits"} the note where it is`,
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
        message: `disposition '${d.id}' requires a target folder — it moves the note somewhere only the caller can name`,
      },
    };
  } else {
    // config-or-target: fall back to the configured destination.
    const configured = d.destinationKey ? input.config[d.destinationKey] : "";
    if (configured === "") {
      return {
        refusal: {
          code: "destination_unresolved",
          message:
            `disposition '${d.id}' has no destination: pass a target folder or configure ` +
            `modules.triage.config.${d.destinationKey} `,
        },
      };
    }
    destFolder = configured;
  }

  // ── the plan ──────────────────────────────────────────────────────────────
  const rawPatch = d.frontmatterKey ? input.config[d.frontmatterKey] : null;
  const patch = rawPatch && Object.keys(rawPatch).length > 0 ? rawPatch : null;
  let moveTo: string | null = null;
  if (d.action === "move") {
    moveTo = `${destFolder}/${basenameOf(input.path)}`;
    if (moveTo === input.path) {
      return {
        refusal: { code: "invalid_target", message: `the note is already in '${destFolder}' — nothing to move` },
      };
    }
  }
  return { plan: { disposition: d, inbox, patch, moveTo, trash: d.action === "trash" } };
}

/**
 * Apply a frontmatter patch to a live frontmatter object, in place (the shape
 * `processFrontMatter` hands over). Semantics — documented in the module doc
 * and the tool description:
 *
 *   - an ARRAY value UNIONS with the existing value (existing scalars are
 *     promoted to a one-element array; duplicates are not re-added) — the
 *     legacy flow's tags-append behavior;
 *   - any other value SETS the key, overwriting an existing value — the
 *     legacy defer-to-someday `status = "someday"` behavior. (The legacy
 *     convert-to-action used set-if-absent for status/priority; the uniform
 *     overwrite is a documented, deliberate simplification.)
 */
export function applyFrontmatterPatch(fm: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
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

export type { TriageDispositionId };
