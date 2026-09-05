/**
 * health-module.test.mjs — the vault-health satellite: src/kernel/* (the pure
 * tiered-findings scanner, ported from the standalone obsidian-vault-health) and
 * src/tools.ts (the two published tools), all headless.
 *
 * Covered:
 *   • the PURE core reproduces the standalone's tiered classification —
 *     auto-safe (unique-target broken link, guarded by the single-candidate
 *     check), approval-gated (empty note at/under the char threshold; orphan
 *     attachment), report-only (dangling link, duplicate bodies, low-signal tag);
 *   • the empty-char threshold boundary and the single-candidate guard;
 *   • the lint tool's scope post-filter (source-note attribution; tags dropped);
 *   • config coercion / validation of the emptyChars threshold;
 *   • THE PUBLICATION CONTRACT: the wire names `vault_health_scan` /
 *     `vault_health_lint`, the untrusted read-only claim, the fact that NEITHER
 *     tool carries a host path key (which is what makes the host block both under
 *     an allowlist), the coded-error rendering, and the re-applied schema bound;
 *   • the `resolveScope` guard THROUGH the published tool — out-of-allowlist,
 *     absolute, `..`-escaping, whitespace-padded, and the BACKSLASH refusal that
 *     the S7 publication into @vault-mcp/core newly added;
 *   • the config THUNK: a settings change lands on the next call, which is the
 *     registration-time capture bug the extraction fixed;
 *   • the one-shot settings adoption from the host's `modules.health.config`.
 *
 * NOT covered here on purpose:
 *   • the host's kernel, journal, write queue, read-only mode and the F3
 *     pathless-tool block. Those are HOST code with host tests; a second copy
 *     could drift into asserting a posture the host does not enforce. What this
 *     package owns — the argument names the host's guard reads — is pinned in the
 *     publication block instead.
 *   • obsidianHealthBackend, the duck-typed Obsidian adapter reading
 *     app.metadataCache + the vault adapter (un-headless — verify live).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isVisible } from "@vault-mcp/core";
import {
  scanHealth,
  filterFindingsToScope,
  summarize,
  healthConfigOf,
  validateHealthConfig,
  DEFAULT_EMPTY_CHARS,
  DEFAULT_HEALTH_CONFIG,
} from "../src/kernel/index.ts";
import { buildHealthTools } from "../src/tools.ts";
import {
  adoptHostConfig,
  settingsOf,
  ADOPTABLE_KEYS,
  HEALTH_FIELDS,
  DEFAULT_PLUGIN_SETTINGS,
} from "../src/settings.ts";
import { publishInto, OWNER, HOST_PATH_KEYS } from "./host-shim.mjs";

/** The host's `visiblePaths`, reproduced over core's published `isVisible` — the
 *  one-path predicate both sides share. Nothing in this package re-implements
 *  visibility; where a test needs to know what an allowlist hides, it asks the
 *  same function the scope guard asks. */
const visiblePaths = (paths, settings) =>
  !settings?.allowlist?.length ? paths : paths.filter((p) => isVisible(p, settings));

/** An in-memory HealthSource. `bodies` maps a note path → its raw text (with
 * frontmatter); absent ⇒ noteBody returns null. */
function fakeSource({ resolved = {}, unresolved = {}, tags = {}, md = [], files = [], aliases = {}, bodies = {} } = {}) {
  return {
    resolvedLinks: () => resolved,
    unresolvedLinks: () => unresolved,
    tags: () => tags,
    markdownFiles: () => md,
    allFiles: () => files,
    aliases: () => aliases,
    noteBody: async (p) => (Object.prototype.hasOwnProperty.call(bodies, p) ? bodies[p] : null),
  };
}

/**
 * Build the two specs and publish them through the host shim, so every assertion
 * below reads the ENVELOPE an agent actually sees (`ok()` / `fail()`'s
 * `Error [code]: message`) rather than a raw return value.
 *
 * `call` takes the BARE name and prefixes it, so the test bodies stay readable
 * while the wire name is still what is exercised; `publication` below pins the
 * prefix itself.
 */
function build({ source = fakeSource(), config = {}, settings } = {}) {
  const { tools } = publishInto(
    buildHealthTools(source, {
      config: () => config,
      ...(settings ? { getSettings: () => settings } : {}),
    }),
  );
  const call = (bare, args = {}) => tools.get(`${OWNER}_${bare}`).handler(args);
  return { tools, call };
}

