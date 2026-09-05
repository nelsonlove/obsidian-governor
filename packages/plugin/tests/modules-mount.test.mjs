/**
 * modules-mount.test.mjs — the module-host MOUNT (mcp/modules-mount.ts): the
 * built-in capability modules registering THROUGH the ModuleRegistry, and the
 * mount-step security gate's testable halves:
 *
 *   gate 1 (handler reachability): every module-contributed tool is
 *          explicitly read-only, and the mount REFUSES one that is not;
 *   gate 2 (minimal host ctx): mountHost hands modules exactly
 *          {getSettings, visible} — no kernel, no sources, no registrar;
 *   gate 3 (registry-only registration): server.ts no longer calls
 *          registerSchemeTools directly (source scan);
 *   plus settings-toggling over the real modules, and tripwire/collision
 *   plumbing staying live on the mount path.
 *
 * Headless: modules-mount.ts imports nothing from `obsidian`; the vault
 * arrives as a static note listing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fakeServer } from "./fake-server.mjs";
import { mountModules, mountHost, builtinModules } from "../src/mcp/modules-mount.ts";
import { ModuleRegistry, collect, toolDocDrift, toolDocReadOnlyDrift } from "../src/kernel/modules/index.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** A tiny fake vault: the scheme module gets `notes`. */
const NOTES = ["00-09 System/06 Agent tooling/06.20 obsidian-vault-mcp-plugin.md"];

/** A no-op pending-review source for the governance module — the module registers
 * obsidian_pending_review over it without ever calling the handler in these tests. */
const pendingReviewSource = { read: async () => null };

/** A no-op provenance backend — the provenance module registers its tools over
 * it without ever calling a handler in these registration-only tests. */
const provenanceSource = {
  noteFrontmatter: () => null,
  read: async () => null,
  stat: async () => null,
  glob: async () => [],
  writeNote: async () => {},
};

// Inert `vocabSource`, `healthSource` and `basesSource` fixtures lived here
// until the S7 satellite extraction. Those three modules are separate plugins
// now (`vault-vocab`, `vault-health`, `vault-bases`), each with its own suite,
// and `MountDeps` no longer declares a slot for any of them.

function deps(overrides = {}) {
  return {
    getSettings: () => ({ ...(overrides.settings ?? {}) }),
    schemeNotes: () => NOTES,
    pendingReviewSource,
    provenanceSource,
    // The fileclass module (#188) gates on the Fileclass plugin being present +
    // a CLI binary; supply both so an ENABLED fileclass module registers its
    // eight tools (the drift checks need a contributed tool list). The exec is
    // never called in these registration-only tests.
    vaultName: "TestVault",
    fileclassPresent: () => true,
    fileclassBinary: "/usr/local/bin/fileclass",
    ...overrides.deps,
  };
}

function mount(overrides = {}) {
  const server = fakeServer();
  const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps(overrides));
  return { server, registry };
}

