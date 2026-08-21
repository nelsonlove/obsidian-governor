/**
 * governance-cohort.test.mjs — WP7: selectors, freeze, full coverage, and the
 * 600-note representation test.
 *
 * The properties, in the settled decisions' own words: dynamic queries only
 * SELECT (the authority object is the frozen manifest); later work cannot
 * enter a frozen cohort (arithmetic, not policy — the digest moves);
 * sampling does not replace required verification (one failed item fails the
 * whole cohort, never silently dropped or admitted); exclusions create a NEW
 * digest (a different decision, never an edit).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { selectProposals, groupIneligibilityOf } from "../src/kernel/governance/cohorts/cohort.ts";
import { freezeCohort, excludeAndRefreeze } from "../src/kernel/governance/cohorts/freeze.ts";
import { verifyCohortCoverage } from "../src/kernel/governance/cohorts/coverage.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { openProposal } from "../src/kernel/governance/proposals/proposal.ts";
import { digestUtf8, digestBytes } from "../src/kernel/governance/contracts/digest.ts";
import { createDefaultPredicateRegistry } from "../src/kernel/governance/verification/predicates.ts";
import { SubjectInvalidError } from "../src/kernel/governance/contracts/subject-v1.ts";

const enc = (s) => new TextEncoder().encode(s);
const T0 = 1_700_000_000_000;

/** Deterministic synthetic proposal factory. */
let seq = 0;
function proposalFor({ notePath, session = "sess-1", classes = ["content"], transformation = { id: "note.write", version: "1" }, baseText = null, proposedText = "body", verification = "unverified" } = {}) {
  seq++;
  const subject = buildProposalSubjectFromOperation({
    vaultId: "vault-1",
    noteId: `uid-${String(seq).padStart(4, "0")}`,
    path: notePath,
    pathSemanticallyRelevant: false,
    base: baseText === null ? null : digestBytes(enc(baseText)),
    proposed: digestBytes(enc(proposedText)),
    changeClasses: classes,
    transformation,
    predicates: [{ id: "content-diff", version: "1" }],
    producingOperation: { id: `op-${seq}`, action: "note.write", actionVersion: 1 },
    observations: [],
    sessionId: session,
    mandateId: null,
  });
  const p = openProposal({ subject, sessionId: session }, T0 + seq, new Uint8Array(10).fill(seq % 251));
  return { ...p, verification };
}

const SCOPE = { include: ["Notes/"], exclude: [] };

// ── selectors ────────────────────────────────────────────────────────────────

describe("selectors — queries select; they never define", () => {
  const pool = [
    proposalFor({ notePath: "Notes/a.md", session: "s1" }),
    proposalFor({ notePath: "Notes/b.md", session: "s1", verification: "passed" }),
    proposalFor({ notePath: "Other/c.md", session: "s2" }),
    { ...proposalFor({ notePath: "Notes/d.md", session: "s1" }), authority: "admitted" },
  ];

  test("by session, by folder, by verification, and their intersection", () => {
    assert.equal(selectProposals(pool, { sessionId: "s1" }).length, 2, "admitted d.md is never a candidate");
    assert.equal(selectProposals(pool, { folder: "Notes" }).length, 2);
    assert.equal(selectProposals(pool, { verification: "passed" }).length, 1);
    assert.equal(selectProposals(pool, { sessionId: "s1", folder: "Notes", verification: "passed" }).length, 1);
  });

  test("class selection is EXACT combination equality, not overlap", () => {
    const structural = proposalFor({ notePath: "Notes/s.md", classes: ["structural", "content"] });
    const all = [...pool, structural];
    assert.equal(selectProposals(all, { classes: ["content"] }).length, 3); // a, b, and Other/c — all pure content
    assert.equal(selectProposals(all, { classes: ["content", "structural"] }).length, 1);
  });

  test("folder is a folder root, never a loose prefix", () => {
    const tricky = proposalFor({ notePath: "Notes2/x.md" });
    assert.equal(selectProposals([tricky], { folder: "Notes" }).length, 0);
  });
});

// ── freezing ─────────────────────────────────────────────────────────────────

