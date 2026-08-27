/**
 * governance-mandate-admission.test.mjs — WP10b: the admission mandate arms.
 *
 * The package that makes standing advance without a human click, so the
 * tests are built around governor-lead's conditions: (1) a mandate-ELIGIBLE
 * cohort — active mayAdmit mandate, promoted tuple, everything matching —
 * still refuses on the human path without a gesture; (6) the claim
 * authority is a widened discriminated union; (7) a THROWING evidence store
 * and an EMPTY one refuse separately, with different codes; (9) escalation
 * refuses at the door independently of the registry's structural line;
 * (10) an automatic admission is distinguishable in the claim, the
 * settlement record, and the outcome. Plus: the eligible baseline ADMITS
 * (the whole point), and each refusal-table row is a one-field mutation of
 * that passing case.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAdmission } from "../src/governor/wiring/admission-wiring.ts";
import { openGitRepository } from "../src/governor/wiring/history-store/git-repository.ts";
import { proposalRef } from "../src/governor/kernel/history-store/refs.ts";
import { createProposalStore } from "../src/governor/kernel/proposals/proposal-store.ts";
import { openProposal } from "../src/governor/kernel/proposals/proposal.ts";
import { buildProposalSubjectFromOperation } from "../src/governor/kernel/proposals/proposal-builder.ts";
import { digestBytes } from "@vault-mcp/core";
import { createDefaultPredicateRegistry } from "../src/governor/kernel/verification/predicates.ts";
import { createTransformationRegistry, tupleOf } from "../src/governor/kernel/transformations/transformation.ts";
import { createPromotionStore } from "../src/governor/kernel/transformations/promotion.ts";
import { createMandateStore } from "../src/governor/kernel/mandates/lifecycle.ts";
import { openDraft } from "../src/governor/kernel/mandates/draft.ts";
import { activateDraft } from "../src/governor/kernel/mandates/mandate.ts";
import { ZERO_USAGE } from "../src/governor/kernel/mandates/budgets.ts";
import { mandateFitOf, productionStampOf } from "../src/governor/kernel/mandates/policy.ts";
import { requireCohortAdmissible, requireAdmissible, AdmissionRefusedError } from "../src/governor/kernel/admission/policy.ts";
import { subjectDigest } from "../src/governor/kernel/contracts/subject-v1.ts";
import { createClaimStore } from "../src/governor/kernel/admission/settlement.ts";
import { freezeCohort } from "../src/governor/kernel/cohorts/freeze.ts";

const enc = (s) => new TextEncoder().encode(s);
const T0 = 1_700_000_000_000;

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

const TRANSFORMATION = {
  schema: "governor.transformation/v1",
  id: "carrier-normalize",
  version: "1",
  title: "Normalize description carriers",
  appliesTo: ["representation"],
  verifier: { predicates: [{ id: "info-preserved", version: "2" }] },
  recovery: { unit: "item" },
};

function mandateTerms(over = {}) {
  return {
    purpose: "normalize carriers across Notes",
    delegate: { kind: "session", value: "sess-1" },
    scope: { include: ["Notes"], exclude: [] },
    allowedClasses: ["representation"],
    transformation: { id: "carrier-normalize", version: "1" },
    predicates: [{ id: "info-preserved", version: "2" }],
    eligibleActions: [{ id: "note.write", version: "1" }],
    requiredDurability: "replayable",
    budgets: { maxItems: 100, maxBytes: 10_000_000, maxDurationMs: 24 * 60 * 60 * 1000, maxProposals: 100, maxFailures: 3 },
    admission: { mayProduce: true, mayAdmit: true },
    recovery: { unit: "item" },
    ...over,
  };
}

/**
 * The full world: real repo, shared predicate registry with the declared
 * verifier, registered transformation, an active mayAdmit mandate, and the
 * promotion store seeded to PROMOTED for the exact tuple. The eligible
 * baseline — every refusal test mutates one thing.
 */
