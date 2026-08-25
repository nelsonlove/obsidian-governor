// MANDATES — the human's bounded delegation, as a record (WP9; D02, D03, D14).
//
// A mandate states what may be ATTEMPTED and what, if anything, may be
// ADMITTED after verification — never "do whatever is necessary". The two
// authorities are separate fields (D02): `mayProduce` covers producing
// proposals under the mandate; `mayAdmit` covers Governor admitting verified
// cohorts without a per-cohort click. In this first implementation `mayAdmit`
// is recorded but NEVER exercised — the admission door still refuses mandate
// authority (policy.ts `mandate_not_supported` sites), and promotion to
// automatic admission is WP10's evidence gate. Recording the human's intent
// now and exercising it later beats retrofitting the schema.
//
// IMMUTABILITY: an active mandate is never edited. Scope, classes,
// transformation, predicate versions, budgets, expiry, recovery — all frozen
// at activation. Amendment is REPLACEMENT: a new draft, a new human
// activation carrying `supersedes`, and the old mandate transitions to
// `superseded`. This is the same append-only discipline every other
// governance record here follows, applied to authority itself.
//
// ACTIVATION IS A HUMAN GESTURE. A draft (draft.ts) carries the full terms
// but confers nothing; `activateDraft` requires a gestureRef minted by the
// pane's gesture gate. There is no agent-reachable activation path — the
// MCP surface can draft and counter-propose, and that is all (the #221
// authority axis: agents supply candidates; humans decide).

import { mintId, type MandateId } from "../contracts/ids.js";
import { isChangeClass, type ChangeClass } from "../contracts/change-class.js";
import { budgetsInvalidReason, type MandateBudgets } from "./budgets.js";
import type { MandateDraftV1 } from "./draft.js";

export type MandateStatus = "active" | "revoked" | "expired" | "exhausted" | "superseded";

/** How the mandate names its delegate — a particular session, a particular connection, or a narrowly defined agent role. */
export interface DelegateBinding {
  kind: "session" | "connection" | "role";
  value: string;
}

/**
 * The delegation's terms — shared verbatim between a draft (requested) and a
 * mandate (granted). Everything here is immutable once activated.
 */
export interface MandateTerms {
  /** The intended outcome, in the human's language. */
  purpose: string;
  delegate: DelegateBinding;
  /** Vault-relative path prefixes. `include` must be non-empty — an unbounded scope is not delegation. */
  scope: { include: string[]; exclude: string[] };
  allowedClasses: ChangeClass[];
  /** The named deterministic rule or bounded plan this mandate authorizes. */
  transformation: { id: string; version: string };
  /** Verification the mandate requires — exact predicate ids and versions. */
  predicates: Array<{ id: string; version: string }>;
  /** Exact eligible action ids and versions. Renaming a tool does not widen authority. */
  eligibleActions: Array<{ id: string; version: string }>;
  /** Observation durability required for work under this mandate. */
  requiredDurability: "replayable";
  budgets: MandateBudgets;
  /** D02's separation. `mayAdmit` is recorded intent; exercising it is WP10's promotion gate. */
  admission: { mayProduce: boolean; mayAdmit: boolean };
  /** Recovery unit for reversal — required before any admission under the mandate. */
  recovery: { unit: "item" | "cohort" };
}

export interface MandateV1 {
  schema: "governor.mandate/v1";
  id: MandateId;
  /** The human granting authority. */
  principal: string;
  terms: MandateTerms;
  /** The draft this activation granted — provenance, not capability. */
  draftId: string;
  activatedAt: number;
  /** Computed at activation from budgets.maxDurationMs. Decided at use, no timers. */
  expiresAt: number;
  /** The activation gesture. Never minted outside the gesture gate. */
  gestureRef: string;
  /** Amendment by replacement: the mandate this one replaces, transitioned to `superseded` by the same activation. */
  supersedes: MandateId | null;
  status: MandateStatus;
  /** Present only on revoked mandates. */
  revokedReason?: string;
  /** Present only on exhausted mandates — which budget stopped it. */
  exhaustedBy?: string;
}

export type MandateRefusalCode =
  | "authority_missing"
  | "terms_invalid"
  | "draft_not_open"
  | "mandate_not_active"
  | "mandate_expired"
  | "mandate_revoked"
  | "mandate_exhausted"
  | "mandate_superseded"
  | "production_not_authorized"
  | "delegate_mismatch"
  | "scope_escape"
  | "class_escalation"
  | "transformation_mismatch"
  | "predicate_mismatch"
  | "action_not_eligible"
  | "durability_insufficient"
  | "budget_exhausted"
  | "mandate_unknown";

export class MandateRefusedError extends Error {
  constructor(readonly code: MandateRefusalCode, detail: string) {
    super(detail);
    this.name = "MandateRefusedError";
  }
}

/**
 * Why the terms are not a valid delegation, or null. "Unknown targets,
 * open-ended verbs, and unbounded cascades are not valid delegation" — every
 * axis must be present, bounded, and well-formed. Shared by drafting and
 * activation so a draft that validates cannot fail activation on shape.
 */
