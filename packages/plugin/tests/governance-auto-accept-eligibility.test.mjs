// Ported from obsidian-stewardship/tests/auto-accept-eligibility.test.mjs (#83, cycle 1) —
// the eligibility predicate, now at src/governor/kernel/auto-accept/eligibility.ts. The
// conjunctive-per-write composition, the allowlist gate, the rail-clean gate + pluggable seam,
// and the audit record. The predicate reads ONLY the objective bytes (+ rename index): no
// agent-supplied field can influence it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, evaluateRail, autoAcceptRecord } from "../src/governor/kernel/auto-accept/eligibility.ts";
import { AUTHORIZED_CLASSES, DEFAULT_ALLOWLIST } from "../src/governor/kernel/auto-accept/classes.ts";

const UID = "019fea8c-2093-758a-8da2-e8dbcddda6b4";
const ALL = [...DEFAULT_ALLOWLIST];
const CONFIRM_OLD_NEW = { confirms: (from, to) => from === "Old" && to === "New" };

// ---------------------------------------------------------------------------
// single-class eligibility
// ---------------------------------------------------------------------------
test("pure uid-stamp → eligible, classes=[uid-stamp]", () => {
  const base = `---\ntitle: N\n---\nbody\n`;
  const cur = `---\ntitle: N\nuid: ${UID}\n---\nbody\n`;
  const r = evaluate(base, cur, { enabled: ALL });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.classes, ["uid-stamp"]);
  assert.equal(r.rail.clean, true);
});

// ---------------------------------------------------------------------------
// composition — a genuine multi-class mechanical write auto-accepts
// ---------------------------------------------------------------------------
test("all four classes at once → eligible, all four classes matched, rail clean", () => {
  const base = `---\ntitle: T\nalpha: 1\nmodified: 2026-01-01\n---\nbody [[Old]]\n`;
  const cur = `---\nuid: ${UID}\nalpha: 1\ntitle: T\nmodified: 2026-08-10\n---\nbody [[New]]\n`;
  const r = evaluate(base, cur, { enabled: ALL, renameIndex: CONFIRM_OLD_NEW });
  assert.equal(r.eligible, true, r.reason);
  assert.deepEqual(r.classes, ["uid-stamp", "timestamp", "canonical-order", "link-heal"]);
  assert.equal(r.rail.clean, true);
  assert.ok(r.rail.results.every((x) => x.byConstruction === true), "all four rail-neutral by construction");
});

// ---------------------------------------------------------------------------
// CONJUNCTIVE-PER-WRITE — a mechanical stamp mixed with ANY content edit stays pending
// ---------------------------------------------------------------------------
test("uid-stamp mixed with a body edit → NOT eligible (whole write pending)", () => {
  const base = `---\ntitle: N\n---\nhello world\n`;
  const cur = `---\ntitle: N\nuid: ${UID}\n---\nhello CRUEL world\n`;
  const r = evaluate(base, cur, { enabled: ALL });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.classes, []);
});

test("timestamp mixed with another frontmatter value change → NOT eligible", () => {
  const base = `---\nstatus: draft\nmodified: 2026-01-01\n---\nbody\n`;
  const cur = `---\nstatus: final\nmodified: 2026-08-10\n---\nbody\n`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, false);
});

test("link-heal to an UNCONFIRMED target → NOT eligible", () => {
  const base = `See [[Old]].\n`;
  const cur = `See [[Nope]].\n`;
  assert.equal(evaluate(base, cur, { enabled: ALL, renameIndex: CONFIRM_OLD_NEW }).eligible, false);
});

// ---------------------------------------------------------------------------
// allowlist gate — disabling a class makes its changes stay pending
// ---------------------------------------------------------------------------
test("disabling uid-stamp → an otherwise-pure uid add stays pending", () => {
  const base = `---\ntitle: N\n---\nbody\n`;
  const cur = `---\ntitle: N\nuid: ${UID}\n---\nbody\n`;
  const enabled = ALL.filter((c) => c !== "uid-stamp");
  assert.equal(evaluate(base, cur, { enabled }).eligible, false);
});

