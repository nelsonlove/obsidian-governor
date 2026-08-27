// The ONE agent-expressible disposition: `governance_submit_revision` (#101, phase 1 of #221).
//
// A revising agent — one whose note a human sent back with `acceptance-status: revising` and a
// `[!revision-request]` callout in the note BODY — resubmits its work: the status returns to
// `proposed`, the addressed `[!revision-request]` callout(s) are removed, and (when a `summary`
// is given) a `[!revision-report]` callout is inserted below the H1 for the reviewer to read and
// dispose of at review. The write lands in the pending channel like any other agent write: the
// kernel journals it, so the governance pane surfaces the note for human review.
//
// AUTHORITY (the #221 axis): this verb supplies a CANDIDATE; it decides nothing. It is declared
// as the single `authority: "agent"` descriptor in governor/kernel/dispositions.ts, and it is
// an ORDINARY GUARDED MUTATING TOOL — registered through the patched registrar in server.ts
// (`readOnlyHint: false`), so read-only mode, the path allowlist, the write queue, the write
// journal and the kernel args (`if_rev` / `idempotency_key` / `intent`) all bind at the standard
// interception point. Nothing here is pane machinery, and nothing in the pane can be reached
// from here.
//
// IT CAN NEVER WRITE ACCEPTANCE. Three independent layers make that true:
//   1. The only status value in this module is the literal `proposed`, written by
//      `setAcceptanceStatusProposed` (governor/kernel/revision.ts), which takes no value
//      parameter — there is no argument through which an accepted-family value could arrive.
//   2. The reviewer text/summary lands as `> `-quoted callout lines in the BODY, behind the
//      frontmatter fence recognized by the shared core recognizer — quoted lines cannot form a
//      frontmatter fence, so a hostile summary cannot smuggle an acceptance assertion into
//      properties.
//   3. Belt-and-suspenders: before writing, the (before, after) frontmatter transition is
//      re-checked with the SHARED accept guard (`acceptTransitionReason`, @vault-mcp/core — the
//      one definition of "asserts acceptance"); any accepted-family introduction/change refuses
//      with `Error [accept_forbidden]` and writes nothing.
//
// Obsidian-free by construction (the tools-pending-review.ts discipline): everything arrives
// through the injected `RevisionSource`, so the whole handler is headless-testable; only the
// adapter in server.ts touches `app`.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { acceptTransitionReason, parseGuardFrontmatter, AcceptForbiddenError } from "@vault-mcp/core";
import { ok, codedError } from "./helpers.js";
import { planSubmitRevision } from "../governor/kernel/revision.js";
import { SUBMIT_REVISION_TOOL } from "../governor/kernel/dispositions.js";

/** What the tool needs from the world — a read and a write, nothing else. */
export interface RevisionSource {
  /** Full note text, or null when the path names no note. */
  read(path: string): Promise<string | null>;
  /** Atomic full-content write of an EXISTING note (vault.process in production). */
  write(path: string, content: string): Promise<void>;
  /** Clock for the report/request date stamp. */
  now(): Date;
}

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/**
 * The note's acceptance-status as a trimmed string, however the key is cased/underscored.
 * A note carrying MULTIPLE status-key spellings that DISAGREE (e.g. `acceptance_status:
 * revising` beside `acceptance-status: accepted`) reads as null — an unrecognizable state must
 * refuse `not_revising` rather than let first-key-wins pick the permissive reading. Non-string
 * values likewise read as null.
 */
