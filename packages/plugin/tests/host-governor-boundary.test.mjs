/**
 * host-governor-boundary.test.mjs — THE STRUCTURAL BOUNDARY (suite split, S1).
 *
 * The suite-split design (docs/suite-split-design.md §2) names three roles: the host (an
 * audited MCP server over the vault), the governance provider (everything that decides
 * authority), and the satellites. S1 makes the first two boundaries STRUCTURAL rather than
 * conceptual: the governance provider's future sources now live in exactly one subtree,
 * `src/governor/`, split into `src/governor/kernel/` (the pure logic, formerly
 * `src/kernel/governance/`) and `src/governor/wiring/` (the Obsidian-facing layer — pane,
 * wiring, stores — formerly `src/governance/`). Nothing else moved and nothing runs
 * differently; one plugin artifact still builds from one `src/`.
 *
 * THE INVARIANT this file pins:
 *
 *   Exactly one subtree — `src/governor/` — contains the governance provider's sources, and
 *   the host never imports governor internals except through the explicitly enumerated seam
 *   list below.
 *
 * Why a test and not a convention: S2 replaces these crossings with the hook API (§5) and S3
 * makes the two subtrees two plugin artifacts. Both steps are only reviewable if the set of
 * crossings is a checked-in number that a diff moves. A new host→governor import that nobody
 * enumerated is exactly the drift that would make S3's split unplannable, so it fails here.
 *
 * The tables are DESCRIPTIVE of today, not aspirational. Every entry is a real edge in the
 * tree as it stands; adding one is a deliberate act with a line in a diff. Shrinking them is
 * the work of S2 and S3 — `EXPECTED_HOST_TO_GOVERNOR` should approach "main.ts registers the
 * provider through the seam, and nothing else", and `EXPECTED_GOVERNOR_TO_HOST` should
 * approach "the provider depends on published contracts only".
 *
 * Instrument discipline: the scan is a pure function over a { path -> source } map, and it is
 * exercised against a synthetic tree with a planted violation BEFORE it is trusted against the
 * real one. A source scan that silently matches nothing is worse than no scan.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG, "src");

/** The one governance subtree. Everything else under `src/` is host. */
const GOVERNOR_ROOT = "src/governor/";

/**
 * THE SEAM LIST — every host module that reaches into `src/governor/`, and exactly what it
 * reaches for. Grouped by host file, with why each group exists today.
 */
const EXPECTED_HOST_TO_GOVERNOR = {
  // The plugin's composition root. `onload` constructs the provider's stores and wires its
  // pane/commands — this is the "installing the provider" edge that S3 replaces with two
  // plugin manifests and the seam's registration call.
  "src/main.ts": [
    "src/governor/kernel/history-store/history-scope.js",
    "src/governor/kernel/history-store/refs.js",
    "src/governor/kernel/history-store/repository.js",
    "src/governor/kernel/mandates/budgets.js",
    "src/governor/kernel/mandates/draft.js",
    "src/governor/kernel/mandates/lifecycle.js",
    "src/governor/kernel/proposals/proposal-store.js",
    "src/governor/kernel/proposals/proposal.js",
    "src/governor/kernel/sessions/session-store.js",
    "src/governor/kernel/sessions/session.js",
    "src/governor/kernel/settings.js",
    "src/governor/kernel/transformations/promotion.js",
    "src/governor/kernel/transformations/transformation.js",
    "src/governor/kernel/verification/predicates.js",
    "src/governor/wiring/admission-wiring.js",
    "src/governor/wiring/history-store/git-repository.js",
    "src/governor/wiring/history-store/local-data-root.js",
    "src/governor/wiring/mandate-wiring.js",
    "src/governor/wiring/migration-wiring.js",
    "src/governor/wiring/mount-state.js",
    "src/governor/wiring/promotion-wiring.js",
    "src/governor/wiring/territories.js",
    "src/governor/wiring/wiring.js",
  ],
  // The settings tab renders the provider's own settings section. UI composition only — it
  // calls a renderer, it holds no authority.
  "src/connection-ui.ts": ["src/governor/wiring/wiring.js"],
  // The MCP transport. This is the producer-stamping edge the design calls out (§5): a write
  // completes, the server builds proposal subjects and stamps mandate production, and records
  // observations. S2 turns this into `registerWriteObserver` and the veto registration.
  "src/mcp/server.ts": [
    "src/governor/kernel/contracts/canonical-json.js",
    "src/governor/kernel/contracts/digest.js",
    "src/governor/kernel/mandates/policy.js",
    "src/governor/kernel/proposals/class-firewall.js",
    "src/governor/kernel/proposals/proposal-builder.js",
    "src/governor/kernel/proposals/proposal.js",
    "src/governor/kernel/sessions/session.js",
    "src/governor/wiring/observations/local-store.js",
    "src/governor/wiring/territories.js",
  ],
  // The guarded core tools consult session liveness and mandate budgets on the write path —
  // §5's `registerSessionGate` is the hook this becomes.
  "src/mcp/tools-core.ts": [
    "src/governor/kernel/mandates/budgets.js",
    "src/governor/kernel/mandates/draft.js",
    "src/governor/kernel/mandates/mandate.js",
    "src/governor/kernel/proposals/proposal.js",
    "src/governor/kernel/sessions/session.js",
  ],
  // The module registry reads the governance module's settings shape to render its config
  // section. Settings projection only — the registry mounts read-only-or-nothing.
  "src/mcp/modules-mount.ts": ["src/governor/kernel/settings.js"],
  // The two governance MCP tool files. §6 assigns these to the provider, published through
  // `vault-mcp-api`; they sit in `src/mcp/` today because that is where the tool tables live.
  "src/mcp/tools-governance-mandate.ts": [
    "src/governor/kernel/contracts/change-class.js",
    "src/governor/kernel/mandates/budgets.js",
    "src/governor/kernel/mandates/draft.js",
    "src/governor/kernel/mandates/mandate.js",
  ],
  "src/mcp/tools-governance-revision.ts": [
    "src/governor/kernel/dispositions.js",
    "src/governor/kernel/revision.js",
  ],
};

