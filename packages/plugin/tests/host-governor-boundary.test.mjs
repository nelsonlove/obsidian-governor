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
 * Why a test and not a convention: S2 replaces the hook-shaped crossings with the seam (§5) and
 * S3 makes the two subtrees two plugin artifacts. Both steps are only reviewable if the set of
 * crossings is a checked-in number that a diff moves. A new host→governor import that nobody
 * enumerated is exactly the drift that would make S3's split unplannable, so it fails here.
 *
 * The tables are DESCRIPTIVE of today, not aspirational. Every entry is a real edge in the
 * tree as it stands; adding one is a deliberate act with a line in a diff. Shrinking them is
 * the work of S2 and S3 — `EXPECTED_HOST_TO_GOVERNOR` should approach "main.ts registers the
 * provider through the seam, and nothing else", and `EXPECTED_GOVERNOR_TO_HOST` should
 * approach "the provider depends on published contracts only".
 *
 * ── WHAT S2 MOVED, AND WHAT IT DELIBERATELY DID NOT ─────────────────────────────────────────
 *
 * S2 built the seam (`src/mcp/seam.ts`) and consumed it in-tree: 45 host→governor edges became
 * 32, and the ones that went are the ones the seam was for.
 *
 *   • `mcp/tools-core.ts` went from FIVE crossings to ZERO. That file declares `ServerCtx`, the
 *     host's per-connection context, and it named five provider types purely to carry provider
 *     PORTS across — the mandate store's verbs, the proposal store's verbs, the session record.
 *     A host context that describes the provider's data model cannot be a host contract at S3.
 *     Proposal production went behind `registerWriteObserver`; the mandate tools now arrive as
 *     registrars from the composition root (`BuildOpts.providerTools`); the session contract
 *     moved host-side, because the host mints sessions (condition 7).
 *   • `mcp/server.ts` went from NINE to FOUR. The `propose` block — class firewall, proposal
 *     builder, mandate stamping, history recording — is now `governor/wiring/write-observer.ts`
 *     behind the seam, and the session liveness consultation is the seam's refusal hook.
 *
 * ── WHAT S3a DID (the contract-publishing package) ──────────────────────────────────────────
 *
 * S2 left four items here as "not done, deferred to S3". S3a discharged three of them by
 * PUBLISHING what the crossing reached for into `@vault-mcp/core`, which is the sanctioned way
 * an entry leaves these tables — the scan matches relative specifiers only, so a dependency on
 * a published contract is by construction not a boundary crossing:
 *
 *   • `server.ts`'s `canonical-json` + `digest` — DONE. They serve the SESSION SCOPE DIGEST, a
 *     host assertion about a connection, so a host depending on a provider for them was always
 *     backwards. `server.ts` went from FOUR crossings to TWO.
 *   • The triage-dispositions inversion (condition 9) — DONE. The generic descriptor substrate
 *     is in `@vault-mcp/core`; triage's own descriptors stayed host-side because triage was to
 *     become a SATELLITE and a provider must not depend on one. It DID at S5, and the foresight
 *     paid: triage left without this table changing. Note the inversion retired the GOVERNOR→HOST
 *     edge (`governor/kernel/dispositions.ts`). `src/mcp/tools-governance-revision.ts` still
 *     crosses twice in the other direction — that is the file's own placement, not the
 *     inversion, and it retires when the file moves with the provider's tools.
 *   • `SessionV1` (condition 7) — DONE, published rather than borrowed.
 *
 * ── WHAT S3b DID (the observations ruling, executed) ────────────────────────────────────────
 *
 * S3a left `server.ts` with two crossings and called them "ruled but not moved". S3b moved
 * them, and `src/mcp/server.ts` is now ABSENT from the table below — the MCP transport reaches
 * into the provider ZERO times, down from nine at S1:
 *
 *   • the observation blob store moved to `src/kernel/observations/`. It was HOST machinery
 *     misfiled under `governor/` — one consumer (the transport), and it already imported the
 *     host's own observation store and paths, which is what its two GOVERNOR→HOST back-edges
 *     were really evidence of. No capture hook was added: the seam gains no surface for a
 *     registrant that does not exist.
 *   • `territories` was PUBLISHED into `@vault-mcp/core` rather than held as host config as
 *     §5 drafted. Its importers land on both sides of the split, so host-only config cannot
 *     serve the provider's review pane, and the only alternative is two copies of a list whose
 *     drift writes note bodies to disk.
 *
 * What is still open, so the remaining numbers are not mistaken for drift:
 *
 *   • `main.ts` — the composition root, still 19 crossings. This is the "installing the
 *     provider" edge, and it goes when there are two plugin manifests.
 *   • `connection-ui.ts`, `modules-mount.ts` — settings/UI composition, one each.
 *   • `tools-governance-mandate.ts` and `tools-governance-revision.ts` still physically sit in
 *     `src/mcp/`. Their registration no longer runs through `ServerCtx`, which is what
 *     mattered; the files move with the rest of the provider's tools.
 *
 * The other direction went 7 → 10 at S2 → 6 at S3a → 4 at S3b. The S2 growth was intended (the
 * provider depending on things the host is RULED to own); S3a and S3b shrank it by publishing
 * those as contracts, or by moving a misfiled module to the side it belonged on. This list is
 * the "publish as a contract or copy it" work item, so entries arriving here from the other
 * table is the split proceeding, and entries leaving is that work item being discharged.
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
  // The plugin's composition root. `onload` constructs the provider's stores, wires its
  // pane/commands, and — since S2 — REGISTERS the provider on the seam. This is the
  // "installing the provider" edge that S3 replaces with two plugin manifests and a
  // registration call the provider makes for itself.
  "src/main.ts": [
    "src/governor/kernel/history-store/history-scope.js",
    "src/governor/kernel/history-store/refs.js",
    "src/governor/kernel/history-store/repository.js",
    "src/governor/kernel/mandates/budgets.js",
    "src/governor/kernel/mandates/lifecycle.js",
    "src/governor/kernel/proposals/proposal-store.js",
    "src/governor/kernel/sessions/session-store.js",
    "src/governor/kernel/settings.js",
    "src/governor/kernel/transformations/promotion.js",
    "src/governor/kernel/transformations/transformation.js",
    "src/governor/kernel/verification/predicates.js",
    "src/governor/wiring/admission-wiring.js",
    "src/governor/wiring/history-store/git-repository.js",
    "src/governor/wiring/history-store/local-data-root.js",
    "src/governor/wiring/mandate-wiring.js",
    "src/governor/wiring/migration-wiring.js",
    "src/governor/wiring/promotion-wiring.js",
    // `territories` is GONE from this list: S3 published it into `@vault-mcp/core`, so the
    // composition root reads the guarded prefixes from the contract, not from the provider.
    "src/governor/wiring/wiring.js",
    // S2: the proposal producer, registered through `registerWriteObserver`.
    "src/governor/wiring/write-observer.js",
  ],
  // The settings tab renders the provider's own settings section. UI composition only — it
  // calls a renderer, it holds no authority.
  "src/connection-ui.ts": ["src/governor/wiring/wiring.js"],
  // `src/mcp/server.ts` IS ABSENT, and that is the entry. The MCP transport crossed the
  // boundary NINE times at S1. S2 retired five (the producer-stamping block became a seam
  // observer; the session contract moved host-side). S3 retired the last four:
  //
  //   • `canonical-json` + `digest` — published in `@vault-mcp/core` (condition 9). The host
  //     consults them for its OWN session scope digest, and a host cannot depend on a provider
  //     for an assertion about its own connection.
  //   • `observations/local-store` — the blob store was HOST machinery misfiled under
  //     `governor/`. It had one consumer (this file) and already imported the host's own
  //     observation store and paths, so it moved to `src/kernel/observations/`. No capture
  //     hook was added: the seam gains no surface for a registrant that does not exist.
  //   • `territories` — published as a CONTRACT rather than held as host config, because its
  //     importers land on both sides of the split and two copies is the failure its own header
  //     names (a prefix missing from capture's list means capture writes note bodies to disk).
  //
  // The transport is the host's, and it now reaches into the provider zero times. Do not
  // re-add an entry here without the design conversation that earns it.
  // The module registry reads the governance module's settings shape to render its config
  // section. Settings projection only — the registry mounts read-only-or-nothing.
  "src/mcp/modules-mount.ts": ["src/governor/kernel/settings.js"],
  // The two governance MCP tool files. §6 assigns these to the provider, published through
  // `vault-mcp-api`; they sit in `src/mcp/` today because that is where the tool tables live.
  // S2 cut the mandate tools' dependency on `ServerCtx` (they register through
  // `BuildOpts.providerTools`, closed over the provider's own store) but left the FILES where
  // they are — moving them is part of S3's tool-publishing package, not the seam's proof.
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
 * ZERO is the number for `src/mcp/tools-core.ts`, and it is S2's exit criterion, so it gets its
 * own name rather than being an absence someone has to notice. `ServerCtx` is the host's
 * per-connection context — the thing S3 keeps — and until S2 it named five provider types.
 */
