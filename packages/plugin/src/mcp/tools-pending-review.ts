// A READ-ONLY view of the governance module's human-review queue (slice B3b; repointed #261).
//
// The governance module (src/governance/wiring.ts) publishes a read-only index at
// `<plugin dir>/governance/pending-index.json` — beside the acceptance log — on every
// review-queue refresh (kernel/governance/pending-index.ts is the serializer). This tool
// exposes a READ of that index to agents, so an agent can see which notes are pending human
// review and avoid stepping on one. It is the same data the review pane shows — nothing here
// is a new source of truth, and NOTHING here changes review state.
//
// HISTORY (#261): this tool originally read the RETIRED standalone Stewardship plugin's
// index at `<config dir>/plugins/stewardship/pending-index.json`. That plugin was
// decommissioned (#164) and nothing published the file any more, so the tool returned
// `{pending: [], count: 0}` unconditionally — absence read as emptiness, the silent-zero
// class (#133/#142) on the review surface itself. Two fixes, both here to stay:
//   1. the index is published by the governance module at a vault-mcp-owned path, and
//   2. an ABSENT or UNREADABLE index is an EXPLICIT `published: false` + `reason` in the
//      response — never a bare empty queue. Empty-and-published stays `published: true,
//      count: 0` (a genuinely clear queue).
//
// HARD invariant — read-only, no accept surface. This tool ONLY reports
// review status that the governance module published: it performs no writes and exposes
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
// Degrade is EXPLICIT, never silent: a missing file (governance module disabled, or never
// refreshed) or an unparseable/schema-broken one reads as `published: false` with a reason —
// still never a tool error (the review queue's absence must never break an agent's
// workflow). Unknown fields within a well-formed index are ignored; entries are tolerated
// individually (drift tolerance), but a root that carries no recognizable `pending` array
// is UNREADABLE, not empty.
//
// Imports nothing from `obsidian` in the pure surface (the parse + the tool):
// the index arrives through an injected `PendingReviewSource`, so this module is
// unit-testable headlessly like tools-uid.ts. Only `obsidianPendingReviewSource`
// touches `app`, and it is the one adapter the live server wires in.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok } from "./helpers.js";
import { PLUGIN_ID } from "../id-migration.js";
import { isVisible, type GuardSettings } from "../guard.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * Where the governance module publishes its review-queue index, relative to the vault-mcp
 * PLUGIN dir (`<config dir>/plugins/governor` unless Obsidian reports otherwise) — built
 * from `app.vault.configDir` (not a hardwired `.obsidian`), so a vault with a renamed config
 * dir still resolves, matching how the journal and install-id build their own plugin-dir
 * paths. Must agree with `pendingIndexPath` in src/governance/wiring.ts.
 */
export const PENDING_INDEX_REL = "governance/pending-index.json";

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
 * The live adapter: reads `<plugin dir>/governance/pending-index.json` through Obsidian's
 * vault adapter. `pluginDir` comes from the host (manifest.dir); absent, the default
 * `<config dir>/plugins/<PLUGIN_ID>` is used. Absent file ⇒ `null`; ANY read error is
 * swallowed to `null` too — the TOOL then reports the explicit not-published state, so a
 * broken read degrades to a visible "not published", never a throw and never a silent empty.
 */
export function obsidianPendingReviewSource(app: App, pluginDir?: string): PendingReviewSource {
  const dir = pluginDir ?? `${app.vault.configDir}/plugins/${PLUGIN_ID}`;
  const path = `${dir}/${PENDING_INDEX_REL}`;
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
 * returned unfiltered). The rest are the governance module's own descriptive fields,
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
 * STRICT parse: entries when the text is a recognizable index, `null` when it is not
 * (non-JSON, non-object root, missing/non-array `pending`) — so the tool can tell an
 * UNREADABLE index apart from a genuinely EMPTY one (#261's explicitness requirement).
 * Individual entries stay drift-tolerant: non-object items and unfilterable (path-less)
 * entries are dropped, unknown/mistyped fields ignored.
 */
export function parsePendingIndexStrict(raw: string): PendingEntry[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const list = (doc as { pending?: unknown }).pending;
  if (!Array.isArray(list)) return null;

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

/**
 * Lenient parse (kept for compatibility): anything unrecognizable collapses to an empty
 * list. The TOOL no longer uses this shape-blind form — it distinguishes absent/unreadable
 * via `parsePendingIndexStrict` — but external callers/tests of the pure parser keep the
 * historical tolerant behavior here.
 */
export function parsePendingIndex(raw: string | null): PendingEntry[] {
  if (raw == null) return [];
  return parsePendingIndexStrict(raw) ?? [];
}

export function registerPendingReviewTools(server: McpServer, ctx: PendingReviewToolsCtx): void {
  server.registerTool(
    "obsidian_pending_review",
    {
      title: "List notes pending human review",
      description:
        "List the notes currently pending human review, as published by vault-mcp's governance module (the review " +
        "queue the governance pane shows). Each entry carries the note's `path` plus the recorded descriptive fields " +
        "(`status`, `agent`, `op`, `when`, `writeCount`). Use it to AVOID editing a note that a human is about to " +
        "review — it is advisory, it blocks nothing. Read-only: this reports review status the governance module " +
        "published; it cannot accept, reject, or otherwise change a note's review state (there is no accept verb in " +
        "any API). `published: false` (with a `reason`) means the index is absent or unreadable — the governance " +
        "module is disabled or has not refreshed — which is NOT the same as an empty queue (`published: true, " +
        "count: 0`). Only notes within your path allowlist are reported.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      // Every failure mode degrades to an EXPLICIT state — a missing/broken review queue must
      // never surface as a tool error, but must never masquerade as an empty queue either
      // (#261; the #133/#142 silent-zero class). The source swallows read errors to null;
      // the strict parse reports unrecognizable text as null; this outer guard covers
      // anything unforeseen (e.g. a throwing filter) so the tool can NEVER fail. It also
      // means it never leaks an error string.
      try {
        const raw = await ctx.source.read();
        if (raw == null) {
          return ok({
            published: false,
            reason: "index-not-published — governance module disabled, not yet refreshed, or index unreadable",
            pending: [],
            count: 0,
          });
        }
        const entries = parsePendingIndexStrict(raw);
        if (entries == null) {
          return ok({
            published: false,
            reason: "index-unreadable — file exists but is not a recognizable pending index",
            pending: [],
            count: 0,
          });
        }
        const settings = ctx.getSettings?.();
        // Allowlist filter — the SAME rule the uid/read tools use. `isVisible`
        // is the one-path form of `visiblePaths` (guard.ts): with no allowlist
        // it returns true for everything, so an unsandboxed session sees the
        // whole queue; under an allowlist a pending note outside the visible set
        // is dropped, so this tool is no path oracle for territory the session
        // cannot read.
        const pending = entries.filter((e) => isVisible(e.path, settings));
        return ok({ published: true, pending, count: pending.length });
      } catch {
        return ok({ published: false, reason: "error", pending: [], count: 0 });
      }
    }
  );
}
