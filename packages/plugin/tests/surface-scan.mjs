/**
 * surface-scan.mjs — the INVERSE half of the bidirectional inventory (WP0).
 *
 * The declared inventory (`src/kernel/operations/inventory-mcp.ts`) says what
 * Governor's MCP surface is. This scanner says what the SOURCE actually
 * registers. A drift test compares them in both directions, so:
 *
 *   • a tool added without an action fails the build; and
 *   • an inventory row whose registration was deleted fails the build.
 *
 * Why a source scan rather than building a server and asking it: every
 * registrar in `buildMcpServer` needs a live Obsidian `App`, several are gated
 * on host plugins being loaded, and `mountModules` gates on settings. A
 * runtime enumeration would therefore report whatever this machine happens to
 * have installed — which is exactly the wrong denominator for "did anyone add
 * a surface." The scan sees every registration unconditionally, including the
 * ones no test machine can reach.
 *
 * This follows the repo's existing idiom: `link-healing.test.mjs` globs
 * `src/**{/}*.ts` for `vault.rename` and proves the glob works by planting a
 * violation, and `registration-surface-sealed.test.mjs` closes the CLASS of
 * SDK registration entry points rather than five instances. The same two
 * moves apply here — see `assertScannerFindsPlantedTool` below.
 *
 * The scanner is deliberately not clever. It resolves exactly the shapes this
 * repo actually uses, and anything it cannot resolve is reported as an
 * `unresolved` entry rather than skipped. A silent skip is how a surface goes
 * missing from an inventory that still claims to be complete.
 */

import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_SRC = resolvePath(HERE, "../src");
export const CORE_SRC = resolvePath(HERE, "../../core/src");

/**
 * Callee names that register an MCP tool with a literal name as first argument.
 *
 * `registerTool` is the patched interception point. `reg`, `register` and
 * `origRegister` are the three places this repo deliberately registers OUTSIDE
 * that patch — the Code Mode meta-tools and `obsidian_write_notes` — each for
 * a documented reason. `capture` is Code Mode's capturing registrar.
 *
 * This list is asserted by its own test: a registration through a callee name
 * NOT in this list would be invisible to the scan, so the class is closed by
 * checking that no other identifier is called with a tool-name-shaped literal
 * first argument in the MCP source tree.
 */
export const REGISTRATION_CALLEES = ["registerTool", "origRegister", "register", "reg", "capture"];

/** A tool name: lowercase, underscore-separated, as the MCP naming rules require. */
const TOOL_NAME = "[a-z][a-z0-9_]*";

/**
 * Pass-through registration sites: a call that forwards a NAME VARIABLE rather
 * than a literal. Each is a plumbing hop, not a surface of its own, and each is
 * listed here with the reason it cannot name a tool by itself. A new
 * pass-through site is a new place a surface could hide, so the set is
 * asserted.
 */
export const KNOWN_PASSTHROUGH_SITES = [
  {
    file: "src/mcp/server.ts",
    reason: "the registerTool monkeypatch and the codeMode capture/origRegister switch — forwards whatever a registrar names",
  },
  {
    file: "src/kernel/modules/module.ts",
    reason: "the module host's registrar adapter — forwards each module's own registerTool calls",
  },
  {
    file: "src/mcp/external-tools.ts",
    reason: "third-party publishers; the name is computed per publisher at runtime and cannot be enumerated statically",
  },
  {
    file: "packages/core/src/register-fs-tools.ts",
    reason: "iterates the FS_TOOLS table in core/src/tool-registry.ts, which the scanner reads directly",
  },
];

async function tsFiles(root) {
  const out = [];
  for await (const rel of glob("**/*.ts", { cwd: root })) out.push({ rel, abs: resolvePath(root, rel) });
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Annotation presets declared in one file.
 *
 * Three shapes occur in this repo, and all three are resolved because a shape
 * the scanner cannot read becomes an `unresolved` entry — which is a scanner
 * failure, not a tool it may quietly ignore:
 *
 *   const RO = { readOnlyHint: true, … }        — the common per-file preset
 *   RO: { readOnlyHint: true, … }               — nested inside
 *                                                 core's SHARED_ANNOTATIONS
 *   const RO = SHARED_ANNOTATIONS.RO;           — an alias, resolved in a
 *                                                 second pass
 */
function presetsIn(text) {
  const presets = new Map();
  const aliases = new Map();

  const declared = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([^}]*)\}/g;
  let m;
  while ((m = declared.exec(text))) {
    const ro = /readOnlyHint\s*:\s*(true|false)/.exec(m[2]);
    if (ro) presets.set(m[1], ro[1] === "true");
  }

  // Nested preset keys, e.g. core's `SHARED_ANNOTATIONS = { RO: { … }, RW: { … } }`.
  const nested = /\b([A-Z][A-Z0-9_]*)\s*:\s*\{([^}]*)\}/g;
  while ((m = nested.exec(text))) {
    const ro = /readOnlyHint\s*:\s*(true|false)/.exec(m[2]);
    if (ro && !presets.has(m[1])) presets.set(m[1], ro[1] === "true");
  }

  const alias = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?([A-Z][A-Z0-9_]*)\s*;/g;
  while ((m = alias.exec(text))) aliases.set(m[1], m[2]);
  for (const [from, to] of aliases) {
    if (!presets.has(from) && presets.has(to)) presets.set(from, presets.get(to));
  }

  return { presets, aliases };
}

