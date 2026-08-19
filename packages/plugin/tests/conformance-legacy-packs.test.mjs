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
import { proseLines, steHits } from "../src/conformance/packs/ste.ts";
import { portHits } from "../src/conformance/packs/port.ts";

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

// ── #227: ste frontmatter recognition binds to the shared core recognizer ─────

describe("stePack (#227) — BOM'd frontmatter is exempt via the shared recognizer", () => {
  const run1 = (text, path = "Notes/prose.md") =>
    stePack().run(snapshot({ sources: [{ path, text }] }));

  test("a BOM'd note's frontmatter is exempt (was linted as prose)", () => {
    // Pre-fix, `lines[0] === "---"` failed on a BOM-prefixed "---", so `desc:` was
    // scanned as prose and flagged. The shared recognizer looks past the BOM.
    const bommed = "\uFEFF---\ndesc: it should be fine; really\n---\nPlain prose here.\n";
    assert.deepEqual(run1(bommed), []);
  });

  test("a BOM'd note's body hits keep original-text line numbers", () => {
    const bommed = "\uFEFF---\na: 1\nb: 2\n---\nWe should go.\n";
    const hits = steHits(bommed);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "modal");
    assert.equal(hits[0].token, "should");
    assert.equal(hits[0].line, 5, "body line numbers are 1-based positions in the ORIGINAL text");
  });

  test("byte-stability: an ordinary exact-`---` fence yields the identical scan (keys unmoved)", () => {
    // The exact shape the Python scan recognized — the recognizer must agree
    // with it line-for-line so BOM-less finding keys do not shift (#209).
    const text = "---\ndesc: should is exempt\n---\nWe should go; it's time.\n";
    assert.deepEqual(proseLines(text), [
      { line: 4, text: "We should go; it's time." },
      { line: 5, text: "" }, // the trailing empty line, exactly as the Python scan yielded it
    ]);
    const kinds = run1(text).map((f) => f.kind).sort();
    assert.deepEqual(kinds, ["contraction 'it's'", "modal 'should'", "semicolon ';'"]);
  });

  test("byte-stability: no frontmatter, and an UNTERMINATED fence, scan the whole text (as the Python did)", () => {
    assert.deepEqual(proseLines("plain line\n"), [
      { line: 1, text: "plain line" },
      { line: 2, text: "" },
    ]);
    // Opener with no closer: the Python scanned everything from line 1; the
    // recognizer finds no block and does the same.
    const unterminated = "---\nkey: should\n";
    assert.deepEqual(proseLines(unterminated), [
      { line: 1, text: "---" },
      { line: 2, text: "key: should" },
      { line: 3, text: "" },
    ]);
  });
});

// ── #112a (pinned): ASCII word boundaries are the rail's own semantics ────────

describe("ASCII word boundaries are the rail's own semantics (#112a, pinned)", () => {
  test("ste: a modal glued to a non-ASCII letter still matches (JS ASCII \\b; Python Unicode \\w did not)", () => {
    const hits = steHits("wordé shouldé x.\n");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "modal");
    assert.equal(hits[0].token, "should");
  });

  test("port: a banned token glued to a non-ASCII letter still matches", () => {
    const hits = portHits("uses Templaterö here\n");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "retired tooling");
    assert.equal(hits[0].token, "Templater");
  });
});

// ── #112b (pinned): blueprint basename-collision arbitration is deterministic ─

describe("structurePack (#112b, pinned) — basename collision resolves last-in-sorted-order", () => {
  const ROOT = DEFAULT_BLUEPRINT_ROOT;
  const collide = [
    { path: `${ROOT}/A/Tag.blueprint`, text: "---\n---\n## One\n" },
    { path: `${ROOT}/Z/Tag.blueprint`, text: "---\n---\n## Two\n" },
  ];

  test("the sorted-last blueprint wins the basename lookup", () => {
    const snap = snapshot({
      blueprints: collide,
      sources: [{ path: "Notes/two.md", text: '---\nblueprint: "[[Tag.blueprint]]"\n---\n## Two\n' }],
    });
    assert.deepEqual(structurePack().run(snap), []); // checked against Z (## Two), not A
  });

  test("…so a note matching only the sorted-FIRST blueprint is DROPPED", () => {
    const snap = snapshot({
      blueprints: collide,
      sources: [{ path: "Notes/one.md", text: '---\nblueprint: "[[Tag.blueprint]]"\n---\n## One\n' }],
    });
    const f = structurePack().run(snap).find((x) => x.check === "DROPPED");
    assert.ok(f, "expected DROPPED: the arbitration chose Z, whose emitted set lacks ## One");
    assert.equal(f.kind, "Tag.blueprint");
  });
});

// ── #112c: an unresolvable {% include %} is a finding, never a silent zero ────

describe("structurePack (#112c) — UNRESOLVED-INCLUDE", () => {
  const ROOT = DEFAULT_BLUEPRINT_ROOT;

  test("a governed blueprint including a missing target is a finding (target = bp path, kind = include target)", () => {
    const bp = {
      path: `${ROOT}/Scope/ScopeNoteHeader.blueprint`,
      text: '---\n---\n{% include "…/Default/header.blueprint" %}\n## Body\n',
    };
    const f = structurePack()
      .run(snapshot({ blueprints: [bp] }))
      .find((x) => x.check === "UNRESOLVED-INCLUDE");
    assert.ok(f, "expected an UNRESOLVED-INCLUDE finding");
    assert.equal(f.script, "conformance_check");
    assert.equal(f.target, `${ROOT}/Scope/ScopeNoteHeader.blueprint`);
    assert.equal(f.kind, "…/Default/header.blueprint");
  });

  test("a RESOLVED include is not a finding; identical unresolved sites collapse to one", () => {
    const header = { path: `${ROOT}/Default/header.blueprint`, text: "## Header\n" };
    const bp = {
      path: `${ROOT}/Reg/Reg.blueprint`,
      text:
        `---\n---\n{% include "${ROOT}/Default/header.blueprint" %}\n` +
        '{% include "gone.blueprint" %}\n{% include "gone.blueprint" %}\n',
    };
    const found = structurePack()
      .run(snapshot({ blueprints: [header, bp] }))
      .filter((x) => x.check === "UNRESOLVED-INCLUDE");
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "gone.blueprint");
  });

  test("includes inside {# comments #} and ___REST___ sections do not affect emission and are not findings", () => {
    const bp = {
      path: `${ROOT}/Quiet/Quiet.blueprint`,
      text:
        '---\n---\n{# {% include "commented.blueprint" %} #}\n' +
        '{% section "___REST___" %}\n{% include "rested.blueprint" %}\n{% endsection %}\n## Body\n',
    };
    assert.deepEqual(structurePack().run(snapshot({ blueprints: [bp] })), []);
  });

  test("ungoverned and underscore-root blueprints are out of scope", () => {
    const mk = (p) => ({ path: p, text: '---\n---\n{% include "gone.blueprint" %}\n' });
    const snap = snapshot({
      blueprints: [mk("Vault archaeology/_maybe/blueprints/gen2/old.blueprint"), mk("_hold/x.blueprint"), mk("Assent/y.blueprint")],
    });
    assert.deepEqual(structurePack().run(snap), []);
  });
});
