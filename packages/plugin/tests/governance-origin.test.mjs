/**
 * governance-origin.test.mjs — WP5, origin classification (D12).
 *
 * D12's shape: four origins, fixed confidence, no false cryptographic claims.
 * The two properties that matter most here are RETENTION and HONESTY —
 * retention, because the existing human-vs-agent classifier's behavior is
 * adopted by name in the decision (trusted editor input advances silently;
 * ambiguity never does) and must survive this change byte-for-byte; honesty,
 * because sync attribution must be UNREACHABLE until a real reconciliation
 * producer exists — "the file changed while Obsidian was closed" is
 * indistinguishable from any external writer.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyOrigin, classifyChange, shouldAdvanceBaselineSilently } from "../src/governor/kernel/origins/classifier.ts";
import { reconcileDisposition } from "../src/governor/kernel/origins/reconcile.ts";
import { classifyModify } from "../src/governor/kernel/classify.ts";
import { ORIGIN_CONFIDENCE } from "../src/governor/kernel/contracts/origin.ts";

const sig = (over = {}) => ({ recentAgentWrite: false, recentGenuineHumanInput: false, syncEvidence: false, ...over });

// ── the four origins ─────────────────────────────────────────────────────────

describe("origin classifier — evidence strength, falling downward", () => {
  test("a journal-matched governor write is governor-originated (bound)", () => {
    const o = classifyOrigin(sig({ recentAgentWrite: true }));
    assert.equal(o.origin, "governor-originated");
    assert.equal(o.confidence, "bound");
  });

  test("trusted editor input is local-human-observed (observed, not proven)", () => {
    const o = classifyOrigin(sig({ recentGenuineHumanInput: true }));
    assert.equal(o.origin, "local-human-observed");
    assert.equal(o.confidence, "observed");
  });

  test("a governor write outranks a trusted keystroke in the same window", () => {
    // The write is BOUND; the keystroke may be the human reacting to it.
    const o = classifyOrigin(sig({ recentAgentWrite: true, recentGenuineHumanInput: true }));
    assert.equal(o.origin, "governor-originated");
  });

  test("nothing attributable is external-unattributed — the honest floor", () => {
    const o = classifyOrigin(sig());
    assert.equal(o.origin, "external-unattributed");
    assert.equal(o.confidence, "indeterminate");
  });

  test("sync attribution requires actual reconciliation evidence", () => {
    assert.equal(classifyOrigin(sig({ syncEvidence: true })).origin, "sync-attributed");
    // and WITHOUT the flag it can never be reached — pinned by the floor test
    // above. No producer sets the flag until WP12; grep proves it:
  });

  test("no production code emits syncEvidence yet — claiming it would be a false attribution", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const HERE = path.dirname(url.fileURLToPath(import.meta.url));
    const srcDir = path.join(HERE, "..", "src");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && !p.includes("origins")) {
          const text = fs.readFileSync(p, "utf8");
          if (/syncEvidence:\s*true/.test(text)) offenders.push(p);
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], "a producer of syncEvidence:true appeared before WP12's reconciliation machinery");
  });
});

// ── retention of the adopted behavior ────────────────────────────────────────

describe("origin classifier — the adopted modify classifier survives verbatim", () => {
  test("classifyChange agrees with classifyModify on every input combination — ALL THREE signals swept", () => {
    // The first version of this test swept agent × human and left syncEvidence
    // at its default — so its name claimed more than its loop checked, and a
    // mutation routing sync evidence to "human" (sync forcing a silent
    // baseline advance) survived the suite. Found by governor-lead's slice
    // review via exactly that mutation. All eight combinations now, with the
    // explicit independence assertion: the modify class must not vary with
    // syncEvidence at all — better sync evidence may one day move a case into
    // review, never into silent advancement.
    for (const agent of [true, false]) {
      for (const human of [true, false]) {
        const expected = classifyModify({ recentAgentWrite: agent, recentGenuineHumanInput: human });
        for (const sync of [true, false]) {
          const { modifyClass } = classifyChange(sig({ recentAgentWrite: agent, recentGenuineHumanInput: human, syncEvidence: sync }));
          assert.equal(modifyClass, expected, `agent=${agent} human=${human} sync=${sync}`);
        }
      }
    }
  });

  test("only a confident human classification advances silently — unchanged", () => {
    assert.ok(shouldAdvanceBaselineSilently("human"));
    assert.ok(!shouldAdvanceBaselineSilently("agent"));
    assert.ok(!shouldAdvanceBaselineSilently("ambiguous"));
  });

  test("one evaluation, two consumers: the origin and the modify class cannot disagree", () => {
    const { modifyClass, origin } = classifyChange(sig({ recentGenuineHumanInput: true }));
    assert.equal(modifyClass, "human");
    assert.equal(origin.origin, "local-human-observed");
  });
});

// ── reconciliation dispositions ──────────────────────────────────────────────

describe("reconcile — what an origin means for standing", () => {
  test("the human's own typing advances silently, touches nothing else", () => {
    const d = reconcileDisposition({ origin: "local-human-observed", hadAdmittedStanding: true });
    assert.deepEqual(d, { advanceSilently: true, routeForReview: false, markStandingStale: false });
  });

  test("a governor change is never its own acceptance — routed for review", () => {
    const d = reconcileDisposition({ origin: "governor-originated", hadAdmittedStanding: false });
    assert.deepEqual(d, { advanceSilently: false, routeForReview: true, markStandingStale: false });
  });

  test("sync and external changes over ADMITTED standing mark it stale — never revoked", () => {
    for (const origin of ["sync-attributed", "external-unattributed"]) {
      const d = reconcileDisposition({ origin, hadAdmittedStanding: true });
      assert.equal(d.markStandingStale, true, origin);
      assert.equal(d.advanceSilently, false, origin);
      assert.equal(d.routeForReview, true, origin);
    }
  });

  test("the same changes over ungoverned notes just route for review", () => {
    const d = reconcileDisposition({ origin: "external-unattributed", hadAdmittedStanding: false });
    assert.deepEqual(d, { advanceSilently: false, routeForReview: true, markStandingStale: false });
  });

  test("ambiguity never silently advances — the D12 fail-safe, end to end", () => {
    // An ambiguous modify is external-unattributed; its disposition must
    // never be silent advancement, whatever the standing.
    for (const hadStanding of [true, false]) {
      const { origin } = classifyChange(sig());
      const d = reconcileDisposition({ origin: origin.origin, hadAdmittedStanding: hadStanding });
      assert.equal(d.advanceSilently, false);
    }
  });
});

// ── production wiring: the origin is actually produced and persisted ─────────

describe("origin wiring — produced in the modify listener, persisted on the advance record", async () => {
  const fs = await import("node:fs");

  test("wiring.ts evaluates classifyChange (one evaluation), with syncEvidence hard false", () => {
    const wiring = fs.readFileSync(new URL("../src/governor/wiring/wiring.ts", import.meta.url), "utf8");
    assert.match(wiring, /classifyChange\(/, "the modify listener produces the origin record");
    assert.match(wiring, /syncEvidence: false/, "no local signal may claim sync attribution");
    assert.ok(!/classifyModify\(/.test(wiring), "the listener no longer calls the bare modify classifier — one evaluation, two consumers");
  });

  test("the silent-advance audit record carries the origin", async () => {
    const { silentAdvanceRecord } = await import("../src/governor/kernel/accept.ts");
    const rec = silentAdvanceRecord({
      ts: "2026-08-21T00:00:00Z",
      path: "A.md",
      reason: "human-edit",
      fromHash: null,
      toHash: "abc",
      origin: { origin: "local-human-observed", confidence: "observed" },
    });
    assert.deepEqual(rec.origin, { origin: "local-human-observed", confidence: "observed" });
    // and without one, the field is absent — pre-WP5 log lines stay valid
    assert.ok(!("origin" in silentAdvanceRecord({ ts: "t", path: "p", reason: "human-edit", fromHash: null, toHash: "x" })));
  });
});

// ── a session is not a governed posture ──────────────────────────────────────

describe("capture policy — having a session is not being governed", async () => {
  test("a bare session id does NOT promote an evidence-default action to replayable", async () => {
    // Every connection opens a session now (WP5). If that alone counted as
    // "governed", the first future evidence-default native action would
    // silently jump to full-payload retention on the strength of nothing but
    // a connection. Governed means a proposing or mandated posture (WP6/WP9).
    const { decideCapture } = await import("../src/kernel/observations/capture-policy.ts");
    const evidenceAction = {
      id: "x.read", version: 1,
      observations: { defaultCapture: "evidence", supportsProposal: false },
    };
    const withSession = decideCapture({ action: evidenceAction, session: { id: "s-1", governed: false }, substantive: true });
    assert.equal(withSession.level, "evidence", "session presence alone must not promote");
    const governed = decideCapture({ action: evidenceAction, session: { id: "s-1", governed: true }, substantive: true });
    assert.equal(governed.level, "replayable", "a genuinely governed session still promotes");
  });

  test("capture.ts passes governed: false until postures exist — pinned at the source", async () => {
    const fs = await import("node:fs");
    const capture = fs.readFileSync(new URL("../src/kernel/observations/capture.ts", import.meta.url), "utf8");
    assert.match(capture, /governed: false/, "a connection's session must not claim a governed posture");
    assert.ok(!/governed: true/.test(capture));
  });
});

// ── executor: identity is never claimed through arguments ────────────────────

describe("reserved identity inputs — refused at the executor (WP5)", () => {
  test("a call whose arguments claim an identity field is refused with the stable code", async () => {
    const { createActionRegistry } = await import("../src/kernel/operations/registry.ts");
    const { createOperationExecutor, ReservedIdentityInputError } = await import("../src/kernel/operations/executor.ts");
    const { compatibilityAction } = await import("../src/kernel/operations/compatibility.ts");

    const r = createActionRegistry();
    r.register(compatibilityAction({ surface: "obsidian_doctor", postcondition: "x", owner: "core", distribution: "public-default", readOnly: true }));
    r.bind({ kind: "mcp", id: "obsidian_doctor", action: "compat.obsidian_doctor", actionVersion: 1 });
    r.validate();
    const executor = createOperationExecutor({ registry: r, actor: () => ({ binding: "c", clientClaim: null }) });

    for (const key of ["actor", "signer", "standing_ref", "acceptedBy"]) {
      await assert.rejects(
        () => executor.run({ surface: { id: "obsidian_doctor" }, inputs: { [key]: "claimed" } }, async () => "never"),
        (e) => e instanceof ReservedIdentityInputError && e.code === "reserved_identity_input",
        `should refuse '${key}'`
      );
    }
  });

  test("ordinary arguments are untouched by the check", async () => {
    const { createActionRegistry } = await import("../src/kernel/operations/registry.ts");
    const { createOperationExecutor } = await import("../src/kernel/operations/executor.ts");
    const { compatibilityAction } = await import("../src/kernel/operations/compatibility.ts");
    const r = createActionRegistry();
    r.register(compatibilityAction({ surface: "obsidian_doctor", postcondition: "x", owner: "core", distribution: "public-default", readOnly: true }));
    r.bind({ kind: "mcp", id: "obsidian_doctor", action: "compat.obsidian_doctor", actionVersion: 1 });
    r.validate();
    const executor = createOperationExecutor({ registry: r, actor: () => ({ binding: "c", clientClaim: null }) });
    const { result } = await executor.run({ surface: { id: "obsidian_doctor" }, inputs: { path: "A.md" } }, async () => "ok");
    assert.equal(result, "ok");
  });
});
