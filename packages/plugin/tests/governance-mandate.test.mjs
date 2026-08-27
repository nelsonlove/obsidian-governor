/**
 * governance-mandate.test.mjs — WP9: mandate drafting, negotiation, lifecycle.
 *
 * The deliverable this file pins (guide §WP9): agent-authored draft and
 * counter-proposal; human gesture activation; immutable terms with amendment
 * by REPLACEMENT; revoke/expire/exhaust/stop; separate mayProduce/mayAdmit;
 * and REPLAY REFUSAL across delegate, session, scope, class, transformation,
 * predicate, expiry, and revocation — each axis its own test leg, each leg a
 * one-field mutation of a baseline that PASSES (so every leg is its own
 * vacuity proof: the axis under test is the only thing that changed).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  activateDraft,
  cloneTerms,
  exhaustMandate,
  expireMandate,
  MandateRefusedError,
  revokeMandate,
  supersedeMandate,
  termsInvalidReason,
} from "../src/governor/kernel/mandates/mandate.ts";
import { declineDraft, markDraftActivated, openDraft, supersedeDraft } from "../src/governor/kernel/mandates/draft.ts";
import { budgetBreach, budgetsInvalidReason, chargeUsage, ZERO_USAGE } from "../src/governor/kernel/mandates/budgets.ts";
import { mandateFitOf, pathWithin } from "../src/governor/kernel/mandates/policy.ts";
import { createMandateStore, foldMandateEvents } from "../src/governor/kernel/mandates/lifecycle.ts";

const T0 = 1_700_000_000_000;
const RAND_A = new Uint8Array(10).fill(1);
const RAND_B = new Uint8Array(10).fill(2);
const RAND_C = new Uint8Array(10).fill(3);

/** A complete, valid delegation — the baseline every refusal leg mutates. */
function terms(over = {}) {
  return {
    purpose: "normalize description carriers in the projects collection",
    delegate: { kind: "session", value: "sess-1" },
    scope: { include: ["Projects"], exclude: ["Projects/Archive"] },
    allowedClasses: ["presentation", "representation"],
    transformation: { id: "carrier-normalize", version: "1" },
    predicates: [{ id: "info-preserved", version: "2" }],
    eligibleActions: [{ id: "note.write", version: "1" }],
    requiredDurability: "replayable",
    budgets: { maxItems: 100, maxBytes: 1_000_000, maxDurationMs: 60 * 60 * 1000, maxProposals: 200, maxFailures: 3 },
    admission: { mayProduce: true, mayAdmit: false },
    recovery: { unit: "cohort" },
    ...over,
  };
}

function draft(over = {}, rand = RAND_A) {
  return openDraft({ authoredBy: { sessionId: "sess-1", client: "claude" }, terms: terms(), ...over }, T0, rand);
}

function activeMandate(termsOver = {}, rand = RAND_B) {
  const d = openDraft({ authoredBy: { sessionId: "sess-1", client: "claude" }, terms: terms(termsOver) }, T0, RAND_A);
  return activateDraft(d, { principal: "nelson", gestureRef: "gesture-act-1" }, T0 + 1000, rand);
}

/** The context that FITS the baseline mandate — every refusal leg mutates one field. */
function fitCtx(over = {}) {
  return {
    delegate: { sessionId: "sess-1", connection: null, role: null },
    notePath: "Projects/alpha.md",
    changeClasses: ["presentation"],
    transformation: { id: "carrier-normalize", version: "1" },
    predicates: [{ id: "info-preserved", version: "2" }],
    action: { id: "note.write", version: "1" },
    durability: "replayable",
    ...over,
  };
}

function memoryIo() {
  const lines = [];
  return {
    lines,
    appendLine: async (l) => void lines.push(l),
    readLines: async () => [...lines],
  };
}

// ── Terms: what counts as a delegation at all ────────────────────────────────

