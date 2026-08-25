// MANDATE LIFECYCLE — durable, append-only, folded (WP9).
//
// The session store's discipline applied to authority records: lifecycle
// events are appended to one log, current state is folded from it, nothing
// is ever rewritten. A mandate's history of transitions — drafted,
// countered, activated, charged, revoked — is itself evidence, and the fold
// is the ONE interpretation of it.
//
// The supersession rules live in the fold, because they are consequences of
// events, not separate acts:
//   * activating a draft marks THE DRAFT activated;
//   * a counter-draft supersedes the draft it counters;
//   * activating a mandate that carries `supersedes` transitions the named
//     mandate to `superseded` — amendment by replacement, one gesture.
//
// USAGE is folded beside status (chargeUsage over `usage` events), so budget
// checks always run against the durable record. Charging past a budget does
// not itself flip the mandate — the caller that observes the breach appends
// the explicit `exhausted` event, the same way session expiry is observed
// and then recorded (`markExpired`).

import { chargeUsage, ZERO_USAGE, type MandateUsage } from "./budgets.js";
import {
  MandateRefusedError,
  exhaustMandate,
  expireMandate,
  revokeMandate,
  supersedeMandate,
  type MandateV1,
} from "./mandate.js";
import { declineDraft, markDraftActivated, supersedeDraft, type MandateDraftV1 } from "./draft.js";

export type MandateEvent =
  | { kind: "drafted"; at: number; draft: MandateDraftV1 }
  | { kind: "draft-declined"; at: number; draftId: string; reason: string }
  | { kind: "activated"; at: number; mandate: MandateV1 }
  | { kind: "usage"; at: number; mandateId: string; delta: Partial<MandateUsage> }
  | { kind: "revoked"; at: number; mandateId: string; reason: string }
  | { kind: "expired"; at: number; mandateId: string }
  | { kind: "exhausted"; at: number; mandateId: string; breach: string };

export interface MandateEventIo {
  /** Atomically append one line. */
  appendLine(line: string): Promise<void>;
  /** All lines, oldest first. Missing store = empty list. */
  readLines(): Promise<string[]>;
}

export interface MandateFold {
  drafts: Map<string, MandateDraftV1>;
  mandates: Map<string, MandateV1>;
  usage: Map<string, MandateUsage>;
}

/**
 * Fold events into current state. Pure, total, forgiving of garbage in the
 * direction of SAFETY: an unparseable line is skipped, an event for an
 * unknown id is ignored, and a transition invalid against folded state keeps
 * the stronger existing state (the session-store discipline, verbatim).
 */
export function foldMandateEvents(lines: readonly string[]): MandateFold {
  const drafts = new Map<string, MandateDraftV1>();
  const mandates = new Map<string, MandateV1>();
  const usage = new Map<string, MandateUsage>();
  for (const line of lines) {
    let ev: MandateEvent;
    try {
      ev = JSON.parse(line) as MandateEvent;
    } catch {
      continue;
    }
    try {
      if (ev.kind === "drafted" && ev.draft?.id) {
        if (drafts.has(ev.draft.id)) continue; // first record wins
        drafts.set(ev.draft.id, ev.draft);
        // A counter supersedes what it counters — the human negotiates over the latest terms.
        if (ev.draft.counterOf !== null) {
          const countered = drafts.get(ev.draft.counterOf);
          if (countered) drafts.set(countered.id, supersedeDraft(countered));
        }
      } else if (ev.kind === "draft-declined") {
        const d = drafts.get(ev.draftId);
        if (d) drafts.set(d.id, declineDraft(d, ev.reason));
      } else if (ev.kind === "activated" && ev.mandate?.id) {
        if (mandates.has(ev.mandate.id)) continue; // first record wins
        mandates.set(ev.mandate.id, ev.mandate);
        usage.set(ev.mandate.id, ZERO_USAGE);
        const d = drafts.get(ev.mandate.draftId);
        if (d && d.status === "open") drafts.set(d.id, markDraftActivated(d));
        // Amendment by replacement: the one gesture that grants also retires.
        if (ev.mandate.supersedes !== null) {
          const old = mandates.get(ev.mandate.supersedes);
          if (old) mandates.set(old.id, supersedeMandate(old));
        }
      } else if (ev.kind === "usage") {
        const m = mandates.get(ev.mandateId);
        if (!m) continue;
        usage.set(ev.mandateId, chargeUsage(usage.get(ev.mandateId) ?? ZERO_USAGE, ev.delta));
      } else if (ev.kind === "revoked") {
        const m = mandates.get(ev.mandateId);
        if (m) mandates.set(m.id, revokeMandate(m, ev.reason));
      } else if (ev.kind === "expired") {
        const m = mandates.get(ev.mandateId);
        if (m && m.status === "active") mandates.set(m.id, expireMandate(m, Math.max(ev.at, m.expiresAt)));
      } else if (ev.kind === "exhausted") {
        const m = mandates.get(ev.mandateId);
        if (m) mandates.set(m.id, exhaustMandate(m, ev.breach));
      }
    } catch {
      // Recorded history colliding with itself — keep the stronger folded
      // state rather than losing the fold.
    }
  }
  return { drafts, mandates, usage };
}

