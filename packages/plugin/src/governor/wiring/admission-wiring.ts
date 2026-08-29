// ADMISSION WIRING — where the capabilities are built and nowhere else (WP6b-2).
//
// This file is THE deliberate addition to the standing-isolation scan's
// allowlist: it is the one production module that may name the standing ref,
// because it is the one that builds the `standingAdvance` capability and
// hands it — as a constructor argument, never a property — to the
// AdmissionService. Everything here is closure-held; nothing lands on the
// plugin instance, a view, a registry, or the DOM (§9, and the same pattern
// gesture.ts already relies on).
//
// FAIL DIRECTION, declared where a reader looks for it (threat model:
// "Every new control must declare its row before release"):
//
//   Mandate, attestation, and admission validation — FAIL CLOSED; the
//   subject REMAINS PROPOSED. Every refusal, every unknown, every crash
//   window before the CAS leaves the note not-admitted. The single
//   deliberate exception is documented at recordSettlement: a crash AFTER
//   the CAS leaves the admission standing with a degraded receipt, because
//   un-ringing the CAS would rewrite authority (#306's write-then-log call).
//
// The standing ref points at ADMISSION COMMITS, not claim ids: a git ref
// must name an object, so each admission writes a commit whose blob is the
// claim JSON and whose message names the claim id, chained on the previous
// standing commit. The kernel service works in claim ids; the capabilities
// built here translate. CAS runs over commit oids, so the git-level
// exactly-one-winner property carries the claim-level one.

import { createAdmissionService, type AdmissionService } from "../kernel/admission/service.js";
import { standingHealth, type StandingHealthReport } from "../kernel/admission/standing-health.js";
import { freezeCohort, excludeAndRefreeze, type FrozenCohort, type FreezeInput } from "../kernel/cohorts/freeze.js";
import { verifyCohortCoverage } from "../kernel/cohorts/coverage.js";
import { selectProposals, type CohortSelector } from "../kernel/cohorts/cohort.js";
import { createClaimStore, type ClaimIo } from "../kernel/admission/settlement.js";
import { AdmissionRefusedError } from "../kernel/admission/policy.js";
import { buildProposalItemSubject, subjectDigest } from "../kernel/contracts/subject-v1.js";
import { digestBytes } from "@vault-mcp/core";
import { standingRef } from "../kernel/history-store/refs.js";
import { RefCasError, type ObjectId } from "../kernel/history-store/types.js";
import type { HistoryRepository } from "../kernel/history-store/repository.js";
import { createDefaultPredicateRegistry } from "../kernel/verification/predicates.js";
import { tupleOf } from "../kernel/transformations/transformation.js";
import { budgetBreach, type MandateUsage } from "../kernel/mandates/budgets.js";
import type { MandateV1 } from "../kernel/mandates/mandate.js";
import type { MandateAdmissionContext } from "../kernel/admission/policy.js";
import { verifySubject } from "../kernel/verification/verify.js";
import type { ProposalStore } from "../kernel/proposals/proposal-store.js";
import type { ProposalV1 } from "../kernel/proposals/proposal.js";

export interface AdmissionUiDeps {
  /** Pending new-style proposals, for the pane's list. */
  pending(): Promise<ProposalV1[]>;
  /**
   * Freeze a selection of pending proposals into an immutable decision
   * subject (WP7b). Pure selection + freeze — confers nothing; the refusal
   * reason (mixed classes, open revisions…) comes back verbatim for the UI.
   */
  freezeSelection(selector: CohortSelector, recoveryUnit: "item" | "cohort"): Promise<{ ok: true; frozen: FrozenCohort; members: ProposalV1[] } | { ok: false; reason: string }>;
  /**
   * Admit a frozen cohort under one gesture. Same reachability contract as
   * admitWithGesture; the gestureRef arrives from the gate.
   */
  admitCohortWithGesture(frozen: FrozenCohort, members: ProposalV1[], gestureRef: string): Promise<CohortAdmitOutcome>;
  /** #337 option 4 — claims-exist-chain-absent surfaced as critical. */
  standingHealth(): Promise<StandingHealthReport>;
  /** Split by finding: exclude members and produce the successor decision. */
  refreezeWithout(frozen: FrozenCohort, members: ProposalV1[], excludeProposalIds: string[], recoveryUnit: "item" | "cohort"): Promise<{ ok: true; frozen: FrozenCohort; members: ProposalV1[] } | { ok: false; reason: string }>;
  /**
   * Admit one proposal. `gestureRef` is minted by the CLICK HANDLER — this
   * function is reachable only through the pane's gesture chain, and the
   * unreachability (closure-held deps, addEventListener wiring, isRealGesture)
   * is the enforcement, exactly as it is for acceptNote.
   */
  admitWithGesture(proposalId: string, gestureRef: string): Promise<AdmitOutcome>;
  /**
   * Revert the note to the proposal's recorded base — D06: revert is a NEW
   * change producing NEW history, never a rewrite. The proposal is superseded;
   * the written-back bytes surface through the ordinary review machinery.
   */
  revertToBase(proposalId: string, gestureRef: string): Promise<RevertOutcome>;
  /**
   * WP10b: admit a frozen cohort under a MANDATE — no gesture, the whole
   * refusal table instead (active mayAdmit mandate, every member its work,
   * automatable in-grant classes, in-scope, the exact registered
   * transformation with its declared verifier covered, the PROMOTED tuple,
   * budget remaining). Absent mandate machinery ⇒ refuses. NO production
   * caller in WP10b — the sweep that invokes it is WP10c's package; until
   * then this is the door, shipped closed and fully gated, the WP6 shape.
   */
  admitCohortUnderMandate(frozen: FrozenCohort, members: ProposalV1[], mandateId: string): Promise<CohortAdmitOutcome>;
  /**
   * WP10c: the mandated-admission sweep — the door's ONE production caller.
   * Groups pending mandate-stamped proposals per mandate, freezes each group,
   * and puts it through admitCohortUnderMandate; the whole refusal table
   * gates every attempt. Returns how many cohorts ADMITTED. Refusals leave
   * the proposals pending — the cohort-decision route to the pane — and are
   * attempt-deduped per (mandate, member-set) so a standing refusal is tried
   * once per member-set change, not once per poll. Quiet when there is
   * nothing to do; absent mandate machinery sweeps nothing.
   */
  sweepMandated(): Promise<number>;
}