describe("terms validation — unknown targets and open-ended verbs are not delegation", () => {
  test("the baseline is valid; each hollowed axis names its own reason", () => {
    assert.equal(termsInvalidReason(terms()), null);
    const cases = [
      [terms({ purpose: "  " }), /purpose is empty/],
      [terms({ delegate: { kind: "vibe", value: "x" } }), /unknown delegate binding kind/],
      [terms({ delegate: { kind: "session", value: "" } }), /delegate binding value is empty/],
      [terms({ scope: { include: [], exclude: [] } }), /unbounded scope is not delegation/],
      [terms({ scope: { include: ["/abs"], exclude: [] } }), /not a vault-relative path prefix/],
      [terms({ scope: { include: ["a/../b"], exclude: [] } }), /not a vault-relative path prefix/],
      [terms({ allowedClasses: [] }), /authorizes named classes/],
      [terms({ allowedClasses: ["presentation", "chaos"] }), /unknown change class/],
      [terms({ transformation: { id: "", version: "1" } }), /exact id and version/],
      [terms({ predicates: [] }), /names its required verification/],
      [terms({ predicates: [{ id: "p", version: "" }] }), /exact id and version/],
      [terms({ eligibleActions: [] }), /exact registered actions/],
      [terms({ requiredDurability: "ephemeral" }), /must be 'replayable'/],
      [terms({ budgets: { maxItems: 0, maxBytes: 1, maxDurationMs: 1, maxProposals: 1, maxFailures: 0 } }), /must be positive/],
      [terms({ budgets: { maxItems: 1.5, maxBytes: 1, maxDurationMs: 1, maxProposals: 1, maxFailures: 0 } }), /non-negative integer/],
      [terms({ admission: { mayProduce: false, mayAdmit: true } }), /mayAdmit alone is not a grant/],
      [terms({ recovery: { unit: "vault" } }), /unknown recovery unit/],
    ];
    for (const [t, re] of cases) {
      const reason = termsInvalidReason(t);
      assert.notEqual(reason, null, `expected a refusal for ${re}`);
      assert.match(reason, re);
    }
  });

  test("the authority class is never delegable — D02's hard line", () => {
    assert.match(termsInvalidReason(terms({ allowedClasses: ["authority"] })), /never delegable/);
    assert.match(termsInvalidReason(terms({ allowedClasses: ["presentation", "authority"] })), /never delegable/);
  });
});

// ── Drafts: agent-authored, conferring nothing ───────────────────────────────

describe("drafts — candidates, never capability", () => {
  test("openDraft validates terms NOW and deep-copies them (the author keeps no live reference)", () => {
    const t = terms();
    const d = openDraft({ authoredBy: { sessionId: "s", client: "c" }, terms: t }, T0, RAND_A);
    t.scope.include.push("Everything");
    t.allowedClasses.push("authority");
    assert.deepEqual(d.terms.scope.include, ["Projects"], "post-authoring mutation of the input never reaches the draft");
    assert.deepEqual(d.terms.allowedClasses, ["presentation", "representation"]);
    assert.throws(
      () => openDraft({ authoredBy: { sessionId: "s", client: "c" }, terms: terms({ scope: { include: [], exclude: [] } }) }, T0),
      (e) => e instanceof MandateRefusedError && e.code === "terms_invalid"
    );
  });

  test("draft transitions are one-way; decline and supersede are idempotent on settled drafts", () => {
    const d = draft();
    const declined = declineDraft(d, "too broad");
    assert.equal(declined.status, "declined");
    assert.equal(declineDraft(declined, "again").status, "declined");
    assert.equal(supersedeDraft(declined).status, "declined", "supersede does not resurrect or downgrade a settled draft");
    assert.throws(() => markDraftActivated(declined), (e) => e.code === "draft_not_open");
  });
});

// ── Activation: the one human act ────────────────────────────────────────────

describe("activation — a gesture grants; nothing else does", () => {
  test("no gestureRef, no principal, non-open draft: each refuses and mints nothing", () => {
    const d = draft();
    assert.throws(() => activateDraft(d, { principal: "nelson", gestureRef: "" }, T0), (e) => e.code === "authority_missing");
    assert.throws(() => activateDraft(d, { principal: "  ", gestureRef: "gesture-1" }, T0), (e) => e.code === "authority_missing");
    assert.throws(
      () => activateDraft(declineDraft(d, "no"), { principal: "nelson", gestureRef: "gesture-1" }, T0),
      (e) => e.code === "draft_not_open"
    );
  });

  test("activation freezes the terms: expiry computed from the budget, draft mutation after the fact changes nothing", () => {
    const d = draft();
    const m = activateDraft(d, { principal: "nelson", gestureRef: "gesture-1" }, T0 + 5, RAND_B);
    assert.equal(m.status, "active");
    assert.equal(m.principal, "nelson");
    assert.equal(m.gestureRef, "gesture-1");
    assert.equal(m.draftId, d.id);
    assert.equal(m.supersedes, null);
    assert.equal(m.expiresAt, T0 + 5 + d.terms.budgets.maxDurationMs, "expiry is the activation clock plus the duration budget");
    d.terms.scope.include.push("Everything");
    d.terms.eligibleActions.push({ id: "vault.nuke", version: "1" });
    assert.deepEqual(m.terms.scope.include, ["Projects"], "the mandate's terms are a deep copy, not a view of the draft");
    assert.equal(m.terms.eligibleActions.length, 1);
  });

  test("status transitions: revoke sticks, expire needs the clock, exhaust names its breach, supersede retires", () => {
    const m = activeMandate();
    assert.throws(() => expireMandate(m, m.expiresAt - 1), (e) => e instanceof MandateRefusedError);
    assert.equal(expireMandate(m, m.expiresAt).status, "expired");
    const revoked = revokeMandate(m, "changed my mind");
    assert.equal(revoked.status, "revoked");
    assert.equal(revokeMandate(revoked, "again").revokedReason, "changed my mind", "revoked stays revoked with its original reason");
    assert.equal(exhaustMandate(revoked, "items").status, "revoked", "exhaust never downgrades a terminal state");
    const ex = exhaustMandate(m, "item budget reached: 100/100");
    assert.equal(ex.status, "exhausted");
    assert.equal(ex.exhaustedBy, "item budget reached: 100/100");
    assert.equal(supersedeMandate(m).status, "superseded");
  });
});

