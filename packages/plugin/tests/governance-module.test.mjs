/**
 * governance-module.test.mjs — the governance (Acceptance) module (#83). THE ACCEPT-
 * UNREACHABILITY TRIPWIRE. Cycle 1 asserted this trivially (no accept surface existed yet);
 * cycle 2 folds in the actual human-only Accept gesture + review pane, so this test is now
 * LOAD-BEARING: it asserts, with the accept surface actually present in the source tree, that
 * NONE of performAccept / setBaseline / runGuardedAdopt / setClassEnabled / stampAcceptance is
 * reachable from any of:
 *   - the governance module's MCP tool list (it contributes ZERO tools),
 *   - the whole mounted MCP surface,
 *   - the plugin instance (no instance method / no this.<member>),
 *   - the view/tab instance (controller held in a module-private WeakMap),
 *   - the mount host ctx handed to modules ({getSettings, visible} only),
 *   - the MCP transport layer (server.ts + mcp/tools-*.ts never import/reference them),
 * and that every pane Accept/Revert/Adopt/allowlist button is addEventListener-wired (so its
 * `.onclick` stays null) and gates on isRealGesture. The DEFINITIVE proof is the deploy-time LIVE
 * reachability walk (pane.ts/wiring.ts import the obsidian runtime, types-only in the test env, so
 * the classes cannot be instantiated headlessly); this source-level tripwire is what catches a
 * regression BEFORE that live check.
 *
 * Headless: modules-mount.ts imports nothing from `obsidian`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeServer } from "./fake-server.mjs";
import { mountModules, mountHost, builtinModules } from "../src/mcp/modules-mount.ts";
import { collect, ModuleRegistry } from "../src/kernel/modules/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const readRaw = (rel) => fs.readFileSync(path.join(srcDir, rel), "utf8");
// Strip comments so identifiers named only in the (extensive) invariant docs don't false-match.
function code(rel) {
  return readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/([^:])\/\/[^\n]*/g, "$1")
    .replace(/^\/\/[^\n]*/gm, "");
}
function mcpToolFiles() {
  const dir = path.join(srcDir, "mcp");
  return fs.readdirSync(dir).filter((f) => f.startsWith("tools-") && f.endsWith(".ts")).map((f) => `mcp/${f}`);
}

/** The forbidden-surface matcher. DELIBERATELY BROADER than the registry's own built-in tripwire
 * (accept/approve/baseline): it also names `adopt` and `setClassEnabled` — the cycle-2 accept-path
 * verbs the registry's fragment list does NOT catch. Asserting the governance module's ACTUAL
 * surface against THIS is what makes the tripwire load-bearing. */
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
    // Posture is "capability", NOT "governance": the v1 registry refuses the governance posture
    // outright (it would be inert), so the fold lands as an ordinary capability module instead.
    assert.equal(gov.posture, "capability");
    assert.equal(gov.enabled, false);
    assert.ok(!gov.mutating, "governance must NOT declare mutating — it contributes no MCP tool");
    assert.deepEqual(gov.capabilities, ["acceptance"]);
  });

  test("disabled by default: the module contributes nothing", () => {
    const { server, registry } = mount();
    const gov = registry.describe().find((d) => d.id === "governance");
    assert.equal(gov.enabled, false);
    assert.deepEqual(gov.tools, []);
    // obsidian_pending_review is always-on in server.ts, NOT a module tool — never on the mount.
    assert.ok(!server.tools.has("obsidian_pending_review"));
  });
});

describe("governance module: contributes ZERO MCP tools when enabled", () => {
  test("enabling it adds NO tool to the surface (the accept surface is an Obsidian pane)", () => {
    const { server, registry } = mount({ modules: { governance: { enabled: true } } });
    assert.deepEqual(registry.problems, []);
    const gov = registry.describe().find((d) => d.id === "governance");
    assert.equal(gov.enabled, true);
    assert.deepEqual(gov.tools, []);
    // Nothing forbidden — and specifically no accept tool — reached the transport.
    for (const name of server.tools.keys()) {
      assert.ok(!FORBIDDEN.test(name), `a forbidden-named tool reached the surface: ${name}`);
    }
    assert.ok(!server.tools.has("obsidian_pending_review"));
  });
});

