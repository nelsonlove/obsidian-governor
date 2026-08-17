/**
 * plugin-state-tools.test.mjs — obsidian_plugin_info / obsidian_plugin_reload.
 *
 * These two exist because `obsidian_environment_info` reports the manifests on
 * DISK, and a plugin under development is routinely not what is running: a
 * rebuild changes the bytes Obsidian would load, and nothing reloads them on
 * its own — a symlinked dev build never even touches the folder Hot Reload
 * watches. The property under test is that the two versions stay APART:
 * `installed_version` from the manifest, `version` from the loaded instance,
 * and `stale` when they disagree.
 *
 * `enabled` and `loaded` are kept apart for the same reason, and this is the
 * plugin's standing rule (packages/plugin/CLAUDE.md): `enabledPlugins` can name
 * a configured-but-uninstalled plugin, so any decision about what is actually
 * running reads the loaded instance. `obsidian_plugin_reload` refusing exactly
 * that stale-entry case is pinned below.
 *
 * tools-nav.ts imports a live Obsidian class, so the specifier is pointed at
 * the stub before it is imported — the same escape hatch link-healing.test.mjs
 * uses, for the same reason: the refusal ladder and the version split are
 * properties of the real handler, not of a re-implementation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerNavTools } = await import("../src/mcp/tools-nav.ts");

// ── harness ───────────────────────────────────────────────────────────────────

function fakeServer() {
  const tools = new Map();
  return {
    server: { registerTool: (name, def, handler) => tools.set(name, { def, handler }) },
    call: (name, args = {}) => tools.get(name).handler(args, {}),
    def: (name) => tools.get(name).def,
  };
}

/**
 * A community-plugin manager whose two registries can disagree, because that
 * disagreement is the whole subject. `installed` is the manifest on disk;
 * `running` is the version the loaded instance carries (omit it and the plugin
 * is installed but not loaded).
 */
function fakeApp(specs = {}, { enableFails = false } = {}) {
  const calls = [];
  const manifests = {};
  const loaded = {};
  const enabledPlugins = new Set();
  for (const [id, spec] of Object.entries(specs)) {
    manifests[id] = { id, name: spec.name ?? id, version: spec.installed, author: spec.author ?? null,
                      description: spec.description ?? null, dir: `.obsidian/plugins/${id}` };
    if (spec.enabled !== false) enabledPlugins.add(id);
    if (spec.running !== undefined) {
      loaded[id] = { manifest: { id, name: spec.name ?? id, version: spec.running } };
    }
  }
  const plugins = {
    manifests,
    plugins: loaded,
    enabledPlugins,
    async loadManifests() {
      calls.push(["loadManifests"]);
      // A rebuild changes the manifest on disk; re-reading is what picks it up.
      for (const [id, spec] of Object.entries(specs)) {
        if (spec.rebuiltTo !== undefined) manifests[id].version = spec.rebuiltTo;
      }
    },
    async disablePlugin(id) {
      calls.push(["disablePlugin", id]);
      delete loaded[id];
    },
    async enablePlugin(id) {
      calls.push(["enablePlugin", id]);
      if (enableFails) throw new Error("bundle failed to evaluate");
      loaded[id] = { manifest: { id, version: manifests[id].version } };
    },
  };
  return { app: { plugins }, calls };
}

function nav(app) {
  const s = fakeServer();
  registerNavTools(s.server, app, { getSettings: () => ({}) });
  return s;
}

const text = (res) => res.content?.[0]?.text ?? "";

// ── obsidian_plugin_info ──────────────────────────────────────────────────────

