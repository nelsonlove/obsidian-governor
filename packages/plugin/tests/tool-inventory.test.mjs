/**
 * tool-inventory.test.mjs
 *
 * Locks the fs-expressible tool set defined in @vault-mcp/core.
 *
 * Intent: after Phase 1, the 17 fs-expressible tools live exclusively in
 * FS_TOOLS inside @vault-mcp/core.  The plugin must not define its own
 * copies.  This file encodes that contract so any future drift causes an
 * immediate test failure.
 *
 * Two invariants:
 *   1. FS_TOOLS contains exactly these 17 names, byte-for-byte.
 *   2. server.ts delegates to registerFsTools from @vault-mcp/core and
 *      does not define any of the 17 names inline as string literals.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FS_TOOLS } from "@vault-mcp/core";

// ── Locked expected set ───────────────────────────────────────────────────────
// This is the source of truth.  Changes here require deliberate review.
// Names are sorted alphabetically — the order in FS_TOOLS is irrelevant.
const EXPECTED_FS_TOOL_NAMES = [
  "obsidian_append_note",
  "obsidian_delete_note",
  "obsidian_find_by_tag",
  "obsidian_force_reindex",
  "obsidian_get_backlinks",
  "obsidian_get_outlinks",
  "obsidian_list_folders",
  "obsidian_list_notes",
  "obsidian_manage_frontmatter",
  "obsidian_move_note",
  "obsidian_patch_note",
  "obsidian_read_note",
  "obsidian_read_notes",
  "obsidian_resolve",
  "obsidian_search_by_frontmatter",
  "obsidian_search_notes",
  "obsidian_write_note",
];

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fs-expressible tool inventory (#25)", () => {

  test("FS_TOOLS contains exactly 17 tools", () => {
    assert.equal(
      FS_TOOLS.length,
      17,
      `expected 17 fs-expressible tools in FS_TOOLS, got ${FS_TOOLS.length}`,
    );
  });

  test("FS_TOOLS names match the locked expected set, byte-identical", () => {
    const actual = FS_TOOLS.map((t) => t.name).sort();
    const expected = [...EXPECTED_FS_TOOL_NAMES].sort();
    assert.deepEqual(
      actual,
      expected,
      "FS_TOOLS names deviate from the locked expected set — update EXPECTED_FS_TOOL_NAMES if intentional",
    );
  });

  test("all FS_TOOLS entries carry capability='fs-expressible'", () => {
    for (const tool of FS_TOOLS) {
      assert.equal(
        tool.capability,
        "fs-expressible",
        `tool '${tool.name}' has unexpected capability '${tool.capability}'`,
      );
    }
  });

  test("server.ts imports registerFsTools from @vault-mcp/core", async () => {
    const serverPath = resolve(HERE, "../src/mcp/server.ts");
    const source = await readFile(serverPath, "utf-8");

    assert.ok(
      source.includes("registerFsTools") && source.includes("@vault-mcp/core"),
      "server.ts must import registerFsTools from @vault-mcp/core",
    );

    assert.ok(
      /registerFsTools\s*\(server/.test(source),
      "server.ts must call registerFsTools(server, ...) to register fs-expressible tools",
    );
  });

  test("server.ts does not define any fs-expressible tool inline (no-drift guard)", async () => {
    const serverPath = resolve(HERE, "../src/mcp/server.ts");
    const source = await readFile(serverPath, "utf-8");

    for (const name of EXPECTED_FS_TOOL_NAMES) {
      assert.ok(
        !source.includes(`"${name}"`),
        `server.ts contains inline string "${name}" — fs-expressible tools must not be re-defined outside FS_TOOLS`,
      );
    }
  });

});

// ── scope-provider read-only tools (Task 6) ─────────────────────────────────
// A different flavor of drift guard than the FS_TOOLS invariants above: those
// tools are defined in @vault-mcp/core and merely delegated to; these are
// defined in tools-scheme.ts itself, so the check is source-presence rather
// than an imported constant. Also pins the not-a-tool ruling: an
// obsidian_scheme_audit tool was considered and rejected (the whole-vault
// findings.ts rule pack is rail material for a later task, not a tool) — this
// must never regress silently. obsidian_validate_name is the ONE-NAME
// exposure of the provider's validateName, distinct from that whole-vault
// rule pack, so it does not disturb the not-a-tool ruling.

const EXPECTED_SCHEME_TOOL_NAMES = [
  "obsidian_schemes",
  "obsidian_validate_name",
  "obsidian_resolve_address",
  "obsidian_next_address",
  "obsidian_list_scope",
  "obsidian_expected_location",
];

// ── scope-provider WRITE tools (Task 4) ─────────────────────────────────────
// The three mutating tools (assign/refile/renumber address), registered
// directly in server.ts — NOT through modules-mount.ts, which refuses any
// tool whose readOnlyHint !== true (see tools-scheme-write.ts's header
// comment). Sibling lock to EXPECTED_SCHEME_TOOL_NAMES above, for the write
// side.

const EXPECTED_SCHEME_WRITE_TOOL_NAMES = [
  "obsidian_assign_address",
  "obsidian_refile_address",
  "obsidian_renumber_address",
];

// ── Full-inventory lock (TOOL-INVENTORY.md ↔ source) ────────────────────────
// The two locks above cover 22 of the tools; the other ~44 drifted silently —
// TOOL-INVENTORY.md calls itself "source of record" yet was missing every tool
// added by the scheme/pending-review/write-notes PRs. This lock makes that
// structurally impossible: the set of tool names REGISTERED in source must
// equal the set of backticked obsidian_* names the inventory documents, in
// both directions.
//
// "Registered in source" is a syntactic scan, deliberately matching every
// registration idiom in the codebase — `server.registerTool(`, a `register(`
// callback parameter (tools-write-notes.ts), and a local `reg(` alias
// (tools-code-mode.ts) — always with the tool name as the first argument on
// the same or next line. FS_TOOLS names come from the imported constant, not
// the scan, since core defines them as data. A registration idiom this scan
// does not recognize will surface as a doc-side "extra" the moment the doc
// documents the new tool, so the lock fails loudly rather than rotting.

const REGISTRATION_CALL_RE = /(?:\bregisterTool|\bregister|\breg)\(\s*\n?\s*"(obsidian_[a-z0-9_]+)"/g;

async function registeredToolNames() {
  const srcDir = resolve(HERE, "../src");
  const names = new Set(FS_TOOLS.map((t) => t.name));
  for (const file of await collectSourceFiles(srcDir)) {
    const source = await readFile(file, "utf-8");
    for (const m of source.matchAll(REGISTRATION_CALL_RE)) names.add(m[1]);
  }
  return names;
}

describe("full tool inventory lock (TOOL-INVENTORY.md)", () => {
  test("every registered tool name appears in TOOL-INVENTORY.md, and vice versa", async () => {
    const registered = await registeredToolNames();
    const doc = await readFile(resolve(HERE, "../TOOL-INVENTORY.md"), "utf-8");
    const documented = new Set(
      [...doc.matchAll(/`(obsidian_[a-z0-9_]+)`/g)].map((m) => m[1]),
    );

    const undocumented = [...registered].filter((n) => !documented.has(n)).sort();
    const phantom = [...documented].filter((n) => !registered.has(n)).sort();

    assert.deepEqual(
      undocumented,
      [],
      `tools registered in source but missing from TOOL-INVENTORY.md: ${undocumented.join(", ")}`,
    );
    assert.deepEqual(
      phantom,
      [],
      `tool names in TOOL-INVENTORY.md that no source file registers: ${phantom.join(", ")}`,
    );
  });

  test("scan sanity: the scan finds the tools each existing lock already pins", async () => {
    // Guards the REGEX SCAN itself: if the registration pattern rots, these
    // names vanish and this fails before the set-equality test could pass on
    // two empty sets. Only the non-FS names below actually exercise the scan —
    // the FS names are seeded from the imported FS_TOOLS constant, so they'd
    // survive a broken regex; they're included only so the pin list reads as
    // "every idiom", with scheme (registerTool), write_notes (register),
    // pending_review (registerTool) and call_tool (reg) covering all three.
    const registered = await registeredToolNames();
    for (const name of [...EXPECTED_FS_TOOL_NAMES, ...EXPECTED_SCHEME_TOOL_NAMES, ...EXPECTED_SCHEME_WRITE_TOOL_NAMES,
      "obsidian_write_notes", "obsidian_pending_review", "obsidian_call_tool"]) {
      assert.ok(registered.has(name), `registration scan lost "${name}"`);
    }
  });
});

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("scope-provider read-only tools (#task-6)", () => {
  test("tools-scheme.ts registers all expected scheme tool names, byte-for-byte", async () => {
    const path = resolve(HERE, "../src/mcp/tools-scheme.ts");
    const source = await readFile(path, "utf-8");
    for (const name of EXPECTED_SCHEME_TOOL_NAMES) {
      assert.ok(source.includes(`"${name}"`), `tools-scheme.ts must register "${name}"`);
    }
  });

  test("server.ts reaches the scheme tools through the module-host mount", async () => {
    // The mount step moved scheme (and vocab) registration INSIDE the
    // ModuleRegistry: server.ts calls mountModules, and modules-mount.ts is
    // the one place registerSchemeTools is invoked (pinned exhaustively by
    // the source scan in modules-mount.test.mjs — this pin covers the wiring
    // direction: the mount is actually reached from the built server).
    const serverPath = resolve(HERE, "../src/mcp/server.ts");
    const source = await readFile(serverPath, "utf-8");
    assert.ok(source.includes("mountModules"), "server.ts must call mountModules");
    const mountPath = resolve(HERE, "../src/mcp/modules-mount.ts");
    const mountSource = await readFile(mountPath, "utf-8");
    assert.ok(
      mountSource.includes("registerSchemeTools") && mountSource.includes("tools-scheme"),
      "modules-mount.ts must import and call registerSchemeTools",
    );
  });

  test("no obsidian_scheme_audit tool exists anywhere in src/ (the not-a-tool ruling, pinned)", async () => {
    const srcDir = resolve(HERE, "../src");
    const files = await collectSourceFiles(srcDir);
    for (const file of files) {
      const source = await readFile(file, "utf-8");
      assert.ok(
        !source.includes("obsidian_scheme_audit"),
        `${file} must not reference "obsidian_scheme_audit" — it was never a tool`,
      );
    }
  });
});

// ── scope-provider write tools (#task-4) ────────────────────────────────────

describe("scope-provider write tools (#task-4)", () => {
  test("tools-scheme-write.ts registers all expected write tool names, byte-for-byte", async () => {
    const path = resolve(HERE, "../src/mcp/tools-scheme-write.ts");
    const source = await readFile(path, "utf-8");
    for (const name of EXPECTED_SCHEME_WRITE_TOOL_NAMES) {
      assert.ok(source.includes(`"${name}"`), `tools-scheme-write.ts must register "${name}"`);
    }
  });

  test("server.ts registers the write tools directly (not through the module host)", async () => {
    // Unlike the read-only scheme tools (mounted through modules-mount.ts),
    // these three mutate by design and cannot pass that host's readOnlyHint
    // gate — see tools-scheme-write.ts's header comment — so server.ts wires
    // them directly, the same shape as registerVaultWriteTools.
    const serverPath = resolve(HERE, "../src/mcp/server.ts");
    const source = await readFile(serverPath, "utf-8");
    assert.ok(source.includes("registerSchemeWriteTools"), "server.ts must call registerSchemeWriteTools");
    assert.ok(
      /registerSchemeWriteTools\s*\(\s*server/.test(source),
      "server.ts must call registerSchemeWriteTools(server, ...)"
    );
  });

  test("all three write tools declare readOnlyHint: false", async () => {
    const { installObsidianStub } = await import("./obsidian-stub.mjs");
    installObsidianStub();
    const { registerSchemeWriteTools } = await import("../src/mcp/tools-scheme-write.ts");
    const tools = new Map();
    const server = { registerTool: (name, def, handler) => tools.set(name, { def, handler }) };
    registerSchemeWriteTools(server, {}, { registry: () => ({ instances: () => [], get: () => null, skipped: () => new Map() }), notes: () => [] });
    for (const name of EXPECTED_SCHEME_WRITE_TOOL_NAMES) {
      assert.ok(tools.has(name), `expected "${name}" to be registered`);
      assert.equal(tools.get(name).def.annotations.readOnlyHint, false, `${name} must be mutating`);
    }
  });
});