const errText = (res) => res.content[0].text;

// ── 1. broken-link tiers (auto-safe vs dangling) ─────────────────────────────

describe("scanHealth: broken-link classification", () => {
  const md = [
    { path: "Notes/Unique.md", size: 100 },
    { path: "Notes/Shared.md", size: 100 },
    { path: "Archive/Shared.md", size: 100 },
    { path: "Notes/Source.md", size: 100 },
  ];

  test("a target that uniquely resolves to one existing note is AUTO-SAFE (repointable)", async () => {
    const f = await scanHealth(fakeSource({ md, unresolved: { "Notes/Source.md": { Unique: 1 } } }), 40);
    assert.equal(f.counts.repointableLinks, 1);
    assert.deepEqual(f.autoSafe.repointableLinks[0], {
      source: "Notes/Source.md",
      target: "Unique",
      resolvesTo: "Notes/Unique.md",
    });
    assert.equal(f.counts.danglingLinks, 0);
  });

  test("an ambiguous target (2+ candidate notes) is NOT auto-safe — dangling `ambiguous`", async () => {
    const f = await scanHealth(fakeSource({ md, unresolved: { "Notes/Source.md": { Shared: 1 } } }), 40);
    assert.equal(f.counts.repointableLinks, 0);
    assert.equal(f.counts.danglingLinks, 1);
    const d = f.reportOnly.danglingLinks[0];
    assert.equal(d.reason, "ambiguous");
    assert.deepEqual(d.candidates, ["Archive/Shared.md", "Notes/Shared.md"]);
  });

  test("a target naming an attachment extension is NEVER repointed — dangling `attachment-ref`", async () => {
    // A note "Unique.md" exists, but the link names Unique.png — an attachment,
    // so the single-candidate guard must not repoint it to the same-stem note.
    const f = await scanHealth(fakeSource({ md, unresolved: { "Notes/Source.md": { "Unique.png": 1 } } }), 40);
    assert.equal(f.counts.repointableLinks, 0);
    assert.equal(f.reportOnly.danglingLinks[0].reason, "attachment-ref");
  });

  test("a #heading/^block sub-reference blocks the repoint — dangling `has-subref`", async () => {
    const f = await scanHealth(fakeSource({ md, unresolved: { "Notes/Source.md": { "Unique#Section": 1 } } }), 40);
    assert.equal(f.counts.repointableLinks, 0);
    assert.equal(f.reportOnly.danglingLinks[0].reason, "has-subref");
  });

  test("a bare heading-only target (no note) is dangling `heading-or-block`", async () => {
    const f = await scanHealth(fakeSource({ md, unresolved: { "Notes/Source.md": { "#Orphaned": 1 } } }), 40);
    assert.equal(f.reportOnly.danglingLinks[0].reason, "heading-or-block");
  });

  test("a target matching no note is dangling `no-match`", async () => {
    const f = await scanHealth(fakeSource({ md, unresolved: { "Notes/Source.md": { Nonexistent: 1 } } }), 40);
    assert.equal(f.reportOnly.danglingLinks[0].reason, "no-match");
    assert.deepEqual(f.reportOnly.danglingLinks[0].candidates, []);
  });

  test("a unique alias match is auto-safe (resolver honors aliases)", async () => {
    const f = await scanHealth(
      fakeSource({
        md,
        aliases: { "Notes/Unique.md": ["Old Name"] },
        unresolved: { "Notes/Source.md": { "Old Name": 1 } },
      }),
      40,
    );
    assert.equal(f.autoSafe.repointableLinks[0].resolvesTo, "Notes/Unique.md");
  });
});

// ── 2. approval-gated tiers (empty notes, orphan attachments) ────────────────

