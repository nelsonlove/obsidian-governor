/**
 * module-registry.test.mjs — the module host (kernel/modules): the Module
 * contract, ModuleRegistry, and the registerXTools adapter.
 *
 * Everything here is Obsidian-free and SDK-free by design — the registrar is
 * structurally typed, so the shared fakeServer stands in for a built server.
 *
 * The load-bearing assertions:
 *   • enabled/disabled from settings (default + override), unknown ids inert
 *   • governance posture refused at construction (the v1 gate)
 *   • the accept/baseline tool-name tripwire refuses at registration
 *   • cross-module name collisions refused, first registration wins
 *   • a throwing register() loses its own tools and nothing else
 *   • adapters carry the existing register(server, ctx) idiom unchanged
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  ModuleRegistry,
  forbiddenToolName,
  moduleFromRegistrar,
  mergeModuleConfig,
} from "../src/kernel/modules/index.ts";

const RO = { readOnlyHint: true };

/** A minimal capability module registering `tools` (name → handler result). */
function mod(id, opts = {}) {
  return {
    id,
    posture: opts.posture ?? "capability",
    capabilities: opts.capabilities ?? [`${id}-cap`],
    enabled: opts.enabled ?? true,
    ...(opts.settingsSchema ? { settingsSchema: opts.settingsSchema } : {}),
    register(reg, host, config) {
      opts.onRegister?.(host, config);
      for (const name of opts.tools ?? [`obsidian_${id}_tool`]) {
        reg(name, { description: `${id} tool`, annotations: RO }, () => ({ from: id }));
      }
      if (opts.throwAfter) throw new Error(`${id} exploded`);
    },
  };
}

/** registerAll into a fresh fakeServer; returns { server, registry }. */
function registerAll(registry, host = {}) {
  const server = fakeServer();
  registry.registerAll((n, d, h) => server.registerTool(n, d, h), host);
  return server;
}

describe("ModuleRegistry: enablement from settings", () => {
  test("default-enabled module registers; default-disabled stays inert", () => {
    const r = new ModuleRegistry([mod("scheme"), mod("draft", { enabled: false })]);
    const server = registerAll(r);
    assert.ok(server.tools.has("obsidian_scheme_tool"));
    assert.ok(!server.tools.has("obsidian_draft_tool"));
    assert.deepEqual(r.enabledModules().map((m) => m.id), ["scheme"]);
  });

  test("settings override the default in both directions", () => {
    const r = new ModuleRegistry(
      [mod("scheme"), mod("draft", { enabled: false })],
      { scheme: { enabled: false }, draft: { enabled: true } },
    );
    const server = registerAll(r);
    assert.ok(!server.tools.has("obsidian_scheme_tool"));
    assert.ok(server.tools.has("obsidian_draft_tool"));
  });

  test("a disabled module's register() is never called", () => {
    let called = false;
    const r = new ModuleRegistry([mod("off", { enabled: false, onRegister: () => (called = true) })]);
    registerAll(r);
    assert.equal(called, false);
  });

  test("settings naming an unknown module are reported and inert", () => {
    const r = new ModuleRegistry([mod("scheme")], { ghost: { enabled: true } });
    assert.ok(r.problems.some((p) => p.includes("unknown module 'ghost'")));
    assert.equal(r.isEnabled("ghost"), false);
    const server = registerAll(r);
    assert.deepEqual([...server.tools.keys()], ["obsidian_scheme_tool"]);
  });

  test("duplicate module ids: first declaration wins, reported", () => {
    const r = new ModuleRegistry([mod("dup", { tools: ["obsidian_first"] }), mod("dup", { tools: ["obsidian_second"] })]);
    assert.ok(r.problems.some((p) => p.includes("duplicate module id 'dup'")));
    const server = registerAll(r);
    assert.ok(server.tools.has("obsidian_first"));
    assert.ok(!server.tools.has("obsidian_second"));
  });
});

describe("ModuleRegistry: the v1 posture gate", () => {
  test("a governance module is refused at construction and registers nothing", () => {
    const r = new ModuleRegistry([mod("steward", { posture: "governance", tools: ["obsidian_pending_status"] })]);
    assert.ok(r.problems.some((p) => p.includes("'steward'") && p.includes("governance")));
    assert.equal(r.isEnabled("steward"), false);
    const server = registerAll(r);
    assert.equal(server.tools.size, 0);
    assert.deepEqual(r.describe(), []);
  });

  test("a refused governance module still reserves its id — a later reuse is a duplicate", () => {
    const r = new ModuleRegistry([
      mod("shadow", { posture: "governance" }),
      mod("shadow", { tools: ["obsidian_shadow_tool"] }),
    ]);
    assert.ok(r.problems.some((p) => p.includes("duplicate module id 'shadow'")));
    const server = registerAll(r);
    assert.equal(server.tools.size, 0);
  });
});

