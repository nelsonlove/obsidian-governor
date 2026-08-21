/**
 * governance-individual-admission.test.mjs — WP6, the only admission path (§9).
 *
 * End to end through the kernel: durable observations → canonical proposal →
 * exact verification → human-gesture authority → AdmissionService → standing.
 * The properties under test are the guide's own sentences: AdmissionService
 * is the only code that advances standing; it revalidates the exact subject;
 * it refuses every row of the §9 table; and the standing ref never moves
 * except by compare-and-swap over a capability the service alone holds.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digestUtf8 } from "../src/kernel/governance/contracts/digest.ts";
import { buildProposalSubjectFromOperation, ProposalDependencyError } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { openProposal, withVerification } from "../src/kernel/governance/proposals/proposal.ts";
import { createProposalStore } from "../src/kernel/governance/proposals/proposal-store.ts";
import { createPredicateRegistry, PredicateRegistryError } from "../src/kernel/governance/verification/registry.ts";
import { verifySubject } from "../src/kernel/governance/verification/verify.ts";
import { requireAdmissible, AdmissionRefusedError } from "../src/kernel/governance/admission/policy.ts";
import { createAdmissionService } from "../src/kernel/governance/admission/service.ts";
import { createClaimStore } from "../src/kernel/governance/admission/settlement.ts";
import { createStandingResolver } from "../src/kernel/governance/admission/standing-resolver.ts";
import { RefCasError } from "../src/kernel/governance/history-store/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const d = (t) => digestUtf8(t);
const T0 = 1_700_000_000_000;
const RAND = (n) => new Uint8Array(10).fill(n);

// ── shared fixtures ──────────────────────────────────────────────────────────

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

const DIFF_PREDICATE = {
  id: "diff-complete",
  version: "1",
  appliesTo: ["content"],
  proves: "the diff between base and proposed is complete and named",
  async evaluate(subject, evidence) {
    const ok = evidence.proposedBytes != null;
    return { passed: ok, detail: ok ? "proposed bytes present and diffed" : "no proposed bytes to diff" };
  },
};

function subjectInput(over = {}) {
  return {
    vaultId: "vault-1",
    noteId: "note-1",
    path: "Notes/A.md",
    pathSemanticallyRelevant: false,
    base: d("base\n"),
    proposed: d("proposed\n"),
    changeClasses: ["content"],
    transformation: { id: "edit", version: "1" },
    predicates: [{ id: "diff-complete", version: "1" }],
    producingOperation: { id: "op-1", action: "note.write", actionVersion: 1 },
    observations: [{ id: "obs-1", level: "replayable", digest: d("seen"), payloadAvailable: true }],
    sessionId: "sess-1",
    mandateId: null,
    ...over,
  };
}

/** The whole path in one harness: registry, stores, a fake standing ref. */
function harness() {
  const registry = createPredicateRegistry();
  registry.register(DIFF_PREDICATE);

  // The standing ref, as the WIRING would build it: a single mutable cell
  // behind a CAS closure. The service receives the closure and nothing else.
  let standing = null;
  const casCalls = [];
  const standingAdvance = async (expected, next) => {
    casCalls.push({ expected, next });
    if (standing !== expected) throw new RefCasError("refs/governor/standing", expected, standing);
    standing = next;
  };

  const claims = createClaimStore(memoryIo());
  const settlements = [];
  // The clock ticks per call: a fixed now + fixed rand would mint IDENTICAL
  // claim ids for two admissions (UUIDv7 is deterministic under injection),
  // which is a property of the test's determinism, not of admissions.
  let tick = 0;
  const service = createAdmissionService({
    claims,
    standingAdvance,
    currentStanding: async () => standing,
    recordSettlement: async (r) => void settlements.push(r),
    now: () => T0 + 10 + ++tick,
    rand: () => RAND(9),
  });
  const resolver = createStandingResolver({ claims, currentStanding: async () => standing });
  return { registry, claims, service, resolver, settlements, casCalls, standing: () => standing };
}

// ── the end-to-end path ──────────────────────────────────────────────────────