test("empty allowlist → nothing is eligible", () => {
  const base = `---\ntitle: N\n---\nbody\n`;
  const cur = `---\ntitle: N\nuid: ${UID}\n---\nbody\n`;
  assert.equal(evaluate(base, cur, { enabled: [] }).eligible, false);
});

test("a multi-class write is ineligible if ANY of its classes is disabled (conjunctive)", () => {
  // uid + reorder, but canonical-order disabled → the reorder is an unexplained residual → pending.
  const base = `---\nalpha: 1\nbeta: 2\n---\nbody\n`;
  const cur = `---\nbeta: 2\nalpha: 1\nuid: ${UID}\n---\nbody\n`;
  const enabled = ["uid-stamp", "timestamp", "link-heal"];
  assert.equal(evaluate(base, cur, { enabled }).eligible, false);
});

// ---------------------------------------------------------------------------
// CONTENT-SMUGGLE regression (against the real evaluate, full allowlist)
// ---------------------------------------------------------------------------
test("SMUGGLE: leading bare line + valid uid → evaluate NOT eligible (the review repro)", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\nSMUGGLED EVIL CONTENT\ntitle: X\nuid: ${UID}\n---\nbody`;
  const r = evaluate(base, cur, { enabled: ALL, renameIndex: CONFIRM_OLD_NEW });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.classes, []);
});

test("SMUGGLE: leading bare line + valid modified → evaluate NOT eligible", () => {
  const base = `---\nmodified: 2026-01-01\n---\nbody`;
  const cur = `---\nSMUGGLED\nmodified: 2026-08-10\n---\nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, false);
});

test("SMUGGLE: content after the last key before the closing fence + uid → NOT eligible", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\ntitle: X\nuid: ${UID}\nSMUGGLED TRAILING CONTENT\n---\nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, false);
});

test("FENCE residual: trailing whitespace added to the CLOSING fence + uid → NOT eligible", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\ntitle: X\nuid: ${UID}\n---   \nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, false);
});

test("FENCE residual: trailing whitespace added to the OPENING fence + uid → NOT eligible", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---   \ntitle: X\nuid: ${UID}\n---\nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, false);
});

test("FENCE: an UNCHANGED fence still auto-accepts a genuine uid stamp", () => {
  const base = `---\ntitle: X\n---\nbody`;
  const cur = `---\ntitle: X\nuid: ${UID}\n---\nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, true);
});

test("FENCE: a pre-existing trailing-whitespace fence UNCHANGED across the stamp still auto-accepts", () => {
  // The whitespace was already in the accepted baseline and did not change → not a residual.
  const base = `---\ntitle: X\n---   \nbody`;
  const cur = `---\ntitle: X\nuid: ${UID}\n---   \nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, true);
});

test("FENCE: creating frontmatter with a non-canonical (trailing-ws) closing fence → NOT eligible", () => {
  const base = `# Note\nbody`;
  const cur = `---\nuid: ${UID}\n---   \n# Note\nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, false);
});

test("FENCE: creating frontmatter with clean canonical fences (first uid stamp) → eligible", () => {
  const base = `# Note\nbody`;
  const cur = `---\nuid: ${UID}\n---\n# Note\nbody`;
  assert.equal(evaluate(base, cur, { enabled: ALL }).eligible, true);
});

// ---------------------------------------------------------------------------
// no-change / residual fail-safe
// ---------------------------------------------------------------------------
test("identical content → not eligible (no-change)", () => {
  const s = `---\nuid: ${UID}\n---\nbody\n`;
  assert.equal(evaluate(s, s, { enabled: ALL }).reason, "no-change");
});