/**
 * The other direction, pinned for the same reason: these are the host modules the provider
 * still depends on. S3 must either publish each as a contract or copy it into the provider,
 * so the list is the S3 work item made countable.
 */
const EXPECTED_GOVERNOR_TO_HOST = {
  "src/governor/kernel/contracts/change-class.ts": ["src/kernel/operations/action.js"],
  "src/governor/kernel/contracts/ids.ts": ["src/kernel/uuidv7.js"],
  "src/governor/kernel/dispositions.ts": ["src/kernel/triage/dispositions.js"],
  "src/governor/kernel/gesture.ts": ["src/kernel/uuidv7.js"],
  "src/governor/wiring/history-store/local-data-root.ts": ["src/paths.js"],
  "src/governor/wiring/observations/local-store.ts": [
    "src/kernel/observations/store.js",
    "src/paths.js",
  ],
};

// ── the instrument ───────────────────────────────────────────────────────────

/** Static and dynamic import/export specifiers, including `import("…")` in type position. */
const SPECIFIER = /(?:\bfrom|\bimport|\bexport)\s*\(?\s*["'](\.[^"']*)["']/g;

const isGovernor = (p) => p.startsWith(GOVERNOR_ROOT);

/**
 * Scan a { path -> source } map and return every relative import edge that crosses the
 * host/governor line, in both directions. Paths are POSIX, relative to the package root.
 */
export function scanBoundary(files) {
  const hostToGovernor = new Map();
  const governorToHost = new Map();
  for (const [path, source] of files) {
    const dir = posix.dirname(path);
    for (const m of source.matchAll(SPECIFIER)) {
      const target = posix.normalize(posix.join(dir, m[1]));
      const from = isGovernor(path);
      const to = isGovernor(target);
      if (from === to) continue;
      const bucket = to ? hostToGovernor : governorToHost;
      if (!bucket.has(path)) bucket.set(path, new Set());
      bucket.get(path).add(target);
    }
  }
  return { hostToGovernor, governorToHost };
}

function readSrc() {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts")) {
        files.set(relative(PKG, abs).split("\\").join("/"), readFileSync(abs, "utf8"));
      }
    }
  };
  walk(SRC);
  return files;
}

/** A Map<string, Set<string>> flattened to sorted "a -> b" lines, for readable diffs. */
const asLines = (m) =>
  [...m]
    .flatMap(([from, tos]) => [...tos].map((to) => `${from} -> ${to}`))
    .sort();

const expectedLines = (table) =>
  Object.entries(table)
    .flatMap(([from, tos]) => tos.map((to) => `${from} -> ${to}`))
    .sort();

// ── the instrument, verified before it is trusted ────────────────────────────