// ── Budgets ──────────────────────────────────────────────────────────────────

describe("budgets — the arithmetic of bounded", () => {
  test("invalid shapes are named; usage accumulates and never decreases", () => {
    assert.equal(budgetsInvalidReason(terms().budgets), null);
    assert.match(budgetsInvalidReason({ ...terms().budgets, maxFailures: -1 }), /non-negative integer/);
    assert.equal(budgetsInvalidReason({ ...terms().budgets, maxFailures: 0 }), null, "a zero failure budget is a valid (strict) delegation");
    const u = chargeUsage(chargeUsage(ZERO_USAGE, { items: 2, bytes: 100 }), { items: -5, proposals: 1.9 });
    assert.deepEqual(u, { items: 2, bytes: 100, proposals: 1, failures: 0 }, "negative deltas clamp to zero; fractions floor");
  });

  test("each axis breaches at its own boundary: capacity at REACHING, failures at EXCEEDING, duration against the clock", () => {
    const b = { maxItems: 2, maxBytes: 10, maxDurationMs: 1000, maxProposals: 5, maxFailures: 1 };
    assert.equal(budgetBreach(b, ZERO_USAGE, T0, T0), null);
    assert.equal(budgetBreach(b, { ...ZERO_USAGE, items: 1 }, T0, T0), null);
    assert.equal(budgetBreach(b, { ...ZERO_USAGE, items: 2 }, T0, T0)?.axis, "items");
    assert.equal(budgetBreach(b, { ...ZERO_USAGE, bytes: 10 }, T0, T0)?.axis, "bytes");
    assert.equal(budgetBreach(b, { ...ZERO_USAGE, proposals: 5 }, T0, T0)?.axis, "proposals");
    assert.equal(budgetBreach(b, { ...ZERO_USAGE, failures: 1 }, T0, T0), null, "a failure budget of 1 tolerates 1");
    assert.equal(budgetBreach(b, { ...ZERO_USAGE, failures: 2 }, T0, T0)?.axis, "failures");
    assert.equal(budgetBreach(b, ZERO_USAGE, T0, T0 + 999), null);
    assert.equal(budgetBreach(b, ZERO_USAGE, T0, T0 + 1000)?.axis, "duration");
  });
});

// ── THE REPLAY-REFUSAL TABLE (the WP9 deliverable) ───────────────────────────