describe("ModuleRegistry: the accept tripwire", () => {
  test("forbiddenToolName matches accept/approve/baseline, case-insensitive", () => {
    for (const name of ["obsidian_accept_note", "obsidian_Approve_all", "advance_BASELINE"]) {
      assert.equal(forbiddenToolName(name), true, name);
    }
    assert.equal(forbiddenToolName("obsidian_resolve_address"), false);
  });

  test("a forbidden registration is refused and reported; the module's other tools survive", () => {
    const r = new ModuleRegistry([mod("sly", { tools: ["obsidian_sly_ok", "obsidian_accept_baseline"] })]);
    const server = registerAll(r);
    assert.ok(server.tools.has("obsidian_sly_ok"));
    assert.ok(!server.tools.has("obsidian_accept_baseline"));
    assert.ok(r.problems.some((p) => p.includes("obsidian_accept_baseline") && p.includes("refused")));
    assert.deepEqual(r.describe()[0].tools, ["obsidian_sly_ok"]);
  });
});

describe("ModuleRegistry: registration hygiene", () => {
  test("cross-module name collision: first wins, second refused and reported", () => {
    const r = new ModuleRegistry([
      mod("a", { tools: ["obsidian_shared"] }),
      mod("b", { tools: ["obsidian_shared", "obsidian_b_own"] }),
    ]);
    const server = registerAll(r);
    assert.equal(server.tools.get("obsidian_shared").handler().from, "a");
    assert.ok(server.tools.has("obsidian_b_own"));
    assert.ok(r.problems.some((p) => p.includes("module 'b'") && p.includes("already registered")));
  });

  test("a throwing validate() is contained: reported, the module and everyone after it still register", () => {
    const r = new ModuleRegistry([
      mod("badcfg", {
        settingsSchema: { defaults: {}, validate: () => { throw new Error("validator exploded"); } },
      }),
      mod("calm"),
    ]);
    const server = registerAll(r);
    assert.ok(server.tools.has("obsidian_badcfg_tool"));
    assert.ok(server.tools.has("obsidian_calm_tool"));
    assert.ok(r.problems.some((p) => p.includes("'badcfg'") && p.includes("validate() threw") && p.includes("validator exploded")));
  });

  test("run problems reset per registerAll; construction problems persist", () => {
    const r = new ModuleRegistry(
      [
        mod("cfg", { settingsSchema: { validate: () => ["bad depth"] } }),
        mod("steward", { posture: "governance" }),
      ],
    );
    registerAll(r);
    registerAll(r);
    registerAll(r);
    // The validate finding appears ONCE (the last run's), not once per call…
    assert.equal(r.problems.filter((p) => p.includes("bad depth")).length, 1);
    // …and the construction-time governance refusal survives every run.
    assert.equal(r.problems.filter((p) => p.includes("governance")).length, 1);
  });

  test("a throwing register() is contained: reported, other modules unaffected", () => {
    const r = new ModuleRegistry([
      mod("bomb", { tools: ["obsidian_bomb_pre"], throwAfter: true }),
      mod("calm"),
    ]);
    const server = registerAll(r);
    // Tools registered before the throw stay registered — refusal semantics
    // match the vocab registry's "one bad row" discipline, not a rollback.
    assert.ok(server.tools.has("obsidian_bomb_pre"));
    assert.ok(server.tools.has("obsidian_calm_tool"));
    assert.ok(r.problems.some((p) => p.includes("'bomb'") && p.includes("exploded")));
  });

  test("registerAll is per-server: a second call re-registers cleanly", () => {
    const r = new ModuleRegistry([mod("scheme")]);
    registerAll(r);
    const second = registerAll(r);
    assert.ok(second.tools.has("obsidian_scheme_tool"));
    assert.deepEqual(r.describe()[0].tools, ["obsidian_scheme_tool"]);
  });
});

