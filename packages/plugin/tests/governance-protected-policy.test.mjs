/**
 * governance-protected-policy.test.mjs — the honor-only-if-blessed rule (#224)
 * and its first consumer, the per-note auto-accept policy (#135).
 *
 * Pins:
 *   • honoredValueFromBlessed reads ONLY blessed (baseline) content — never raw
 *     frontmatter — and confers nothing for undeclared / non-authority keys,
 *     unparseable blessed blocks, or ambiguous canonical duplicates;
 *   • autoAcceptPolicyOf accepts exactly `appends` | `all` (case-insensitive),
 *     nothing else;
 *   • the eligibility policy branch: appends honored + byte-prefix append →
 *     eligible with policy logged; append+edit → pending; `all` → eligible for
 *     anything; no policy → class-allowlist only, byte-identical;
 *   • protectedPropertyDrift + computeQueue's side-door surfacing: a
 *     non-journaled write to a declared property surfaces for review while an
 *     ordinary non-journaled diff stays out of the queue exactly as before;
 *   • the HONOR-RULE SCENARIO with the reconciler's pieces: a side-door
 *     `auto-accept` is INERT (not honored, not auto-accepting) until either a
 *     human-attributed edit (classify → silent advance) or an Accept advances
 *     the baseline over it — after which it IS honored.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  honoredValueFromBlessed,
  autoAcceptPolicyOf,
  protectedPropertyDrift,
} from "../src/kernel/governance/protected-policy.ts";
import { evaluate } from "../src/kernel/governance/auto-accept/eligibility.ts";
import { autoAcceptRecord } from "../src/kernel/governance/auto-accept/eligibility.ts";
import { DEFAULT_ALLOWLIST } from "../src/kernel/governance/auto-accept/classes.ts";
import { computeQueue } from "../src/kernel/governance/queue.ts";
import { classifyModify, shouldAdvanceBaselineSilently } from "../src/kernel/governance/classify.ts";
import { contentHash } from "../src/kernel/governance/hash.ts";
import {
  DEFAULT_PROTECTED_PROPERTIES,
  setDeclaredProtectedProperties,
} from "@vault-mcp/core";

const silent = () => {};
beforeEach(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));
after(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));

const ALL = [...DEFAULT_ALLOWLIST];

describe("honoredValueFromBlessed", () => {
  test("reads the blessed frontmatter value", () => {
    assert.equal(honoredValueFromBlessed("---\nauto-accept: appends\n---\nbody\n", "auto-accept"), "appends");
  });

  test("no blessed content → nothing honored", () => {
    assert.equal(honoredValueFromBlessed(null, "auto-accept"), undefined);
    assert.equal(honoredValueFromBlessed(undefined, "auto-accept"), undefined);
  });

  test("a key not declared authority-conferring confers nothing — even when the bytes carry it", () => {
    setDeclaredProtectedProperties([{ key: "auto-accept", grade: "agent-forbidden" }], silent);
    assert.equal(honoredValueFromBlessed("---\nauto-accept: all\n---\n", "auto-accept"), undefined);
    setDeclaredProtectedProperties([], silent);
    assert.equal(honoredValueFromBlessed("---\nauto-accept: all\n---\n", "auto-accept"), undefined);
  });

  test("unclassifiable blessed frontmatter confers nothing (fail safe)", () => {
    assert.equal(honoredValueFromBlessed("---\n\t: broken\n---\n", "auto-accept"), undefined);
  });

  test("ambiguous canonical duplicates confer nothing", () => {
    assert.equal(
      honoredValueFromBlessed("---\nauto-accept: appends\nauto_accept: all\n---\n", "auto-accept"),
      undefined
    );
    // ...but AGREEING duplicates do
    assert.equal(
      honoredValueFromBlessed("---\nauto-accept: all\nauto_accept: all\n---\n", "auto-accept"),
      "all"
    );
  });
});

describe("autoAcceptPolicyOf", () => {
  test("appends / all (case-insensitive, trimmed)", () => {
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: appends\n---\n"), "appends");
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: ALL\n---\n"), "all");
    assert.equal(autoAcceptPolicyOf("---\nauto_accept: Appends\n---\n"), "appends");
  });

  test("anything else is NO policy", () => {
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: everything\n---\n"), null);
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: [appends]\n---\n"), null);
    assert.equal(autoAcceptPolicyOf("---\ntitle: x\n---\n"), null);
    assert.equal(autoAcceptPolicyOf(null), null);
  });
});

describe("eligibility — the per-note policy branch (#135)", () => {
  const base = "---\nauto-accept: appends\n---\nlog\n";

  test("appends honored + pure append → eligible, policy logged", () => {
    const cur = base + "new line\n";
    const r = evaluate(base, cur, { enabled: ALL, policy: "appends" });
    assert.equal(r.eligible, true, r.reason);
    assert.equal(r.policy, "appends");
    assert.equal(r.reason, "policy-appends");
    assert.deepEqual(r.classes, []);
    const rec = autoAcceptRecord({
      ts: "t", path: "p", fromHash: "a", toHash: "b", classes: r.classes, railResult: r.rail, policy: r.policy,
    });
    assert.equal(rec.policy, "appends");
  });

  test("append AND edit of existing content → NOT an append → stays pending", () => {
    const cur = base.replace("log", "log EDITED") + "new line\n";
    const r = evaluate(base, cur, { enabled: ALL, policy: "appends" });
    assert.equal(r.eligible, false);
  });

  test("`all` accepts any pending change", () => {
    const cur = "---\nauto-accept: all\ntotally: rewritten\n---\ndifferent\n";
    const r = evaluate(base, cur, { enabled: ALL, policy: "all" });
    assert.equal(r.eligible, true);
    assert.equal(r.policy, "all");
    assert.equal(r.reason, "policy-all");
  });

  test("policy works even with the class allowlist EMPTY (orthogonal delegations)", () => {
    const r = evaluate(base, base + "x\n", { enabled: [], policy: "appends" });
    assert.equal(r.eligible, true);
  });

  test("appends policy that fails the detector still falls through to class evaluation", () => {
    const b = "---\ntitle: N\n---\nbody\n";
    const c = "---\ntitle: N\nuid: 019fea8c-2093-758a-8da2-e8dbcddda6b4\n---\nbody\n";
    const r = evaluate(b, c, { enabled: ALL, policy: "appends" });
    assert.equal(r.eligible, true, r.reason);
    assert.deepEqual(r.classes, ["uid-stamp"]);
    assert.equal(r.policy, undefined, "class-driven accept carries no policy");
  });

  test("no policy → class-allowlist only (content edit stays pending)", () => {
    const r = evaluate(base, base + "x\n", { enabled: ALL, policy: null });
    assert.equal(r.eligible, false);
    const r2 = evaluate(base, base + "x\n", { enabled: ALL });
    assert.equal(r2.eligible, false);
  });

  test("no-change short-circuits before the policy branch", () => {
    const r = evaluate(base, base, { enabled: ALL, policy: "all" });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "no-change");
  });
});

describe("protectedPropertyDrift + the queue's side-door surfacing (#224 §3)", () => {
  const blessed = "---\nauto-accept: appends\ntitle: T\n---\nbody\n";

  test("drift detected on change / removal / introduction; none on unrelated edits", () => {
    assert.deepEqual(protectedPropertyDrift(blessed, blessed.replace("appends", "all")), ["auto-accept"]);
    assert.deepEqual(protectedPropertyDrift(blessed, "---\ntitle: T\n---\nbody\n"), ["auto-accept"]);
    assert.deepEqual(protectedPropertyDrift("---\ntitle: T\n---\n", blessed), ["auto-accept"]);
    assert.deepEqual(protectedPropertyDrift(blessed, blessed.replace("body", "new body")), []);
    assert.deepEqual(protectedPropertyDrift(blessed, blessed.replace("T", "U")), []);
  });

  test("unparseable side falls back to textual mention (surface on doubt)", () => {
    const broken = "---\n\t: broken\nauto_accept: all\n---\nbody\n";
    assert.deepEqual(protectedPropertyDrift(blessed, broken), ["auto-accept"]);
    const brokenUnrelated = "---\n\t: broken\ntitle: T\n---\nbody\n";
    assert.deepEqual(protectedPropertyDrift("---\ntitle: T\n---\n", brokenUnrelated), []);
  });

  test("computeQueue: a non-journaled declared-property change surfaces as a side-door row", () => {
    const baseline = {
      path: "n.md",
      content: blessed,
      hash: contentHash(blessed),
      acceptedAt: "2026-08-18T10:00:00.000Z",
      acceptedBy: "local-human",
    };
    const current = blessed.replace("appends", "all");
    const queue = computeQueue({
      notes: [{ path: "n.md", content: current }],
      getBaseline: (p) => (p === "n.md" ? baseline : null),
      journal: [],
      protectedDrift: protectedPropertyDrift,
    });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].sideDoor, true);
    assert.equal(queue[0].agent, "(side-door)");
    assert.deepEqual(queue[0].protectedKeys, ["auto-accept"]);
    assert.equal(queue[0].writeCount, 0);
  });

  test("computeQueue: an ordinary non-journaled diff still stays OUT of the queue", () => {
    const baseline = {
      path: "n.md",
      content: blessed,
      hash: contentHash(blessed),
      acceptedAt: "2026-08-18T10:00:00.000Z",
      acceptedBy: "local-human",
    };
    const queue = computeQueue({
      notes: [{ path: "n.md", content: blessed.replace("body", "edited body") }],
      getBaseline: () => baseline,
      journal: [],
      protectedDrift: protectedPropertyDrift,
    });
    assert.equal(queue.length, 0);
  });

  test("computeQueue without the drift hook behaves byte-identically to the historical queue", () => {
    const baseline = {
      path: "n.md",
      content: blessed,
      hash: contentHash(blessed),
      acceptedAt: "2026-08-18T10:00:00.000Z",
      acceptedBy: "local-human",
    };
    const queue = computeQueue({
      notes: [{ path: "n.md", content: blessed.replace("appends", "all") }],
      getBaseline: () => baseline,
      journal: [],
    });
    assert.equal(queue.length, 0);
  });

  test("no baseline → nothing blessed to drift from → no side-door row", () => {
    const queue = computeQueue({
      notes: [{ path: "n.md", content: blessed }],
      getBaseline: () => null,
      journal: [],
      protectedDrift: protectedPropertyDrift,
    });
    assert.equal(queue.length, 0);
  });
});

describe("the HONOR-RULE SCENARIO — side-door writes are inert until blessed", () => {
  // The reconciler's decision pieces, driven exactly as wiring.ts drives them:
  // classifyModify picks the class; only "human" advances the baseline silently;
  // maybeAutoAccept derives the policy from the BASELINE content.
  const before = "---\ntitle: T\n---\nlog\n";
  const sideDoor = "---\ntitle: T\nauto-accept: all\n---\nlog\n";

  test("side-door write: ambiguous → no silent advance → policy NOT honored → agent writes stay pending", () => {
    // 1. A non-journaled, non-human write lands auto-accept: all in the bytes.
    const cls = classifyModify({ recentAgentWrite: false, recentGenuineHumanInput: false });
    assert.equal(cls, "ambiguous");
    assert.equal(shouldAdvanceBaselineSilently(cls), false, "the reconciler must not bless it");
    // 2. The baseline is still `before`; the policy read (wiring reads
    //    baseline.content) confers nothing.
    assert.equal(autoAcceptPolicyOf(before), null);
    // 3. So an agent-attributed change does NOT auto-accept off the raw bytes.
    const r = evaluate(before, sideDoor + "agent line\n", {
      enabled: [],
      policy: autoAcceptPolicyOf(before),
    });
    assert.equal(r.eligible, false, "raw frontmatter must never be honored unblessed");
  });

  test("human-attributed edit: classify → silent advance → the SAME value is now honored", () => {
    const cls = classifyModify({ recentAgentWrite: false, recentGenuineHumanInput: true });
    assert.equal(shouldAdvanceBaselineSilently(cls), true);
    // wiring.ts: setBaseline(path, current) — the blessed content is now sideDoor.
    assert.equal(autoAcceptPolicyOf(sideDoor), "all");
    const r = evaluate(sideDoor, sideDoor + "agent line\n", { enabled: [], policy: autoAcceptPolicyOf(sideDoor) });
    assert.equal(r.eligible, true);
    assert.equal(r.policy, "all");
  });

  test("accept in review: baseline advance covering the write blesses it identically", () => {
    // performAccept → acceptNote → store.setBaseline(path, current): blessed
    // content becomes the reviewed bytes. The policy read flips from null to
    // honored at exactly that boundary — no other path does.
    assert.equal(autoAcceptPolicyOf(before), null);
    const blessedAfterAccept = sideDoor; // what setBaseline stored
    assert.equal(autoAcceptPolicyOf(blessedAfterAccept), "all");
  });
});
