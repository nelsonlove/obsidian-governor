/**
 * governance-transformations.test.mjs — WP10a: the named transformation
 * registry and the promotion evidence gate.
 *
 * The two lines this file holds: (1) content and authority work can NEVER
 * enter the registry automatic admission is defined over — D02's line,
 * enforced structurally at registration; (2) promotion is offered only over
 * the exact (transformation, verifier, recovery) tuple's recorded live
 * evidence, refuses NAMING what is missing, and is a human gesture on top
 * of the facts — absence never renders as emptiness.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AUTOMATABLE_CLASSES,
  createTransformationRegistry,
  TransformationRegistryError,
} from "../src/kernel/governance/transformations/transformation.ts";
import {
  createPromotionStore,
  foldPromotionEvents,
  missingEvidenceOf,
  PromotionRefusedError,
  promotionVerdictOf,
  tupleKeyOf,
  verifierKeyOf,
} from "../src/kernel/governance/transformations/promotion.ts";
import { createPredicateRegistry } from "../src/kernel/governance/verification/registry.ts";

const T0 = 1_700_000_000_000;

/** A predicate registry holding the verifiers the fixtures name. */
function predicates() {
  const reg = createPredicateRegistry();
  for (const [id, version, cls] of [
    ["info-preserved", "2", "representation"],
    ["schema-valid", "1", "structural"],
  ]) {
    reg.register({ id, version, appliesTo: [cls], proves: `${id} holds`, evaluate: async () => ({ passed: true, detail: "fixture" }) });
  }
  return reg;
}

function transformation(over = {}) {
  return {
    schema: "governor.transformation/v1",
    id: "carrier-normalize",
    version: "1",
    title: "Normalize description carriers",
    appliesTo: ["representation"],
    verifier: { predicates: [{ id: "info-preserved", version: "2" }] },
    recovery: { unit: "cohort" },
    ...over,
  };
}

const TUPLE = {
  transformationId: "carrier-normalize",
  transformationVersion: "1",
  verifier: verifierKeyOf([{ id: "info-preserved", version: "2" }]),
  recoveryUnit: "cohort",
};

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

// ── The registry ─────────────────────────────────────────────────────────────

describe("transformation registry — the vocabulary of what could ever be automatic", () => {
  test("a valid transformation registers, is frozen, and reads back exactly", () => {
    const reg = createTransformationRegistry(predicates());
    reg.register(transformation());
    const t = reg.get("carrier-normalize", "1");
    assert.equal(t.title, "Normalize description carriers");
    assert.ok(Object.isFrozen(t), "a registered entry is frozen");
    assert.ok(Object.isFrozen(t.appliesTo), "…including its class list");
    assert.ok(Object.isFrozen(t.verifier.predicates), "…and its verifier list");
    assert.equal(reg.get("carrier-normalize", "2"), null, "a missing version is null, never a guess at another");
    assert.equal(reg.all().length, 1);
  });

  test("D02'S LINE IS STRUCTURAL: content and authority classes are refused at registration", () => {
    const reg = createTransformationRegistry(predicates());
    for (const cls of ["content", "authority"]) {
      assert.throws(
        () => reg.register(transformation({ appliesTo: ["representation", cls] })),
        (e) => e instanceof TransformationRegistryError && e.code === "class_not_automatable",
        `class '${cls}' must be unregistrable`
      );
    }
    assert.equal(reg.all().length, 0, "nothing landed");
    // And the automatable set itself is what D02 names, frozen.
    assert.deepEqual([...AUTOMATABLE_CLASSES], ["encoding", "presentation", "representation", "structural"]);
    assert.ok(Object.isFrozen(AUTOMATABLE_CLASSES));
  });

  test("shape refusals: duplicate versions, empty classes, empty/unregistered verifiers", () => {
    const reg = createTransformationRegistry(predicates());
    reg.register(transformation());
    assert.throws(() => reg.register(transformation()), (e) => e.code === "duplicate");
    reg.register(transformation({ version: "2" })); // a NEW version is fine — versions are immutable, not unique-per-id
    assert.throws(() => reg.register(transformation({ version: "3", appliesTo: [] })), (e) => e.code === "shape_invalid");
    assert.throws(() => reg.register(transformation({ version: "3", verifier: { predicates: [] } })), (e) => e.code === "shape_invalid");
    assert.throws(
      () => reg.register(transformation({ version: "3", verifier: { predicates: [{ id: "info-preserved", version: "99" }] } })),
      (e) => e.code === "verifier_unregistered",
      "a verifier version the predicate registry does not hold refuses — a check that cannot run has not passed"
    );
    assert.throws(
      () => reg.register(transformation({ version: "3", verifier: { predicates: [{ id: "no-such", version: "1" }] } })),
      (e) => e.code === "verifier_unregistered"
    );
  });
});