describe("ModuleRegistry: config + describe", () => {
  test("configFor merges schema defaults under user config; validate problems are reported", () => {
    const schema = {
      defaults: { root: "", depth: 2 },
      validate: (c) => (typeof c.depth === "number" ? [] : ["depth must be a number"]),
    };
    let seen;
    const r = new ModuleRegistry(
      [mod("cfg", { settingsSchema: schema, onRegister: (_h, config) => (seen = config) })],
      { cfg: { config: { root: "Projects", depth: "nope" } } },
    );
    assert.deepEqual(r.configFor("cfg"), { root: "Projects", depth: "nope" });
    registerAll(r);
    assert.deepEqual(seen, { root: "Projects", depth: "nope" });
    assert.ok(r.problems.some((p) => p.includes("module 'cfg' config") && p.includes("depth must be a number")));
  });

  test("mergeModuleConfig: user config wins shallowly, absent halves tolerated", () => {
    assert.deepEqual(mergeModuleConfig({ a: 1, b: 2 }, { b: 3 }), { a: 1, b: 3 });
    assert.deepEqual(mergeModuleConfig(undefined, undefined), {});
  });

  test("describe() enumerates posture, capabilities, enablement and contributed tools", () => {
    const r = new ModuleRegistry(
      [mod("scheme", { capabilities: ["addressing", "allocation"] }), mod("vocab", { enabled: false })],
    );
    registerAll(r);
    assert.deepEqual(r.describe(), [
      {
        id: "scheme",
        posture: "capability",
        capabilities: ["addressing", "allocation"],
        enabled: true,
        tools: ["obsidian_scheme_tool"],
      },
      { id: "vocab", posture: "capability", capabilities: ["vocab-cap"], enabled: false, tools: [] },
    ]);
  });

  test("host ctx reaches register() verbatim, including the visible filter", () => {
    const kernel = { marker: true };
    const visible = (paths) => paths.filter((p) => p.startsWith("Projects/"));
    let got;
    const r = new ModuleRegistry([mod("ctx", { onRegister: (host) => (got = host) })]);
    registerAll(r, { kernel, getSettings: () => ({ readOnly: true }), sources: { ctx: [1, 2] }, visible });
    assert.equal(got.kernel, kernel);
    assert.deepEqual(got.getSettings(), { readOnly: true });
    assert.deepEqual(got.sources.ctx, [1, 2]);
    assert.deepEqual(got.visible(["Projects/a.md", "Archive/b.md"]), ["Projects/a.md"]);
  });
});

describe("moduleFromRegistrar: the registerXTools adapter", () => {
  // Stand-ins for the two real first contents, in their exact idioms — the
  // scope provider's offered shape (registerSchemeTools(server, ctx) with
  // {registry(), notes(), getSettings?}) and a vocab-style tool layer. The
  // point pinned here: the EXISTING function signature adapts without any
  // change to the function itself. Both are SYNTHETIC — the names are the two
  // founding modules', but neither function is imported, and the vocab one no
  // longer has a real counterpart in this plugin at all (it left for the
  // `vault-vocab` satellite at S7). The two SHAPES are what this pins, and
  // they are still the two shapes the adapter has to accept.
  function registerSchemeTools(server, ctx) {
    server.registerTool(
      "obsidian_resolve_address",
      { description: "resolve", annotations: RO },
      () => ({ schemes: ctx.registry().length, notes: ctx.notes().length }),
    );
  }
  function registerVocabTools(server, ctx) {
    server.registerTool(
      "obsidian_lookup_term",
      { description: "lookup", annotations: RO },
      () => ({ vocabularies: ctx.vocabularies.length }),
    );
  }

  test("scope-shaped and vocab-shaped registrars adapt and coexist", () => {
    const scheme = moduleFromRegistrar(
      { id: "scheme", capabilities: ["addressing"], enabled: true },
      registerSchemeTools,
      (host, config) => ({
        getSettings: host.getSettings,
        registry: () => [config.scheme ?? "jd"],
        notes: () => host.sources?.scheme ?? [],
      }),
    );
    const vocab = moduleFromRegistrar(
      { id: "vocab", capabilities: ["vocabulary"], enabled: true },
      registerVocabTools,
      (host) => ({ vocabularies: host.sources?.vocab ?? [] }),
    );
    const r = new ModuleRegistry([scheme, vocab]);
    const server = registerAll(r, { sources: { scheme: ["00.01 A.md"], vocab: ["t"] } });
    assert.deepEqual(server.tools.get("obsidian_resolve_address").handler(), { schemes: 1, notes: 1 });
    assert.deepEqual(server.tools.get("obsidian_lookup_term").handler(), { vocabularies: 1 });
    assert.equal(r.problems.length, 0);
  });

  test("adapter config flows from settings through ctxOf", () => {
    const scheme = moduleFromRegistrar(
      { id: "scheme", capabilities: ["addressing"], enabled: true, settingsSchema: { defaults: { scheme: "jd" } } },
      registerSchemeTools,
      (host, config) => ({ registry: () => [config.scheme], notes: () => [] }),
    );
    const r = new ModuleRegistry([scheme], { scheme: { config: { scheme: "para" } } });
    const server = registerAll(r);
    assert.equal(server.tools.get("obsidian_resolve_address").handler().schemes, 1);
    assert.deepEqual(r.configFor("scheme"), { scheme: "para" });
  });

  test("adapter defaults posture to capability and carries meta", () => {
    const m = moduleFromRegistrar({ id: "x", capabilities: ["c"], enabled: false }, () => {}, () => ({}));
    assert.equal(m.posture, "capability");
    assert.equal(m.enabled, false);
  });
});
