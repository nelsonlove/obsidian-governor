// ADMISSION POLICY — what admission REQUIRES, as one refusal table (WP6, §9).
//
// The guide's list of what the admission call does not accept, made
// structural. Every rule is a typed refusal with the reason in the message,
// because each refusal reaches a human deciding whether to fix or abandon.
//
// The policy is PURE: it receives facts (the proposal, the verification
// records, the authority reference, the clock) and answers. Gathering the
// facts honestly is the service's job; deciding is this module's.

import { subjectDigest, type CohortSubjectV1, type ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { ProposalV1 } from "../proposals/proposal.js";
import type { VerificationRecord } from "../verification/predicate.js";
import type { CohortCoverageOutcome } from "../cohorts/coverage.js";
import { groupIneligibilityOf } from "../cohorts/cohort.js";
import type { MandateV1 } from "../mandates/mandate.js";
import type { MandateUsage } from "../mandates/budgets.js";
import { budgetBreach } from "../mandates/budgets.js";
import { pathWithin } from "../mandates/policy.js";
import { AUTOMATABLE_CLASSES, type TransformationV1 } from "../transformations/transformation.js";
import type { PromotionVerdict } from "../transformations/promotion.js";

/** How this admission is authorized. The mandate arm is real as of WP10b — validated by the mandate table below, never waved through. */
export type AdmissionAuthority =
  | {
      kind: "human-gesture";
      /** An opaque reference minted by the gesture path (never caller-supplied). */
      gestureRef: string;
    }
  | {
      kind: "mandate";
      mandateId: string;
    };

/**
 * The facts the mandate refusal table decides over — RESOLVED BY THE
 * SERVICE'S capability (the verification pattern: the request has no field a
 * caller-built context could ride in on). Every "could not resolve" state is
 * explicit and refuses; nothing here defaults to permissive.
 */
export interface MandateAdmissionContext {
  /** The mandate the authority names, from the durable store. null = the store answered "no such mandate". */
  mandate: MandateV1 | null;
  usage: MandateUsage;
  /** The REGISTERED transformation matching the cohort's stamp, or null when the registry does not hold it. */
  transformation: TransformationV1 | null;
  /**
   * The promotion verdict for the transformation's exact tuple — or
   * `unavailable` when the evidence store could not be read (condition 7: a
   * broken evidence lookup must read as BROKEN, its own refusal, never as
   * "no recorded failures, therefore safe" and never silently as
   * unpromoted — a wrong-shaped answer here is a blanket auto-admit).
   */
  promotion: PromotionVerdict | { state: "unavailable"; detail: string };
}

export class AdmissionRefusedError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    /** Member noteIds a cohort refusal names — STRUCTURED, so split-by-finding never parses prose (a noteId containing ", " or "—" would corrupt a regex extraction). */
    readonly failedNoteIds?: string[]
  ) {
    super(`admission refused [${code}]: ${detail}`);
    this.name = "AdmissionRefusedError";
  }
}

export interface AdmissionRequest {
  proposal: ProposalV1;
  /** The subject as the CALLER believes it stands. Revalidated against the proposal's. */
  subject: ProposalItemSubjectV1;
  authority: AdmissionAuthority;
}

/**
 * The refusal table. Returns nothing; throws the first violated rule.
 *
 * `verification` is NOT part of the request: the records arrive from the
 * SERVICE, which ran them itself. The first draft accepted caller-supplied
 * records and compared them to the subject's predicate list — and since the
 * caller controls both the subject and the records, it could forge matching
 * pairs freely (proven by the review's exploit: an unverified subject
 * admitted with hand-built passed:true records). Removing the field is the
 * fix §9 actually asks for: "resolves every required predicate" is the
 * service's act, and a verdict has no path into admission except through it.
 *
 * Order matters only for message quality — every rule is independently
 * sufficient to refuse, and none may be skipped for any caller.
 */
