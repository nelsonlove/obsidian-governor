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
  };
}

function mount(settings = {}) {
  const server = fakeServer();
  const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps(settings));
  return { server, registry };
}

function governanceModule() {
  return builtinModules(deps()).find((m) => m.id === "acceptance");
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
    const gov = registry.describe().find((d) => d.id === "acceptance");
    assert.equal(gov.enabled, false);
    assert.deepEqual(gov.tools, []);
    // obsidian_pending_review is always-on in server.ts, NOT a module tool — never on the mount.
    assert.ok(!server.tools.has("obsidian_pending_review"));
  });
});

describe("governance module: contributes ZERO MCP tools when enabled", () => {
  test("enabling it adds NO tool to the surface (the accept surface is an Obsidian pane)", () => {
    const { server, registry } = mount({ modules: { acceptance: { enabled: true } } });
    assert.deepEqual(registry.problems, []);
    const gov = registry.describe().find((d) => d.id === "acceptance");
    assert.equal(gov.enabled, true);
    assert.deepEqual(gov.tools, []);
    // Nothing forbidden — and specifically no accept tool — reached the transport.
    for (const name of server.tools.keys()) {
      assert.ok(!FORBIDDEN.test(name), `a forbidden-named tool reached the surface: ${name}`);
    }
    assert.ok(!server.tools.has("obsidian_pending_review"));
  });
});

describe("governance module: renders a config-tab section (badge toggles + convergence fields, empty directory)", () => {
  test("collect() gives it a section — badge toggles + acceptedBy + requiredFrontmatterKeys, no tools, disabled", () => {
    const settings = { modules: {} };
    const hosted = collect(builtinModules(deps(settings)), settings.modules, settings);
    const gov = hosted.find((h) => h.id === "acceptance");
    assert.ok(gov, "governance not rendered by collect()");
    assert.ok(gov.summary.length > 0, "governance summary is empty");
    // The two badge-display toggles (ribbon + pane-tab, default ON) plus the two
    // acceptance-convergence fields (#221/#164): the accepted-by identity (text, default
    // "local-human") and the optional required-frontmatter conformance gate (csv, default
    // EMPTY = no gate). All four match the exact keys the pane wiring reads through
    // governanceDisplaySettings / governanceAcceptanceSettings.
    assert.deepEqual(gov.fields.map((f) => f.key), [
      "showRibbonBadge",
      "showViewTabBadge",
      "acceptedBy",
      "gateMode",
      "requiredFrontmatterKeys",
    ]);
    const byKey = new Map(gov.fields.map((f) => [f.key, f]));
    for (const key of ["showRibbonBadge", "showViewTabBadge"]) {
      assert.equal(byKey.get(key).type, "toggle");
      assert.equal(byKey.get(key).value, true, `${key} should default ON`);
    }
    assert.equal(byKey.get("acceptedBy").type, "text");
    assert.equal(byKey.get("acceptedBy").value, "local-human", "acceptedBy defaults to local-human");
    assert.equal(byKey.get("gateMode").type, "select");
    assert.equal(byKey.get("gateMode").value, "soft", "the gate responds softly by default");
    assert.equal(byKey.get("requiredFrontmatterKeys").type, "csv");
    assert.deepEqual(byKey.get("requiredFrontmatterKeys").value, [], "the conformance gate defaults EMPTY (no gate)");
    assert.equal(gov.enabled, false);
    assert.equal(gov.directory.tools.length, 0);
  });

  test("a stored `false` overrides the default-on toggle (the pane honors it)", () => {
    const settings = { modules: { acceptance: { config: { showRibbonBadge: false } } } };
    const hosted = collect(builtinModules(deps(settings)), settings.modules, settings);
    const gov = hosted.find((h) => h.id === "acceptance");
    const ribbon = gov.fields.find((f) => f.key === "showRibbonBadge");
    const tab = gov.fields.find((f) => f.key === "showViewTabBadge");
    assert.equal(ribbon.value, false, "stored false must override the default-on");
    assert.equal(tab.value, true, "the untouched toggle stays default-on");
  });
});