describe("mandateFitOf — replay refusal across every axis", () => {
  test("the baseline fits — every refusal leg below is a one-field mutation of this passing case", () => {
    assert.deepEqual(mandateFitOf(activeMandate(), ZERO_USAGE, fitCtx(), T0 + 2000), { ok: true });
  });

  test("revocation, supersession, exhaustion, expiry — the mandate's own liveness refuses first", () => {
    const m = activeMandate();
    const at = T0 + 2000;
    assert.equal(mandateFitOf(revokeMandate(m, "distrust"), ZERO_USAGE, fitCtx(), at).code, "mandate_revoked");
    assert.equal(mandateFitOf(supersedeMandate(m), ZERO_USAGE, fitCtx(), at).code, "mandate_superseded");
    assert.equal(mandateFitOf(exhaustMandate(m, "items"), ZERO_USAGE, fitCtx(), at).code, "mandate_exhausted");
    // Expiry needs no writer to have happened: status still says active.
    const expired = mandateFitOf(m, ZERO_USAGE, fitCtx(), m.expiresAt);
    assert.equal(expired.code, "mandate_expired");
    // And a revoked mandate refuses as revoked even for OUT-OF-SCOPE work — the strongest fact wins.
    assert.equal(mandateFitOf(revokeMandate(m, "x"), ZERO_USAGE, fitCtx({ notePath: "Elsewhere/n.md" }), at).code, "mandate_revoked");
  });

  test("delegate and session: the binding names one identity kind and the work must present exactly it", () => {
    const at = T0 + 2000;
    const m = activeMandate();
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ delegate: { sessionId: "sess-OTHER", connection: null, role: null } }), at).code, "delegate_mismatch");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ delegate: { sessionId: null, connection: null, role: null } }), at).code, "delegate_mismatch");
    // A connection-bound mandate ignores the session id entirely — and vice versa.
    const mc = activeMandate({ delegate: { kind: "connection", value: "conn-9" } });
    assert.equal(mandateFitOf(mc, ZERO_USAGE, fitCtx(), at).code, "delegate_mismatch", "a session id does not satisfy a connection binding");
    assert.deepEqual(
      mandateFitOf(mc, ZERO_USAGE, fitCtx({ delegate: { sessionId: null, connection: "conn-9", role: null } }), at),
      { ok: true }
    );
    const mr = activeMandate({ delegate: { kind: "role", value: "curator" } });
    assert.deepEqual(mandateFitOf(mr, ZERO_USAGE, fitCtx({ delegate: { sessionId: null, connection: null, role: "curator" } }), at), { ok: true });
    assert.equal(mandateFitOf(mr, ZERO_USAGE, fitCtx({ delegate: { sessionId: null, connection: null, role: "editor" } }), at).code, "delegate_mismatch");
  });

  test("scope: outside include refuses, inside exclude refuses, segment boundaries hold", () => {
    const at = T0 + 2000;
    const m = activeMandate();
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ notePath: "Elsewhere/n.md" }), at).code, "scope_escape");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ notePath: "Projects/Archive/old.md" }), at).code, "scope_escape");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ notePath: "ProjectsExtra/n.md" }), at).code, "scope_escape", "'Projects' never covers 'ProjectsExtra'");
    assert.equal(pathWithin("a/bc", "a/b"), false);
    assert.equal(pathWithin("a/b/c", "a/b/"), true, "a trailing slash on the prefix is tolerated");
  });

  test("class: any derived class outside the allowed set blocks; deriving nothing is not authorization", () => {
    const at = T0 + 2000;
    const m = activeMandate();
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ changeClasses: ["presentation", "content"] }), at).code, "class_escalation");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ changeClasses: ["authority"] }), at).code, "class_escalation");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ changeClasses: [] }), at).code, "class_escalation");
  });

  test("transformation and predicate: exact id AND version, no fuzzy match", () => {
    const at = T0 + 2000;
    const m = activeMandate();
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ transformation: { id: "carrier-normalize", version: "2" } }), at).code, "transformation_mismatch");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ transformation: null }), at).code, "transformation_mismatch");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ predicates: [{ id: "info-preserved", version: "1" }] }), at).code, "predicate_mismatch");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ predicates: [] }), at).code, "predicate_mismatch");
    // Extra predicates beyond the required set are fine — the mandate names a floor, not a ceiling.
    assert.deepEqual(
      mandateFitOf(m, ZERO_USAGE, fitCtx({ predicates: [{ id: "info-preserved", version: "2" }, { id: "extra", version: "9" }] }), at),
      { ok: true }
    );
  });

  test("action eligibility and durability: renaming a tool widens nothing; ephemeral observations refuse", () => {
    const at = T0 + 2000;
    const m = activeMandate();
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ action: { id: "note.write", version: "2" } }), at).code, "action_not_eligible");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ action: null }), at).code, "action_not_eligible");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ durability: "ephemeral" }), at).code, "durability_insufficient");
    assert.equal(mandateFitOf(m, ZERO_USAGE, fitCtx({ durability: null }), at).code, "durability_insufficient");
  });

  test("budget: reached usage refuses as a normal stop; production authority is checked", () => {
    const at = T0 + 2000;
    const m = activeMandate();
    assert.equal(mandateFitOf(m, { ...ZERO_USAGE, items: 100 }, fitCtx(), at).code, "budget_exhausted");
    assert.equal(mandateFitOf(m, { ...ZERO_USAGE, failures: 4 }, fitCtx(), at).code, "budget_exhausted");
  });
});

// ── Lifecycle store: durable, folded, garbage-tolerant ───────────────────────