export function requireAdmissible(request: AdmissionRequest, verification: VerificationRecord[], now: number): void {
  const { proposal, subject, authority } = request;

  // The exact subject, not a selector: the caller's subject must digest to
  // exactly what the proposal recorded. A drifted working tree, an edited
  // manifest, a "close enough" — all land here.
  const digest = subjectDigest(subject);
  if (digest.value !== proposal.subjectDigest.value) {
    throw new AdmissionRefusedError(
      "subject_drift",
      `the subject digests to ${digest.value.slice(0, 12)}… but the proposal covers ${proposal.subjectDigest.value.slice(0, 12)}…; re-propose the current state`
    );
  }

  if (proposal.authority !== "proposed") {
    throw new AdmissionRefusedError("proposal_not_proposed", `the proposal is ${proposal.authority}; only a proposed subject can be admitted`);
  }
  // §9: "a result with partial, uncertain, receiving, or conflicted state"
  // is never admitted. The proposal records its producing operation's
  // outcome at open; anything but a clean completion refuses here.
  if (proposal.producedOutcome !== "completed") {
    throw new AdmissionRefusedError(
      "result_not_settled",
      `the producing operation's outcome is '${proposal.producedOutcome}'; only a completed result can be admitted`
    );
  }
  if (proposal.development === "revision-requested") {
    throw new AdmissionRefusedError("revision_open", "a revision was requested; the revised result is a new subject");
  }

  // Ephemeral dependencies cannot support admission (D16). The subject
  // schema already refuses them; this re-checks at the decision boundary
  // because admission is the last door and doors do not trust hallways.
  for (const obs of subject.observations) {
    if ((obs.capture as string) === "ephemeral") {
      throw new AdmissionRefusedError("ephemeral_dependency", `observation ${obs.id} is ephemeral and supports nothing`);
    }
  }

  // Verification: exact coverage of the EXACT digest, every record passed,
  // and no required predicate missing. The records parameter arrives from
  // the SERVICE, which ran them — the request type has no field a
  // caller-supplied verdict could ride in on.
  //
  // The proposal's verification AXIS is deliberately not checked here: it is
  // a projection, and the truth is the freshly-run outcome — a proposal whose
  // axis lags at "unverified" admits fine when the predicates pass NOW, and
  // an axis claiming "passed" proves nothing. (The proposal STORE's
  // withAdmitted still requires the axis, so the projection catches up
  // through setVerification before markAdmitted — two records, each honest
  // about what it is.)
  const required = new Map(subject.predicates.map((p) => [`${p.id}@${p.version}`, false]));
  for (const record of verification) {
    if (record.subjectDigest.value !== digest.value) {
      throw new AdmissionRefusedError(
        "verification_stale",
        `verification of ${record.predicate.id}@${record.predicate.version} addresses a different subject; the subject changed after it ran`
      );
    }
    const k = `${record.predicate.id}@${record.predicate.version}`;
    if (!required.has(k)) continue; // extra verification is harmless; it just proves nothing required
    if (!record.passed) {
      throw new AdmissionRefusedError("verification_failed", `${k} failed: ${record.detail}`);
    }
    required.set(k, true);
  }
  const missing = [...required.entries()].filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length > 0) {
    throw new AdmissionRefusedError("verification_incomplete", `required verification missing: ${missing.join(", ")} — coverage is exact and total, never sampled`);
  }

  // Authority. The INDIVIDUAL path admits only through the human gesture —
  // deliberately, and not as a leftover: mandated admission is a COHORT act
  // by doctrine (D02 / sessions-mandates-and-cohorts.md mode 3 — "Governor
  // verifies every item and admits exact cohorts"; the pilot and every
  // exception are individual precisely BECAUSE a human decides them). An
  // automatic single-item door would be a second, smaller entrance with the
  // same authority and half the manifest discipline.
  if (authority.kind === "mandate") {
    throw new AdmissionRefusedError(
      "mandate_requires_cohort",
      "mandated admission decides frozen cohorts only; a single result is either part of a cohort or a human's individual decision"
    );
  }
  if (!authority.gestureRef) {
    throw new AdmissionRefusedError("authority_missing", "admission requires the gesture reference minted by the accept surface");
  }

  // A mandate-PRODUCED subject under a HUMAN gesture is the cohort-decision
  // happy path (D02: even eligible mandates run in cohort-decision mode) —
  // the mandateId is provenance the human sees, never a gate on their
  // decision. WP6's refusal here is retired by WP10b, on purpose.

  void now; // the clock stays a parameter: the cohort table's mandate arm consumes it, and the two tables must age together
}

export interface CohortAdmissionRequest {
  /** The frozen decision subject, as presented to the human. */
  frozenSubject: CohortSubjectV1;
  /** The digest the GESTURE covered — what the human saw and confirmed. */
  gestureCoveredDigest: string;
  /** The member proposals, in the subject's canonical item order. */
  memberProposals: ProposalV1[];
  authority: AdmissionAuthority;
}

