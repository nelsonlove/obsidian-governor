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
} from "../src/governor/kernel/protected-policy.ts";
import { evaluate } from "../src/governor/kernel/auto-accept/eligibility.ts";
import { autoAcceptRecord } from "../src/governor/kernel/auto-accept/eligibility.ts";
import { DEFAULT_ALLOWLIST } from "../src/governor/kernel/auto-accept/classes.ts";
import { computeQueue } from "../src/governor/kernel/queue.ts";
import { classifyModify, shouldAdvanceBaselineSilently } from "../src/governor/kernel/classify.ts";
import { contentHash } from "../src/governor/kernel/hash.ts";
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

describe("autoAcceptPolicyOf — RETIRED (WP10c): a badge, never a grant", () => {
  test("appends still parses (display + drift protection); ALL no longer parses AT ALL", () => {
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: appends\n---\n"), "appends");
    assert.equal(autoAcceptPolicyOf("---\nauto_accept: Appends\n---\n"), "appends");
    // The guide's order, literal: delete the `all` policy. Even a blessed
    // `all` reads as NO policy — under any authority era, including a
    // post-rollback legacy one. The blank check does not come back.
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: ALL\n---\n"), null);
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: all\n---\n"), null);
  });

  test("anything else is NO policy", () => {
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: everything\n---\n"), null);
    assert.equal(autoAcceptPolicyOf("---\nauto-accept: [appends]\n---\n"), null);
    assert.equal(autoAcceptPolicyOf("---\ntitle: x\n---\n"), null);
    assert.equal(autoAcceptPolicyOf(null), null);
  });
});

describe("eligibility — the policy arms are DELETED (WP10c; condition 9's subset assertion)", () => {
  const base = "---\nauto-accept: appends\n---\nlog\n";

  // CONDITION 9, in behavior: for every legacy policy value, the set of
  // auto-acceptable changes is now a SUBSET of what it was — because the
  // policy arms conferred eligibility and now nothing does. Each case below
  // was ELIGIBLE pre-WP10c solely because of its policy; each must now stay
  // pending. (evaluate's ctx no longer has a policy field; passing one is an
  // ignored extra property, which the last leg pins.)
  test("a pure append on an appends note is RESIDUAL now — content proposes", () => {
    const r = evaluate(base, base + "new line\n", { enabled: ALL });
    assert.equal(r.eligible, false);
    assert.match(r.reason, /^body:/, "the tail is a body residual, whatever the strict evaluator names it");
  });

  test("an arbitrary rewrite on an `all` note stays pending — the blank check is dead", () => {
    const cur = "---\nauto-accept: all\ntotally: rewritten\n---\ndifferent\n";
    const r = evaluate(base, cur, { enabled: ALL });
    assert.equal(r.eligible, false);
  });

  test("class-driven accepts are UNCHANGED — the subset kept everything the classes granted", () => {
    const b = "---\ntitle: N\n---\nbody\n";
    const c = "---\ntitle: N\nuid: 019fea8c-2093-758a-8da2-e8dbcddda6b4\n---\nbody\n";
    const r = evaluate(b, c, { enabled: ALL });
    assert.equal(r.eligible, true, r.reason);
    assert.deepEqual(r.classes, ["uid-stamp"]);
  });

  test("a smuggled legacy `policy` context field is IGNORED — no caller can re-arm the arms", () => {
    const withAll = evaluate(base, base + "x\n", { enabled: ALL, policy: "all" });
    assert.equal(withAll.eligible, false, "policy: 'all' in the ctx confers nothing");
    const withAppends = evaluate(base, base + "x\n", { enabled: ALL, policy: "appends" });
    assert.equal(withAppends.eligible, false, "policy: 'appends' in the ctx confers nothing");
  });

  test("results carry no policy field — nothing downstream can act on one", () => {
    const b = "---\ntitle: N\n---\nbody\n";
    const c = "---\ntitle: N\nuid: 019fea8c-2093-758a-8da2-e8dbcddda6b4\n---\nbody\n";
    const r = evaluate(b, c, { enabled: ALL });
    assert.equal("policy" in r, false);
  });
});