describe("freeze — the moment a query stops being a query", () => {
  test("later work cannot enter: a new proposal changes the digest, arithmetically", () => {
    const a = proposalFor({ notePath: "Notes/a.md" });
    const b = proposalFor({ notePath: "Notes/b.md" });
    const frozen1 = freezeCohort({ items: [a, b], resolvedScope: SCOPE, recoveryUnit: "item" });
    const late = proposalFor({ notePath: "Notes/late.md" });
    const frozen2 = freezeCohort({ items: [a, b, late], resolvedScope: SCOPE, recoveryUnit: "item" });
    assert.notEqual(frozen1.digest.value, frozen2.digest.value);
    // and the ORIGINAL frozen subject is untouched by the existence of the new one
    assert.equal(frozen1.subject.items.length, 2);
  });

  test("an ineligible group refuses to freeze: mixed classes", () => {
    const content = proposalFor({ notePath: "Notes/a.md", classes: ["content"] });
    const mixed = proposalFor({ notePath: "Notes/b.md", classes: ["structural", "content"] });
    assert.equal(groupIneligibilityOf([content, mixed]) !== null, true);
    assert.throws(() => freezeCohort({ items: [content, mixed], resolvedScope: SCOPE, recoveryUnit: "item" }), SubjectInvalidError);
  });

  test("an ineligible group refuses to freeze: mixed transformations; empty freezes nothing", () => {
    const a = proposalFor({ notePath: "Notes/a.md", transformation: { id: "note.write", version: "1" } });
    const b = proposalFor({ notePath: "Notes/b.md", transformation: { id: "formatter", version: "2" } });
    assert.throws(() => freezeCohort({ items: [a, b], resolvedScope: SCOPE, recoveryUnit: "item" }));
    assert.throws(() => freezeCohort({ items: [], resolvedScope: SCOPE, recoveryUnit: "item" }));
  });

  test("memberProposalIds[i] corresponds to subject.items[i] — the correlation, not just the sort", () => {
    // The first version compared the item list against a sorted copy of
    // itself — self-referential (review finding). The crux is that position
    // i's member id is THE proposal whose subject sits at position i.
    const z = proposalFor({ notePath: "Notes/z.md" });
    const a = proposalFor({ notePath: "Notes/a.md" });
    const frozen = freezeCohort({ items: [z, a], resolvedScope: SCOPE, recoveryUnit: "item" });
    for (let i = 0; i < frozen.subject.items.length; i++) {
      const source = [z, a].find((p) => p.subject.noteId === frozen.subject.items[i].noteId);
      assert.equal(frozen.memberProposalIds[i], source.id, `position ${i} names the right proposal`);
    }
  });

  test("a mismatched (original, frozen) pair refuses to exclude — arithmetic over trust", () => {
    const a = proposalFor({ notePath: "Notes/a.md" });
    const b = proposalFor({ notePath: "Notes/b.md" });
    const c = proposalFor({ notePath: "Notes/c.md" });
    const input = { items: [a, b], resolvedScope: SCOPE, recoveryUnit: "item" };
    const frozen = freezeCohort(input);
    assert.throws(
      () => excludeAndRefreeze({ items: [a, c], resolvedScope: SCOPE, recoveryUnit: "item" }, frozen, [b.id]),
      SubjectInvalidError,
      "a successor must derive from the decision presented, not from whatever the caller claims"
    );
  });

  test("the frozen structure refuses casual mutation; WP7b's real guard is recomputation", () => {
    const a = proposalFor({ notePath: "Notes/a.md" });
    const frozen = freezeCohort({ items: [a], resolvedScope: SCOPE, recoveryUnit: "item" });
    assert.ok(Object.isFrozen(frozen.subject));
    assert.ok(Object.isFrozen(frozen.subject.items));
    assert.throws(() => {
      frozen.subject.items.pop();
    });
  });

  test("non-proposed and revision-requested members refuse to freeze — no unresolved escalation rides a gesture", () => {
    const a = proposalFor({ notePath: "Notes/a.md" });
    const admitted = { ...proposalFor({ notePath: "Notes/b.md" }), authority: "admitted" };
    const revising = { ...proposalFor({ notePath: "Notes/c.md" }), development: "revision-requested" };
    assert.throws(() => freezeCohort({ items: [a, admitted], resolvedScope: SCOPE, recoveryUnit: "item" }));
    assert.throws(() => freezeCohort({ items: [a, revising], resolvedScope: SCOPE, recoveryUnit: "item" }));
  });

  test("mixed verifier policies refuse — one gesture must not cover items verified to different standards", () => {
    const a = proposalFor({ notePath: "Notes/a.md" });
    const b = proposalFor({ notePath: "Notes/b.md" });
    const otherPolicy = { ...b, subject: { ...b.subject, predicates: [{ id: "other-pred", version: "9" }] } };
    assert.throws(() => freezeCohort({ items: [a, otherPolicy], resolvedScope: SCOPE, recoveryUnit: "item" }));
  });

  test("exclusion produces a SUCCESSOR digest carrying the exclusion in its subject", () => {
    const a = proposalFor({ notePath: "Notes/a.md" });
    const b = proposalFor({ notePath: "Notes/b.md" });
    const input = { items: [a, b], resolvedScope: SCOPE, recoveryUnit: "item" };
    const frozen = freezeCohort(input);
    const successor = excludeAndRefreeze(input, frozen, [b.id]);
    assert.notEqual(successor.digest.value, frozen.digest.value);
    assert.deepEqual(successor.subject.excludedProposalIds, [b.id]);
    assert.equal(successor.subject.items.length, 1);
    // excluding a non-member refuses
    assert.throws(() => excludeAndRefreeze(input, frozen, ["ghost"]), SubjectInvalidError);
  });
});

// ── coverage ─────────────────────────────────────────────────────────────────