describe("the mandate store — append-only events, one fold", () => {
  test("draft → counter → activate → charge → revoke, end to end, with supersession folding", async () => {
    const io = memoryIo();
    const store = createMandateStore(io);

    const d1 = draft({}, RAND_A);
    await store.draft(d1, T0);

    // The counter supersedes the countered draft.
    const d2 = openDraft(
      { authoredBy: { sessionId: "sess-1", client: "claude" }, terms: terms({ budgets: { ...terms().budgets, maxItems: 50 } }), counterOf: d1.id },
      T0 + 10,
      RAND_B
    );
    await store.draft(d2, T0 + 10);
    assert.equal((await store.getDraft(d1.id)).status, "superseded");
    assert.equal((await store.getDraft(d2.id)).status, "open");

    // Activation marks the draft and grants the mandate.
    const m1 = activateDraft(d2, { principal: "nelson", gestureRef: "gesture-1" }, T0 + 20, RAND_C);
    await store.activate(m1, T0 + 20);
    assert.equal((await store.getDraft(d2.id)).status, "activated");
    assert.equal((await store.getMandate(m1.id)).status, "active");
    assert.deepEqual(await store.usageOf(m1.id), ZERO_USAGE);

    // Usage folds; charging an unknown or inactive mandate refuses.
    await store.charge(m1.id, { items: 3, bytes: 500, proposals: 3 }, T0 + 30);
    await store.charge(m1.id, { failures: 1 }, T0 + 31);
    assert.deepEqual(await store.usageOf(m1.id), { items: 3, bytes: 500, proposals: 3, failures: 1 });

    // Amendment by replacement: a fresh draft, one activation carrying supersedes.
    const d3 = draft({}, new Uint8Array(10).fill(4));
    await store.draft(d3, T0 + 40);
    const m2 = activateDraft(d3, { principal: "nelson", gestureRef: "gesture-2", supersedes: m1.id }, T0 + 50, new Uint8Array(10).fill(5));
    await store.activate(m2, T0 + 50);
    assert.equal((await store.getMandate(m1.id)).status, "superseded", "one gesture grants the replacement AND retires the replaced");
    assert.equal((await store.getMandate(m2.id)).status, "active");
    await assert.rejects(() => store.charge(m1.id, { items: 1 }, T0 + 60), (e) => e.code === "mandate_not_active");

    await store.revoke(m2.id, "done with this");
    assert.equal((await store.getMandate(m2.id)).status, "revoked");
    assert.equal((await store.allMandates()).length, 2);
    assert.equal((await store.allDrafts()).length, 3);
  });

  test("store guards: unknown references refuse and write NOTHING", async () => {
    const io = memoryIo();
    const store = createMandateStore(io);
    const d = draft();
    await assert.rejects(
      () => store.draft(openDraft({ authoredBy: { sessionId: null, client: null }, terms: terms(), counterOf: "no-such" }, T0, RAND_B), T0),
      (e) => e.code === "mandate_unknown"
    );
    const orphan = activateDraft(d, { principal: "nelson", gestureRef: "g" }, T0, RAND_C);
    await assert.rejects(() => store.activate(orphan, T0), (e) => e.code === "mandate_unknown", "activating against an unrecorded draft refuses");
    await assert.rejects(() => store.charge("no-such", { items: 1 }, T0), (e) => e.code === "mandate_unknown");
    await assert.rejects(() => store.revoke("no-such", "r", T0), (e) => e.code === "mandate_unknown");
    assert.equal(io.lines.length, 0, "every refusal above wrote nothing");
  });

  test("activation through the store refuses a settled draft — no path re-activates", async () => {
    const io = memoryIo();
    const store = createMandateStore(io);
    const d = draft();
    await store.draft(d, T0);
    const m1 = activateDraft(d, { principal: "nelson", gestureRef: "g1" }, T0 + 1, RAND_B);
    await store.activate(m1, T0 + 1);
    const m2 = activateDraft(d, { principal: "nelson", gestureRef: "g2" }, T0 + 2, RAND_C);
    await assert.rejects(() => store.activate(m2, T0 + 2), (e) => e.code === "draft_not_open", "a draft grants at most once");
  });

  test("the fold survives garbage and ignores unknown ids; first record wins on duplicates", () => {
    const d = draft();
    const m = activateDraft(d, { principal: "nelson", gestureRef: "g" }, T0, RAND_B);
    const dupe = { ...m, principal: "impostor" };
    const fold = foldMandateEvents([
      "{ not json",
      JSON.stringify({ kind: "drafted", at: T0, draft: d }),
      JSON.stringify({ kind: "usage", at: T0, mandateId: "unknown", delta: { items: 1 } }),
      JSON.stringify({ kind: "revoked", at: T0, mandateId: "unknown", reason: "x" }),
      JSON.stringify({ kind: "activated", at: T0, mandate: m }),
      JSON.stringify({ kind: "activated", at: T0 + 1, mandate: dupe }),
      JSON.stringify({ kind: "usage", at: T0 + 2, mandateId: m.id, delta: { items: 2 } }),
      "also garbage",
    ]);
    assert.equal(fold.mandates.get(m.id).principal, "nelson", "a duplicate activation never rewrites the first record");
    assert.deepEqual(fold.usage.get(m.id), { ...ZERO_USAGE, items: 2 });
    assert.equal(fold.drafts.get(d.id).status, "activated");
  });

  test("markExpired and markExhausted record observed facts, idempotently, and only over active mandates", async () => {
    const io = memoryIo();
    const store = createMandateStore(io);
    const d = draft();
    await store.draft(d, T0);
    const m = activateDraft(d, { principal: "nelson", gestureRef: "g" }, T0 + 1, RAND_B);
    await store.activate(m, T0 + 1);
    await store.markExhausted(m.id, "item budget reached: 100/100", T0 + 2);
    assert.equal((await store.getMandate(m.id)).status, "exhausted");
    assert.equal((await store.getMandate(m.id)).exhaustedBy, "item budget reached: 100/100");
    const before = io.lines.length;
    await store.markExhausted(m.id, "again", T0 + 3);
    await store.markExpired(m.id, T0 + 4);
    assert.equal(io.lines.length, before, "observing a fact about a non-active mandate writes nothing");
  });
});

