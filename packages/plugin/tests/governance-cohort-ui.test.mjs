/**
 * governance-cohort-ui.test.mjs — WP7b: the cohort gesture, end to end.
 *
 * One gesture, one claim covering N subjects, one CAS — against the REAL
 * history repository. The properties: the frozen digest is RECOMPUTED at
 * decision time (tampering refuses); any drifted member aborts WHOLE with
 * the items named; coverage is the service's own run; the claim's
 * coveredNotes are DERIVED from the manifest (pinned equal); the resolver
 * answers per member off the real chain; split-by-finding stages a
 * successor that is its own decision; and §15's family binds the cohort
 * gesture identically.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAdmission } from "../src/governance/admission-wiring.ts";
import { openGitRepository } from "../src/governance/history-store/git-repository.ts";
import { proposalRef, standingRef } from "../src/kernel/governance/history-store/refs.ts";
import { createProposalStore } from "../src/kernel/governance/proposals/proposal-store.ts";
import { openProposal } from "../src/kernel/governance/proposals/proposal.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { subjectDigest } from "../src/kernel/governance/contracts/subject-v1.ts";
import { digestBytes } from "../src/kernel/governance/contracts/digest.ts";
import { createStandingResolver } from "../src/kernel/governance/admission/standing-resolver.ts";
import { createClaimStore } from "../src/kernel/governance/admission/settlement.ts";
import { runGuardedDisposition } from "../src/kernel/governance/gesture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);
const T0 = 1_700_000_000_000;

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-cohort-ui-"));
  const repo = await openGitRepository({ gitdir: path.join(root, "gitdir"), worktree: path.join(root, "vault") });
  const vault = new Map();
  const proposals = createProposalStore(memoryIo());
  const claimIo = memoryIo();
  const admission = buildAdmission({
    repo: async () => repo,
    claimIo,
    proposals,
    readNoteBytes: async (p) => (vault.has(p) ? enc(vault.get(p)) : null),
    writeNoteBytes: async (p, bytes) => void vault.set(p, new TextDecoder().decode(bytes)),
    appendSettlement: async () => {},
    now: () => T0,
  });
  let seq = 0;
  const noteIds = new Map(); // path → stable noteId: re-producing a note keeps its IDENTITY
  async function produce(notePath, baseText, proposedText) {
    seq++;
    if (!noteIds.has(notePath)) noteIds.set(notePath, `uid-${String(noteIds.size + 1).padStart(3, "0")}`);
    if (baseText !== null) vault.set(notePath, baseText);
    vault.set(notePath, proposedText);
    const subject = buildProposalSubjectFromOperation({
      vaultId: "vault-1",
      noteId: noteIds.get(notePath),
      path: notePath,
      pathSemanticallyRelevant: false,
      base: baseText === null ? null : digestBytes(enc(baseText)),
      proposed: digestBytes(enc(proposedText)),
      changeClasses: ["content"],
      transformation: { id: "note.write", version: "1" },
      predicates: [{ id: "content-diff", version: "1" }],
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
  return { repo, vault, proposals, claimIo, admission, produce, cleanup };
}

describe("the cohort gesture — one claim covering N, against the real repository", () => {
  let h;
  before(async () => {
    h = await harness();
  });
  after(() => h.cleanup());

  test("freeze the selection, admit under ONE gesture, resolve every member off the real chain", async () => {
    for (let i = 0; i < 5; i++) await h.produce(`Notes/batch-${i}.md`, `old ${i}\n`, `new ${i}\n`);
    const sel = await h.admission.freezeSelection({ folder: "Notes" }, "item");
    assert.ok(sel.ok, sel.reason);
    assert.equal(sel.frozen.subject.items.length, 5);

    const outcome = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-cohort-1");
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.receipt.memberCount, 5);
    assert.equal(outcome.receipt.subjectDigest, sel.frozen.digest.value, "the claim covers the FROZEN digest");

    // ONE claim, coveredNotes derived equal to the manifest — pinned.
    const claims = createClaimStore(h.claimIo);
    const all = await claims.all();
    assert.equal(all.length, 1);
    assert.deepEqual(
      all[0].coveredNotes.map((n) => `${n.noteId}:${n.subjectDigest}`).sort(),
      sel.frozen.subject.items.map((i) => `${i.noteId}:${subjectDigest(i).value}`).sort(),
      "coveredNotes IS the manifest, derived, never supplied"
    );

    // The resolver answers per member off the real standing chain.
    const chain = async () => {
      const oids = await h.repo.log(standingRef(), 100);
      return oids.map((c) => /^admission ([0-9a-f-]+)/.exec(c.message + "\n")[1]);
    };
    const resolver = createStandingResolver({ claims, standingChain: chain });
    for (const item of sel.frozen.subject.items) {
      const answer = await resolver.forSubject(subjectDigest(item).value);
      assert.equal(answer.state, "admitted", `${item.noteId} stands`);
      assert.equal(answer.claim.id, outcome.claimId);
    }
    // Projections caught up.
    for (const m of sel.members) {
      assert.equal((await h.proposals.get(m.id)).authority, "admitted");
    }
  });

  test("ONE drifted member aborts the WHOLE decision, named — nothing advances", async () => {
    const a = await h.produce("Drift/a.md", "base-a\n", "prop-a\n");
    const b = await h.produce("Drift/b.md", "base-b\n", "prop-b\n");
    const sel = await h.admission.freezeSelection({ folder: "Drift" }, "item");
    assert.ok(sel.ok);
    h.vault.set("Drift/b.md", "EDITED AFTER FREEZE\n");
    const before = await h.repo.resolveRef(standingRef());
    const outcome = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-drift");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "subject_drift");
    assert.deepEqual(outcome.failedNoteIds, [b.subject.noteId], "the drifted member is NAMED");
    assert.equal(await h.repo.resolveRef(standingRef()), before, "standing untouched — whole-abort");
    assert.equal((await h.proposals.get(a.id)).authority, "proposed", "the clean member also remains proposed");
  });

  test("a TAMPERED frozen structure refuses — the digest is recomputed, never trusted", async () => {
    await h.produce("Tamper/a.md", "b\n", "p\n");
    const sel = await h.admission.freezeSelection({ folder: "Tamper" }, "item");
    assert.ok(sel.ok);
    // The structure is deep-frozen; simulate a tampered PRESENTATION instead:
    // a frozen object whose digest field claims something its subject is not.
    const tampered = { subject: sel.frozen.subject, digest: { algorithm: "sha256", value: "f".repeat(64) }, memberProposalIds: sel.frozen.memberProposalIds };
    const outcome = await h.admission.admitCohortWithGesture(tampered, sel.members, "gesture-tamper");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "subject_drift");
  });

  test("split by finding: exclude the failing members into a successor that admits under ITS OWN ref", async () => {
    for (let i = 0; i < 4; i++) await h.produce(`Split/n-${i}.md`, `o ${i}\n`, `p ${i}\n`);
    const sel = await h.admission.freezeSelection({ folder: "Split" }, "item");
    assert.ok(sel.ok);
    // Two members drift.
    h.vault.set("Split/n-1.md", "CHANGED\n");
    h.vault.set("Split/n-3.md", "ALSO CHANGED\n");
    const first = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-split-1");
    assert.ok(!first.ok);
    assert.equal(first.failedNoteIds.length, 2);

    const failedSet = new Set(first.failedNoteIds);
    const excludeIds = sel.frozen.subject.items
      .map((item, i) => (failedSet.has(item.noteId) ? sel.frozen.memberProposalIds[i] : null))
      .filter((x) => x !== null);
    const split = await h.admission.refreezeWithout(sel.frozen, sel.members, excludeIds, "item");
    assert.ok(split.ok, split.reason);
    assert.equal(split.frozen.subject.items.length, 2);
    assert.equal(split.frozen.subject.excludedProposalIds.length, 2, "the exclusions ride the successor's own manifest");
    assert.notEqual(split.frozen.digest.value, sel.frozen.digest.value);

    const second = await h.admission.admitCohortWithGesture(split.frozen, split.members, "gesture-split-2");
    assert.ok(second.ok, JSON.stringify(second));
    assert.equal(second.receipt.memberCount, 2);
    // The excluded remain proposed — their own path, never silently dropped.
    for (const id of excludeIds) {
      assert.equal((await h.proposals.get(id)).authority, "proposed");
    }
  });

  test("re-admitting the SAME cohort refuses already_admitted; a MEMBER re-admitted individually flips alone", async () => {
    const p0 = await h.produce("Chain2/x.md", "v0\n", "v1\n");
    const p1 = await h.produce("Chain2/y.md", "w0\n", "w1\n");
    const sel = await h.admission.freezeSelection({ folder: "Chain2" }, "item");
    assert.ok(sel.ok);
    const first = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "g-1");
    assert.ok(first.ok, JSON.stringify(first));
    const again = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "g-2");
    assert.ok(!again.ok);
    assert.equal(again.code, "already_admitted");

    // Individually re-admit x at new content: only x flips.
    const p2 = await h.produce("Chain2/x.md", "v1\n", "v2\n");
    const solo = await h.admission.admitWithGesture(p2.id, "g-3");
    assert.ok(solo.ok, JSON.stringify(solo));
    const claims = createClaimStore(h.claimIo);
    const chain = async () => (await h.repo.log(standingRef(), 100)).map((c) => /^admission ([0-9a-f-]+)/.exec(c.message + "\n")[1]);
    const resolver = createStandingResolver({ claims, standingChain: chain });
    const xOld = await resolver.forSubject(subjectDigest(sel.frozen.subject.items.find((i) => i.noteId === p0.subject.noteId)).value);
    assert.equal(xOld.state, "superseded", "x's cohort-covered subject is superseded by its solo re-admission");
    const y = await resolver.forSubject(subjectDigest(sel.frozen.subject.items.find((i) => i.noteId === p1.subject.noteId)).value);
    assert.equal(y.state, "admitted", "y stands untouched");
  });
});

// ── §15 on the cohort gesture ────────────────────────────────────────────────

describe("§15 — the cohort gesture is gated identically", () => {
  test("a synthetic event cannot reach freeze-or-admit; forged objects blocked", async () => {
    let reached = false;
    for (const forged of [{ isTrusted: false, type: "click" }, {}, { isTrusted: true }]) {
      const outcome = await runGuardedDisposition(forged, null, async () => {
        reached = true;
      });
      assert.equal(outcome, "blocked-untrusted");
    }
    assert.equal(reached, false);
  });

  test("the pane wires Group & admit AND the successor through the shared gate; one gesture covers one claim — pinned", () => {
    const raw = fs.readFileSync(path.join(HERE, "..", "src", "governance", "pane.ts"), "utf8");
    const lines = raw.split("\n");
    for (const el of ["groupBtn", "sucBtn"]) {
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`${el}\\.addEventListener\\(`).test(lines[i])) {
          assert.match(lines.slice(i, i + 5).join("\n"), /runGuardedDisposition/, `${el} routes through the shared gate`);
          found = true;
        }
      }
      assert.ok(found, `${el} exists and is addEventListener-wired`);
    }
    // The successor is its OWN decision: the split path stages it and never
    // reuses the original gestureRef for a second claim.
    assert.match(raw, /pendingSuccessor/, "the successor is staged, not auto-admitted");
    assert.ok(!/admitCohortWithGesture\(split\.frozen, split\.members, gestureRef\)/.test(raw), "the original ref never covers the successor's claim");
  });

  test("vacuity: the pins match real wiring sites", () => {
    const raw = fs.readFileSync(path.join(HERE, "..", "src", "governance", "pane.ts"), "utf8");
    assert.ok(/groupBtn\.addEventListener\(/.test(raw));
    assert.ok(/sucBtn\.addEventListener\(/.test(raw));
  });
});
