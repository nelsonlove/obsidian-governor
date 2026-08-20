/**
 * operations-surface-inventory.test.mjs — WP0's bidirectional inventory.
 *
 * WP0 asks for two things that only mean something together:
 *
 *   • an inventory of every MCP surface; and
 *   • an INVERSE inventory proving every reachable handler has a registered
 *     action and every binding resolves.
 *
 * One without the other is how a capability comes to exist in source, vanish
 * at runtime, remain in the README, and still look supported. So this file
 * compares two independently produced views of the same facts:
 *
 *   declared — src/kernel/operations/inventory-mcp.ts, hand-written
 *   observed — tests/surface-scan.mjs, read out of the source
 *
 * and fails on any disagreement, in either direction, including the
 * `readOnlyHint` value itself. That last one is deliberate double-entry: the
 * declared table has to be self-contained (the registry is built inside the
 * running plugin, where no scanner exists), and because the two are authored
 * separately, a transcription slip and a future annotation change both fail
 * loudly instead of quietly agreeing with themselves.
 *
 * The scanner's own reach is tested too. A source scan that has silently
 * stopped matching is worse than no scan, so — following
 * `link-healing.test.mjs`'s precedent — a violation is PLANTED in a scratch
 * file and the scan must find it.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  scanMcpSurfaces,
  scanUnknownRegistrationCallees,
  REGISTRATION_CALLEES,
  KNOWN_PASSTHROUGH_SITES,
  PLUGIN_SRC,
} from "./surface-scan.mjs";
import {
  MCP_SURFACE_INVENTORY,
  EXTERNAL_PUBLISHER_ROW,
  mcpCompatibilityActions,
  mcpSurfaceBindings,
} from "../src/kernel/operations/inventory-mcp.ts";
import { createActionRegistry } from "../src/kernel/operations/registry.ts";
import { COMPAT_PREFIX, isCompatibilityAction } from "../src/kernel/operations/compatibility.ts";

const scan = await scanMcpSurfaces();

/** The declared rows, minus the one surface whose names are computed at
 * runtime — a third-party publisher's tools cannot appear in a source scan of
 * THIS repo, so comparing it against one would be meaningless. */
const declared = new Map(MCP_SURFACE_INVENTORY.map((r) => [r.tool, r]));

// ── the scanner must be able to see everything ───────────────────────────────

describe("surface scan — the scanner resolves every registration it finds", () => {
  test("nothing is unresolved", () => {
    assert.deepEqual(
      scan.unresolved,
      [],
      "a registration the scanner cannot resolve is a scanner failure, not a tool it may skip:\n" +
        scan.unresolved.map((u) => `  ${u.name} (${u.file}): ${u.reason}`).join("\n")
    );
  });

  test("no registration hides behind an unknown callee", async () => {
    const found = await scanUnknownRegistrationCallees();
    // `refuse("base_parse_error", …)` and `refuse("base_timeout", …)` in
    // tools-bases.ts are typed ERROR CODES that happen to match the tool-name
    // shape. They are refusals, not registrations. Listed explicitly so a
    // genuinely new registration callee still fails this test.
    const KNOWN_FALSE_POSITIVES = [
      { callee: "refuse", name: "base_parse_error" },
      { callee: "refuse", name: "base_timeout" },
    ];
    const unexplained = found.filter(
      (f) => !KNOWN_FALSE_POSITIVES.some((k) => k.callee === f.callee && k.name === f.name)
    );
    assert.deepEqual(
      unexplained,
      [],
      "a tool-name-shaped literal is passed to an identifier the scan does not know about, so a registration there " +
        "would be invisible to this inventory:\n" +
        unexplained.map((f) => `  ${f.callee}("${f.name}") in ${f.file}`).join("\n")
    );
  });

  test("the known registration callees are the documented five", () => {
    assert.deepEqual([...REGISTRATION_CALLEES].sort(), ["capture", "origRegister", "reg", "register", "registerTool"]);
  });

  test("the pass-through sites are the documented four", () => {
    assert.equal(KNOWN_PASSTHROUGH_SITES.length, 4);
    for (const site of KNOWN_PASSTHROUGH_SITES) {
      assert.ok(site.file && site.reason, `${site.file} needs a stated reason it cannot name a tool itself`);
    }
  });
});