const SERVER_CTX = "src/mcp/tools-core.ts";

/**
 * The other direction, pinned for the same reason: these are the host modules the provider
 * still depends on. S3 must either publish each as a contract or copy it into the provider,
 * so the list is the S3 work item made countable.
 */
const EXPECTED_GOVERNOR_TO_HOST = {
  "src/governor/kernel/contracts/change-class.ts": ["src/kernel/operations/action.js"],
  // S3 (condition 9) retired FOUR entries from this table by publishing what they reached for
  // into `@vault-mcp/core`, which is the "publish it or copy it" work item this list exists to
  // make countable:
  //
  //   • `contracts/ids.ts` → uuidv7 and `gesture.ts` → uuidv7. The provider mints ids too, so
  //     the mint is shared surface; forking it would give one vault two id formats. The host's
  //     `kernel/uuidv7.ts` is GONE rather than left as a re-export — a shim that only the
  //     composition root uses is a crossing waiting to be re-added by the next author.
  //   • `dispositions.ts` → the former `kernel/triage/dispositions.js`. Only the GENERIC descriptor
  //     substrate moved; triage's own descriptors stayed host-side because triage was to become
  //     a SATELLITE, and a provider that depends on a satellite is the layering inversion this
  //     entry was recording. Triage became one at S5 and took its descriptors with it, so
  //     neither the crossing nor the file it named exists any more.
  //   • `sessions/session-store.ts` → `kernel/sessions/session.js`. Condition 7 ruled the host
  //     mints, which makes `SessionV1` a published contract rather than a host internal the
  //     provider borrows. `openSession` stays host-side ON THE RULING, not on a dependency.
  "src/governor/wiring/history-store/local-data-root.ts": ["src/paths.js"],
  // `wiring/observations/local-store.ts` is GONE from this table because the FILE left the
  // governor tree entirely (S3): its two back-edges here — the host's observation store and
  // the host's paths — were the evidence that it was host machinery filed on the wrong side,
  // not a provider module with an awkward dependency. It now lives at
  // `src/kernel/observations/local-store.ts`, where those imports are ordinary neighbours.
  // S2: the proposal producer, behind the seam. It depends on exactly two host things — the
  // native write action whose writes it speaks for, and the seam's own `WriteFacts` type. Both
  // are host contracts by design (§6 assigns the action registry to the host, and the seam IS
  // the host's published hook API), so this is the provider depending on published surface
  // rather than on host internals.
  "src/governor/wiring/write-observer.ts": [
    "src/kernel/operations/actions/note-write.js",
    "src/mcp/seam.js",
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

  test("S2's exit criterion: ServerCtx names ZERO governance-provider types", () => {
    // The host's per-connection context is the thing S3 keeps. Until S2 it named five provider
    // types — three for the mandate store's verbs, one for the proposal store's, one for the
    // session record — purely to carry provider PORTS into the transport. A context that
    // describes the provider's data model is not a host contract, and no amount of hook API
    // fixes that; the ports had to go, not merely be routed differently.
    const { hostToGovernor } = scanBoundary(readSrc());
    assert.deepEqual(
      [...(hostToGovernor.get(SERVER_CTX) ?? [])].sort(),
      [],
      `${SERVER_CTX} declares ServerCtx and must name NO governor type. A port on the host's ` +
        `context is how the provider's data model leaks back into the host — put the provider's ` +
        `state behind the seam (mcp/seam.ts), or hand it in as a registrar from main.ts.`
    );
  });

  test("the seam is small enough to reason about — a countable, shrinking number", () => {
    const { hostToGovernor, governorToHost } = scanBoundary(readSrc());
    const host = asLines(hostToGovernor).length;
    const crossings = host + asLines(governorToHost).length;
    // Two bounds, because the two directions are meant to move differently.
    //
    // host→governor must approach ZERO: every one of these is the host reaching into provider
    // internals, and at S3 there is no such reach to make. S1 enumerated 45; S2 left 32; S3a
    // left 30; S3b leaves 27.
    //
    // The bound is set to the CURRENT number, not a round number above it. A ratchet with slack
    // is a ratchet that lets the next few regressions through silently, which is the opposite of
    // what it is for — it sat at 35 against an actual 32 through all of S2 and would not have
    // caught three new crossings. Tighten it in the same commit that lowers the count.
    assert.ok(
      host <= 27,
      `${host} host→governor imports — this direction only shrinks; route it through the seam`
    );
    // The total is the coarse ratchet. It rises slightly slower than host→governor falls,
    // because a contract moving host-side turns one host→governor edge into one or more
    // governor→host ones — the provider depending on published host contracts is the TARGET
    // state for that list, so the total is a guard against sprawl, not a target in itself.
    assert.ok(
      crossings <= 31,
      `${crossings} boundary crossings — the split is meant to shrink this, not grow it`
    );
  });
});
