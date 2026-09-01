/**
 * governance-settlement.test.mjs — WP6, admission crash windows (§10).
 *
 * The claim is written before the standing ref is ever asked to move, so a
 * crash between the two leaves durable, unattached evidence rather than a
 * ref naming something that doesn't exist. Every test here is one crash
 * window through the real admission service and claim store.
 *
 * (This file used to also cover a crash-recovery decision function/type and
 * a companion chain-walking resolver — both removed dead in #379, no caller
 * outside their own tests. That coverage went with them; see the commit
 * that made this removal for why it was safe.)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { digestUtf8 } from "@vault-mcp/core";
import { buildProposalSubjectFromOperation } from "../src/governor/kernel/proposals/proposal-builder.ts";
import { openProposal, withVerification } from "../src/governor/kernel/proposals/proposal.ts";
import { createPredicateRegistry } from "../src/governor/kernel/verification/registry.ts";
import { verifySubject } from "../src/governor/kernel/verification/verify.ts";
import { createAdmissionService } from "../src/governor/kernel/admission/service.ts";
import { buildAdmissionClaim, createClaimStore } from "../src/governor/kernel/admission/settlement.ts";

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

// ── crash windows through the real service ───────────────────────────────────

describe("admission crash windows — claim always lands before the ref moves", () => {
  const registry = createPredicateRegistry();
  registry.register(PRED);
  const verify = (subject) => verifySubject(registry, subject, {}, T0);

  async function readyRequest() {
    const subject = subjectFixture();
    const proposal = withVerification(openProposal({ subject, sessionId: "s" }, T0, RAND), "passed");
    return { proposal, subject, authority: { kind: "human-gesture", gestureRef: "g" } };
  }

  test("crash BETWEEN claim and ref: the claim is durable and unattached; authority never moves", async () => {
    const claims = createClaimStore(memoryIo());
    let standing = null;
    const service = createAdmissionService({
      claims,
      standingAdvance: async () => {
        throw new Error("simulated crash before the ref moved");
      },
      verify,
      currentStanding: async () => standing,
      recordSettlement: async () => assert.fail("settlement must not be recorded when the ref never moved"),
      now: () => T0,
    });
    await assert.rejects(() => readyRequest().then((r) => service.admit(r)), /simulated crash/);

    const all = await claims.all();
    assert.equal(all.length, 1, "the claim landed before the crash");
    assert.equal(standing, null, "authority never moved");
  });

  test("crash BETWEEN ref and settlement record: the admission stands despite the recording failure", async () => {
    const claims = createClaimStore(memoryIo());
    let standing = null;
    const service = createAdmissionService({
      claims,
      standingAdvance: async (expected, next) => {
        assert.equal(standing, expected);
        standing = next;
      },
      verify,
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
  });

  test("a projection failure costs nothing — rebuildable by definition", async () => {
    const claims = createClaimStore(memoryIo());
    let standing = null;
    const service = createAdmissionService({
      claims,
      standingAdvance: async (_e, next) => void (standing = next),
      verify,
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

// ── claim store durability ────────────────────────────────────────────────────

describe("claim store — a corrupt tail does not corrupt neighbors", () => {
  test("claim-store garbage does not corrupt neighbors", async () => {
    const io = memoryIo();
    const claims = createClaimStore(io);
    const claim = buildAdmissionClaim({ subjectDigest: d("x"), proposalId: "p", authority: { kind: "human-gesture", gestureRef: "g" }, verification: [], expectedStanding: null, coveredNotes: [{ vaultId: "v", noteId: "n", subjectDigest: d("x").value }], now: T0, rand: RAND });
    await claims.append(claim);
    io.lines.push("{corrupt json");
    const rebooted = createClaimStore(io);
    assert.equal((await rebooted.all()).length, 1, "the readable claim survives the corrupt tail");
  });
});