describe("governance module: renders a config-tab section (two badge toggles, empty directory)", () => {
  test("collect() gives it a section — two badge-display toggles, default ON, no tools, disabled", () => {
    const settings = { modules: {} };
    const hosted = collect(builtinModules(deps(settings)), settings.modules, settings);
    const gov = hosted.find((h) => h.id === "governance");
    assert.ok(gov, "governance not rendered by collect()");
    assert.ok(gov.summary.length > 0, "governance summary is empty");
    // Gap A: the two badge-display toggles (ribbon + pane-tab), matching the exact keys the pane
    // wiring reads through governanceDisplaySettings, both defaulting ON.
    assert.deepEqual(gov.fields.map((f) => f.key), ["showRibbonBadge", "showViewTabBadge"]);
    for (const f of gov.fields) {
      assert.equal(f.type, "toggle");
      assert.equal(f.value, true, `${f.key} should default ON`);
    }
    assert.equal(gov.enabled, false);
    assert.equal(gov.directory.tools.length, 0);
  });

  test("a stored `false` overrides the default-on toggle (the pane honors it)", () => {
    const settings = { modules: { governance: { config: { showRibbonBadge: false } } } };
    const hosted = collect(builtinModules(deps(settings)), settings.modules, settings);
    const gov = hosted.find((h) => h.id === "governance");
    const ribbon = gov.fields.find((f) => f.key === "showRibbonBadge");
    const tab = gov.fields.find((f) => f.key === "showViewTabBadge");
    assert.equal(ribbon.value, false, "stored false must override the default-on");
    assert.equal(tab.value, true, "the untouched toggle stays default-on");
  });
});

describe("governance module: badge config keys match what the pane actually reads", () => {
  test("the two field keys ARE the governanceDisplaySettings keys (toggling flips the badge)", async () => {
    const { governanceDisplaySettings, DEFAULT_GOVERNANCE_SETTINGS } = await import(
      "../src/kernel/governance/settings.ts"
    );
    const gov = governanceModule();
    const keys = gov.manifest.config.fields.map((f) => f.key).sort();
    // The pane derives its two booleans from exactly these keys — so a field key that drifted from
    // them would render a toggle that controls nothing.
    assert.deepEqual(keys, Object.keys(DEFAULT_GOVERNANCE_SETTINGS).sort());
    // And the manifest defaults ARE the pane's defaults (both ON), so an untouched config renders
    // the same state the pane would show.
    assert.deepEqual(gov.manifest.config.defaults, DEFAULT_GOVERNANCE_SETTINGS);
    // End-to-end: a config of {showRibbonBadge:false} the field would persist is read back by the
    // pane's own coercion as showRibbonBadge:false.
    assert.equal(governanceDisplaySettings({ showRibbonBadge: false }).showRibbonBadge, false);
    assert.equal(governanceDisplaySettings({ showRibbonBadge: false }).showViewTabBadge, true);
  });
});

