/**
 * conformance-drift-pack.test.mjs — the ported drift rule pack (drift ←
 * drift_audit.py), the last legacy Python conformance script moved to TS.
 *
 * The drift pack maps each Python finding string `"{LETTER}: {rest}"` onto the
 * canonical 4-tuple Finding keyed BYTE-IDENTICAL to the ratchet's `parse_drift`:
 *   { script: "drift_audit", check: <LETTER>, target: <rest>, kind: "" }
 * so the accepted-debt baseline's 56 drift keys carry across the port. Every
 * finding-producing check (A/B/D/E/F/G/J) is exercised here, plus a clean
 * fixture, the empty `kind`, and the E/F traversal-order + scope edges. The
 * print-only checks (C/H/I) emit no findings and so appear nowhere.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { driftPack, DEFAULT_REGISTRIES_ROOT } from "../src/conformance/packs/index.ts";

const FBF = DEFAULT_REGISTRIES_ROOT;
const BASE02 = "00-09 System/02 Obsidian/02.03 Artifacts for 02 Obsidian";
const PLUGSTACK = "00-09 System/02 Obsidian/02.12 Plugin stack.md";

/** Build the drift-shaped snapshot. `config` maps a vault-relative `.obsidian`
 * path to its raw text (community-plugins.json / quickadd data.json / a
 * plugin's manifest.json). */
function snap({ sources = [], files = [], dirs = [], walkOrder = [], config = {} } = {}) {
  const obsidianConfig = Object.entries(config).map(([path, text]) => ({ path, text }));
  return { notes: [], paths: [], blueprints: [], sources, files, dirs, walkOrder, obsidianConfig };
}
const run = (s) => driftPack().run(s);
const targets = (findings, letter) => findings.filter((f) => f.check === letter).map((f) => f.target);

// ── key shape ─────────────────────────────────────────────────────────────────

describe("driftPack key shape", () => {
  test("script is drift_audit, check is the letter, target is the message body, kind is empty", () => {
    const findings = run(snap({ dirs: ["00-09 System/00 A", "00-09 System/00 B"] }));
    const f = findings.find((x) => x.check === "J");
    assert.ok(f, "expected a J finding");
    assert.equal(f.script, "drift_audit");
    assert.equal(f.check, "J");
    assert.equal(f.kind, ""); // empty kind → serialized key carries a trailing pipe
    assert.equal(f.target, "category number 00 is claimed by 2 folders: 00 A; 00 B");
  });

  test("the empty fixture yields no findings", () => {
    assert.deepEqual(run(snap()), []);
  });
});

// ── A. QuickAdd choices <-> .action quickadd-choice surfaces ───────────────────

describe("driftPack A (choices <-> actions)", () => {
  const qa = JSON.stringify({
    choices: [
      { type: "Multi", name: "grp", choices: [{ name: "Do X", command: true }, { name: "NoCmd", command: false }] },
      { name: "Reveal slot in Finder", command: true }, // UI choice → excluded from dir-1
      { name: "Orphan", command: true }, // command-enabled, no action, not UI → dir-1 finding
    ],
  });
  const actDoX = { path: `${FBF}/Actions/dox.action.md`, text: "---\nsurfaces:\n  quickadd-choice: Do X\n---\n" };
  const actGhost = { path: `${FBF}/Actions/ghost.action.md`, text: "---\nsurfaces:\n  quickadd-choice: Ghost\n---\n" };

  test("dir-1: a command-enabled choice with no .action entry (UI choices exempt)", () => {
    const t = targets(run(snap({ sources: [actDoX, actGhost], config: { ".obsidian/plugins/quickadd/data.json": qa } })), "A");
    assert.ok(t.includes("choice 'Orphan' is command-enabled but no .action entry names it"));
    assert.ok(!t.some((x) => x.includes("Reveal slot in Finder")), "UI choice is exempt");
    assert.ok(!t.some((x) => x.includes("'Do X'")), "a choice an action names is fine");
    assert.ok(!t.some((x) => x.includes("NoCmd")), "a non-command choice is not enumerated");
  });

  test("dir-2: an .action naming a choice absent from QuickAdd config", () => {
    const t = targets(run(snap({ sources: [actDoX, actGhost], config: { ".obsidian/plugins/quickadd/data.json": qa } })), "A");
    assert.ok(t.includes("ghost.action.md names choice 'Ghost' which does not exist in QuickAdd config"));
  });

  test("no quickadd config → check A is skipped entirely", () => {
    assert.deepEqual(targets(run(snap({ sources: [actGhost] })), "A"), []);
  });
});

