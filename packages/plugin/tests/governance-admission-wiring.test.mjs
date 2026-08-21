/**
 * governance-admission-wiring.test.mjs — WP6b-2: the admission wiring, end to
 * end against the REAL history repository.
 *
 * The full §9 path, headless: a produced proposal (snapshots on its recording
 * ref) → click-time re-observation → the service's own verification run over
 * evidence Governor resolves (base bytes replayed from the recording; proposed
 * bytes from the "vault") → standing advanced as an admission COMMIT the ref
 * CASes onto. Plus §15's required attack family: synthetic clicks and
 * captured callbacks remain unable to admit — mutation-style, not prose.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAdmission, readFileFromTree, mintGestureRef } from "../src/governance/admission-wiring.ts";
import { openGitRepository } from "../src/governance/history-store/git-repository.ts";
import { proposalRef, standingRef } from "../src/kernel/governance/history-store/refs.ts";
import { createProposalStore } from "../src/kernel/governance/proposals/proposal-store.ts";
import { openProposal } from "../src/kernel/governance/proposals/proposal.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { digestBytes } from "../src/kernel/governance/contracts/digest.ts";
import { runGuardedDisposition } from "../src/kernel/governance/gesture.ts";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const T0 = 1_700_000_000_000;

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

/** A full harness: real git repo, real stores, a fake vault, produced proposal. */
async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-admission-"));
  const repo = await openGitRepository({ gitdir: path.join(root, "gitdir"), worktree: path.join(root, "vault") });

  const vault = new Map(); // path → string
  const proposals = createProposalStore(memoryIo());
  const settlements = [];
  let settlementFails = false;

  const admission = buildAdmission({
    repo: async () => repo,
    claimIo: memoryIo(),
    proposals,
    readNoteBytes: async (p) => (vault.has(p) ? enc(vault.get(p)) : null),
    writeNoteBytes: async (p, bytes) => void vault.set(p, dec(bytes)),
    appendSettlement: async (r) => {
      if (settlementFails) throw new Error("settlement disk on fire");
      settlements.push(r);
    },
    now: () => T0,
  });

  /** Produce a proposal the way WP6b-1's producer does: snapshots then open. */
  let produceSeq = 0;
  async function produce(notePath, baseText, proposedText) {
    produceSeq++;
    if (baseText !== null) vault.set(notePath, baseText);
    vault.set(notePath, proposedText); // the write has landed (D11: visible working tree)
    const subject = buildProposalSubjectFromOperation({
      vaultId: "vault-1",
      noteId: `path:${notePath}`,
      path: notePath,
      pathSemanticallyRelevant: false,
      base: baseText === null ? null : digestBytes(enc(baseText)),
      proposed: digestBytes(enc(proposedText)),
      changeClasses: ["content"],
      transformation: { id: "note.write", version: "1" },
      predicates: [{ id: "content-diff", version: "1" }],
      producingOperation: { id: `op-${notePath}`, action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "sess-1",
      mandateId: null,
    });
    // Distinct mint instant per produce: identical (now, rand) pairs mint
    // identical UUIDv7s — a property of injection, not of proposals.
    const proposal = openProposal({ subject, sessionId: "sess-1" }, T0 + produceSeq, new Uint8Array(10).fill(produceSeq));
    const ref = proposalRef(proposal.id);
    const base = await repo.recordSnapshot({
      ref,
      files: [{ path: notePath, bytes: baseText === null ? null : enc(baseText) }],
      message: `base for proposal ${proposal.id}`,
      timestamp: 1,
      expectedRef: null,
    });
    await repo.recordSnapshot({
      ref,
      files: [{ path: notePath, bytes: enc(proposedText) }],
      message: `proposed for proposal ${proposal.id}`,
      timestamp: 2,
      expectedRef: base.oid,
    });
    await proposals.open({ ...proposal, recordingRef: ref }, T0);
    return proposal;
  }

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { repo, vault, proposals, settlements, admission, produce, cleanup, setSettlementFails: (v) => (settlementFails = v) };
}

