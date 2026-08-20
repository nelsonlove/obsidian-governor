/**
 * operations-observations.test.mjs — WP2, Gate 0.
 *
 * An observation is what Governor RETURNED after enforcing the read boundary.
 * Three levels, and the whole design turns on the difference between them:
 *
 *   ephemeral   nothing retained. Cannot support anything.
 *   evidence    identities, source state, response digest, shape, omissions,
 *               truncation, availability — but not the payload.
 *   replayable  all of that plus the exact bytes Governor returned.
 *
 * D16 settles the defaults; this file pins them, and pins the rule that gives
 * them teeth: an ephemeral observation can never support a proposal, a
 * verification result, or an admission. Governor re-observes durably instead.
 *
 * Why that rule matters more than it looks: without it, "this change was based
 * on what I read" degrades into an assertion nobody can check. The point of
 * capturing reads at all is that a reviewer can see what the agent was
 * actually shown — and a level that retains nothing cannot deliver that, no
 * matter how confidently a later claim cites it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_LEVELS,
  atLeast,
  decideCapture,
  strongestOf,
} from "../src/kernel/observations/capture-policy.ts";
import { validateDependencies, DEPENDENCY_PROBLEMS } from "../src/kernel/observations/dependencies.ts";
import { buildObservation, redactForCapture, payloadDigest } from "../src/kernel/observations/observation.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

function action(over = {}) {
  return {
    id: "note.read",
    modes: ["read"],
    observations: { defaultCapture: "evidence", supportsProposal: true },
    ...over,
  };
}

const GOVERNED = { id: "session-1", governed: true };
const ADHOC = null;

// ── the ordering that makes "at least" meaningful ────────────────────────────

describe("capture levels — ordering", () => {
  test("the three levels are ordered weakest to strongest", () => {
    assert.deepEqual([...CAPTURE_LEVELS], ["ephemeral", "evidence", "replayable"]);
  });

  test("atLeast compares by strength, not alphabetically", () => {
    assert.equal(atLeast("replayable", "evidence"), true);
    assert.equal(atLeast("evidence", "replayable"), false);
    assert.equal(atLeast("evidence", "evidence"), true);
    // Alphabetically "ephemeral" < "evidence" < "replayable" happens to agree,
    // which is exactly why it is worth asserting the comparison is by strength.
    assert.equal(atLeast("ephemeral", "evidence"), false);
  });

  test("strongestOf picks the strongest requirement, never the caller's preference", () => {
    assert.equal(strongestOf("ephemeral", "replayable", "evidence"), "replayable");
    assert.equal(strongestOf("ephemeral"), "ephemeral");
  });
});

// ── D16's default table ──────────────────────────────────────────────────────

describe("capture policy — D16 defaults", () => {
  test("a substantive vault read in a governed session is replayable", () => {
    const { level } = decideCapture({ action: action(), session: GOVERNED, substantive: true });
    assert.equal(level, "replayable");
  });

  test("the same read outside a governed session is evidence", () => {
    const { level } = decideCapture({ action: action(), session: ADHOC, substantive: true });
    assert.equal(level, "evidence");
  });

  test("plumbing is ephemeral even inside a governed session", () => {
    const plumbing = action({ id: "connection.handshake", observations: { defaultCapture: "ephemeral", supportsProposal: false } });
    const { level } = decideCapture({ action: plumbing, session: GOVERNED, substantive: false });
    assert.equal(level, "ephemeral");
  });

  test("a verification or authority input is replayable regardless of session", () => {
    const verify = action({ id: "verify.schema", modes: ["read"], observations: { defaultCapture: "evidence", supportsProposal: true } });
    const { level } = decideCapture({ action: verify, session: ADHOC, substantive: false, supportingAuthority: true });
    assert.equal(level, "replayable");
  });

  test("every decision states its reason, so a receipt can explain itself", () => {
    const { reason } = decideCapture({ action: action(), session: GOVERNED, substantive: true });
    assert.ok(reason.length > 10);
  });
});

// ── a caller may strengthen, never weaken ────────────────────────────────────

describe("capture policy — a caller cannot weaken the level", () => {
  test("a caller may request a STRONGER level", () => {
    const { level } = decideCapture({ action: action(), session: ADHOC, substantive: true, requested: "replayable" });
    assert.equal(level, "replayable");
  });

  test("a caller requesting a WEAKER level is ignored", () => {
    const { level, requestedIgnored } = decideCapture({
      action: action(),
      session: GOVERNED,
      substantive: true,
      requested: "ephemeral",
    });
    assert.equal(level, "replayable", "the policy floor wins");
    assert.equal(requestedIgnored, true, "and the receipt says the request was ignored, rather than silently dropping it");
  });

  test("an authority-supporting read cannot be talked down to evidence", () => {
    const { level } = decideCapture({
      action: action(),
      session: GOVERNED,
      substantive: true,
      supportingAuthority: true,
      requested: "evidence",
    });
    assert.equal(level, "replayable");
  });
});

// ── the rule with teeth ──────────────────────────────────────────────────────

describe("observation dependencies — ephemeral supports nothing", () => {
  const evidenceObs = { id: "obs-1", level: "evidence", sessionId: "session-1", sourceState: [], result: { truncated: false, unavailable: [] } };
  const replayObs = { ...evidenceObs, id: "obs-2", level: "replayable", result: { truncated: false, unavailable: [], payloadObject: "sha256:abc" } };

  test("a proposal may depend on evidence or replayable observations", () => {
    for (const obs of [evidenceObs, replayObs]) {
      const problems = validateDependencies({ observations: [obs], claim: "proposal", sessionId: "session-1" });
      assert.deepEqual(problems, []);
    }
  });

  test("a proposal may NOT depend on an ephemeral observation", () => {
    const ephemeral = { ...evidenceObs, id: "obs-3", level: "ephemeral" };
    const problems = validateDependencies({ observations: [ephemeral], claim: "proposal", sessionId: "session-1" });
    assert.deepEqual(problems.map((p) => p.code), ["ephemeral_dependency"]);
  });

  for (const claim of ["proposal", "verification", "admission"]) {
    test(`an ephemeral observation is refused for a ${claim}`, () => {
      const ephemeral = { ...evidenceObs, level: "ephemeral" };
      const problems = validateDependencies({ observations: [ephemeral], claim, sessionId: "session-1" });
      assert.ok(problems.some((p) => p.code === "ephemeral_dependency"));
    });
  }

  test("a verification requires REPLAYABLE, not merely evidence", () => {
    // A verifier compares content. Evidence retains a digest and a shape, not
    // the bytes — so it can prove that something was read, never what it said.
    const problems = validateDependencies({ observations: [evidenceObs], claim: "verification", sessionId: "session-1" });
    assert.deepEqual(problems.map((p) => p.code), ["insufficient_capture"]);
  });

  test("an observation from a DIFFERENT session is refused", () => {
    const problems = validateDependencies({ observations: [replayObs], claim: "proposal", sessionId: "other-session" });
    assert.deepEqual(problems.map((p) => p.code), ["foreign_session"]);
  });

  test("a truncated observation cannot support a claim that needs the whole result", () => {
    const truncated = { ...replayObs, result: { truncated: true, unavailable: [], payloadObject: "sha256:abc" } };
    const problems = validateDependencies({ observations: [truncated], claim: "verification", sessionId: "session-1" });
    assert.ok(problems.some((p) => p.code === "truncated_dependency"));
  });

  test("an observation whose source was unavailable is refused", () => {
    // "Absence is not emptiness": a read that could not reach one of its
    // sources returned a partial answer, and a claim built on it would be a
    // claim about a vault that was never fully seen.
    const partial = { ...replayObs, result: { truncated: false, unavailable: ["dataview"], payloadObject: "sha256:abc" } };
    const problems = validateDependencies({ observations: [partial], claim: "proposal", sessionId: "session-1" });
    assert.ok(problems.some((p) => p.code === "unavailable_source"));
  });

  test("no observations at all is refused for a claim that requires support", () => {
    const problems = validateDependencies({ observations: [], claim: "verification", sessionId: "session-1" });
    assert.deepEqual(problems.map((p) => p.code), ["no_dependencies"]);
  });

  test("every problem code is documented", () => {
    for (const code of Object.keys(DEPENDENCY_PROBLEMS)) {
      assert.ok(DEPENDENCY_PROBLEMS[code].length > 20, `${code} needs a real explanation`);
    }
  });
});

// ── scope and redaction happen BEFORE capture ────────────────────────────────

describe("observations — filtered before capture, never after", () => {
  test("a replayable payload is redacted before it is stored", () => {
    // The order is the control. Capturing first and redacting later means the
    // unredacted bytes existed in the store, however briefly — and a retention
    // policy cannot un-write them.
    const { payload, redactions } = redactForCapture(
      { path: "A.md", body: "token=SECRET", meta: { apiKey: "SECRET" } },
      { redactKeys: ["apiKey"] }
    );
    assert.equal(payload.meta.apiKey, "<redacted>");
    assert.equal(payload.body, "token=SECRET", "only declared keys are redacted; content is not guessed at");
    assert.deepEqual(redactions, ["meta.apiKey"]);
  });

  test("redaction is recorded, so a reviewer knows something was withheld", () => {
    const { redactions } = redactForCapture({ a: 1, secret: "x" }, { redactKeys: ["secret"] });
    assert.deepEqual(redactions, ["secret"]);
  });

  test("nothing to redact leaves the payload untouched and says so", () => {
    const input = { a: 1 };
    const { payload, redactions } = redactForCapture(input, { redactKeys: ["secret"] });
    assert.deepEqual(payload, input);
    assert.deepEqual(redactions, []);
  });
});

// ── the observation record ───────────────────────────────────────────────────

describe("observations — the record", () => {
  const base = {
    id: "obs-1",
    operationId: "op-1",
    action: { id: "note.read", version: 1 },
    capturedAt: 1_700_000_000_000,
    actorBinding: "conn-1",
    sessionId: "session-1",
    normalizedRequestDigest: "fnv1a64:aaaa",
    effectiveScopeDigest: "fnv1a64:bbbb",
    sourceState: [{ identity: "uid-1", path: "A.md", revision: "7", contentDigest: "sha256:cc" }],
  };

  test("an ephemeral observation retains no payload and no digest", () => {
    const obs = buildObservation({ ...base, level: "ephemeral", payload: { body: "secret" } });
    assert.equal(obs, null, "an ephemeral observation is not a record at all — there is nothing to keep");
  });

  test("an evidence observation keeps the shape but not the bytes", () => {
    const obs = buildObservation({ ...base, level: "evidence", payload: { body: "the note text" } });
    assert.equal(obs.level, "evidence");
    assert.ok(obs.result.digest.startsWith("sha256:"));
    assert.equal(obs.result.payloadObject, null, "evidence does not retain the payload");
    assert.ok(!JSON.stringify(obs).includes("the note text"));
  });

  test("a replayable observation names a content-addressed object, not inline bytes", () => {
    const obs = buildObservation({
      ...base,
      level: "replayable",
      payload: { body: "the note text" },
      payloadObject: "sha256:deadbeef",
    });
    assert.equal(obs.level, "replayable");
    assert.equal(obs.result.payloadObject, "sha256:deadbeef");
    assert.ok(!JSON.stringify(obs).includes("the note text"), "the record references the payload; it does not embed it");
  });

  test("a replayable observation without a stored object is refused", () => {
    // Claiming replayability with nothing to replay is the exact overclaim
    // this whole level exists to prevent.
    assert.throws(
      () => buildObservation({ ...base, level: "replayable", payload: { body: "x" } }),
      /payloadObject/
    );
  });
});

// ── the digest must distinguish what was returned ────────────────────────────

describe("observations — the payload digest is content-sensitive", () => {
  test("two DIFFERENT payloads of the same length digest differently", () => {
    // The operation-identity normalizer collapses long strings to `<N chars>`,
    // which is right for keeping note bodies out of a metadata record and
    // catastrophic here: distinguishing what was returned is most of what an
    // evidence-level observation is FOR. Measured before fixing — these two
    // digested identically under the truncating normalizer.
    const a = payloadDigest({ body: "A".repeat(500) });
    const b = payloadDigest({ body: "B".repeat(500) });
    assert.notEqual(a, b);
  });

  test("the same payload digests identically regardless of key order", () => {
    assert.equal(payloadDigest({ a: 1, b: 2 }), payloadDigest({ b: 2, a: 1 }));
  });

  test("it is a cryptographic digest, because this one has an adversary", () => {
    // An agent that could collide two payloads could make a proposal cite
    // evidence of having read something other than what it read.
    assert.match(payloadDigest({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
  });

  test("an evidence record still embeds no content", () => {
    const obs = buildObservation({
      id: "o", operationId: "op", action: { id: "a", version: 1 }, capturedAt: 0,
      level: "evidence", actorBinding: "c", normalizedRequestDigest: "x",
      effectiveScopeDigest: "y", sourceState: [], payload: { body: "SENSITIVE-TEXT" },
    });
    assert.ok(!JSON.stringify(obs).includes("SENSITIVE-TEXT"));
  });
});
