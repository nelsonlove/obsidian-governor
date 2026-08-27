// MANDATE FIT — does this exact work fall inside this exact delegation? (WP9)
//
// The WP9 deliverable this file IS: "replay refusal across delegate, session,
// scope, class, transformation, predicate, expiry, and revocation." Every
// axis is its own typed refusal, checked in authority-first order, and the
// check is PURE — the caller supplies the mandate, its folded usage, the
// work's facts, and the clock. Nothing here reads stores or wall clocks.
//
// This is the production-side gate (`mayProduce`). The admission-side gate
// (`mayAdmit`, D02's other half) lives at the DOOR — admission/policy.ts's
// requireMandateCohortAdmissible (WP10b), which owns its own table because
// doors do not trust hallways: it re-checks liveness/expiry/scope/classes
// itself and adds what only the door can know (the promoted tuple, the
// declared verifier's coverage, the recovery unit). This file stays the
// producer's half; productionStampOf below is its one production consumer.
//
// FAIL DIRECTION: every uncertain input refuses. A missing transformation,
// an unknown durability, an absent action — each reads as "outside the
// mandate", never "probably fine". The mandate is the whitelist; the world
// is the default-deny.

import type { ChangeClass } from "../contracts/change-class.js";
import { budgetBreach, type MandateUsage } from "./budgets.js";
import type { MandateRefusalCode, MandateV1 } from "./mandate.js";

/** The facts about one unit of work seeking to run under a mandate. */
export interface MandateFitContext {
  /** The delegate presenting the work. */
  delegate: { sessionId: string | null; connection: string | null; role: string | null };
  /** The note path the work touches. */
  notePath: string;
  /** Change classes DERIVED from the work (the class firewall's output), never declared. */
  changeClasses: ChangeClass[];
  transformation: { id: string; version: string } | null;
  /** The predicates the work will be verified under. */
  predicates: Array<{ id: string; version: string }>;
  /** The registered action producing the work. */
  action: { id: string; version: string } | null;
  /** Durability of the observations supporting the work. */
  durability: "replayable" | "ephemeral" | null;
}

export type MandateFit = { ok: true } | { ok: false; code: MandateRefusalCode; detail: string };

const refuse = (code: MandateRefusalCode, detail: string): MandateFit => ({ ok: false, code, detail });

/** Segment-boundary prefix match: `a/b` covers `a/b` and `a/b/c`, never `a/bc`. */
export function pathWithin(path: string, prefix: string): boolean {
  const p = prefix.replace(/\/+$/, "");
  return path === p || path.startsWith(p + "/");
}

/**
 * The whole verdict. Check order is deliberate: the mandate's own liveness
 * first (a revoked mandate refuses as revoked even for out-of-scope work —
 * the strongest fact wins), then who is asking, then what they are asking
 * to do, then whether budget remains.
 */
