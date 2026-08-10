/**
 * config-host.test.mjs — issue #81's kernel-level pieces: the
 * `ModuleManifest` shape (manifest.ts) and the `collect` collector
 * (config-host.ts) that turns a module list + settings into render-ready
 * data for the generic settings-tab renderer.
 *
 * Load-bearing assertions:
 *   • manifest config validation: a valid config is accepted (no problems),
 *     an invalid one is rejected loudly (reported, never silently dropped)
 *   • collect() produces one HostedModule per registered module, including
 *     a module with NO config fields (capability-directory-only) — it must
 *     still render (fields: [], a real entry), never crash or vanish
 *   • a ConfigBinding round-trips: write() then read() recovers the patch,
 *     and write() never mutates the settings object it was handed
 *   • a throwing validate() is contained — reported as one problem string,
 *     collect() never throws
 *   • ModuleRegistry's manifest.config-first / settingsSchema-fallback
 *     priority (the "grows settingsSchema" migration path)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { collect, toolDocDrift, toolDocReadOnlyDrift, ModuleRegistry } from "../src/kernel/modules/index.ts";

const RO = { readOnlyHint: true };

/** A module with a full manifest: two config fields + a validate that
 * refuses a negative `depth`, plus a two-tool directory. */
function configModule(overrides = {}) {
  return {
    id: "widget",
    posture: "capability",
    capabilities: ["widgets"],
    enabled: true,
    manifest: {
      summary: "Widget things.",
      config: {
        fields: [
          { key: "root", label: "Root", type: "text" },
          { key: "depth", label: "Depth", type: "number" },
        ],
        validate: (c) => (typeof c.depth === "number" && c.depth >= 0 ? [] : ["depth must be a non-negative number"]),
      },
      directory: {
        tools: [
          { name: "obsidian_widget_list", purpose: "List widgets.", readOnly: true },
          { name: "obsidian_widget_get", purpose: "Get one widget.", readOnly: true },
        ],
      },
    },
    register(reg) {
      reg("obsidian_widget_list", { annotations: RO }, () => ({}));
      reg("obsidian_widget_get", { annotations: RO }, () => ({}));
    },
    ...overrides,
  };
}

/** A module with a manifest but NO config block at all — the real shape
 * the vocab module ships with in this PR (capability-directory-only). */
function directoryOnlyModule(overrides = {}) {
  return {
    id: "gadget",
    posture: "capability",
    capabilities: ["gadgets"],
    enabled: true,
    manifest: {
      summary: "Gadget things — nothing to configure.",
      directory: { tools: [{ name: "obsidian_gadget_list", purpose: "List gadgets.", readOnly: true }] },
    },
    register(reg) {
      reg("obsidian_gadget_list", { annotations: RO }, () => ({}));
    },
    ...overrides,
  };
}

