/**
 * governance-store-binding.test.mjs — the cutover marker ↔ store binding.
 *
 * The invariant under test (store-binding.ts): anything that travels with
 * the vault cannot prove which machine is authoritative. The marker carries
 * the id of the machine-local store it authorizes; a machine without that id
 * says "cut over elsewhere; chain absent here" — never a silent "nothing
 * admitted". The id is minted ONLY inside gestured acts; an unbound marker
 * is NEVER auto-adopted (both rejected designs have their graves pinned
 * here). Every leg calls the real functions (#342's rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { bindingVerdict, mintStoreIdGestured } from "../src/governor/kernel/migration/store-binding.ts";
import { performCutover, bindMarker, rollbackCutover, CutoverRefusedError, CUTOVER_DEFAULT } from "../src/governor/kernel/migration/cutover.ts";
import { buildMigration } from "../src/governor/wiring/migration-wiring.ts";
import { buildAdmission } from "../src/governor/wiring/admission-wiring.ts";

const T0 = 1_900_000_000_000;
const REPORT = { baselines: 1, acceptanceEvents: { total: 1, humanAccepts: 1, silentAdvances: 0, autoAccepts: 0, reverts: 0, rekeys: 0, dispositions: 0, unknown: 0 }, pendingIndex: false, unparseableLines: 0, totalRecords: 2 };

function memoryCutoverStore(initial = null) {
  let stored = initial;
  return { read: async () => stored ?? CUTOVER_DEFAULT, write: async (s) => void (stored = s), peek: () => stored };
}

function memoryStoreIdIo(initial = null) {
  let id = initial;
  let writes = 0;
  return { read: async () => id, write: async (v) => { id = v; writes++; }, writes: () => writes, peek: () => id };
}

describe("the verdict — pure, read-only, four honest states", () => {
  test("pre-cutover / bound / marker-unbound / store-mismatch, each with the right voice", () => {
    assert.deepEqual(bindingVerdict(CUTOVER_DEFAULT, null), { state: "pre-cutover" });
    assert.deepEqual(bindingVerdict(CUTOVER_DEFAULT, "s-1"), { state: "pre-cutover" }, "a local id without a cutover binds nothing");

    const bound = { ...CUTOVER_DEFAULT, cutOver: true, storeId: "s-1" };
    assert.deepEqual(bindingVerdict(bound, "s-1"), { state: "bound", storeId: "s-1" });

    const unbound = { ...CUTOVER_DEFAULT, cutOver: true, storeId: null };
    const u = bindingVerdict(unbound, null);
    assert.equal(u.state, "marker-unbound");
    assert.match(u.detail, /never adopted automatically/, "the rejected auto-adoption stays rejected, in the user-facing text");

    // THE RESTORE CASE: marker names a store, machine has none (vault
    // restored without its chain) — the disaster-recovery lie now speaks.
    const m1 = bindingVerdict(bound, null);
    assert.equal(m1.state, "store-mismatch");
    assert.equal(m1.localStoreId, null);
    assert.match(m1.detail, /cut over elsewhere; chain absent here/);
    assert.match(m1.detail, /NOT evidence that nothing was admitted/);

    // The synced-replica case: a different local id.
    const m2 = bindingVerdict(bound, "s-OTHER");
    assert.equal(m2.state, "store-mismatch");
    assert.equal(m2.localStoreId, "s-OTHER");
  });
});

describe("minting is gestured-only; reads never write", () => {
  test("mintStoreIdGestured refuses without a gesture; mints once; returns the existing id thereafter", async () => {
    const io = memoryStoreIdIo();
    await assert.rejects(() => mintStoreIdGestured(io, "", () => "s-new"), (e) => e instanceof CutoverRefusedError && e.code === "authority_missing");
    assert.equal(io.writes(), 0, "a refused mint wrote nothing");
    assert.equal(await mintStoreIdGestured(io, "g-1", () => "s-new"), "s-new");
    assert.equal(await mintStoreIdGestured(io, "g-2", () => "s-DIFFERENT"), "s-new", "an existing id is never re-minted");
    assert.equal(io.writes(), 1);
  });

  test("THE REJECTED DESIGNS STAY DEAD: binding() and status() never write — a replica cannot look bound by loading", async () => {
    // A migration whose marker is cut-over-unbound (Nelson's pre-binding
    // shape) with a spying store-id io: every read path must leave both the
    // marker and the id untouched. If anyone re-adds auto-adoption or a
    // lazy mint, this test is the tripwire.
    const files = new Map([["gov/cutover.json", JSON.stringify({ ...CUTOVER_DEFAULT, cutOver: true, at: T0, gestureRef: "g-orig", importReport: REPORT, rolledBackAt: null })]]);
    let markerWrites = 0;
    const io = {
      exists: async (p) => files.has(p),
      read: async (p) => files.get(p),
      write: async (p, d) => { if (p === "gov/cutover.json") markerWrites++; files.set(p, d); },
      append: async (p, d) => void files.set(p, (files.get(p) ?? "") + d),
      mkdir: async () => {},
    };
    const storeIdIo = memoryStoreIdIo();
    const migration = buildMigration({
      io,
      paths: { govDir: "gov", acceptanceLog: "gov/a.jsonl", pendingIndex: "gov/p.json", baselinesDir: "gov/b", legacyEvidence: "gov/e.jsonl", cutoverState: "gov/cutover.json" },
      baselines: () => [],
      now: () => T0,
      storeIdIo,
      mintId: () => "s-minted",
    });
    await migration.loadState();
    const v = await migration.binding();
    assert.equal(v.state, "marker-unbound");
    await migration.status();
    await migration.binding();
    assert.equal(storeIdIo.writes(), 0, "no read path minted an id");
    assert.equal(markerWrites, 0, "no read path wrote the marker — auto-adoption stays dead");

    // And the ONE gestured act resolves it.
    const bound = await migration.bindChain("g-bind");
    assert.equal(bound.storeId, "s-minted");
    assert.equal(storeIdIo.writes(), 1);
    assert.equal((await migration.binding()).state, "bound");
  });
});

describe("the kernel acts", () => {
  test("performCutover requires and stamps the storeId; bindMarker resolves ONLY the unbound case", async () => {
    const store = memoryCutoverStore();
    await assert.rejects(() => performCutover(store, "g-1", REPORT, "", T0), (e) => e instanceof CutoverRefusedError && e.code === "store_unbound");
    const state = await performCutover(store, "g-1", REPORT, "s-1", T0);
    assert.equal(state.storeId, "s-1", "a binding-era cutover is born bound");

    // bindMarker on a BOUND marker: same store → already_bound; different →
    // bound_elsewhere (re-binding authority is deliberately not this act).
    await assert.rejects(() => bindMarker(store, "g-2", "s-1", T0), (e) => e.code === "already_bound");
    await assert.rejects(() => bindMarker(store, "g-2", "s-OTHER", T0), (e) => e.code === "bound_elsewhere");

    // The pre-binding marker path.
    const legacy = memoryCutoverStore({ ...CUTOVER_DEFAULT, cutOver: true, at: T0, gestureRef: "g-orig", importReport: REPORT, rolledBackAt: null });
    await assert.rejects(() => bindMarker(legacy, "", "s-1", T0), (e) => e.code === "authority_missing");
    const boundLegacy = await bindMarker(legacy, "g-bind", "s-1", T0);
    assert.equal(boundLegacy.storeId, "s-1");
    assert.equal(boundLegacy.gestureRef, "g-orig", "the original cutover gesture survives; the bind adds identity, not history rewrite");

    // No marker → nothing to bind.
    await assert.rejects(() => bindMarker(memoryCutoverStore(), "g", "s-1", T0), (e) => e.code === "not_cut_over");
  });

  test("rollback carries the binding forward as history", async () => {
    const store = memoryCutoverStore();
    await performCutover(store, "g-1", REPORT, "s-1", T0);
    const back = await rollbackCutover(store, "g-r", T0 + 1);
    assert.equal(back.storeId, "s-1", "the identity the marker once authorized is preserved on the rolled-back record");
  });
});

describe("the admission binding gate — a mismatched machine cannot grow a second chain", () => {
  function gatedAdmission(gateResult) {
    // A minimal buildAdmission whose bindingGate returns the given verdict;
    // the gate must refuse BEFORE any store/proposal work, so the stub deps
    // throw if reached.
    const boom = () => { throw new Error("must not be reached when the gate refuses"); };
    return buildAdmission({
      repo: async () => { throw new Error("repo must not be opened by a gate refusal"); },
      claimIo: { appendLine: boom, readLines: async () => [] },
      proposals: { pending: async () => [], get: boom, setVerification: boom, markAdmitted: boom, supersede: boom, requestRevision: boom, open: boom },
      readNoteBytes: boom,
      writeNoteBytes: boom,
      appendSettlement: boom,
      now: () => T0,
      bindingGate: async () => gateResult,
    });
  }

  test("marker_unbound and store_mismatch refuse both admit paths with the verdict's own detail", async () => {
    for (const [code, detail] of [["marker_unbound", "unbound detail"], ["store_mismatch", "cut over elsewhere; chain absent here"]]) {
      const admission = gatedAdmission({ ok: false, code, detail });
      const solo = await admission.admitWithGesture("prop-1", "g-1");
      assert.equal(solo.ok, false);
      assert.equal(solo.code, code);
      assert.equal(solo.detail, detail);
      const frozen = { subject: { items: [] }, digest: { algorithm: "sha256", value: "x".repeat(64) }, memberProposalIds: [] };
      const cohort = await admission.admitCohortWithGesture(frozen, [], "g-2");
      assert.equal(cohort.ok, false);
      assert.equal(cohort.code, code);
    }
  });

  test("VACUITY: a passing gate reaches the ordinary path (the stub then refuses for its own reasons, proving the gate was not the stop)", async () => {
    const admission = gatedAdmission({ ok: true });
    const outcome = await admission.admitWithGesture("prop-1", "g-1");
    assert.equal(outcome.ok, false);
    assert.notEqual(outcome.code, "marker_unbound");
    assert.notEqual(outcome.code, "store_mismatch");
  });
});

describe("bindChain refuses a corrupt marker — a bind never launders", () => {
  test("unparseable cutover.json → state_corrupt, file untouched, no id minted", async () => {
    const files = new Map([["gov/cutover.json", "{ not json"]]);
    const io = {
      exists: async (p) => files.has(p),
      read: async (p) => files.get(p),
      write: async (p, d) => void files.set(p, d),
      append: async (p, d) => void files.set(p, (files.get(p) ?? "") + d),
      mkdir: async () => {},
    };
    const storeIdIo = (() => { let id = null, w = 0; return { read: async () => id, write: async (v) => { id = v; w++; }, writes: () => w }; })();
    const migration = buildMigration({
      io,
      paths: { govDir: "gov", acceptanceLog: "gov/a.jsonl", pendingIndex: "gov/p.json", baselinesDir: "gov/b", legacyEvidence: "gov/e.jsonl", cutoverState: "gov/cutover.json" },
      baselines: () => [],
      now: () => T0,
      storeIdIo,
      mintId: () => "s-x",
    });
    await migration.loadState();
    await assert.rejects(() => migration.bindChain("g-1"), (e) => e instanceof CutoverRefusedError && e.code === "state_corrupt");
    assert.equal(files.get("gov/cutover.json"), "{ not json", "the unparseable file survives byte-identical for the human");
    assert.equal(storeIdIo.writes(), 0, "no identity was minted on the refused path");
  });
});