async function world({ promote = true, terms = {}, promotionStore: storeOverride } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-wp10b-"));
  const repo = await openGitRepository({ gitdir: path.join(root, "gitdir"), worktree: path.join(root, "vault") });
  const vault = new Map();
  const proposals = createProposalStore(memoryIo());
  const claimIo = memoryIo();
  const settlements = [];

  const sharedPredicates = createDefaultPredicateRegistry();
  sharedPredicates.register({
    id: "info-preserved",
    version: "2",
    appliesTo: ["representation"],
    proves: "information is preserved",
    evaluate: async () => ({ passed: true, detail: "fixture" }),
  });
  const registry = createTransformationRegistry(sharedPredicates);
  registry.register(TRANSFORMATION);

  const promotionStore = storeOverride ?? createPromotionStore(memoryIo());
  const mandateStore = createMandateStore(memoryIo());

  // The mandate: drafted, granted (kernel acts — the store trusts them).
  const draft = openDraft({ authoredBy: { sessionId: "sess-1", client: "claude" }, terms: mandateTerms(terms) }, T0, new Uint8Array(10).fill(7));
  await mandateStore.draft(draft, T0);
  const mandate = activateDraft(draft, { principal: "nelson", gestureRef: "gesture-grant" }, T0, new Uint8Array(10).fill(8));
  await mandateStore.activate(mandate, T0);

  if (promote && !storeOverride) {
    const tuple = tupleOf(TRANSFORMATION);
    await promotionStore.recordEvidence(tuple, { kind: "individual-admit", ref: "seed-1" }, T0);
    await promotionStore.recordEvidence(tuple, { kind: "cohort-admit", ref: "seed-2", memberCount: 3 }, T0);
    await promotionStore.recordEvidence(tuple, { kind: "revert", ref: "seed-3" }, T0);
    await promotionStore.promote(tuple, "gesture-promote", "nelson", T0);
  }

  const admission = buildAdmission({
    repo: async () => repo,
    claimIo,
    proposals,
    readNoteBytes: async (p) => (vault.has(p) ? enc(vault.get(p)) : null),
    writeNoteBytes: async (p, bytes) => void vault.set(p, new TextDecoder().decode(bytes)),
    bindingGate: async () => ({ ok: true }),
    appendSettlement: async (r) => void settlements.push(r),
    predicates: sharedPredicates,
    promotion: {
      transformationOf: (id, version) => registry.get(id, version),
      recordEvidence: async () => {},
      verdictOf: (tuple) => promotionStore.verdictOf(tuple),
    },
    mandates: {
      get: (id) => mandateStore.getMandate(id),
      usageOf: (id) => mandateStore.usageOf(id),
      charge: (id, delta, at) => mandateStore.charge(id, delta, at),
      markExhausted: (id, breach, at) => mandateStore.markExhausted(id, breach, at),
    },
    now: () => T0 + 1000,
  });

  let seq = 0;
  async function produce(notePath, baseText, proposedText, { mandateId = mandate.id, classes, transformation } = {}) {
    seq++;
    vault.set(notePath, proposedText);
    const subject = buildProposalSubjectFromOperation({
      vaultId: "vault-1",
      noteId: `uid-${seq}`,
      path: notePath,
      pathSemanticallyRelevant: false,
      base: baseText === null ? null : digestBytes(enc(baseText)),
      proposed: digestBytes(enc(proposedText)),
      changeClasses: classes ?? ["representation"],
      transformation: transformation ?? { id: "carrier-normalize", version: "1" },
      predicates: [
        { id: "content-diff", version: "1" },
        { id: "info-preserved", version: "2" },
      ],
      producingOperation: { id: `op-${seq}`, action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "sess-1",
      mandateId,
    });
    const proposal = openProposal({ subject, sessionId: "sess-1" }, T0 + seq, new Uint8Array(10).fill(seq));
    const ref = proposalRef(proposal.id);
    const base = await repo.recordSnapshot({
      ref,
      files: [{ path: notePath, bytes: baseText === null ? null : enc(baseText) }],
      message: "base",
      timestamp: 1,
      expectedRef: null,
    });
    await repo.recordSnapshot({ ref, files: [{ path: notePath, bytes: enc(proposedText) }], message: "proposed", timestamp: 2, expectedRef: base.oid });
    const full = { ...proposal, recordingRef: ref };
    await proposals.open(full, T0);
    return full;
  }

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { repo, vault, proposals, claimIo, settlements, admission, produce, mandate, mandateStore, promotionStore, registry, sharedPredicates, cleanup };
}

// ── The eligible baseline ADMITS — and is distinguishable everywhere ─────────

describe("the mandate door — the eligible cohort admits automatically, distinguishably", () => {
  test("full pipeline: stamped members, frozen cohort, admitCohortUnderMandate → claim/settlement/outcome all say MANDATE; budgets charged", async () => {
    const w = await world();
    try {
      const p1 = await w.produce("Notes/a.md", "old a\n", "new a\n");
      const p2 = await w.produce("Notes/b.md", "old b\n", "new b\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      assert.ok(sel.ok, sel.reason);

      const outcome = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.ok(outcome.ok, JSON.stringify(outcome));
      assert.equal(outcome.authority, `mandate:${w.mandate.id}`, "condition 10: the outcome says which door opened");

      // The claim carries the widened union's mandate arm, complete.
      const claims = await createClaimStore(w.claimIo).all();
      assert.equal(claims.length, 1);
      assert.equal(claims[0].authority.kind, "mandate");
      assert.equal(claims[0].authority.mandateId, w.mandate.id);
      assert.match(claims[0].authority.useRef, /^mandate-use-/, "the use ref is service-minted");
      assert.equal(claims[0].authority.promotedTuple, "carrier-normalize@1", "the claim names the exact promoted tuple");

      // The settlement record distinguishes it too.
      assert.equal(w.settlements.length, 1);
      assert.equal(w.settlements[0].authority, `mandate:${w.mandate.id}`);

      // Budgets charged: the two admitted items spent the mandate.
      const usage = await w.mandateStore.usageOf(w.mandate.id);
      assert.equal(usage.items, 2, "an automatic admission spends the budget it ran under");

      // The members resolve admitted off the chain.
      assert.equal((await w.proposals.get(p1.id)).authority, "admitted");
      assert.equal((await w.proposals.get(p2.id)).authority, "admitted");
    } finally {
      w.cleanup();
    }
  });

  test("CONDITION 1, SHARPENED: the same mandate-ELIGIBLE cohort refuses on the human path without a gesture — and admits WITH one", async () => {
    const w = await world();
    try {
      await w.produce("Notes/a.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      assert.ok(sel.ok);
      const ungated = await w.admission.admitCohortWithGesture(sel.frozen, sel.members, "");
      assert.equal(ungated.ok, false);
      assert.equal(ungated.code, "authority_missing", "eligibility for the automatic door buys NOTHING on the human path");
      const gated = await w.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-1");
      assert.ok(gated.ok, JSON.stringify(gated));
      assert.equal(gated.authority, "human-gesture");
    } finally {
      w.cleanup();
    }
  });

  test("a mandate-produced subject admitted INDIVIDUALLY by human gesture is the cohort-decision happy path (WP6's refusal retired)", async () => {
    const w = await world();
    try {
      const p = await w.produce("Notes/solo.md", "old\n", "new\n");
      const outcome = await w.admission.admitWithGesture(p.id, "gesture-solo");
      assert.ok(outcome.ok, JSON.stringify(outcome));
    } finally {
      w.cleanup();
    }
  });

  test("the individual path REFUSES mandate authority: automatic admission decides cohorts only", () => {
    const w = { subject: null };
    void w;
    // Policy-level: requireAdmissible with a mandate authority refuses before
    // anything else about the mandate is even consulted.
    assert.throws(
      () => {
        // A minimal self-consistent subject/proposal pair.
        const subject = buildProposalSubjectFromOperation({
          vaultId: "v",
          noteId: "n",
          path: "Notes/x.md",
          pathSemanticallyRelevant: false,
          base: null,
          proposed: { algorithm: "sha256", value: "0".repeat(64) },
          changeClasses: ["representation"],
          transformation: { id: "t", version: "1" },
          predicates: [{ id: "content-diff", version: "1" }],
          producingOperation: { id: "op", action: "a", actionVersion: 1 },
          observations: [],
          sessionId: "s",
          mandateId: "m-1",
        });
        const proposal = {
          subjectDigest: subjectDigest(subject),
          authority: "proposed",
          producedOutcome: "completed",
          development: "none",
        };
        const records = subject.predicates.map((p) => ({
          predicate: { id: p.id, version: p.version },
          subjectDigest: subjectDigest(subject),
          passed: true,
          detail: "fixture",
          evaluatedAt: T0,
        }));
        requireAdmissible({ proposal, subject, authority: { kind: "mandate", mandateId: "m-1" } }, records, T0);
      },
      (e) => e instanceof AdmissionRefusedError && e.code === "mandate_requires_cohort"
    );
  });
});

// ── Condition 7: the two absence shapes, separately ──────────────────────────

describe("condition 7 — a broken evidence store and an empty one are different refusals", () => {
  test("EMPTY promotion store: promotion_missing, with the missing evidence NAMED", async () => {
    const w = await world({ promote: false });
    try {
      await w.produce("Notes/a.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const outcome = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, "promotion_missing");
      assert.match(outcome.detail, /missing live evidence/, "the gap is spoken, not implied");
    } finally {
      w.cleanup();
    }
  });

  test("THROWING promotion store: promotion_unavailable — broken reads as broken, never as unpromoted (and NEVER as promoted)", async () => {
    const throwing = {
      recordEvidence: async () => {},
      promote: async () => {},
      demote: async () => {},
      verdictOf: async () => {
        throw new Error("evidence store unreadable");
      },
      all: async () => [],
    };
    const w = await world({ promotionStore: throwing });
    try {
      await w.produce("Notes/a.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const outcome = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, "promotion_unavailable");
      assert.match(outcome.detail, /evidence store unreadable|authorizes nothing/);
    } finally {
      w.cleanup();
    }
  });

  test("a THROWING mandate store refuses mandate_unavailable — resolution failure is its own code", async () => {
    const w = await world();
    try {
      await w.produce("Notes/a.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      // Rebuild admission with a mandates port whose get throws.
      const broken = buildAdmission({
        repo: async () => w.repo,
        claimIo: memoryIo(),
        proposals: w.proposals,
        readNoteBytes: async (p) => (w.vault.has(p) ? enc(w.vault.get(p)) : null),
        writeNoteBytes: async () => {},
        bindingGate: async () => ({ ok: true }),
        appendSettlement: async () => {},
        predicates: w.sharedPredicates,
        promotion: {
          transformationOf: (id, version) => w.registry.get(id, version),
          recordEvidence: async () => {},
          verdictOf: (t) => w.promotionStore.verdictOf(t),
        },
        mandates: {
          get: async () => {
            throw new Error("mandate store io failure");
          },
          usageOf: async () => ZERO_USAGE,
          charge: async () => {},
          markExhausted: async () => {},
        },
        now: () => T0 + 1000,
      });
      const outcome = await broken.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, "mandate_unavailable");
    } finally {
      w.cleanup();
    }
  });

  test("NO mandate machinery wired at all: the mandate door refuses mandate_unavailable (fail closed, not fall through)", async () => {
    const w = await world();
    try {
      await w.produce("Notes/a.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const bare = buildAdmission({
        repo: async () => w.repo,
        claimIo: memoryIo(),
        proposals: w.proposals,
        readNoteBytes: async (p) => (w.vault.has(p) ? enc(w.vault.get(p)) : null),
        writeNoteBytes: async () => {},
        bindingGate: async () => ({ ok: true }),
        appendSettlement: async () => {},
        now: () => T0 + 1000,
      });
      const outcome = await bare.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, "mandate_unavailable");
    } finally {
      w.cleanup();
    }
  });
});

// ── The refusal table — one-field mutations of the eligible baseline ─────────

describe("the mandate refusal table (policy level) — each axis its own code", () => {
  function item(over = {}) {
    return buildProposalSubjectFromOperation({
      vaultId: "v",
      noteId: over.noteId ?? "n-1",
      path: over.path ?? "Notes/a.md",
      pathSemanticallyRelevant: false,
      base: null,
      proposed: { algorithm: "sha256", value: "0".repeat(64) },
      changeClasses: over.changeClasses ?? ["representation"],
      transformation: over.transformation ?? { id: "carrier-normalize", version: "1" },
      predicates: over.predicates ?? [
        { id: "content-diff", version: "1" },
        { id: "info-preserved", version: "2" },
      ],
      producingOperation: { id: "op-1", action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "sess-1",
      mandateId: over.mandateId !== undefined ? over.mandateId : MANDATE.id,
    });
  }

  const MANDATE = activateDraft(
    openDraft({ authoredBy: { sessionId: "sess-1", client: "c" }, terms: mandateTerms() }, T0, new Uint8Array(10).fill(9)),
    { principal: "nelson", gestureRef: "g" },
    T0,
    new Uint8Array(10).fill(10)
  );

  function ctx(over = {}) {
    return {
      mandate: MANDATE,
      usage: ZERO_USAGE,
      transformation: TRANSFORMATION,
      promotion: { state: "promoted", promotedAt: T0, promotedBy: "nelson" },
      ...over,
    };
  }

  function frozenFor(items) {
    const proposals = items.map((s, i) => openProposal({ subject: s, sessionId: "sess-1" }, T0 + i, new Uint8Array(10).fill(i + 1)));
    const frozen = freezeCohort({ items: proposals, resolvedScope: { include: ["Notes"], exclude: [] }, recoveryUnit: "item" });
    return { frozen, proposals };
  }

  function judge(items, mandateCtx, { authority } = {}) {
    const { frozen, proposals } = frozenFor(items);
    const coverage = {
      cohortDigest: subjectDigest(frozen.subject).value,
      passed: true,
      items: frozen.subject.items.map((i) => ({ noteId: i.noteId, passed: true, records: [] })),
      failedNoteIds: [],
    };
    requireCohortAdmissible(
      {
        frozenSubject: frozen.subject,
        gestureCoveredDigest: frozen.digest.value,
        memberProposals: proposals,
        authority: authority ?? { kind: "mandate", mandateId: MANDATE.id },
      },
      coverage,
      T0 + 1000,
      mandateCtx
    );
  }

  test("the baseline passes — every leg below mutates exactly one thing", () => {
    judge([item()], ctx());
  });

  const CASES = [
    ["mandate_unavailable: no context", [{}], undefined, "mandate_unavailable"],
    ["mandate_unknown: store answered null", [{}], { mandate: null }, "mandate_unknown"],

    ["mandate_subject_mismatch: a member produced elsewhere", [{ mandateId: "some-other-mandate" }], {}, "mandate_subject_mismatch"],
    ["class_not_automatable: a content member (even though a mandate MAY produce content)", [{ changeClasses: ["content"] }], {}, "class_not_automatable"],
    ["scope_escape: a member outside the scope", [{ path: "Elsewhere/x.md" }], {}, "scope_escape"],
    ["transformation_mismatch: a member of a different transformation version", [{ transformation: { id: "carrier-normalize", version: "9" } }], {}, "transformation_mismatch"],
    ["transformation_unregistered: the registry does not hold it", [{}], { transformation: null }, "transformation_unregistered"],
    ["verifier_not_covered: a member missing the declared verifier", [{ predicates: [{ id: "content-diff", version: "1" }] }], {}, "verifier_not_covered"],
    ["promotion_unavailable: the evidence could not be read", [{}], { promotion: { state: "unavailable", detail: "io" } }, "promotion_unavailable"],
    ["promotion_missing: unpromoted tuple", [{}], { promotion: { state: "unpromoted", counts: { individualAdmits: 0, cohortAdmits: 0, reverts: 0 }, missing: ["individual-admit (pilot): never"] } }, "promotion_missing"],
    ["budget_exhausted: usage at the item cap", [{}], { usage: { ...ZERO_USAGE, items: 100 } }, "budget_exhausted"],
  ];
  for (const [name, itemOvers, ctxOver, code] of CASES) {
    test(name, () => {
      assert.throws(
        () => judge(itemOvers.map((o) => item(o)), ctxOver === undefined ? undefined : ctx(ctxOver)),
        (e) => e instanceof AdmissionRefusedError && e.code === code,
        `expected ${code}`
      );
    });
  }

  test("mandate_expired: active status but past expiry — the WP6 seam, consumed", () => {
    assert.throws(
      () => {
        const { frozen, proposals } = frozenFor([item()]);
        const coverage = { cohortDigest: subjectDigest(frozen.subject).value, passed: true, items: [], failedNoteIds: [] };
        requireCohortAdmissible(
          { frozenSubject: frozen.subject, gestureCoveredDigest: frozen.digest.value, memberProposals: proposals, authority: { kind: "mandate", mandateId: MANDATE.id } },
          coverage,
          MANDATE.expiresAt + 1,
          ctx()
        );
      },
      (e) => e.code === "mandate_expired"
    );
  });

  test("class_escalation: a class inside AUTOMATABLE but outside the mandate's grant", () => {
    // The mandate grants representation only; presentation is automatable in
    // general but NOT granted here — escalation refuses at the door.
    assert.throws(
      () => judge([item({ changeClasses: ["presentation"] })], ctx()),
      (e) => e.code === "class_escalation"
    );
  });

  test("admission_not_authorized: a mayProduce-only mandate's results return for the human decision", () => {
    const produceOnly = activateDraft(
      openDraft(
        { authoredBy: { sessionId: "s", client: "c" }, terms: mandateTerms({ admission: { mayProduce: true, mayAdmit: false } }) },
        T0,
        new Uint8Array(10).fill(11)
      ),
      { principal: "nelson", gestureRef: "g" },
      T0,
      new Uint8Array(10).fill(12)
    );
    assert.throws(
      () => judge([item({ mandateId: produceOnly.id })], ctx({ mandate: produceOnly }), { authority: { kind: "mandate", mandateId: produceOnly.id } }),
      (e) => e instanceof AdmissionRefusedError && e.code === "admission_not_authorized"
    );
  });

  test("recovery_mismatch: the frozen unit differs from the tuple's declared unit", () => {
    const subjects = [item()];
    const proposals = subjects.map((s, i) => openProposal({ subject: s, sessionId: "sess-1" }, T0 + i, new Uint8Array(10).fill(i + 1)));
    const frozen = freezeCohort({ items: proposals, resolvedScope: { include: ["Notes"], exclude: [] }, recoveryUnit: "cohort" });
    const coverage = { cohortDigest: subjectDigest(frozen.subject).value, passed: true, items: [], failedNoteIds: [] };
    assert.throws(
      () =>
        requireCohortAdmissible(
          { frozenSubject: frozen.subject, gestureCoveredDigest: frozen.digest.value, memberProposals: proposals, authority: { kind: "mandate", mandateId: MANDATE.id } },
          coverage,
          T0 + 1000,
          ctx()
        ),
      (e) => e.code === "recovery_mismatch"
    );
  });
});

// ── Replay, exhaustion-by-charging, and the producer's stamp ─────────────────

describe("replay, budgets, and the producer", () => {
  test("the same cohort cannot auto-admit twice; a gesture claim's replay check ignores mandate claims", async () => {
    const w = await world();
    try {
      await w.produce("Notes/a.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const first = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.ok(first.ok);
      const second = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.equal(second.ok, false);
      assert.equal(second.code, "already_admitted", "one decision, one standing advance — the chain itself is the one-shot");
    } finally {
      w.cleanup();
    }
  });

  test("charging past the item budget marks the mandate exhausted — and the NEXT automatic admission refuses", async () => {
    const w = await world({ terms: { budgets: { maxItems: 2, maxBytes: 10_000_000, maxDurationMs: 24 * 60 * 60 * 1000, maxProposals: 100, maxFailures: 3 } } });
    try {
      await w.produce("Notes/a.md", "old a\n", "new a\n");
      await w.produce("Notes/b.md", "old b\n", "new b\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const first = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.ok(first.ok, JSON.stringify(first));
      // The charge (2 items = the cap) breached → observed → exhausted, durably.
      assert.equal((await w.mandateStore.getMandate(w.mandate.id)).status, "exhausted", "a spent budget STOPS, recorded as the normal stop");
      // And the next automatic admission refuses on the mandate's own status.
      await w.produce("Notes/c.md", "old c\n", "new c\n");
      const sel2 = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const second = await w.admission.admitCohortUnderMandate(sel2.frozen, sel2.members, w.mandate.id);
      assert.equal(second.ok, false);
      assert.equal(second.code, "mandate_exhausted");
    } finally {
      w.cleanup();
    }
  });

  test("productionStampOf: fit stamps and charges; unfit surfaces the refusal and stamps nothing; no mandate, no anything", () => {
    const m = activateDraft(
      openDraft({ authoredBy: { sessionId: "sess-1", client: "c" }, terms: mandateTerms() }, T0, new Uint8Array(10).fill(13)),
      { principal: "nelson", gestureRef: "g" },
      T0,
      new Uint8Array(10).fill(14)
    );
    const fitCtx = {
      delegate: { sessionId: "sess-1", connection: null, role: null },
      notePath: "Notes/a.md",
      changeClasses: ["representation"],
      transformation: { id: "carrier-normalize", version: "1" },
      predicates: [{ id: "info-preserved", version: "2" }],
      action: { id: "note.write", version: "1" },
      durability: "replayable",
    };
    const stamped = productionStampOf(m, ZERO_USAGE, fitCtx, 512, T0 + 1);
    assert.equal(stamped.mandateId, m.id);
    assert.deepEqual(stamped.charge, { items: 1, proposals: 1, bytes: 512 });

    const unfit = productionStampOf(m, ZERO_USAGE, { ...fitCtx, notePath: "Elsewhere/x.md" }, 512, T0 + 1);
    assert.equal(unfit.mandateId, null);
    assert.equal(unfit.charge, null);
    assert.equal(unfit.refusal.code, "scope_escape", "the refusal is surfaced for observability, never a gate on production");

    const none = productionStampOf(null, ZERO_USAGE, fitCtx, 512, T0 + 1);
    assert.deepEqual(none, { mandateId: null, charge: null, refusal: null });

    // Sanity: the fit function productionStampOf rides is the WP9 one.
    assert.deepEqual(mandateFitOf(m, ZERO_USAGE, fitCtx, T0 + 1), { ok: true });
  });

  test("evidence is NOT recorded for a mandated admission — the gate's evidence classes are human acts", async () => {
    const recorded = [];
    const w = await world();
    try {
      // Rewire recordEvidence to spy (the world's default is a no-op; build a
      // fresh admission with a spying recorder over the same stores).
      const spying = buildAdmission({
        repo: async () => w.repo,
        claimIo: memoryIo(),
        proposals: w.proposals,
        readNoteBytes: async (p) => (w.vault.has(p) ? enc(w.vault.get(p)) : null),
        writeNoteBytes: async () => {},
        bindingGate: async () => ({ ok: true }),
        appendSettlement: async () => {},
        predicates: w.sharedPredicates,
        promotion: {
          transformationOf: (id, version) => w.registry.get(id, version),
          recordEvidence: async (tuple, evidence) => void recorded.push(evidence),
          verdictOf: (t) => w.promotionStore.verdictOf(t),
        },
        mandates: {
          get: (id) => w.mandateStore.getMandate(id),
          usageOf: (id) => w.mandateStore.usageOf(id),
          charge: (id, d, at) => w.mandateStore.charge(id, d, at),
          markExhausted: (id, b, at) => w.mandateStore.markExhausted(id, b, at),
        },
        now: () => T0 + 1000,
      });
      await w.produce("Notes/a.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const outcome = await spying.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.ok(outcome.ok, JSON.stringify(outcome));
      assert.equal(recorded.length, 0, "an automatic admission proves nothing about human-evidenced tuples");
    } finally {
      w.cleanup();
    }
  });
});

// ── Review-of-#358 fixes, pinned ─────────────────────────────────────────────

describe("review-of-#358 fixes", () => {
  test("B1: INTERLEAVED REPLAY refuses — lagged projections + a moved head no longer admit the same cohort twice", async () => {
    const w = await world();
    try {
      // Build admission whose markAdmitted ALWAYS fails: the projection lags
      // by design (rebuildable), which is the realistic WP10c-sweep-retry
      // trigger the review named.
      const laggy = buildAdmission({
        repo: async () => w.repo,
        claimIo: w.claimIo,
        proposals: {
          ...w.proposals,
          pending: () => w.proposals.pending(),
          get: (id) => w.proposals.get(id),
          setVerification: (id, v, at) => w.proposals.setVerification(id, v, at),
          markAdmitted: async () => {
            throw new Error("projection store down");
          },
          supersede: (id, at) => w.proposals.supersede(id, at),
          open: (p, at) => w.proposals.open(p, at),
        },
        readNoteBytes: async (p) => (w.vault.has(p) ? enc(w.vault.get(p)) : null),
        writeNoteBytes: async () => {},
        bindingGate: async () => ({ ok: true }),
        appendSettlement: async () => {},
        predicates: w.sharedPredicates,
        promotion: {
          transformationOf: (id, version) => w.registry.get(id, version),
          recordEvidence: async () => {},
          verdictOf: (t) => w.promotionStore.verdictOf(t),
        },
        mandates: {
          get: (id) => w.mandateStore.getMandate(id),
          usageOf: (id) => w.mandateStore.usageOf(id),
          charge: (id, d, at) => w.mandateStore.charge(id, d, at),
          markExhausted: (id, b, at) => w.mandateStore.markExhausted(id, b, at),
        },
        now: () => T0 + 1000,
      });

      // Cohort X admits (projection catch-up fails silently — by design).
      await w.produce("Notes/x1.md", "old x\n", "new x\n");
      const selX = await laggy.freezeSelection({ folder: "Notes" }, "item");
      assert.ok(selX.ok);
      const first = await laggy.admitCohortUnderMandate(selX.frozen, selX.members, w.mandate.id);
      assert.ok(first.ok, JSON.stringify(first));

      // Unrelated cohort Y admits — the head MOVES past X.
      await w.produce("Other/y1.md", "old y\n", "new y\n", {});
      // (Other/ is outside the mandate's scope; admit Y under human gesture.)
      const selY = await laggy.freezeSelection({ folder: "Other" }, "item");
      assert.ok(selY.ok);
      const second = await laggy.admitCohortWithGesture(selY.frozen, selY.members, "gesture-y");
      assert.ok(second.ok, JSON.stringify(second));

      // X re-submitted: members still read "proposed" (projection lagged),
      // bytes unchanged, head ≠ X — the review's exploit. It must refuse.
      const replay = await laggy.admitCohortUnderMandate(selX.frozen, selX.members, w.mandate.id);
      assert.equal(replay.ok, false);
      assert.equal(replay.code, "already_admitted", "the claim store is the one-shot, not the head");
      // And exactly ONE claim covers X's digest — no duplicate landed.
      const claims = await createClaimStore(w.claimIo).all();
      assert.equal(claims.filter((c) => c.subjectDigest.value === selX.frozen.digest.value).length, 1);
      // Usage charged once, not twice.
      assert.equal((await w.mandateStore.usageOf(w.mandate.id)).items, 1);
    } finally {
      w.cleanup();
    }
  });

  test("S1: a hand-built MIXED-CLASS frozen cohort refuses at the mandate door — the door does not trust the freeze", async () => {
    const w = await world({ terms: { allowedClasses: ["representation", "presentation"] } });
    try {
      // Two members, both automatable, both granted — but MIXED combinations.
      const pA = await w.produce("Notes/m1.md", "old 1\n", "new 1\n");
      const pB = await w.produce("Notes/m2.md", "old 2\n", "new 2\n", { classes: ["presentation"] });
      // Bypass freezeCohort's group check by hand-building the frozen shape
      // the way a hostile in-process caller would.
      const { buildCohortSubject } = await import("../src/governor/kernel/contracts/subject-v1.ts");
      const cohortSubject = buildCohortSubject({ items: [pA.subject, pB.subject], resolvedScope: { include: ["Notes"], exclude: [] }, recoveryUnit: "item", excludedProposalIds: [] });
      const frozen = { subject: cohortSubject, digest: subjectDigest(cohortSubject), memberProposalIds: [pA.id, pB.id] };
      const outcome = await w.admission.admitCohortUnderMandate(frozen, [pA, pB], w.mandate.id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, "cohort_ineligible", "mixed-class results split BEFORE admission — enforced at admission");
      assert.match(outcome.detail, /mixed class combinations/);
    } finally {
      w.cleanup();
    }
  });

  test("S2: a garbage promotion verdict refuses promotion_unavailable — typed, never a laundered TypeError", async () => {
    for (const garbage of [null, {}, { state: "???" }, { state: 42 }]) {
      const store = {
        recordEvidence: async () => {},
        promote: async () => {},
        demote: async () => {},
        verdictOf: async () => garbage,
        all: async () => [],
      };
      const w = await world({ promotionStore: store });
      try {
        await w.produce("Notes/g.md", "old\n", "new\n");
        const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
        const outcome = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
        assert.equal(outcome.ok, false);
        assert.equal(outcome.code, "promotion_unavailable", `garbage ${JSON.stringify(garbage)} must refuse typed`);
      } finally {
        w.cleanup();
      }
    }
  });

  test("S2 sibling: an unpromoted verdict with a MISSING `missing` array still refuses promotion_missing without throwing", async () => {
    const store = {
      recordEvidence: async () => {},
      promote: async () => {},
      demote: async () => {},
      verdictOf: async () => ({ state: "unpromoted", counts: { individualAdmits: 0, cohortAdmits: 0, reverts: 0 } }),
      all: async () => [],
    };
    const w = await world({ promotionStore: store });
    try {
      await w.produce("Notes/s.md", "old\n", "new\n");
      const sel = await w.admission.freezeSelection({ folder: "Notes" }, "item");
      const outcome = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, w.mandate.id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, "promotion_missing", "a recognized state with a malformed detail field keeps its own code");
    } finally {
      w.cleanup();
    }
  });
});

// ── WP10c: the mandated sweep — the door's production caller ─────────────────

describe("sweepMandated — automatic admission arrives as a sweep, fully gated", () => {
  test("the eligible world: stamped proposals sweep straight through the door; the pane's queue empties", async () => {
    const w = await world();
    try {
      await w.produce("Notes/s1.md", "old 1\n", "new 1\n");
      await w.produce("Notes/s2.md", "old 2\n", "new 2\n");
      const admitted = await w.admission.sweepMandated();
      assert.equal(admitted, 1, "one cohort admitted (both members in one decision)");
      const claims = await createClaimStore(w.claimIo).all();
      assert.equal(claims.length, 1);
      assert.equal(claims[0].authority.kind, "mandate");
      assert.equal((await w.admission.pending()).length, 0, "the swept members left the decision space");
      assert.equal((await w.mandateStore.usageOf(w.mandate.id)).items, 2);
    } finally {
      w.cleanup();
    }
  });

  test("an unpromoted tuple refuses at the door; the proposals STAY PENDING — the cohort-decision route", async () => {
    const w = await world({ promote: false });
    try {
      await w.produce("Notes/u1.md", "old\n", "new\n");
      const admitted = await w.admission.sweepMandated();
      assert.equal(admitted, 0);
      assert.equal((await w.admission.pending()).length, 1, "refused work waits for the human, never vanishes");
      assert.equal((await createClaimStore(w.claimIo).all()).length, 0);
    } finally {
      w.cleanup();
    }
  });

  test("ATTEMPT-DEDUPE: an unchanged member set is tried once, not once per poll; a member change re-arms", async () => {
    const w = await world({ promote: false });
    try {
      await w.produce("Notes/d1.md", "old\n", "new\n");
      // Count door attempts through the promotion verdict reads (one per attempt).
      let verdictReads = 0;
      const origVerdictOf = w.promotionStore.verdictOf.bind(w.promotionStore);
      w.promotionStore.verdictOf = (t) => { verdictReads++; return origVerdictOf(t); };
      await w.admission.sweepMandated();
      const after1 = verdictReads;
      assert.ok(after1 >= 1, "the first sweep reached the door");
      await w.admission.sweepMandated();
      await w.admission.sweepMandated();
      assert.equal(verdictReads, after1, "identical member sets do not re-run the door");
      await w.produce("Notes/d2.md", "old 2\n", "new 2\n");
      await w.admission.sweepMandated();
      assert.ok(verdictReads > after1, "a changed member set re-arms the attempt");
    } finally {
      w.cleanup();
    }
  });

  test("a mayProduce-only mandate's work is never even attempted — the pre-check skips it; unstamped work is invisible to the sweep", async () => {
    const w = await world({ terms: { admission: { mayProduce: true, mayAdmit: false } } });
    try {
      await w.produce("Notes/p1.md", "old\n", "new\n");
      await w.produce("Notes/p2.md", "old\n", "new\n", { mandateId: null }); // unstamped
      let verdictReads = 0;
      const origVerdictOf = w.promotionStore.verdictOf.bind(w.promotionStore);
      w.promotionStore.verdictOf = (t) => { verdictReads++; return origVerdictOf(t); };
      const admitted = await w.admission.sweepMandated();
      assert.equal(admitted, 0);
      assert.equal(verdictReads, 0, "no door attempt for a produce-only mandate");
      assert.equal((await w.admission.pending()).length, 2, "everything waits for the human");
    } finally {
      w.cleanup();
    }
  });

  test("no mandate machinery wired: the sweep is a quiet zero, never a crash", async () => {
    const w = await world();
    try {
      const bare = buildAdmission({
        repo: async () => w.repo,
        claimIo: memoryIo(),
        proposals: w.proposals,
        readNoteBytes: async () => null,
        writeNoteBytes: async () => {},
        bindingGate: async () => ({ ok: true }),
        appendSettlement: async () => {},
        now: () => T0 + 1000,
      });
      assert.equal(await bare.sweepMandated(), 0);
    } finally {
      w.cleanup();
    }
  });
});

// ── WP10c source pins: the poll's era swap and the reconcile gate ────────────

describe("the era swap, pinned at the source (wiring.ts is plugin-bound; the scan proves the paths RUN the guards)", () => {
  const wiringSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../src/governor/wiring/wiring.ts"), "utf8");

  test("pollJournal runs the LEGACY sweep only pre-retirement, and the MANDATED sweep only post", () => {
    assert.match(wiringSrc, /if \(!legacyRetired\(plugin\)\) \{\s*\n\s*const accepted = await sweepAutoAccept\(plugin\);/, "the legacy sweep is behind !legacyRetired");
    assert.match(wiringSrc, /\} else \{\s*\n\s*const admission = admissionDeps\.get\(plugin\);\s*\n\s*if \(admission\) \{\s*\n\s*const admitted = await admission\.sweepMandated\(\);/, "the mandated sweep is the else arm");
  });

  test("reconcile's silent advance is gated: post-cutover a human edit no-ops quietly instead of throwing per edit", () => {
    // The refresh here became COALESCED (the rename-storm fix): a per-file
    // handler must never await the whole-vault pass. What this pin cares about
    // is unchanged — the retirement guard sits inside the silent-advance
    // branch, before setBaseline — so it matches the guard, not the refresh
    // call's shape.
    assert.match(wiringSrc, /if \(shouldAdvanceBaselineSilently\(cls\)\) \{[\s\S]{0,700}?if \(legacyRetired\(plugin\)\) \{ requestRefresh\(plugin\); return; \}/, "the guard sits inside the silent-advance branch, before setBaseline");
  });

  test("maybeAutoAccept consults NO per-note policy anymore — the read is gone from the wiring", () => {
    assert.ok(!/autoAcceptPolicyOf\(baseline\.content\)/.test(wiringSrc), "the eligibility path reads no policy");
    assert.ok(!/logRefusalOnce/.test(wiringSrc), "the policy refusal logger died with the policy");
    // The one surviving read is the display badge (honoredAutoAccept).
    const reads = wiringSrc.match(/autoAcceptPolicyOf\(/g) ?? [];
    assert.equal(reads.length, 1, "exactly one read: the badge thunk");
  });
});

// ── Review-of-#359 fix: the mandateId selector row, RUN ──────────────────────

describe("per-mandate grouping (review of #359: the selector row needed a path that runs it)", () => {
  test("selectProposals filters by mandateId directly", async () => {
    const { selectProposals } = await import("../src/governor/kernel/cohorts/cohort.ts");
    const w = await world();
    try {
      const pA = await w.produce("Notes/ga.md", "old a\n", "new a\n");
      const pB = await w.produce("Notes/gb.md", "old b\n", "new b\n", { mandateId: "other-mandate" });
      const all = [pA, pB];
      assert.deepEqual(selectProposals(all, { mandateId: w.mandate.id }).map((p) => p.id), [pA.id]);
      assert.deepEqual(selectProposals(all, { mandateId: "other-mandate" }).map((p) => p.id), [pB.id]);
      assert.equal(selectProposals(all, {}).length, 2, "no selector, no filter");
    } finally {
      w.cleanup();
    }
  });

  test("TWO mandates sweep as two separate cohorts — claims never cross membership", async () => {
    const w = await world();
    try {
      // A second active mayAdmit mandate over the same promoted tuple.
      const d2 = openDraft(
        { authoredBy: { sessionId: "sess-2", client: "claude" }, terms: mandateTerms({ delegate: { kind: "session", value: "sess-2" } }) },
        T0 + 5,
        new Uint8Array(10).fill(21)
      );
      await w.mandateStore.draft(d2, T0 + 5);
      const m2 = activateDraft(d2, { principal: "nelson", gestureRef: "gesture-grant-2" }, T0 + 5, new Uint8Array(10).fill(22));
      await w.mandateStore.activate(m2, T0 + 5);

      const pA1 = await w.produce("Notes/a1.md", "old a1\n", "new a1\n");
      const pA2 = await w.produce("Notes/a2.md", "old a2\n", "new a2\n");
      const pB1 = await w.produce("Notes/b1.md", "old b1\n", "new b1\n", { mandateId: m2.id });

      const admitted = await w.admission.sweepMandated();
      assert.equal(admitted, 2, "one cohort per mandate — without the selector row this is 0 (mixed-mandate freezes refuse)");

      const claims = await createClaimStore(w.claimIo).all();
      assert.equal(claims.length, 2);
      const byMandate = new Map(claims.map((c) => [c.authority.mandateId, c.coveredNotes.map((n) => n.noteId).sort()]));
      assert.deepEqual(byMandate.get(w.mandate.id), [pA1.subject.noteId, pA2.subject.noteId].sort(), "mandate A's claim covers exactly A's members");
      assert.deepEqual(byMandate.get(m2.id), [pB1.subject.noteId], "mandate B's claim covers exactly B's member");
      // And each mandate spent only ITS OWN budget.
      assert.equal((await w.mandateStore.usageOf(w.mandate.id)).items, 2);
      assert.equal((await w.mandateStore.usageOf(m2.id)).items, 1);
    } finally {
      w.cleanup();
    }
  });
});

// ── governor-lead's #359 post-merge ask: the leak pinned BY OUTCOME at the
// wiring level — a cohort presented to the WRONG mandate's door refuses by
// code, whatever upstream machinery mis-grouped it ─────────────────────────

describe("cross-mandate leak, pinned by outcome", () => {
  test("mandate B's door refuses mandate A's frozen cohort with mandate_subject_mismatch — nothing admits, nothing charges", async () => {
    const w = await world();
    try {
      const d2 = openDraft(
        { authoredBy: { sessionId: "sess-2", client: "claude" }, terms: mandateTerms({ delegate: { kind: "session", value: "sess-2" } }) },
        T0 + 5,
        new Uint8Array(10).fill(23)
      );
      await w.mandateStore.draft(d2, T0 + 5);
      const m2 = activateDraft(d2, { principal: "nelson", gestureRef: "gesture-grant-3" }, T0 + 5, new Uint8Array(10).fill(24));
      await w.mandateStore.activate(m2, T0 + 5);

      await w.produce("Notes/leak.md", "old\n", "new\n"); // stamped under mandate 1
      const sel = await w.admission.freezeSelection({ mandateId: w.mandate.id }, "item");
      assert.ok(sel.ok);
      // The hostile hand-off: mandate 1's cohort pushed through mandate 2's door.
      const outcome = await w.admission.admitCohortUnderMandate(sel.frozen, sel.members, m2.id);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, "mandate_subject_mismatch", "a mandate admits only its own work — by code, at the door, whatever mis-grouped upstream");
      assert.equal((await createClaimStore(w.claimIo).all()).length, 0);
      assert.equal((await w.mandateStore.usageOf(m2.id)).items, 0, "the wrong mandate's budget is untouched");
      assert.equal((await w.admission.pending()).length, 1, "the work stays for its own mandate's sweep or the human");
    } finally {
      w.cleanup();
    }
  });
});