// ── The UI wiring: buildMandateUi (governor/wiring/mandate-wiring.ts) ─────────────

const { buildMandateUi } = await import("../src/governor/wiring/mandate-wiring.ts");
const { createSessionStore } = await import("../src/governor/kernel/sessions/session-store.ts");
const { openSession } = await import("../src/governor/kernel/sessions/session.ts");

function wiredWorld() {
  const mandateIo = memoryIo();
  const sessionIo = memoryIo();
  const store = createMandateStore(mandateIo);
  const sessions = createSessionStore(sessionIo);
  const ui = buildMandateUi({
    store,
    attachSessionMandate: (sid, mid, now) => sessions.attachMandate(sid, mid, now),
    principal: () => "nelson",
    now: () => T0 + 100,
  });
  return { store, sessions, ui, mandateIo, sessionIo };
}

describe("buildMandateUi — the pane's three verbs", () => {
  test("activate grants, attaches the session, and refuses without a gesture", async () => {
    const { store, sessions, ui } = wiredWorld();
    const sess = openSession(
      { vaultId: "v", replicaId: "r", actor: { connection: "c1", clientClaim: null }, journalHead: null, scopeDigest: "d" },
      T0,
      RAND_A
    );
    await sessions.open(sess, T0);
    const d = openDraft(
      { authoredBy: { sessionId: sess.id, client: "claude" }, terms: terms({ delegate: { kind: "session", value: sess.id } }) },
      T0,
      RAND_B
    );
    await store.draft(d, T0);

    // No gesture, no grant — and NOTHING was written.
    const refused = await ui.activate(d.id, "");
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "authority_missing");
    assert.equal((await store.getDraft(d.id)).status, "open");

    const granted = await ui.activate(d.id, "gesture-ui-1");
    assert.equal(granted.ok, true);
    assert.equal(granted.sessionAttachWarning, null);
    assert.equal((await store.getMandate(granted.mandateId)).principal, "nelson");
    assert.equal((await sessions.get(sess.id)).mandateId, granted.mandateId, "activation recorded the binding on the session");

    // A session's mandate is set once: a second grant against the same live
    // session activates the mandate but WARNS that the session refused it.
    const d2 = openDraft(
      { authoredBy: { sessionId: sess.id, client: "claude" }, terms: terms({ delegate: { kind: "session", value: sess.id } }) },
      T0 + 1,
      RAND_C
    );
    await store.draft(d2, T0 + 1);
    const second = await ui.activate(d2.id, "gesture-ui-2");
    assert.equal(second.ok, true);
    assert.match(second.sessionAttachWarning, /did not take the binding/);
    assert.match(second.sessionAttachWarning, /provenance, not a gate/, "the warning claims exactly what the kernel enforces — no more");
    assert.equal((await sessions.get(sess.id)).mandateId, granted.mandateId, "the first binding stands");
  });

  test("activating a COUNTER of a granted draft supersedes the earlier grant — amendment by replacement, one gesture", async () => {
    const { store, ui } = wiredWorld();
    const d1 = draft({}, RAND_A);
    await store.draft(d1, T0);
    const first = await ui.activate(d1.id, "gesture-1");
    assert.equal(first.ok, true);

    const d2 = openDraft(
      { authoredBy: { sessionId: "sess-1", client: "claude" }, terms: terms(), counterOf: d1.id },
      T0 + 1,
      RAND_B
    );
    await store.draft(d2, T0 + 1);
    const second = await ui.activate(d2.id, "gesture-2");
    assert.equal(second.ok, true);
    assert.equal(second.supersededMandateId, first.mandateId, "the counter's grant names what it replaced");
    assert.equal((await store.getMandate(first.mandateId)).status, "superseded");
    assert.equal((await store.getMandate(second.mandateId)).status, "active");

    // An UNRELATED draft's activation supersedes nothing — derived, never guessed.
    const d3 = draft({}, RAND_C);
    await store.draft(d3, T0 + 2);
    const third = await ui.activate(d3.id, "gesture-3");
    assert.equal(third.supersededMandateId, null);
  });

  test("decline and revoke are gesture-gated and land in the durable record", async () => {
    const { store, ui } = wiredWorld();
    const d = draft({}, RAND_A);
    await store.draft(d, T0);
    assert.equal((await ui.decline(d.id, "too broad", "")).code, "authority_missing");
    assert.equal((await ui.decline(d.id, "too broad", "gesture-d")).ok, true);
    assert.equal((await store.getDraft(d.id)).status, "declined");

    const d2 = draft({}, RAND_B);
    await store.draft(d2, T0 + 1);
    const g = await ui.activate(d2.id, "gesture-a");
    assert.equal((await ui.revoke(g.mandateId, "distrust", "")).code, "authority_missing");
    assert.equal((await ui.revoke(g.mandateId, "distrust", "gesture-r")).ok, true);
    const revoked = await store.getMandate(g.mandateId);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedReason, "distrust");
  });
});