// ── B. plugin enablement <-> the 02.12 plugin-stack note ───────────────────────

describe("driftPack B (plugin stack)", () => {
  const plug = {
    path: PLUGSTACK,
    text: [
      "| Plugin | Status | Version |",
      "| --- | --- | --- |",
      "| Alpha | enabled | 1.0 |",
      "| Beta | disabled | 1.0 |",
      "| Gone | uninstalled | - |",
      "",
    ].join("\n"),
  };
  const config = {
    ".obsidian/community-plugins.json": JSON.stringify(["beta"]), // only beta is enabled
    ".obsidian/plugins/alpha/manifest.json": JSON.stringify({ id: "alpha", name: "Alpha" }),
    ".obsidian/plugins/beta/manifest.json": JSON.stringify({ id: "beta", name: "Beta" }),
    ".obsidian/plugins/extra/manifest.json": JSON.stringify({ id: "extra", name: "Extra" }),
  };

  test("flags enablement mismatches, uninstalled-but-installed, and installed-but-unlisted", () => {
    const t = targets(run(snap({ sources: [plug], config })), "B");
    assert.ok(t.includes("'Alpha' is disabled but 02.12 says enabled"));
    assert.ok(t.includes("'Beta' is enabled but 02.12 says disabled"));
    assert.ok(t.includes("installed plugin 'Extra' (disabled) missing from 02.12"));
    // 'Gone' is uninstalled in the doc and not installed → no finding
    assert.ok(!t.some((x) => x.includes("Gone")), "doc-uninstalled + not-installed is consistent");
  });

  test("no plugin-stack note → check B is skipped (Python's PLUGSTACK.exists() guard)", () => {
    assert.deepEqual(targets(run(snap({ config })), "B"), []);
  });
});

// ── D. action surfaces (user-script / module / template) <-> filesystem ────────

describe("driftPack D (surface existence)", () => {
  const act = {
    path: `${FBF}/Actions/d.action.md`,
    text: [
      "---",
      "surfaces:",
      "  user-script: QuickAdd/exists.md",
      "  module: modules/missing.js",
      "  template: Templates/missing.md",
      "---",
      "",
    ].join("\n"),
  };
  const existsMd = { path: `${BASE02}/QuickAdd/exists.md`, text: "---\n---\nno js block here\n" };

  test("missing module/template flagged; an existing .md user-script without a js block flagged", () => {
    const s = snap({ sources: [act, existsMd], files: [existsMd.path] });
    const t = targets(run(s), "D");
    assert.ok(t.includes("d.action.md names module 'modules/missing.js' which does not exist"));
    assert.ok(t.includes("d.action.md names template 'Templates/missing.md' which does not exist"));
    assert.ok(t.includes("d.action.md user-script 'QuickAdd/exists.md' has no fenced js block"));
  });

  test("an existing .md user-script WITH a fenced js block is clean", () => {
    const withJs = { path: `${BASE02}/QuickAdd/exists.md`, text: "---\n---\n```js\nreturn 1;\n```\n" };
    const onlyScript = { path: `${FBF}/Actions/e.action.md`, text: "---\nsurfaces:\n  user-script: QuickAdd/exists.md\n---\n" };
    const t = targets(run(snap({ sources: [onlyScript, withJs], files: [withJs.path] })), "D");
    assert.deepEqual(t, []);
  });
});

// ── E / F. uid identity in raw traversal order ─────────────────────────────────