export interface MandateStore {
  /** Record an authored draft (or counter — the draft carries `counterOf`). */
  draft(draft: MandateDraftV1, now: number): Promise<void>;
  /** Human declines a draft. Idempotent on non-open drafts. */
  declineDraft(draftId: string, reason: string, now: number): Promise<void>;
  /** Record an activation minted by `activateDraft` — the store trusts the kernel act, it does not re-derive it. */
  activate(mandate: MandateV1, now: number): Promise<void>;
  /** Charge usage against an active mandate. */
  charge(mandateId: string, delta: Partial<MandateUsage>, now: number): Promise<void>;
  revoke(mandateId: string, reason: string, now: number): Promise<void>;
  /** Record an observed expiry, so durable state matches what liveness already decided. */
  markExpired(mandateId: string, now: number): Promise<void>;
  /** Record an observed budget breach. */
  markExhausted(mandateId: string, breach: string, now: number): Promise<void>;
  getDraft(draftId: string): Promise<MandateDraftV1 | null>;
  getMandate(mandateId: string): Promise<MandateV1 | null>;
  usageOf(mandateId: string): Promise<MandateUsage>;
  allDrafts(): Promise<MandateDraftV1[]>;
  allMandates(): Promise<MandateV1[]>;
}

export function createMandateStore(io: MandateEventIo): MandateStore {
  // Lines cached, fold recomputed on demand — one interpretation of events,
  // no hand-maintained incremental mirror (the session store's reasoning;
  // mandate counts are small).
  let lines: string[] | null = null;

  async function allLines(): Promise<string[]> {
    if (lines === null) lines = await io.readLines();
    return lines;
  }

  async function state(): Promise<MandateFold> {
    return foldMandateEvents(await allLines());
  }

  async function append(ev: MandateEvent): Promise<void> {
    // Cache seeded BEFORE the append — a cold read after appendLine would
    // already contain the new line and double-count it.
    const cached = await allLines();
    const line = JSON.stringify(ev);
    await io.appendLine(line);
    cached.push(line);
  }

  return {
    async draft(draft, now) {
      const s = await state();
      if (s.drafts.has(draft.id)) throw new MandateRefusedError("terms_invalid", `draft ${draft.id} is already recorded`);
      if (draft.counterOf !== null && !s.drafts.has(draft.counterOf)) {
        throw new MandateRefusedError("mandate_unknown", `draft ${draft.id} counters unknown draft ${draft.counterOf}`);
      }
      await append({ kind: "drafted", at: now, draft });
    },
    async declineDraft(draftId, reason, now) {
      const s = await state();
      const d = s.drafts.get(draftId);
      if (!d) throw new MandateRefusedError("mandate_unknown", `no draft ${draftId}`);
      if (d.status !== "open") return; // idempotent: already settled
      await append({ kind: "draft-declined", at: now, draftId, reason });
    },
    async activate(mandate, now) {
      const s = await state();
      if (s.mandates.has(mandate.id)) throw new MandateRefusedError("terms_invalid", `mandate ${mandate.id} is already recorded`);
      const d = s.drafts.get(mandate.draftId);
      if (!d) throw new MandateRefusedError("mandate_unknown", `mandate ${mandate.id} activates unknown draft ${mandate.draftId}`);
      if (d.status !== "open") throw new MandateRefusedError("draft_not_open", `draft ${d.id} is ${d.status}; only an open draft activates`);
      if (mandate.supersedes !== null && !s.mandates.has(mandate.supersedes)) {
        throw new MandateRefusedError("mandate_unknown", `mandate ${mandate.id} supersedes unknown mandate ${mandate.supersedes}`);
      }
      await append({ kind: "activated", at: now, mandate });
    },
    async charge(mandateId, delta, now) {
      const s = await state();
      const m = s.mandates.get(mandateId);
      if (!m) throw new MandateRefusedError("mandate_unknown", `no mandate ${mandateId}`);
      if (m.status !== "active") {
        throw new MandateRefusedError("mandate_not_active", `mandate ${mandateId} is ${m.status}; usage is charged only against active mandates`);
      }
      await append({ kind: "usage", at: now, mandateId, delta });
    },
    async revoke(mandateId, reason, now) {
      const s = await state();
      if (!s.mandates.has(mandateId)) throw new MandateRefusedError("mandate_unknown", `no mandate ${mandateId}`);
      await append({ kind: "revoked", at: now, mandateId, reason });
    },
    async markExpired(mandateId, now) {
      const s = await state();
      const m = s.mandates.get(mandateId);
      if (!m || m.status !== "active") return;
      await append({ kind: "expired", at: now, mandateId });
    },
    async markExhausted(mandateId, breach, now) {
      const s = await state();
      const m = s.mandates.get(mandateId);
      if (!m || m.status !== "active") return;
      await append({ kind: "exhausted", at: now, mandateId, breach });
    },
    async getDraft(draftId) {
      return (await state()).drafts.get(draftId) ?? null;
    },
    async getMandate(mandateId) {
      return (await state()).mandates.get(mandateId) ?? null;
    },
    async usageOf(mandateId) {
      return (await state()).usage.get(mandateId) ?? ZERO_USAGE;
    },
    async allDrafts() {
      return [...(await state()).drafts.values()];
    },
    async allMandates() {
      return [...(await state()).mandates.values()];
    },
  };
}
