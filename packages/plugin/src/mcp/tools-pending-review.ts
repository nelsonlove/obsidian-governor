// A READ-ONLY view of Stewardship's human-review queue (slice B3b).
//
// Stewardship (a separate plugin) rewrites a read-only index at
// `<config dir>/plugins/stewardship/pending-index.json` on every review-queue
// refresh. This tool exposes a READ of that index to agents, so an agent can
// see which notes are pending human review and avoid stepping on one. It is the
// same data Stewardship already surfaces in its own pane — nothing here is a new
// source of truth, and NOTHING here changes review state.
//
// HARD invariant — read-only, no accept surface. This tool ONLY reports
// review status that another plugin published: it performs no writes and exposes
// no way to change acceptance or advance a baseline (`readOnlyHint: true`; the
// "accept verb is in no API" scar). It reports pending-ness; it cannot accept.
//
// Allowlist-aware, deliberately — exactly like tools-uid.ts. The index is
// written from the whole vault, so an allowlisted session that could learn about
// pending notes in territory it cannot read would have a path oracle for the
// area it is sandboxed out of. Every returned path is therefore filtered through
// the SAME guard the uid/read tools use (`isVisible` — the one-path form of
// `visiblePaths`, guard.ts), BEFORE it is reported.
//
// Graceful/degrade by construction. A missing file (Stewardship not installed,
// or never refreshed), an unparseable one, or a schema-drifted one all read as
// an EMPTY pending list, never an error — the review queue's absence must never
// break an agent's workflow. Unknown fields are ignored; a missing or non-array
// `pending` is empty.
//
// Imports nothing from `obsidian` in the pure surface (the parse + the tool):
// the index arrives through an injected `PendingReviewSource`, so this module is
// unit-testable headlessly like tools-uid.ts. Only `obsidianPendingReviewSource`
// touches `app`, and it is the one adapter the live server wires in.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * Where Stewardship publishes its review-queue index, relative to the vault
 * CONFIG dir — built from `app.vault.configDir` (not a hardwired `.obsidian`),
 * so a vault with a renamed config dir still resolves, matching how the journal
 * and install-id build their own plugin-dir paths.
 */
export const PENDING_INDEX_REL = "plugins/stewardship/pending-index.json";

/**
 * The one thing this tool needs from the world: the raw text of the index file,
 * or `null` when it is absent/unreadable. A narrow duck type (like
 * InstallIdAdapter/JournalAdapter) keeps the tool obsidian-free and headlessly
 * testable, and structurally denies it any write/delete reach.
 */
export interface PendingReviewSource {
  read(): Promise<string | null>;
}

/**
 * The live adapter: reads `<config dir>/plugins/stewardship/pending-index.json`
 * through Obsidian's vault adapter. Absent file ⇒ `null`; ANY read error is
 * swallowed to `null` too, because a broken read must degrade to "empty queue",
 * never throw into the tool.
 */
export function obsidianPendingReviewSource(app: App): PendingReviewSource {
  const path = `${app.vault.configDir}/${PENDING_INDEX_REL}`;
  return {
    async read() {
      try {
        const adapter = app.vault.adapter;
        if (!(await adapter.exists(path))) return null;
        return await adapter.read(path);
      } catch {
        return null;
      }
    },
  };
}

export interface PendingReviewToolsCtx {
  source: PendingReviewSource;
  /** The guard's settings — the allowlist filter below. Absent ⇒ unfiltered. */
  getSettings?: () => GuardSettings;
}

/**
 * One pending-review entry, as reported. Only `path` is required (an entry with
 * no path cannot be allowlist-filtered, so it is DROPPED — it can never be
 * returned unfiltered). The rest are Stewardship's own descriptive fields,
 * passed through verbatim WHEN present and well-typed; unknown fields are
 * ignored (schema-drift tolerance).
 */
export interface PendingEntry {
  path: string;
  status?: string;
  agent?: string;
  op?: string;
  when?: string;
  writeCount?: number;
}

/**
 * Parse the index text into entries, tolerating every kind of drift: non-JSON,
 * a non-object root, a missing or non-array `pending`, non-object items, and
 * unknown fields. Anything unexpected collapses to an empty list rather than
 * throwing — the tool's graceful-degrade guarantee lives here, so the handler
 * stays a straight-line read + filter.
 */
export function parsePendingIndex(raw: string | null): PendingEntry[] {
  if (raw == null) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const list = (doc as { pending?: unknown }).pending;
  if (!Array.isArray(list)) return [];

  const out: PendingEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    // Unfilterable ⇒ dropped: with no path we could neither allowlist-check it
    // nor tell the caller what note it names.
    if (typeof rec.path !== "string" || rec.path.length === 0) continue;
    const entry: PendingEntry = { path: rec.path };
    if (typeof rec.status === "string") entry.status = rec.status;
    if (typeof rec.agent === "string") entry.agent = rec.agent;
    if (typeof rec.op === "string") entry.op = rec.op;
    if (typeof rec.when === "string") entry.when = rec.when;
    if (typeof rec.writeCount === "number") entry.writeCount = rec.writeCount;
    out.push(entry);
  }
  return out;
}

export function registerPendingReviewTools(server: McpServer, ctx: PendingReviewToolsCtx): void {
  server.registerTool(
    "obsidian_pending_review",
    {
      title: "List notes pending human review",
      description:
        "List the notes currently pending human review, as published by the Stewardship plugin's review queue. Each " +
        "entry carries the note's `path` plus whatever descriptive fields Stewardship recorded (`status`, `agent`, " +
        "`op`, `when`, `writeCount`). Use it to AVOID editing a note that a human is about to review — it is advisory, " +
        "it blocks nothing. Read-only: this reports review status that Stewardship published; it cannot accept, reject, " +
        "or otherwise change a note's review state (there is no accept verb in any API). Returns an empty list when " +
        "Stewardship is not installed or has not refreshed its queue. Only notes within your path allowlist are reported.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      // Every failure mode degrades to an empty list — a missing/broken review
      // queue must never surface as a tool error. The source already swallows
      // read errors to null and parsePendingIndex swallows parse/shape errors;
      // this outer guard covers anything unforeseen (e.g. a throwing filter) so
      // the tool can NEVER fail. It also means it never leaks an error string.
      try {
        const raw = await ctx.source.read();
        const settings = ctx.getSettings?.();
        // Allowlist filter — the SAME rule the uid/read tools use. `isVisible`
        // is the one-path form of `visiblePaths` (guard.ts): with no allowlist
        // it returns true for everything, so an unsandboxed session sees the
        // whole queue; under an allowlist a pending note outside the visible set
        // is dropped, so this tool is no path oracle for territory the session
        // cannot read.
        const pending = parsePendingIndex(raw).filter((e) => isVisible(e.path, settings));
        return ok({ pending, count: pending.length });
      } catch {
        return ok({ pending: [], count: 0 });
      }
    }
  );
}