describe("collect: one HostedModule per module, in order", () => {
  test("a module WITH config fields gets its current values merged from settings.modules.<id>.config", () => {
    const [hosted] = collect([configModule()], { widget: { config: { root: "Projects", depth: 2 } } }, {});
    assert.equal(hosted.id, "widget");
    assert.equal(hosted.enabled, true);
    assert.equal(hosted.summary, "Widget things.");
    assert.deepEqual(
      hosted.fields.map((f) => [f.key, f.value]),
      [
        ["root", "Projects"],
        ["depth", 2],
      ],
    );
    assert.deepEqual(hosted.problems, []);
    assert.equal(hosted.directory.tools.length, 2);
  });

  test("valid config is accepted: no problems", () => {
    const [hosted] = collect([configModule()], { widget: { config: { depth: 0 } } }, {});
    assert.deepEqual(hosted.problems, []);
  });

  test("invalid config is rejected LOUDLY: reported, not silently dropped or coerced", () => {
    const [hosted] = collect([configModule()], { widget: { config: { depth: -1 } } }, {});
    assert.deepEqual(hosted.problems, ["depth must be a non-negative number"]);
    // The bad value is still visible in the field — never silently swapped
    // for a default with no trace.
    assert.equal(hosted.fields.find((f) => f.key === "depth").value, -1);
  });

  test("a module with NO config fields still renders: fields: [], a real entry, never absent", () => {
    const hosted = collect([directoryOnlyModule()], {}, {});
    assert.equal(hosted.length, 1);
    assert.equal(hosted[0].id, "gadget");
    assert.deepEqual(hosted[0].fields, []);
    assert.deepEqual(hosted[0].problems, []);
    assert.equal(hosted[0].directory.tools.length, 1);
  });

  test("a module with no manifest at all still gets a minimal entry, not skipped", () => {
    const bare = { id: "bare", posture: "capability", capabilities: [], enabled: true, register() {} };
    const hosted = collect([bare], {}, {});
    assert.deepEqual(hosted, [
      {
        id: "bare",
        posture: "capability",
        capabilities: [],
        enabled: true,
        summary: "",
        fields: [],
        problems: [],
        directory: { tools: [], addressForms: [], rulePacks: [], kernelArgs: [] },
      },
    ]);
  });

  test("mixed list: a capability-directory-only module and a config-bearing one coexist, each rendered", () => {
    const hosted = collect([configModule(), directoryOnlyModule()], {}, {});
    assert.deepEqual(hosted.map((h) => h.id), ["widget", "gadget"]);
    assert.deepEqual(hosted[1].fields, []);
  });

  test("settings.modules.<id>.enabled overrides the module default in both directions", () => {
    const hosted = collect(
      [configModule({ enabled: true }), directoryOnlyModule({ enabled: false })],
      { widget: { enabled: false }, gadget: { enabled: true } },
      {},
    );
    assert.equal(hosted[0].enabled, false);
    assert.equal(hosted[1].enabled, true);
  });

  test("a throwing validate() is contained: reported as one problem string, collect() never throws", () => {
    const bomb = configModule({
      manifest: {
        summary: "x",
        config: { fields: [], validate: () => { throw new Error("boom"); } },
      },
    });
    const [hosted] = collect([bomb], {}, {});
    assert.equal(hosted.problems.length, 1);
    assert.match(hosted.problems[0], /validate\(\) threw/);
    assert.match(hosted.problems[0], /boom/);
  });
});

describe("collect: ConfigBinding — a module whose config predates the module host", () => {
  function boundModule(overrides = {}) {
    return configModule({
      configBinding: {
        read(settings) {
          return { ...(settings.legacy?.config ?? {}) };
        },
        write(settings, patch) {
          const nextConfig = { ...(settings.legacy?.config ?? {}) };
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete nextConfig[k];
            else nextConfig[k] = v;
          }
          return { ...settings, legacy: { ...settings.legacy, config: nextConfig } };
        },
      },
      ...overrides,
    });
  }

  test("collect() reads through the binding, ignoring modules.<id>.config entirely", () => {
    const settings = { legacy: { config: { root: "Elsewhere", depth: 3 } } };
    // A modules.widget.config row is present too, but must be IGNORED for a
    // bound module — the binding is authoritative.
    const [hosted] = collect([boundModule()], { widget: { config: { root: "Ignored", depth: 99 } } }, settings);
    assert.deepEqual(
      hosted.fields.map((f) => [f.key, f.value]),
      [
        ["root", "Elsewhere"],
        ["depth", 3],
      ],
    );
  });

  test("binding.write() round-trips: writing a patch then reading it back recovers the value", () => {
    const mod = boundModule();
    const settings0 = { legacy: { config: { root: "A", depth: 1 } } };
    const settings1 = mod.configBinding.write(settings0, { depth: 5 });
    assert.deepEqual(mod.configBinding.read(settings1), { root: "A", depth: 5 });
  });

  test("binding.write() never mutates the settings object it was handed", () => {
    const mod = boundModule();
    const settings0 = { legacy: { config: { root: "A", depth: 1 } } };
    const frozen = JSON.parse(JSON.stringify(settings0));
    mod.configBinding.write(settings0, { depth: 5 });
    assert.deepEqual(settings0, frozen);
  });

  test("a patch value of undefined REMOVES the key (blank-means-default convention)", () => {
    const mod = boundModule();
    const settings0 = { legacy: { config: { root: "A", depth: 1 } } };
    const settings1 = mod.configBinding.write(settings0, { root: undefined });
    assert.deepEqual(mod.configBinding.read(settings1), { depth: 1 });
  });
});