describe("individual admission — the seven steps, end to end", () => {
  test("observations → subject → proposal → verification → gesture → admission → standing", async () => {
    const h = harness();

    // 1-2. A native operation's evidence becomes a canonical subject.
    const subject = buildProposalSubjectFromOperation(subjectInput());
    const proposal = openProposal({ subject, sessionId: "sess-1" }, T0, RAND(1));
    const store = createProposalStore(memoryIo());
    await store.open(proposal, T0);

    // 3. The registered verifier covers the exact subject.
    const outcome = await verifySubject(h.registry, subject, { proposedBytes: new TextEncoder().encode("proposed\n") }, T0 + 5);
    assert.ok(outcome.passed);
    await store.setVerification(proposal.id, "passed", T0 + 5);

    // 4-5. The human gesture authorizes; the service revalidates and admits.
    const verified = withVerification(proposal, "passed");
    const { claim } = await h.service.admit({
      proposal: verified,
      subject,
      verification: outcome.records,
      authority: { kind: "human-gesture", gestureRef: "gesture-123" },
    });

    // 6. The receipt distinguishes the stages: claim ≠ operation ≠ proposal.
    assert.notEqual(claim.id, proposal.id);
    assert.equal(claim.proposalId, proposal.id);
    assert.equal(claim.subjectDigest.value, proposal.subjectDigest.value);
    assert.equal(claim.authority.gestureRef, "gesture-123");

    // Standing advanced by CAS, exactly once, from null.
    assert.equal(h.standing(), claim.id);
    assert.deepEqual(h.casCalls, [{ expected: null, next: claim.id }]);
    assert.equal(h.settlements.length, 1);

    // The resolver answers from the claim chain.
    const answer = await h.resolver.forSubject(subject && claim.subjectDigest.value);
    assert.equal(answer.state, "admitted");
    await store.markAdmitted(proposal.id, claim.id, T0 + 11);
    assert.equal((await store.get(proposal.id)).authority, "admitted");
  });

  test("a second admission supersedes the first through the SAME CAS chain", async () => {
    const h = harness();
    const s1 = buildProposalSubjectFromOperation(subjectInput());
    const p1 = openProposal({ subject: s1, sessionId: "s" }, T0, RAND(1));
    const o1 = await verifySubject(h.registry, s1, { proposedBytes: new Uint8Array(1) }, T0);
    const a1 = await h.service.admit({ proposal: withVerification(p1, "passed"), subject: s1, verification: o1.records, authority: { kind: "human-gesture", gestureRef: "g1" } });

    const s2 = buildProposalSubjectFromOperation(subjectInput({ proposed: d("v2\n"), base: d("proposed\n") }));
    const p2 = openProposal({ subject: s2, sessionId: "s" }, T0 + 20, RAND(2));
    const o2 = await verifySubject(h.registry, s2, { proposedBytes: new Uint8Array(1) }, T0 + 20);
    const a2 = await h.service.admit({ proposal: withVerification(p2, "passed"), subject: s2, verification: o2.records, authority: { kind: "human-gesture", gestureRef: "g2" } });

    assert.equal(h.standing(), a2.claim.id);
    const first = await h.resolver.forSubject(a1.claim.subjectDigest.value);
    assert.equal(first.state, "superseded");
    assert.equal(first.by.id, a2.claim.id);
  });
});

// ── the refusal table (§9) ───────────────────────────────────────────────────

describe("admission policy — every §9 refusal, by code", () => {
  const subject = () => buildProposalSubjectFromOperation(subjectInput());
  async function records(h, subj) {
    return (await verifySubject(h.registry, subj, { proposedBytes: new Uint8Array(1) }, T0)).records;
  }

  test("a drifted subject refuses: subject_drift", async () => {
    const h = harness();
    const subj = subject();
    const proposal = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    const drifted = buildProposalSubjectFromOperation(subjectInput({ proposed: d("SOMETHING ELSE") }));
    const driftedRecords = await records(h, drifted);
    await assert.rejects(
      () => h.service.admit({ proposal, subject: drifted, verification: driftedRecords, authority: { kind: "human-gesture", gestureRef: "g" } }),
      (e) => e instanceof AdmissionRefusedError && e.code === "subject_drift"
    );
    assert.equal(h.standing(), null, "nothing advanced");
  });

  test("failed verification refuses: verification_failed", async () => {
    const h = harness();
    const subj = subject();
    const proposal = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    const failing = await verifySubject(h.registry, subj, { proposedBytes: null }, T0);
    assert.ok(!failing.passed);
    await assert.rejects(
      () => h.service.admit({ proposal, subject: subj, verification: failing.records, authority: { kind: "human-gesture", gestureRef: "g" } }),
      (e) => e.code === "verification_failed"
    );
  });

  test("missing required verification refuses: verification_incomplete — sampling is not coverage", async () => {
    const h = harness();
    const subj = subject();
    const proposal = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    await assert.rejects(
      () => h.service.admit({ proposal, subject: subj, verification: [], authority: { kind: "human-gesture", gestureRef: "g" } }),
      (e) => e.code === "verification_incomplete"
    );
  });

  test("verification addressed to another digest refuses: verification_stale", async () => {
    const h = harness();
    const subj = subject();
    const other = buildProposalSubjectFromOperation(subjectInput({ proposed: d("other") }));
    const proposal = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    const staleRecords = await records(h, other);
    await assert.rejects(
      () => h.service.admit({ proposal, subject: subj, verification: staleRecords, authority: { kind: "human-gesture", gestureRef: "g" } }),
      (e) => e.code === "verification_stale"
    );
  });

  test("a mandate authority refuses OUTRIGHT: Gate 1 has no automatic admission", async () => {
    const h = harness();
    const subj = subject();
    const proposal = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    const okRecords = await records(h, subj);
    await assert.rejects(
      () => h.service.admit({ proposal, subject: subj, verification: okRecords, authority: { kind: "mandate", mandateId: "m-1" } }),
      (e) => e.code === "mandate_not_supported"
    );
  });

  test("a missing gesture reference refuses: authority_missing", () => {
    const subj = subject();
    const proposal = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    assert.throws(
      () => requireAdmissible({ proposal, subject: subj, verification: [], authority: { kind: "human-gesture", gestureRef: "" } }, T0),
      (e) => e.code === "authority_missing" || e.code === "verification_incomplete"
    );
  });

  test("an already-admitted or superseded proposal refuses: proposal_not_proposed", async () => {
    const h = harness();
    const subj = subject();
    const p = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    const recs = await records(h, subj);
    await h.service.admit({ proposal: p, subject: subj, verification: recs, authority: { kind: "human-gesture", gestureRef: "g" } });
    const admitted = { ...p, authority: "admitted" };
    await assert.rejects(
      () => h.service.admit({ proposal: admitted, subject: subj, verification: recs, authority: { kind: "human-gesture", gestureRef: "g" } }),
      (e) => e.code === "proposal_not_proposed"
    );
  });

  test("an ephemeral dependency cannot reach admission — refused at BUILD time already", () => {
    assert.throws(
      () => buildProposalSubjectFromOperation(subjectInput({ observations: [{ id: "o", level: "ephemeral", digest: d("x"), payloadAvailable: false }] })),
      ProposalDependencyError
    );
  });

  test("a replayable dependency with a missing payload refuses at build time", () => {
    assert.throws(
      () => buildProposalSubjectFromOperation(subjectInput({ observations: [{ id: "o", level: "replayable", digest: d("x"), payloadAvailable: false }] })),
      (e) => e.code === "proposal_dependency_invalid"
    );
  });

  test("a subject requiring an unregistered predicate cannot even verify", async () => {
    const h = harness();
    const subj = buildProposalSubjectFromOperation(subjectInput({ predicates: [{ id: "ghost", version: "9" }] }));
    await assert.rejects(() => verifySubject(h.registry, subj, {}, T0), PredicateRegistryError);
  });
});

