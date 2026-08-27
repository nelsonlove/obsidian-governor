// MANDATE UI WIRING — the human half of bounded delegation (WP9).
//
// The pane's Mandates section calls THESE three verbs, and nothing else
// does: `activate` (the ONE grant), `decline`, `revoke`. Every verb takes a
// gestureRef parameter that only runGuardedDisposition mints — the same
// perimeter admission uses. The MCP surface has no route here: agents draft
// (tools-governance-mandate.ts); humans decide.
//
// AMENDMENT BY REPLACEMENT, made concrete: activating a draft that COUNTERS
// an already-granted draft supersedes the earlier grant in the same gesture
// — the one click that grants the replacement retires the replaced. This is
// derived (counterOf chain → active mandate), never guessed: an unrelated
// draft's activation supersedes nothing.
//
// SESSION ATTACHMENT: when the granted mandate binds a session, activation
// also records the binding on the session store (`mandated` event), so the
// producer side can resolve "which mandate governs this session" from the
// durable record. An attach that fails (session closed since drafting) does
// NOT undo the grant — the mandate is active, the dead session simply can
// never present the matching identity — but the outcome SAYS so.

import { activateDraft, MandateRefusedError, type MandateRefusalCode, type MandateV1 } from "../kernel/mandates/mandate.js";
import type { MandateDraftV1 } from "../kernel/mandates/draft.js";
import type { MandateStore } from "../kernel/mandates/lifecycle.js";
import type { MandateUsage } from "../kernel/mandates/budgets.js";

export type MandateActOutcome =
  | { ok: true; mandateId: string; supersededMandateId: string | null; sessionAttachWarning: string | null }
  | { ok: false; code: MandateRefusalCode | "mandate_error"; detail: string };

export interface MandateUiDeps {
  /** All drafts, open first, newest first within status. */
  drafts(): Promise<MandateDraftV1[]>;
  /** All mandates with folded usage, active first, newest first within status. */
  mandates(): Promise<Array<{ mandate: MandateV1; usage: MandateUsage }>>;
  /** THE grant. gestureRef comes from runGuardedDisposition — no other mint exists. */
  activate(draftId: string, gestureRef: string): Promise<MandateActOutcome>;
  decline(draftId: string, reason: string, gestureRef: string): Promise<MandateActOutcome>;
  revoke(mandateId: string, reason: string, gestureRef: string): Promise<MandateActOutcome>;
}

export interface BuildMandateUiDeps {
  store: MandateStore;
  /** The session store's attach edge; null when sessions are not wired. */
  attachSessionMandate: ((sessionId: string, mandateId: string, now: number) => Promise<void>) | null;
  /** The configured human identity the grant records as principal. */
  principal: () => string;
  now?: () => number;
}

const STATUS_ORDER: Record<string, number> = { open: 0, active: 0, revoked: 2, expired: 2, exhausted: 2, superseded: 3, activated: 1, declined: 3 };

export function buildMandateUi(deps: BuildMandateUiDeps): MandateUiDeps {
  const now = deps.now ?? (() => Date.now());

  const fail = (e: unknown): MandateActOutcome =>
    e instanceof MandateRefusedError
      ? { ok: false, code: e.code, detail: e.message }
      : { ok: false, code: "mandate_error", detail: e instanceof Error ? e.message : String(e) };

  return {
    async drafts() {
      const all = await deps.store.allDrafts();
      return all.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.requestedAt - a.requestedAt);
    },
    async mandates() {
      const all = await deps.store.allMandates();
      const sorted = all.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.activatedAt - a.activatedAt);
      const out: Array<{ mandate: MandateV1; usage: MandateUsage }> = [];
      for (const m of sorted) out.push({ mandate: m, usage: await deps.store.usageOf(m.id) });
      return out;
    },
    async activate(draftId, gestureRef) {
      try {
        if (!gestureRef) throw new MandateRefusedError("authority_missing", "activation requires a gesture");
        const draft = await deps.store.getDraft(draftId);
        if (!draft) throw new MandateRefusedError("mandate_unknown", `no draft ${draftId}`);

        // Amendment by replacement: a counter's activation retires the grant
        // it narrows — following the WHOLE counterOf chain, because a
        // negotiation can run more than one round (d3 counters d2 counters
        // d1; if d1 was granted, activating d3 replaces that grant). Derived,
        // not guessed: an unrelated draft supersedes nothing. Cycle-guarded —
        // a corrupt chain terminates instead of hanging the grant.
        let supersedes: MandateV1["id"] | null = null;
        if (draft.counterOf !== null) {
          const mandates = await deps.store.allMandates();
          const drafts = new Map((await deps.store.allDrafts()).map((d) => [d.id, d]));
          const seen = new Set<string>();
          let link: string | null = draft.counterOf;
          while (link !== null && !seen.has(link)) {
            seen.add(link);
            const prior = mandates.find((m) => m.draftId === link && m.status === "active");
            if (prior) {
              supersedes = prior.id;
              break;
            }
            link = drafts.get(link)?.counterOf ?? null;
          }
        }

        const at = now();
        const mandate = activateDraft(draft, { principal: deps.principal(), gestureRef, supersedes }, at);
        await deps.store.activate(mandate, at);

        let warning: string | null = null;
        if (mandate.terms.delegate.kind === "session") {
          if (deps.attachSessionMandate === null) {
            warning = "sessions are not wired on this build; the mandate is active but no session records the binding";
          } else {
            try {
              await deps.attachSessionMandate(mandate.terms.delegate.value, mandate.id, at);
            } catch (e) {
              // HONEST about what the kernel enforces (review of #356): fit
              // binds by SESSION ID, not by the session record's mandateId —
              // so work from this session can still fit the new mandate. The
              // failure here means only that the session's own durable record
              // keeps its earlier state; nothing in this warning may claim an
              // enforcement that does not exist yet (WP10 decides whether the
              // producer resolves the governing mandate from the session
              // record — until then the record is provenance, not a gate).
              warning =
                `the mandate is active and binds session ${mandate.terms.delegate.value} by id, but the session's own ` +
                `record did not take the binding (${e instanceof Error ? e.message : String(e)}) — the session record keeps ` +
                "its earlier state; it is provenance, not a gate, so work presenting this session id still fits this mandate";
            }
          }
        }
        return { ok: true, mandateId: mandate.id, supersededMandateId: supersedes, sessionAttachWarning: warning };
      } catch (e) {
        return fail(e);
      }
    },
    async decline(draftId, reason, gestureRef) {
      try {
        if (!gestureRef) throw new MandateRefusedError("authority_missing", "declining requires a gesture");
        await deps.store.declineDraft(draftId, reason, now());
        return { ok: true, mandateId: "", supersededMandateId: null, sessionAttachWarning: null };
      } catch (e) {
        return fail(e);
      }
    },
    async revoke(mandateId, reason, gestureRef) {
      try {
        if (!gestureRef) throw new MandateRefusedError("authority_missing", "revocation requires a gesture");
        await deps.store.revoke(mandateId, reason, now());
        return { ok: true, mandateId, supersededMandateId: null, sessionAttachWarning: null };
      } catch (e) {
        return fail(e);
      }
    },
  };
}
