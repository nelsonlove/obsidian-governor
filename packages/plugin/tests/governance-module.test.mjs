/**
 * governance-module.test.mjs — the governance (Acceptance) module (#83, cycle 1:
 * the Stewardship fold). Cycle 1 is deliberately MINIMAL and one-way:
 *
 *   - the module mounts through the ModuleRegistry like scheme/vocab/skills,
 *     ships DISABLED, and — when enabled — contributes exactly ONE read-only
 *     surface, the reused obsidian_pending_review (#75);
 *   - it renders a config-tab section (directory-only, like vocab);
 *   - THE TRIPWIRE: no accept / baseline / adopt / setClassEnabled surface is
 *     reachable from the module's tool list, and the module receives no plugin
 *     instance / app / kernel / accept surface to reach one through. This is
 *     trivially true this cycle (none is added) — it is asserted anyway because
 *     it becomes load-bearing in cycle 2, when the accept gesture + pane fold in
 *     under their own reachability review. A regression there trips this test.
 *
 * Headless: modules-mount.ts imports nothing from `obsidian`; the pending-review
 * source arrives as a fake `{ read }`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { mountModules, mountHost, builtinModules } from "../src/mcp/modules-mount.ts";
import { collect, ModuleRegistry } from "../src/kernel/modules/index.ts";

/** The forbidden-surface matcher. DELIBERATELY BROADER than the registry's own
 * built-in tripwire (accept/approve/baseline): this also names `adopt` and
 * `setClassEnabled` — the cycle-2 accept-path verbs the registry's fragment list
 * does NOT catch (a read-only `obsidian_adopt_*` would sail past the registry's
 * check and its read-only gate). Asserting the governance module's ACTUAL surface
 * against THIS is what makes the tripwire load-bearing for cycle 2. */
const FORBIDDEN = /accept|baseline|adopt|approve|setclassenabled|set_class_enabled/i;

function deps(settings = {}) {
  return {
    getSettings: () => ({ ...settings }),
    schemeNotes: () => [],
    vocabSource: { paths: () => [], frontmatter: () => null, body: async () => null },
    skillsSource: {
      notes: async () => [],
      resolveLink: () => null,
      embed: async () => null,
      basePath: () => null,
      frontmatterOf: () => null,
      exists: () => false,
      applyFrontmatter: async () => {},
    },
    pendingReviewSource: { read: async () => null },
  };
}

function mount(settings = {}) {
  const server = fakeServer();
  const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps(settings));
  return { server, registry };
}

function governanceModule() {
  return builtinModules(deps()).find((m) => m.id === "governance");
}

describe("governance module: shape + default-off", () => {
  test("declared as a read-only capability module, disabled by default, NOT mutating", () => {
    const gov = governanceModule();
    assert.ok(gov, "governance module is not declared");
    // Posture is "capability", NOT "governance": the v1 registry refuses the
    // governance posture outright (it would be inert), so the fold lands as an
    // ordinary read-only capability module instead.
    assert.equal(gov.posture, "capability");
    assert.equal(gov.enabled, false);
    assert.ok(!gov.mutating, "governance must NOT declare mutating — it is read-only");
    assert.deepEqual(gov.capabilities, ["acceptance"]);
  });

  test("disabled by default: obsidian_pending_review is NOT on the surface", () => {
    const { server, registry } = mount();
    assert.ok(!server.tools.has("obsidian_pending_review"));
    const gov = registry.describe().find((d) => d.id === "governance");
    assert.equal(gov.enabled, false);
    assert.deepEqual(gov.tools, []);
  });
});

describe("governance module: registers its one read-only surface when enabled", () => {
  test("enabling it contributes exactly obsidian_pending_review, read-only", () => {
    const { server, registry } = mount({ modules: { governance: { enabled: true } } });
    assert.deepEqual(registry.problems, []);
    const gov = registry.describe().find((d) => d.id === "governance");
    assert.deepEqual(gov.tools, ["obsidian_pending_review"]);
    const entry = server.tools.get("obsidian_pending_review");
    assert.ok(entry, "obsidian_pending_review not registered");
    assert.equal(entry.def.annotations?.readOnlyHint, true);
  });

  test("the registered handler answers read-only (empty queue over the fake source), never mutates", async () => {
    const { server } = mount({ modules: { governance: { enabled: true } } });
    const { handler } = server.tools.get("obsidian_pending_review");
    const res = await handler({});
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, { pending: [], count: 0 });
  });
});

describe("governance module: renders a config-tab section (directory-only, like vocab)", () => {
  test("collect() gives it a section — no config fields, one read-only tool, disabled", () => {
    const settings = { modules: {} };
    const hosted = collect(builtinModules(deps(settings)), settings.modules, settings);
    const gov = hosted.find((h) => h.id === "governance");
    assert.ok(gov, "governance not rendered by collect()");
    assert.ok(gov.summary.length > 0, "governance summary is empty");
    assert.deepEqual(gov.fields, []);
    assert.equal(gov.enabled, false);
    assert.equal(gov.directory.tools.length, 1);
    assert.equal(gov.directory.tools[0].name, "obsidian_pending_review");
    assert.equal(gov.directory.tools[0].readOnly, true);
  });
});

