/**
 * conformance-drift-pack.test.mjs — the ported drift rule pack (drift ←
 * drift_audit.py), the last legacy Python conformance script moved to TS.
 *
 * The drift pack maps each Python finding string `"{LETTER}: {rest}"` onto the
 * canonical 4-tuple Finding keyed BYTE-IDENTICAL to the ratchet's `parse_drift`:
 *   { script: "drift_audit", check: <LETTER>, target: <rest>, kind: "" }
 * for every check EXCEPT E and F, whose Python message embeds volatile data
 * (an order-dependent homes list for E, a count + traversal-ordered path
 * sample for F). `parse_drift`'s docstring keys those two specially — E on
 * the uid alone (target <uid>, kind "dup-uid"), F count/sample-independently
 * (target "uid-coverage", kind "uid-less") — so the accepted-debt baseline's
 * keys carry across the port AND stay stable under unrelated edits (issue
 * #136: keying E/F on the raw message text produces a permanent false-NEW
 * treadmill, since the message changes on every unrelated uid-less note or
 * duplicate-uid claimant).
 *
 * Every finding-producing check (A/B/D/E/F/G/J) is exercised here, plus a
 * clean fixture, the empty `kind`, the E/F traversal-order + scope edges, and
 * — the load-bearing regression coverage for #136 — two KEY STABILITY tests
 * that add an unrelated uid-less note (F) / duplicate-uid claimant (E) and
 * assert the key is unchanged while the message differs. A message-level
 * parity test cannot catch this class of bug by construction; only a
 * key-level test can. The print-only checks (C/H/I) emit no findings and so
 * appear nowhere.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { driftPack, DEFAULT_REGISTRIES_ROOT } from "../src/conformance/packs/index.ts";
import { findingKey } from "../src/conformance/finding.ts";

const FBF = DEFAULT_REGISTRIES_ROOT;
const BASE02 = "00-09 System/02 Obsidian/02.03 Artifacts for 02 Obsidian";
const PLUGSTACK = "00-09 System/02 Obsidian/02.12 Plugin stack.md";

/** Build the drift-shaped snapshot. `config` maps a vault-relative `.obsidian`
 * path to its raw text (community-plugins.json / quickadd data.json / a
 * plugin's manifest.json).
 *
 * Check A now REQUIRES the QuickAdd config — absence/corruption is refused
 * loudly, not treated as an empty choice set (#136 item 2). So every snapshot
 * defaults to a valid empty QuickAdd config (`{"choices":[]}`), letting tests
 * that target OTHER checks ignore it. A `config` entry for the QuickAdd path
 * overrides that default (the A dir-1/dir-2 tests supply their own); pass
 * `noQuickadd: true` to omit it entirely and exercise check A's refusal. */