export type CohortAdmitOutcome =
  | {
      ok: true;
      claimId: string;
      degraded: boolean;
      /** Condition 10: "human-gesture" or "mandate:<id>" — the receipt says which door opened. */
      authority: string;
      receipt: { subjectDigest: string; memberCount: number; predicates: string[]; verifier: string; coverage: "exact-and-total" };
    }
  | { ok: false; code: string; detail: string; failedNoteIds?: string[] };

export type AdmitOutcome =
  | {
      ok: true;
      claimId: string;
      /** True when the settlement record failed AFTER the CAS: the admission stands; the record is catching up (journal.status "degraded"). */
      degraded: boolean;
      /** Receipt material — the never-say rules need subject, predicate, verifier, and coverage NAMED. */
      receipt: { subjectDigest: string; predicates: string[]; verifier: string; coverage: "exact-and-total" };
    }
  | { ok: false; code: string; detail: string };

export type RevertOutcome = { ok: true; supersededProposalId: string } | { ok: false; code: string; detail: string };

export interface BuildAdmissionDeps {
  repo: () => Promise<HistoryRepository>;
  claimIo: ClaimIo;
  proposals: ProposalStore;
  /** Current note bytes, or null when the note does not exist. */
  readNoteBytes(path: string): Promise<Uint8Array | null>;
  /** Write note bytes through the plugin's ordinary write machinery (revert). */
  writeNoteBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Append one settlement line to the acceptance log. */
  appendSettlement(record: { event: "admission-settlement"; claimId: string; subjectDigest: string; ts: string; authority: string }): Promise<void>;
  /** Rebuildable projections refresh (the pane nudge). Optional. */
  /**
   * The cutover marker↔store binding gate (store-binding.ts). When present
   * and not ok, BOTH admit paths refuse before any work: on a machine whose
   * local store is not the one the marker authorizes (a restore without its
   * chain, an unbound pre-binding marker), admitting would silently grow a
   * NEW chain beside a marker naming another — the exact split the binding
   * exists to prevent. Refusing both ways: legacy already refuses (cutOver),
   * and admission refuses HERE with the verdict's own honest detail.
   *
   * REQUIRED and called unconditionally (review finding - fourth
   * guard-exists-path-doesn't-run of the week): as an optional field, the
   * one production wiring in main.ts was unpinned and deletable with a
   * green suite. Required means the COMPILER pins the wiring: a .ts caller
   * cannot build without providing the gate.
   */
  bindingGate: () => Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
  refreshProjections?: () => Promise<void>;
  /**
   * The predicate registry admission verifies against. OPTIONAL with the
   * default registry as fallback — but production (main.ts) passes the ONE
   * shared instance the transformation registry also validates against, so
   * "a transformation's declared verifier is registered" and "admission can
   * run that verifier" are the same fact by construction (WP10a): a subject
   * naming a predicate this registry lacks refuses at admission, which is
   * exactly what makes recorded evidence honest about what ran.
   */
  predicates?: import("../kernel/verification/registry.js").PredicateRegistry;
  /**
   * WP10a: the promotion-evidence recorder. OPTIONAL and a FACT-RECORDER,
   * not a gate (the refreshProjections class, not the bindingGate class):
   * absence records nothing, and a recording failure never fails the
   * admission it describes. Evidence accrues ONLY to transformations the
   * registry actually holds — an unregistered transformation's admissions
   * are ordinary human decisions, evidence for nothing automatic.
   */
  promotion?: {
    transformationOf(id: string, version: string): import("../kernel/transformations/transformation.js").TransformationV1 | null;
    recordEvidence(
      tuple: import("../kernel/transformations/promotion.js").PromotionTuple,
      evidence: { kind: "individual-admit" | "cohort-admit" | "revert"; ref: string; memberCount?: number },
      now: number
    ): Promise<void>;
    /** WP10b: the promotion verdict the mandate door consumes. A THROW here refuses the admission (promotion_unavailable via the context resolver) — never a silent unpromoted. */
    verdictOf(tuple: import("../kernel/transformations/promotion.js").PromotionTuple): Promise<import("../kernel/transformations/promotion.js").PromotionVerdict>;
  };
  /**
   * WP10b: the mandate store's admission-facing verbs. Optional — absent
   * (tests, bare embeds, gesture-only wirings) means every mandate-authority
   * admission refuses mandate_unavailable, which is the fail-closed shape.
   */
  mandates?: {
    get(mandateId: string): Promise<MandateV1 | null>;
    usageOf(mandateId: string): Promise<MandateUsage>;
    charge(mandateId: string, delta: Partial<MandateUsage>, now: number): Promise<void>;
    markExhausted(mandateId: string, breach: string, now: number): Promise<void>;
  };
  now?: () => number;
}