export function acceptanceStatusOf(fm: Record<string, unknown> | null): string | null {
  if (!fm) return null;
  const values: string[] = [];
  for (const key of Object.keys(fm)) {
    const k = key.trim().toLowerCase();
    if (k === "acceptance-status" || k === "acceptance_status") {
      const v = fm[key];
      if (typeof v !== "string") return null;
      values.push(v.trim());
    }
  }
  if (values.length === 0) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

/**
 * The belt-and-suspenders accept check the handler runs on every write: the (before, after)
 * frontmatter transition must be clean under the SHARED accept guard. Returns the refusal
 * reason, or null when the write may proceed. Exported so the perimeter test can drive it
 * directly with a hostile `after` — the handler itself can only ever produce `proposed`, so a
 * live call cannot exercise the refusing branch.
 */
export function revisionWriteRefusalReason(before: string, after: string): string | null {
  try {
    return acceptTransitionReason(parseGuardFrontmatter(before), parseGuardFrontmatter(after));
  } catch (e) {
    // parseGuardFrontmatter fails CLOSED on frontmatter it cannot confidently classify.
    return e instanceof AcceptForbiddenError ? e.message : String(e);
  }
}

export function registerGovernanceRevisionTool(server: McpServer, source: RevisionSource): void {
  server.registerTool(
    SUBMIT_REVISION_TOOL,
    {
      title: "Submit a revised note back for human review",
      description:
        "Resubmit a note a human sent back for changes (`acceptance-status: revising`). THE REVISING AGENT'S " +
        "CONTRACT: the human's feedback lives in the NOTE BODY — read the `[!revision-request]` callout(s) below " +
        "the H1, plus any other inline notes the reviewer left — NOT in any frontmatter field (there is no " +
        "`requested-changes` property). After you have revised the note (via the ordinary write tools), call this " +
        "to hand it back: it sets `acceptance-status: proposed`, removes the addressed `[!revision-request]` " +
        "callout(s), and — when `summary` is given — inserts a `> [!revision-report]` callout below the H1 " +
        "describing what you changed (the reviewer disposes of it at review). The note then lands in the pending " +
        "channel for human review like any other agent write. Refuses with Error [not_revising] when the note is " +
        "not in the revising state (nothing to submit). This tool cannot accept anything: it writes only " +
        "`proposed`, and the accept-forbidden guard re-checks the write — acceptance is a human gesture in the " +
        "review pane, never an API call. Pass `intent` (the standard kernel argument) if you want the write " +
        "journal to carry your summary of why.",
      inputSchema: {
        path: z.string().describe("Vault-relative path of the revising note (uid:/jd: addressing works)."),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "What you changed, for the reviewer — inserted into the note as a `[!revision-report]` callout " +
              "below the H1. Omit to resubmit without a report."
          ),
      },
      annotations: RW,
    },
    async ({ path, summary }: { path: string; summary?: string }) => {
      if (!path.toLowerCase().endsWith(".md")) {
        return codedError("invalid_path", `not a markdown note: ${path}`);
      }
      const before = await source.read(path);
      if (before === null) return codedError("not_found", `no note at ${path}`);

      // The status gate — read through the guard's own strict frontmatter reader, which fails
      // CLOSED (refuses) on YAML it cannot confidently classify rather than guessing.
      let fmBefore: Record<string, unknown> | null;
      try {
        fmBefore = parseGuardFrontmatter(before);
      } catch (e) {
        return codedError("accept_forbidden", (e as Error).message);
      }
      const status = acceptanceStatusOf(fmBefore);
      if (status !== "revising") {
        return codedError(
          "not_revising",
          `${path} has acceptance-status ${status === null ? "(none)" : `'${status}'`} — nothing to submit. ` +
            "Only a note a human marked 'revising' (via the review pane's Request changes) can be resubmitted."
        );
      }

      const date = source.now().toISOString().slice(0, 10);
      const plan = planSubmitRevision(before, { summary, date });
      if (plan === null) {
        // Unreachable after the status gate above except on a malformed-frontmatter race; fail closed.
        return codedError("not_revising", `${path} carries no acceptance-status to transition`);
      }

      // Belt-and-suspenders: the (before, after) transition through the SHARED accept guard.
      const refusal = revisionWriteRefusalReason(before, plan.content);
      if (refusal !== null) return codedError("accept_forbidden", refusal);

      await source.write(path, plan.content);
      return ok({
        path,
        acceptance_status: "proposed",
        removed_requests: plan.removedRequests,
        report_inserted: plan.reportInserted,
        // The guarded.ts effects convention: the journal records what actually changed.
        filesChanged: 1,
        files: [path],
      });
    }
  );
}

// ── governance_revisions: the read-side discovery listing ─────────────────────
//
// The submit tool above closes the round-trip; this tool OPENS it: a dispatcher
// asks "what revision work is waiting, and what did the human ask for?" without
// reading every note. Read-only, always-on beside obsidian_pending_review
// (server.ts), allowlist-filtered with the SAME isVisible rule every read
// surface uses. It confers nothing: the listing is derived from frontmatter the
// pane's request-changes gesture wrote and callouts in agent-readable bodies.

import { isVisible, type GuardSettings } from "../guard.js";
import { parseRevisionRequestCallouts, splitNote } from "../governor/kernel/revision.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const REVISIONS_CAP = 100;

/** Enumeration seam for the listing: every markdown note's path + cached frontmatter. */
export interface RevisionListSource {
  /** All markdown notes with their (metadata-cache) frontmatter; order unspecified. */
  listNotes(): Promise<Array<{ path: string; frontmatter: Record<string, unknown> | null }>>;
  /** Full note text, or null when the path names no note. */
  read(path: string): Promise<string | null>;
  /** Settings for the allowlist read boundary (absent ⇒ everything visible). */
  getSettings?: () => GuardSettings;
}

export function registerGovernanceRevisionsListTool(server: McpServer, source: RevisionListSource): void {
  server.registerTool(
    "governance_revisions",
    {
      title: "List notes awaiting revision",
      description:
        "Notes a human sent back for changes (`acceptance-status: revising`), with the `[!revision-request]` " +
        "callout text parsed out of each note's body — the request, its date, and the note's path — so a " +
        "dispatcher can read the human's asks at a glance and route the work. THE REVISING AGENT'S CONTRACT: " +
        "the feedback lives in the NOTE BODY (the callout plus anything else the human left inline); finish with " +
        "governance_submit_revision. Read-only; allowlist-filtered; capped at " + REVISIONS_CAP + ".",
      inputSchema: {
        folder: z.string().optional().describe("Only notes under this vault-relative folder prefix."),
      },
      annotations: RO,
    },
    async ({ folder }: { folder?: string }) => {
      const settings = source.getSettings?.();
      const all = await source.listNotes();
      const prefix = folder ? folder.replace(/\/+$/, "") + "/" : null;
      const revising = all.filter(
        (n) =>
          acceptanceStatusOf(n.frontmatter) === "revising" &&
          (!prefix || n.path.startsWith(prefix) || n.path === prefix.slice(0, -1)) &&
          (!settings || isVisible(n.path, settings))
      );
      const capped = revising.slice(0, REVISIONS_CAP);
      const items = [];
      for (const n of capped) {
        const text = await source.read(n.path);
        // A cache/disk race (note deleted between list and read) drops the row
        // rather than failing the listing.
        if (text === null) continue;
        const requests = parseRevisionRequestCallouts(splitNote(text).body);
        items.push({ path: n.path, requests });
      }
      return ok({
        count: items.length,
        total_revising: revising.length,
        truncated: revising.length > capped.length,
        items,
      });
    }
  );
}