describe("toolDocDrift / toolDocReadOnlyDrift — the manifest-can't-rot checks", () => {
  test("clean: every declared ToolDoc matches a contributed tool and vice versa", () => {
    const docs = [
      { name: "obsidian_widget_list", purpose: "x", readOnly: true },
      { name: "obsidian_widget_get", purpose: "x", readOnly: true },
    ];
    assert.deepEqual(toolDocDrift(docs, ["obsidian_widget_list", "obsidian_widget_get"]), []);
  });

  test("a ToolDoc naming a tool that was never contributed is reported", () => {
    const docs = [{ name: "obsidian_ghost", purpose: "x", readOnly: true }];
    const problems = toolDocDrift(docs, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /obsidian_ghost/);
    assert.match(problems[0], /does not match any tool/);
  });

  test("a contributed tool with no ToolDoc is reported", () => {
    const problems = toolDocDrift([], ["obsidian_undocumented"]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /obsidian_undocumented/);
    assert.match(problems[0], /no ToolDoc/);
  });

  test("readOnly drift: a ToolDoc's readOnly must match the registered annotation", () => {
    const docs = [{ name: "obsidian_widget_list", purpose: "x", readOnly: true }];
    assert.deepEqual(toolDocReadOnlyDrift(docs, { obsidian_widget_list: { readOnlyHint: true } }), []);
    const problems = toolDocReadOnlyDrift(docs, { obsidian_widget_list: { readOnlyHint: false } });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /readOnlyHint is false/);
  });

  test("a missing annotation counts as a mismatch, not a pass", () => {
    const docs = [{ name: "obsidian_widget_list", purpose: "x", readOnly: true }];
    const problems = toolDocReadOnlyDrift(docs, {});
    assert.equal(problems.length, 1);
  });
});

describe("ModuleRegistry: manifest.config takes priority over the deprecated settingsSchema", () => {
  test("a module with ONLY manifest.config uses its defaults/validate through configFor/registerAll", () => {
    const m = {
      id: "m",
      posture: "capability",
      capabilities: [],
      enabled: true,
      manifest: { summary: "x", config: { fields: [], defaults: { a: 1 }, validate: (c) => (c.a === 1 ? [] : ["bad a"]) } },
      register() {},
    };
    const r = new ModuleRegistry([m], { m: { config: { a: 2 } } });
    assert.deepEqual(r.configFor("m"), { a: 2 });
    r.registerAll(() => {}, {});
    assert.ok(r.problems.some((p) => p.includes("'m' config") && p.includes("bad a")));
  });

  test("a module with BOTH manifest.config and a legacy settingsSchema: manifest wins outright, not a blend", () => {
    const m = {
      id: "m",
      posture: "capability",
      capabilities: [],
      enabled: true,
      settingsSchema: { defaults: { legacy: true }, validate: () => ["from legacy schema"] },
      manifest: { summary: "x", config: { fields: [], defaults: { fromManifest: true }, validate: () => [] } },
      register() {},
    };
    const r = new ModuleRegistry([m], {});
    assert.deepEqual(r.configFor("m"), { fromManifest: true });
    r.registerAll(() => {}, {});
    assert.ok(!r.problems.some((p) => p.includes("from legacy schema")));
  });

  test("a module with ONLY the deprecated settingsSchema still works (no flag day)", () => {
    const m = {
      id: "m",
      posture: "capability",
      capabilities: [],
      enabled: true,
      settingsSchema: { defaults: { a: 1 }, validate: (c) => (c.a === 1 ? [] : ["bad a"]) },
      register() {},
    };
    const r = new ModuleRegistry([m], { m: { config: { a: 2 } } });
    assert.deepEqual(r.configFor("m"), { a: 2 });
    r.registerAll(() => {}, {});
    assert.ok(r.problems.some((p) => p.includes("bad a")));
  });
});
