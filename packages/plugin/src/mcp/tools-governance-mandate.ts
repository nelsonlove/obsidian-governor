// MANDATE NEGOTIATION — the agent half of bounded delegation (WP9).
//
// Two verbs, both candidates-only in the #221 sense:
//
//   * `governance_mandate_draft` — author a mandate request (or a
//     counter-proposal narrowing an earlier one). A MUTATING registration:
//     it rides the patched registrar, so read-only mode blocks negotiating
//     authority from a read-only session, and the queue/journal record that
//     the request was made. It writes a DRAFT into the mandate store —
//     never a mandate. Activation is `authority: "human"` and exists only
//     as the review pane's gesture-gated control; there is deliberately no
//     tool for it, and no argument on this tool can produce one.
//
//   * `governance_mandates` — the read-side listing (drafts, active and
//     settled mandates, usage against budgets), so an agent can see what
//     delegation exists before drafting a duplicate, and can watch its own
//     budgets while working.
//
// ALLOWLIST DISCIPLINE (the lock-scope precedent): a sandboxed session may
// not draft over territory it cannot see — every scope.include entry must be
// visible under the active path allowlist, refused `out_of_allowlist`
// otherwise. The listing filters the same way: a mandate whose scope names
// hidden territory is COUNTED, never named (the list_scope_claims shape).
//
// Obsidian-free by construction: everything arrives through the injected
// source; the adapter lives in server.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, codedError } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import { openDraft, type MandateDraftV1 } from "../kernel/governance/mandates/draft.js";
import { MandateRefusedError, type MandateTerms, type MandateV1 } from "../kernel/governance/mandates/mandate.js";
import type { MandateUsage } from "../kernel/governance/mandates/budgets.js";
import type { ChangeClass } from "../kernel/governance/contracts/change-class.js";

/** What the tools need from the world — narrow store access plus identity facts. */
export interface MandateToolsSource {
  /** Record an authored draft (the store refuses duplicates and unknown counter targets). */
  draft(draft: MandateDraftV1, now: number): Promise<void>;
  allDrafts(): Promise<MandateDraftV1[]>;
  allMandates(): Promise<MandateV1[]>;
  usageOf(mandateId: string): Promise<MandateUsage>;
  /** The calling connection's session id, for the default delegate binding. */
  sessionId(): string | null;
  /** The calling client's self-asserted name — provenance, never authority. */
  client(): string | null;
  now(): number;
  /** Settings for the allowlist boundary (absent ⇒ everything visible). */
  getSettings?: () => GuardSettings;
}

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Every scope entry a draft names must be visible to the drafting session. */
function scopeRefusal(entries: string[], settings: GuardSettings | undefined): string | null {
  if (!settings) return null;
  for (const e of entries) {
    if (!isVisible(e, settings)) return e;
  }
  return null;
}

const idVersion = z.object({ id: z.string().min(1), version: z.string().min(1) });

