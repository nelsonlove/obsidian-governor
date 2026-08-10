/**
 * conformance-pack-drift.test.mjs — the drift_audit rule pack (note-only
 * checks E/F/G), a faithful TS port of drift_audit.py.
 *
 * Ratchet key parity is the load-bearing bit, and E/F are SPECIAL-CASED by the
 * ratchet's `parse_drift` (they are not the generic form):
 *   E → ("drift_audit", "E", <uid>,           "dup-uid")   — keyed on the uid
 *   F → ("drift_audit", "F", "uid-coverage",  "uid-less")  — count-independent
 *   G → ("drift_audit", "G", <message rest>,  "")          — generic form
 * F being count-independent matters: the message carries a changing count and
 * a 5-note sample, so keying on the message would churn the baseline on every
 * new gap. One finding, one stable key.
 *
 * Scope (drift_audit.py `iter_notes`): governed notes only — no dot/.trash
 * segments, no `_`-prefixed root, no `Assent/` root.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { driftPack } from "../src/conformance/packs/drift.ts";

const REG = "00-09 System/00 System management/00.05 Registries for the system";
const note = (path, frontmatter = {}, text = "") => ({ path, frontmatter, body: text, text });
const run = (notes) => driftPack().run({ notes, paths: notes.map((n) => n.path), sources: notes });
const U1 = "019fe4e8-cac4-75de-aa1d-4f54d1382cbe";
const U2 = "019fe8d5-542c-72ce-853f-f4fb6bf72ffd";

describe("driftPack — E (duplicate uid)", () => {
  test("two notes sharing a uid produce one finding keyed on the uid", () => {
    const f = run([note("A.md", { uid: U1 }), note("B.md", { uid: U1 })]);
    const e = f.filter((x) => x.check === "E");
    assert.equal(e.length, 1);
    assert.equal(e[0].script, "drift_audit");
    assert.equal(e[0].target, U1, "target is the uid (ratchet parse_drift)");
    assert.equal(e[0].kind, "dup-uid");
    assert.match(e[0].detail, /claimed by 2 notes/);
  });

  test("distinct uids produce no E finding", () => {
    assert.deepEqual(run([note("A.md", { uid: U1 }), note("B.md", { uid: U2 })]).filter((x) => x.check === "E"), []);
  });

  test("a non-UUID uid is not identity — it counts as uid-less, not a duplicate", () => {
    const f = run([note("A.md", { uid: "not-a-uuid" }), note("B.md", { uid: "not-a-uuid" })]);
    assert.deepEqual(f.filter((x) => x.check === "E"), []);
    assert.equal(f.filter((x) => x.check === "F").length, 1);
  });
});

describe("driftPack — F (uid coverage)", () => {
  test("uid-less notes aggregate into ONE finding with a count-independent key", () => {
    const f = run([note("A.md"), note("B.md"), note("C.md", { uid: U1 })]).filter((x) => x.check === "F");
    assert.equal(f.length, 1);
    assert.equal(f[0].target, "uid-coverage");
    assert.equal(f[0].kind, "uid-less");
    assert.match(f[0].detail, /2 note\(s\) lack a usable uid/);
  });

  test("the key does not change when the count does (baseline stability)", () => {
    const two = run([note("A.md"), note("B.md")]).find((x) => x.check === "F");
    const three = run([note("A.md"), note("B.md"), note("C.md")]).find((x) => x.check === "F");
    assert.equal(`${two.target}|${two.kind}`, `${three.target}|${three.kind}`);
  });

  test("the daily-note template is uid-exempt (its empty uid is copy payload)", () => {
    const exempt = `${REG}/Daily notes/Daily note.template.md`;
    assert.deepEqual(run([note(exempt), note("A.md", { uid: U1 })]).filter((x) => x.check === "F"), []);
  });

  test("all notes carrying a uid ⇒ no F finding", () => {
    assert.deepEqual(run([note("A.md", { uid: U1 })]).filter((x) => x.check === "F"), []);
  });
});

describe("driftPack — G (registry naming self-consistency)", () => {
  test("an action whose title disagrees with the filename is flagged", () => {
    const p = `${REG}/Action registry/Action/stamp.action.md`;
    const f = run([note(p, { title: "wrong" }, "# `stamp`\n")]).filter((x) => x.check === "G");
    assert.equal(f.length, 1);
    assert.match(f[0].target, /stamp\.action\.md title is 'wrong'/);
    assert.equal(f[0].kind, "", "G uses the generic key form");
  });

  test("a property's title must be backticked (`key`), unlike action/type", () => {
    const p = `${REG}/Meta registry/Property/uid.property.md`;
    assert.deepEqual(run([note(p, { title: "`uid`" })]).filter((x) => x.check === "G"), []);
    assert.equal(run([note(p, { title: "uid" })]).filter((x) => x.check === "G").length, 1);
  });

  test("an action's H1 must be the backticked key; a mismatch is flagged", () => {
    const p = `${REG}/Action registry/Action/stamp.action.md`;
    const f = run([note(p, { title: "stamp.action" }, "# wrong-h1\n")]).filter((x) => x.check === "G");
    assert.equal(f.length, 1);
    assert.match(f[0].target, /H1 is 'wrong-h1'/);
  });

  test("a tag entry's title must equal the filename stem", () => {
    const p = `${REG}/Meta registry/meta.tag/type.tag.md`;
    assert.deepEqual(run([note(p, { title: "type.tag" })]).filter((x) => x.check === "G"), []);
    assert.equal(run([note(p, { title: "type" })]).filter((x) => x.check === "G").length, 1);
  });

  test("registry naming is checked only under the registries root", () => {
    assert.deepEqual(run([note("Elsewhere/stamp.action.md", { title: "wrong" })]).filter((x) => x.check === "G"), []);
  });
});

describe("driftPack — scope (iter_notes parity)", () => {
  test("dot/.trash segments, `_` roots and Assent/ are out of scope", () => {
    const out = [
      note(".obsidian/x.md"),
      note(".trash/y.md"),
      note("_keep/z.md"),
      note("Assent/1. Mission.md"),
    ];
    assert.deepEqual(run(out), []);
  });

  test("non-markdown notes are out of scope (the Python walks *.md)", () => {
    assert.deepEqual(run([note("Reg/X.fileclass")]), []);
  });
});