describe("admission wiring — the full path against the real repository", () => {
  let h;
  before(async () => {
    h = await harness();
  });
  after(() => h.cleanup());

  test("a produced proposal admits: verification runs on replayed base + current bytes, standing becomes a commit", async () => {
    const proposal = await h.produce("Notes/A.md", "base text\n", "proposed text\n");
    const outcome = await h.admission.admitWithGesture(proposal.id, mintGestureRef(T0));
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.degraded, false);

    // The receipt names subject, predicate, verifier, coverage (never-say rules).
    assert.equal(outcome.receipt.subjectDigest, proposal.subjectDigest.value);
    assert.deepEqual(outcome.receipt.predicates, ["content-diff@1"]);
    assert.match(outcome.receipt.verifier, /content-diff@1/);
    assert.equal(outcome.receipt.coverage, "exact-and-total");

    // Standing is a REAL commit the ref names, whose message carries the claim
    // id and whose tree carries the claim JSON — readable by stock git.
    const oid = await h.repo.resolveRef(standingRef());
    const commit = await h.repo.readCommit(oid);
    assert.match(commit.message, new RegExp(`^admission ${outcome.claimId}`));
    const claimBytes = await readFileFromTree(h.repo, commit.tree, "claim.json");
    assert.equal(JSON.parse(dec(claimBytes)).id, outcome.claimId);

    // Settlement recorded; projection store caught up.
    assert.equal(h.settlements.length, 1);
    assert.equal((await h.proposals.get(proposal.id)).authority, "admitted");
  });

  test("an edit between proposal and click ABORTS with subject_drift — nothing admits, nothing advances", async () => {
    const proposal = await h.produce("Notes/B.md", "base\n", "proposed\n");
    h.vault.set("Notes/B.md", "EDITED AFTER THE PROPOSAL\n");
    const before = await h.repo.resolveRef(standingRef());
    const outcome = await h.admission.admitWithGesture(proposal.id, mintGestureRef(T0));
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "subject_drift");
    assert.equal(await h.repo.resolveRef(standingRef()), before, "standing untouched");
    assert.equal((await h.proposals.get(proposal.id)).authority, "proposed", "remains proposed — fail closed");
  });

  test("a deleted note refuses: a disappearance is a fact, the proposal stays proposed (D06)", async () => {
    const proposal = await h.produce("Notes/C.md", "base\n", "proposed\n");
    h.vault.delete("Notes/C.md");
    const outcome = await h.admission.admitWithGesture(proposal.id, mintGestureRef(T0));
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "note_missing");
  });

  test("a creation admits with base null — the recording's empty base is the discriminator, not a guess", async () => {
    const proposal = await h.produce("Notes/New.md", null, "brand new\n");
    const outcome = await h.admission.admitWithGesture(proposal.id, mintGestureRef(T0));
    assert.ok(outcome.ok, JSON.stringify(outcome));
  });

  test("a second admission chains on the first — supersession through one CAS chain of commits", async () => {
    const p1 = await h.produce("Notes/Chain.md", "v0\n", "v1\n");
    const first = await h.admission.admitWithGesture(p1.id, mintGestureRef(T0));
    assert.ok(first.ok);
    const p2 = await h.produce("Notes/Chain.md", "v1\n", "v2\n");
    const second = await h.admission.admitWithGesture(p2.id, mintGestureRef(T0));
    assert.ok(second.ok, JSON.stringify(second));
    const head = await h.repo.readCommit(await h.repo.resolveRef(standingRef()));
    assert.match(head.message, new RegExp(`^admission ${second.claimId}`));
    assert.equal(head.parents.length, 1, "chained on the prior standing commit");
  });

  test("DEGRADED: a settlement-append failure after the CAS leaves the admission STANDING and says so", async () => {
    const proposal = await h.produce("Notes/Degraded.md", "base\n", "proposed\n");
    h.setSettlementFails(true);
    const outcome = await h.admission.admitWithGesture(proposal.id, mintGestureRef(T0));
    h.setSettlementFails(false);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.degraded, true, "the receipt SAYS the record is catching up — never a silent gap, never a lie that it failed");
    const head = await h.repo.readCommit(await h.repo.resolveRef(standingRef()));
    assert.match(head.message, new RegExp(`^admission ${outcome.claimId}`));
  });

  test("revert writes the recorded base back as a NEW change and supersedes the proposal", async () => {
    const proposal = await h.produce("Notes/Revert.md", "the base\n", "the proposal\n");
    const outcome = await h.admission.revertToBase(proposal.id, mintGestureRef(T0));
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(h.vault.get("Notes/Revert.md"), "the base\n", "the base bytes are back");
    assert.equal((await h.proposals.get(proposal.id)).authority, "superseded");
    // The rejected result is PRESERVED in the recording — new history, no rewrite.
    const chain = await h.repo.log(proposal.recordingRef ?? proposalRef(proposal.id), 10);
    const proposedCommit = chain[0];
    const preserved = await readFileFromTree(h.repo, proposedCommit.tree, "Notes/Revert.md");
    assert.equal(dec(preserved), "the proposal\n");
  });
});