describe("boundary scan: the instrument itself", () => {
  test("it FINDS a planted host→governor import (a scan that matches nothing proves nothing)", () => {
    const files = new Map([
      ["src/main.ts", 'import { wire } from "./governor/wiring/wiring.js";\n'],
      ["src/governor/wiring/wiring.js", "export const wire = 1;\n"],
    ]);
    const { hostToGovernor } = scanBoundary(files);
    assert.deepEqual(asLines(hostToGovernor), ["src/main.ts -> src/governor/wiring/wiring.js"]);
  });

  test("it FINDS a planted governor→host import", () => {
    const files = new Map([
      ["src/governor/kernel/x.ts", 'import { p } from "../../paths.js";\n'],
    ]);
    const { governorToHost } = scanBoundary(files);
    assert.deepEqual(asLines(governorToHost), ["src/governor/kernel/x.ts -> src/paths.js"]);
  });

  test("it sees `import(…)` in type position, not only top-level import statements", () => {
    const files = new Map([
      ["src/mcp/x.ts", 'type T = import("../governor/kernel/revision.js").Revision;\n'],
    ]);
    assert.deepEqual(asLines(scanBoundary(files).hostToGovernor), [
      "src/mcp/x.ts -> src/governor/kernel/revision.js",
    ]);
  });

  test("it ignores edges that do NOT cross (host→host, governor→governor)", () => {
    const files = new Map([
      ["src/mcp/a.ts", 'import "./b.js";\n'],
      ["src/governor/wiring/pane.ts", 'import "../kernel/accept.js";\n'],
    ]);
    const { hostToGovernor, governorToHost } = scanBoundary(files);
    assert.deepEqual(asLines(hostToGovernor), []);
    assert.deepEqual(asLines(governorToHost), []);
  });

  test("the real tree is non-trivial — the scan reads actual sources", () => {
    const files = readSrc();
    assert.ok(files.size > 200, `only ${files.size} source files found; the walker is broken`);
    assert.ok(
      [...files.keys()].some((p) => p.startsWith(GOVERNOR_ROOT)),
      "no file under src/governor/ — the boundary subtree is missing"
    );
  });
});

// ── the invariant ────────────────────────────────────────────────────────────

describe("THE BOUNDARY — one governance subtree, an enumerated seam", () => {
  test("the governance provider's sources live under src/governor/ and nowhere else", () => {
    const files = [...readSrc().keys()];
    // The pre-S1 roots are gone: no file may sit at the old addresses.
    for (const dead of ["src/governance/", "src/kernel/governance/"]) {
      const strays = files.filter((f) => f.startsWith(dead));
      assert.deepEqual(strays, [], `${dead} still holds sources — the S1 move is incomplete`);
    }
    // And the subtree is the two halves the design names, nothing else.
    const halves = new Set(
      files
        .filter((f) => f.startsWith(GOVERNOR_ROOT))
        .map((f) => f.slice(GOVERNOR_ROOT.length).split("/")[0])
    );
    assert.deepEqual([...halves].sort(), ["kernel", "wiring"]);
  });

  test("the host imports governor internals ONLY at the enumerated seam", () => {
    const { hostToGovernor } = scanBoundary(readSrc());
    assert.deepEqual(
      asLines(hostToGovernor),
      expectedLines(EXPECTED_HOST_TO_GOVERNOR),
      "the host↔governor seam changed. Every crossing is a thing S2/S3 must replace with a " +
        "hook registration — add it to EXPECTED_HOST_TO_GOVERNOR deliberately, or route it " +
        "through the seam instead."
    );
  });

  test("no host file outside the seam list touches src/governor/ at all", () => {
    const { hostToGovernor } = scanBoundary(readSrc());
    const listed = new Set(Object.keys(EXPECTED_HOST_TO_GOVERNOR));
    const unlisted = [...hostToGovernor.keys()].filter((f) => !listed.has(f)).sort();
    assert.deepEqual(unlisted, [], "unenumerated host modules reach into the governance subtree");
  });

  test("the governor's remaining dependencies on the host are enumerated (the S3 work item)", () => {
    const { governorToHost } = scanBoundary(readSrc());
    assert.deepEqual(
      asLines(governorToHost),
      expectedLines(EXPECTED_GOVERNOR_TO_HOST),
      "the provider's dependency on host modules changed; each one must be published as a " +
        "contract or copied into the provider before S3 can build two artifacts."
    );
  });

  test("the seam is small enough to reason about — a countable, shrinking number", () => {
    const { hostToGovernor, governorToHost } = scanBoundary(readSrc());
    const crossings = asLines(hostToGovernor).length + asLines(governorToHost).length;
    // S1 is a rename: this is the pre-existing coupling made visible, not new coupling.
    // The bound exists so the number can only go DOWN without a deliberate edit here.
    assert.ok(
      crossings <= 60,
      `${crossings} boundary crossings — the split is meant to shrink this, not grow it`
    );
  });
});