test("a change with no attributable class (e.g. plain body edit) → not eligible", () => {
  const base = `plain body\n`;
  const cur = `plain body edited\n`;
  const r = evaluate(base, cur, { enabled: ALL, renameIndex: CONFIRM_OLD_NEW });
  assert.equal(r.eligible, false);
});

// ---------------------------------------------------------------------------
// advisory-agent-text independence — the predicate has NO agent-field input at all
// ---------------------------------------------------------------------------
test("eligibility is a pure function of bytes — identical bytes give identical verdict", () => {
  const base = `---\ntitle: N\n---\nbody\n`;
  const cur = `---\ntitle: N\nuid: ${UID}\n---\nbody\n`;
  const a = evaluate(base, cur, { enabled: ALL });
  const b = evaluate(base, cur, { enabled: ALL });
  assert.deepEqual(a, b);
  // The evaluate signature accepts NO intent / agent field: there is no channel by which agent
  // text could sway the verdict. (The static scan in governance-auto-accept-security.test.mjs
  // proves the module never references `intent`.)
});

// ---------------------------------------------------------------------------
// rail-clean gate + pluggable seam for FUTURE non-rail-neutral classes
// ---------------------------------------------------------------------------
test("evaluateRail: rail-neutral class is clean by construction with no railCheck", () => {
  const summary = evaluateRail(["uid-stamp"], "a", "b", {});
  assert.equal(summary.clean, true);
  assert.equal(summary.results[0].byConstruction, true);
});

test("evaluateRail: a NON-neutral class with NO railCheck → NOT clean (refused)", () => {
  const specFn = () => ({ id: "future", railNeutral: false, railNeutralBecause: "" });
  const summary = evaluateRail(["future"], "a", "b", {}, specFn);
  assert.equal(summary.clean, false);
});

test("evaluateRail: a NON-neutral class is clean ONLY when railCheck returns clean:true", () => {
  const specFn = () => ({ id: "future", railNeutral: false, railNeutralBecause: "" });
  const dirty = evaluateRail(["future"], "a", "b", { railCheck: () => ({ clean: false, findings: ["x"] }) }, specFn);
  assert.equal(dirty.clean, false);
  const clean = evaluateRail(["future"], "a", "b", { railCheck: () => ({ clean: true }) }, specFn);
  assert.equal(clean.clean, true);
  assert.equal(clean.results[0].byConstruction, false);
});

test("evaluateRail: a railCheck that THROWS → not clean (fail safe)", () => {
  const specFn = () => ({ id: "future", railNeutral: false, railNeutralBecause: "" });
  const summary = evaluateRail(["future"], "a", "b", { railCheck: () => { throw new Error("boom"); } }, specFn);
  assert.equal(summary.clean, false);
});

test("every AUTHORIZED class is rail-neutral (v1 assertion)", () => {
  for (const spec of AUTHORIZED_CLASSES) {
    assert.equal(spec.railNeutral, true, `${spec.id} must be rail-neutral by construction in v1`);
    assert.ok(spec.railNeutralBecause.length > 0, `${spec.id} must document WHY it is rail-neutral`);
  }
});

// ---------------------------------------------------------------------------
// audit record
// ---------------------------------------------------------------------------
test("autoAcceptRecord is loud + complete (path, hashes, classes, rail, ts, reason)", () => {
  const rec = autoAcceptRecord({
    ts: "2026-08-10T00:00:00.000Z",
    path: "Note.md",
    fromHash: "aaa",
    toHash: "bbb",
    classes: ["uid-stamp"],
    railResult: { clean: true, results: [{ class: "uid-stamp", clean: true, byConstruction: true }] },
  });
  assert.equal(rec.event, "auto-accept");
  assert.equal(rec.reason, "auto-accept");
  assert.equal(rec.path, "Note.md");
  assert.equal(rec.fromHash, "aaa");
  assert.equal(rec.toHash, "bbb");
  assert.deepEqual(rec.classes, ["uid-stamp"]);
  assert.equal(rec.railResult.clean, true);
});