// ── Tuple identity ───────────────────────────────────────────────────────────

describe("the promotion tuple — exact, canonical, no near-misses", () => {
  test("verifier identity is order-independent; every tuple component changes the key", () => {
    const a = verifierKeyOf([{ id: "x", version: "1" }, { id: "a", version: "2" }]);
    const b = verifierKeyOf([{ id: "a", version: "2" }, { id: "x", version: "1" }]);
    assert.equal(a, b, "two spellings of one verifier set are one identity");
    const base = tupleKeyOf(TUPLE);
    assert.notEqual(tupleKeyOf({ ...TUPLE, transformationVersion: "2" }), base, "a new transformation version restarts the clock");
    assert.notEqual(tupleKeyOf({ ...TUPLE, verifier: verifierKeyOf([{ id: "info-preserved", version: "3" }]) }), base, "a new VERIFIER version restarts the clock");
    assert.notEqual(tupleKeyOf({ ...TUPLE, recoveryUnit: "item" }), base, "a different recovery path is a different tuple");
  });
});

// ── The evidence gate ────────────────────────────────────────────────────────

describe("promotion — facts recorded, decision gestured, absence spoken", () => {
  test("the full path: three evidence kinds accumulate, promote succeeds only after all three, demote brakes", async () => {
    const store = createPromotionStore(memoryIo());

    // The gate speaks its arithmetic from the very first ask.
    let v = await store.verdictOf(TUPLE);
    assert.equal(v.state, "unpromoted");
    assert.equal(v.missing.length, 3, "all three evidence classes are named missing, not silently absent");

    await store.recordEvidence(TUPLE, { kind: "individual-admit", ref: "claim-1" }, T0);
    await assert.rejects(
      () => store.promote(TUPLE, "gesture-1", "nelson", T0 + 1),
      (e) => e instanceof PromotionRefusedError && e.code === "promotion_evidence_missing" && /cohort/.test(e.message) && /recovery drill/.test(e.message),
      "the refusal NAMES the missing classes"
    );

    await store.recordEvidence(TUPLE, { kind: "cohort-admit", ref: "cohort-digest-1", memberCount: 600 }, T0 + 2);
    await store.recordEvidence(TUPLE, { kind: "revert", ref: "proposal-9" }, T0 + 3);

    // Gestured-only, principal named.
    await assert.rejects(() => store.promote(TUPLE, "", "nelson", T0 + 4), (e) => e.code === "authority_missing");
    await store.promote(TUPLE, "gesture-2", "nelson", T0 + 5);
    v = await store.verdictOf(TUPLE);
    assert.equal(v.state, "promoted");
    assert.equal(v.promotedBy, "nelson");
    await assert.rejects(() => store.promote(TUPLE, "gesture-3", "nelson", T0 + 6), (e) => e.code === "already_promoted");

    // The brake: gestured, immediate, evidence survives.
    await assert.rejects(() => store.demote(TUPLE, "", "nelson", "concern", T0 + 7), (e) => e.code === "authority_missing");
    await store.demote(TUPLE, "gesture-4", "nelson", "verifier concern", T0 + 8);
    v = await store.verdictOf(TUPLE);
    assert.equal(v.state, "unpromoted");
    assert.deepEqual(v.counts, { individualAdmits: 1, cohortAdmits: 1, reverts: 1 }, "demotion is distrust of the decision, not amnesia about the facts");
    assert.deepEqual(v.missing, [], "the gate is still met — re-promotion is one gesture away");
    await store.promote(TUPLE, "gesture-5", "nelson", T0 + 9);
    assert.equal((await store.verdictOf(TUPLE)).state, "promoted");
  });

  test("evidence for a NEAR tuple counts for nothing: promote still refuses", async () => {
    const store = createPromotionStore(memoryIo());
    const near = { ...TUPLE, verifier: verifierKeyOf([{ id: "info-preserved", version: "3" }]) };
    await store.recordEvidence(near, { kind: "individual-admit", ref: "c1" }, T0);
    await store.recordEvidence(near, { kind: "cohort-admit", ref: "c2" }, T0);
    await store.recordEvidence(near, { kind: "revert", ref: "c3" }, T0);
    await assert.rejects(
      () => store.promote(TUPLE, "gesture-1", "nelson", T0 + 1),
      (e) => e.code === "promotion_evidence_missing",
      "a different verifier version's evidence is evidence for a different tuple"
    );
    // And the near tuple itself IS promotable — the evidence went where it belongs.
    await store.promote(near, "gesture-2", "nelson", T0 + 2);
    assert.equal((await store.verdictOf(near)).state, "promoted");
  });

  test("refusals write nothing; empty evidence refs refuse", async () => {
    const io = memoryIo();
    const store = createPromotionStore(io);
    await assert.rejects(() => store.recordEvidence(TUPLE, { kind: "revert", ref: "  " }, T0), (e) => e.code === "evidence_invalid");
    await assert.rejects(() => store.promote(TUPLE, "gesture-1", "nelson", T0), (e) => e.code === "promotion_evidence_missing");
    await assert.rejects(() => store.demote(TUPLE, "gesture-1", "nelson", "r", T0), (e) => e.code === "not_promoted");
    assert.equal(io.lines.length, 0, "every refusal above wrote nothing");
  });

  test("the fold survives garbage and half-shaped tuples; verdict helpers are total", () => {
    const good = { kind: "evidence", at: T0, tuple: TUPLE, evidence: { kind: "revert", ref: "x" } };
    const fold = foldPromotionEvents([
      "{ not json",
      JSON.stringify({ kind: "evidence", at: T0, tuple: { transformationId: "x" }, evidence: { kind: "revert", ref: "y" } }),
      JSON.stringify(good),
      JSON.stringify({ kind: "promoted", at: T0, tuple: TUPLE, gestureRef: "g", principal: "nelson" }),
    ]);
    assert.equal(fold.size, 1, "the half-shaped tuple never became a row");
    const s = fold.get(tupleKeyOf(TUPLE));
    assert.equal(s.counts.reverts, 1);
    assert.equal(promotionVerdictOf(s).state, "promoted");
    assert.equal(promotionVerdictOf(null).state, "unpromoted");
    assert.equal(missingEvidenceOf({ individualAdmits: 1, cohortAdmits: 1, reverts: 1 }).length, 0);
  });
});