describe("coverage — exact and total, sampling is not verification", () => {
  const registry = createDefaultPredicateRegistry();

  function evidenceMap(pairs) {
    const m = new Map(pairs);
    return async (item) => {
      const e = m.get(item.noteId);
      if (!e) throw new Error(`no evidence for ${item.noteId}`);
      return e;
    };
  }

  test("all items verified → the cohort passes, addressed to its digest", async () => {
    const a = proposalFor({ notePath: "Notes/a.md", baseText: "ba", proposedText: "pa" });
    const b = proposalFor({ notePath: "Notes/b.md", baseText: "bb", proposedText: "pb" });
    const frozen = freezeCohort({ items: [a, b], resolvedScope: SCOPE, recoveryUnit: "item" });
    const outcome = await verifyCohortCoverage(
      registry,
      frozen,
      evidenceMap([
        [a.subject.noteId, { baseBytes: enc("ba"), proposedBytes: enc("pa") }],
        [b.subject.noteId, { baseBytes: enc("bb"), proposedBytes: enc("pb") }],
      ]),
      T0
    );
    assert.ok(outcome.passed);
    assert.equal(outcome.cohortDigest, frozen.digest.value);
  });

  test("ONE failed item fails the WHOLE cohort — and is named, never dropped", async () => {
    const a = proposalFor({ notePath: "Notes/a.md", baseText: "ba", proposedText: "pa" });
    const bad = proposalFor({ notePath: "Notes/bad.md", baseText: "bb", proposedText: "pb" });
    const frozen = freezeCohort({ items: [a, bad], resolvedScope: SCOPE, recoveryUnit: "item" });
    const outcome = await verifyCohortCoverage(
      registry,
      frozen,
      evidenceMap([
        [a.subject.noteId, { baseBytes: enc("ba"), proposedBytes: enc("pa") }],
        [bad.subject.noteId, { baseBytes: enc("bb"), proposedBytes: enc("DRIFTED") }],
      ]),
      T0
    );
    assert.ok(!outcome.passed);
    assert.deepEqual(outcome.failedNoteIds, [bad.subject.noteId]);
    assert.equal(outcome.items.length, 2, "every item is in the outcome — nothing vanished");
  });

  test("unresolvable evidence is a FAILED item, not a skipped one", async () => {
    const a = proposalFor({ notePath: "Notes/a.md", baseText: "ba", proposedText: "pa" });
    const frozen = freezeCohort({ items: [a], resolvedScope: SCOPE, recoveryUnit: "item" });
    const outcome = await verifyCohortCoverage(registry, frozen, async () => {
      throw new Error("recording unreadable");
    }, T0);
    assert.ok(!outcome.passed);
    assert.match(outcome.items[0].records[0].detail, /evidence could not be resolved/);
  });
});

// ── the 600-note representation test ─────────────────────────────────────────

describe("the 600-note representation fixture — deliberate exceptions, no silent anything", () => {
  test("600 synthetic description-carriers: freeze, verify, split by finding, admit the successor", async () => {
    const registry = createDefaultPredicateRegistry();
    // 600 notes; 7 deliberately broken (their live bytes drifted after the
    // proposal — the representation change did not land as recorded).
    const BROKEN = new Set([13, 111, 222, 333, 444, 555, 599]);
    const items = [];
    const evidence = new Map();
    for (let i = 0; i < 600; i++) {
      const notePath = `Notes/carrier-${String(i).padStart(3, "0")}.md`;
      const baseText = `description: old ${i}\n`;
      const proposedText = `description: new ${i}\n`;
      const p = proposalFor({ notePath, baseText, proposedText, transformation: { id: "description-migrate", version: "1" } });
      items.push(p);
      evidence.set(p.subject.noteId, {
        baseBytes: enc(baseText),
        proposedBytes: BROKEN.has(i) ? enc("SOMETHING ELSE ENTIRELY\n") : enc(proposedText),
      });
    }

    const input = { items, resolvedScope: { include: ["Notes/"], exclude: [] }, recoveryUnit: "item" };
    const frozen = freezeCohort(input);
    assert.equal(frozen.subject.items.length, 600);

    const outcome = await verifyCohortCoverage(registry, frozen, async (item) => evidence.get(item.noteId), T0);
    assert.ok(!outcome.passed, "seven deliberate exceptions fail the WHOLE cohort");
    assert.equal(outcome.failedNoteIds.length, 7);

    // Split by finding: exclude the failures into a successor decision.
    const failedProposalIds = outcome.items.filter((i) => !i.passed).map((i) => i.proposalId);
    const successor = excludeAndRefreeze(input, frozen, failedProposalIds);
    assert.equal(successor.subject.items.length, 593);
    assert.equal(successor.subject.excludedProposalIds.length, 7, "the exclusions are IN the successor's subject");
    assert.notEqual(successor.digest.value, frozen.digest.value, "a different decision, a different digest");

    const successorOutcome = await verifyCohortCoverage(registry, successor, async (item) => evidence.get(item.noteId), T0);
    assert.ok(successorOutcome.passed, "the successor passes exact-and-total coverage");
    assert.equal(successorOutcome.cohortDigest, successor.digest.value);

    // And the failed items are still THERE, proposed, awaiting their own path
    // — excluded, never silently dropped from existence.
    for (const id of failedProposalIds) {
      const still = items.find((p) => p.id === id);
      assert.equal(still.authority, "proposed");
    }
  });
});
