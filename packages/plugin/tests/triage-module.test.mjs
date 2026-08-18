/**
 * triage-module.test.mjs — the inbox-triage module (#221 phase 2): the
 * disposition substrate's second instance.
 *
 * Pins:
 *   • the SUBSTRATE EXTRACTION is invisible — the governance table still
 *     declares against the shared shape and the shared helpers behave
 *     identically over both instances (the governance suite itself runs
 *     untouched; here we pin the substrate side);
 *   • descriptor completeness — exactly the legacy flow's ten dispositions,
 *     ALL `authority: "agent"` (none confers standing), pure frozen data,
 *     single-sourced into the tool's enum and description;
 *   • triage_queue — inbox recognition by configured marker, folder-note
 *     exclusion, allowlist filtering BEFORE reads, oldest-first order, cap;
 *   • triage_dispose — dry-run by default (reports, writes nothing),
 *     per-disposition apply effects over a fake source (move / retype /
 *     trash), target-required and target-unsupported refusals, unknown
 *     disposition refusal, destination_unresolved / destination_occupied /
 *     out_of_allowlist refusals, accept-forbidden config patches refused,
 *     scheme-absent degradation (and the advisory when present);
 *   • module-host conformance — mounted through the ModuleRegistry as a
 *     `mutating: true` module, default DISABLED, config validated loudly;
 *   • the TOOL-INVENTORY doc documents both tool names (the crosssession
 *     precedent for surfaces outside the locked obsidian_* family).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fakeServer } from "./fake-server.mjs";
import {
  TRIAGE_DISPOSITIONS,
  triageDispositionById,
  triageDispositionIds,
  triageDispositionLines,
  DEFAULT_TRIAGE_CONFIG,
  validateTriageConfig,
  triageConfigOf,
  inboxFolderOf,
  sortQueue,
  planDispose,
  applyFrontmatterPatch,
  gestureGatedIn,
  dispositionsForSurface,
  dispositionByIdIn,
} from "../src/kernel/triage/index.ts";
import { DISPOSITIONS } from "../src/kernel/governance/dispositions.ts";
import { registerTriageTools, emptyTriageSource } from "../src/mcp/tools-triage.ts";
import { mountModules } from "../src/mcp/modules-mount.ts";
import { memoryReceiptStore } from "../src/kernel/crosssession/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── a fake vault the handlers run over ──────────────────────────────────────

const INBOX = "00-09 System/03 Agents/03.10 Inbox for 03 Agents";

function fakeVault(files = {}) {
  // files: path -> { ctime?, mtime?, fm? }
  const state = new Map(Object.entries(files));
  const log = [];
  return {
    state,
    log,
    source: {
      paths: () => [...state.keys()],
      frontmatter: (p) => state.get(p)?.fm ?? null,
      stat: (p) => {
        const f = state.get(p);
        return f ? { ctime: f.ctime ?? null, mtime: f.mtime ?? null } : null;
      },
      exists: (p) => state.has(p),
      move: async (from, to) => {
        if (!state.has(from)) throw new Error(`not found: ${from}`);
        if (state.has(to)) throw new Error(`destination exists: ${to}`);
        state.set(to, state.get(from));
        state.delete(from);
        log.push({ op: "move", from, to });
      },
      trashNote: async (p) => {
        if (!state.has(p)) throw new Error(`not found: ${p}`);
        state.delete(p);
        log.push({ op: "trash", path: p });
      },
      updateFrontmatter: async (p, apply) => {
        const f = state.get(p);
        if (!f) throw new Error(`not found: ${p}`);
        f.fm = f.fm ?? {};
        apply(f.fm);
        log.push({ op: "frontmatter", path: p, fm: JSON.parse(JSON.stringify(f.fm)) });
      },
    },
  };
}

function register(vault, ctxOverrides = {}) {
  const server = fakeServer();
  registerTriageTools(server, vault.source, { config: { ...DEFAULT_TRIAGE_CONFIG }, ...ctxOverrides });
  return server;
}

const item = (name) => `${INBOX}/${name}`;

// ── the substrate (Part A): extraction invisible, helpers shared ────────────

describe("the disposition substrate: shared shape, both instances declared against it", () => {
  test("the governance instance still behaves identically through the shared helpers", () => {
    // The substrate helpers give the same answers the governance instance's
    // own (delegating) helpers give — the extraction moved code, not behavior.
    assert.deepEqual(
      dispositionsForSurface(DISPOSITIONS, "pending-item").map((d) => d.id),
      ["accept", "revert", "request-changes"],
    );
    assert.equal(dispositionByIdIn(DISPOSITIONS, "adopt").confirm, true);
    assert.deepEqual(
      gestureGatedIn(DISPOSITIONS).map((d) => d.id).sort(),
      ["accept", "adopt", "request-changes", "revert", "withdraw"],
    );
  });

  test("the triage instance has NOTHING to gesture-gate — no human verb, no pane surface", () => {
    assert.deepEqual(gestureGatedIn(TRIAGE_DISPOSITIONS), []);
    assert.deepEqual(
      dispositionsForSurface(TRIAGE_DISPOSITIONS, "mcp-tool").map((d) => d.id),
      [...triageDispositionIds()],
    );
  });
});

// ── descriptor completeness (Part B, single source) ─────────────────────────

describe("triage descriptors: the legacy flow's ten verbs, all agent, pure frozen data", () => {
  test("exactly the ten legacy dispositions, in declared order", () => {
    assert.deepEqual(triageDispositionIds(), [
      "discard",
      "route",
      "establish-new-home",
      "convert-to-action",
      "develop-as-knowledge",
      "register",
      "curate-as-link",
      "defer-to-someday",
      "archive-as-record",
      "escalate",
    ]);
  });

  test("every disposition is authority: agent — none confers standing", () => {
    for (const d of TRIAGE_DISPOSITIONS) {
      assert.equal(d.authority, "agent", `${d.id} must be agent-authority`);
      assert.equal(d.surface, "mcp-tool", `${d.id} must surface as an MCP tool`);
    }
  });

  test("the target-policy table matches the legacy flow's NEEDS_TARGET set", () => {
    const required = TRIAGE_DISPOSITIONS.filter((d) => d.targetPolicy === "required").map((d) => d.id);
    assert.deepEqual(required.sort(), ["curate-as-link", "establish-new-home", "register", "route"]);
    const none = TRIAGE_DISPOSITIONS.filter((d) => d.targetPolicy === "none").map((d) => d.id);
    assert.deepEqual(none.sort(), ["discard", "escalate"]);
    // The rest fall back to config destinations.
    const configOr = TRIAGE_DISPOSITIONS.filter((d) => d.targetPolicy === "config-or-target");
    assert.deepEqual(configOr.map((d) => d.id).sort(), [
      "archive-as-record",
      "convert-to-action",
      "defer-to-someday",
      "develop-as-knowledge",
    ]);
    for (const d of configOr) assert.ok(d.destinationKey, `${d.id} must name its destination config key`);
  });

  test("descriptors are pure frozen data — no callable rides any descriptor", () => {
    assert.ok(Object.isFrozen(TRIAGE_DISPOSITIONS));
    for (const d of TRIAGE_DISPOSITIONS) {
      assert.ok(Object.isFrozen(d), `${d.id} must be frozen`);
      for (const [k, v] of Object.entries(d)) {
        assert.notEqual(typeof v, "function", `${d.id}.${k} must not be a callable`);
        assert.equal(typeof v, "string", `${d.id}.${k} must be plain string data`);
      }
      assert.ok(d.effect.length > 0 && d.label.length > 0, `${d.id} must declare label + effect`);
    }
  });

  test("the table is the SINGLE SOURCE: the tool enum and description derive from it", () => {
    const vault = fakeVault();
    const server = register(vault);
    const { def } = server.tools.get("triage_dispose");
    // Every id appears in the registered description (via triageDispositionLines).
    for (const line of triageDispositionLines()) {
      assert.ok(def.description.includes(line), `description must carry: ${line}`);
    }
    // And the zod enum accepts exactly the table's ids.
    const dispositionSchema = def.inputSchema.disposition;
    for (const id of triageDispositionIds()) {
      assert.equal(dispositionSchema.safeParse(id).success, true, `enum must accept ${id}`);
    }
    assert.equal(dispositionSchema.safeParse("accept").success, false, "the enum is closed");
    // No accept-shaped verb anywhere in the set.
    for (const id of triageDispositionIds()) {
      assert.ok(!/accept|approve|baseline/i.test(id), `${id} must not be accept-shaped`);
    }
  });

  test("dry_run defaults to TRUE at the schema level (report-first)", () => {
    const vault = fakeVault();
    const server = register(vault);
    const { def } = server.tools.get("triage_dispose");
    assert.equal(def.inputSchema.dry_run.parse(undefined), true);
  });
});

// ── config ──────────────────────────────────────────────────────────────────

describe("triage config: validated loudly, degrades to defaults, never hardwired", () => {
  test("defaults mirror the legacy flow's stamps and the live inbox convention", () => {
    const cfg = triageConfigOf({ ...DEFAULT_TRIAGE_CONFIG });
    assert.deepEqual(cfg.inboxMarkers, [" Inbox for "]);
    assert.deepEqual(cfg.actionFrontmatter, { tags: ["note/task"], status: "open", priority: "normal" });
    assert.deepEqual(cfg.somedayFrontmatter, { status: "someday" });
    assert.deepEqual(cfg.escalateFrontmatter, { tags: ["attention/user"] });
    assert.equal(cfg.archiveDestination, "");
  });

  test("validate is loud about every malformed value", () => {
    const problems = validateTriageConfig({
      inboxMarkers: "not-an-array",
      archiveDestination: "/absolute",
      actionFrontmatter: "{not json",
      somedayFrontmatter: '["array"]',
    });
    assert.ok(problems.some((p) => p.includes("inboxMarkers")));
    assert.ok(problems.some((p) => p.includes("archiveDestination")));
    assert.ok(problems.some((p) => p.includes("actionFrontmatter")));
    assert.ok(problems.some((p) => p.includes("somedayFrontmatter")));
  });

  test("an empty markers list is refused — with none, nothing is ever an inbox item", () => {
    assert.ok(validateTriageConfig({ inboxMarkers: [] }).some((p) => p.includes("inboxMarkers")));
    assert.ok(validateTriageConfig({ inboxMarkers: ["  "] }).some((p) => p.includes("inboxMarkers")));
  });

  test("a configured patch may never assert acceptance (the shared rule, at validation time)", () => {
    const problems = validateTriageConfig({ escalateFrontmatter: '{"accepted-by": "me"}' });
    assert.ok(problems.some((p) => p.includes("escalateFrontmatter") && p.includes("acceptance")));
    const problems2 = validateTriageConfig({ actionFrontmatter: '{"acceptance-status": "accepted"}' });
    assert.ok(problems2.some((p) => p.includes("actionFrontmatter")));
    // `acceptance-status: proposed` is agent-legal, exactly like every write surface.
    assert.deepEqual(validateTriageConfig({ actionFrontmatter: '{"acceptance-status": "proposed"}' }), []);
  });

  test("triageConfigOf degrades an invalid stored value to its default (validation already reported it)", () => {
    const cfg = triageConfigOf({ ...DEFAULT_TRIAGE_CONFIG, somedayFrontmatter: "{broken", inboxMarkers: 42 });
    assert.deepEqual(cfg.somedayFrontmatter, { status: "someday" });
    assert.deepEqual(cfg.inboxMarkers, [" Inbox for "]);
  });

  test("inbox recognition is configurable — a different vault's marker works, the default stops applying", () => {
    assert.equal(inboxFolderOf("A/My Inbox/x.md", ["Inbox"]), "A/My Inbox");
    assert.equal(inboxFolderOf("A/My Inbox/x.md", [" Inbox for "]), null);
  });
});

// ── the queue predicate + queue tool ────────────────────────────────────────

describe("inbox recognition (pure)", () => {
  test("any ancestor folder matching a marker qualifies; deepest inbox wins", () => {
    assert.equal(inboxFolderOf(`${INBOX}/x.md`, [" Inbox for "]), INBOX);
    assert.equal(inboxFolderOf(`${INBOX}/sub/x.md`, [" Inbox for "]), INBOX);
    assert.equal(
      inboxFolderOf(`${INBOX}/9 Inbox for sub/x.md`, [" Inbox for "]),
      `${INBOX}/9 Inbox for sub`,
    );
    assert.equal(inboxFolderOf("Projects/x.md", [" Inbox for "]), null);
    assert.equal(inboxFolderOf("root-note.md", [" Inbox for "]), null);
  });

  test("the inbox's own folder note is not an item", () => {
    assert.equal(inboxFolderOf(`${INBOX}/03.10 Inbox for 03 Agents.md`, [" Inbox for "]), null);
    // …but a same-named note one level DEEPER is an ordinary item (its
    // immediate parent is "sub", so it is not the inbox's folder note).
    assert.equal(inboxFolderOf(`${INBOX}/sub/03.10 Inbox for 03 Agents.md`, [" Inbox for "]), INBOX);
  });

  test("sortQueue: oldest first, unknown created last, path tiebreak", () => {
    const rows = [
      { path: "b.md", inbox: "i", created: 200, modified: null, type: null, status: null },
      { path: "a.md", inbox: "i", created: null, modified: null, type: null, status: null },
      { path: "c.md", inbox: "i", created: 100, modified: null, type: null, status: null },
      { path: "d.md", inbox: "i", created: 100, modified: null, type: null, status: null },
    ];
    assert.deepEqual(sortQueue(rows).map((r) => r.path), ["c.md", "d.md", "b.md", "a.md"]);
  });
});

describe("triage_queue", () => {
  const files = {
    [item("old.md")]: { ctime: 1_000, mtime: 2_000, fm: { type: "note", status: "open" } },
    [item("new.md")]: { ctime: 5_000, mtime: 6_000 },
    [`${INBOX}/03.10 Inbox for 03 Agents.md`]: { ctime: 1 }, // the folder note — not an item
    "Projects/elsewhere.md": { ctime: 10 },
  };

  test("lists inbox items only, oldest first, with metadata", async () => {
    const server = register(fakeVault(files), { now: () => new Date(86_400_000 * 3) });
    const { def, handler } = server.tools.get("triage_queue");
    assert.equal(def.annotations.readOnlyHint, true);
    const res = await handler({});
    assert.equal(res.isError, undefined);
    const sc = res.structuredContent;
    assert.equal(sc.total, 2);
    assert.deepEqual(sc.notes.map((n) => n.path), [item("old.md"), item("new.md")]);
    assert.equal(sc.notes[0].inbox, INBOX);
    assert.equal(sc.notes[0].type, "note");
    assert.equal(sc.notes[0].status, "open");
    assert.equal(sc.notes[0].created, new Date(1_000).toISOString());
    assert.equal(sc.notes[0].age_days, 2); // ~3 days clock minus ~0 created
    assert.equal(sc.notes[1].type, null);
    assert.equal(sc.truncated, false);
  });

  test("allowlist filtering: hidden inbox notes are neither listed nor read", async () => {
    const vault = fakeVault(files);
    let framed = 0;
    const spySource = {
      ...vault.source,
      frontmatter: (p) => {
        framed++;
        return vault.source.frontmatter(p);
      },
    };
    const server = fakeServer();
    registerTriageTools(server, spySource, {
      config: { ...DEFAULT_TRIAGE_CONFIG },
      visible: (paths) => paths.filter((p) => p.endsWith("new.md")),
    });
    const res = await server.tools.get("triage_queue").handler({});
    assert.deepEqual(res.structuredContent.notes.map((n) => n.path), [item("new.md")]);
    assert.equal(framed, 1, "hidden notes' frontmatter must never be read");
  });

  test("the cap truncates with the total reported", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("triage_queue").handler({ limit: 1 });
    assert.equal(res.structuredContent.total, 2);
    assert.equal(res.structuredContent.returned, 1);
    assert.equal(res.structuredContent.truncated, true);
  });
});

// ── triage_dispose ──────────────────────────────────────────────────────────

const errText = (res) => res.content.map((c) => c.text).join("\n");

describe("triage_dispose: refusals (typed, identical for dry-run and apply)", () => {
  const files = { [item("x.md")]: { ctime: 1 }, "Projects/done.md": {} };

  test("a non-inbox note is refused not_inbox", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("triage_dispose").handler({ path: "Projects/done.md", disposition: "discard" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /not_inbox/);
  });

  test("unknown disposition is refused at runtime too (the enum already blocks it at the schema)", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "explode" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /unknown_disposition/);
  });

  test("target-required dispositions refuse typed without one", async () => {
    const server = register(fakeVault(files));
    for (const disposition of ["route", "establish-new-home", "register", "curate-as-link"]) {
      const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition });
      assert.equal(res.isError, true, `${disposition} must refuse`);
      assert.match(errText(res), /target_required/);
    }
  });

  test("discard/escalate refuse a target — nothing to aim", async () => {
    const server = register(fakeVault(files));
    for (const disposition of ["discard", "escalate"]) {
      const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition, target: "T" });
      assert.equal(res.isError, true);
      assert.match(errText(res), /target_unsupported/);
    }
  });

  test("config-backed dispositions refuse destination_unresolved with neither target nor config", async () => {
    const server = register(fakeVault(files));
    for (const disposition of ["convert-to-action", "develop-as-knowledge", "defer-to-someday", "archive-as-record"]) {
      const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition });
      assert.equal(res.isError, true, `${disposition} must refuse unconfigured`);
      assert.match(errText(res), /destination_unresolved/);
      assert.match(errText(res), /modules\.triage\.config/);
    }
  });

  test("an occupied destination is refused — never an overwrite", async () => {
    const vault = fakeVault({ [item("x.md")]: {}, "Projects/x.md": {} });
    const server = register(vault);
    const res = await server.tools
      .get("triage_dispose")
      .handler({ path: item("x.md"), disposition: "route", target: "Projects", dry_run: false });
    assert.equal(res.isError, true);
    assert.match(errText(res), /destination_occupied/);
    assert.deepEqual(vault.log, [], "nothing may be written");
  });

  test("a computed destination outside the allowlist is refused, dry-run included", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = fakeServer();
    registerTriageTools(server, vault.source, {
      config: { ...DEFAULT_TRIAGE_CONFIG },
      visible: (paths) => paths.filter((p) => !p.startsWith("Secret/")),
    });
    const res = await server.tools
      .get("triage_dispose")
      .handler({ path: item("x.md"), disposition: "route", target: "Secret" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /out_of_allowlist/);
  });

  test("a malformed target is refused (absolute, escaping, whitespace)", async () => {
    const server = register(fakeVault(files));
    for (const target of ["/abs", "a/../b", " padded "]) {
      const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "route", target });
      assert.equal(res.isError, true, `target ${JSON.stringify(target)} must refuse`);
      assert.match(errText(res), /invalid_target/);
    }
  });

  test("a missing source note is refused not_found", async () => {
    const server = register(fakeVault({}));
    const res = await server.tools.get("triage_dispose").handler({ path: item("ghost.md"), disposition: "discard" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /not_found/);
  });

  test("an acceptance-carrying configured patch can NEVER reach a note — sanitized to the default at coercion, re-checked at the write", async () => {
    // Layer 1 (validation): validateTriageConfig refuses it loudly — pinned in
    // the config suite above. Layer 2 (coercion): triageConfigOf treats an
    // acceptance-carrying patch as invalid and degrades to the CLEAN default,
    // so the runtime accept_forbidden belt in the handler is genuinely
    // unreachable through config — pinned here by applying and observing that
    // only the default patch landed, never the acceptance field.
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = fakeServer();
    registerTriageTools(server, vault.source, {
      config: { ...DEFAULT_TRIAGE_CONFIG, escalateFrontmatter: '{"accepted-on": "2026-01-01"}' },
    });
    const res = await server.tools
      .get("triage_dispose")
      .handler({ path: item("x.md"), disposition: "escalate", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [
      { op: "frontmatter", path: item("x.md"), fm: { tags: ["attention/user"] } },
    ]);
    assert.ok(!("accepted-on" in vault.state.get(item("x.md")).fm), "the acceptance field must never land");
  });
});

describe("triage_dispose: dry-run (the default) reports and writes nothing", () => {
  test("dry-run is the default and reports the exact plan", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: { ...DEFAULT_TRIAGE_CONFIG, archiveDestination: "Archive/2026" } });
    const res = await server.tools
      .get("triage_dispose")
      .handler({ path: item("x.md"), disposition: "archive-as-record" });
    assert.equal(res.isError, undefined);
    const sc = res.structuredContent;
    assert.equal(sc.dry_run, true);
    assert.equal(sc.applied, false);
    assert.equal(sc.plan.action, "move");
    assert.equal(sc.plan.move_to, `Archive/2026/x.md`);
    assert.equal(sc.inbox, INBOX);
    assert.deepEqual(vault.log, [], "dry-run writes nothing");
    assert.ok(!("filesChanged" in sc), "dry-run reports no effects");
  });

  test("dry-run for a retyping disposition reports the frontmatter patch", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: { ...DEFAULT_TRIAGE_CONFIG, actionDestination: "Tasks" } });
    const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "convert-to-action" });
    const sc = res.structuredContent;
    assert.deepEqual(sc.plan.frontmatter_patch, { tags: ["note/task"], status: "open", priority: "normal" });
    assert.equal(sc.plan.move_to, "Tasks/x.md");
    assert.deepEqual(vault.log, []);
  });
});

describe("triage_dispose: apply — each disposition's effect over the fake backend", () => {
  test("discard trashes (never deletes) the note", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault);
    const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "discard", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [{ op: "trash", path: item("x.md") }]);
    assert.equal(res.structuredContent.trashed, true);
    assert.deepEqual(res.structuredContent.files, [item("x.md")]);
  });

  test("route / establish-new-home / register / curate-as-link move to the target folder", async () => {
    for (const disposition of ["route", "establish-new-home", "register", "curate-as-link"]) {
      const vault = fakeVault({ [item("x.md")]: {} });
      const server = register(vault);
      const res = await server.tools
        .get("triage_dispose")
        .handler({ path: item("x.md"), disposition, target: "Projects/Dest", dry_run: false });
      assert.equal(res.isError, undefined, `${disposition} must apply`);
      assert.deepEqual(vault.log, [{ op: "move", from: item("x.md"), to: "Projects/Dest/x.md" }]);
      assert.equal(res.structuredContent.applied, true);
      assert.equal(res.structuredContent.moved_to, "Projects/Dest/x.md");
      assert.deepEqual(res.structuredContent.files, ["Projects/Dest/x.md"]);
    }
  });

  test("convert-to-action retypes THEN moves (config destination, patch semantics: union arrays, overwrite scalars)", async () => {
    const vault = fakeVault({ [item("x.md")]: { fm: { tags: ["existing"], status: "raw" } } });
    const server = register(vault, { config: { ...DEFAULT_TRIAGE_CONFIG, actionDestination: "Tasks" } });
    const res = await server.tools
      .get("triage_dispose")
      .handler({ path: item("x.md"), disposition: "convert-to-action", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log.map((l) => l.op), ["frontmatter", "move"], "frontmatter first, then the move");
    assert.deepEqual(vault.log[0].fm, {
      tags: ["existing", "note/task"],
      status: "open",
      priority: "normal",
    });
    assert.deepEqual(vault.log[1], { op: "move", from: item("x.md"), to: "Tasks/x.md" });
    assert.equal(res.structuredContent.frontmatter_applied, true);
  });

  test("an explicit target overrides the configured destination", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: { ...DEFAULT_TRIAGE_CONFIG, somedayDestination: "Configured" } });
    const res = await server.tools
      .get("triage_dispose")
      .handler({ path: item("x.md"), disposition: "defer-to-someday", target: "Explicit", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.equal(vault.log.find((l) => l.op === "move").to, "Explicit/x.md");
  });

  test("defer-to-someday stamps status: someday then moves", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: { ...DEFAULT_TRIAGE_CONFIG, somedayDestination: "Someday" } });
    await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "defer-to-someday", dry_run: false });
    assert.deepEqual(vault.log[0], { op: "frontmatter", path: item("x.md"), fm: { status: "someday" } });
    assert.equal(vault.log[1].to, "Someday/x.md");
  });

  test("develop-as-knowledge / archive-as-record are plain moves (no patch)", async () => {
    for (const [disposition, key, dest] of [
      ["develop-as-knowledge", "knowledgeDestination", "Knowledge"],
      ["archive-as-record", "archiveDestination", "Records"],
    ]) {
      const vault = fakeVault({ [item("x.md")]: {} });
      const server = register(vault, { config: { ...DEFAULT_TRIAGE_CONFIG, [key]: dest } });
      const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition, dry_run: false });
      assert.equal(res.isError, undefined);
      assert.deepEqual(vault.log, [{ op: "move", from: item("x.md"), to: `${dest}/x.md` }], `${disposition}`);
    }
  });

  test("escalate flags in place — frontmatter only, the note stays put", async () => {
    const vault = fakeVault({ [item("x.md")]: { fm: { tags: ["attention/user"] } } });
    const server = register(vault);
    const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "escalate", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [
      { op: "frontmatter", path: item("x.md"), fm: { tags: ["attention/user"] } }, // union: no duplicate
    ]);
    assert.equal(res.structuredContent.applied, true);
    assert.ok(!("moved_to" in res.structuredContent));
    assert.deepEqual(res.structuredContent.files, [item("x.md")]);
  });

  test("a move failing AFTER the patch names the partial state instead of hiding it", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    vault.source.move = async () => {
      throw new Error("disk full");
    };
    const server = register(vault, { config: { ...DEFAULT_TRIAGE_CONFIG, actionDestination: "Tasks" } });
    const res = await server.tools
      .get("triage_dispose")
      .handler({ path: item("x.md"), disposition: "convert-to-action", dry_run: false });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.frontmatter_applied, true);
    assert.match(res.structuredContent.error, /frontmatter patch was applied but the move failed/);
  });
});

describe("triage_dispose: scheme integration degrades cleanly", () => {
  test("no schemeExpected seam ⇒ no scheme field, everything else identical", async () => {
    const server = register(fakeVault({ [item("x.md")]: {} }));
    const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "discard" });
    assert.equal(res.isError, undefined);
    assert.ok(!("scheme" in res.structuredContent));
  });

  test("a schemeExpected answer lands as the advisory; a THROWING seam degrades to absent", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, {
      schemeExpected: () => ({ address: "03.10", expected_folder: "00-09 System/03 Agents" }),
    });
    const res = await server.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "discard" });
    assert.deepEqual(res.structuredContent.scheme, { address: "03.10", expected_folder: "00-09 System/03 Agents" });

    const server2 = register(vault, {
      schemeExpected: () => {
        throw new Error("scheme exploded");
      },
    });
    const res2 = await server2.tools.get("triage_dispose").handler({ path: item("x.md"), disposition: "discard" });
    assert.equal(res2.isError, undefined, "a broken scheme seam must not fail the dispose");
    assert.ok(!("scheme" in res2.structuredContent));
  });
});

// ── frontmatter patch semantics (pure) ──────────────────────────────────────

describe("applyFrontmatterPatch", () => {
  test("arrays union (scalar existing promoted), scalars overwrite", () => {
    const fm = { tags: "solo", status: "raw" };
    applyFrontmatterPatch(fm, { tags: ["note/task", "solo"], status: "open", priority: "normal" });
    assert.deepEqual(fm, { tags: ["solo", "note/task"], status: "open", priority: "normal" });
  });
});

// ── module-host conformance ─────────────────────────────────────────────────

describe("module-host conformance", () => {
  const NOTES = [item("x.md")];
  const mountDeps = (settings = {}) => ({
    getSettings: () => ({ ...settings }),
    schemeNotes: () => NOTES,
    vocabSource: { paths: () => NOTES, frontmatter: () => null, body: async () => null },
    skillsSource: {
      notes: async () => [],
      resolveLink: () => null,
      embed: async () => null,
      basePath: () => null,
      frontmatterOf: () => null,
      exists: () => false,
      applyFrontmatter: async () => {},
    },
    provenanceSource: { noteFrontmatter: () => null, read: async () => null, stat: async () => null, glob: async () => [], writeNote: async () => {} },
    healthSource: {
      resolvedLinks: () => ({}),
      unresolvedLinks: () => ({}),
      tags: () => ({}),
      markdownFiles: () => [],
      allFiles: () => [],
      aliases: () => ({}),
      noteBody: async () => null,
    },
    vaultName: "TestVault",
    fileclassPresent: () => false,
    crosssessionSource: { paths: () => [], frontmatter: () => null, read: async () => null, append: async () => {} },
    crosssessionReceipts: memoryReceiptStore(),
    triageSource: fakeVault({ [item("x.md")]: { ctime: 1 } }).source,
  });

  test("default settings: the triage module is DISABLED and contributes nothing", () => {
    const server = fakeServer();
    const registry = mountModules((n, d, h) => server.registerTool(n, d, h), mountDeps());
    assert.ok(!server.tools.has("triage_queue"));
    assert.ok(!server.tools.has("triage_dispose"));
    const desc = registry.describe().find((d) => d.id === "triage");
    assert.equal(desc.enabled, false);
    assert.deepEqual(registry.problems, []);
  });

  test("enabled: both tools mount through the registry with the declared annotations", async () => {
    const server = fakeServer();
    const registry = mountModules(
      (n, d, h) => server.registerTool(n, d, h),
      mountDeps({ modules: { triage: { enabled: true } } }),
    );
    assert.deepEqual(registry.problems, []);
    assert.equal(server.tools.get("triage_queue").def.annotations.readOnlyHint, true);
    assert.equal(server.tools.get("triage_dispose").def.annotations.readOnlyHint, false);
    const desc = registry.describe().find((d) => d.id === "triage");
    assert.deepEqual(desc.tools.sort(), ["triage_dispose", "triage_queue"]);
    // The mounted queue actually answers over the injected source.
    const res = await server.tools.get("triage_queue").handler({});
    assert.equal(res.structuredContent.total, 1);
  });

  test("a config problem is reported loudly through registry.problems", () => {
    const server = fakeServer();
    const registry = mountModules(
      (n, d, h) => server.registerTool(n, d, h),
      mountDeps({ modules: { triage: { enabled: true, config: { actionFrontmatter: "{broken" } } } }),
    );
    assert.ok(registry.problems.some((p) => p.includes("triage") && p.includes("actionFrontmatter")));
  });

  test("scheme ON: the mounted dispose carries the scheme advisory; scheme OFF: it degrades to absent", async () => {
    // An inbox item whose FILENAME carries a JD address — the default JD
    // instance recognizes it, so the wired seam answers with the address.
    const addressed = item("03.42 Misfiled thing.md");
    const withAddressed = () => ({
      ...mountDeps({ modules: { triage: { enabled: true } } }),
      schemeNotes: () => [addressed],
      triageSource: fakeVault({ [addressed]: { ctime: 1 } }).source,
    });

    const on = fakeServer();
    mountModules((n, d, h) => on.registerTool(n, d, h), withAddressed());
    const resOn = await on.tools.get("triage_dispose").handler({ path: addressed, disposition: "discard" });
    assert.equal(resOn.isError, undefined);
    assert.equal(resOn.structuredContent.scheme?.address, "03.42", "the wired seam must report the note's address");

    const off = fakeServer();
    mountModules((n, d, h) => off.registerTool(n, d, h), {
      ...withAddressed(),
      getSettings: () => ({ modules: { triage: { enabled: true }, scheme: { enabled: false } } }),
    });
    const resOff = await off.tools.get("triage_dispose").handler({ path: addressed, disposition: "discard" });
    assert.equal(resOff.isError, undefined);
    assert.ok(!("scheme" in resOff.structuredContent), "scheme disabled ⇒ no advisory, no failure");
  });
});

// ── inventory doc lock (the crosssession precedent for non-obsidian_* names) ─

describe("TOOL-INVENTORY documents the triage surface", () => {
  test("both tool names appear in TOOL-INVENTORY.md", () => {
    const doc = readFileSync(path.join(HERE, "..", "TOOL-INVENTORY.md"), "utf8");
    assert.ok(doc.includes("`triage_queue`"), "TOOL-INVENTORY.md must document triage_queue");
    assert.ok(doc.includes("`triage_dispose`"), "TOOL-INVENTORY.md must document triage_dispose");
  });
});