function snap({ sources = [], files = [], dirs = [], walkOrder = [], config = {}, noQuickadd = false } = {}) {
  const base = noQuickadd ? {} : { ".obsidian/plugins/quickadd/data.json": '{"choices":[]}' };
  const merged = { ...base, ...config };
  const obsidianConfig = Object.entries(merged).map(([path, text]) => ({ path, text }));
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

  // #136 item 2: a missing/corrupt/reshaped QuickAdd config must REFUSE loudly
  // (a typed throw the engine turns into a pack_error) rather than silently
  // skip check A and let the run report CONFORMING with ~30 findings gone.
  test("absent quickadd config → check A REFUSES loudly (not a silent skip)", () => {
    assert.throws(() => run(snap({ sources: [actGhost], noQuickadd: true })), /needs '.*quickadd\/data\.json', which is absent/);
  });

  test("unparseable quickadd config → check A REFUSES loudly", () => {
    const bad = { ".obsidian/plugins/quickadd/data.json": "{ not valid json" };
    assert.throws(() => run(snap({ sources: [actGhost], config: bad })), /cannot parse .*quickadd\/data\.json.* as JSON/);
  });

  test("reshaped quickadd config (choices not an array) → check A REFUSES loudly", () => {
    const reshaped = { ".obsidian/plugins/quickadd/data.json": JSON.stringify({ choices: "nope" }) };
    assert.throws(() => run(snap({ sources: [actGhost], config: reshaped })), /'choices' is not an array/);
  });

  test("the refusal surfaces as a conformance_engine pack_error through the engine", async () => {
    const { runEngine } = await import("../src/conformance/engine.ts");
    const pack = driftPack();
    const findings = runEngine([pack], snap({ sources: [actGhost], noQuickadd: true }));
    const err = findings.find((f) => f.script === "conformance_engine" && f.check === "pack_error");
    assert.ok(err, "expected a pack_error finding attributing the drift pack's refusal");
    assert.equal(err.target, "drift_audit");
  });

  test("a valid empty quickadd config → check A runs and finds nothing (absence-vs-emptiness: [] IS a real answer)", () => {
    assert.deepEqual(targets(run(snap({ sources: [actGhost] })), "A"), [
      "ghost.action.md names choice 'Ghost' which does not exist in QuickAdd config",
    ]);
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
//
// E and F are keyed specially (issue #136): their MESSAGE (`detail`) still
// carries the traversal-ordered homes list / count+sample, and is asserted
// below exactly as before. But the ratchet KEY — `target`/`kind`, what
// `findingKey()` serializes — must NOT move when that volatile data changes.
// The two "key stability" tests are the load-bearing regression coverage: a
// message-level parity check cannot catch this class of bug by construction,
// only a key-level one can.

describe("driftPack E/F (uid)", () => {
  const UID = "0192f1a0-1234-7abc-8def-0123456789ab";
  const withUid = (p, uid = UID) => ({ path: p, text: `---\nuid: ${uid}\n---\nbody\n` });
  const noUid = (p) => ({ path: p, text: "---\ntitle: x\n---\nbody\n" });

  test("E: two notes sharing a uid → one finding, homes joined in traversal order in `detail`", () => {
    const s = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const findings = run(s).filter((f) => f.check === "E");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail, `E: uid ${UID} is claimed by 2 notes: Notes/a.md; Notes/b.md`);
  });

  test("E key: keyed on the uid, not the homes list (issue #136) — target is the uid, kind is 'dup-uid'", () => {
    const s = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const f = run(s).find((x) => x.check === "E");
    assert.equal(f.target, UID);
    assert.equal(f.kind, "dup-uid");
    assert.equal(findingKey(f), `drift_audit|E|${UID}|dup-uid`);
  });

  test("E key stability: a THIRD claimant joins (changing the homes list and its order) — the key is unchanged", () => {
    const two = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const keyBefore = findingKey(run(two).find((f) => f.check === "E"));

    // A third claimant joins, ahead of the other two in traversal order —
    // this changes both the COUNT and the ORDER of the homes list embedded
    // in the message.
    const three = snap({
      walkOrder: ["Notes/zzz.md", "Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/zzz.md"), withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const fAfter = run(three).find((f) => f.check === "E");
    const keyAfter = findingKey(fAfter);

    assert.equal(keyAfter, keyBefore, "the E key must be stable when an unrelated claimant joins");
    // The message DID change — proving a message-level check would have
    // reported a false NEW finding here.
    assert.equal(fAfter.detail, `E: uid ${UID} is claimed by 3 notes: Notes/zzz.md; Notes/a.md; Notes/b.md`);
  });

  test("F: uid-less notes → one aggregated finding, sample in WALK order (not sorted), +N more, in `detail`", () => {
    // walkOrder is deliberately NOT alphabetical — the sample must follow it.
    const order = ["Notes/z.md", "Notes/a.md", "Notes/m.md", "Notes/b.md", "Notes/y.md", "Notes/c.md", "Notes/n.md"];
    const s = snap({ walkOrder: order, sources: order.map(noUid) });
    const f = run(s).find((x) => x.check === "F");
    assert.equal(
      f.detail,
      "F: 7 note(s) lack a usable uid — run 'Stamp missing UIDs': Notes/z.md; Notes/a.md; Notes/m.md; Notes/b.md; Notes/y.md (+2 more)",
    );
  });

  test("F: five or fewer uid-less notes → no '(+N more)' suffix in `detail`", () => {
    const order = ["Notes/z.md", "Notes/a.md"];
    const f = run(snap({ walkOrder: order, sources: order.map(noUid) })).find((x) => x.check === "F");
    assert.equal(f.detail, "F: 2 note(s) lack a usable uid — run 'Stamp missing UIDs': Notes/z.md; Notes/a.md");
  });

  test("F key: keyed count/sample-independently (issue #136) — target 'uid-coverage', kind 'uid-less'", () => {
    const order = ["Notes/z.md", "Notes/a.md"];
    const f = run(snap({ walkOrder: order, sources: order.map(noUid) })).find((x) => x.check === "F");
    assert.equal(f.target, "uid-coverage");
    assert.equal(f.kind, "uid-less");
    assert.equal(findingKey(f), "drift_audit|F|uid-coverage|uid-less");
  });

  test("F key stability: an UNRELATED additional uid-less note is added — the key is unchanged though count/sample changes", () => {
    const order = ["Notes/z.md", "Notes/a.md", "Notes/m.md", "Notes/b.md", "Notes/y.md"];
    const before = snap({ walkOrder: order, sources: order.map(noUid) });
    const keyBefore = findingKey(run(before).find((f) => f.check === "F"));

    const orderPlusOne = [...order, "Notes/unrelated-new-note.md"];
    const after = snap({ walkOrder: orderPlusOne, sources: orderPlusOne.map(noUid) });
    const fAfter = run(after).find((f) => f.check === "F");
    const keyAfter = findingKey(fAfter);

    assert.equal(keyAfter, keyBefore, "the F key must be stable when an unrelated uid-less note is added");
    // The message DID change (count 5 → 6, "+1 more" appears) — proving a
    // message-level check would have reported a false NEW finding here.
    assert.ok(fAfter.detail.startsWith("F: 6 note(s) lack a usable uid"));
  });

  test("a non-UUID uid value counts as no-identity (F), not a valid identity", () => {
    const bad = { path: "Notes/x.md", text: "---\nuid: not-a-uuid\n---\n" };
    const f = run(snap({ walkOrder: ["Notes/x.md"], sources: [bad] })).find((x) => x.check === "F");
    assert.ok(f.detail.startsWith("F: 1 note(s) lack a usable uid"));
  });

  test("iter_notes scope: dot/.trash segments, _ roots, and Assent are excluded from E/F", () => {
    const order = ["_hold/s.md", "Assent/t.md", ".obsidian/u.md", "x/.hidden/v.md", "Notes/real.md"];
    const s = snap({ walkOrder: order, sources: order.map(noUid) });
    const f = run(s).find((x) => x.check === "F");
    // only the one governed note counts
    assert.equal(f.detail, "F: 1 note(s) lack a usable uid — run 'Stamp missing UIDs': Notes/real.md");
  });

  test("the daily-note template is uid-exempt (empty uid is copy payload, not drift)", () => {
    const tpl = `${FBF}/Daily notes/Daily note.template.md`;
    const s = snap({ walkOrder: [tpl], sources: [noUid(tpl)] });
    assert.equal(run(s).filter((f) => f.check === "F").length, 0);
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