describe("governance module: config keys match what the pane actually reads", () => {
  test("the field keys ARE the governanceDisplaySettings + governanceAcceptanceSettings keys", async () => {
    const {
      governanceDisplaySettings,
      governanceAcceptanceSettings,
      DEFAULT_GOVERNANCE_SETTINGS,
      DEFAULT_ACCEPTANCE_SETTINGS,
    } = await import("../src/governor/kernel/settings.ts");
    const gov = governanceModule();
    const keys = gov.manifest.config.fields.map((f) => f.key).sort();
    // The pane derives its settings from exactly these keys — so a field key that drifted from
    // them would render a control that controls nothing.
    assert.deepEqual(
      keys,
      [...Object.keys(DEFAULT_GOVERNANCE_SETTINGS), ...Object.keys(DEFAULT_ACCEPTANCE_SETTINGS)].sort(),
    );
    // And the manifest defaults ARE the pane's defaults, so an untouched config renders
    // the same state the pane would use.
    assert.deepEqual(gov.manifest.config.defaults, { ...DEFAULT_GOVERNANCE_SETTINGS, ...DEFAULT_ACCEPTANCE_SETTINGS });
    // End-to-end: a config of {showRibbonBadge:false} the field would persist is read back by the
    // pane's own coercion as showRibbonBadge:false.
    assert.equal(governanceDisplaySettings({ showRibbonBadge: false }).showRibbonBadge, false);
    assert.equal(governanceDisplaySettings({ showRibbonBadge: false }).showViewTabBadge, true);
    // End-to-end for the convergence fields: what the text/csv fields persist is what the accept
    // path reads back (identity + gate list).
    assert.equal(governanceAcceptanceSettings({ acceptedBy: "nelson" }).acceptedBy, "nelson");
    assert.deepEqual(
      governanceAcceptanceSettings({ requiredFrontmatterKeys: ["uid", "title"] }).requiredFrontmatterKeys,
      ["uid", "title"],
    );
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
    const { server, registry } = mount({ modules: { acceptance: { enabled: true } } });
    const gov = registry.describe().find((d) => d.id === "acceptance");
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
      id: "acceptance",
      posture: "capability",
      capabilities: ["acceptance"],
      enabled: true,
      register(reg) {
        reg("obsidian_accept_note", { annotations: { readOnlyHint: false } }, () => ({}));
        reg("obsidian_advance_baseline", { annotations: { readOnlyHint: true } }, () => ({}));
      },
    };
    const registry = new ModuleRegistry([hostile], { acceptance: { enabled: true } });
    registry.registerAll((n, d, h) => server.registerTool(n, d, h), mountHost(deps()));
    assert.ok(!server.tools.has("obsidian_accept_note"));
    assert.ok(!server.tools.has("obsidian_advance_baseline"));
    assert.equal(registry.problems.filter((p) => p.includes("refused")).length, 2);
    assert.deepEqual(registry.describe().find((d) => d.id === "acceptance").tools, []);
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
  // gesture-gated pane handler. `stampAcceptedFrontmatter` is the #221/#164 convergence's ONE
  // production writer of the accepted family (processFrontMatter), replacing the retired pure
  // stampAcceptance helper.
  const ACCEPT_EQUIVALENT = [
    "performAccept", "performRevert", "performAdopt", "setClassEnabled", "reconcile",
    "getStore", "setBaseline", "acceptNote", "revertNote", "stampAcceptedFrontmatter",
  ];

  test("wiring.ts: the accept-equivalent capabilities are module-scope, not instance methods or this.<member>", () => {
    const wiring = code("governor/wiring/wiring.ts");
    for (const name of ACCEPT_EQUIVALENT) {
      assert.ok(!isInstanceMethod(wiring, name), `${name} must NOT be an instance method`);
      assert.ok(!referencesThisMember(wiring, name), `this.${name} must not exist (would be reachable from app)`);
    }
    // The accept-path capabilities ARE declared as module-scope functions.
    for (const fn of ["performAccept", "performRevert", "performAdopt", "reconcile", "setClassEnabled", "stampAcceptedFrontmatter"]) {
      assert.match(wiring, new RegExp(`\\n(?:async )?function ${fn}\\s*\\(`), `${fn} must be a module-scope function`);
    }
  });

  test("wiring.ts: the baseline store lives in a module-private WeakMap, never this.store", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.ok(!/\bthis\.store\b/.test(wiring), "store must not be this.store (would be reachable)");
    assert.match(wiring, /const baselineStores = new WeakMap</, "the store must be held in a module-private WeakMap");
  });

  test("wiring.ts: registers ZERO commands (a command is agent-invokable via obsidian_run_command)", () => {
    const wiring = code("governor/wiring/wiring.ts");
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
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /let disposed = false;/, "must track a disposed flag");
    assert.match(wiring, /component\.register\(\(\) => \{[\s\S]*?disposed = true;/, "cleanup hook must flip disposed");
    const m = /onLayoutReady\(async \(\) => \{([\s\S]*?)\n  \}\);/.exec(wiring);
    assert.ok(m, "onLayoutReady callback must exist");
    assert.match(m[1], /if \(disposed\) return;/, "onLayoutReady must bail when disposed");
    assert.match(m[1], /registerInterval/, "the poll interval is created inside onLayoutReady");
  });

  test("pane.ts: the controller lives in a module-private WeakMap, never on the instance", () => {
    const pane = code("governor/wiring/pane.ts");
    assert.ok(!/\bthis\.controller\b/.test(pane), "no this.controller (would be reachable)");
    assert.ok(!/(private|readonly)\s+controller\b/.test(pane), "no controller instance field on the view");
    assert.match(pane, /const viewDeps = new WeakMap</, "deps held in a module-private WeakMap");
    assert.match(pane, /viewDeps\.set\(this,/, "constructor stows deps in the WeakMap");
  });

  test("pane.ts: EVERY legacy accept-class control is gated on the cutover — offered, or omitted, never dead", () => {
    // The 2026-08-24 incident: Nelson cut over, clicked Accept, and got
    // `legacy_writer_disabled`. The refusal was right; offering the control was
    // not. The context menu was fixed first, and an independent review then
    // found the pane doing the SAME thing — rendering live Accept/Revert
    // buttons directly above its own notice saying Accept is disabled.
    const pane = code("governor/wiring/pane.ts");

    // The Proposed section's accept is not created at all once retired.
    assert.match(
      pane,
      /if \(!\(deps\.legacyRetired\?\.\(\) \?\? false\)\) \{\s*\n\s*const proposedAcceptBtn/,
      "the Proposed-section Accept must be inside a legacyRetired guard",
    );

    // The queue detail's accept + revert are removed once retired.
    const detailGuard = /if \(deps\.legacyRetired\?\.\(\) \?\? false\) \{[\s\S]{0,400}?acceptBtn\.remove\(\);[\s\S]{0,200}?revertBtn\.remove\(\);/;
    assert.match(pane, detailGuard, "the queue-detail Accept and Revert must be removed when legacy is retired");

    // Request-changes is deliberately NOT retired — it advances no baseline.
    assert.ok(
      !/legacyRetired[\s\S]{0,200}?requestBtn\.remove\(\)/.test(pane),
      "request-changes advances no baseline and must survive the cutover",
    );
  });

  test("VACUITY: the cutover-gate scan can fail — it is not matching on prose", () => {
    // Strip the guards and every assertion above must stop matching. Without
    // this, a regex drifting to match a comment would keep the suite green
    // while the buttons went back to being live.
    const stripped = code("governor/wiring/pane.ts")
      .replace(/if \(!\(deps\.legacyRetired\?\.\(\) \?\? false\)\) \{\s*\n\s*const proposedAcceptBtn/g, "const proposedAcceptBtn")
      .replace(/acceptBtn\.remove\(\);/g, "")
      .replace(/revertBtn\.remove\(\);/g, "");
    assert.ok(!/if \(!\(deps\.legacyRetired\?\.\(\) \?\? false\)\) \{\s*\n\s*const proposedAcceptBtn/.test(stripped));
    assert.ok(!/acceptBtn\.remove\(\);/.test(stripped));
  });

  test("pane.ts: every accept-class button is addEventListener-wired, NEVER via .onclick = (so .onclick stays null)", () => {
    const pane = code("governor/wiring/pane.ts");
    // WP9's three mandate controls are on this list because activation GRANTS
    // PROSPECTIVE AUTHORITY — a stronger act than a single admission — and
    // revoke/decline are human dispositions on the same surface. (Review of
    // #356: the buttons shipped correctly wired but unpinned; an onclick
    // rewrite of Activate survived the whole suite. Guard-exists-path-
    // doesn't-run, the family's canonical shape.)
    for (const el of [
      "acceptBtn", "revertBtn", "adoptBtn", "checkbox", "confirm", "proposedAcceptBtn", "proposedRequestBtn",
      "activateBtn", "revokeBtn", "declineBtn",
      // WP10a: promote arms automatic admission; demote is the brake — both authority-class.
      "promoteBtn", "demoteBtn",
    ]) {
      assert.ok(!new RegExp(`\\b${el}\\.onclick\\s*=`).test(pane),
        `${el}.onclick = … is the forgeable wiring — must use addEventListener`);
    }
    assert.match(pane, /activateBtn\.addEventListener\(\s*["']click["']/, "mandate Activate via addEventListener");
    assert.match(pane, /revokeBtn\.addEventListener\(\s*["']click["']/, "mandate Revoke via addEventListener");
    assert.match(pane, /declineBtn\.addEventListener\(\s*["']click["']/, "mandate Decline via addEventListener");
    assert.match(pane, /promoteBtn\.addEventListener\(\s*["']click["']/, "promotion Promote via addEventListener");
    assert.match(pane, /demoteBtn\.addEventListener\(\s*["']click["']/, "promotion Demote via addEventListener");
    assert.match(pane, /acceptBtn\.addEventListener\(\s*["']click["']/, "accept via addEventListener");
    assert.match(pane, /revertBtn\.addEventListener\(\s*["']click["']/, "revert via addEventListener");
    // The Proposed section's two controls (#221/#164) keep the same wiring discipline.
    assert.match(pane, /proposedAcceptBtn\.addEventListener\(\s*["']click["']/, "Proposed-section accept via addEventListener");
    assert.match(pane, /proposedRequestBtn\.addEventListener\(\s*["']click["']/, "Proposed-section request-changes via addEventListener");
    // Adopt is now wired by the SHARED wireAdoptButton helper (one implementation, shared with the
    // settings-tab render). That helper wires via `btn.addEventListener('click', …)` — never
    // `.onclick =` — and the pane hands it `adoptBtn`. Both facts are asserted so the adopt wiring
    // stays addEventListener-only across the refactor.
    assert.match(pane, /export function wireAdoptButton\(/, "wireAdoptButton is the shared adopt wiring");
    assert.match(pane, /btn\.addEventListener\(\s*["']click["']/, "wireAdoptButton wires via addEventListener");
    assert.match(pane, /wireAdoptButton\(\s*\n?\s*adoptBtn/, "the pane wires its adopt button via wireAdoptButton");
    assert.match(pane, /checkbox\.addEventListener\(\s*["']click["']/, "allowlist checkbox via addEventListener");
    assert.match(pane, /confirm\.addEventListener\(\s*["']click["']/, "modal confirm via addEventListener");
  });

  test("pane.ts: every accept-class handler gates on isRealGesture (directly or via runGuardedAdopt)", () => {
    const paneRaw = readRaw("governor/wiring/pane.ts");
    assert.match(paneRaw, /isRealGesture/, "the pane must use the isRealGesture gate");
    // accept/revert handlers gate directly on isRealGesture — including the Proposed
    // section's converged Accept and Request-changes (#221/#164).
    const lines = paneRaw.split("\n");
    // runGuardedDisposition IS the shared gesture gate (gesture.ts: "THE ONE
    // SHARED GESTURE GATE"; its first line is the isRealGesture check), so a
    // handler routing through it is gated — the tripwire accepts the shared
    // gate by name, same as it always accepted runGuardedAdopt (its wrapper).
    // admitBtn is on the list because ADMISSION advances standing — the §9
    // authority act — and the WP6b-2 revert button shares revertBtn's name.
    for (const el of ["acceptBtn", "revertBtn", "proposedAcceptBtn", "proposedRequestBtn", "admitBtn", "activateBtn", "revokeBtn", "declineBtn", "promoteBtn", "demoteBtn"]) {
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`${el}\\.addEventListener\\(`).test(lines[i])) {
          assert.match(
            lines.slice(i, i + 5).join("\n"),
            /isRealGesture|runGuardedDisposition|runGuardedAdopt/,
            `${el} handler must gate on isRealGesture (directly or via the shared gate)`
          );
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
    const wiringRaw = readRaw("governor/wiring/wiring.ts");
    const m = /async function setClassEnabled\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(wiringRaw);
    assert.ok(m, "setClassEnabled must be a module-scope function");
    // The refusal may carry the popout-incident Notice (2026-08-23) — the pin
    // is the GATE-then-refuse shape, not the exact statement body: the branch
    // must test !isRealGesture(evt) and its consequent must return false.
    assert.match(m[1], /if \(!isRealGesture\(evt\)\) \{?[^}\n]*return false;? ?\}?/,
      "setClassEnabled must refuse unless handed a real trusted gesture");
  });

  test("stampAcceptedFrontmatter (the ONE writer of the accepted family, #221/#164) is module-scope, unexported, gesture-path-only", () => {
    const wiringRaw = readRaw("governor/wiring/wiring.ts");
    const wiring = code("governor/wiring/wiring.ts");
    // Module-scope, NEVER exported: an export would let any importer hold the accepted-family
    // writer directly, outside the gesture perimeter.
    assert.match(wiring, /\nasync function stampAcceptedFrontmatter\(/, "must be a module-scope function");
    assert.ok(!/export\s+(?:async\s+)?function\s+stampAcceptedFrontmatter\b/.test(wiring), "must NOT be exported");
    assert.ok(!/export\s+\{[^}]*\bstampAcceptedFrontmatter\b/.test(wiring), "must NOT be re-exported");
    assert.ok(!/\bthis\.stampAcceptedFrontmatter\b/.test(wiring), "must not be an instance member");
    // It writes via Obsidian's own processFrontMatter, and the `accepted` VALUE is assigned to
    // acceptance-status in exactly ONE place in the whole wiring — inside this function. The
    // other processFrontMatter status writes are the agent-legal revising/proposed transitions.
    const acceptedAssigns = wiringRaw.match(/\bfm\[["']acceptance-status["']\]\s*=\s*(?!fields\.status)["']accepted["']/g) ?? [];
    assert.equal(acceptedAssigns.length, 0, "no literal 'accepted' status assignment outside the typed fields.status");
    const stampBody = /async function stampAcceptedFrontmatter\([\s\S]*?\n\}/.exec(wiringRaw);
    assert.ok(stampBody, "stampAcceptedFrontmatter body found");
    assert.match(stampBody[0], /processFrontMatter/, "the stamp writes via app.fileManager.processFrontMatter");
    assert.match(stampBody[0], /fm\["acceptance-status"\] = fields\.status/, "status comes from the typed fields (literal 'accepted' type)");
    // The ONLY caller is buildAcceptDeps' stampAccepted thunk (the acceptNote dep) — i.e. the
    // gesture-gated performAccept path. Two references total: declaration + the one thunk.
    const refs = wiring.match(/\bstampAcceptedFrontmatter\b/g) ?? [];
    assert.equal(refs.length, 2, "declaration + the buildAcceptDeps thunk — no other caller may exist");
    assert.match(wiring, /stampAccepted:\s*\(p,\s*fields\)\s*=>\s*stampAcceptedFrontmatter\(plugin,\s*p,\s*fields\)/,
      "the one call site is acceptNote's injected stampAccepted dep");
    // The MCP transport must reference NONE of the accept path.
    const mcpLayer = ["mcp/server.ts", ...mcpToolFiles()];
    for (const rel of mcpLayer) {
      const src = code(rel);
      for (const name of [
        "stampAcceptedFrontmatter", "stampAccepted", "performAccept", "performAdopt",
        "runGuardedAdopt", "setClassEnabled", "acceptNote", "revertNote",
      ]) {
        assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${rel} must not reference the accept-path fn ${name}`);
      }
      assert.ok(!/governor\/kernel\/accept/.test(readRaw(rel)), `${rel} must not import the accept kernel module`);
    }
  });

  test("the converged accept clears the human-input record (the #228 race discipline extends to the stamp write)", () => {
    // The stamp is a programmatic write landing right after a human click (and possibly recent
    // typing in the same note's editor). A lingering genuine-human-input record would let the
    // debounced reconcile misattribute a subsequent unrelated agent write as a human edit.
    const wiringRaw = readRaw("governor/wiring/wiring.ts");
    const m = /async function performAccept\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(wiringRaw);
    assert.ok(m, "performAccept body found");
    assert.match(m[1], /humanInputMap\(plugin\)\.delete\(path\)/, "performAccept must clear the human-input record");
    assert.match(m[1], /finally/, "the clear runs in finally — a partially-failed accept has still written");
  });

  test("the MCP transport imports nothing from src/governor/wiring/ (the accept pane), and pending-review stays always-on read-only", () => {
    for (const rel of ["mcp/server.ts", "mcp/modules-mount.ts", ...mcpToolFiles()]) {
      assert.ok(!/from ["'][^"']*\/governor\/wiring\/(pane|wiring)/.test(readRaw(rel)),
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
    assert.match(main, /modules\?\.acceptance\?\.enabled === true/, "gated on the acceptance module enabled flag");
    // The plugin exposes no accept-equivalent method and registers no accept command.
    for (const name of ["performAccept", "performAdopt", "setBaseline", "acceptNote", "stampAcceptedFrontmatter"]) {
      assert.ok(!isInstanceMethod(main, name), `${name} must not be a plugin instance method`);
    }
    assert.ok(!/addCommand\([^)]*accept/i.test(readRaw("main.ts")), "no accept command on the plugin");
  });
});

describe("history browser (#135): a READ-ONLY surface that confers nothing", () => {
  // The history browser reads the acceptance log and renders it. It must add NO accept surface:
  // no command, no MCP tool, no log-write path, and the MCP transport must not grow a way to
  // reach the log reader. (The render path's text-node-only discipline is pinned behaviorally in
  // governance-history.test.mjs.)

  test("wiring.ts: readAcceptanceLog is module-scope, read-only (adapter.read), never a this.<member> or export", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /\nasync function readAcceptanceLog\(/, "readAcceptanceLog must be a module-scope function");
    assert.ok(!/\bthis\.readAcceptanceLog\b/.test(wiring), "must not be an instance member");
    assert.ok(!/export\s+(?:async\s+)?function\s+readAcceptanceLog\b/.test(wiring), "must not be exported");
    // The one appendLog writer is unchanged; the history reader must never append.
    const m = /async function readAcceptanceLog\([\s\S]*?\n\}/.exec(wiring);
    assert.ok(m, "readAcceptanceLog body found");
    assert.ok(!/\.append\(|\.write\(/.test(m[0]), "the history reader must not write the log");
  });

  test("the kernel history module is import-reachable from the pane ONLY — never from the MCP layer", () => {
    for (const rel of ["mcp/server.ts", "mcp/modules-mount.ts", ...mcpToolFiles()]) {
      assert.ok(
        !/governor\/kernel\/history/.test(readRaw(rel)),
        `${rel} must not import the governance history module`,
      );
      assert.ok(!/\breadAcceptanceLog\b/.test(code(rel)), `${rel} must not reference readAcceptanceLog`);
    }
    // The positive leg — without it the loop above would pass in a world where NOBODY imports
    // the reader. Asserted on the pane's actual import SPECIFIER, not on the segment
    // `governor/kernel/history`: inside src/governor/ the pane's import is relative
    // (`../kernel/history.js`), so that segment survives only in prose, and a comment pinning
    // itself is not a pin.
    assert.match(
      readRaw("governor/wiring/pane.ts"),
      /from ["']\.\.\/kernel\/history\.js["']/,
      "the pane renders the history",
    );
  });

  test("history adds no command and no forbidden-named tool (the module still contributes ZERO tools)", () => {
    const { server, registry } = mount({ modules: { acceptance: { enabled: true } } });
    assert.deepEqual(registry.describe().find((d) => d.id === "acceptance").tools, []);
    for (const name of server.tools.keys()) {
      assert.ok(!/history/i.test(name), `no history tool may reach the MCP surface: ${name}`);
      assert.ok(!FORBIDDEN.test(name), `a forbidden-named tool reached the surface: ${name}`);
    }
    assert.ok(!/\baddCommand\b/.test(code("governor/wiring/pane.ts")), "the pane registers no command");
  });
});

describe("#101 dispositions-as-data: THE TRIPWIRE — the wrap adds no reachable callable", () => {
  // The descriptor refactor wraps accept/revert/adopt's EXISTING wiring in declared data and adds
  // two new human dispositions (request-changes, withdraw) plus ONE agent tool
  // (governance_submit_revision). These tests pin that the refactor changed reachability NOWHERE:
  // descriptors are pure data, the new human verbs are gesture-only, and the only new agent
  // surface is the guarded MCP tool registered in server.ts.

  test("dispositions.ts is a pure-data leaf: no accept import, no accept-path reference, no obsidian import", () => {
    const d = code("governor/kernel/dispositions.ts");
    assert.ok(!/^\s*import /m.test(readRaw("governor/kernel/dispositions.ts")), "dispositions.ts must import nothing");
    for (const name of ["performAccept", "performAdopt", "acceptNote", "revertNote", "stampAcceptedFrontmatter", "setBaseline", "runGuardedAdopt"]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(d), `dispositions.ts must not reference ${name}`);
    }
    assert.ok(!/from ["']obsidian["']/.test(readRaw("governor/kernel/dispositions.ts")));
  });

  test("wiring.ts: performRequestChanges / performWithdraw are module-scope, never instance methods, this.<members>, or exports", () => {
    const wiring = code("governor/wiring/wiring.ts");
    for (const fn of ["performRequestChanges", "performWithdraw", "listRevising", "listProposed"]) {
      assert.match(wiring, new RegExp(`\\n(?:async )?function ${fn}\\s*\\(`), `${fn} must be a module-scope function`);
      assert.ok(!new RegExp(`\\bthis\\.${fn}\\b`).test(wiring), `this.${fn} must not exist`);
      assert.ok(!new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`).test(wiring), `${fn} must NOT be exported`);
      assert.ok(!new RegExp(`export\\s+\\{[^}]*\\b${fn}\\b`).test(wiring), `${fn} must NOT be re-exported`);
    }
  });

  test("pane.ts: the request-changes and withdraw buttons are addEventListener-wired and isRealGesture-gated", () => {
    const paneRaw = readRaw("governor/wiring/pane.ts");
    const pane = code("governor/wiring/pane.ts");
    for (const el of ["requestBtn", "withdrawBtn"]) {
      assert.ok(!new RegExp(`\\b${el}\\.onclick\\s*=`).test(pane), `${el}.onclick = … is the forgeable wiring`);
      const lines = paneRaw.split("\n");
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`${el}\\.addEventListener\\(`).test(lines[i])) {
          assert.match(lines.slice(i, i + 5).join("\n"), /isRealGesture/, `${el} handler must gate on isRealGesture`);
          found = true;
        }
      }
      assert.ok(found, `${el} must be wired with addEventListener`);
    }
  });

  test("wiring.ts: NO menu-item onClick is accept-capable — each only opens the confirmation modal", () => {
    // A MenuItem handler can carry LAYER 2 (isRealGesture) but structurally cannot carry LAYER 1
    // (unreachability): `workspace.trigger("file-menu", <fake menu>, file, "…")` is public API, so
    // renderer-JS can hand this registration a stub menu that CAPTURES the onClick callback and
    // then calls it with a real, trusted MouseEvent kept from an earlier unrelated click. So the
    // menu path must reach the accept only THROUGH a modal whose own confirm button carries both
    // layers (pane.ts ConfirmModal: addEventListener + isRealGesture).
    const wiring = code("governor/wiring/wiring.ts");
    const lines = wiring.split("\n");
    for (const evt of ['"file-menu"', '"files-menu"']) {
      assert.match(wiring, new RegExp(`workspace\\.on\\(${evt}`), `${evt} must be registered via plugin.app.workspace.on`);
    }
    // Any parameter name, optional `async` — a renamed parameter must not silently opt a handler
    // out of this tripwire. No fixed count either: EVERY onClick found is checked, so a third
    // menu item added later is covered without editing a number here.
    const onClick = /\.onClick\(\s*(?:async\s*)?\(\s*\w*\s*\)?/;
    let onClickCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!onClick.test(lines[i])) continue;
      onClickCount++;
      const body = lines.slice(i, i + 4).join("\n");
      // Deliberately NOT asserting isRealGesture on the menu callback. #299 added it as defence
      // in depth; a live smoke test on 0.15.0 (file explorer, left sidebar) then showed Obsidian
      // renders this as a NATIVE Electron menu whose onClick receives no DOM Event, so the check
      // rejected every real click and the item was inert. Asserting it here would pin the feature
      // broken. The invariant that matters is unchanged and enforced below: a menu callback may
      // hand off to the modal flow and may NOT reach an accept-capable call.
      assert.match(body, /runMenuAccept/, "menu item onClick must only hand off to the confirm-modal flow");
      // The accept-capable calls must NOT be reachable from the menu callback itself.
      assert.ok(!/acceptThroughGate|acceptViaMenu|\bdeps\.accept\b/.test(body),
        "a menu onClick must never call the accept path directly — it opens confirmMenuAccept instead");
    }
    assert.ok(onClickCount >= 2, "the single-file and multi-select Accept menu items must both be onClick-wired");
    // The hand-off itself: the batch confirm modal is the ONLY way the menu flow reaches accept.
    const flow = wiring.match(/const runMenuAccept[\s\S]{0,600}/);
    assert.ok(flow, "runMenuAccept must exist");
    assert.match(flow[0], /confirmMenuAccept\(/, "runMenuAccept must open the confirmation modal first");
    assert.match(flow[0], /if \(!confirmed\) return/, "an unconfirmed modal must accept nothing");
    // ONE modal for the whole batch, then per-file accepts (a per-file confirm would be both worse
    // UX and a different gate); the per-file loop is what keeps one failure from aborting the rest.
    assert.match(flow[0], /for \(const t of targets\) await acceptViaMenu\(/,
      "the confirmed batch runs the per-file accepts independently");
  });

  test("pane.ts: confirmMenuAccept routes through the addEventListener+isRealGesture ConfirmModal", () => {
    const pane = code("governor/wiring/pane.ts");
    assert.match(pane, /export function confirmMenuAccept\(/, "the menu-accept confirmation must live in the pane");
    const fn = pane.match(/export function confirmMenuAccept\([\s\S]{0,900}/);
    assert.match(fn[0], /new ConfirmModal\(/, "it must reuse the gesture-gated ConfirmModal, not a bespoke dialog");
    // It must disclose the accepted-by stamp, like the pane's own Accept tooltip (acceptEffectFor).
    assert.match(fn[0], /acceptedBy/, "the confirmation must name the accepted-by identity it will stamp");
    assert.match(fn[0], /accepted-by/, "the confirmation must say that accepting stamps the accepted family");
  });

  test("pane.ts: the request-changes modal's confirm button is gesture-gated like the adopt confirm", () => {
    const paneRaw = readRaw("governor/wiring/pane.ts");
    // Both modal confirm buttons are named `confirm`; every one must be addEventListener-wired
    // (the shared .onclick tripwire above covers the forgeable form) and each addEventListener
    // handler must gate on isRealGesture within its opening lines.
    const lines = paneRaw.split("\n");
    let confirms = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/\bconfirm\.addEventListener\(/.test(lines[i])) {
        confirms++;
        assert.match(lines.slice(i, i + 4).join("\n"), /isRealGesture/, "modal confirm must gate on isRealGesture");
      }
    }
    assert.equal(confirms, 2, "both modals (adopt confirm + request-changes confirm) must be addEventListener-wired");
  });

  test("descriptors drive the render but carry NO callable: the pane reads only labels/ids from them", () => {
    const pane = code("governor/wiring/pane.ts");
    // The pane renders from the declared set …
    assert.match(pane, /dispositionsFor\("pending-item"\)/);
    // … and never invokes anything ON a descriptor (data in, no capability out).
    assert.ok(!/\bd\.effect\s*\(/.test(pane), "descriptor.effect must never be called");
    assert.ok(!/\bd\.(run|handler|action|perform)\b/.test(pane), "descriptors must carry no handler-shaped member");
  });

  test("the MCP layer never references the revision GESTURE path (the two human verbs stay pane-only)", () => {
    for (const rel of ["mcp/server.ts", "mcp/modules-mount.ts", ...mcpToolFiles()]) {
      const src = code(rel);
      // The module-scope gesture callables + the modal prompt — the names that would indicate the
      // MCP layer had grown a way to reach the human dispositions. (Prose like the module
      // summary's "withdraw a revision request" is fine; these identifiers are not.)
      for (const name of ["performRequestChanges", "performWithdraw", "promptRequestChanges", "listRevising", "listProposed", "buildProposedList"]) {
        assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `${rel} must not reference the gesture-path name ${name}`);
      }
    }
  });

  test("both disposition writes clear the human-input record — a modal keystroke must not launder a silent advance", () => {
    // performRequestChanges runs right after the human TYPED (in the modal). If the reviewed note
    // is also the active editor tab, that typing recorded genuine human input for the path, and
    // reconcile would misread the programmatic write as a human edit — silently baseline-advancing
    // the agent's unreviewed content without an Accept. Both writes must clear the record.
    const wiringRaw = readRaw("governor/wiring/wiring.ts");
    for (const fn of ["performRequestChanges", "performWithdraw"]) {
      const m = new RegExp(`async function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(wiringRaw);
      assert.ok(m, `${fn} body found`);
      assert.match(m[1], /humanInputMap\(plugin\)\.delete\(path\)/, `${fn} must clear the human-input record`);
    }
  });

  test("no command reaches the new dispositions (wiring/pane register zero commands — re-asserted post-#101)", () => {
    assert.ok(!/\baddCommand\b/.test(code("governor/wiring/wiring.ts")));
    assert.ok(!/\baddCommand\b/.test(code("governor/wiring/pane.ts")));
  });

  test("governance_submit_revision is the ONE new agent surface — NOT a governance-module tool, not accept-shaped", () => {
    // It registers in server.ts (the registerVaultWriteTools shape); the governance MODULE still
    // contributes ZERO tools, and the mounted module surface never sees it.
    const { server, registry } = mount({ modules: { acceptance: { enabled: true } } });
    assert.deepEqual(registry.describe().find((d) => d.id === "acceptance").tools, []);
    assert.ok(!server.tools.has("governance_submit_revision"));
    // The name deliberately does NOT match the forbidden matcher: submit-revision supplies a
    // candidate; it is not an accept/adopt/baseline verb.
    assert.ok(!FORBIDDEN.test("governance_submit_revision"));
    // And server.ts registers it through the ORDINARY patched registrar (guard/queue/journal).
    assert.match(code("mcp/server.ts"), /registerGovernanceRevisionTool\(server,/);
    // The tool module reaches ONLY the pure kernel machinery — never the pane/wiring gesture path.
    const tool = readRaw("mcp/tools-governance-revision.ts");
    assert.ok(!/from ["'][^"']*\/governor\/wiring\/(pane|wiring)/.test(tool));
    assert.match(tool, /governor\/kernel\/revision/);
  });

  test("the submit tool structurally cannot write acceptance: only setAcceptanceStatusProposed writes status", () => {
    const revision = code("governor/kernel/revision.ts");
    // The one status writer takes NO value parameter and hard-codes `proposed`.
    assert.match(revision, /export function setAcceptanceStatusProposed\(content: string\)/);
    assert.match(revision, /: proposed`/);
    assert.ok(!/accepted/.test(revision.replace(/acceptance[-_][sS]tatus/g, "")), "revision.ts must never name an accepted value");
    // And it must not reference the sanctioned accepted-writer.
    assert.ok(!/\bstampAcceptance\b/.test(revision));
  });
});

describe("governance settings-tab surface: the accept path stays module-private across the NEW home", () => {
  // The settings tab is a SECOND gesture-gated home for adopt-baseline + the auto-accept allowlist.
  // The invariant is unchanged: connection-ui.ts (the settings tab) must never hold, receive, or be
  // able to walk an accept-capable callable. It does so by calling a render function the governance
  // module EXPOSES, handing it only a container — the controls are built INSIDE the module from its
  // own module-private controller. These tests pin that arrangement at the source level.

  test("wiring.ts exposes renderGovernanceSettings as a module-scope function (not an accept export)", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /export function renderGovernanceSettings\(\s*plugin[^,]*,\s*containerEl/,
      "renderGovernanceSettings(plugin, containerEl) must be the exposed entry point");
    // The accept-capable controller + its callables must NOT be exported — only the render fn and
    // the mount-state predicate leave the module. An `export` of any accept verb would let the
    // settings tab (or anything importing wiring) hold an accept callable directly.
    for (const name of ["buildController", "performAdopt", "performAccept", "performRevert", "setClassEnabled", "getStore"]) {
      assert.ok(!new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(wiring),
        `${name} must NOT be exported from wiring.ts (it would escape the module boundary)`);
      assert.ok(!new RegExp(`export\\s+\\{[^}]*\\b${name}\\b`).test(wiring),
        `${name} must NOT be re-exported from wiring.ts`);
    }
  });

  test("renderGovernanceSettings builds its accept controls via the SHARED gesture-gated helpers", () => {
    const wiring = code("governor/wiring/wiring.ts");
    // It uses wireAdoptButton + renderAllowlist (the one addEventListener-gated implementation),
    // never a second inline `.addEventListener('click')` accept path or an `.onclick =` handler.
    assert.match(wiring, /wireAdoptButton\(/, "adopt must go through the shared wireAdoptButton");
    assert.match(wiring, /renderAllowlist\(/, "the allowlist must go through the shared renderAllowlist");
    assert.ok(!/\.onclick\s*=/.test(wiring), "wiring.ts must wire no forgeable .onclick accept handler");
    // The adopt confirm is the shared confirmAdopt (gesture- + confirmation-gated), and the allowlist
    // hands renderAllowlist only the three narrow module-scope thunks — never a full controller.
    assert.match(wiring, /confirmAdopt\(plugin\.app\)/, "adopt confirmation uses the shared confirmAdopt");
    assert.match(wiring, /setClassEnabled:\s*\(id,\s*on,\s*evt\)\s*=>\s*setClassEnabled\(plugin,/,
      "the allowlist mutator thunk forwards the event to the gesture-gated module-scope setClassEnabled");
  });

  test("renderGovernanceSettings renders only when governance is MOUNTED, else a hint (no live accept controls)", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /if\s*\(!isGovernanceMounted\(plugin\)\)/,
      "must gate the controls on the live-mount predicate");
    // The mount flag is a plain WeakSet membership — it holds NO callable, so it cannot itself be an
    // accept gadget, and it is deleted on the mount's teardown so a disabled module shows the hint.
    assert.match(wiring, /const mountedPlugins = new WeakSet</, "mount state is a module-private WeakSet");
    assert.match(wiring, /mountedPlugins\.delete\(plugin\)/, "the mount flag is dropped on teardown");
  });

  test("connection-ui.ts renders governance by handing the module a CONTAINER, receiving nothing back", () => {
    const ui = code("connection-ui.ts");
    // It calls the module's render fn with (this.plugin, section) — a container — and does NOT
    // capture a return value (renderGovernanceSettings returns void; there is nothing to capture).
    assert.match(ui, /if\s*\(mod\.id === "acceptance"\)\s*renderGovernanceSettings\(this\.plugin,\s*\w+\)/,
      "the governance branch passes only a container, mirroring the vocab branch");
    assert.ok(!/=\s*renderGovernanceSettings\(/.test(ui),
      "connection-ui must not assign renderGovernanceSettings' result to anything");
    // And it never references any accept-equivalent callable directly (its only governance touch is
    // the render fn + the module-enabled toggle).
    for (const name of ["performAccept", "performAdopt", "runGuardedAdopt", "setClassEnabled", "acceptNote", "revertNote", "buildController", "confirmAdopt"]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(ui), `connection-ui must not reference the accept-path fn ${name}`);
    }
  });

  test("the fuller auto-accept text is a SHARED constant (both surfaces render the same one, not two literals)", () => {
    const pane = code("governor/wiring/pane.ts");
    // The constant exists and the pane's allowlist renderer uses it (not an inline string that a
    // settings-tab copy could drift from).
    assert.match(pane, /export const AUTO_ACCEPT_DESC\s*=/, "AUTO_ACCEPT_DESC must be exported from pane.ts");
    assert.match(pane, /governance-allowlist-desc["'],\s*text:\s*AUTO_ACCEPT_DESC/,
      "renderAllowlist must render AUTO_ACCEPT_DESC, not an inline string");
    // The settings tab reaches the same text THROUGH renderAllowlist (shared) — so there is exactly
    // one definition. The RUNTIME value's fuller phrasing (spanning the source's string-concat
    // boundary) is pinned behaviorally in governance-settings-tab.test.mjs against the imported
    // constant; here we only pin the single-source STRUCTURE.
    // The adopt description is likewise a shared constant the settings tab imports.
    assert.match(pane, /export const ADOPT_BASELINE_DESC\s*=/, "ADOPT_BASELINE_DESC must be exported from pane.ts");
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /ADOPT_BASELINE_DESC/, "the settings tab must reference the shared ADOPT_BASELINE_DESC");
  });
});

// ---------------------------------------------------------------------------
// #261 — the event-driven sweep drive + the published pending index.
// Live-diagnosed: Chromium throttles/suspends renderer timers while the
// Obsidian window is occluded, so the 2.5s poll interval does not tick during
// unattended sessions — exactly when agents write. The journal-append nudge is
// the throttling-immune drive; these pins keep it (and the index publisher)
// from silently regressing back to timer-only.
// ---------------------------------------------------------------------------
describe("governance module: #261 — journal nudge + pending-index publisher", () => {
  test("wiring.ts exports nudgeGovernanceQueue, gated on the mounted set (no-op unmounted)", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /export function nudgeGovernanceQueue\s*\(/, "the nudge must be exported for main.ts");
    const body = wiring.slice(wiring.indexOf("export function nudgeGovernanceQueue"));
    assert.match(body.slice(0, 300), /mountedPlugins\.has\(plugin\)/, "the nudge must check the live-mount set first");
  });

  test("main.ts nudges the governance queue after every journal append", () => {
    const main = code("main.ts");
    assert.match(main, /nudgeGovernanceQueue/, "main.ts must import and call the nudge");
    assert.match(main, /journal\.append\s*=/, "the kernel journal's append must be wrapped with the nudge");
  });

  test("refresh() publishes the pending index at the plugin-dir governance path", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /serializePendingIndex\(pending/, "refresh must serialize the freshly computed queue");
    assert.match(wiring, /pendingIndexPath: `\$\{govDir\}\/pending-index\.json`/, "the index lives beside the acceptance log");
  });

  test("unmount retracts the published index (absent index ⇒ the tool's explicit not-published state)", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /adapter\.remove\(paths\(plugin\)\.pendingIndexPath\)/, "teardown must remove the published index");
  });

  test("the poll interval callback contains the rejection guard (no unhandled rejection into the interval)", () => {
    const wiring = code("governor/wiring/wiring.ts");
    assert.match(wiring, /pollJournal\(plugin\)\.catch\(/, "poll rejections must die in a console.error, never escape");
  });
});
