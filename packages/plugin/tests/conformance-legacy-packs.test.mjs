/**
 * conformance-legacy-packs.test.mjs — the three ported legacy rule packs:
 *   structure ← conformance_check.py   (blueprint conformance)
 *   port      ← port_lint.py           (stale cross-vault references)
 *   ste       ← ste_lint.py            (Simplified Technical English)
 *
 * Each pack maps its finding onto the canonical 4-tuple Finding whose key is
 * BYTE-IDENTICAL to conformance_ratchet.py's normalization, so the accepted-debt
 * baseline carries across the port. Those normalizations (the frozen contract):
 *   conformance_check DROPPED     → { check: "DROPPED",      target: path, kind: <bp basename> }
 *   conformance_check NO-BLUEPRINT→ { check: "NO-BLUEPRINT",  target: path, kind: <full wikilink inner> }
 *   port_lint                     → { check: <pattern name>, target: path, kind: <matched token> }
 *   ste_lint                      → { check: "editable",      target: path, kind: "<name> '<token.toLowerCase()>'" }
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { structurePack, portPack, stePack, DEFAULT_BLUEPRINT_ROOT } from "../src/conformance/packs/index.ts";

function snapshot({ sources = [], blueprints = [] } = {}) {
  return { notes: [], paths: sources.map((s) => s.path), sources, blueprints };
}

// ── structure pack (conformance_check) ────────────────────────────────────────

describe("structurePack (conformance_check)", () => {
  const ROOT = DEFAULT_BLUEPRINT_ROOT;
  const tagBp = { path: `${ROOT}/Tag/Tag.blueprint`, text: "---\nx: 1\n---\n## Purpose\n## Usage\n" };

  test("DROPPED: a note carrying an H2 its blueprint does not emit (kind = bp basename)", () => {
    const snap = snapshot({
      blueprints: [tagBp],
      sources: [{ path: "Notes/foo.tag.md", text: '---\nblueprint: "[[Tag.blueprint]]"\n---\n## Purpose\n## Rogue\n' }],
    });
    const f = structurePack().run(snap).find((x) => x.check === "DROPPED");
    assert.ok(f, "expected a DROPPED finding");
    assert.equal(f.script, "conformance_check");
    assert.equal(f.target, "Notes/foo.tag.md");
    assert.equal(f.kind, "Tag.blueprint"); // basename, as the ratchet keyed it
  });

  test("NO-BLUEPRINT: a note naming a nonexistent blueprint (kind = full wikilink inner)", () => {
    const snap = snapshot({
      blueprints: [tagBp],
      sources: [{ path: "Notes/bar.md", text: '---\nblueprint: "[[Sub/Missing.blueprint]]"\n---\n## X\n' }],
    });
    const f = structurePack().run(snap).find((x) => x.check === "NO-BLUEPRINT");
    assert.ok(f, "expected a NO-BLUEPRINT finding");
    assert.equal(f.target, "Notes/bar.md");
    assert.equal(f.kind, "Sub/Missing.blueprint"); // full inner text, not the basename
  });

  test("REFILL (emitted − note) is a warning only — not a finding", () => {
    const snap = snapshot({
      blueprints: [tagBp],
      sources: [{ path: "Notes/refill.md", text: '---\nblueprint: "[[Tag.blueprint]]"\n---\n## Purpose\n' }],
    });
    assert.deepEqual(structurePack().run(snap), []); // Usage is missing → REFILL, not emitted
  });

  test("a dynamic-H2 blueprint is SKIPPED — no DROPPED even with an extra note H2", () => {
    const dyn = { path: `${ROOT}/Dyn/Dyn.blueprint`, text: "---\n---\n## {{ title }}\n## Purpose\n" };
    const snap = snapshot({
      blueprints: [dyn],
      sources: [{ path: "Notes/dyn.md", text: '---\nblueprint: "[[Dyn.blueprint]]"\n---\n## Purpose\n## Rogue\n' }],
    });
    assert.deepEqual(structurePack().run(snap), []);
  });

  test("an open-ended (___REST___) blueprint preserves the body — no DROPPED", () => {
    const rest = {
      path: `${ROOT}/Area/Area.blueprint`,
      text: '---\n---\n## Purpose\n{% section "___REST___" %}\n## Default\n{% endsection %}\n',
    };
    const snap = snapshot({
      blueprints: [rest],
      sources: [{ path: "Notes/area.md", text: '---\nblueprint: "[[Area.blueprint]]"\n---\n## Purpose\n## Anything\n' }],
    });
    assert.deepEqual(structurePack().run(snap), []);
  });

  test("{% include %} counts the included H2s as emitted (not dropped)", () => {
    const header = { path: `${ROOT}/Default/header.blueprint`, text: "## Header\n" };
    const withInc = {
      path: `${ROOT}/Reg/Reg.blueprint`,
      text: `---\n---\n{% include "${ROOT}/Default/header.blueprint" %}\n## Body\n`,
    };
    const snap = snapshot({
      blueprints: [header, withInc],
      sources: [{ path: "Notes/reg.md", text: '---\nblueprint: "[[Reg.blueprint]]"\n---\n## Header\n## Body\n' }],
    });
    assert.deepEqual(structurePack().run(snap), []); // Header is emitted via the include
  });

  test("H2s inside a note's fenced code block are not counted (no false DROPPED)", () => {
    const snap = snapshot({
      blueprints: [{ path: `${ROOT}/Tag/Tag.blueprint`, text: "---\n---\n## Purpose\n" }],
      sources: [
        {
          path: "Notes/fence.md",
          text: '---\nblueprint: "[[Tag.blueprint]]"\n---\n## Purpose\n```\n## Fake\n```\n',
        },
      ],
    });
    assert.deepEqual(structurePack().run(snap), []);
  });

  test("a note with no blueprint frontmatter yields nothing", () => {
    const snap = snapshot({
      blueprints: [tagBp],
      sources: [{ path: "Notes/plain.md", text: "---\ntitle: Plain\n---\n## Whatever\n" }],
    });
    assert.deepEqual(structurePack().run(snap), []);
  });

  test("ungoverned roots (Assent, Vault archaeology, _staging) are out of scope", () => {
    const mk = (p) => ({ path: p, text: '---\nblueprint: "[[Tag.blueprint]]"\n---\n## Purpose\n## Rogue\n' });
    const snap = snapshot({
      blueprints: [tagBp],
      sources: [mk("Assent/a.md"), mk("Vault archaeology/b.md"), mk("_hold/c.md")],
    });
    assert.deepEqual(structurePack().run(snap), []);
  });
});

// ── port pack (port_lint) ─────────────────────────────────────────────────────

describe("portPack (port_lint)", () => {
  test("flags each family with kind = the matched token", () => {
    const snap = snapshot({
      sources: [
        { path: "Agents/brief.md", text: "See ~/obsidian-new/foo and address 05.11 via Templater.\n" },
      ],
    });
    const byCheck = Object.fromEntries(portPack().run(snap).map((f) => [f.check, f]));
    assert.equal(byCheck["retired source-vault path"].kind, "~/obsidian-new");
    assert.equal(byCheck["retired source-vault path"].target, "Agents/brief.md");
    assert.equal(byCheck["retired source-vault path"].script, "port_lint");
    assert.equal(byCheck["old-vault address"].kind, "05.11");
    assert.equal(byCheck["retired tooling"].kind, "Templater");
  });

  test("the live ~/obsidian path is NOT flagged", () => {
    const snap = snapshot({ sources: [{ path: "Agents/ok.md", text: "The vault lives at ~/obsidian today.\n" }] });
    assert.deepEqual(portPack().run(snap), []);
  });

  test("a line naming the reference as historical passes", () => {
    const snap = snapshot({
      sources: [{ path: "Agents/hist.md", text: "Templater is retired; do not reintroduce it.\n" }],
    });
    assert.deepEqual(portPack().run(snap), []);
  });

  test("identical-token hits in one file collapse to one finding", () => {
    const snap = snapshot({
      sources: [{ path: "Agents/dup.md", text: "~/obsidian-new/a\n~/obsidian-new/b\n~/obsidian-new/c\n" }],
    });
    const hits = portPack().run(snap).filter((f) => f.check === "retired source-vault path");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "~/obsidian-new");
  });

  test("_staging roots are out of scope", () => {
    const snap = snapshot({ sources: [{ path: "_hold/x.md", text: "~/obsidian-old/y\n" }] });
    assert.deepEqual(portPack().run(snap), []);
  });
});

// ── ste pack (ste_lint) ───────────────────────────────────────────────────────

describe("stePack (ste_lint)", () => {
  const run1 = (text, path = "Notes/prose.md") =>
    stePack().run(snapshot({ sources: [{ path, text }] }));

  test("flags each mechanical check; kind = \"<name> '<token lower-cased>'\"", () => {
    const kinds = new Set(run1("This Should be split; it's been fixed.\n").map((f) => f.kind));
    assert.ok(kinds.has("modal 'should'"), "modal lower-cased in the key"); // token was 'Should'
    assert.ok(kinds.has("semicolon ';'"));
    assert.ok(kinds.has("contraction 'it's'"));
    assert.ok(kinds.has("present-perfect 'been'") === false, "PERFECT needs an auxiliary");
  });

  test("check is always 'editable', script 'ste_lint', target the path", () => {
    const f = run1("It is done; move on.\n").find((x) => x.kind === "semicolon ';'");
    assert.equal(f.script, "ste_lint");
    assert.equal(f.check, "editable");
    assert.equal(f.target, "Notes/prose.md");
  });

  test("present perfect (has/have/had been) is flagged, token lower-cased", () => {
    const kinds = run1("The file Has Been moved.\n").map((f) => f.kind);
    assert.ok(kinds.includes("present-perfect 'has been'"));
  });

  test("frontmatter, fenced code, inline code, and quoted spans are exempt", () => {
    const clean = "---\ndesc: it's fine; really\n---\nPlain prose here.\n`it's in code`\n```\nshould; may\n```\n\"a quoted; span\"\n";
    assert.deepEqual(run1(clean), []);
  });

  test("band01 (01 System architecture) and frozen (.04 records) notes are excluded", () => {
    const bad = "This should not count; really.\n";
    assert.deepEqual(run1(bad, "00-09 System/01 System architecture/x.md"), []);
    assert.deepEqual(run1(bad, "00-09 System/00.04 Records for the system/y.md"), []);
    // …but a plain editable note IS counted
    assert.ok(run1(bad, "Notes/editable.md").length > 0);
  });

  test("identical-token hits in one file collapse to one finding", () => {
    const hits = run1("should here\nshould there\nShould again\n").filter((f) => f.kind === "modal 'should'");
    assert.equal(hits.length, 1);
  });

  test("Assent and _staging roots are out of scope", () => {
    assert.deepEqual(run1("bad; text\n", "Assent/x.md"), []);
    assert.deepEqual(run1("bad; text\n", "_hold/y.md"), []);
  });
});