describe("session ⇄ mandate binding (session-store 'mandated' event)", () => {
  test("attachMandate refuses non-open and already-mandated sessions, writing nothing on refusal", async () => {
    const io = memoryIo();
    const sessions = createSessionStore(io);
    const s = openSession(
      { vaultId: "v", replicaId: "r", actor: { connection: "c", clientClaim: null }, journalHead: null, scopeDigest: "d" },
      T0,
      RAND_A
    );
    await sessions.open(s, T0);
    await sessions.attachMandate(s.id, "m-1", T0 + 1);
    assert.equal((await sessions.get(s.id)).mandateId, "m-1");
    const before = io.lines.length;
    await assert.rejects(() => sessions.attachMandate(s.id, "m-2", T0 + 2), /set once/);
    await assert.rejects(() => sessions.attachMandate("no-such", "m-1", T0 + 2));
    assert.equal(io.lines.length, before, "refused attaches appended no event");
    await sessions.close(s.id, T0 + 3);
    const closed = openSession(
      { vaultId: "v", replicaId: "r", actor: { connection: "c2", clientClaim: null }, journalHead: null, scopeDigest: "d" },
      T0,
      RAND_B
    );
    await sessions.open(closed, T0);
    await sessions.close(closed.id, T0 + 1);
    await assert.rejects(() => sessions.attachMandate(closed.id, "m-3", T0 + 4), /session_not_live|is closed/);
  });
});

// ── The MCP surface: tools-governance-mandate.ts (review of #356: the
// allowlist gate and the no-session default were shipped untested — a
// neutered scopeRefusal survived the full suite. These legs close that.) ────

const { registerMandateTools } = await import("../src/mcp/tools-governance-mandate.ts");

function mountedTools({ sessionId = "sess-1", allowlist } = {}) {
  const tools = new Map();
  const server = { registerTool: (name, def, handler) => tools.set(name, { def, handler }) };
  const { store } = { store: createMandateStore(memoryIo()) };
  registerMandateTools(server, {
    draft: (d, now) => store.draft(d, now),
    allDrafts: () => store.allDrafts(),
    allMandates: () => store.allMandates(),
    usageOf: (id) => store.usageOf(id),
    sessionId: () => sessionId,
    client: () => "claude",
    now: () => T0,
    getSettings: allowlist ? () => ({ readOnly: false, allowlist }) : undefined,
  });
  return { tools, store };
}

/** The draft tool's args, matching the baseline terms() shape. */
function draftArgs(over = {}) {
  return {
    purpose: "normalize carriers",
    scope_include: ["Projects"],
    allowed_classes: ["presentation"],
    transformation: { id: "carrier-normalize", version: "1" },
    predicates: [{ id: "info-preserved", version: "2" }],
    eligible_actions: [{ id: "note.write", version: "1" }],
    budgets: { max_items: 10, max_bytes: 1000, max_duration_ms: 60000, max_proposals: 10, max_failures: 0 },
    ...over,
  };
}

function structured(res) {
  return res.structuredContent ?? JSON.parse(res.content[0].text);
}