export function registerMandateTools(server: McpServer, source: MandateToolsSource): void {
  server.registerTool(
    "governance_mandate_draft",
    {
      title: "Draft a mandate request (or counter-proposal)",
      description:
        "Author a mandate DRAFT — a bounded-delegation request the human can activate in the review pane. This " +
        "confers no authority: a draft is a candidate, activation is a human gesture, and there is no tool that " +
        "activates. State exact terms: purpose, scope (path prefixes), allowed change classes, the named " +
        "transformation and verification predicates (exact ids and versions), eligible actions, and budgets " +
        "(items, bytes, duration, proposals, failures) — unknown targets and open-ended verbs are not valid " +
        "delegation and are refused with the reason. Pass counter_of to NARROW an earlier draft (the counter " +
        "supersedes it; silence is never acceptance). The delegate binding defaults to this connection's own " +
        "session. Note: in the current release even an activated mandate runs in cohort-decision mode — " +
        "may_admit records intent for the WP10 promotion gate; it does not enable automatic admission.",
      inputSchema: {
        purpose: z.string().min(1).max(2000).describe("The intended outcome, in plain language."),
        scope_include: z.array(z.string().min(1)).min(1).describe("Vault-relative path prefixes the work may touch."),
        scope_exclude: z.array(z.string().min(1)).optional().describe("Prefixes carved OUT of the scope."),
        allowed_classes: z
          .array(z.string().min(1))
          .min(1)
          .describe("Change classes the mandate authorizes (encoding/presentation/representation/structural/content — authority is never delegable)."),
        transformation: idVersion.describe("The exact named transformation this mandate authorizes."),
        predicates: z.array(idVersion).min(1).describe("Required verification predicates, exact ids and versions."),
        eligible_actions: z.array(idVersion).min(1).describe("Exact registered action ids and versions the work may invoke."),
        budgets: z
          .object({
            max_items: z.number().int().positive(),
            max_bytes: z.number().int().positive(),
            max_duration_ms: z.number().int().positive(),
            max_proposals: z.number().int().positive(),
            max_failures: z.number().int().min(0),
          })
          .describe("Hard stops. Reaching a budget is a normal stop, not an error."),
        may_admit: z
          .boolean()
          .optional()
          .describe("Request prospective admission authority (D02 classes only; inert until the WP10 promotion gate)."),
        recovery_unit: z.enum(["item", "cohort"]).optional().describe("Reversal unit; default cohort."),
        delegate: z
          .object({ kind: z.enum(["session", "connection", "role"]), value: z.string().min(1) })
          .optional()
          .describe("Who the mandate binds. Default: this connection's session."),
        counter_of: z.string().optional().describe("Draft id this proposal narrows — the counter supersedes it."),
      },
      annotations: RW,
    },
    async (args: {
      purpose: string;
      scope_include: string[];
      scope_exclude?: string[];
      allowed_classes: string[];
      transformation: { id: string; version: string };
      predicates: Array<{ id: string; version: string }>;
      eligible_actions: Array<{ id: string; version: string }>;
      budgets: { max_items: number; max_bytes: number; max_duration_ms: number; max_proposals: number; max_failures: number };
      may_admit?: boolean;
      recovery_unit?: "item" | "cohort";
      delegate?: { kind: "session" | "connection" | "role"; value: string };
      counter_of?: string;
    }) => {
      const settings = source.getSettings?.();
      const hidden = scopeRefusal(args.scope_include, settings);
      if (hidden !== null) {
        return codedError("out_of_allowlist", `scope entry '${hidden}' is outside this session's path allowlist — a sandboxed session cannot draft over territory it cannot see`);
      }
      let delegate = args.delegate ?? null;
      if (delegate === null) {
        const sid = source.sessionId();
        if (sid === null) {
          return codedError("no_session", "no delegate given and this connection has no session to bind — pass `delegate` explicitly");
        }
        delegate = { kind: "session", value: sid };
      }
      const terms: MandateTerms = {
        purpose: args.purpose,
        delegate,
        scope: { include: args.scope_include, exclude: args.scope_exclude ?? [] },
        allowedClasses: args.allowed_classes as ChangeClass[],
        transformation: args.transformation,
        predicates: args.predicates,
        eligibleActions: args.eligible_actions,
        requiredDurability: "replayable",
        budgets: {
          maxItems: args.budgets.max_items,
          maxBytes: args.budgets.max_bytes,
          maxDurationMs: args.budgets.max_duration_ms,
          maxProposals: args.budgets.max_proposals,
          maxFailures: args.budgets.max_failures,
        },
        admission: { mayProduce: true, mayAdmit: args.may_admit === true },
        recovery: { unit: args.recovery_unit ?? "cohort" },
      };
      const now = source.now();
      try {
        const draft = openDraft(
          { authoredBy: { sessionId: source.sessionId(), client: source.client() }, terms, counterOf: args.counter_of ?? null },
          now
        );
        await source.draft(draft, now);
        return ok({
          draft_id: draft.id,
          status: draft.status,
          counter_of: draft.counterOf,
          delegate: draft.terms.delegate,
          expires_after_activation_ms: draft.terms.budgets.maxDurationMs,
          note: "This is a request, not authority. A human reviews and activates it (or not) in the review pane's Mandates section.",
        });
      } catch (e) {
        if (e instanceof MandateRefusedError) return codedError(e.code, e.message);
        throw e;
      }
    }
  );

  server.registerTool(
    "governance_mandates",
    {
      title: "List mandate drafts and mandates",
      description:
        "The delegation landscape: open/settled drafts and every mandate with its status, terms summary, and usage " +
        "against budgets. Read-only. Under a path allowlist, drafts/mandates whose scope names territory outside " +
        "the allowlist are counted, never detailed.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      const settings = source.getSettings?.();
      const visible = (scope: { include: string[] }) => scopeRefusal(scope.include, settings) === null;
      const drafts = await source.allDrafts();
      const mandates = await source.allMandates();
      const visibleDrafts = drafts.filter((d) => visible(d.terms.scope));
      const visibleMandates = mandates.filter((m) => visible(m.terms.scope));
      const items = [];
      for (const m of visibleMandates) {
        items.push({
          mandate_id: m.id,
          status: m.status,
          purpose: m.terms.purpose,
          delegate: m.terms.delegate,
          scope: m.terms.scope,
          allowed_classes: m.terms.allowedClasses,
          transformation: m.terms.transformation,
          may_admit: m.terms.admission.mayAdmit,
          activated_at: m.activatedAt,
          expires_at: m.expiresAt,
          supersedes: m.supersedes,
          usage: await source.usageOf(m.id),
          budgets: m.terms.budgets,
        });
      }
      return ok({
        drafts: visibleDrafts.map((d) => ({
          draft_id: d.id,
          status: d.status,
          purpose: d.terms.purpose,
          delegate: d.terms.delegate,
          scope: d.terms.scope,
          counter_of: d.counterOf,
          requested_at: d.requestedAt,
        })),
        mandates: items,
        hidden_drafts: drafts.length - visibleDrafts.length,
        hidden_mandates: mandates.length - visibleMandates.length,
      });
    }
  );
}