export function termsInvalidReason(t: MandateTerms): string | null {
  if (!t.purpose.trim()) return "purpose is empty — a delegation names its intended outcome";
  if (t.delegate.kind !== "session" && t.delegate.kind !== "connection" && t.delegate.kind !== "role") {
    return `unknown delegate binding kind '${String(t.delegate.kind)}'`;
  }
  if (!t.delegate.value.trim()) return "delegate binding value is empty";
  if (t.scope.include.length === 0) return "scope.include is empty — an unbounded scope is not delegation";
  for (const p of [...t.scope.include, ...t.scope.exclude]) {
    if (typeof p !== "string" || !p.trim() || p.startsWith("/") || p.includes("..")) {
      return `scope entry ${JSON.stringify(p)} is not a vault-relative path prefix`;
    }
  }
  if (t.allowedClasses.length === 0) return "allowedClasses is empty — a mandate authorizes named classes";
  for (const c of t.allowedClasses) {
    if (!isChangeClass(c)) return `unknown change class '${String(c)}'`;
  }
  if (t.allowedClasses.includes("authority")) {
    return "the authority class is never delegable — authority changes use a direct human authority path (D02)";
  }
  if (!t.transformation.id.trim() || !t.transformation.version.trim()) return "transformation must name an exact id and version";
  if (t.predicates.length === 0) return "predicates is empty — a mandate names its required verification";
  for (const p of t.predicates) {
    if (!p.id.trim() || !p.version.trim()) return "every predicate needs an exact id and version";
  }
  if (t.eligibleActions.length === 0) return "eligibleActions is empty — a mandate authorizes exact registered actions";
  for (const a of t.eligibleActions) {
    if (!a.id.trim() || !a.version.trim()) return "every eligible action needs an exact id and version";
  }
  if (t.requiredDurability !== "replayable") return `requiredDurability must be 'replayable', got '${String(t.requiredDurability)}'`;
  const b = budgetsInvalidReason(t.budgets);
  if (b !== null) return b;
  if (!t.admission.mayProduce) {
    return "mayProduce is false — a mandate that authorizes no production delegates nothing (mayAdmit alone is not a grant)";
  }
  if (t.recovery.unit !== "item" && t.recovery.unit !== "cohort") return `unknown recovery unit '${String(t.recovery.unit)}'`;
  return null;
}

export interface ActivateInput {
  principal: string;
  gestureRef: string;
  supersedes?: MandateId | null;
}

/**
 * Grant a draft: the ONE act that turns requested terms into authority.
 * Requires a gesture (the pane mints gestureRef inside runGuardedDisposition;
 * an empty ref here means the call did not come through the gate). The terms
 * are deep-copied and frozen — the draft object cannot be a back-door into
 * the mandate after activation.
 */
export function activateDraft(draft: MandateDraftV1, input: ActivateInput, now: number, rand?: Uint8Array): MandateV1 {
  if (!input.gestureRef) throw new MandateRefusedError("authority_missing", "mandate activation is a human gesture; no gestureRef was presented");
  if (!input.principal.trim()) throw new MandateRefusedError("authority_missing", "mandate activation names its human principal");
  if (draft.status !== "open") {
    throw new MandateRefusedError("draft_not_open", `draft ${draft.id} is ${draft.status}; only an open draft can be activated`);
  }
  const invalid = termsInvalidReason(draft.terms);
  if (invalid !== null) throw new MandateRefusedError("terms_invalid", invalid);
  const terms = cloneTerms(draft.terms);
  return {
    schema: "governor.mandate/v1",
    id: mintId("mandate", now, rand),
    principal: input.principal,
    terms,
    draftId: draft.id,
    activatedAt: now,
    expiresAt: now + terms.budgets.maxDurationMs,
    gestureRef: input.gestureRef,
    supersedes: input.supersedes ?? null,
    status: "active",
  };
}

/** A deep copy so no caller-held reference can mutate an activated mandate's terms. */
export function cloneTerms(t: MandateTerms): MandateTerms {
  return {
    purpose: t.purpose,
    delegate: { kind: t.delegate.kind, value: t.delegate.value },
    scope: { include: [...t.scope.include], exclude: [...t.scope.exclude] },
    allowedClasses: [...t.allowedClasses],
    transformation: { id: t.transformation.id, version: t.transformation.version },
    predicates: t.predicates.map((p) => ({ id: p.id, version: p.version })),
    eligibleActions: t.eligibleActions.map((a) => ({ id: a.id, version: a.version })),
    requiredDurability: t.requiredDurability,
    budgets: { ...t.budgets },
    admission: { mayProduce: t.admission.mayProduce, mayAdmit: t.admission.mayAdmit },
    recovery: { unit: t.recovery.unit },
  };
}

// ── Status transitions — one-way, the session discipline ─────────────────────

export function revokeMandate(m: MandateV1, reason: string): MandateV1 {
  // Revocation is a human statement of distrust; recording it over an already
  // inert mandate is allowed and idempotent — but revoked stays revoked.
  if (m.status === "revoked") return m;
  return { ...m, status: "revoked", revokedReason: reason };
}

export function expireMandate(m: MandateV1, now: number): MandateV1 {
  if (m.status !== "active") return m;
  if (now < m.expiresAt) throw new MandateRefusedError("mandate_not_active", `mandate ${m.id} has not expired yet`);
  return { ...m, status: "expired" };
}

export function exhaustMandate(m: MandateV1, breach: string): MandateV1 {
  if (m.status !== "active") return m;
  return { ...m, status: "exhausted", exhaustedBy: breach };
}

export function supersedeMandate(m: MandateV1): MandateV1 {
  if (m.status !== "active") return m;
  return { ...m, status: "superseded" };
}