describe("#261 composition — RETIRED with the appends policy (WP10c)", () => {
  const RENAMED = { confirms: (from, to) => from === "Vault machinery" && to === "00.16 Vault machinery" };
  // The live repro's shape, miniaturized byte-for-byte in kind:
  const base =
    "---\nname: CROSS-SESSION\nmodified: 2026-08-19T01:37\nauto-accept: appends\n---\n" +
    "# Log\n\nSee the [[Vault machinery]] index.\n";
  const cur =
    "---\nname: CROSS-SESSION\nmodified: 2026-08-19T06:40\nauto-accept: appends\n---\n" +
    "# Log\n\nSee the [[00.16 Vault machinery]] index.\n\n## probe append\n\nentry body\n";

  test("the #261 composed case (classes + appended tail) now stays PENDING — the tail is residual content", () => {
    const r = evaluate(base, cur, { enabled: ALL, renameIndex: RENAMED });
    assert.equal(r.eligible, false, "the composed accept died with the policy; the wedge cannot recur because nothing waits on a policy-accept");
  });

  test("the class-only halves still work exactly as before: timestamp + confirmed link-heal WITHOUT a tail → eligible", () => {
    const noTail =
      "---\nname: CROSS-SESSION\nmodified: 2026-08-19T06:40\nauto-accept: appends\n---\n" +
      "# Log\n\nSee the [[00.16 Vault machinery]] index.\n";
    const r = evaluate(base, noTail, { enabled: ALL, renameIndex: RENAMED });
    assert.equal(r.eligible, true, r.reason);
    assert.deepEqual(r.classes, ["timestamp", "link-heal"]);
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

  test("the textual fallback is scoped to the frontmatter BLOCK — a body mention surfaces nothing", () => {
    const brokenBodyMention = "---\n\t: broken\ntitle: T\n---\nprose about auto-accept in the body\n";
    assert.deepEqual(protectedPropertyDrift("---\ntitle: T\n---\n", brokenBodyMention), []);
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

  test("human-attributed edit: the silent advance still blesses — but a blessed `all` is STILL no policy (WP10c)", () => {
    const cls = classifyModify({ recentAgentWrite: false, recentGenuineHumanInput: true });
    assert.equal(shouldAdvanceBaselineSilently(cls), true);
    // wiring.ts: setBaseline(path, current) — the blessed content is now
    // sideDoor. Pre-WP10c this leg proved the honor-boundary ARMS the
    // policy; post-WP10c the stronger fact holds: even blessing cannot
    // resurrect `all` — the deletion is at the parser, upstream of honor.
    assert.equal(autoAcceptPolicyOf(sideDoor), null);
    const r = evaluate(sideDoor, sideDoor + "agent line\n", { enabled: [] });
    assert.equal(r.eligible, false, "nothing auto-accepts on an `all` note, blessed or not");
  });

  test("accept in review: blessing still flips honor for APPENDS' badge; `all` stays dead through every door (WP10c)", () => {
    // performAccept → acceptNote → store.setBaseline(path, current): blessed
    // content becomes the reviewed bytes. Post-WP10c the honor boundary only
    // matters for the appends BADGE — and `all` reads as no policy on both
    // sides of it, because the deletion is at the parser.
    assert.equal(autoAcceptPolicyOf(before), null);
    const blessedAfterAccept = sideDoor; // what setBaseline stored
    assert.equal(autoAcceptPolicyOf(blessedAfterAccept), null, "blessed `all` is still nothing");
    const appendsNote = "---\nauto-accept: appends\ntitle: T\n---\nbody\n";
    assert.equal(autoAcceptPolicyOf(appendsNote), "appends", "the appends badge still honors — display only");
  });
});
