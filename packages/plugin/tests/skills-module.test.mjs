/**
 * skills-module.test.mjs — the vault-skills module folded into vault-mcp
 * (cycle 2 of #82). Three things this cycle must prove:
 *
 *   1. the skills module REGISTERS through the module host and RENDERS a
 *      config tab (config-host `collect`) with its fields + tool directory;
 *   2. all SIX vault_skills_* tools land on the GUARDED registrar (the mount's
 *      patched registerTool), the three writes as `readOnlyHint: false` — the
 *      annotation that routes them through the guard/queue/journal — the three
 *      reads as read-only; and the module contributes NO accept/approve tool;
 *   3. vault_skills_mark CANNOT write an acceptance assertion — the mark path
 *      runs the shared accept-forbidden transition guard, so a mark that would
 *      introduce/change an accepted-family field is REFUSED and nothing is
 *      written, while preserving an existing (human-granted) accepted value is
 *      allowed. This is the load-bearing requirement of the fold.
 *
 * Headless: tools-skills.ts imports nothing from `obsidian`; the vault arrives
 * as a fake SkillsBackend and the accept guard runs over plain objects.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { mountModules, builtinModules } from "../src/mcp/modules-mount.ts";
import { registerSkillsTools, guardSkillsMark } from "../src/mcp/tools-skills.ts";
import { collect, forbiddenToolName } from "../src/kernel/modules/index.ts";
import { AcceptForbiddenError } from "@vault-mcp/core";

const SKILLS_TOOLS = [
  "vault_skills_validate",
  "vault_skills_tree",
  "vault_skills_preview",
  "vault_skills_export",
  "vault_skills_release",
  "vault_skills_mark",
];
const READ_TOOLS = ["vault_skills_validate", "vault_skills_tree", "vault_skills_preview"];
const WRITE_TOOLS = ["vault_skills_export", "vault_skills_release", "vault_skills_mark"];

const inertSkillsSource = {
  notes: async () => [],
  resolveLink: () => null,
  embed: async () => null,
  basePath: () => null,
  frontmatterOf: () => null,
  exists: () => false,
  applyFrontmatter: async () => {},
};

function deps(settings = {}) {
  return {
    getSettings: () => settings,
    schemeNotes: () => [],
    vocabSource: { paths: () => [], frontmatter: () => null, body: async () => null },
    skillsSource: inertSkillsSource,
  };
}

function mount(settings) {
  const server = fakeServer();
  const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps(settings));
  return { server, registry };
}

// ── 1. registration + config tab ───────────────────────────────────────────

describe("skills module: registration + config tab", () => {
  test("ships DISABLED — a mutating module a human turns on — so it contributes nothing by default", () => {
    const { server, registry } = mount({});
    assert.equal(registry.isEnabled("skills"), false);
    const names = [...server.tools.keys()];
    assert.ok(!names.some((n) => n.startsWith("vault_skills_")));
  });

  test("collect() renders a skills config tab: summary, nine config fields with defaults, six-tool directory", () => {
    const mods = builtinModules(deps({}));
    const hosted = collect(mods, {}, {});
    const skills = hosted.find((h) => h.id === "skills");
    assert.ok(skills, "skills module not rendered");
    assert.ok(skills.summary.length > 0);
    assert.equal(skills.fields.length, 9);
    // Fields render their manifest defaults (blank until the user overrides).
    assert.equal(skills.fields.find((f) => f.key === "pluginName").value, "vault-skills");
    assert.equal(skills.fields.find((f) => f.key === "outputDir").value, "~/.claude/skills/vault-skills");
    // The capability directory documents every tool, read/write flags intact.
    assert.deepEqual(skills.directory.tools.map((t) => t.name).sort(), [...SKILLS_TOOLS].sort());
    for (const t of skills.directory.tools) {
      assert.equal(t.readOnly, READ_TOOLS.includes(t.name), `${t.name} readOnly flag`);
    }
  });

  test("a user config override lands in the rendered field value + the module toggles on", () => {
    const settings = { modules: { skills: { enabled: true, config: { pluginName: "my-skills" } } } };
    const hosted = collect(builtinModules(deps(settings)), settings.modules, settings);
    const skills = hosted.find((h) => h.id === "skills");
    assert.equal(skills.enabled, true);
    assert.equal(skills.fields.find((f) => f.key === "pluginName").value, "my-skills");
  });
});

// ── 2. the six tools on the guarded registrar ──────────────────────────────

describe("skills module: the six tools on the guarded registrar", () => {
  test("enabled: all six vault_skills_* tools register through the mount", () => {
    const { server } = mount({ modules: { skills: { enabled: true } } });
    const names = [...server.tools.keys()];
    for (const n of SKILLS_TOOLS) assert.ok(names.includes(n), `missing ${n}`);
  });

  test("the three write tools register mutating (readOnlyHint:false) — the annotation that routes them through the guard/queue/journal; reads are read-only", () => {
    const { server } = mount({ modules: { skills: { enabled: true } } });
    for (const n of WRITE_TOOLS) assert.equal(server.tools.get(n).def.annotations.readOnlyHint, false, `${n} must be mutating`);
    for (const n of READ_TOOLS) assert.equal(server.tools.get(n).def.annotations.readOnlyHint, true, `${n} must be read-only`);
  });

  test("the mutating tools mount ONLY because the module declares `mutating` — the gate otherwise refuses a non-read-only module tool", () => {
    // The skills module's export/release/mark are readOnlyHint:false and still
    // register: proof the mount's per-module gate honored `mutating: true`.
    const { server, registry } = mount({ modules: { skills: { enabled: true } } });
    assert.ok(server.tools.has("vault_skills_export"));
    assert.deepEqual(registry.problems, []);
  });

  test("the module contributes NO accept/approve/baseline tool (the registry tripwire would refuse one anyway)", () => {
    for (const n of SKILLS_TOOLS) assert.equal(forbiddenToolName(n), false, `${n} unexpectedly reads as accept-shaped`);
    // There is no seventh, accept-shaped tool hiding in the surface.
    const { server } = mount({ modules: { skills: { enabled: true } } });
    const skillsNames = [...server.tools.keys()].filter((n) => n.startsWith("vault_skills_"));
    assert.equal(skillsNames.length, 6);
    assert.ok(!skillsNames.some((n) => forbiddenToolName(n)));
  });
});

// ── 3. the accept-forbidden guard on vault_skills_mark (load-bearing) ───────

const PREFIX = { mode: "prefix", prefix: "", key: "vault-skills", typeSource: "frontmatter" };

describe("guardSkillsMark: a skills-mark can never introduce an acceptance assertion", () => {
  test("a clean mark on a clean note is allowed (returns the MarkResult, no throw)", () => {
    const result = guardSkillsMark({}, { type: "skill" }, PREFIX);
    assert.equal(result.set.type, "skill");
  });

  test("INTRODUCING an accepted-family field is REFUSED — here via a field prefix that would write `accepted-*` keys", () => {
    // A field prefix of `accepted-` makes the mark write `accepted-type` etc. —
    // an acceptance-PROVENANCE key. The shared guard must refuse it: proof the
    // mark path actually runs acceptTransitionReason, not that its fixed inputs
    // happen never to spell "accepted".
    assert.throws(
      () => guardSkillsMark({}, { type: "skill" }, { ...PREFIX, prefix: "accepted-" }),
      AcceptForbiddenError,
    );
  });

  test("PRESERVING an existing (human-granted) accepted value forward is ALLOWED", () => {
    // The note already carries a human-set acceptance-status: accepted; a normal
    // mark adds `type` and leaves the accepted value untouched → not a transition.
    const before = { "acceptance-status": "accepted" };
    const result = guardSkillsMark(before, { type: "agent" }, PREFIX);
    assert.equal(result.set.type, "agent");
    // The guard never mutated the caller's before-frontmatter.
    assert.deepEqual(before, { "acceptance-status": "accepted" });
  });

  test("an accepted value already present is not re-introduced by an unrelated mark (array/scalar forms)", () => {
    assert.doesNotThrow(() => guardSkillsMark({ accepted: ["yes"] }, { type: "policy" }, PREFIX));
  });
});

// ── the mark HANDLER end-to-end: refusal blocks the write ──────────────────

function markHandler(config, before) {
  const server = fakeServer();
  const writes = [];
  const backend = {
    ...inertSkillsSource,
    exists: () => true,
    frontmatterOf: () => before,
    applyFrontmatter: async (p, mutate) => {
      const fm = { ...before };
      mutate(fm);
      writes.push({ path: p, fm });
    },
  };
  registerSkillsTools(server, backend, { config, getSettings: () => ({}) });
  return { handler: server.tools.get("vault_skills_mark").handler, writes };
}

describe("vault_skills_mark handler: the guard blocks the write, not just the response", () => {
  test("a clean mark writes the frontmatter", async () => {
    const { handler, writes } = markHandler({}, {});
    const res = await handler({ path: "Note.md", type: "skill" });
    assert.equal(res.isError, undefined);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].fm.type, "skill");
  });

  test("a mark that would write an accepted-family field is refused AND nothing is written", async () => {
    const { handler, writes } = markHandler({ fieldMode: "prefix", fieldPrefix: "accepted-" }, {});
    const res = await handler({ path: "Note.md", type: "skill" });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res), /accept/i);
    assert.equal(writes.length, 0, "the accept-forbidden write must not have landed");
  });

  test("a missing note fails before any write", async () => {
    const server = fakeServer();
    registerSkillsTools(server, { ...inertSkillsSource, exists: () => false }, { config: {}, getSettings: () => ({}) });
    const res = await server.tools.get("vault_skills_mark").handler({ path: "Nope.md", type: "skill" });
    assert.equal(res.isError, true);
  });
});