// ── Integration: evidence flows from REAL admissions (the fact-recorder in
// admission-wiring), and the gate then opens on facts, not assertions ────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAdmission } from "../src/governance/admission-wiring.ts";
import { createDefaultPredicateRegistry } from "../src/kernel/governance/verification/predicates.ts";
import { buildPromotionUi } from "../src/governance/promotion-wiring.ts";
import { openGitRepository } from "../src/governance/history-store/git-repository.ts";
import { proposalRef } from "../src/kernel/governance/history-store/refs.ts";
import { createProposalStore } from "../src/kernel/governance/proposals/proposal-store.ts";
import { openProposal } from "../src/kernel/governance/proposals/proposal.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { digestBytes } from "../src/kernel/governance/contracts/digest.ts";
import { tupleOf } from "../src/kernel/governance/transformations/transformation.ts";

const enc = (s) => new TextEncoder().encode(s);

async function admissionHarness({ recordEvidence } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-wp10a-"));
  const repo = await openGitRepository({ gitdir: path.join(root, "gitdir"), worktree: path.join(root, "vault") });
  const vault = new Map();
  const proposals = createProposalStore(memoryIo());
  // ONE predicate registry shared by admission verification and the
  // transformation registry (the production shape): the default set plus the
  // fixture verifiers, so a subject naming info-preserved@2 has it RUN at
  // admission — which is what makes the recorded evidence honest.
  const sharedPredicates = createDefaultPredicateRegistry();
  for (const [id, version, cls] of [["info-preserved", "2", "representation"], ["schema-valid", "1", "structural"]]) {
    sharedPredicates.register({ id, version, appliesTo: [cls], proves: `${id} holds`, evaluate: async () => ({ passed: true, detail: "fixture" }) });
  }
  const registry = createTransformationRegistry(sharedPredicates);
  // recovery per ITEM: revertToBase is an item-level drill, and the recorder
  // refuses to count it for a cohort-unit tuple (the honesty containment).
  registry.register(transformation({ recovery: { unit: "item" } })); // carrier-normalize@1 — REGISTERED
  const promotionStore = createPromotionStore(memoryIo());
  const recorded = [];
  const admission = buildAdmission({
    repo: async () => repo,
    claimIo: memoryIo(),
    proposals,
    readNoteBytes: async (p) => (vault.has(p) ? enc(vault.get(p)) : null),
    writeNoteBytes: async (p, bytes) => void vault.set(p, new TextDecoder().decode(bytes)),
    bindingGate: async () => ({ ok: true }),
    appendSettlement: async () => {},
    predicates: sharedPredicates,
    promotion: {
      transformationOf: (id, version) => registry.get(id, version),
      recordEvidence:
        recordEvidence ??
        (async (tuple, evidence, at) => {
          recorded.push({ tuple, evidence });
          await promotionStore.recordEvidence(tuple, evidence, at);
        }),
    },
    now: () => T0,
  });
  let seq = 0;
  async function produce(notePath, baseText, proposedText, transformationRef, { classes, preds } = {}) {
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
      transformation: transformationRef,
      // The declared verifier must be COVERED for evidence to count (review of #357).
      predicates: preds ?? [{ id: "content-diff", version: "1" }, { id: "info-preserved", version: "2" }],
      producingOperation: { id: `op-${seq}`, action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "sess-1",
      mandateId: null,
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
  return { admission, produce, promotionStore, registry, recorded, cleanup };
}

const REGISTERED = { id: "carrier-normalize", version: "1" };
const UNREGISTERED = { id: "note.write", version: "1" };

describe("evidence flows from real admissions — and only for registered transformations", () => {
  test("individual admit, cohort admit, revert: each records its evidence kind against the REGISTERED tuple; then the gate opens", async () => {
    const h = await admissionHarness();
    try {
      // Pilot: one individual admit.
      const p1 = await h.produce("Notes/a.md", "old\n", "new\n", REGISTERED);
      const solo = await h.admission.admitWithGesture(p1.id, "gesture-1");
      assert.ok(solo.ok, JSON.stringify(solo));

      // Cohort: two members, one gesture.
      const p2 = await h.produce("Notes/b.md", "old b\n", "new b\n", REGISTERED);
      const p3 = await h.produce("Notes/c.md", "old c\n", "new c\n", REGISTERED);
      const sel = await h.admission.freezeSelection({ folder: "Notes" }, "item");
      assert.ok(sel.ok, sel.reason);
      assert.equal(sel.frozen.subject.items.length, 2, "the admitted pilot is no longer pending");
      const cohort = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-2");
      assert.ok(cohort.ok, JSON.stringify(cohort));

      // Recovery drill: a revert of a fresh proposal of the same tuple.
      const p4 = await h.produce("Notes/d.md", "old d\n", "new d\n", REGISTERED);
      const back = await h.admission.revertToBase(p4.id, "gesture-3");
      assert.ok(back.ok, JSON.stringify(back));

      const kinds = h.recorded.map((r) => r.evidence.kind).sort();
      assert.deepEqual(kinds, ["cohort-admit", "individual-admit", "revert"]);
      const cohortEv = h.recorded.find((r) => r.evidence.kind === "cohort-admit");
      assert.equal(cohortEv.evidence.memberCount, 2);
      assert.equal(cohortEv.evidence.ref, sel.frozen.digest.value, "cohort evidence references the frozen digest");
      for (const r of h.recorded) {
        assert.equal(r.tuple.transformationId, "carrier-normalize");
        assert.equal(r.tuple.recoveryUnit, "item", "the tuple comes from the REGISTERED declaration, not the subject");
      }

      // THE GATE OPENS ON FACTS: promote now succeeds through the UI wiring.
      const ui = buildPromotionUi({ registry: h.registry, store: h.promotionStore, principal: () => "nelson", now: () => T0 + 100 });
      const rows = await ui.rows();
      assert.equal(rows[0].verdict.state, "unpromoted");
      assert.deepEqual(rows[0].verdict.missing, [], "the live-evidence gate is met by the three real acts above");
      const promoted = await ui.promote("carrier-normalize", "1", "gesture-4");
      assert.ok(promoted.ok, JSON.stringify(promoted));
      assert.equal((await ui.rows())[0].verdict.state, "promoted");
      // And the UI refuses without a gesture, and over unknown transformations.
      assert.equal((await ui.demote("carrier-normalize", "1", "r", "")).code, "authority_missing");
      assert.equal((await ui.promote("no-such", "1", "gesture-5")).code, "transformation_unknown");
    } finally {
      h.cleanup();
    }
  });

  test("an UNREGISTERED transformation's admissions record nothing — ordinary decisions, evidence for nothing automatic", async () => {
    const h = await admissionHarness();
    // The console spy distinguishes the CLEAN skip (the null-guard) from a
    // swallowed crash that happens to record nothing: removing the guard
    // makes tupleOf(null) throw into the recorder's catch — same zero
    // records, but NOISY, once per admission (the post-cutover auto-accept
    // sweep taught us what per-poll console noise costs). Silent is pinned.
    const errors = [];
    const origError = console.error;
    console.error = (...args) => void errors.push(args.map(String).join(" "));
    try {
      const p = await h.produce("Notes/x.md", "old\n", "new\n", UNREGISTERED);
      const solo = await h.admission.admitWithGesture(p.id, "gesture-1");
      assert.ok(solo.ok);
      assert.equal(h.recorded.length, 0, "no evidence accrued");
      assert.deepEqual(errors.filter((e) => e.includes("promotion evidence")), [], "the skip is CLEAN — no swallowed crash masquerading as the guard");
    } finally {
      console.error = origError;
      h.cleanup();
    }
  });

  test("a THROWING evidence recorder never costs the admission — facts must not tax acts", async () => {
    const h = await admissionHarness({ recordEvidence: async () => { throw new Error("evidence store down"); } });
    try {
      const p = await h.produce("Notes/y.md", "old\n", "new\n", REGISTERED);
      const solo = await h.admission.admitWithGesture(p.id, "gesture-1");
      assert.ok(solo.ok, "the admission stands although evidence recording failed");
    } finally {
      h.cleanup();
    }
  });
});

describe("review-of-#357 fixes, pinned", () => {
  test("the honesty containments: uncovered verifier, out-of-footprint class, and unit-mismatched revert each record NOTHING, silently", async () => {
    const h = await admissionHarness();
    const errors = [];
    const origError = console.error;
    console.error = (...args) => void errors.push(args.map(String).join(" "));
    try {
      // Subject claims the registered transformation but never carried its verifier.
      const p1 = await h.produce("Notes/nc.md", "o\n", "n\n", REGISTERED, { preds: [{ id: "content-diff", version: "1" }] });
      assert.ok((await h.admission.admitWithGesture(p1.id, "g-1")).ok);
      // Subject's class is outside the declared footprint.
      const p2 = await h.produce("Notes/oc.md", "o\n", "n\n", REGISTERED, { classes: ["content"] });
      assert.ok((await h.admission.admitWithGesture(p2.id, "g-2")).ok);
      assert.equal(h.recorded.length, 0, "admitted-but-not-the-tuple's-shape is evidence for nothing");
      assert.deepEqual(errors.filter((e) => e.includes("promotion evidence")), [], "each skip is clean, not a swallowed crash");
    } finally {
      console.error = origError;
      h.cleanup();
    }
  });

  test("a COHORT-unit tuple's drill is not satisfied by an item revert — the missing drill stays named", async () => {
    // A registry whose transformation declares recovery per cohort, same everything else.
    const h = await admissionHarness();
    try {
      h.registry.register(transformation({ version: "2", recovery: { unit: "cohort" } }));
      const p = await h.produce("Notes/cu.md", "o\n", "n\n", { id: "carrier-normalize", version: "2" });
      assert.ok((await h.admission.revertToBase(p.id, "g-1")).ok);
      assert.equal(h.recorded.length, 0, "an item revert does not exercise 'recovery per cohort'");
    } finally {
      h.cleanup();
    }
  });

  test("promote AND demote each require a named principal; the fold skips a half-shaped promoted line", async () => {
    const store = createPromotionStore(memoryIo());
    for (const [kind, ref] of [["individual-admit", "a"], ["cohort-admit", "b"], ["revert", "c"]]) {
      await store.recordEvidence(TUPLE, { kind, ref }, T0);
    }
    await assert.rejects(() => store.promote(TUPLE, "g-1", "  ", T0), (e) => e.code === "authority_missing");
    await store.promote(TUPLE, "g-1", "nelson", T0);
    await assert.rejects(() => store.demote(TUPLE, "g-2", "", "r", T0), (e) => e.code === "authority_missing");
    const fold = foldPromotionEvents([JSON.stringify({ kind: "promoted", tuple: TUPLE })]);
    assert.equal(promotionVerdictOf(fold.get(tupleKeyOf(TUPLE))).state, "unpromoted", "a promoted line with no clock and no principal folds to nothing");
  });

  test("separator characters are unregistrable — tuple identities cannot collide by data", () => {
    const reg = createTransformationRegistry(predicates());
    for (const bad of ["a,b", "a@b", "a|b", "a b"]) {
      assert.throws(() => reg.register(transformation({ id: bad })), (e) => e.code === "shape_invalid", `id '${bad}' must refuse`);
      assert.throws(() => reg.register(transformation({ version: bad })), (e) => e.code === "shape_invalid", `version '${bad}' must refuse`);
    }
  });
});