describe("governance module: THE TRIPWIRE — no accept/baseline/adopt/setClassEnabled surface", () => {
  test("the matcher has teeth (it would catch the cycle-2 verbs, incl. ones the registry misses)", () => {
    // Prove the regex is live before relying on it, the way the mount's source-scan
    // test proves its pattern. These are the exact names cycle 2 must NOT add here.
    for (const bad of [
      "obsidian_accept_note",
      "obsidian_adopt_baseline",
      "obsidian_advance_baseline",
      "governance_setClassEnabled",
      "obsidian_approve_change",
    ]) {
      assert.ok(FORBIDDEN.test(bad), `matcher failed to catch ${bad}`);
    }
    assert.ok(!FORBIDDEN.test("obsidian_pending_review"));
  });

  test("nothing forbidden is reachable from the module's contributed tool list", () => {
    const { server, registry } = mount({ modules: { governance: { enabled: true } } });
    const gov = registry.describe().find((d) => d.id === "governance");
    // Every tool the module actually contributed…
    for (const name of gov.tools) {
      assert.ok(!FORBIDDEN.test(name), `governance contributed a forbidden-named tool: ${name}`);
      // …and every one is read-only, so it cannot reach the write queue, the write
      // primitive, or the accept-forbidden guard's territory (the guard routes ONLY
      // readOnlyHint === false calls to the kernel's mutation path).
      assert.equal(server.tools.get(name).def.annotations?.readOnlyHint, true);
    }
    // The whole mounted surface, too — governance added nothing forbidden to it.
    for (const name of server.tools.keys()) {
      assert.ok(!FORBIDDEN.test(name), `a forbidden-named tool reached the surface: ${name}`);
    }
  });

  test("nothing forbidden is declared in the module's manifest directory", () => {
    const gov = governanceModule();
    const dir = gov.manifest.directory ?? {};
    for (const t of dir.tools ?? []) {
      assert.ok(!FORBIDDEN.test(t.name), `manifest ToolDoc names a forbidden surface: ${t.name}`);
      assert.equal(t.readOnly, true, `manifest ToolDoc ${t.name} must be read-only`);
    }
    // No non-tool surface (address form, rule pack, kernel arg) smuggles one either.
    for (const s of [...(dir.addressForms ?? []), ...(dir.rulePacks ?? []), ...(dir.kernelArgs ?? [])]) {
      assert.ok(!FORBIDDEN.test(s.name), `manifest surface names a forbidden capability: ${s.name}`);
    }
  });

  test("the module reaches no plugin instance / app / kernel / accept surface to mutate through", () => {
    // The ONLY context the governance module's register() receives is mountHost's
    // ctx — exactly {getSettings, visible}. No `app`, no plugin instance, no kernel
    // (queue/journal/locks), no baseline/accept surface. So even if a later edit
    // slipped an accept-shaped call into a handler, it would have nothing to call it
    // against. This is the "trivially true this cycle" half, asserted anyway because
    // cycle 2 wires the accept gesture and this is where its blast radius is bounded.
    const host = mountHost(deps());
    assert.deepEqual(Object.keys(host).sort(), ["getSettings", "visible"]);
  });

  test("even so, the registry REFUSES a governance-shaped module that tries to add an accept/baseline tool", () => {
    // Defense in depth: prove the tripwire path is not vacuous. A hostile module
    // (governance's id/posture) attempting accept/baseline-named registrations is
    // refused and reported by the registry's own name check — the tool never reaches
    // the surface. (adopt/setClassEnabled are caught by THIS test file's FORBIDDEN
    // assertions above, not the registry's narrower built-in list.)
    const server = fakeServer();
    const hostile = {
      id: "governance",
      posture: "capability",
      capabilities: ["acceptance"],
      enabled: true,
      register(reg) {
        reg("obsidian_accept_note", { annotations: { readOnlyHint: false } }, () => ({}));
        reg("obsidian_advance_baseline", { annotations: { readOnlyHint: true } }, () => ({}));
      },
    };
    const registry = new ModuleRegistry([hostile], { governance: { enabled: true } });
    registry.registerAll((n, d, h) => server.registerTool(n, d, h), mountHost(deps()));
    assert.ok(!server.tools.has("obsidian_accept_note"));
    assert.ok(!server.tools.has("obsidian_advance_baseline"));
    assert.equal(registry.problems.filter((p) => p.includes("refused")).length, 2);
    assert.deepEqual(registry.describe().find((d) => d.id === "governance").tools, []);
  });
});