/**
 * The cohort refusal table (WP7b). The frozen structure is RECOMPUTED, never
 * trusted (freeze.ts's stated obligation): tampering makes the precomputed
 * digest stale, and recomputation is what turns tampering into a refusal.
 * Coverage arrives from the SERVICE's own run (the WP6a lesson at birth);
 * one failed item fails the gesture whole, with the items named —
 * review-and-safety's abort rule at cohort scale.
 */
export function requireCohortAdmissible(request: CohortAdmissionRequest, coverage: CohortCoverageOutcome, now: number, mandateCtx?: MandateAdmissionContext): void {
  const { frozenSubject, memberProposals, authority } = request;

  // The RECOMPUTED digest must be what the gesture covered. A tampered
  // structure, a drifted member (re-observed digests are rebuilt into the
  // click-time subject by the wiring), or a stale presentation all land here.
  const recomputed = subjectDigest(frozenSubject);
  if (recomputed.value !== request.gestureCoveredDigest) {
    throw new AdmissionRefusedError(
      "subject_drift",
      `the cohort recomputes to ${recomputed.value.slice(0, 12)}… but the gesture covered ${request.gestureCoveredDigest.slice(0, 12)}…; the decision changed between presentation and click`
    );
  }

  // Members correlate to frozen items by NOTE IDENTITY, never by position:
  // buildCohortSubject sorts items canonically by noteId while callers hold
  // members in selection order, so a positional check would refuse legitimate
  // cohorts whenever real-vault noteIds don't happen to ascend in selection
  // order (review finding — every early test's uid-001…uid-00N ascended, so
  // position and canon always agreed and the suite couldn't see it).
  if (memberProposals.length !== frozenSubject.items.length) {
    throw new AdmissionRefusedError("subject_drift", "the member list does not match the frozen manifest");
  }
  const byIdentity = new Map(memberProposals.map((p) => [`${p.subject.vaultId}\u0000${p.subject.noteId}`, p]));
  if (byIdentity.size !== memberProposals.length) {
    throw new AdmissionRefusedError("subject_drift", "the member list carries duplicate note identities");
  }
  for (const item of frozenSubject.items) {
    const proposal = byIdentity.get(`${item.vaultId}\u0000${item.noteId}`);
    if (!proposal) {
      throw new AdmissionRefusedError("subject_drift", `frozen item ${item.noteId} has no corresponding member proposal`);
    }
    if (proposal.authority !== "proposed") {
      throw new AdmissionRefusedError("proposal_not_proposed", `member ${item.noteId} is ${proposal.authority}; only proposed items admit`);
    }
    if (proposal.producedOutcome !== "completed") {
      throw new AdmissionRefusedError("result_not_settled", `member ${item.noteId}'s producing operation was '${proposal.producedOutcome}'`);
    }
    // A mandate-produced member under a HUMAN gesture is the cohort-decision
    // happy path — provenance, not a gate (WP10b retires WP6's refusal). The
    // mandate-AUTHORITY table below is where member mandate ids bind.
  }
  // The item table's rule at cohort scale: an open human objection blocks the
  // member, and one blocked member blocks the decision (whole-abort). A
  // revision request flips no note bytes, so drift and coverage both pass
  // over it — this row is the ONLY thing that can see it. ALL objected
  // members are collected and named in ONE refusal, so split-by-finding
  // excludes them in one successor rather than one gated click each.
  const revisionOpen = frozenSubject.items
    .map((item) => byIdentity.get(`${item.vaultId}\u0000${item.noteId}`))
    .filter((p): p is ProposalV1 => p !== undefined && p.development === "revision-requested")
    .map((p) => p.subject.noteId);
  if (revisionOpen.length > 0) {
    throw new AdmissionRefusedError("revision_open", `a revision was requested on ${revisionOpen.length} member(s): ${revisionOpen.join(", ")}; the revised results are new subjects`, revisionOpen);
  }

  // Coverage: the service's own run, exact and total, addressed to THIS digest.
  if (coverage.cohortDigest !== recomputed.value) {
    throw new AdmissionRefusedError("verification_stale", "the coverage outcome addresses a different cohort digest");
  }
  if (!coverage.passed) {
    throw new AdmissionRefusedError(
      "verification_failed",
      `coverage failed for ${coverage.failedNoteIds.length} member(s): ${coverage.failedNoteIds.join(", ")} — exclude-and-refreeze (split by finding) or resolve them; a failed item is never silently dropped or admitted`
    );
  }

  if (authority.kind === "mandate") {
    requireMandateCohortAdmissible(request, mandateCtx, now);
  } else if (!authority.gestureRef) {
    throw new AdmissionRefusedError("authority_missing", "cohort admission requires the gesture reference minted by the accept surface");
  }

  // Cross-item base compatibility (change-classes' "compatible base state")
  // in its CROSS-item sense — all bases sampled from one consistent
  // world-state — is session-base territory (D01) and lands with the
  // session-base predicate, not here: per-item base agreement is what
  // coverage just proved. Named so the omission reads as a decision.
}