describe("driftPack E/F (uid)", () => {
  const UID = "0192f1a0-1234-7abc-8def-0123456789ab";
  const withUid = (p, uid = UID) => ({ path: p, text: `---\nuid: ${uid}\n---\nbody\n` });
  const noUid = (p) => ({ path: p, text: "---\ntitle: x\n---\nbody\n" });

  test("E: two notes sharing a uid → one finding, homes joined in traversal order", () => {
    const s = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const t = targets(run(s), "E");
    assert.deepEqual(t, [`uid ${UID} is claimed by 2 notes: Notes/a.md; Notes/b.md`]);
  });

  test("F: uid-less notes → one aggregated finding, sample in WALK order (not sorted), +N more", () => {
    // walkOrder is deliberately NOT alphabetical — the sample must follow it.
    const order = ["Notes/z.md", "Notes/a.md", "Notes/m.md", "Notes/b.md", "Notes/y.md", "Notes/c.md", "Notes/n.md"];
    const s = snap({ walkOrder: order, sources: order.map(noUid) });
    const t = targets(run(s), "F");
    assert.deepEqual(t, [
      "7 note(s) lack a usable uid — run 'Stamp missing UIDs': Notes/z.md; Notes/a.md; Notes/m.md; Notes/b.md; Notes/y.md (+2 more)",
    ]);
  });

  test("F: five or fewer uid-less notes → no '(+N more)' suffix", () => {
    const order = ["Notes/z.md", "Notes/a.md"];
    const t = targets(run(snap({ walkOrder: order, sources: order.map(noUid) })), "F");
    assert.deepEqual(t, ["2 note(s) lack a usable uid — run 'Stamp missing UIDs': Notes/z.md; Notes/a.md"]);
  });

  test("a non-UUID uid value counts as no-identity (F), not a valid identity", () => {
    const bad = { path: "Notes/x.md", text: "---\nuid: not-a-uuid\n---\n" };
    const t = targets(run(snap({ walkOrder: ["Notes/x.md"], sources: [bad] })), "F");
    assert.equal(t.length, 1);
    assert.ok(t[0].startsWith("1 note(s) lack a usable uid"));
  });

  test("iter_notes scope: dot/.trash segments, _ roots, and Assent are excluded from E/F", () => {
    const order = ["_hold/s.md", "Assent/t.md", ".obsidian/u.md", "x/.hidden/v.md", "Notes/real.md"];
    const s = snap({ walkOrder: order, sources: order.map(noUid) });
    const t = targets(run(s), "F");
    // only the one governed note counts
    assert.deepEqual(t, ["1 note(s) lack a usable uid — run 'Stamp missing UIDs': Notes/real.md"]);
  });

  test("the daily-note template is uid-exempt (empty uid is copy payload, not drift)", () => {
    const tpl = `${FBF}/Daily notes/Daily note.template.md`;
    const s = snap({ walkOrder: [tpl], sources: [noUid(tpl)] });
    assert.deepEqual(targets(run(s), "F"), []);
  });
});

// ── G. registry naming self-consistency ────────────────────────────────────────

describe("driftPack G (naming)", () => {
  test("property with no title → 'None' vs the backticked key", () => {
    const prop = { path: `${FBF}/feat/x.property.md`, text: "---\ndesc: y\n---\n" };
    const t = targets(run(snap({ sources: [prop] })), "G");
    assert.ok(t.includes("x.property.md title is 'None', the filename says '`x`'"));
  });

  test("action title matches the stem but a wrong H1 is flagged (kind of the whole message)", () => {
    const act = { path: `${FBF}/Actions/y.action.md`, text: "---\ntitle: y.action\n---\n# `wrong`\n" };
    const t = targets(run(snap({ sources: [act] })), "G");
    assert.ok(!t.some((x) => x.includes("title is")), "title matches the stem → no title finding");
    assert.ok(t.includes("y.action.md H1 is '`wrong`', the filename says '`y`'"));
  });

  test("tag title must equal the filename stem", () => {
    const tag = { path: `${FBF}/feat/z.tag.md`, text: "---\ntitle: \"#z\"\n---\n" };
    const t = targets(run(snap({ sources: [tag] })), "G");
    assert.ok(t.includes("z.tag.md title is '#z', the filename says 'z.tag'"));
  });

  test("a type whose title equals its stem is clean", () => {
    const type = { path: `${FBF}/feat/w.type.md`, text: "---\ntitle: w.type\n---\n" };
    assert.deepEqual(targets(run(snap({ sources: [type] })), "G"), []);
  });
});

// ── J. category-number collisions on the 00-09 System spine ────────────────────

describe("driftPack J (category numbering)", () => {
  test("a two-digit code claimed by more than one direct child of the System spine", () => {
    const dirs = [
      "00-09 System/00 Alpha",
      "00-09 System/00 Beta",
      "00-09 System/01 Gamma",
      "00-09 System/00 Alpha/nested 00 deep", // NOT a direct child → ignored
      "Other/00 Elsewhere", // NOT under the spine → ignored
    ];
    const t = targets(run(snap({ dirs })), "J");
    assert.deepEqual(t, ["category number 00 is claimed by 2 folders: 00 Alpha; 00 Beta"]);
  });
});