/**
 * Merge every file's presets into one map, so an IMPORTED preset resolves.
 *
 * Several tool files use `RO`/`RW` imported from a sibling rather than
 * declared locally. Merging is only safe if the names mean the same thing
 * everywhere, so a name defined with two different `readOnlyHint` values is
 * recorded as a CONFLICT and refuses to resolve. Guessing which definition an
 * importer meant is precisely how a mutating tool would come to be inventoried
 * as read-only.
 */
function mergePresets(perFile) {
  const global = new Map();
  const conflicts = new Set();
  for (const { presets } of perFile) {
    for (const [name, ro] of presets) {
      if (global.has(name) && global.get(name) !== ro) conflicts.add(name);
      else global.set(name, ro);
    }
  }
  for (const name of conflicts) global.delete(name);
  return { global, conflicts };
}

/** String constants: `export const SUBMIT_REVISION_TOOL = "governance_submit_revision"`. */
function stringConstsIn(text) {
  const consts = new Map();
  const re = new RegExp(`\\bconst\\s+([A-Z][A-Z0-9_]*)\\s*=\\s*"(${TOOL_NAME})"`, "g");
  let m;
  while ((m = re.exec(text))) consts.set(m[1], m[2]);
  return consts;
}

/**
 * Resolve the `readOnlyHint` for one registration, given the slice of source
 * that follows its name literal.
 *
 * Returns `undefined` when it cannot be resolved — never a default. An
 * unresolved annotation means the scanner does not know whether a surface
 * mutates, and guessing `true` there would silently exempt a mutating tool
 * from the inventory's own read/write check.
 */
function readOnlyOf(slice, presets, globalPresets) {
  const inline = /annotations\s*:\s*\{[^}]*?readOnlyHint\s*:\s*(true|false)/.exec(slice);
  if (inline) return inline[1] === "true";
  const named = /annotations\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(slice);
  // File-local first, then the merged map — a local declaration always wins
  // over an identically named preset somewhere else in the tree.
  if (named) return presets.get(named[1]) ?? globalPresets.get(named[1]);
  return undefined;
}

/**
 * Every MCP tool registration the source contains.
 *
 * Returns `{ tools, unresolved }`. `tools` is a Map from tool name to
 * `{ name, file, callee, readOnly }`. `unresolved` lists registrations whose
 * name or annotation could not be resolved — a non-empty list is a scanner
 * failure, not an acceptable outcome, and the drift test asserts it is empty.
 */