describe("scanHealth: approval-gated tiers + the empty-char boundary", () => {
  test("empty-note threshold is inclusive: body length == threshold is empty, +1 is not", async () => {
    const at = "x".repeat(40);
    const over = "y".repeat(41);
    const f = await scanHealth(
      fakeSource({
        md: [
          { path: "At.md", size: 50 },
          { path: "Over.md", size: 50 },
        ],
        bodies: { "At.md": at, "Over.md": over },
      }),
      40,
    );
    assert.deepEqual(f.approvalGated.emptyNotes.map((e) => e.path), ["At.md"]);
    assert.equal(f.approvalGated.emptyNotes[0].bodyChars, 40);
  });

  test("frontmatter is excluded from the empty-note body count", async () => {
    const body = "---\ntitle: Stub\ntags: [a, b, c]\n---\n\nhi"; // body after frontmatter is just "hi"
    const f = await scanHealth(fakeSource({ md: [{ path: "Stub.md", size: 40 }], bodies: { "Stub.md": body } }), 40);
    assert.equal(f.approvalGated.emptyNotes.length, 1);
    assert.equal(f.approvalGated.emptyNotes[0].bodyChars, 2);
  });

  test("an attachment with zero inbound links is an orphan; a referenced one is not", async () => {
    const files = [
      { path: "assets/orphan.png", ext: "png", size: 9000 },
      { path: "assets/used.png", ext: "png", size: 100 },
      { path: "Note.md", ext: "md", size: 50 }, // md files are never orphan attachments
    ];
    const f = await scanHealth(
      fakeSource({ files, md: [{ path: "Note.md", size: 50 }], resolved: { "Note.md": { "assets/used.png": 1 } } }),
      40,
    );
    assert.deepEqual(f.approvalGated.orphanAttachments.map((a) => a.path), ["assets/orphan.png"]);
    assert.equal(f.approvalGated.orphanAttachments[0].bytes, 9000);
  });
});

// ── 3. report-only tiers (dangling handled above, duplicates, low-signal tags) ─

describe("scanHealth: duplicates + low-signal tags", () => {
  test("two notes with identical (frontmatter-stripped) bodies form a duplicate group", async () => {
    const body = "This is a real body well over the empty threshold, so it counts as a duplicate.";
    const f = await scanHealth(
      fakeSource({
        md: [
          { path: "A.md", size: 100 },
          { path: "B.md", size: 100 },
        ],
        // Different frontmatter, identical body → still a duplicate.
        bodies: { "A.md": `---\nid: a\n---\n${body}`, "B.md": `---\nid: b\n---\n${body}` },
      }),
      40,
    );
    assert.equal(f.counts.duplicateGroups, 1);
    assert.deepEqual(f.reportOnly.duplicates[0], ["A.md", "B.md"]);
  });

  test("near-empty identical stubs are NOT grouped as duplicates (below the threshold floor)", async () => {
    const f = await scanHealth(
      fakeSource({
        md: [
          { path: "A.md", size: 10 },
          { path: "B.md", size: 10 },
        ],
        bodies: { "A.md": "tiny", "B.md": "tiny" },
      }),
      40,
    );
    assert.equal(f.counts.duplicateGroups, 0);
    // …but they ARE both flagged empty.
    assert.equal(f.counts.emptyNotes, 2);
  });

  test("a tag used at most once is low-signal; a tag used more is not", async () => {
    const f = await scanHealth(fakeSource({ tags: { "#stray": 1, "#common": 12, "#zero": 0 } }), 40);
    assert.deepEqual(
      f.reportOnly.lowSignalTags.map((t) => t.tag),
      ["#stray", "#zero"],
    );
  });

  test("summarize renders one line per tier off the counts", async () => {
    const f = await scanHealth(fakeSource({ md: [{ path: "A.md", size: 10 }], bodies: { "A.md": "" } }), 40);
    const text = summarize(f);
    assert.match(text, /^Vault health — 1 notes, 0 files$/m);
    assert.match(text, /approval-gated: 1 empty\/near-empty note\(s\)/);
  });
});

// ── 4. the lint tool's scope post-filter ─────────────────────────────────────