describe("mountModules: the built-in modules register through the registry", () => {
  test("default settings: the scheme tools are all present, no problems", () => {
    const { server, registry } = mount();
    const names = [...server.tools.keys()];
    // The scheme module's five, exactly as the direct registrations used to
    // contribute them. (The vocab module's four were listed here until the S7
    // satellite extraction; scheme is the last of the pre-host pair.)
    for (const n of [
      "obsidian_schemes",
      "obsidian_resolve_address",
      "obsidian_next_address",
      "obsidian_list_scope",
      "obsidian_expected_location",
    ]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.deepEqual(registry.problems, []);
    const described = registry.describe();
    // provenance (the obsidian-provenance fold), fileclass (#188, the
    // fileclass CLI fold), governance (#83) and jd-scaffold (Stage A of the
    // jd-dashboard fold) all ship DISABLED (opt-in surfaces a human turns on),
    // so they contribute nothing here — scheme is the only live module left.
    // (Triage was a tenth module until S5, cross-session a ninth until S6, and
    // vocab, health and bases went at S7; they are the `vault-triage`,
    // `vault-crosssession`, `vault-vocab`, `vault-health` and `vault-bases`
    // satellite plugins and mount nothing here.)
    assert.deepEqual(described.map((d) => d.id), ["scheme", "provenance", "fileclass", "acceptance", "jd-scaffold"]);
    for (const d of described) {
      if (["provenance", "fileclass", "acceptance", "jd-scaffold"].includes(d.id)) {
        assert.equal(d.enabled, false);
        assert.deepEqual(d.tools, []);
      } else {
        assert.ok(d.enabled && d.tools.length > 0);
      }
    }
    // No provenance/fileclass tool leaked onto the surface while the modules are off.
    assert.ok(!names.some((n) => n.startsWith("provenance_")));
    assert.ok(!names.some((n) => n.startsWith("fileclass_")));
    // Nothing triage-, vocab-, health- or bases-shaped can leak from the mount
    // at all now: those modules are gone. Kept as pins because the satellites
    // publish through the EXTERNAL registry, which is a different surface with
    // a different gate — and because these names are exactly what a
    // half-reverted extraction would put back.
    assert.ok(!names.some((n) => n.startsWith("triage_") || n.startsWith("vault_triage_")));
    assert.ok(!names.some((n) => n.startsWith("obsidian_vocab") || n === "obsidian_resolve_term" || n === "obsidian_validate_terms" || n === "obsidian_list_vocabulary"));
    assert.ok(!names.includes("obsidian_health") && !names.includes("obsidian_lint"));
    assert.ok(!names.some((n) => n.startsWith("base_") || n.startsWith("vault_bases_")));
    // obsidian_pending_review is NEVER on the MODULE surface (#83 cycle 2): it is
    // registered always-on in server.ts, decoupled from the governance toggle, so the
    // mount never contributes it whether governance is on or off.
    assert.ok(!names.includes("obsidian_pending_review"));
  });

  test("governance ON: contributes ZERO MCP tools (the accept surface is an Obsidian pane, not a tool)", () => {
    const { server, registry } = mount({ settings: { modules: { acceptance: { enabled: true } } } });
    const names = [...server.tools.keys()];
    // The governance module's capability is the review pane (wired in main.ts) — it puts
    // NOTHING on the MCP transport. Enabling it adds no tool at all, and never the
    // always-on-elsewhere obsidian_pending_review.
    assert.ok(!names.includes("obsidian_pending_review"));
    assert.deepEqual(registry.problems, []);
    const gov = registry.describe().find((d) => d.id === "acceptance");
    assert.equal(gov.enabled, true);
    assert.deepEqual(gov.tools, []);
  });

  test("settings-toggle: modules.scheme.enabled=false unmounts the scheme surface", () => {
    const { server, registry } = mount({ settings: { modules: { scheme: { enabled: false } } } });
    const names = [...server.tools.keys()];
    assert.ok(!names.some((n) => n.includes("address") || n === "obsidian_schemes" || n === "obsidian_list_scope"));
    assert.equal(registry.isEnabled("scheme"), false);
  });

  test("a stale modules.vocab / .health / .bases row is an unknown id, not a mount", () => {
    // The three modules left at S7. An existing data.json still carries their
    // rows; the mount must simply not know them rather than resurrect anything.
    const { server, registry } = mount({
      settings: { modules: { vocab: { enabled: true }, health: { enabled: true }, bases: { enabled: true } } },
    });
    const names = [...server.tools.keys()];
    assert.ok(!names.some((n) => n.startsWith("obsidian_vocab") || n === "obsidian_health" || n.startsWith("base_")));
    assert.equal(registry.describe().find((d) => d.id === "vocab"), undefined);
    assert.equal(registry.describe().find((d) => d.id === "health"), undefined);
    assert.equal(registry.describe().find((d) => d.id === "bases"), undefined);
    // Reported, not silently swallowed — the same "unknown module id" note a
    // stale `modules.skills` / `.triage` / `.crosssession` row already gets.
    // It is how a user learns why a module tab disappeared.
    assert.deepEqual(registry.problems, [
      "settings name unknown module 'vocab' — ignored",
      "settings name unknown module 'health' — ignored",
      "settings name unknown module 'bases' — ignored",
    ]);
  });

  test("a registered scheme tool actually answers over the injected listing", async () => {
    const { server } = mount();
    const { handler } = server.tools.get("obsidian_schemes");
    const res = await handler({});
    assert.equal(res.isError, undefined);
    assert.ok(res.structuredContent.schemes.some((s) => s.id === "jd"));
  });
});

describe("mount gate 1: read-only-only registrar", () => {
  test("every mounted tool is explicitly read-only", () => {
    const { server } = mount();
    for (const [name, { def }] of server.tools) {
      assert.equal(def.annotations?.readOnlyHint, true, `${name} must be read-only`);
    }
  });

  test("a module tool without readOnlyHint:true is gate-refused: reported, unregistered, and NOT recorded", () => {
    // A drifted module contributing a mutating and an unannotated tool,
    // pushed through the same gate mountModules installs. The gate runs
    // BEFORE the registry's bookkeeping, so the refusal must not appear in
    // describe() and must not reserve the name for later modules.
    const server = fakeServer();
    const gate = (name, def) => (def?.annotations?.readOnlyHint === true ? null : "not explicitly read-only");
    const hostile = {
      id: "drift",
      posture: "capability",
      capabilities: ["x"],
      enabled: true,
      register(reg) {
        reg("obsidian_drift_write", { annotations: { readOnlyHint: false } }, () => ({}));
        reg("obsidian_drift_bare", {}, () => ({}));
      },
    };
    const honest = {
      id: "honest",
      posture: "capability",
      capabilities: ["y"],
      enabled: true,
      register(reg) {
        // Reuses a name the hostile module was refused on — must register
        // fine: a refusal reserves nothing.
        reg("obsidian_drift_write", { annotations: { readOnlyHint: true } }, () => ({ from: "honest" }));
      },
    };
    const reg2 = new ModuleRegistry([hostile, honest], {});
    reg2.registerAll((n, d, h) => server.registerTool(n, d, h), mountHost(deps()), { gate });
    assert.ok(!server.tools.has("obsidian_drift_bare"));
    assert.equal(reg2.problems.filter((p) => p.includes("'drift'") && p.includes("refused")).length, 2);
    // describe() is truthful: the refused tools are not listed as contributed.
    const drift = reg2.describe().find((d) => d.id === "drift");
    assert.deepEqual(drift.tools, []);
    // The refused name was never reserved — the honest module holds it now.
    assert.equal(server.tools.get("obsidian_drift_write").handler().from, "honest");
    assert.deepEqual(reg2.describe().find((d) => d.id === "honest").tools, ["obsidian_drift_write"]);
  });
});

describe("mount gate 2: the host ctx handed to modules is minimal", () => {
  test("mountHost exposes exactly {getSettings, visible} — nothing else", () => {
    const host = mountHost(deps());
    assert.deepEqual(Object.keys(host).sort(), ["getSettings", "visible"]);
    assert.equal(typeof host.getSettings, "function");
    assert.equal(typeof host.visible, "function");
  });

  test("host.visible applies the allowlist", () => {
    const host = mountHost(deps({ settings: { allowlist: ["Projects"] } }));
    assert.deepEqual(host.visible(["Projects/a.md", "Archive/b.md"]), ["Projects/a.md"]);
  });

  test("builtinModules declares the five capability modules (provenance + fileclass + jd-scaffold mutating; acceptance NOT)", () => {
    const mods = builtinModules(deps());
    assert.deepEqual(mods.map((m) => [m.id, m.posture]), [
      ["scheme", "capability"],
      ["provenance", "capability"],
      // fileclass (#188, the fileclass CLI fold) is a MUTATING capability module
      // (set / set_where write typed frontmatter through the accept guard).
      ["fileclass", "capability"],
      // governance is posture "capability", NOT "governance" — the v1 registry refuses
      // the governance posture (it is inert). It clears that gate by being read-only.
      ["acceptance", "capability"],
      // jd-scaffold (Stage A of the jd-dashboard fold) is a MUTATING capability
      // module (standard_zeros / ensure_category_indexes / promote_to_folder
      // create/rename real vault notes and folders).
      ["jd-scaffold", "capability"],
      // WHAT LEFT, and when: triage (#221 phase 2) at S5, cross-session (#232)
      // at S6, and vocab + health + bases (#243) at S7. All five are satellite
      // plugins now, reaching the vault through the external-tool registry —
      // same guarded interception point, different publisher. This list is the
      // shrinking record of the suite split; a name reappearing here without a
      // package being deleted would be a half-reverted extraction.
    ]);
    // provenance, fileclass and jd-scaffold are the modules that declare they
    // may contribute mutating tools; scheme and acceptance are NOT mutating.
    assert.deepEqual(mods.filter((m) => m.mutating).map((m) => m.id), ["provenance", "fileclass", "jd-scaffold"]);
  });
});

describe("mount gate 3: registry-only registration (source scan)", () => {
  // The scan is over ALL of src/, not a hand-kept file list (the
  // link-healing scan's lesson): a new file calling the scheme/vocab
  // registrars directly would bypass the tripwire and collision checks.
  function tsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return tsFiles(p);
      return e.isFile() && p.endsWith(".ts") ? [p] : [];
    });
  }

  test("registerSchemeTools is CALLED only in modules-mount.ts", () => {
    const offenders = [];
    for (const f of tsFiles(SRC)) {
      const base = path.basename(f);
      // tools-vocab.ts was in this skip list until the S7 satellite extraction.
      if (base === "modules-mount.ts" || base === "tools-scheme.ts") continue;
      const src = readFileSync(f, "utf8");
      if (/register(Scheme|Vocab)Tools\s*\(/.test(src)) offenders.push(base);
    }
    assert.deepEqual(offenders, [], `direct scheme/vocab registration outside the mount: ${offenders}`);
  });

  test("the scan is live: it would catch a planted violation", () => {
    // Feed the regex a synthetic source line to prove the pattern matches the
    // call form (not just the import form the allowlisted files contain).
    assert.ok(/register(Scheme|Vocab)Tools\s*\(/.test("  registerSchemeTools(server, ctx);"));
    assert.ok(!/register(Scheme|Vocab)Tools\s*\(/.test('import { registerSchemeTools } from "./tools-scheme.js";'));
  });
});

describe("#81 config-host: both built-in modules carry a manifest, drift-free", () => {
  test("every module builtinModules() declares has a manifest with a summary", () => {
    const mods = builtinModules(deps());
    for (const m of mods) {
      assert.ok(m.manifest, `${m.id} has no manifest`);
      assert.equal(typeof m.manifest.summary, "string");
      assert.ok(m.manifest.summary.length > 0, `${m.id}'s manifest summary is empty`);
    }
  });

  test("scheme's manifest declares the four config fields the old hand-built Schemes section rendered", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    assert.deepEqual(
      scheme.manifest.config.fields.map((f) => f.key).sort(),
      ["contentDecimalFloor", "excludedRoots", "expandedAreas", "expandedCategories"],
    );
  });

  test("acceptance's manifest is the capability-directory-only case: no config fields is legal", () => {
    // Vocab was the module this pinned until S7 — a REAL module with a
    // manifest but no `config` block, so the renderer's "section with zero
    // fields" path had a live subject rather than a synthetic fixture.
    // Acceptance inherits the role: it has config fields but an EMPTY tool
    // directory, the other half of the same "never skipped, never a crash"
    // guarantee.
    const acceptance = builtinModules(deps()).find((m) => m.id === "acceptance");
    assert.ok(acceptance.manifest.config);
    assert.deepEqual(acceptance.manifest.directory.tools, []);
  });

  test("drift check: every ToolDoc names a tool the module ACTUALLY contributed on registerAll, and vice versa", () => {
    // Enable every default-off module so all modules contribute — the drift check
    // needs a contributed tool list to compare each manifest against.
    const { registry } = mount({ settings: { modules: { provenance: { enabled: true }, fileclass: { enabled: true }, acceptance: { enabled: true }, "jd-scaffold": { enabled: true } } } });
    const described = registry.describe();
    for (const d of described) {
      const mod = builtinModules(deps()).find((m) => m.id === d.id);
      const problems = toolDocDrift(mod.manifest.directory.tools ?? [], d.tools);
      assert.deepEqual(problems, [], `${d.id}: ${problems.join("; ")}`);
    }
  });

  test("readOnly drift: every ToolDoc's readOnly matches the tool's real registered annotation", () => {
    const { server } = mount({ settings: { modules: { provenance: { enabled: true }, fileclass: { enabled: true }, acceptance: { enabled: true }, "jd-scaffold": { enabled: true } } } });
    const mods = builtinModules(deps());
    const annotationsByName = Object.fromEntries([...server.tools].map(([name, { def }]) => [name, def.annotations]));
    for (const mod of mods) {
      const problems = toolDocReadOnlyDrift(mod.manifest.directory.tools ?? [], annotationsByName);
      assert.deepEqual(problems, [], `${mod.id}: ${problems.join("; ")}`);
    }
  });

  test("scheme's ConfigBinding round-trips against the REAL settings shape (settings.schemes[0])", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const settings0 = { schemes: [{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: ["90-99"] } }] };
    const settings1 = scheme.configBinding.write(settings0, { contentDecimalFloor: 15, excludedRoots: ["Archive"] });
    assert.deepEqual(scheme.configBinding.read(settings1), {
      expandedAreas: ["90-99"],
      contentDecimalFloor: 15,
      excludedRoots: ["Archive"],
    });
    // Non-mutating: the original settings object is untouched.
    assert.deepEqual(settings0.schemes[0].config, { expandedAreas: ["90-99"] });
    assert.equal(settings0.schemes[0].excludedRoots, undefined);
  });

  test("scheme's ConfigBinding self-heals an explicitly empty schemes: [] instead of silently no-opping the write", () => {
    // The generic renderer always shows the scheme fields (unlike the old
    // hand-built section, which hid itself when no JD instance existed) —
    // an empty schemes array must not turn a field edit into a silent no-op.
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const settings0 = { schemes: [] };
    const settings1 = scheme.configBinding.write(settings0, { contentDecimalFloor: 5 });
    assert.equal(settings1.schemes.length, 1);
    assert.equal(settings1.schemes[0].provider, "johnny-decimal");
    assert.deepEqual(scheme.configBinding.read(settings1), { contentDecimalFloor: 5 });
    // The original (empty) array is untouched.
    assert.deepEqual(settings0.schemes, []);
  });

  test("scheme's ConfigBinding refuses to write JD-shaped keys into a schemes[0] of a foreign provider", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const settings0 = { schemes: [{ id: "other", provider: "some-other-provider", config: { anything: true } }] };
    assert.deepEqual(scheme.configBinding.read(settings0), {});
    const settings1 = scheme.configBinding.write(settings0, { contentDecimalFloor: 5 });
    // No-op: the foreign instance's config is untouched, not corrupted with
    // a JD-shaped key it doesn't understand.
    assert.deepEqual(settings1, settings0);
  });

  test("scheme's manifest validate rejects an invalid expandedAreas token loudly (subsumes validateJdConfig)", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const problems = scheme.manifest.config.validate({ expandedAreas: ["not-an-area"] });
    assert.ok(problems.some((p) => p.includes("expandedAreas")));
  });

  test("scheme's manifest validate rejects an invalid excludedRoots entry loudly (the instance-level sibling field)", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const problems = scheme.manifest.config.validate({ excludedRoots: ["/absolute/not/allowed"] });
    assert.ok(problems.some((p) => p.includes("excludedRoots") && p.includes("relative")));
  });

  test("scheme's manifest validate accepts a fully valid config with no problems", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    assert.deepEqual(
      scheme.manifest.config.validate({ expandedAreas: ["90-99"], expandedCategories: ["27"], contentDecimalFloor: 10, excludedRoots: ["Archive"] }),
      [],
    );
  });

  test("collect() over the real mounted modules renders a section for each, scheme with fields", () => {
    const settings = { schemes: [{ id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 20 } }], modules: {} };
    const mods = builtinModules(deps({ settings }));
    const hosted = collect(mods, settings.modules, settings);
    assert.deepEqual(hosted.map((h) => h.id), ["scheme", "provenance", "fileclass", "acceptance", "jd-scaffold"]);
    const scheme = hosted.find((h) => h.id === "scheme");
    assert.equal(scheme.fields.find((f) => f.key === "contentDecimalFloor").value, 20);
    // The governance module renders its section too — two badge-display toggles
    // (ribbon + pane-tab, default ON) plus the two acceptance-convergence fields
    // (#221/#164: acceptedBy text, requiredFrontmatterKeys csv) and an EMPTY capability
    // directory, because its capability is the Obsidian review pane (wired in main.ts),
    // not an MCP tool. It contributes nothing to the transport and ships disabled.
    const governance = hosted.find((h) => h.id === "acceptance");
    assert.deepEqual(governance.fields.map((f) => f.key), [
      "showRibbonBadge",
      "showViewTabBadge",
      "acceptedBy",
      "gateMode",
      "requiredFrontmatterKeys",
    ]);
    const govField = (k) => governance.fields.find((f) => f.key === k);
    assert.ok(["showRibbonBadge", "showViewTabBadge"].every((k) => govField(k).type === "toggle" && govField(k).value === true));
    assert.equal(govField("acceptedBy").type, "text");
    assert.equal(govField("acceptedBy").value, "local-human");
    assert.equal(govField("requiredFrontmatterKeys").type, "csv");
    assert.deepEqual(govField("requiredFrontmatterKeys").value, []);
    assert.equal(governance.enabled, false);
    assert.equal(governance.directory.tools.length, 0);
    // The fileclass module (#188, the fileclass CLI fold) renders its own config
    // tab: one config field (the CLI binary path, default blank) plus an
    // eight-tool capability directory (six read + two write). Ships disabled.
    const fileclass = hosted.find((h) => h.id === "fileclass");
    assert.equal(fileclass.fields.length, 1);
    assert.equal(fileclass.fields.find((f) => f.key === "binaryPath").value, "");
    assert.equal(fileclass.enabled, false);
    assert.equal(fileclass.directory.tools.length, 8);
    assert.equal(fileclass.directory.tools.filter((t) => t.readOnly === false).length, 2);
    // Five modules rendered their own config tabs here and no longer do:
    // triage's eight fields left at S5, crosssession's three at S6, and at S7
    // health's one (`emptyChars`), bases' two (`queryTimeoutMs` / `rowCap`) and
    // vocab's bespoke LIST-shaped instance form — the one module-specific
    // branch this renderer ever had. Each set was ported verbatim into its own
    // package's `src/settings.ts` and is pinned by that package's suite; the
    // host hosts nothing for any of them.
    for (const gone of ["triage", "crosssession", "vocab", "health", "bases"]) {
      assert.equal(hosted.find((h) => h.id === gone), undefined, `${gone} should not be hosted`);
    }
  });
});