// ── the scanner actually works ───────────────────────────────────────────────

describe("surface scan — proven against a planted registration", () => {
  const planted = resolvePath(PLUGIN_SRC, "mcp/__inventory-scan-scratch.ts");
  after(() => rm(planted, { force: true }));

  test("a newly added tool is caught by the scan and reported as undeclared", async () => {
    await writeFile(
      planted,
      [
        "// [test artifact — safe to delete] planted by operations-surface-inventory.test.mjs",
        "const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };",
        "export function registerPlanted(server: any) {",
        '  server.registerTool("obsidian_planted_violation", { title: "planted", inputSchema: {}, annotations: RW }, async () => ({}));',
        "}",
        "",
      ].join("\n"),
      "utf8"
    );
    const rescan = await scanMcpSurfaces();
    assert.ok(
      rescan.tools.has("obsidian_planted_violation"),
      "the scan no longer matches this repo's registration shape — it would silently under-report a real new tool"
    );
    assert.equal(rescan.tools.get("obsidian_planted_violation").readOnly, false);
    assert.ok(!declared.has("obsidian_planted_violation"), "the planted tool is correctly absent from the declared inventory");
  });
});

// ── forward: everything declared is registered ───────────────────────────────

describe("inventory — forward direction", () => {
  test("every declared surface exists in the source", () => {
    const missing = [...declared.keys()].filter((name) => !scan.tools.has(name));
    assert.deepEqual(
      missing,
      [],
      "these surfaces are declared in inventory-mcp.ts but nothing registers them — a row whose registration was deleted:\n" +
        missing.map((m) => `  ${m}`).join("\n")
    );
  });
});

// ── inverse: everything registered is declared ───────────────────────────────

describe("inventory — inverse direction", () => {
  test("every registered surface is declared", () => {
    const undeclared = [...scan.tools.keys()].filter((name) => !declared.has(name));
    assert.deepEqual(
      undeclared,
      [],
      "these tools are registered but have no action in inventory-mcp.ts — every reachable surface resolves to a " +
        "registered action, so add a row (with its module, distribution and postcondition) before merging:\n" +
        undeclared.map((n) => `  ${n} (${scan.tools.get(n).file})`).join("\n")
    );
  });
});

// ── the double-entry column ──────────────────────────────────────────────────

describe("inventory — declared readOnly agrees with the source", () => {
  test("no declared readOnly contradicts its annotation", () => {
    const wrong = [];
    for (const [name, row] of declared) {
      const found = scan.tools.get(name);
      if (!found) continue; // already reported by the forward test
      if (found.readOnly !== row.readOnly) {
        wrong.push(`  ${name}: inventory says readOnly=${row.readOnly}, ${found.file} declares readOnlyHint=${found.readOnly}`);
      }
    }
    assert.deepEqual(
      wrong,
      [],
      "readOnly is what the guard, the write queue and the journal all key on; a disagreement here means the " +
        "inventory describes a different safety posture than the one that runs:\n" + wrong.join("\n")
    );
  });

  test("the counts match, so neither view has drifted wholesale", () => {
    assert.equal(declared.size, scan.tools.size);
    const declaredReads = [...declared.values()].filter((r) => r.readOnly).length;
    const scannedReads = [...scan.tools.values()].filter((t) => t.readOnly).length;
    assert.equal(declaredReads, scannedReads);
  });
});

// ── the inventory is well-formed on its own terms ────────────────────────────

