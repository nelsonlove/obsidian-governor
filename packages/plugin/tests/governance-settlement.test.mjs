/**
 * governance-settlement.test.mjs — WP6, crash windows and the two asymmetric
 * rules (§10).
 *
 * "An admission claim written without a ref advance is unattached evidence
 * and can be retried safely. A ref that points to a missing or invalid claim
 * is a critical health failure and must not be presented as standing."
 *
 * Every test here is one crash window or one side of that asymmetry. The
 * dangerous direction — manufacturing authority during recovery — must be
 * structurally unavailable, and the ordering (claim BEFORE ref) is what
 * guarantees no window leaves a ref naming evidence that does not exist.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { digestUtf8 } from "../src/kernel/governance/contracts/digest.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { openProposal, withVerification } from "../src/kernel/governance/proposals/proposal.ts";
import { createPredicateRegistry } from "../src/kernel/governance/verification/registry.ts";
import { verifySubject } from "../src/kernel/governance/verification/verify.ts";
import { createAdmissionService } from "../src/kernel/governance/admission/service.ts";
import { buildAdmissionClaim, createClaimStore, decideSettlement } from "../src/kernel/governance/admission/settlement.ts";
import { createStandingResolver } from "../src/kernel/governance/admission/standing-resolver.ts";

const d = (t) => digestUtf8(t);
const T0 = 1_700_000_000_000;
const RAND = new Uint8Array(10).fill(5);

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

const PRED = {
  id: "diff-complete",
  version: "1",
  appliesTo: ["content"],
  proves: "diff complete",
  async evaluate() {
    return { passed: true, detail: "ok" };
  },
};

function subjectFixture() {
  return buildProposalSubjectFromOperation({
    vaultId: "v",
    noteId: "n",
    path: "A.md",
    pathSemanticallyRelevant: false,
    base: null,
    proposed: d("proposed"),
    changeClasses: ["content"],
    transformation: { id: "edit", version: "1" },
    predicates: [{ id: "diff-complete", version: "1" }],
    producingOperation: { id: "op", action: "note.write", actionVersion: 1 },
    observations: [{ id: "o", level: "evidence", digest: d("seen"), payloadAvailable: true }],
    sessionId: "s",
    mandateId: null,
  });
}

// ── the settlement decision table ────────────────────────────────────────────

describe("settlement decisions — the two asymmetric rules", () => {
  const claim = buildAdmissionClaim({
    subjectDigest: d("x"),
    proposalId: "p-1",
    gestureRef: "g",
    verification: [],
    expectedStanding: null,
    now: T0,
    rand: RAND,
  });

  test("claim without ref advance → retriable, never discarded, never auto-authoritative", () => {
    const dec = decideSettlement({ claim, refReflectsClaim: false, refWithoutClaim: false });
    assert.equal(dec.kind, "retry-ref-advance");
  });

  test("ref without readable claim → critical health failure, never presented as standing", () => {
    const dec = decideSettlement({ claim: null, refReflectsClaim: false, refWithoutClaim: true });
    assert.equal(dec.kind, "critical-health-failure");
    assert.match(dec.detail, /never rebuild the claim from the ref/);
  });

  test("agreement is settled; absence of both is settled", () => {
    assert.equal(decideSettlement({ claim, refReflectsClaim: true, refWithoutClaim: false }).kind, "settled");
    assert.equal(decideSettlement({ claim: null, refReflectsClaim: false, refWithoutClaim: false }).kind, "settled");
  });

  test("no decision kind can assert an admission happened — the enum is the guarantee", () => {
    const kinds = new Set(["settled", "retry-ref-advance", "critical-health-failure"]);
    for (const c of [claim, null]) {
      for (const reflects of [true, false]) {
        for (const orphanRef of [true, false]) {
          assert.ok(kinds.has(decideSettlement({ claim: c, refReflectsClaim: reflects, refWithoutClaim: orphanRef }).kind));
        }
      }
    }
  });
});

// ── crash windows through the real service ───────────────────────────────────

describe("admission crash windows — claim always lands before the ref moves", () => {
  async function readyRequest() {
    const registry = createPredicateRegistry();
    registry.register(PRED);
    const subject = subjectFixture();
    const proposal = withVerification(openProposal({ subject, sessionId: "s" }, T0, RAND), "passed");
    const outcome = await verifySubject(registry, subject, {}, T0);
    return { proposal, subject, verification: outcome.records, authority: { kind: "human-gesture", gestureRef: "g" } };
  }

  test("crash BETWEEN claim and ref: the claim is durable and unattached; recovery says retry", async () => {
    const claims = createClaimStore(memoryIo());
    let standing = null;
    const service = createAdmissionService({
      claims,
      standingAdvance: async () => {
        throw new Error("simulated crash before the ref moved");
      },
      currentStanding: async () => standing,
      recordSettlement: async () => assert.fail("settlement must not be recorded when the ref never moved"),
      now: () => T0,
    });
    await assert.rejects(() => readyRequest().then((r) => service.admit(r)), /simulated crash/);

    const all = await claims.all();
    assert.equal(all.length, 1, "the claim landed before the crash");
    const dec = decideSettlement({ claim: all[0], refReflectsClaim: false, refWithoutClaim: false });
    assert.equal(dec.kind, "retry-ref-advance", "recovery treats it as safely retriable");
    assert.equal(standing, null, "authority never moved");
  });

  test("crash BETWEEN ref and settlement record: the admission stands; recovery completes the record", async () => {
    const claims = createClaimStore(memoryIo());
    let standing = null;
    const service = createAdmissionService({
      claims,
      standingAdvance: async (expected, next) => {
        assert.equal(standing, expected);
        standing = next;
      },
      currentStanding: async () => standing,
      recordSettlement: async () => {
        throw new Error("simulated crash after the ref moved");
      },
      now: () => T0,
    });
    // The admission itself FAILS loudly (the caller must know settlement is
    // incomplete) — but the authority transition has happened and holds.
    await assert.rejects(() => readyRequest().then((r) => service.admit(r)), /after the ref moved/);
    const all = await claims.all();
    assert.equal(all.length, 1);
    assert.equal(standing, all[0].id, "the ref reflects the claim");
    assert.equal(decideSettlement({ claim: all[0], refReflectsClaim: true, refWithoutClaim: false }).kind, "settled");
  });

  test("a projection failure costs nothing — rebuildable by definition", async () => {
    const claims = createClaimStore(memoryIo());
    let standing = null;
    const service = createAdmissionService({
      claims,
      standingAdvance: async (_e, next) => void (standing = next),
      currentStanding: async () => standing,
      recordSettlement: async () => {},
      refreshProjections: async () => {
        throw new Error("pane exploded");
      },
      now: () => T0,
    });
    const { claim } = await service.admit(await readyRequest());
    assert.equal(standing, claim.id, "the admission completed despite the projection failure");
  });
});

// ── the resolver refuses to present the critical failure as standing ─────────

describe("standing resolver — a ref naming a missing claim is unresolvable, not empty", () => {
  test("forSubject answers unresolvable; current() throws rather than returning null", async () => {
    const claims = createClaimStore(memoryIo());
    const resolver = createStandingResolver({ claims, currentStanding: async () => "ghost-claim-id" });
    const answer = await resolver.forSubject(d("anything").value);
    assert.equal(answer.state, "unresolvable");
    assert.match(answer.detail, /critical health failure/);
    await assert.rejects(() => resolver.current(), /critical health failure/);
  });

  test("claim-store garbage does not corrupt neighbors", async () => {
    const io = memoryIo();
    const claims = createClaimStore(io);
    const claim = buildAdmissionClaim({ subjectDigest: d("x"), proposalId: "p", gestureRef: "g", verification: [], expectedStanding: null, now: T0, rand: RAND });
    await claims.append(claim);
    io.lines.push("{corrupt json");
    const rebooted = createClaimStore(io);
    assert.equal((await rebooted.all()).length, 1, "the readable claim survives the corrupt tail");
  });
});