export function mandateFitOf(mandate: MandateV1, usage: MandateUsage, ctx: MandateFitContext, now: number): MandateFit {
  // 1–2. Revocation and expiry (status first; expiry needs no writer to have happened).
  if (mandate.status === "revoked") {
    return refuse("mandate_revoked", `mandate ${mandate.id} was revoked${mandate.revokedReason ? `: ${mandate.revokedReason}` : ""}`);
  }
  if (mandate.status === "exhausted") {
    return refuse("mandate_exhausted", `mandate ${mandate.id} is exhausted${mandate.exhaustedBy ? ` (${mandate.exhaustedBy})` : ""}`);
  }
  if (mandate.status === "superseded") {
    return refuse("mandate_superseded", `mandate ${mandate.id} was superseded — work runs under its replacement, not under it`);
  }
  if (mandate.status !== "active") {
    return refuse("mandate_not_active", `mandate ${mandate.id} is ${mandate.status}`);
  }
  if (now >= mandate.expiresAt) {
    return refuse("mandate_expired", `mandate ${mandate.id} expired at ${mandate.expiresAt} (now ${now})`);
  }

  if (!mandate.terms.admission.mayProduce) {
    return refuse("production_not_authorized", `mandate ${mandate.id} does not authorize production`);
  }

  // 3. Delegate + session. The binding names ONE identity kind; the work must
  // present that exact identity. A missing identity is a mismatch, not a pass.
  const d = mandate.terms.delegate;
  const presented = d.kind === "session" ? ctx.delegate.sessionId : d.kind === "connection" ? ctx.delegate.connection : ctx.delegate.role;
  if (presented === null || presented !== d.value) {
    return refuse(
      "delegate_mismatch",
      `mandate ${mandate.id} binds ${d.kind} '${d.value}'; the work presented ${presented === null ? `no ${d.kind}` : `${d.kind} '${presented}'`}`
    );
  }

  // 4. Scope: inside some include, outside every exclude. A path this
  // function cannot reason about prefix-wise — traversal segments, absolute
  // form — refuses BEFORE matching (the file's fail direction): vault paths
  // never carry these, so their presence means the input is not a vault path.
  const t = mandate.terms;
  if (ctx.notePath.startsWith("/") || ctx.notePath.split("/").includes("..") || ctx.notePath.split("/").includes(".")) {
    return refuse("scope_escape", `'${ctx.notePath}' is not a plain vault-relative path; scope cannot be decided over it`);
  }
  if (!t.scope.include.some((p) => pathWithin(ctx.notePath, p))) {
    return refuse("scope_escape", `'${ctx.notePath}' is outside the mandate's scope (${t.scope.include.join(", ")})`);
  }
  const excluded = t.scope.exclude.find((p) => pathWithin(ctx.notePath, p));
  if (excluded !== undefined) {
    return refuse("scope_escape", `'${ctx.notePath}' is inside excluded scope '${excluded}'`);
  }

  // 5. Classes: every derived class must be allowed. Escalation blocks.
  if (ctx.changeClasses.length === 0) {
    return refuse("class_escalation", "the work derived no change classes — nothing to authorize is not authorization");
  }
  const escalated = ctx.changeClasses.find((c) => !t.allowedClasses.includes(c));
  if (escalated !== undefined) {
    return refuse("class_escalation", `class '${escalated}' is outside the mandate's allowed classes (${t.allowedClasses.join(", ")})`);
  }

  // 6. Transformation: exact id AND version.
  if (ctx.transformation === null || ctx.transformation.id !== t.transformation.id || ctx.transformation.version !== t.transformation.version) {
    const got = ctx.transformation === null ? "none" : `${ctx.transformation.id}@${ctx.transformation.version}`;
    return refuse("transformation_mismatch", `mandate ${mandate.id} authorizes ${t.transformation.id}@${t.transformation.version}; the work presents ${got}`);
  }

  // 7. Predicates: every required predicate present at its exact version.
  for (const req of t.predicates) {
    const hit = ctx.predicates.find((p) => p.id === req.id);
    if (!hit || hit.version !== req.version) {
      return refuse(
        "predicate_mismatch",
        `mandate ${mandate.id} requires predicate ${req.id}@${req.version}; the work presents ${hit ? `${hit.id}@${hit.version}` : "nothing for that id"}`
      );
    }
  }

  // 8. Action eligibility: the exact registered action id and version.
  if (ctx.action === null || !t.eligibleActions.some((a) => a.id === ctx.action?.id && a.version === ctx.action?.version)) {
    const got = ctx.action === null ? "none" : `${ctx.action.id}@${ctx.action.version}`;
    return refuse("action_not_eligible", `mandate ${mandate.id} authorizes actions [${t.eligibleActions.map((a) => `${a.id}@${a.version}`).join(", ")}]; the work presents ${got}`);
  }

  // 9. Observation durability.
  if (ctx.durability !== t.requiredDurability) {
    return refuse(
      "durability_insufficient",
      `mandate ${mandate.id} requires ${t.requiredDurability} observations; the work presents ${ctx.durability ?? "unknown durability"}`
    );
  }

  // 10. Budgets — reaching one is a normal stop. The duration axis is
  // DELIBERATELY shadowed here: expiresAt = activatedAt + maxDurationMs, and
  // the expiry check above refuses first at the same instant, so a duration
  // breach can only surface through budgetBreach's direct callers (the
  // exhaustion-observation flow). Same clock tick, same refusal either way.
  const breach = budgetBreach(t.budgets, usage, mandate.activatedAt, now);
  if (breach !== null) {
    return refuse("budget_exhausted", `mandate ${mandate.id}: ${breach.detail}`);
  }

  return { ok: true };
}

/** What the producer does about a session's governing mandate for one write (WP10b). */
export interface ProductionStampDecision {
  /** The mandate id to stamp on the subject, or null (unfit / no mandate). */
  mandateId: string | null;
  /** The usage to charge iff stamped — items, proposals, and the written bytes. */
  charge: { items: number; proposals: number; bytes: number } | null;
  /** The fit refusal when a LIVE mandate did not fit this work — observability, never a gate: the proposal proceeds unstamped. */
  refusal: MandateFit | null;
}

/**
 * The producer's stamp decision, pure (WP10b). A mandate never BLOCKS
 * production — proposals are safe, and an unfit write simply proposes
 * ungoverned-by-mandate — but the stamp is granted only through the full
 * production fit, and a stamp implies a charge: work counted under the
 * mandate is work that spends its budgets.
 */
export function productionStampOf(
  mandate: MandateV1 | null,
  usage: MandateUsage,
  ctx: MandateFitContext,
  bytes: number,
  now: number
): ProductionStampDecision {
  if (mandate === null) return { mandateId: null, charge: null, refusal: null };
  const fit = mandateFitOf(mandate, usage, ctx, now);
  if (!fit.ok) return { mandateId: null, charge: null, refusal: fit };
  return { mandateId: mandate.id, charge: { items: 1, proposals: 1, bytes: Math.max(0, Math.floor(bytes)) }, refusal: fit };
}