// ── §15: the required authority-perimeter attack family ──────────────────────

describe("§15 — synthetic clicks and captured callbacks remain unable to admit", () => {
  test("a synthetic (untrusted) event stops at the FIRST gate: the confirm modal never opens, admit never runs", async () => {
    let confirmOpened = false;
    let admitted = false;
    const outcome = await runGuardedDisposition(
      { isTrusted: false, type: "click" }, // a synthesized event — exactly what dispatchEvent produces
      async () => {
        confirmOpened = true;
        return true;
      },
      async () => {
        admitted = true;
      }
    );
    assert.equal(outcome, "blocked-untrusted");
    assert.equal(confirmOpened, false, "the modal never even opened");
    assert.equal(admitted, false);
  });

  test("a captured-callback replay with a forged plain object cannot admit", async () => {
    // The 0.15.2-era attack shape: renderer JS captures a handler and invokes
    // it with whatever it likes. The handler's first act is the shared gate,
    // and a plain object is not a trusted Event.
    let admitted = false;
    for (const forged of [{}, { isTrusted: true }, null, undefined, "click"]) {
      const outcome = await runGuardedDisposition(forged, null, async () => {
        admitted = true;
      });
      assert.equal(outcome, "blocked-untrusted", `forged ${JSON.stringify(forged)} must not pass`);
    }
    assert.equal(admitted, false);
  });

  test("the pane wires Admit through the shared gate — pinned at the source", async () => {
    const fsm = await import("node:fs");
    const raw = fsm.readFileSync(new URL("../src/governance/pane.ts", import.meta.url), "utf8");
    const lines = raw.split("\n");
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (/admitBtn\.addEventListener\(/.test(lines[i])) {
        assert.match(lines.slice(i, i + 5).join("\n"), /runGuardedDisposition/, "Admit routes through THE shared gesture gate");
        found = true;
      }
    }
    assert.ok(found, "the Admit button exists and is addEventListener-wired");
    assert.match(raw, /mintGestureRef\(Date\.now\(\)\)/, "the gesture ref is minted INSIDE the click handler");
  });

  test("this scan can find something — the vacuity self-check", async () => {
    const fsm = await import("node:fs");
    const raw = fsm.readFileSync(new URL("../src/governance/pane.ts", import.meta.url), "utf8");
    assert.ok(/admitBtn\.addEventListener\(/.test(raw), "the pattern matches the real wiring site");
  });
});

// ── the fail-closed row, declared where a reader looks ───────────────────────

describe("the declared fail direction", () => {
  test("admission-wiring.ts declares its threat-model row at the top of the file", async () => {
    const fsm = await import("node:fs");
    const raw = fsm.readFileSync(new URL("../src/governance/admission-wiring.ts", import.meta.url), "utf8");
    assert.match(raw, /FAIL CLOSED/, "the row is declared");
    assert.match(raw, /REMAINS PROPOSED/, "with the outcome named");
    assert.match(raw, /degraded/i, "and the one deliberate exception documented");
  });
});