describe("MCP mandate tools — draft-and-list only, allowlist-disciplined", () => {
  test("exactly two tools register; draft is mutating, the listing read-only; no verb grants", () => {
    const { tools } = mountedTools();
    assert.deepEqual([...tools.keys()].sort(), ["governance_mandate_draft", "governance_mandates"]);
    assert.equal(tools.get("governance_mandate_draft").def.annotations.readOnlyHint, false);
    assert.equal(tools.get("governance_mandates").def.annotations.readOnlyHint, true);
    for (const name of tools.keys()) {
      assert.ok(!/activate|grant|revoke|decline/.test(name), "no agent verb may look like a grant");
    }
  });

  test("drafting lands in the store bound to the calling session; kernel refusals surface as coded errors", async () => {
    const { tools, store } = mountedTools();
    const res = await tools.get("governance_mandate_draft").handler(draftArgs());
    assert.notEqual(res.isError, true);
    const body = structured(res);
    const d = await store.getDraft(body.draft_id);
    assert.equal(d.status, "open");
    assert.deepEqual(d.terms.delegate, { kind: "session", value: "sess-1" }, "the default delegate is the calling session");
    assert.equal(d.authoredBy.client, "claude");

    const bad = await tools.get("governance_mandate_draft").handler(draftArgs({ allowed_classes: ["authority"] }));
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /never delegable/);
    assert.equal((await store.allDrafts()).length, 1, "a refused draft wrote nothing");
  });

  test("no session and no explicit delegate: refuses rather than minting an unbound delegation", async () => {
    const { tools, store } = mountedTools({ sessionId: null });
    const res = await tools.get("governance_mandate_draft").handler(draftArgs());
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no_session/);
    assert.equal((await store.allDrafts()).length, 0);
    // An explicit delegate unblocks it.
    const ok2 = await tools.get("governance_mandate_draft").handler(draftArgs({ delegate: { kind: "role", value: "curator" } }));
    assert.notEqual(ok2.isError, true);
  });

  test("THE ALLOWLIST GATE RUNS: a sandboxed session cannot draft over hidden territory, in include OR exclude position", async () => {
    const { tools, store } = mountedTools({ allowlist: ["Projects"] });
    const hidden = await tools.get("governance_mandate_draft").handler(draftArgs({ scope_include: ["Secrets"] }));
    assert.equal(hidden.isError, true);
    assert.match(hidden.content[0].text, /out_of_allowlist/);
    assert.equal((await store.allDrafts()).length, 0, "the refused draft wrote nothing");
    // A broader-than-allowlist prefix refuses too — 'Projects' under allowlist ['Projects/Sub'] is not visible.
    const { tools: narrow } = mountedTools({ allowlist: ["Projects/Sub"] });
    const broad = await narrow.get("governance_mandate_draft").handler(draftArgs());
    assert.equal(broad.isError, true);
    // And the fitting case passes (vacuity: the gate is the only variable).
    const ok2 = await tools.get("governance_mandate_draft").handler(draftArgs());
    assert.notEqual(ok2.isError, true);
  });

  test("the listing counts hidden-scope records without naming them — exclude entries count as scope too", async () => {
    const { tools, store } = mountedTools({ allowlist: ["Projects"] });
    const seed = createMandateStore(memoryIo()); // unused; keep symmetry obvious
    void seed;
    const visible = openDraft({ authoredBy: { sessionId: "s", client: "c" }, terms: terms({ scope: { include: ["Projects"], exclude: [] } }) }, T0, RAND_A);
    const hiddenInclude = openDraft({ authoredBy: { sessionId: "s", client: "c" }, terms: terms({ scope: { include: ["Secrets"], exclude: [] } }) }, T0, RAND_B);
    const hiddenExclude = openDraft(
      { authoredBy: { sessionId: "s", client: "c" }, terms: terms({ scope: { include: ["Projects"], exclude: ["Secrets/Deep"] } }) },
      T0,
      RAND_C
    );
    await store.draft(visible, T0);
    await store.draft(hiddenInclude, T0 + 1);
    await store.draft(hiddenExclude, T0 + 2);
    const res = structured(await tools.get("governance_mandates").handler({}));
    assert.equal(res.drafts.length, 1);
    assert.equal(res.drafts[0].draft_id, visible.id);
    assert.equal(res.hidden_drafts, 2, "hidden include AND hidden exclude are both counted, never named");
    const text = JSON.stringify(res);
    assert.ok(!text.includes("Secrets"), "no hidden path appears anywhere in the listing");
  });
});

describe("review-of-#356 fixes, pinned", () => {
  test("counter-supersession walks the WHOLE chain: d3 counters d2 counters d1; activating d3 retires d1's grant", async () => {
    const { store, ui } = wiredWorld();
    const d1 = draft({}, RAND_A);
    await store.draft(d1, T0);
    const g1 = await ui.activate(d1.id, "gesture-1");
    const d2 = openDraft({ authoredBy: { sessionId: "sess-1", client: "claude" }, terms: terms(), counterOf: d1.id }, T0 + 1, RAND_B);
    await store.draft(d2, T0 + 1);
    const d3 = openDraft({ authoredBy: { sessionId: "sess-1", client: "claude" }, terms: terms(), counterOf: d2.id }, T0 + 2, RAND_C);
    await store.draft(d3, T0 + 2);
    const g3 = await ui.activate(d3.id, "gesture-3");
    assert.equal(g3.ok, true);
    assert.equal(g3.supersededMandateId, g1.mandateId, "the grant two links up the chain is the one being replaced");
    assert.equal((await store.getMandate(g1.mandateId)).status, "superseded", "the broad grant does not survive the narrowing");
  });

  test("mandateFitOf refuses a traversal or absolute notePath before any prefix match", () => {
    const m = activeMandate();
    const at = T0 + 2000;
    for (const p of ["Projects/../Secrets/x.md", "/Projects/alpha.md", "Projects/./x.md", "../x.md"]) {
      const v = mandateFitOf(m, ZERO_USAGE, fitCtx({ notePath: p }), at);
      assert.equal(v.code, "scope_escape", `'${p}' must refuse`);
    }
    // Vacuity: the plain path still fits — the traversal check is the only variable.
    assert.deepEqual(mandateFitOf(m, ZERO_USAGE, fitCtx(), at), { ok: true });
  });
});
