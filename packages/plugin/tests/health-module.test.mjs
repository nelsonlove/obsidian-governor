/**
 * health-module.test.mjs — the obsidian-vault-health scanner folded into
 * vault-mcp. What this proves:
 *
 *   1. the PURE core (kernel/health/*, Obsidian-free over an injected
 *      HealthSource) reproduces the standalone's tiered classification —
 *      auto-safe (unique-target broken link, guarded by the single-candidate
 *      check), approval-gated (empty note at/under the char threshold; orphan
 *      attachment), report-only (dangling link, duplicate bodies, low-signal tag);
 *   2. the empty-char threshold boundary and the single-candidate guard;
 *   3. obsidian_lint's scope post-filter (source-note attribution; tags dropped);
 *   4. config coercion/validation of the emptyChars threshold;
 *   5. the two tools register through the module host, BOTH read-only, the module
 *      ships DISABLED, and it contributes NO write / accept tool — the module has
 *      no write path at all (that is the design).
 *
 * Headless: tools-health.ts imports nothing from `obsidian`; the vault arrives as
 * a fake HealthSource. The live adapter (obsidianHealthBackend, reading
 * app.metadataCache + the vault adapter) is the one un-headless-testable seam.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  scanHealth,
  filterFindingsToScope,
  healthConfigOf,
  validateHealthConfig,
  DEFAULT_EMPTY_CHARS,
} from "../src/kernel/health/index.ts";
import { registerHealthTools } from "../src/mcp/tools-health.ts";
import { mountModules, builtinModules } from "../src/mcp/modules-mount.ts";
import { collect, forbiddenToolName } from "../src/kernel/modules/index.ts";

const HEALTH_TOOLS = ["obsidian_health", "obsidian_lint"];

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
});

// ── 4. obsidian_lint scope post-filter ───────────────────────────────────────

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

// ── 6. tool handlers ─────────────────────────────────────────────────────────

function tools(source, config = {}) {
  const server = fakeServer();
  registerHealthTools(server, source, { config, getSettings: () => ({}) });
  return server;
}

describe("health tools: handlers answer over the injected source", () => {
  const source = () =>
    fakeSource({
      md: [
        { path: "Notes/Unique.md", size: 100 },
        { path: "Notes/Src.md", size: 100 },
      ],
      unresolved: { "Notes/Src.md": { Unique: 1 } },
    });

  test("obsidian_health returns the full tiered findings + a summary + counts", async () => {
    const res = await tools(source()).tools.get("obsidian_health").handler({});
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.counts.repointableLinks, 1);
    assert.equal(res.structuredContent.autoSafe.repointableLinks[0].resolvesTo, "Notes/Unique.md");
    assert.match(res.structuredContent.summary, /Vault health/);
    assert.equal(res.structuredContent.emptyChars, 40);
  });

  test("obsidian_lint restricts to a scope and echoes it", async () => {
    const res = await tools(source()).tools.get("obsidian_lint").handler({ scope: "Archive" });
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
    const res = await tools(src, { emptyChars: 1 }).tools.get("obsidian_health").handler({});
    assert.deepEqual(res.structuredContent.approvalGated.emptyNotes.map((e) => e.path), ["A.md"]);
  });

  test("both tools register read-only", () => {
    const server = tools(source());
    for (const n of HEALTH_TOOLS) {
      assert.equal(server.tools.get(n).def.annotations.readOnlyHint, true, `${n} must be read-only`);
    }
  });
});

// ── 7. module registration through the module host ───────────────────────────

const inertHealth = {
  resolvedLinks: () => ({}),
  unresolvedLinks: () => ({}),
  tags: () => ({}),
  markdownFiles: () => [],
  allFiles: () => [],
  aliases: () => ({}),
  noteBody: async () => null,
};

function deps(settings = {}) {
  return {
    getSettings: () => settings,
    schemeNotes: () => [],
    vocabSource: { paths: () => [], frontmatter: () => null, body: async () => null },
    provenanceSource: {
      noteFrontmatter: () => null,
      read: async () => null,
      stat: async () => null,
      glob: async () => [],
      writeNote: async () => {},
    },
    healthSource: inertHealth,
  };
}

function mount(settings) {
  const server = fakeServer();
  const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps(settings));
  return { server, registry };
}

describe("health module: registration through the module host", () => {
  test("ships DISABLED — contributes nothing by default", () => {
    const { server, registry } = mount({});
    assert.equal(registry.isEnabled("health"), false);
    assert.ok(!server.tools.has("obsidian_health"));
    assert.ok(!server.tools.has("obsidian_lint"));
  });

  test("enabled: both tools register, BOTH read-only, no registry problems", () => {
    const { server, registry } = mount({ modules: { health: { enabled: true } } });
    for (const n of HEALTH_TOOLS) {
      assert.ok(server.tools.has(n), `missing ${n}`);
      assert.equal(server.tools.get(n).def.annotations.readOnlyHint, true, `${n} must be read-only`);
    }
    // health declares NO `mutating` flag, so the read-only-only mount gate must
    // admit it with zero problems.
    assert.deepEqual(registry.problems, []);
  });

  test("contributes NO accept/approve/write tool — the module has no write path", () => {
    for (const n of HEALTH_TOOLS) assert.equal(forbiddenToolName(n), false, `${n} unexpectedly reads as accept-shaped`);
    const { server } = mount({ modules: { health: { enabled: true } } });
    const healthNames = [...server.tools.keys()].filter((n) => n === "obsidian_health" || n === "obsidian_lint");
    assert.equal(healthNames.length, 2);
    assert.ok(!healthNames.some((n) => forbiddenToolName(n)));
  });

  test("collect() renders a health config tab: summary, one config field (default 40), two-tool directory", () => {
    const hosted = collect(builtinModules(deps({})), {}, {});
    const health = hosted.find((h) => h.id === "health");
    assert.ok(health, "health module not rendered");
    assert.ok(health.summary.length > 0);
    assert.equal(health.fields.length, 1);
    assert.equal(health.fields.find((f) => f.key === "emptyChars").value, 40);
    assert.deepEqual(health.directory.tools.map((t) => t.name).sort(), [...HEALTH_TOOLS].sort());
    for (const t of health.directory.tools) assert.equal(t.readOnly, true, `${t.name} readOnly flag`);
  });
});

// ── the scope guard (2026-08-29 review) ──────────────────────────────────────
//
// `obsidian_lint`'s `scope` is a bare string, so it is NOT in guard.ts's
// PATH_KEYS and `guardCall` never sees it — a tool taking one must check it by
// hand, and this one did not. A session allowlisted to `Projects/` could lint
// `Archive/` and get back that folder's dangling-link text, orphan-attachment
// paths, empty-note paths and duplicate-group paths.

describe("obsidian_lint: the scope argument is guarded by hand, since guardCall cannot see it", () => {
  const corpus = () =>
    fakeSource({
      md: [
        { path: "Projects/A.md", size: 100 },
        { path: "Archive/Secret.md", size: 100 },
      ],
      bodies: { "Projects/A.md": "hello", "Archive/Secret.md": "hello" },
    });

  const sandboxed = () => {
    const server = fakeServer();
    registerHealthTools(server, corpus(), {
      config: {},
      getSettings: () => ({ readOnly: false, allowlist: ["Projects"] }),
    });
    return server.tools.get("obsidian_lint").handler;
  };

  test("a scope outside the allowlist is REFUSED, not quietly reported as empty", async () => {
    // Refusal rather than a zeroed report on purpose: a zeroed report for a
    // hidden folder is indistinguishable from a clean one.
    const res = await sandboxed()({ scope: "Archive" });
    assert.equal(res.isError, true);
    assert.match(JSON.stringify(res), /out_of_allowlist/);
  });

  test("a scope INSIDE the allowlist still works", async () => {
    const res = await sandboxed()({ scope: "Projects" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.scope, "Projects");
  });

  test("a scope that merely CONTAINS the allowlist is out of it too", async () => {
    const res = await sandboxed()({ scope: "." });
    assert.equal(res.isError, true);
  });
});