describe("filterFindingsToScope: restrict findings to one folder", () => {
  const source = () =>
    fakeSource({
      md: [
        { path: "Projects/Target.md", size: 100 },
        { path: "Projects/Src.md", size: 100 },
        { path: "Archive/Src.md", size: 100 },
        { path: "Projects/EmptyP.md", size: 10 },
        { path: "Archive/EmptyA.md", size: 10 },
      ],
      unresolved: {
        "Projects/Src.md": { Target: 1 }, // repointable, source in scope
        "Archive/Src.md": { Target: 1 }, // repointable, source OUT of scope
      },
      bodies: { "Projects/EmptyP.md": "", "Archive/EmptyA.md": "" },
      tags: { "#stray": 1 },
    });

  test("broken links are attributed to their SOURCE note; out-of-scope sources drop", async () => {
    const full = await scanHealth(source(), 40);
    assert.equal(full.counts.repointableLinks, 2);
    const scoped = filterFindingsToScope(full, "Projects");
    assert.deepEqual(
      scoped.autoSafe.repointableLinks.map((r) => r.source),
      ["Projects/Src.md"],
    );
    assert.deepEqual(
      scoped.approvalGated.emptyNotes.map((e) => e.path),
      ["Projects/EmptyP.md"],
    );
  });

  test("low-signal tags are omitted from a scoped lint (vault-wide, no folder attribution)", async () => {
    const scoped = filterFindingsToScope(await scanHealth(source(), 40), "Projects");
    assert.equal(scoped.counts.lowSignalTags, 0);
    assert.deepEqual(scoped.reportOnly.lowSignalTags, []);
  });

  test("scope match is segment-bounded (Proj does not match Projects/)", async () => {
    const scoped = filterFindingsToScope(await scanHealth(source(), 40), "Proj");
    assert.equal(scoped.counts.emptyNotes, 0);
  });
});

// ── 5. config coercion + validation ──────────────────────────────────────────

describe("healthConfigOf / validateHealthConfig", () => {
  test("defaults to 40 when unset or the wrong shape", () => {
    assert.equal(healthConfigOf({}).emptyChars, DEFAULT_EMPTY_CHARS);
    assert.equal(healthConfigOf({ emptyChars: "nope" }).emptyChars, 40);
    assert.equal(healthConfigOf({ emptyChars: -5 }).emptyChars, 40);
    assert.equal(healthConfigOf({ emptyChars: 0 }).emptyChars, 0);
    assert.equal(healthConfigOf({ emptyChars: 80 }).emptyChars, 80);
    assert.equal(healthConfigOf({ emptyChars: 40.9 }).emptyChars, 40); // floored
  });

  test("validate reports a bad threshold loudly (never coerces)", () => {
    assert.deepEqual(validateHealthConfig({}), []);
    assert.deepEqual(validateHealthConfig({ emptyChars: 40 }), []);
    assert.equal(validateHealthConfig({ emptyChars: "x" }).length, 1);
    assert.equal(validateHealthConfig({ emptyChars: -1 }).length, 1);
    assert.equal(validateHealthConfig({ emptyChars: 1.5 }).length, 1);
  });
});

// ── 6. tool handlers, through the publishing envelope ────────────────────────

describe("health tools: handlers answer over the injected source", () => {
  const source = () =>
    fakeSource({
      md: [
        { path: "Notes/Unique.md", size: 100 },
        { path: "Notes/Src.md", size: 100 },
      ],
      unresolved: { "Notes/Src.md": { Unique: 1 } },
    });

  test("vault_health_scan returns the full tiered findings + a summary + counts", async () => {
    const { call } = build({ source: source() });
    const res = await call("scan");
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.counts.repointableLinks, 1);
    assert.equal(res.structuredContent.autoSafe.repointableLinks[0].resolvesTo, "Notes/Unique.md");
    assert.match(res.structuredContent.summary, /Vault health/);
    assert.equal(res.structuredContent.emptyChars, 40);
  });

  test("vault_health_lint restricts to a scope and echoes it", async () => {
    const { call } = build({ source: source() });
    const res = await call("lint", { scope: "Archive" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.scope, "Archive");
    // The one repointable link's source is under Notes/, not Archive/ → filtered out.
    assert.equal(res.structuredContent.counts.repointableLinks, 0);
  });

  test("the config threshold flows into the scan (emptyChars=1 flags only truly-empty)", async () => {
    const src = fakeSource({
      md: [
        { path: "A.md", size: 10 },
        { path: "B.md", size: 10 },
      ],
      bodies: { "A.md": "", "B.md": "hello" },
    });
    const { call } = build({ source: src, config: { emptyChars: 1 } });
    const res = await call("scan");
    assert.deepEqual(res.structuredContent.approvalGated.emptyNotes.map((e) => e.path), ["A.md"]);
  });

  test("a trailing slash and an internal `./` normalize before both the guard and the filter", async () => {
    // The module filtered on the RAW argument while guarding the normalized one;
    // the satellite does both over the normalized prefix, so they cannot disagree.
    const src = fakeSource({ md: [{ path: "Projects/E.md", size: 10 }], bodies: { "Projects/E.md": "" } });
    const { call } = build({ source: src });
    for (const raw of ["Projects/", "Projects/./", "Projects//"]) {
      const res = await call("lint", { scope: raw });
      assert.equal(res.isError, undefined, raw);
      assert.equal(res.structuredContent.scope, "Projects", raw);
      assert.equal(res.structuredContent.counts.emptyNotes, 1, raw);
    }
  });
});