describe("governance module: THE TRIPWIRE — structural (module + registry)", () => {
  test("the matcher has teeth (it would catch the accept verbs, incl. ones the registry misses)", () => {
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

  test("nothing forbidden is reachable from the module's contributed tool list or the whole surface", () => {
    const { server, registry } = mount({ modules: { governance: { enabled: true } } });
    const gov = registry.describe().find((d) => d.id === "governance");
    for (const name of gov.tools) assert.ok(!FORBIDDEN.test(name), `governance contributed a forbidden tool: ${name}`);
    for (const name of server.tools.keys()) assert.ok(!FORBIDDEN.test(name), `a forbidden-named tool reached the surface: ${name}`);
  });

  test("nothing forbidden is declared in the module's manifest directory", () => {
    const gov = governanceModule();
    const dir = gov.manifest.directory ?? {};
    for (const t of dir.tools ?? []) assert.ok(!FORBIDDEN.test(t.name), `manifest ToolDoc names a forbidden surface: ${t.name}`);
    for (const s of [...(dir.addressForms ?? []), ...(dir.rulePacks ?? []), ...(dir.kernelArgs ?? [])]) {
      assert.ok(!FORBIDDEN.test(s.name), `manifest surface names a forbidden capability: ${s.name}`);
    }
  });

  test("the module reaches no plugin instance / app / kernel / accept surface to mutate through", () => {
    // The ONLY context the governance module's register() receives is mountHost's ctx — exactly
    // {getSettings, visible}. No `app`, no plugin instance, no kernel (queue/journal/locks), no
    // baseline/accept surface. Even if a later edit slipped an accept-shaped call into a module
    // handler, it would have nothing to call it against.
    const host = mountHost(deps());
    assert.deepEqual(Object.keys(host).sort(), ["getSettings", "visible"]);
  });

  test("the registry REFUSES a governance-shaped module that tries to add an accept/baseline tool", () => {
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

describe("governance module: THE TRIPWIRE — source reachability (accept surface present)", () => {
  // A class METHOD is `<indent><modifiers?> name(` (inside a class body). A module function is
  // `function name(` at column 0. This matcher fires ONLY on an instance method.
  function isInstanceMethod(src, name) {
    return new RegExp(
      `(?:^|\\n)[ \\t]+(?:private |public |protected |readonly |static |get |set )*(?:async )?${name}\\s*\\(`,
    ).test(src);
  }
  const referencesThisMember = (src, name) => new RegExp(`\\bthis\\.${name}\\b`).test(src);

  // The accept-equivalent capabilities. None may be an instance method, a this.<member>, or an MCP
  // reference. Each exists ONLY as a module-scope function / WeakMap value reached through a
  // gesture-gated pane handler.
  const ACCEPT_EQUIVALENT = [
    "performAccept", "performRevert", "performAdopt", "setClassEnabled", "reconcile",
    "getStore", "setBaseline", "acceptNote", "revertNote", "stampAcceptance",
  ];

  test("wiring.ts: the accept-equivalent capabilities are module-scope, not instance methods or this.<member>", () => {
    const wiring = code("governance/wiring.ts");
    for (const name of ACCEPT_EQUIVALENT) {
      assert.ok(!isInstanceMethod(wiring, name), `${name} must NOT be an instance method`);
      assert.ok(!referencesThisMember(wiring, name), `this.${name} must not exist (would be reachable from app)`);
    }
    // performAccept/performRevert/performAdopt/reconcile/setClassEnabled ARE declared as module-scope functions.
    for (const fn of ["performAccept", "performRevert", "performAdopt", "reconcile", "setClassEnabled"]) {
      assert.match(wiring, new RegExp(`\\n(?:async )?function ${fn}\\s*\\(`), `${fn} must be a module-scope function`);
    }
  });

  test("wiring.ts: the baseline store lives in a module-private WeakMap, never this.store", () => {
    const wiring = code("governance/wiring.ts");
    assert.ok(!/\bthis\.store\b/.test(wiring), "store must not be this.store (would be reachable)");
    assert.match(wiring, /const baselineStores = new WeakMap</, "the store must be held in a module-private WeakMap");
  });

  test("wiring.ts: registers ZERO commands (a command is agent-invokable via obsidian_run_command)", () => {
    const wiring = code("governance/wiring.ts");
    assert.ok(!/\baddCommand\b/.test(wiring), "the governance wiring must register no command");
  });

  test("wiring.ts: onLayoutReady is disposed-guarded so an unmount/unload never leaks an auto-accept poll", () => {
    // The poll interval created in onLayoutReady runs pollJournal → sweepAutoAccept → setBaseline
    // (it advances baselines). onLayoutReady returns no EventRef, so if the mount is torn down in the
    // onload→layout-ready window the register-cleanups have already flushed and an interval created
    // afterward is never cleared — a leaked auto-accept poll on a disposed mount. The callback must
    // be gated on a disposed flag flipped by the child Component's register cleanup (the live-mount
    // teardown: `plugin.removeChild` on toggle-off, or the plugin's own unload — the wireUidIndex
    // disposed-flag pattern, scoped to the mount's Component).
    const wiring = code("governance/wiring.ts");
    assert.match(wiring, /let disposed = false;/, "must track a disposed flag");
    assert.match(wiring, /component\.register\(\(\) => \{[\s\S]*?disposed = true;/, "cleanup hook must flip disposed");
    const m = /onLayoutReady\(async \(\) => \{([\s\S]*?)\n  \}\);/.exec(wiring);
    assert.ok(m, "onLayoutReady callback must exist");
    assert.match(m[1], /if \(disposed\) return;/, "onLayoutReady must bail when disposed");
    assert.match(m[1], /registerInterval/, "the poll interval is created inside onLayoutReady");
  });

  test("pane.ts: the controller lives in a module-private WeakMap, never on the instance", () => {
    const pane = code("governance/pane.ts");
    assert.ok(!/\bthis\.controller\b/.test(pane), "no this.controller (would be reachable)");
    assert.ok(!/(private|readonly)\s+controller\b/.test(pane), "no controller instance field on the view");
    assert.match(pane, /const viewDeps = new WeakMap</, "deps held in a module-private WeakMap");
    assert.match(pane, /viewDeps\.set\(this,/, "constructor stows deps in the WeakMap");
  });

  test("pane.ts: every accept-class button is addEventListener-wired, NEVER via .onclick = (so .onclick stays null)", () => {
    const pane = code("governance/pane.ts");
    for (const el of ["acceptBtn", "revertBtn", "adoptBtn", "checkbox", "confirm"]) {
      assert.ok(!new RegExp(`\\b${el}\\.onclick\\s*=`).test(pane),
        `${el}.onclick = … is the forgeable wiring — must use addEventListener`);
    }
    assert.match(pane, /acceptBtn\.addEventListener\(\s*["']click["']/, "accept via addEventListener");
    assert.match(pane, /revertBtn\.addEventListener\(\s*["']click["']/, "revert via addEventListener");
    assert.match(pane, /adoptBtn\.addEventListener\(\s*["']click["']/, "adopt via addEventListener");
    assert.match(pane, /checkbox\.addEventListener\(\s*["']click["']/, "allowlist checkbox via addEventListener");
    assert.match(pane, /confirm\.addEventListener\(\s*["']click["']/, "modal confirm via addEventListener");
  });

  test("pane.ts: every accept-class handler gates on isRealGesture (directly or via runGuardedAdopt)", () => {
    const paneRaw = readRaw("governance/pane.ts");
    assert.match(paneRaw, /isRealGesture/, "the pane must use the isRealGesture gate");
    // accept/revert handlers gate directly on isRealGesture.
    const lines = paneRaw.split("\n");
    for (const el of ["acceptBtn", "revertBtn"]) {
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`${el}\\.addEventListener\\(`).test(lines[i])) {
          assert.match(lines.slice(i, i + 5).join("\n"), /isRealGesture/, `${el} handler must gate on isRealGesture`);
          found = true;
        }
      }
      assert.ok(found, `${el} must be wired with addEventListener`);
    }
    // adopt gates via runGuardedAdopt (which checks isRealGesture); the allowlist checkbox gates
    // via deps.setClassEnabled (whose body checks isRealGesture — asserted below).
    assert.match(paneRaw, /runGuardedAdopt/, "adopt must go through runGuardedAdopt");
  });

  test("wiring.ts: setClassEnabled (the auto-accept allowlist mutator) gates on isRealGesture", () => {
    const wiringRaw = readRaw("governance/wiring.ts");
    const m = /async function setClassEnabled\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(wiringRaw);
    assert.ok(m, "setClassEnabled must be a module-scope function");
    assert.match(m[1], /if \(!isRealGesture\(evt\)\) return false;/,
      "setClassEnabled must refuse unless handed a real trusted gesture");
  });

  test("stampAcceptance (the one place that writes `accepted`) is reachable ONLY from the gesture path, never from MCP", () => {
    // accept.ts (the gesture path) imports stampAcceptance; the MCP transport must NOT.
    assert.match(readRaw("kernel/governance/accept.ts"), /import \{ stampAcceptance \}/,
      "acceptNote is the sanctioned caller of stampAcceptance");
    const mcpLayer = ["mcp/server.ts", ...mcpToolFiles()];
    for (const rel of mcpLayer) {
      const src = code(rel);
      assert.ok(!/\bstampAcceptance\b/.test(src), `${rel} must not reference stampAcceptance`);
      for (const name of ["performAccept", "performAdopt", "runGuardedAdopt", "setClassEnabled", "acceptNote", "revertNote"]) {
        assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${rel} must not reference the accept-path fn ${name}`);
      }
    }
  });

  test("the MCP transport imports nothing from src/governance/ (the accept pane), and pending-review stays always-on read-only", () => {
    for (const rel of ["mcp/server.ts", "mcp/modules-mount.ts", ...mcpToolFiles()]) {
      assert.ok(!/from ["'][^"']*\/governance\/(pane|wiring)/.test(readRaw(rel)),
        `${rel} must not import the governance pane/wiring`);
    }
    // obsidian_pending_review is registered always-on in server.ts (read-only), decoupled from the
    // governance module toggle — the one MCP read surface, and it is not accept-shaped.
    const server = code("mcp/server.ts");
    assert.match(server, /registerPendingReviewTools\(server,/, "obsidian_pending_review must be registered always-on");
    assert.ok(!FORBIDDEN.test("obsidian_pending_review"));
  });

  test("main.ts wires the pane ONLY via wireGovernance behind the module-enabled flag — no accept method/command/tool on the plugin", () => {
    const main = code("main.ts");
    assert.match(main, /wireGovernance\(this,/, "main.ts wires the pane via wireGovernance");
    assert.match(main, /modules\?\.governance\?\.enabled === true/, "gated on the governance module enabled flag");
    // The plugin exposes no accept-equivalent method and registers no accept command.
    for (const name of ["performAccept", "performAdopt", "setBaseline", "acceptNote", "stampAcceptance"]) {
      assert.ok(!isInstanceMethod(main, name), `${name} must not be a plugin instance method`);
    }
    assert.ok(!/addCommand\([^)]*accept/i.test(readRaw("main.ts")), "no accept command on the plugin");
  });
});