/**
 * THE MANDATE REFUSAL TABLE — what an admission with no human click requires
 * (WP10b; D02, D14; governor-lead's conditions 1, 5, 7, 9). Runs AFTER the
 * shared rows above, so drift, settlement, revision, and coverage are
 * already proven for the exact digest; this table decides only whether the
 * MANDATE may stand in for the gesture. Every uncertainty refuses with its
 * own code — and the two absence shapes are DISTINCT on purpose: a store
 * that answered "nothing" (promotion_missing, with the gap named) and a
 * store that could not answer (promotion_unavailable) are different bugs,
 * and only one of them looks like one.
 */
function requireMandateCohortAdmissible(request: CohortAdmissionRequest, ctx: MandateAdmissionContext | undefined, now: number): void {
  const { frozenSubject, authority } = request;
  if (authority.kind !== "mandate") throw new AdmissionRefusedError("authority_missing", "not a mandate authority");
  if (ctx === undefined) {
    throw new AdmissionRefusedError("mandate_unavailable", "no mandate context capability is wired; a mandate that cannot be validated authorizes nothing");
  }

  // 1. The mandate itself: known, active, unexpired (the WP6 `void now` seam, consumed at last).
  const m = ctx.mandate;
  if (m === null) throw new AdmissionRefusedError("mandate_unknown", `no mandate ${authority.mandateId} in the durable record`);
  if (m.id !== authority.mandateId) {
    throw new AdmissionRefusedError("mandate_unknown", "the resolved mandate does not match the authority's id — the context is answering a different question");
  }
  if (m.status !== "active") {
    throw new AdmissionRefusedError(`mandate_${m.status}`, `mandate ${m.id} is ${m.status}; nothing further runs under it`);
  }
  if (now >= m.expiresAt) {
    throw new AdmissionRefusedError("mandate_expired", `mandate ${m.id} expired at ${m.expiresAt} (now ${now})`);
  }
  if (!m.terms.admission.mayAdmit) {
    throw new AdmissionRefusedError("admission_not_authorized", `mandate ${m.id} authorizes production only (mayProduce without mayAdmit); its results return for the human cohort decision`);
  }

  // 1b. Group eligibility, re-checked AT THE DOOR (#358 review S1): the
  // freeze already refuses mixed class-combinations / transformations /
  // verifier policies, but this table's own principle is that doors do not
  // trust hallways — a hand-built frozen structure must meet the same bar
  // here, where standing actually advances with no human to notice. D02's
  // "mixed-class results split before admission", enforced at admission.
  const grouped = groupIneligibilityOf(request.memberProposals);
  if (grouped !== null) {
    throw new AdmissionRefusedError("cohort_ineligible", `the member group is not one decision: ${grouped}`);
  }

  // 2. Every member was produced under THIS mandate — named misses, whole-abort.
  const foreign = frozenSubject.items.filter((i) => i.mandateId !== m.id).map((i) => i.noteId);
  if (foreign.length > 0) {
    throw new AdmissionRefusedError(
      "mandate_subject_mismatch",
      `${foreign.length} member(s) were not produced under mandate ${m.id}: ${foreign.join(", ")} — a mandate admits only its own work`,
      foreign
    );
  }

  // 3. Classes: automatable AND inside the mandate's grant. The registry
  // already cannot hold content/authority (WP10a's structural line) — this
  // is the door's own check, because doors do not trust hallways, and a
  // mandate may legally allow producing content that must NEVER auto-admit.
  for (const item of frozenSubject.items) {
    const notAutomatable = item.changeClasses.find((c) => !AUTOMATABLE_CLASSES.includes(c));
    if (notAutomatable !== undefined) {
      throw new AdmissionRefusedError("class_not_automatable", `member ${item.noteId} carries class '${notAutomatable}' — content and authority work never auto-admits (D02)`);
    }
    const escalated = item.changeClasses.find((c) => !m.terms.allowedClasses.includes(c));
    if (escalated !== undefined) {
      throw new AdmissionRefusedError("class_escalation", `member ${item.noteId} carries class '${escalated}', outside mandate ${m.id}'s grant (${m.terms.allowedClasses.join(", ")})`);
    }
    // 4. Scope, per member, named.
    if (item.path === null || !m.terms.scope.include.some((p) => pathWithin(item.path!, p)) || m.terms.scope.exclude.some((p) => pathWithin(item.path!, p))) {
      throw new AdmissionRefusedError("scope_escape", `member ${item.noteId} (${item.path ?? "no path"}) is outside mandate ${m.id}'s scope`);
    }
    // 5. Transformation: the mandate's exact named transformation, per member.
    if (item.transformation.id !== m.terms.transformation.id || item.transformation.version !== m.terms.transformation.version) {
      throw new AdmissionRefusedError(
        "transformation_mismatch",
        `member ${item.noteId} carries ${item.transformation.id}@${item.transformation.version}; mandate ${m.id} authorizes ${m.terms.transformation.id}@${m.terms.transformation.version}`
      );
    }
  }

  // 6. The transformation must be REGISTERED — promotion is defined only
  // over the registry, and an unregistered name has no tuple to have
  // evidenced.
  const t = ctx.transformation;
  if (t === null) {
    throw new AdmissionRefusedError("transformation_unregistered", `${m.terms.transformation.id}@${m.terms.transformation.version} is not a registered transformation; nothing unregistered auto-admits`);
  }
  if (t.id !== m.terms.transformation.id || t.version !== m.terms.transformation.version) {
    throw new AdmissionRefusedError("transformation_unregistered", "the resolved transformation does not match the mandate's — the context is answering a different question");
  }
  // 6b. The declared verifier must be covered by every member's predicate
  // list — the tuple's promise holds only if ITS verifier runs at this
  // admission (the coverage rows above prove the listed predicates ran;
  // this proves the list contains the right ones).
  for (const item of frozenSubject.items) {
    for (const p of t.verifier.predicates) {
      if (!item.predicates.some((sp) => sp.id === p.id && sp.version === p.version)) {
        throw new AdmissionRefusedError(
          "verifier_not_covered",
          `member ${item.noteId} does not carry the tuple's declared verifier ${p.id}@${p.version}; what was verified is not what was promoted`
        );
      }
    }
  }
  // 6c. Recovery: the frozen decision's unit must be the tuple's declared unit.
  if (frozenSubject.recoveryUnit !== t.recovery.unit) {
    throw new AdmissionRefusedError(
      "recovery_mismatch",
      `the cohort froze with recovery per ${frozenSubject.recoveryUnit}; the promoted tuple declares recovery per ${t.recovery.unit}`
    );
  }

  // 7. Promotion — the live-evidence gate's verdict, three-state and loud.
  // A verdict outside the known shapes is UNAVAILABLE, typed (#358 review
  // S2): the wrong-shaped answer must not surface as a TypeError laundered
  // into admission_error — the comment above promised its own refusal, and
  // now the code keeps it.
  const promo = ctx.promotion;
  if (promo === null || typeof promo !== "object" || (promo.state !== "promoted" && promo.state !== "unpromoted" && promo.state !== "unavailable")) {
    throw new AdmissionRefusedError("promotion_unavailable", "the promotion verdict was not a recognized shape; a broken evidence answer authorizes nothing");
  }
  if (promo.state === "unavailable") {
    throw new AdmissionRefusedError("promotion_unavailable", `the promotion evidence could not be read (${promo.detail}); a broken evidence store authorizes nothing`);
  }
  if (promo.state !== "promoted") {
    const missing = Array.isArray(promo.missing) ? promo.missing : [];
    throw new AdmissionRefusedError(
      "promotion_missing",
      `${t.id}@${t.version} is not promoted for automatic admission — ${missing.length > 0 ? `missing live evidence: ${missing.join("; ")}` : "the evidence gate is met but no human has promoted it"}`
    );
  }

  // 8. Budgets — the admission spends items; a reached budget is a normal stop.
  const breach = budgetBreach(m.terms.budgets, ctx.usage, m.activatedAt, now);
  if (breach !== null) {
    throw new AdmissionRefusedError("budget_exhausted", `mandate ${m.id}: ${breach.detail}`);
  }
}