// ── 7. the publication contract (replaces the module-host conformance block) ──
//
// There is no module to mount any more. What takes its place is the contract with
// the Governor host: the names the two tools go on the wire under, the flags the
// host reads off them, and the argument shapes the host's guard can see. Each of
// these was a property the module got for free from the mount and now has to be
// asserted explicitly.
//
// The host's own machinery — the F3 pathless-tool block, the path allowlist,
// read-only mode, the write queue, the journal — is NOT reproduced here. It is
// host code with host tests, and external tools whose read-only claim is
// untrusted ride the same guarded registration path as built-ins, so the
// behaviour is the host's to pin. What this package owns is the half below: what
// its arguments are NAMED.

describe("publication: names, flags, and what the host's guard can scope", () => {
  const specs = () => buildHealthTools(fakeSource(), { config: () => ({}) });

  test("the plugin id sanitizes to `vault_health`, so the wire names are vault_health_scan / _lint", () => {
    assert.equal(OWNER, "vault_health");
    assert.deepEqual(specs().map((t) => t.name), ["scan", "lint"]);
    const { tools } = publishInto(specs());
    assert.deepEqual([...tools.keys()], ["vault_health_scan", "vault_health_lint"]);
  });

  test("the bare names shed `obsidian_` — a CHOICE, and the published names clear the host's F1 check", () => {
    // The rename was NOT forced. `external-tools.ts`'s F1 tests the PUBLISHED
    // name (`${owner}_${bare}`), not the bare one, so keeping `obsidian_health`
    // would have published `vault_health_obsidian_health` — legal, and merely
    // stuttering. `obsidian_` was the HOST's built-in namespace, never this
    // module's own name, which is why the bare names shed it (the bases
    // satellite's `base_` reasoning). What this pins is only the half the
    // package owns: the bare names carry no host namespace, and what we publish
    // clears F1.
    for (const spec of specs()) {
      assert.ok(!spec.name.startsWith("obsidian_"), `${spec.name} must not carry the host's namespace`);
      assert.ok(!`${OWNER}_${spec.name}`.startsWith("obsidian_"), spec.name);
    }
    // The declined alternative, spelled out so the reasoning is not lost: it
    // would have registered, which is exactly why declining it was a decision.
    assert.ok(!`${OWNER}_obsidian_health`.startsWith("obsidian_"), "the stuttering alternative was publishable");
  });

  test("both tools CLAIM read-only, and an untrusted claim registers as MUTATING", () => {
    // This is the whole reason the allowlist posture is what it is: the host
    // distrusts an external tool's readOnlyHint unless the raw publisher id is in
    // trustedReadOnlyPlugins, and a mutating tool with no path argument is
    // blocked outright under an allowlist.
    const untrusted = publishInto(specs()).tools;
    for (const bare of ["scan", "lint"]) {
      assert.equal(untrusted.get(`vault_health_${bare}`).def.claimsReadOnly, true, bare);
      assert.equal(untrusted.get(`vault_health_${bare}`).def.annotations.readOnlyHint, false, bare);
    }
    const trusted = publishInto(specs(), { trusted: true }).tools;
    for (const bare of ["scan", "lint"]) {
      assert.equal(trusted.get(`vault_health_${bare}`).def.annotations.readOnlyHint, true, bare);
    }
  });

  test("NEITHER argument list carries a host path key — so under an allowlist the host blocks both wholesale", () => {
    // The decision, pinned. `scan` takes NO arguments; `lint` takes `scope`,
    // which is a folder PREFIX and a filter over findings, not the path of a
    // file the tool reads — the scan reads the whole vault by design. It was
    // deliberately NOT renamed into a path key: the guard would then let a
    // scoped lint through while the underlying scan still read everything, which
    // is the illusion of a check. See tools.ts and CLAUDE.md.
    //
    // HOST_PATH_KEYS is a SNAPSHOT of the host's list — a review aid, not a live
    // tripwire. The test that fires when the host adds a key is the host's own
    // guard test over the live `collectPaths`.
    for (const spec of specs()) {
      for (const key of Object.keys(spec.inputSchema ?? {})) {
        assert.ok(
          !HOST_PATH_KEYS.includes(key),
          `${spec.name}.${key} would make the tool scopable — revisit the README's fail-closed posture`,
        );
      }
    }
    assert.deepEqual(Object.keys(specs()[0].inputSchema ?? {}), [], "scan takes no arguments at all");
    assert.deepEqual(Object.keys(specs()[1].inputSchema ?? {}), ["scope"]);
    assert.ok(!HOST_PATH_KEYS.includes("scope"), "the pin is only meaningful while `scope` is not a host path key");
  });

  test("refusals throw with a lowercase-snake code, which the host renders as `Error [code]: message`", async () => {
    const { call } = build();
    const res = await call("lint", { scope: "/absolute" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[invalid_scope\]: /);
  });

  test("the `.min(1)` bound is re-applied in the HANDLER, because the schema's does not survive the boundary", async () => {
    // The SDK converts zod to JSON Schema and the host converts it back through a
    // small subset: type, description and string enums survive; min, max, default
    // and pattern do not. So an empty-string / missing / non-string `scope`
    // reaches the handler and must refuse there. This is the
    // vault_skills_release semver lesson.
    const { call } = build();
    for (const args of [{ scope: "" }, {}, { scope: 7 }, { scope: null }]) {
      const res = await call("lint", args);
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.match(errText(res), /^Error \[invalid_argument\]: /, JSON.stringify(args));
    }
  });

  test("the tool DESCRIPTIONS snapshot the threshold at build time — which is why main.ts re-publishes", () => {
    const at40 = buildHealthTools(fakeSource(), { config: () => ({}) });
    assert.ok(at40.every((t) => t.description.includes("40 characters")), "the shipped default renders");
    const at200 = buildHealthTools(fakeSource(), { config: () => ({ emptyChars: 200 }) });
    assert.ok(at200.every((t) => t.description.includes("200 characters")));
    // The snapshot is frozen for the life of the spec: changing the config a
    // published spec closes over does NOT change its description. Only a
    // republish does, which is the contract main.ts implements.
    let config = { emptyChars: 200 };
    const live = buildHealthTools(fakeSource(), { config: () => config });
    config = { emptyChars: 5 };
    assert.ok(live.every((t) => t.description.includes("200 characters")), "the description stays frozen");
  });

  test("the config is read PER CALL — the registration-time capture the extraction fixed", async () => {
    // `registerHealthTools` computed `healthConfigOf(ctx.config)` ONCE and both
    // handlers closed over it. As a module that was per-connection; as a
    // satellite there is no per-connection rebuild, so the capture would have
    // frozen the threshold at plugin load forever.
    let config = { emptyChars: 1 };
    const source = fakeSource({
      md: [
        { path: "A.md", size: 10 },
        { path: "B.md", size: 10 },
      ],
      bodies: { "A.md": "", "B.md": "hello" },
    });
    const { tools } = publishInto(buildHealthTools(source, { config: () => config }));
    const call = (bare, args = {}) => tools.get(`${OWNER}_${bare}`).handler(args);

    const first = await call("scan");
    assert.equal(first.structuredContent.emptyChars, 1);
    assert.deepEqual(first.structuredContent.approvalGated.emptyNotes.map((e) => e.path), ["A.md"]);

    config = { emptyChars: 40 };
    const second = await call("scan");
    assert.equal(second.structuredContent.emptyChars, 40, "the new threshold took effect with no republish");
    assert.deepEqual(second.structuredContent.approvalGated.emptyNotes.map((e) => e.path), ["A.md", "B.md"]);

    // The same freshness through lint.
    const scoped = await call("lint", { scope: "A.md" });
    assert.equal(scoped.structuredContent.emptyChars, 40);
  });
});

// ── 8. the scope guard, through the published tool ───────────────────────────
//
// `scope` is a bare string, so it is NOT in the host guard's PATH_KEYS and
// `guardCall` never sees it — a tool taking one must check it by hand, and until
// 2026-08-29 this one did not: a session allowlisted to `Projects/` could lint
// `Archive/Secrets` and get back that folder's dangling-link text,
// orphan-attachment paths, empty-note paths and duplicate-group paths, with
// `ctx.getSettings` sitting on the context declared and never called.
//
// At S7 the resolver was PUBLISHED into `@vault-mcp/core` rather than copied into
// this package (packages/core/src/scope.ts) — the isVisible / executeQuickAddChoice
// precedent. The move is behaviour-preserving except for ONE new refusal: a scope
// containing a BACKSLASH is now `invalid_scope`, because every downstream check
// splits on "/" alone. Core's own tests pin the function; what THIS suite pins is
// that the tool SURFACES each refusal, in the envelope an agent reads.

describe("vault_health_lint: the scope argument is guarded by hand, since the host guard cannot see it", () => {
  const corpus = () =>
    fakeSource({
      md: [
        { path: "Projects/A.md", size: 100 },
        { path: "Archive/Secret.md", size: 100 },
      ],
      bodies: { "Projects/A.md": "hello", "Archive/Secret.md": "hello" },
    });

  const ALLOWLIST = { readOnly: false, allowlist: ["Projects"] };
  const sandboxed = () => build({ source: corpus(), settings: ALLOWLIST }).call;

  test("a scope outside the allowlist is REFUSED, not quietly reported as empty", async () => {
    // Refusal rather than a zeroed report on purpose: a zeroed report for a
    // hidden folder is indistinguishable from a clean one.
    const res = await sandboxed()("lint", { scope: "Archive" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[out_of_allowlist\]: /);
    // …and the refusal agrees with core's own predicate over the same settings —
    // nothing here re-implements visibility.
    assert.deepEqual(visiblePaths(["Projects/A.md", "Archive/Secret.md"], ALLOWLIST), ["Projects/A.md"]);
  });

  test("a scope INSIDE the allowlist still works", async () => {
    const res = await sandboxed()("lint", { scope: "Projects" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.scope, "Projects");
  });

  test("a scope that merely CONTAINS the allowlist is out of it too", async () => {
    // `.` normalizes to a scope that names no folder at all, so it refuses before
    // the allowlist half is even reached — either way it is typed, never a
    // whole-vault report handed to a sandboxed session.
    const res = await sandboxed()("lint", { scope: "." });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[invalid_scope\]: /);
    // A real containing prefix takes the allowlist branch.
    const res2 = await build({ source: corpus(), settings: { readOnly: false, allowlist: ["Projects/Alpha"] } }).call(
      "lint",
      { scope: "Projects" },
    );
    assert.equal(res2.isError, true);
    assert.match(errText(res2), /^Error \[out_of_allowlist\]: /);
  });

  test("malformed scopes refuse invalid_scope — absolute, `..`-escaping, whitespace-padded", async () => {
    const { call } = build({ source: corpus() });
    for (const scope of ["/Projects", "../secrets", "..", " Projects", "Projects ", "Projects/../.."]) {
      const res = await call("lint", { scope });
      assert.equal(res.isError, true, scope);
      assert.match(errText(res), /^Error \[invalid_scope\]: /, scope);
    }
  });

  test("a BACKSLASH in the scope refuses invalid_scope — the one refusal the core publication ADDED", async () => {
    // `Projects\..\..\Secrets` reads as ONE opaque segment to every check that
    // splits on "/", and as a traversal to whatever normalizes it later.
    // Obsidian paths never legitimately contain a backslash, so the class is
    // closed rather than the instance — and BOTH callers (the host's
    // obsidian_check_links and this lint) got stricter in the same motion.
    const { call } = build({ source: corpus() });
    for (const scope of ["Projects\\..\\Archive", "Archive\\Secret.md", "a\\b"]) {
      const res = await call("lint", { scope });
      assert.equal(res.isError, true, scope);
      assert.match(errText(res), /^Error \[invalid_scope\]: /, scope);
      assert.match(errText(res), /contains a backslash/, scope);
    }
  });

  test("with NO settings supplied the guard still refuses malformed scopes — only the allowlist half is dormant", async () => {
    // The shipped configuration: main.ts supplies no `getSettings`, because a
    // satellite cannot reach the host's guard settings. The malformed-scope half
    // is what remains load-bearing, and it is the half that runs in the
    // configuration the operator actually has (an empty allowlist).
    const { call } = build({ source: corpus() });
    const bad = await call("lint", { scope: "/Archive" });
    assert.equal(bad.isError, true);
    const fine = await call("lint", { scope: "Archive" });
    assert.equal(fine.isError, undefined, "with no allowlist configured, any well-formed scope is in scope");
  });
});

// ── 9. one-shot config adoption from the host's modules.health.config ────────

describe("settings adoption (pure)", () => {
  const HOST = (config) => ({ modules: { health: { enabled: true, config } } });
  const fresh = () => ({ ...DEFAULT_PLUGIN_SETTINGS, config: {} });

  test("adopts the recognized key once and latches", () => {
    const out = adoptHostConfig(fresh(), HOST({ emptyChars: 200 }));
    assert.deepEqual(out.config, { emptyChars: 200 });
    assert.equal(out.adoptedFromHost, true);
    assert.equal(adoptHostConfig(out, HOST({ emptyChars: 5 })), null, "the latch is one-shot");
  });

  test("the satellite's OWN values win; adoption only fills gaps", () => {
    const out = adoptHostConfig({ ...fresh(), config: { emptyChars: 99 } }, HOST({ emptyChars: 200 }));
    assert.deepEqual(out.config, { emptyChars: 99 });
  });

  test("an unrecognized host key is NOT copied", () => {
    const out = adoptHostConfig(fresh(), HOST({ notAField: 1, emptyChars: 7 }));
    assert.deepEqual(out.config, { emptyChars: 7 });
    assert.deepEqual([...ADOPTABLE_KEYS].sort(), Object.keys(DEFAULT_HEALTH_CONFIG).sort());
  });

  test("an ABSENT host adopts nothing and does NOT latch — the one chance survives", () => {
    assert.equal(adoptHostConfig(fresh(), undefined), null);
    assert.equal(adoptHostConfig(fresh(), null), null);
  });

  test("a host whose `settings` is still UNDEFINED reads as NOT READY, never as empty settings", () => {
    // main.ts passes `undefined` for a host instance whose `settings` field has
    // not been assigned yet (it is declared without an initializer and assigned
    // mid-onload). Treating that as "host present, empty settings" would burn the
    // one-shot latch on nothing and the user's config would never adopt — the
    // failure the skills extraction's review found.
    assert.equal(adoptHostConfig(fresh(), undefined), null);
  });

  test("a host present with NO health config still latches — the question was asked and answered", () => {
    const out = adoptHostConfig(fresh(), { modules: { health: { enabled: true } } });
    assert.deepEqual(out.config, {});
    assert.equal(out.adoptedFromHost, true);
  });

  test("settingsOf coerces a corrupt or hand-edited data.json to the defaults", () => {
    assert.deepEqual(settingsOf(null), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf([1, 2]), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf({ config: "nope", adoptedFromHost: "yes" }), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf({ config: { emptyChars: 7 }, adoptedFromHost: true }), {
      config: { emptyChars: 7 },
      adoptedFromHost: true,
    });
  });

  test("there is exactly ONE adoption — no operator state file to migrate", () => {
    // Unlike the crosssession satellite, the health module kept nothing on disk:
    // every call recomputes the scan from the live metadata cache. The absence is
    // a checked fact, so a future reader does not have to wonder whether a second
    // latch was forgotten.
    assert.deepEqual(Object.keys(DEFAULT_PLUGIN_SETTINGS).sort(), ["adoptedFromHost", "config"]);
  });

  test("the settings-tab fields are the host manifest's one key, with its label and help", () => {
    assert.deepEqual(HEALTH_FIELDS.map((f) => f.key), ["emptyChars"]);
    const [field] = HEALTH_FIELDS;
    assert.equal(field.label, "Empty-note character threshold");
    assert.equal(field.type, "number");
    assert.ok(field.help.includes(`(${DEFAULT_EMPTY_CHARS})`), "the help interpolates the shipped default");
    // No stale `modules.health.config.` pointer in anything user-visible.
    assert.ok(!field.help.includes("modules.health.config"));
  });
});