/** The admission-commit message format — the claimId↔oid translation's carrier. */
const STANDING_MESSAGE = /^admission ([0-9a-f-]+)\n/;

export function buildAdmission(deps: BuildAdmissionDeps): AdmissionUiDeps {
  const now = deps.now ?? (() => Date.now());
  // WP10c sweep state, closure-held (never on the plugin/app): the last
  // attempted member-set per mandate, and the last refusal logged per
  // mandate — dedupe, not authority; losing them on reload costs one retry.
  const sweepAttempts = new Map<string, string>();
  const logOnceKeys = new Map<string, string>();
  const claims = createClaimStore(deps.claimIo);
  const registry = deps.predicates ?? createDefaultPredicateRegistry();

  // Promotion evidence (WP10a): one recording site per admission/revert
  // outcome, keyed on the REGISTERED transformation (tupleOf builds the
  // tuple from the registered declaration, never from the subject's own
  // predicate list). Total: any throw lands in console.error and the
  // admission's own result is untouched — a fact-recorder must never cost
  // the act it describes. Degraded successes deliberately do NOT record:
  // under-counting is the safe direction for a promotion gate, and the
  // degraded branch is a crash-recovery path, not a place to grow evidence.
  const recordPromotionEvidence = (
    subject: {
      transformation: { id: string; version: string };
      predicates: Array<{ id: string; version: string }>;
      changeClasses: readonly string[];
    } | null | undefined,
    kind: "individual-admit" | "cohort-admit" | "revert",
    ref: string,
    memberCount?: number
  ): void => {
    try {
      if (!deps.promotion || !subject) return;
      const t = deps.promotion.transformationOf(subject.transformation.id, subject.transformation.version);
      if (t === null) return;
      // THE HONESTY CONTAINMENTS (review of #357, rule 1: claim vs evidence).
      // Evidence for tuple X must describe work that actually WAS X's shape:
      //   * the subject's predicate list must cover the declared verifier set
      //     — otherwise "admitted under X's verifier" was never checked;
      //   * the subject's classes must fit the declared footprint — an
      //     out-of-footprint admission is evidence for a different animal;
      //   * a revert drills the declared recovery path only when the UNIT
      //     matches — an item revert does not exercise "recovery per cohort"
      //     (cohort-unit tuples wait for the cohort-scale revert verb; their
      //     missing drill stays NAMED in the pane, which is the honest state).
      // Each miss is a CLEAN skip (pinned silent), not a crash.
      const declared = new Map(t.verifier.predicates.map((p) => [p.id, p.version]));
      for (const [id, version] of declared) {
        if (!subject.predicates.some((p) => p.id === id && p.version === version)) return;
      }
      if (!subject.changeClasses.every((c) => (t.appliesTo as readonly string[]).includes(c))) return;
      if (kind === "revert" && t.recovery.unit !== "item") return;
      void deps.promotion
        .recordEvidence(tupleOf(t), { kind, ref, ...(memberCount !== undefined ? { memberCount } : {}) }, now())
        .catch((e) => console.error("[governor] promotion evidence record failed (facts only; the decision stands)", e));
    } catch (e) {
      console.error("[governor] promotion evidence record failed (facts only; the decision stands)", e);
    }
  };

  /** The claim id the standing ref currently names, or null. */
  async function currentStanding(): Promise<string | null> {
    const repo = await deps.repo();
    const oid = await repo.resolveRef(standingRef());
    if (oid === null) return null;
    const commit = await repo.readCommit(oid);
    const m = STANDING_MESSAGE.exec(commit.message + "\n");
    if (!m) {
      // A standing ref naming a commit that is not an admission commit is
      // §10's critical health failure — surfaced, never read as absence.
      throw new Error(`standing ref names commit ${oid} whose message is not an admission record — critical health failure`);
    }
    return m[1];
  }

  /** CAS in claim ids, executed over commit oids. */
  async function standingAdvance(expectedClaimId: string | null, nextClaimId: string): Promise<void> {
    const repo = await deps.repo();
    const curOid = await repo.resolveRef(standingRef());
    const curClaim = curOid === null ? null : await claimIdOf(repo, curOid);
    if (curClaim !== expectedClaimId) throw new RefCasError(standingRef(), expectedClaimId, curClaim);
    const claim = await claims.byId(nextClaimId);
    // The commit's blob carries the claim JSON — the standing chain is
    // readable by stock git without the jsonl store (D08's export posture).
    const blob = await repo.writeBlob(new TextEncoder().encode(JSON.stringify(claim ?? { id: nextClaimId })));
    const tree = await repo.writeTree([{ mode: "100644", path: "claim.json", oid: blob, type: "blob" }]);
    const commit = await repo.writeCommit({
      message: `admission ${nextClaimId}\n`,
      tree,
      parents: curOid === null ? [] : [curOid],
      timestamp: Math.floor(now() / 1000),
    });
    await repo.casRef(standingRef(), curOid, commit);
  }

  async function claimIdOf(repo: HistoryRepository, oid: ObjectId): Promise<string | null> {
    const commit = await repo.readCommit(oid);
    const m = STANDING_MESSAGE.exec(commit.message + "\n");
    return m ? m[1] : null;
  }

  /** Base bytes from the proposal's recording ref chain (the base commit is the chain's root). */
  async function baseBytesOf(proposal: ProposalV1): Promise<Uint8Array | null> {
    if (proposal.recordingRef === null || proposal.subject.path === null) return null;
    const repo = await deps.repo();
    const chain = await repo.log(proposal.recordingRef, 10);
    const baseCommit = chain[chain.length - 1]; // oldest = the base snapshot
    if (!baseCommit) return null;
    return readFileFromTree(repo, baseCommit.tree, proposal.subject.path);
  }

  const service: AdmissionService = createAdmissionService({
    claims,
    standingAdvance,
    currentStanding,
    verifyCohort: async (frozenSubject, cohortDigest, memberProposals) => {
      // The cohort-shaped verify capability: full coverage, evidence per item
      // resolved by Governor from the recording refs and the current vault —
      // the same sources the item path uses, exact and total. The member
      // proposals arrive ON THE CALL, so the item↔proposal correlation is a
      // local map per invocation — no state shared across admissions (the
      // shared-map draft raced: one call's cleanup emptied another's
      // correlation before its serialized coverage ran, refusing healthy
      // members and feeding split-by-finding corrupted evidence).
      const byIdentity = new Map(memberProposals.map((p) => [`${p.subject.vaultId}\u0000${p.subject.noteId}`, p]));
      const shaped = {
        subject: frozenSubject,
        digest: { algorithm: "sha256" as const, value: cohortDigest },
        memberProposalIds: frozenSubject.items.map((item) => byIdentity.get(`${item.vaultId}\u0000${item.noteId}`)?.id ?? ""),
      };
      return verifyCohortCoverage(
        registry,
        shaped as import("../kernel/cohorts/freeze.js").FrozenCohort,
        async (item) => {
          const proposedBytes = item.path === null ? null : await deps.readNoteBytes(item.path);
          const proposal = byIdentity.get(`${item.vaultId}\u0000${item.noteId}`) ?? null;
          const baseBytes = proposal ? await baseBytesOf(proposal) : null;
          return { baseBytes, proposedBytes };
        },
        now()
      );
    },
    verify: async (subject) => {
      // Evidence resolved by GOVERNOR at admission time: proposed bytes are
      // the CURRENT note (what the human is looking at), base bytes replay
      // from the recording. The caller supplies neither.
      const proposal = subjectProposal.get(subject);
      const proposedBytes = subject.path === null ? null : await deps.readNoteBytes(subject.path);
      const baseBytes = proposal ? await baseBytesOf(proposal) : null;
      return verifySubject(registry, subject, { baseBytes, proposedBytes }, now());
    },
    recordSettlement: async (r) => {
      await deps.appendSettlement({
        event: "admission-settlement",
        claimId: r.claimId,
        subjectDigest: r.subjectDigest,
        ts: new Date(r.at).toISOString(),
        // Condition 10: an automatic admission is distinguishable in what a
        // human reads afterward — the settlement line names its authority.
        authority: r.authority,
      });
    },
    refreshProjections: deps.refreshProjections,
    // WP10b: the mandate refusal table's fact resolver. Distinctions kept
    // loud: a store that THROWS surfaces as promotion "unavailable" (its own
    // refusal), never as unpromoted; an unregistered transformation resolves
    // to null and the policy names it transformation_unregistered.
    mandateContext:
      deps.mandates &&
      (async (mandateId, transformation) => {
        const mandate = await deps.mandates!.get(mandateId);
        const usage = await deps.mandates!.usageOf(mandateId);
        const t = deps.promotion?.transformationOf(transformation.id, transformation.version) ?? null;
        let promotion: MandateAdmissionContext["promotion"];
        if (t === null || !deps.promotion) {
          promotion = { state: "unavailable", detail: "no registered transformation/promotion machinery to consult" };
        } else {
          try {
            promotion = await deps.promotion.verdictOf(tupleOf(t));
          } catch (e) {
            promotion = { state: "unavailable", detail: e instanceof Error ? e.message : String(e) };
          }
        }
        return { mandate, usage, transformation: t, promotion };
      }),
    // Budget charge after a mandate admission stands; an observed breach is
    // recorded as the normal stop (exhausted), durably.
    chargeMandate:
      deps.mandates &&
      (async (mandateId, delta, at) => {
        await deps.mandates!.charge(mandateId, delta, at);
        const m = await deps.mandates!.get(mandateId);
        if (m && m.status === "active") {
          const breach = budgetBreach(m.terms.budgets, await deps.mandates!.usageOf(mandateId), m.activatedAt, at);
          if (breach !== null) await deps.mandates!.markExhausted(mandateId, breach.detail, at);
        }
      }),
    now,
  });

  // The verify closure needs the PROPOSAL for the recording ref, but the
  // service hands it only the subject. Correlated through a WeakMap keyed on
  // the exact subject object admitWithGesture passes — no ambient state, no
  // id-keyed map that could cross admissions.
  const subjectProposal = new WeakMap<object, ProposalV1>();

  function cohortReceipt(subjectDigest: string, frozen: FrozenCohort) {
    return {
      subjectDigest,
      memberCount: frozen.subject.items.length,
      predicates: [...new Set(frozen.subject.items.flatMap((i) => i.predicates.map((p) => `${p.id}@${p.version}`)))],
      verifier: "governor cohort coverage (deterministic, run at admission, exact and total)",
      coverage: "exact-and-total" as const,
    };
  }

  // The shared cohort-decision core (WP10b): one body, two doors. The
  // gesture door passes the human's ref; the mandate door passes the mandate
  // authority and the service resolves + judges the full refusal table.
  // Everything else — binding gate, click/decision-time member re-fetch,
  // already-standing self-heal, per-member re-observation, degraded-window
  // discrimination — is IDENTICAL on purpose: the automatic path gets no
  // smaller entrance (governor-lead's condition on second doors).
  async function decideCohortAdmission(
    frozen: FrozenCohort,
    members: ProposalV1[],
    authority: import("../kernel/admission/policy.js").AdmissionAuthority
  ): Promise<CohortAdmitOutcome> {
    const authorityLabel = authority.kind === "human-gesture" ? "human-gesture" : `mandate:${authority.mandateId}`;
      // The degraded discriminator is standing MOVEMENT during this call —
      // the item path's rule, applied at cohort scale. A failed pre-read is
      // "unknown", which suppresses the degraded-success branch entirely.
      let preHead: string | null = null;
      let preHeadKnown = false;
      try {
        // Inside the try (review symmetry): a THROWING gate degrades to the
        // caught admission_error like the item path's — never an unhandled
        // rejection in a click handler. Unreachable with today's
        // swallow-everything reads; pinned by shape, not by reachability.
        {
          const gate = await deps.bindingGate();
          if (!gate.ok) return { ok: false, code: gate.code, detail: gate.detail };
        }
        // RE-FETCH EVERY MEMBER at click time: the caller's array is a
        // freeze-time snapshot, and an authority/development flip that
        // changes no note bytes (a revision request, a concurrent admission)
        // is invisible to byte drift — only fresh facts can see it. The
        // policy's member table then judges the CURRENT proposals.
        const fresh: ProposalV1[] = [];
        for (const m of members) {
          const cur = await deps.proposals.get(m.id);
          if (!cur) return { ok: false, code: "proposal_unknown", detail: `member proposal ${m.id} no longer exists` };
          fresh.push(cur);
        }
        const byIdentity = new Map(fresh.map((m) => [`${m.subject.vaultId}\u0000${m.subject.noteId}`, m]));

        // Already standing? Refuse TRUTHFULLY and retry the projection
        // catch-up so the pane self-heals (the item path's F2 rule).
        try {
          preHead = await currentStanding();
          preHeadKnown = true;
        } catch {
          preHead = null;
        }
        {
          // The self-heal scans the WHOLE claim store, not the head (#358
          // review B1's wiring half): a lagged projection plus an interleaved
          // unrelated admission left the pane offering this cohort forever —
          // the service now refuses the duplicate either way; this makes the
          // refusal also CATCH THE PROJECTIONS UP. Compared against the
          // RECOMPUTED cohort digest, never the caller's precomputed
          // frozen.digest (freeze.ts's obligation): a mis-correlated
          // frozen/members pair must not stamp never-admitted members
          // "admitted" under a claim that does not cover them.
          const priorSame = await claims.bySubject(subjectDigest(frozen.subject).value);
          if (priorSame.length > 0) {
            const prior = priorSame[priorSame.length - 1];
            for (const m of fresh) {
              try {
                await deps.proposals.setVerification(m.id, "passed", now());
                await deps.proposals.markAdmitted(m.id, prior.id, now());
              } catch {
                /* projection remains behind; the refusal still tells the truth */
              }
            }
            return { ok: false, code: "already_admitted", detail: `this exact cohort was already admitted as claim ${prior.id}; nothing further to admit` };
          }
        }

        // RE-OBSERVE EVERY MEMBER: correlated to the frozen manifest by NOTE
        // IDENTITY (the manifest is canonically sorted; caller order is not
        // trusted) — any drifted member, any identity gap, aborts WHOLE with
        // the item(s) named.
        const drifted: string[] = [];
        for (const item of frozen.subject.items) {
          const proposal = byIdentity.get(`${item.vaultId}\u0000${item.noteId}`);
          if (!proposal) {
            return { ok: false, code: "subject_drift", detail: `frozen item ${item.noteId} has no corresponding member proposal` };
          }
          if (item.path === null) return { ok: false, code: "path_missing", detail: `member ${item.noteId} has no path to re-observe` };
          const current = await deps.readNoteBytes(item.path);
          if (current === null || digestBytes(current).value !== item.proposed.value) {
            drifted.push(item.noteId);
          }
        }
        if (drifted.length > 0) {
          return {
            ok: false,
            code: "subject_drift",
            detail: `${drifted.length} member(s) changed since the decision was frozen: ${drifted.join(", ")} — the whole cohort aborts; split by finding or re-freeze`,
            failedNoteIds: drifted,
          };
        }

        const { claim } = await service.admitCohort({
          frozenSubject: frozen.subject,
          gestureCoveredDigest: frozen.digest.value,
          memberProposals: fresh,
          authority,
        });

        // Projections: every member catches up; failures degrade (D05).
        for (const m of fresh) {
          try {
            await deps.proposals.setVerification(m.id, "passed", now());
            await deps.proposals.markAdmitted(m.id, claim.id, now());
          } catch (e) {
            console.error("[governor] member projection update after cohort admission failed (rebuildable)", e);
          }
        }

        // One cohort, one transformation (groupIneligibilityOf refuses mixed),
        // so the first member speaks for the manifest.
        if (authority.kind === "human-gesture") recordPromotionEvidence(fresh[0]?.subject, "cohort-admit", frozen.digest.value, fresh.length);
        return {
          ok: true,
          claimId: claim.id,
          degraded: false,
          authority: authorityLabel,
          receipt: cohortReceipt(claim.subjectDigest.value, frozen),
        };
      } catch (e) {
        if (e instanceof AdmissionRefusedError) {
          return { ok: false, code: e.code, detail: e.message, ...(e.failedNoteIds && e.failedNoteIds.length > 0 ? { failedNoteIds: [...e.failedNoteIds] } : {}) };
        }
        if (e instanceof RefCasError) return { ok: false, code: e.code, detail: "standing moved during this admission; re-open and decide again" };
        // A throw AFTER the CAS is the degraded window: the admission may
        // stand while the settlement record is missing. Same movement
        // discrimination as the item path: standing must have advanced
        // DURING THIS CALL to a claim covering THIS cohort digest — then the
        // truth is a degraded success, the projections still catch up, and
        // the receipt says the settlement record was not written.
        try {
          const head = await currentStanding();
          if (preHeadKnown && head !== null && head !== preHead) {
            const claim = await claims.byId(head);
            if (claim && claim.subjectDigest.value === frozen.digest.value) {
              for (const m of members) {
                try {
                  await deps.proposals.setVerification(m.id, "passed", now());
                  await deps.proposals.markAdmitted(m.id, claim.id, now());
                } catch {
                  /* rebuildable */
                }
              }
              return { ok: true, claimId: head, degraded: true, authority: authorityLabel, receipt: cohortReceipt(claim.subjectDigest.value, frozen) };
            }
          }
        } catch {
          /* fall through to the plain failure */
        }
        return { ok: false, code: "admission_error", detail: e instanceof Error ? e.message : String(e) };
      }
    }

  return {
    async pending() {
      return deps.proposals.pending();
    },

    async freezeSelection(selector, recoveryUnit) {
      try {
        const pending = await deps.proposals.pending();
        const selected = selectProposals(pending, selector);
        if (selected.length === 0) return { ok: false, reason: "the selection matches no pending proposals" };
        const frozen = freezeCohort({ items: selected, resolvedScope: { include: [], exclude: [] }, recoveryUnit });
        // Members are returned in the SUBJECT's canonical item order (the
        // freeze sorts items by noteId; selection order is arbitrary), so
        // members[i] corresponds to frozen.subject.items[i] for every caller.
        const byId = new Map<string, ProposalV1>(selected.map((m) => [m.id, m]));
        return { ok: true, frozen, members: frozen.memberProposalIds.map((id) => byId.get(id)!) };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async refreezeWithout(frozen, members, excludeProposalIds, recoveryUnit) {
      try {
        const input: FreezeInput = {
          items: members,
          resolvedScope: frozen.subject.resolvedScope,
          recoveryUnit,
          excludedProposalIds: [...frozen.subject.excludedProposalIds],
        };
        const successor = excludeAndRefreeze(input, frozen, excludeProposalIds);
        const byId = new Map<string, ProposalV1>(members.map((m) => [m.id, m]));
        return { ok: true, frozen: successor, members: successor.memberProposalIds.map((id) => byId.get(id)!) };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async standingHealth(): Promise<StandingHealthReport> {
      // #337 option 4: the chain-absent direction surfaced as CRITICAL. The
      // chain reader reuses claimIdOf — one canonical parse of the standing
      // commit message, never a second regex.
      return standingHealth({
        claims,
        standingChain: async () => {
          const repo = await deps.repo();
          const head = await repo.resolveRef(standingRef());
          if (head === null) return [];
          const ids: string[] = [];
          for (const entry of await repo.log(standingRef(), 100000)) {
            const id = await claimIdOf(repo, entry.oid);
            if (id !== null) ids.push(id);
          }
          return ids;
        },
      });
    },

    async admitCohortWithGesture(frozen, members, gestureRef) {
      return decideCohortAdmission(frozen, members, { kind: "human-gesture", gestureRef });
    },

    // WP10b: the mandate door. Same core, no gesture — the refusal table is
    // the gate. WP10c's sweep below is its one production caller.
    async admitCohortUnderMandate(frozen, members, mandateId) {
      return decideCohortAdmission(frozen, members, { kind: "mandate", mandateId });
    },

    async sweepMandated() {
      // No mandate machinery ⇒ nothing can pass the door; don't even look.
      if (!deps.mandates) return 0;
      let admitted = 0;
      try {
        const pending = await deps.proposals.pending();
        const byMandate = new Map<string, ProposalV1[]>();
        for (const p of pending) {
          const id = p.subject.mandateId;
          if (id !== null) (byMandate.get(id) ?? byMandate.set(id, []).get(id)!).push(p);
        }
        for (const [mandateId, members] of byMandate) {
          try {
            // Cheap pre-checks — the DOOR stays authoritative; these only
            // avoid freezing+verifying cohorts that cannot possibly pass.
            const mandate = await deps.mandates.get(mandateId);
            if (!mandate || mandate.status !== "active" || !mandate.terms.admission.mayAdmit) continue;

            // Attempt-dedupe: one try per exact member-set. A refused cohort
            // whose members have not changed is not retried every poll —
            // per-poll coverage verification would be real work and the
            // refusal deterministic. Any member change (new proposal, admit,
            // supersede) changes the key and re-arms the attempt.
            const attemptKey = members.map((m) => `${m.id}:${m.subjectDigest.value}`).sort().join(",");
            if (sweepAttempts.get(mandateId) === attemptKey) continue;
            sweepAttempts.set(mandateId, attemptKey);

            // Freeze with the TUPLE's declared recovery unit — the door
            // refuses recovery_mismatch otherwise, so the sweep freezes what
            // the promotion actually covers. Unregistered ⇒ the door refuses
            // transformation_unregistered; freeze with "item" and let it say so.
            const t = deps.promotion?.transformationOf(mandate.terms.transformation.id, mandate.terms.transformation.version) ?? null;
            const sel = await this.freezeSelection({ mandateId }, t?.recovery.unit ?? "item");
            if (!sel.ok) continue; // ineligible group (mixed, revising member…) — the pane's business
            const outcome = await this.admitCohortUnderMandate(sel.frozen, sel.members, mandateId);
            if (outcome.ok) {
              admitted++;
              sweepAttempts.delete(mandateId); // a success re-arms — the next batch is a new decision
              console.log(
                `[governor] mandated admission: ${outcome.receipt.memberCount} result(s) admitted under mandate ${mandateId.slice(0, 8)}… ` +
                  `(claim ${outcome.claimId.slice(0, 8)}…, ${outcome.authority})`
              );
            } else if (logOnceKeys.get(mandateId) !== `${attemptKey}:${outcome.code}`) {
              // A refusal is the cohort-decision route working — log once per
              // (member-set, code) so a standing refusal is diagnosable
              // without being noise (the legacy sweep's lesson).
              logOnceKeys.set(mandateId, `${attemptKey}:${outcome.code}`);
              console.log(`[governor] mandated admission declined for mandate ${mandateId.slice(0, 8)}… [${outcome.code}]: ${outcome.detail} — the cohort stays for the human decision`);
            }
          } catch (e) {
            console.error(`[governor] mandated sweep failed for mandate ${mandateId} (fail closed; nothing admitted for it)`, e);
          }
        }
      } catch (e) {
        console.error("[governor] mandated sweep failed (fail closed; nothing admitted)", e);
      }
      return admitted;
    },

    async admitWithGesture(proposalId, gestureRef) {
      // Visible to the catch below: the degraded discriminator is standing
      // MOVEMENT during this call, so the pre-call head must survive the try.
      // `preHeadKnown` is the re-review's transient-fault sentinel: a FAILED
      // pre-read is "unknown", not "absent" — and an unknown starting point
      // suppresses the degraded-success branch entirely, because movement
      // cannot be asserted from a point nobody saw.
      let preHead: string | null = null;
      let preHeadKnown = false;
      try {
        {
          const gate = await deps.bindingGate();
          if (!gate.ok) return { ok: false, code: gate.code, detail: gate.detail };
        }
        const proposal = await deps.proposals.get(proposalId);
        if (!proposal) return { ok: false, code: "proposal_unknown", detail: `no proposal ${proposalId}` };
        if (proposal.subject.path === null) return { ok: false, code: "path_missing", detail: "this proposal has no path to re-observe" };

        // Already standing? Refuse TRUTHFULLY rather than chaining a silent
        // duplicate admission commit (review F2: a failed projection update
        // left the pane offering Admit again, and the second gesture passed
        // every policy row). The refusal also retries the projection catch-up
        // so the pane self-heals instead of offering the button forever.
        try {
          preHead = await currentStanding();
          preHeadKnown = true;
        } catch {
          preHead = null;
        }
        if (preHead !== null) {
          const headClaim = await claims.byId(preHead);
          if (headClaim && headClaim.subjectDigest.value === proposal.subjectDigest.value) {
            try {
              await deps.proposals.setVerification(proposalId, "passed", now());
              await deps.proposals.markAdmitted(proposalId, headClaim.id, now());
            } catch {
              /* projection remains behind; the refusal below still tells the truth */
            }
            return { ok: false, code: "already_admitted", detail: `this exact subject already stands as claim ${headClaim.id}; nothing further to admit` };
          }
        }

        // RE-OBSERVE AT CLICK TIME (review-and-safety: "a changed item aborts
        // admission rather than shrinking or expanding the decision
        // silently"): the click-time subject carries the CURRENT bytes'
        // digest; any edit since the proposal changes the digest and the
        // policy refuses with subject_drift.
        const current = await deps.readNoteBytes(proposal.subject.path);
        if (current === null) return { ok: false, code: "note_missing", detail: `${proposal.subject.path} no longer exists (D06: a disappearance is a fact; the proposal stays proposed)` };
        const { schema, ...rest } = proposal.subject;
        void schema;
        const clickSubject = buildProposalItemSubject({ ...rest, proposed: digestBytes(current) });

        subjectProposal.set(clickSubject, proposal);
        const { claim } = await service.admit({ proposal, subject: clickSubject, authority: { kind: "human-gesture", gestureRef } });

        // Projections catch up; failures degrade (D05).
        try {
          await deps.proposals.setVerification(proposalId, "passed", now());
          await deps.proposals.markAdmitted(proposalId, claim.id, now());
        } catch (e) {
          console.error("[governor] proposal projection update after admission failed (rebuildable)", e);
        }

        recordPromotionEvidence(proposal.subject, "individual-admit", claim.id);
        return {
          ok: true,
          claimId: claim.id,
          degraded: false,
          receipt: {
            subjectDigest: claim.subjectDigest.value,
            predicates: proposal.subject.predicates.map((p) => `${p.id}@${p.version}`),
            verifier: "governor content-diff@1 (deterministic, run at admission)",
            coverage: "exact-and-total",
          },
        };
      } catch (e) {
        if (e instanceof AdmissionRefusedError) return { ok: false, code: e.code, detail: e.message };
        if (e instanceof RefCasError) return { ok: false, code: e.code, detail: "standing moved during this admission; re-open the pane and decide again" };
        // A throw AFTER the CAS is the degraded window: the claim may stand
        // while the settlement record is missing. The discriminator is
        // MOVEMENT (review F1): standing must have advanced DURING THIS CALL
        // to a claim for this subject — a pre-existing claim with a matching
        // digest means this act never happened, and that case is answered by
        // the already_admitted refusal above, never by a degraded success
        // that would attribute a failed act to a prior admission.
        try {
          const head = await currentStanding();
          if (preHeadKnown && head !== null && head !== preHead) {
            const claim = await claims.byId(head);
            const proposal = await deps.proposals.get(proposalId);
            if (claim && proposal && claim.subjectDigest.value === proposal.subjectDigest.value) {
              return {
                ok: true,
                claimId: head,
                degraded: true,
                receipt: {
                  subjectDigest: claim.subjectDigest.value,
                  predicates: proposal.subject.predicates.map((p) => `${p.id}@${p.version}`),
                  verifier: "governor content-diff@1 (deterministic, run at admission)",
                  coverage: "exact-and-total",
                },
              };
            }
          }
        } catch {
          /* fall through to the plain failure */
        }
        return { ok: false, code: "admission_error", detail: e instanceof Error ? e.message : String(e) };
      }
    },

    async revertToBase(proposalId, gestureRef) {
      try {
        if (!gestureRef) return { ok: false, code: "authority_missing", detail: "revert is a human act" };
        const proposal = await deps.proposals.get(proposalId);
        if (!proposal) return { ok: false, code: "proposal_unknown", detail: `no proposal ${proposalId}` };
        if (proposal.authority !== "proposed") return { ok: false, code: "proposal_not_proposed", detail: `the proposal is ${proposal.authority}` };
        if (proposal.subject.path === null) return { ok: false, code: "path_missing", detail: "no path to revert" };
        // A creation's recorded base is NON-EXISTENCE. Writing an empty file
        // would misdescribe it (review F3: "the recorded base bytes" would be
        // a lie), and deletion machinery is the structural action's territory
        // — so this refuses with the honest code until that action exists.
        if (proposal.subject.base === null) {
          return { ok: false, code: "creation_revert_unsupported", detail: "this proposal created the note; its base is non-existence, and deleting is a structural act this surface does not perform" };
        }
        const base = await baseBytesOf(proposal);
        if (base === null) {
          return { ok: false, code: "base_unavailable", detail: "the recorded base cannot be read back; refusing a guessed revert" };
        }
        // The recording is VERIFIED against the subject before anything is
        // written (review F7): if the ref chain ever grows past the
        // producer's two commits, "oldest of the last 10" could be the wrong
        // commit, and a revert writing wrong bytes while saying "the
        // recorded base" is the exact confident-wrong-answer class.
        if (digestBytes(base).value !== proposal.subject.base.value) {
          return { ok: false, code: "base_mismatch", detail: "the recording's base does not digest to the subject's base; refusing rather than reverting to the wrong bytes" };
        }
        // D06: the revert WRITES NEW bytes through the ordinary machinery —
        // new history, a new subject if anything proposes it — and the
        // rejected result stays preserved in the recording ref. Nothing is
        // rewritten.
        await deps.writeNoteBytes(proposal.subject.path, base);
        try {
          await deps.proposals.supersede(proposalId, now());
        } catch (e) {
          // The bytes ARE back; only the projection failed. The receipt must
          // say what ran (review F4) — a plain "not reverted" would deny a
          // mutation that happened.
          return { ok: false, code: "revert_partial", detail: `the base bytes were written back, but the proposal could not be superseded (${e instanceof Error ? e.message : String(e)}); a later Admit will refuse with subject_drift` };
        }
        recordPromotionEvidence(proposal.subject, "revert", proposalId);
        return { ok: true, supersededProposalId: proposalId };
      } catch (e) {
        return { ok: false, code: "revert_error", detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** Walk a (possibly nested) tree to a file's bytes; null when absent. */
export async function readFileFromTree(repo: HistoryRepository, treeOid: ObjectId, filePath: string): Promise<Uint8Array | null> {
  const segments = filePath.split("/");
  let tree = await repo.readTree(treeOid);
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = tree.find((e) => e.path === segments[i] && e.type === "tree");
    if (!dir) return null;
    tree = await repo.readTree(dir.oid);
  }
  const file = tree.find((e) => e.path === segments[segments.length - 1] && e.type === "blob");
  if (!file) return null;
  return repo.readBlob(file.oid);
}