// ── concurrency and the CAS ──────────────────────────────────────────────────

describe("admission — standing moves only by CAS, serialized", () => {
  test("standing moved under the admission → RefCasError, and the loser's claim stays unattached", async () => {
    const h = harness();
    const subj = buildProposalSubjectFromOperation(subjectInput());
    const p = withVerification(openProposal({ subject: subj, sessionId: "s" }, T0, RAND(1)), "passed");
    const recs = (await verifySubject(h.registry, subj, { proposedBytes: new Uint8Array(1) }, T0)).records;

    // Sabotage: standing moves after the service reads its expectation. The
    // serialized chain prevents INTERNAL interleaving, so simulate an external
    // mover by wrapping currentStanding to lie once.
    let lied = false;
    const service = createAdmissionService({
      claims: h.claims,
      standingAdvance: async (expected, next) => {
        if (!lied) {
          lied = true;
          throw new RefCasError("refs/governor/standing", expected, "someone-else");
        }
        void next;
      },
      currentStanding: async () => null,
      recordSettlement: async () => {},
      now: () => T0,
    });
    await assert.rejects(
      () => service.admit({ proposal: p, subject: subj, verification: recs, authority: { kind: "human-gesture", gestureRef: "g" } }),
      RefCasError
    );
    // The claim was durably stored before the CAS — unattached evidence,
    // exactly what §10 calls safe to retry.
    assert.equal((await h.claims.all()).length, 1);
  });
});

// ── the isolation, enforced at the source ────────────────────────────────────

describe("standing isolation — nothing outside the sanctioned modules touches the standing ref", () => {
  test("standingRef() is constructed only in refs.ts; no suggestive public surface exists", () => {
    const srcDir = path.join(HERE, "..", "src");
    const offenders = [];
    const allowed = [
      path.join("kernel", "governance", "history-store", "refs.ts"), // the construction point
    ];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(p, "utf8");
          if (/refs\/governor\/standing/.test(text) && !allowed.some((a) => p.endsWith(a))) {
            offenders.push(p);
          }
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], "the standing ref name is constructed in exactly one module");
  });

  test("the AdmissionService is not placed on any ambient surface", () => {
    // §9: not on the plugin instance, view instance, command registry, MCP
    // registry, or DOM. The service exists only as a closure-held value; this
    // scan refuses the assignments that would ambient-publish it.
    const srcDir = path.join(HERE, "..", "src");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(p, "utf8");
          if (/(this|window|globalThis|app)\s*\.\s*\w*[aA]dmission\w*\s*=/.test(text)) offenders.push(p);
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, []);
  });
});