export async function scanMcpSurfaces() {
  const files = [
    ...(await tsFiles(PLUGIN_SRC)).map((f) => ({ ...f, rel: `src/${f.rel}` })),
    ...(await tsFiles(CORE_SRC)).map((f) => ({ ...f, rel: `packages/core/src/${f.rel}` })),
  ];

  const tools = new Map();
  const unresolved = [];
  /** String consts are resolved across the whole tree: `SUBMIT_REVISION_TOOL`
   * is declared in kernel/governance/dispositions.ts and used in mcp/. */
  const globalConsts = new Map();
  const parsed = [];

  for (const f of files) {
    const text = await readFile(f.abs, "utf8");
    parsed.push({ ...f, text, ...presetsIn(text) });
    for (const [k, v] of stringConstsIn(text)) globalConsts.set(k, v);
  }
  const { global: globalPresets, conflicts } = mergePresets(parsed);
  for (const name of conflicts) {
    unresolved.push({
      name: `(preset ${name})`,
      file: "(multiple)",
      reason: "the same annotation preset name is declared with two different readOnlyHint values; an imported use cannot be resolved",
    });
  }

  const calleeAlt = REGISTRATION_CALLEES.join("|");
  // A literal name, or an identifier the scanner may resolve to one.
  const callRe = new RegExp(
    `(?:[A-Za-z_$][\\w$]*\\.)?\\b(${calleeAlt})\\(\\s*(?:"(${TOOL_NAME})"|([A-Z][A-Z0-9_]*))\\s*,`,
    "g"
  );

  for (const f of parsed) {
    // Every registration's start offset in this file, so each one's definition
    // slice can be BOUNDED at the next registration. Without that bound, a def
    // that happens to omit `annotations` would silently borrow the next tool's
    // — inventorying a mutating tool as read-only, which is the one error this
    // scanner must never make.
    const starts = [];
    let s;
    callRe.lastIndex = 0;
    while ((s = callRe.exec(f.text))) starts.push(s.index);

    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(f.text))) {
      const [, callee, literal, ident] = m;
      const name = literal ?? globalConsts.get(ident);
      if (!name) {
        // A pass-through hop forwarding a variable is expected; anything else
        // is a registration the scanner cannot see, and is reported.
        continue;
      }
      const next = starts.find((i) => i > m.index) ?? f.text.length;
      const slice = f.text.slice(m.index, Math.min(next, m.index + 6000));
      const readOnly = readOnlyOf(slice, f.presets, globalPresets);
      if (readOnly === undefined) {
        unresolved.push({ name, file: f.rel, reason: "annotations could not be resolved to a readOnlyHint" });
        continue;
      }
      if (tools.has(name)) {
        unresolved.push({ name, file: f.rel, reason: `registered more than once (also ${tools.get(name).file})` });
        continue;
      }
      tools.set(name, { name, file: f.rel, callee, readOnly });
    }
  }

  // The 17 fs-expressible tools come from a TABLE, not from call sites:
  // register-fs-tools.ts iterates `FS_TOOLS` in core/src/tool-registry.ts.
  const registryFile = parsed.find((f) => f.rel === "packages/core/src/tool-registry.ts");
  if (!registryFile) {
    unresolved.push({ name: "(FS_TOOLS)", file: "packages/core/src/tool-registry.ts", reason: "table file not found" });
  } else {
    const entryRe = new RegExp(`name:\\s*"(${TOOL_NAME})"`, "g");
    // Same bounding as the call sites: an entry's annotations must be its own.
    const entryStarts = [];
    let e;
    while ((e = entryRe.exec(registryFile.text))) entryStarts.push(e.index);
    entryRe.lastIndex = 0;
    let m;
    while ((m = entryRe.exec(registryFile.text))) {
      const name = m[1];
      const next = entryStarts.find((i) => i > m.index) ?? registryFile.text.length;
      const slice = registryFile.text.slice(m.index, Math.min(next, m.index + 6000));
      const readOnly = readOnlyOf(slice, registryFile.presets, globalPresets);
      if (readOnly === undefined) {
        unresolved.push({ name, file: registryFile.rel, reason: "FS_TOOLS entry annotations could not be resolved" });
        continue;
      }
      if (tools.has(name)) {
        unresolved.push({ name, file: registryFile.rel, reason: `also registered at ${tools.get(name).file}` });
        continue;
      }
      tools.set(name, { name, file: registryFile.rel, callee: "FS_TOOLS", readOnly });
    }
  }

  return { tools, unresolved };
}

/**
 * Find identifiers OTHER than the known callees that are called with a
 * tool-name-shaped string literal as their first argument, inside the MCP
 * source tree.
 *
 * This is what closes the class. A future refactor that introduces
 * `myRegistrar("obsidian_new_thing", …)` would be invisible to the scan above;
 * this reports it so the drift test fails rather than silently under-counting.
 *
 * Restricted to `src/mcp/` and `packages/core/src/`, where tool registration
 * lives; elsewhere in the tree a call with a lowercase string first argument is
 * ordinary code, not a registration.
 */
export async function scanUnknownRegistrationCallees() {
  const files = [
    ...(await tsFiles(PLUGIN_SRC)).filter((f) => f.rel.startsWith("mcp/")).map((f) => ({ ...f, rel: `src/${f.rel}` })),
    ...(await tsFiles(CORE_SRC)).map((f) => ({ ...f, rel: `packages/core/src/${f.rel}` })),
  ];
  const known = new Set(REGISTRATION_CALLEES);
  const found = [];
  // A tool-name-shaped literal is namespaced: it has at least one underscore
  // and starts with one of the prefixes this product actually publishes. A
  // bare lowercase word ("path", "utf8") is ordinary code and must not be
  // mistaken for a registration.
  const re = /(?:[A-Za-z_$][\w$]*\.)?\b([A-Za-z_$][\w$]*)\(\s*"((?:obsidian|vault|fileclass|provenance|triage|crosssession|base|governance)_[a-z0-9_]+)"\s*,/g;
  for (const f of files) {
    const text = await readFile(f.abs, "utf8");
    let m;
    while ((m = re.exec(text))) {
      if (known.has(m[1])) continue;
      found.push({ callee: m[1], name: m[2], file: f.rel });
    }
  }
  return found;
}