describe("inventory — internal consistency", () => {
  test("no duplicate tool rows", () => {
    const names = MCP_SURFACE_INVENTORY.map((r) => r.tool);
    assert.equal(new Set(names).size, names.length);
  });

  test("every row states a postcondition, a module and a distribution", () => {
    for (const row of [...MCP_SURFACE_INVENTORY, EXTERNAL_PUBLISHER_ROW]) {
      assert.ok(row.postcondition?.length > 10, `${row.tool} needs a real postcondition`);
      assert.ok(row.module?.length, `${row.tool} needs an owning module`);
      assert.ok(row.distribution?.length, `${row.tool} needs a distribution`);
    }
  });

  test("every surface registered outside the patched registrar explains itself", () => {
    // These four are the repo's deliberate exceptions. Each must carry its
    // reason in the inventory, so "why is this unguarded" is answerable from
    // the inventory alone rather than by reading server.ts.
    const outside = MCP_SURFACE_INVENTORY.filter((r) => r.unguardedRegistration);
    assert.deepEqual(
      outside.map((r) => r.tool).sort(),
      ["obsidian_call_tool", "obsidian_describe_tool", "obsidian_search_tools", "obsidian_write_notes"]
    );
    for (const row of outside) assert.ok(row.unguardedRegistration.length > 20, `${row.tool} needs a real reason`);
  });

  test("the third-party publisher surface is registered as a mechanism, not a fixed tool list", () => {
    assert.equal(EXTERNAL_PUBLISHER_ROW.readOnly, false, "an external read-only claim is disbelieved by default");
    assert.equal(EXTERNAL_PUBLISHER_ROW.refusesUnderScope, true, "a pathless external mutation cannot be bounded under a scope");
    assert.ok(!scan.tools.has(EXTERNAL_PUBLISHER_ROW.tool), "the publisher mechanism is not itself a registered tool name");
  });
});

// ── the whole thing loads into the registry and validates clean ──────────────

describe("inventory — builds a valid action registry", () => {
  const registry = createActionRegistry();
  for (const action of mcpCompatibilityActions()) registry.register(action);
  for (const binding of mcpSurfaceBindings()) registry.bind(binding);
  const problems = registry.validate();

  test("the MCP inventory validates with no problems", () => {
    assert.deepEqual(
      problems.map((p) => `${p.code}: ${p.message}`),
      []
    );
  });

  test("every action from this inventory is a compatibility action", () => {
    // Gate 0 declares nothing natively. When that stops being true, this test
    // is the reminder to move the action out of the compatibility inventory
    // rather than leaving a native contract in a table of derived ones.
    for (const action of registry.actions()) {
      assert.ok(isCompatibilityAction(action), `${action.id} is in the compatibility inventory but is not derived`);
      assert.equal(action.native, false);
      assert.ok(action.id.startsWith(COMPAT_PREFIX));
    }
  });

  test("no compatibility action claims durable observations or mandate eligibility", () => {
    for (const action of registry.actions()) {
      assert.equal(action.observations.defaultCapture, "ephemeral", `${action.id} must not claim durable capture`);
      assert.equal(action.observations.supportsProposal, false, `${action.id} must not claim proposal support`);
      assert.equal(action.authority.automaticAdmission, "never", `${action.id} must not claim mandate eligibility`);
    }
  });

  test("no compatibility action is Governor-only, so none can carry an authority class", () => {
    for (const action of registry.actions()) {
      assert.equal(action.authority.governorOnly, false);
      assert.ok(!action.changeClasses.includes("authority"), `${action.id} must not claim the authority class`);
    }
  });

  test("the migration debt is countable: every action is compat.*, and that number is the work left", () => {
    const compat = registry.actions().filter(isCompatibilityAction).length;
    assert.equal(compat, registry.actions().length);
    assert.equal(compat, MCP_SURFACE_INVENTORY.length + 1, "the +1 is the external-publisher mechanism");
  });
});

// ── the distribution projection is exact ─────────────────────────────────────

describe("inventory — distribution projection", () => {
  test("every distribution value is one of the four", () => {
    const allowed = new Set(["public-default", "public-optional", "private", "excluded"]);
    for (const row of [...MCP_SURFACE_INVENTORY, EXTERNAL_PUBLISHER_ROW]) {
      assert.ok(allowed.has(row.distribution), `${row.tool} has distribution '${row.distribution}'`);
    }
  });

  test("no excluded surface is also claimed as public", () => {
    const excluded = MCP_SURFACE_INVENTORY.filter((r) => r.distribution === "excluded").map((r) => r.tool);
    // Both exclusions are deliberate and named here so removing one is a
    // visible decision rather than a quiet reclassification.
    assert.deepEqual(excluded.sort(), ["obsidian_cli", "obsidian_delete_note"]);
  });

  test("the public profile is a strict subset of the whole surface", () => {
    const total = MCP_SURFACE_INVENTORY.length;
    const publicCount = MCP_SURFACE_INVENTORY.filter(
      (r) => r.distribution === "public-default" || r.distribution === "public-optional"
    ).length;
    assert.ok(publicCount > 0 && publicCount < total, "a profile that is all-public or all-private is not a profile");
  });
});