describe("obsidian_plugin_info", () => {
  test("reports every installed plugin, sorted, when no id is given", async () => {
    const { app } = fakeApp({
      dataview: { installed: "0.5.0", running: "0.5.0" },
      "a-plugin": { installed: "1.0.0", running: "1.0.0" },
    });
    const res = await nav(app).call("obsidian_plugin_info", {});

    assert.equal(res.isError, undefined, text(res));
    assert.equal(res.structuredContent.count, 2);
    assert.deepEqual(res.structuredContent.plugins.map((p) => p.id), ["a-plugin", "dataview"]);
  });

  test("a rebuilt-but-unreloaded plugin reads as stale: version is what RUNS, installed_version what is on disk", async () => {
    const { app } = fakeApp({ mb: { installed: "1.5.2", running: "1.5.1" } });
    const res = await nav(app).call("obsidian_plugin_info", { plugin_id: "mb" });

    const p = res.structuredContent.plugin;
    assert.equal(p.version, "1.5.1", "the loaded instance is still the old build");
    assert.equal(p.installed_version, "1.5.2");
    assert.equal(p.stale, true);
    assert.equal(p.loaded, true);
  });

  test("agreeing versions are not stale", async () => {
    const { app } = fakeApp({ mb: { installed: "1.5.2", running: "1.5.2" } });
    const res = await nav(app).call("obsidian_plugin_info", { plugin_id: "mb" });
    assert.equal(res.structuredContent.plugin.stale, false);
  });

  test("installed but not loaded: version is null and stale is false — an absent build is not a mismatched one", async () => {
    const { app } = fakeApp({ mb: { installed: "1.5.2", enabled: false } });
    const res = await nav(app).call("obsidian_plugin_info", { plugin_id: "mb" });

    const p = res.structuredContent.plugin;
    assert.equal(p.loaded, false);
    assert.equal(p.enabled, false);
    assert.equal(p.version, null);
    assert.equal(p.installed_version, "1.5.2");
    assert.equal(p.stale, false);
  });

  test("enabled and loaded are separate answers — a stale enabledPlugins entry is not a running plugin", async () => {
    // The configured-but-uninstalled case CLAUDE.md warns about: listed as
    // enabled, no instance. Reporting `enabled` alone would call it running.
    const { app } = fakeApp({ ghost: { installed: "1.0.0" } });
    const res = await nav(app).call("obsidian_plugin_info", { plugin_id: "ghost" });

    assert.equal(res.structuredContent.plugin.enabled, true);
    assert.equal(res.structuredContent.plugin.loaded, false);
  });

  test("an unknown id is a coded refusal, not an empty report", async () => {
    const { app } = fakeApp({ dataview: { installed: "0.5.0", running: "0.5.0" } });
    const res = await nav(app).call("obsidian_plugin_info", { plugin_id: "nope" });

    assert.equal(res.isError, true);
    assert.match(text(res), /Error \[plugin_not_found\]/);
  });

  test("is read-only, so it costs no queue slot and works in read-only mode", () => {
    const { app } = fakeApp({});
    assert.equal(nav(app).def("obsidian_plugin_info").annotations.readOnlyHint, true);
  });
});

// ── obsidian_plugin_reload ────────────────────────────────────────────────────

describe("obsidian_plugin_reload", () => {
  test("re-reads the manifests BEFORE disabling, then disables and enables", async () => {
    // Order matters: disable/enable alone re-runs the manifest Obsidian read at
    // startup, so a bumped version would be missed.
    const { app, calls } = fakeApp({ mb: { installed: "1.5.1", running: "1.5.1", rebuiltTo: "1.5.2" } });
    const res = await nav(app).call("obsidian_plugin_reload", { plugin_id: "mb" });

    assert.equal(res.isError, undefined, text(res));
    assert.deepEqual(calls, [["loadManifests"], ["disablePlugin", "mb"], ["enablePlugin", "mb"]]);
    assert.equal(res.structuredContent.reloaded, true);
    assert.equal(res.structuredContent.version, "1.5.2", "the response reports the version now RUNNING");
  });

  test("refuses to reload vault-mcp — it hosts the connection carrying the response", async () => {
    const { app, calls } = fakeApp({ "vault-mcp": { installed: "0.8.8", running: "0.8.8" } });
    const res = await nav(app).call("obsidian_plugin_reload", { plugin_id: "vault-mcp" });

    assert.equal(res.isError, true);
    assert.match(text(res), /Error \[reload_refused\]/);
    assert.deepEqual(calls, [], "the refusal lands before anything is touched");
  });

  test("refuses an id that is not installed", async () => {
    const { app } = fakeApp({ mb: { installed: "1.0.0", running: "1.0.0" } });
    const res = await nav(app).call("obsidian_plugin_reload", { plugin_id: "nope" });

    assert.equal(res.isError, true);
    assert.match(text(res), /Error \[plugin_not_found\]/);
  });

  test("refuses a plugin that is enabled but not loaded — the stale-entry case, gated on the instance", async () => {
    const { app, calls } = fakeApp({ ghost: { installed: "1.0.0" } });
    const res = await nav(app).call("obsidian_plugin_reload", { plugin_id: "ghost" });

    assert.equal(res.isError, true);
    assert.match(text(res), /Error \[plugin_not_loaded\]/);
    assert.deepEqual(calls, [], "nothing is disabled on the strength of an enabledPlugins entry");
  });

  test("a failed re-enable says so, and says the plugin is now OFF", async () => {
    // Half-reloaded is the one outcome a caller must not have to guess at.
    const { app, calls } = fakeApp({ mb: { installed: "1.0.0", running: "1.0.0" } }, { enableFails: true });
    const res = await nav(app).call("obsidian_plugin_reload", { plugin_id: "mb" });

    assert.equal(res.isError, true);
    assert.match(text(res), /Error \[reload_failed\]/);
    assert.match(text(res), /now OFF/);
    assert.match(text(res), /bundle failed to evaluate/, "the underlying reason is not swallowed");
    assert.deepEqual(calls.map((c) => c[0]), ["loadManifests", "disablePlugin", "enablePlugin"]);
  });

  test("is mutating, which is what buys it the queue slot and the journal record", () => {
    const { app } = fakeApp({});
    assert.equal(nav(app).def("obsidian_plugin_reload").annotations.readOnlyHint, false);
  });
});
