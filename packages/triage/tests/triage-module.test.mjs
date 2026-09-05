/**
 * triage-module.test.mjs — the vault-triage satellite's surface (#221 phase 2,
 * PHASE-3 SHAPE per #241 / Nelson's 2026-08-19 ruling), carried over from the
 * host's module suite at the S5 extraction.
 *
 * Everything below runs through `tests/host-shim.mjs`, which reproduces the
 * three things the Governor host does to a published tool: the
 * `<sanitized plugin id>_<bare name>` naming, the ok()/fail() envelopes
 * (including fail()'s `Error [code]: message` rendering), and the annotations
 * it derives from an UNTRUSTED `readOnly` claim. So these tests pin the
 * envelopes an agent actually sees, not just the handlers' return values.
 *
 * What moved OUT of this file at the extraction, and where it went:
 *   • the governance instance's shared-helper equivalence — to the host's
 *     tests/governance-dispositions.test.mjs (it needs the host's DISPOSITIONS
 *     table; the triage half of the same claim stayed here);
 *   • the `queryBaseRows` seam tests — to the host's
 *     tests/bases-module.test.mjs (the seam is host code and did not come with
 *     the module; see the note at the bottom of src/tools.ts);
 *   • the opaque-execution deny-constant pin — to the host's
 *     tests/cli-policy.test.mjs (the constants are host code);
 *   • the module-host conformance block — deleted. There is no module to
 *     mount; its replacement is the publication/settings block at the bottom.
 *
 * Pins:
 *   • the SUBSTRATE EXTRACTION stays invisible from this side — the triage
 *     code-level instance is the THREE built-in primitives (trash / move /
 *     stamp), all `authority: "agent"`, pure frozen data, declared against the
 *     shape published in `@vault-mcp/core`;
 *   • MERGED-TABLE semantics — built-ins ∪ declared rows, the default
 *     escalate declared row (deletable, patch fed by escalateFrontmatter),
 *     built-in description overrides via the shared description field, id
 *     collisions refused loudly (and the colliding row dropped), the tool
 *     enum + description single-sourced from the merged table;
 *   • the three primitives' plan/apply parity with the #238 behavior where
 *     unchanged (dry-run default, typed refusals, occupied/allowlist
 *     re-checks, patch union/overwrite, mid-sequence failure reporting);
 *   • move whitelist/blacklist — enforced at PLAN time and RE-CHECKED at
 *     APPLY time (proven with a config that flips between the two reads);
 *   • declared `choice` rows — executed through the injected runChoice seam,
 *     dry_run REFUSED without an explicit false, target refused, refusal
 *     passthrough, script-throw surfaces as failure, and the deny-set
 *     NON-WEAKENING: the opaque-execution deny constants are untouched and a
 *     raw command id is not a disposition;
 *   • base-backed queues — {base}/{view}, config-named {queue}s, typed
 *     bases_unavailable feature-gate refusal, refusal passthrough, allowlist
 *     row filtering through the shared queryBaseRows seam, marker-queue
 *     fallback unchanged;
 *   • MIGRATION — a config carrying the OLD phase-2 shape behaves sanely;
 *   • the PUBLICATION contract — the two published names, the untrusted
 *     read-only claim, the `target_path` rename that lets the host's guard see
 *     the destination folder, and the one-shot settings adoption from the
 *     host's former `modules.triage.config`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { publishInto, OWNER } from "./host-shim.mjs";
import {
  TRIAGE_DISPOSITIONS,
  TRIAGE_BUILTIN_IDS,
  defaultEscalateRow,
  mergedDispositionsOf,
  mergedIds,
  mergedLines,
  DEFAULT_TRIAGE_CONFIG,
  validateTriageConfig,
  triageConfigOf,
  declaredRowsOf,
  queuesOf,
  inboxFolderOf,
  sortQueue,
  planDispose,
  moveDenied,
  applyFrontmatterPatch,
  gestureGatedIn,
  dispositionsForSurface,
  dispositionByIdIn,
} from "../src/kernel/index.ts";
import { buildTriageTools, emptyTriageSource } from "../src/tools.ts";
import { adoptHostConfig, settingsOf, TRIAGE_FIELDS, ADOPTABLE_KEYS } from "../src/settings.ts";

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
      runChoice: async (binding, variables) => {
        log.push({ op: "choice", binding, variables });
        return { ok: true, choice: binding };
      },
    },
  };
}

/**
 * Build the tool specs over a fake vault and publish them through the host
 * shim. `config` may be given as a plain record for readability; the real ctx
 * takes a THUNK (read per call), so it is wrapped here rather than in every
 * test — the tests that care about per-call freshness pass a function.
 */
function register(vault, ctxOverrides = {}) {
  const { config, ...rest } = ctxOverrides;
  const configThunk =
    typeof config === "function" ? config : () => ({ ...(config ?? DEFAULT_TRIAGE_CONFIG) });
  return publishInto(buildTriageTools(vault.source, { config: configThunk, ...rest }));
}

const item = (name) => `${INBOX}/${name}`;
const errText = (res) => res.content.map((c) => c.text).join("\n");

/** A config record with declared rows / other overrides as JSON strings. */
const withConfig = (over = {}) => ({ ...DEFAULT_TRIAGE_CONFIG, ...over });
const declared = (rows) => JSON.stringify(rows);

// ── the substrate (Part A): extraction invisible, helpers shared ────────────

// The acceptance instance's half of this claim — that it too behaves
// identically through the shared helpers — is pinned in the HOST's
// tests/governance-dispositions.test.mjs. It cannot be pinned here: its table
// is host code. One shape, two suites, no shared build, which is the whole
// point of having published the shape to `@vault-mcp/core` first.
describe("the disposition substrate: the triage instance declared against the published shape", () => {
  test("the triage instance has NOTHING to gesture-gate — no human verb, no pane surface", () => {
    assert.deepEqual(gestureGatedIn(TRIAGE_DISPOSITIONS), []);
    assert.deepEqual(
      dispositionsForSurface(TRIAGE_DISPOSITIONS, "mcp-tool").map((d) => d.id),
      [...TRIAGE_BUILTIN_IDS],
    );
  });

  test("the built-in table is the three primitives — frozen, pure string data, all agent", () => {
    assert.deepEqual([...TRIAGE_BUILTIN_IDS], ["trash", "move", "stamp"]);
    assert.ok(Object.isFrozen(TRIAGE_DISPOSITIONS));
    for (const d of TRIAGE_DISPOSITIONS) {
      assert.ok(Object.isFrozen(d), `${d.id} must be frozen`);
      assert.equal(d.authority, "agent", `${d.id} must be agent-authority`);
      assert.equal(d.surface, "mcp-tool");
      for (const [k, v] of Object.entries(d)) {
        assert.notEqual(typeof v, "function", `${d.id}.${k} must not be a callable`);
        assert.equal(typeof v, "string", `${d.id}.${k} must be plain string data`);
      }
      assert.ok(d.effect.length > 0 && d.label.length > 0);
    }
  });
});

// ── merged-table semantics ──────────────────────────────────────────────────

describe("the merged disposition table (built-ins ∪ declared)", () => {
  test("defaults: three built-ins + the one default declared row, escalate", () => {
    const table = mergedDispositionsOf(triageConfigOf(withConfig()));
    assert.deepEqual(mergedIds(table), ["trash", "move", "stamp", "escalate"]);
    const escalate = table.find((d) => d.id === "escalate");
    assert.equal(escalate.builtin, false);
    assert.equal(escalate.action, "stamp");
    assert.equal(escalate.inPlace, true);
    assert.deepEqual(escalate.patch, { tags: ["attention/user"] });
    assert.equal(escalate.targetPolicy, "none");
  });

  test("the escalate row's patch (its tag) is configured via escalateFrontmatter", () => {
    const cfg = triageConfigOf(withConfig({ escalateFrontmatter: '{"tags": ["attention/nelson"]}' }));
    const table = mergedDispositionsOf(cfg);
    assert.deepEqual(table.find((d) => d.id === "escalate").patch, { tags: ["attention/nelson"] });
  });

  test("the escalate row is DELETABLE: an explicit declared list without it drops it", () => {
    const cfg = triageConfigOf(withConfig({ declaredDispositions: "[]" }));
    assert.deepEqual(mergedIds(mergedDispositionsOf(cfg)), ["trash", "move", "stamp"]);
  });

  test("built-in descriptions are human-overridable via config — the shared description field", () => {
    const cfg = triageConfigOf(
      withConfig({ builtinDescriptions: '{"move": "route the note to its JD scope folder"}' }),
    );
    const table = mergedDispositionsOf(cfg);
    assert.equal(table.find((d) => d.id === "move").description, "route the note to its JD scope folder");
    // Un-overridden built-ins keep their default text.
    assert.match(table.find((d) => d.id === "trash").description, /recoverable/);
    assert.deepEqual(
      validateTriageConfig(withConfig({ builtinDescriptions: '{"explode": "x"}' })).filter((p) => p.includes("explode")).length,
      1,
      "an unknown built-in id is reported loudly",
    );
  });

  test("id collisions are refused LOUDLY — with a built-in, and between declared rows", () => {
    const rows = declared([
      { id: "move", action: "trash", description: "shadow a builtin" },
      { id: "custom", action: "trash", description: "ok" },
      { id: "custom", action: "trash", description: "dupe" },
    ]);
    const problems = validateTriageConfig(withConfig({ declaredDispositions: rows }));
    assert.ok(problems.some((p) => p.includes("'move'") && p.includes("built-in")));
    assert.ok(problems.some((p) => p.includes("'custom'") && p.includes("earlier declared row")));
    // …and the colliding rows are DROPPED from the merged table, never merged.
    const table = mergedDispositionsOf(triageConfigOf(withConfig({ declaredDispositions: rows })));
    assert.deepEqual(mergedIds(table), ["trash", "move", "stamp", "custom"]);
    assert.equal(table.find((d) => d.id === "move").builtin, true, "the built-in must win");
  });

  test("per-action row shapes are validated loudly and bad rows dropped", () => {
    const rows = declared([
      { id: "a", action: "trash", patch: { x: 1 }, description: "trash with patch" },
      { id: "b", action: "stamp", description: "stamp without patch" },
      { id: "c", action: "stamp", inPlace: true, destination: "X", patch: { s: 1 }, description: "contradiction" },
      { id: "d", action: "choice", description: "choice without binding" },
      { id: "e", action: "move", choice: "Nope", description: "move with choice" },
      { id: "ok", action: "move", destination: "Projects", description: "fine" },
    ]);
    const problems = validateTriageConfig(withConfig({ declaredDispositions: rows }));
    for (const [id, needle] of [
      ["a", "takes no patch"],
      ["b", "needs a non-empty patch"],
      ["c", "contradict"],
      ["d", "needs a `choice` binding"],
      ["e", "takes no choice"],
    ]) {
      assert.ok(problems.some((p) => p.includes(`'${id}'`) && p.includes(needle)), `${id}: ${needle}`);
    }
    const table = mergedDispositionsOf(triageConfigOf(withConfig({ declaredDispositions: rows })));
    assert.deepEqual(mergedIds(table), ["trash", "move", "stamp", "ok"]);
  });

  test("a declared patch may never assert acceptance — refused loudly, row dropped", () => {
    const rows = declared([{ id: "x", action: "stamp", patch: { "accepted-by": "me" }, description: "evil" }]);
    const problems = validateTriageConfig(withConfig({ declaredDispositions: rows }));
    assert.ok(problems.some((p) => p.includes("'x'") && p.includes("acceptance")));
    const table = mergedDispositionsOf(triageConfigOf(withConfig({ declaredDispositions: rows })));
    assert.ok(!mergedIds(table).includes("x"));
  });

  test("declared ids are trimmed — ' move' collides with the built-in, not a whitespace sibling", () => {
    const rows = declared([{ id: " move", action: "trash", description: "sneaky" }]);
    const problems = validateTriageConfig(withConfig({ declaredDispositions: rows }));
    assert.ok(problems.some((p) => p.includes("built-in")));
    // The colliding row is dropped; the explicit (now-empty) declared list
    // still replaces the default escalate row, as any explicit list does.
    const table = mergedDispositionsOf(triageConfigOf(withConfig({ declaredDispositions: rows })));
    assert.deepEqual(mergedIds(table), ["trash", "move", "stamp"]);
  });

  test("a blanked escalateFrontmatter makes the default escalate row refuse patch_unresolved — never a silent no-op", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: withConfig({ escalateFrontmatter: "{}" }) });
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "escalate", dry_run: false });
    assert.equal(res.isError, true);
    assert.match(errText(res), /patch_unresolved.*escalateFrontmatter/s);
    assert.deepEqual(vault.log, []);
  });

  test("declaredRowsOf distinguishes UNSET (null ⇒ default escalate) from an explicit []", () => {
    assert.equal(declaredRowsOf("").rows, null);
    assert.equal(declaredRowsOf(undefined).rows, null);
    assert.deepEqual(declaredRowsOf("[]").rows, []);
  });

  test("the tool enum and description are single-sourced from the MERGED table", () => {
    const config = withConfig({
      declaredDispositions: declared([
        { id: "escalate", action: "stamp", patch: { tags: ["attention/user"] }, inPlace: true, description: "flag for the human" },
        { id: "file-bookmark", action: "choice", choice: "File bookmark", description: "run the bookmark filing macro" },
      ]),
    });
    const server = register(fakeVault(), { config });
    const { def } = server.tools.get("vault_triage_dispose");
    const table = mergedDispositionsOf(triageConfigOf(config));
    for (const line of mergedLines(table)) {
      assert.ok(def.description.includes(line), `description must carry: ${line}`);
    }
    const dispositionSchema = def.inputSchema.disposition;
    for (const id of mergedIds(table)) {
      assert.equal(dispositionSchema.safeParse(id).success, true, `enum must accept ${id}`);
    }
    assert.equal(dispositionSchema.safeParse("discard").success, false, "the retired legacy verbs are gone");
    assert.equal(dispositionSchema.safeParse("accept").success, false, "the enum is closed");
    for (const id of mergedIds(table)) {
      assert.ok(!/accept|approve|baseline/i.test(id), `${id} must not be accept-shaped`);
    }
  });

  test("dry_run defaults to TRUE at the schema level (report-first)", () => {
    const server = register(fakeVault());
    assert.equal(server.tools.get("vault_triage_dispose").def.inputSchema.dry_run.parse(undefined), true);
  });
});

// ── config: loud validation, degrade to defaults ────────────────────────────

describe("triage config (phase 3)", () => {
  test("defaults: markers + escalate patch mirror the live conventions; stamp unconfigured; no bounds/queues", () => {
    const cfg = triageConfigOf(withConfig());
    assert.deepEqual(cfg.inboxMarkers, [" Inbox for "]);
    assert.deepEqual(cfg.escalateFrontmatter, { tags: ["attention/user"] });
    assert.deepEqual(cfg.stampFrontmatter, {});
    assert.deepEqual(cfg.moveWhitelist, []);
    assert.deepEqual(cfg.moveBlacklist, []);
    assert.equal(cfg.declared, null);
    assert.deepEqual(cfg.queues, []);
  });

  test("validate is loud about every malformed value", () => {
    const problems = validateTriageConfig({
      inboxMarkers: "not-an-array",
      stampFrontmatter: "{not json",
      escalateFrontmatter: '["array"]',
      moveWhitelist: "nope",
      moveBlacklist: ["/absolute"],
      declaredDispositions: "{not json",
      builtinDescriptions: "[]",
      queues: '[{"id": "q", "base": "not-a-base.md"}]',
    });
    for (const key of [
      "inboxMarkers",
      "stampFrontmatter",
      "escalateFrontmatter",
      "moveWhitelist",
      "moveBlacklist",
      "declaredDispositions",
      "builtinDescriptions",
      "queues",
    ]) {
      assert.ok(problems.some((p) => p.includes(key)), `must report ${key}`);
    }
  });

  test("an empty markers list is refused — with none, nothing is ever an inbox item", () => {
    assert.ok(validateTriageConfig({ inboxMarkers: [] }).some((p) => p.includes("inboxMarkers")));
  });

  test("a config patch asserting acceptance is refused at validation AND sanitized at coercion", () => {
    const problems = validateTriageConfig(withConfig({ escalateFrontmatter: '{"accepted-by": "me"}' }));
    assert.ok(problems.some((p) => p.includes("escalateFrontmatter") && p.includes("acceptance")));
    // Coercion degrades to the CLEAN default — the acceptance field can never
    // reach the default escalate row.
    const cfg = triageConfigOf(withConfig({ escalateFrontmatter: '{"accepted-by": "me"}' }));
    assert.deepEqual(cfg.escalateFrontmatter, { tags: ["attention/user"] });
    // `acceptance-status: proposed` stays agent-legal, like every surface.
    assert.deepEqual(validateTriageConfig(withConfig({ stampFrontmatter: '{"acceptance-status": "proposed"}' })), []);
  });

  test("reserved object-machinery keys are refused loudly and never written", () => {
    const problems = validateTriageConfig(withConfig({ stampFrontmatter: '{"__proto__": {"x": 1}}' }));
    assert.ok(problems.some((p) => p.includes("stampFrontmatter") && p.includes("__proto__")));
    const fm = {};
    applyFrontmatterPatch(fm, JSON.parse('{"__proto__": {"x": 1}, "status": "open"}'));
    assert.deepEqual(fm, { status: "open" });
    assert.equal(Object.getPrototypeOf(fm), Object.prototype);
  });

  test("queues: id-unique {id, base(.base), view?} rows; bad rows reported and dropped", () => {
    const value = JSON.stringify([
      { id: "acceptance", base: "Views/Acceptance.base", view: "queue" },
      { id: "acceptance", base: "Views/Other.base" },
      { id: "debt", base: "Views/Debt.base" },
      { id: "bad", base: "note.md" },
    ]);
    const { queues, problems } = queuesOf(value);
    assert.deepEqual(queues, [
      { id: "acceptance", base: "Views/Acceptance.base", view: "queue" },
      { id: "debt", base: "Views/Debt.base" },
    ]);
    assert.ok(problems.some((p) => p.includes("repeats")));
    assert.ok(problems.some((p) => p.includes("'bad'") && p.includes(".base")));
  });
});

// ── MIGRATION: the OLD phase-2 config shape behaves sanely ──────────────────

describe("migration: a phase-2 config (no declared rows) is sane", () => {
  const OLD = {
    inboxMarkers: [" Inbox for "],
    actionDestination: "Tasks",
    knowledgeDestination: "",
    somedayDestination: "Someday",
    archiveDestination: "",
    actionFrontmatter: '{"tags": ["note/task"], "status": "open", "priority": "normal"}',
    somedayFrontmatter: '{"status": "someday"}',
    escalateFrontmatter: '{"tags": ["attention/custom"]}',
  };

  test("unknown legacy keys are ignored — no validation noise, no crash", () => {
    assert.deepEqual(validateTriageConfig(OLD), []);
  });

  test("the merged table is builtins + escalate, and the legacy escalate patch carries over", () => {
    const table = mergedDispositionsOf(triageConfigOf(OLD));
    assert.deepEqual(mergedIds(table), ["trash", "move", "stamp", "escalate"]);
    assert.deepEqual(table.find((d) => d.id === "escalate").patch, { tags: ["attention/custom"] });
  });

  test("a retired legacy verb refuses unknown_disposition (re-declare it as a row instead)", async () => {
    const server = register(fakeVault({ [item("x.md")]: {} }), { config: OLD });
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "convert-to-action" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /unknown_disposition/);
  });
});

// ── the queue predicate + marker queue (unchanged phase-2 behavior) ─────────

describe("inbox recognition (pure) — unchanged", () => {
  test("any ancestor folder matching a marker qualifies; deepest inbox wins; folder note excluded", () => {
    assert.equal(inboxFolderOf(`${INBOX}/x.md`, [" Inbox for "]), INBOX);
    assert.equal(inboxFolderOf(`${INBOX}/sub/x.md`, [" Inbox for "]), INBOX);
    assert.equal(inboxFolderOf("Projects/x.md", [" Inbox for "]), null);
    assert.equal(inboxFolderOf(`${INBOX}/03.10 Inbox for 03 Agents.md`, [" Inbox for "]), null);
    assert.equal(inboxFolderOf(`${INBOX}/sub/sub.md`, [" Inbox for "]), INBOX);
  });

  test("sortQueue: oldest first, unknown created last, path tiebreak", () => {
    const rows = [
      { path: "b.md", inbox: "i", created: 200, modified: null, type: null, status: null },
      { path: "a.md", inbox: "i", created: null, modified: null, type: null, status: null },
      { path: "c.md", inbox: "i", created: 100, modified: null, type: null, status: null },
    ];
    assert.deepEqual(sortQueue(rows).map((r) => r.path), ["c.md", "b.md", "a.md"]);
  });
});

describe("triage_queue: the marker queue (default) — unchanged", () => {
  const files = {
    [item("old.md")]: { ctime: 1_000, mtime: 2_000, fm: { type: "note", status: "open" } },
    [item("new.md")]: { ctime: 5_000, mtime: 6_000 },
    [`${INBOX}/03.10 Inbox for 03 Agents.md`]: { ctime: 1 },
    "Projects/elsewhere.md": { ctime: 10 },
  };

  test("lists inbox items only, oldest first, with metadata", async () => {
    const server = register(fakeVault(files), { now: () => new Date(86_400_000 * 3) });
    const { def, handler } = server.tools.get("vault_triage_queue");
    // The spec CLAIMS read-only; the host distrusts an external tool's claim,
    // so the registered annotation is false. Pinned properly in the
    // publication block below — here just the claim, so the read-only intent
    // of this tool stays visible where its behaviour is tested.
    assert.equal(def.claimsReadOnly, true);
    assert.equal(def.annotations.readOnlyHint, false);
    const res = await handler({});
    assert.equal(res.isError, undefined);
    const sc = res.structuredContent;
    assert.equal(sc.total, 2);
    assert.deepEqual(sc.notes.map((n) => n.path), [item("old.md"), item("new.md")]);
    assert.equal(sc.notes[0].inbox, INBOX);
    assert.equal(sc.notes[0].age_days, 2);
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
    const server = register({ source: spySource }, {
      config: withConfig(),
      visible: (paths) => paths.filter((p) => p.endsWith("new.md")),
    });
    const res = await server.tools.get("vault_triage_queue").handler({});
    assert.deepEqual(res.structuredContent.notes.map((n) => n.path), [item("new.md")]);
    assert.equal(framed, 1, "hidden notes' frontmatter must never be read");
  });

  test("the cap truncates with the total reported", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("vault_triage_queue").handler({ limit: 1 });
    assert.equal(res.structuredContent.total, 2);
    assert.equal(res.structuredContent.returned, 1);
    assert.equal(res.structuredContent.truncated, true);
  });
});

// ── base-backed queues (#241 point 5) ───────────────────────────────────────

describe("triage_queue: base-backed queues through the shared seam", () => {
  const ROWS = {
    view: "queue",
    viewType: "table",
    columns: ["file.name", "note.status"],
    rows: [
      { path: "A/x.md", values: { "note.status": "open" } },
      { path: "A/y.md", values: { "note.status": "stale" } },
    ],
    total: 2,
    truncated: false,
    someRowsHidden: false,
  };

  const fakeBaseQuery = (calls = []) => async (args) => {
    calls.push(args);
    return { result: { ...ROWS } };
  };

  test("{base} serves the evaluated rows, in the Base's own order", async () => {
    const calls = [];
    const server = register(fakeVault(), { baseQuery: fakeBaseQuery(calls) });
    const res = await server.tools.get("vault_triage_queue").handler({ base: "Views/Stale.base", view: "queue" });
    assert.equal(res.isError, undefined);
    const sc = res.structuredContent;
    assert.equal(sc.base, "Views/Stale.base");
    assert.equal(sc.view, "queue");
    assert.deepEqual(sc.columns, ["file.name", "note.status"]);
    assert.deepEqual(sc.notes.map((n) => n.path), ["A/x.md", "A/y.md"]);
    assert.deepEqual(sc.notes[0].properties, { "note.status": "open" });
    assert.equal(sc.returned, 2);
    assert.deepEqual(calls, [{ path: "Views/Stale.base", view: "queue", limit: 50 }]);
  });

  test("a config-named {queue} resolves to its declared base + view", async () => {
    const calls = [];
    const server = register(fakeVault(), {
      config: withConfig({ queues: JSON.stringify([{ id: "acceptance", base: "Views/Acceptance.base", view: "q" }]) }),
      baseQuery: fakeBaseQuery(calls),
    });
    const res = await server.tools.get("vault_triage_queue").handler({ queue: "acceptance", limit: 10 });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.queue, "acceptance");
    assert.equal(res.structuredContent.base, "Views/Acceptance.base");
    assert.deepEqual(calls, [{ path: "Views/Acceptance.base", view: "q", limit: 10 }]);
  });

  test("typed argument refusals: unknown queue, queue+base conflict, view without base", async () => {
    const server = register(fakeVault(), {
      config: withConfig({ queues: JSON.stringify([{ id: "acceptance", base: "V/A.base" }]) }),
      baseQuery: fakeBaseQuery(),
    });
    const q = server.tools.get("vault_triage_queue").handler;
    assert.match(errText(await q({ queue: "nope" })), /unknown_queue.*acceptance/s);
    assert.match(errText(await q({ queue: "acceptance", base: "V/A.base" })), /invalid_arguments/);
    assert.match(errText(await q({ view: "x" })), /invalid_arguments/);
  });

  test("feature gate: no wired seam ⇒ typed bases_unavailable; the marker queue still works", async () => {
    const server = register(fakeVault({ [item("x.md")]: { ctime: 1 } }));
    const q = server.tools.get("vault_triage_queue").handler;
    const res = await q({ base: "V/A.base" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /bases_unavailable/);
    const markers = await q({});
    assert.equal(markers.isError, undefined);
    assert.equal(markers.structuredContent.total, 1, "the marker queue is unaffected");
  });

  test("seam refusals pass through typed (base_timeout, view_not_found, out_of_allowlist)", async () => {
    for (const code of ["base_timeout", "view_not_found", "out_of_allowlist", "bases_unavailable"]) {
      const server = register(fakeVault(), {
        baseQuery: async () => ({ refusal: { code, message: `msg for ${code}` } }),
      });
      const res = await server.tools.get("vault_triage_queue").handler({ base: "V/A.base" });
      assert.equal(res.isError, true);
      assert.match(errText(res), new RegExp(code));
    }
  });

  test("some_rows_hidden is disclosed only under an active allowlist (the base_query rule)", async () => {
    const hiddenRows = async () => ({ result: { ...ROWS, someRowsHidden: true } });
    const bare = register(fakeVault(), { baseQuery: hiddenRows });
    const res1 = await bare.tools.get("vault_triage_queue").handler({ base: "V/A.base" });
    assert.ok(!("some_rows_hidden" in res1.structuredContent), "no allowlist ⇒ not disclosed");
    const listed = register(fakeVault(), {
      baseQuery: hiddenRows,
      getSettings: () => ({ allowlist: ["A"] }),
    });
    const res2 = await listed.tools.get("vault_triage_queue").handler({ base: "V/A.base" });
    assert.equal(res2.structuredContent.some_rows_hidden, true);
  });
});

// The `queryBaseRows` seam's own tests moved to the HOST's
// tests/bases-module.test.mjs at the S5 extraction: the seam is host code and
// deliberately did not come with the module (a second copy would race the
// host's module-scoped capture serializer over Obsidian's one hidden Bases
// leaf — see the note at the bottom of src/tools.ts). What remains here is
// this side of the contract: with no `baseQuery` wired, the base-backed forms
// refuse typed and the marker queue is unaffected.

// ── triage_dispose: primitives (plan/apply parity with #238 where unchanged) ─

describe("triage_dispose: typed refusals (identical for dry-run and apply)", () => {
  const files = { [item("x.md")]: { ctime: 1 }, "Projects/done.md": {} };

  test("a non-inbox note is refused not_inbox", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("vault_triage_dispose").handler({ path: "Projects/done.md", disposition: "trash" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /not_inbox/);
  });

  test("unknown disposition is refused at runtime too (the enum already blocks it at the schema)", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "explode" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /unknown_disposition/);
  });

  test("built-in move requires a target", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "move" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /target_required/);
  });

  test("trash / stamp / escalate refuse a target — nothing to aim", async () => {
    const server = register(fakeVault(files), {
      config: withConfig({ stampFrontmatter: '{"status": "seen"}' }),
    });
    for (const disposition of ["trash", "stamp", "escalate"]) {
      const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition, target_path: "T" });
      assert.equal(res.isError, true, `${disposition} must refuse`);
      assert.match(errText(res), /target_unsupported/);
    }
  });

  test("built-in stamp with no configured patch refuses patch_unresolved", async () => {
    const server = register(fakeVault(files));
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "stamp" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /patch_unresolved.*stampFrontmatter/s);
  });

  test("an occupied destination is refused — never an overwrite", async () => {
    const vault = fakeVault({ [item("x.md")]: {}, "Projects/x.md": {} });
    const server = register(vault);
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "move", target_path: "Projects", dry_run: false });
    assert.equal(res.isError, true);
    assert.match(errText(res), /destination_occupied/);
    assert.deepEqual(vault.log, [], "nothing may be written");
  });

  test("a computed destination outside the allowlist is refused, dry-run included", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, {
      config: withConfig(),
      visible: (paths) => paths.filter((p) => !p.startsWith("Secret/")),
    });
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "move", target_path: "Secret" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /out_of_allowlist/);
  });

  test("a malformed target is refused (absolute, escaping, whitespace)", async () => {
    const server = register(fakeVault(files));
    for (const target of ["/abs", "a/../b", " padded "]) {
      const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "move", target_path: target });
      assert.equal(res.isError, true, `target ${JSON.stringify(target)} must refuse`);
      assert.match(errText(res), /invalid_target/);
    }
  });

  test("a missing source note is refused not_found", async () => {
    const server = register(fakeVault({}));
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("ghost.md"), disposition: "trash" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /not_found/);
  });
});

describe("triage_dispose: dry-run (the default) reports and writes nothing", () => {
  test("dry-run is the default and reports the exact plan", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault);
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "move", target_path: "Archive/2026" });
    assert.equal(res.isError, undefined);
    const sc = res.structuredContent;
    assert.equal(sc.dry_run, true);
    assert.equal(sc.applied, false);
    assert.equal(sc.plan.action, "move");
    assert.equal(sc.plan.move_to, "Archive/2026/x.md");
    assert.equal(sc.inbox, INBOX);
    assert.deepEqual(vault.log, [], "dry-run writes nothing");
    assert.ok(!("filesChanged" in sc), "dry-run reports no effects");
  });

  test("dry-run for a stamping disposition reports the frontmatter patch", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: withConfig({ stampFrontmatter: '{"status": "seen"}' }) });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "stamp" });
    assert.deepEqual(res.structuredContent.plan.frontmatter_patch, { status: "seen" });
    assert.ok(!("move_to" in res.structuredContent.plan));
    assert.deepEqual(vault.log, []);
  });
});

describe("triage_dispose: apply — the three primitives + declared rows over the fake backend", () => {
  test("trash trashes (never deletes) the note", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault);
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "trash", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [{ op: "trash", path: item("x.md") }]);
    assert.equal(res.structuredContent.trashed, true);
    assert.deepEqual(res.structuredContent.files, [item("x.md")]);
  });

  test("move moves to the target folder and reports the effect at the final path", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault);
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "move", target_path: "Projects/Dest", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [{ op: "move", from: item("x.md"), to: "Projects/Dest/x.md" }]);
    assert.equal(res.structuredContent.moved_to, "Projects/Dest/x.md");
    assert.deepEqual(res.structuredContent.files, ["Projects/Dest/x.md"]);
  });

  test("stamp applies the configured patch in place (union arrays, overwrite scalars)", async () => {
    const vault = fakeVault({ [item("x.md")]: { fm: { tags: ["existing"], status: "raw" } } });
    const server = register(vault, {
      config: withConfig({ stampFrontmatter: '{"tags": ["note/task"], "status": "open"}' }),
    });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "stamp", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [
      { op: "frontmatter", path: item("x.md"), fm: { tags: ["existing", "note/task"], status: "open" } },
    ]);
    assert.ok(!("moved_to" in res.structuredContent));
    assert.deepEqual(res.structuredContent.files, [item("x.md")]);
  });

  test("the default escalate row flags in place — parity with the #238 escalate", async () => {
    const vault = fakeVault({ [item("x.md")]: { fm: { tags: ["attention/user"] } } });
    const server = register(vault);
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "escalate", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [
      { op: "frontmatter", path: item("x.md"), fm: { tags: ["attention/user"] } }, // union: no duplicate
    ]);
    assert.equal(res.structuredContent.applied, true);
    assert.ok(!("moved_to" in res.structuredContent));
  });

  test("a declared stamp row with a destination stamps THEN moves (the re-declared convert-to-action)", async () => {
    const vault = fakeVault({ [item("x.md")]: { fm: { tags: ["existing"] } } });
    const server = register(vault, {
      config: withConfig({
        declaredDispositions: declared([
          {
            id: "convert-to-action",
            action: "stamp",
            destination: "Tasks",
            patch: { tags: ["note/task"], status: "open" },
            description: "retype as a task and file it",
          },
        ]),
      }),
    });
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "convert-to-action", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log.map((l) => l.op), ["frontmatter", "move"], "frontmatter first, then the move");
    assert.deepEqual(vault.log[0].fm, { tags: ["existing", "note/task"], status: "open" });
    assert.deepEqual(vault.log[1], { op: "move", from: item("x.md"), to: "Tasks/x.md" });
    assert.equal(res.structuredContent.frontmatter_applied, true);
    // …and an explicit target overrides the declared destination.
    const vault2 = fakeVault({ [item("y.md")]: {} });
    const server2 = register(vault2, {
      config: withConfig({
        declaredDispositions: declared([
          { id: "c", action: "stamp", destination: "Tasks", patch: { s: 1 }, description: "d" },
        ]),
      }),
    });
    await server2.tools
      .get("vault_triage_dispose")
      .handler({ path: item("y.md"), disposition: "c", target_path: "Explicit", dry_run: false });
    assert.equal(vault2.log.find((l) => l.op === "move").to, "Explicit/y.md");
  });

  test("a declared move row with a destination is a config-or-target move", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, {
      config: withConfig({
        declaredDispositions: declared([
          { id: "archive", action: "move", destination: "Records/2026", description: "file as a record" },
        ]),
      }),
    });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "archive", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [{ op: "move", from: item("x.md"), to: "Records/2026/x.md" }]);
  });

  // The mid-sequence partial failure used to be pinned here, against the
  // module's okError() envelope (ok()'s structure PLUS isError). A published
  // handler cannot produce that shape — it returns or it throws — so the
  // assertion moved to the publication block below, where it pins the typed
  // `dispose_partially_applied` throw and that its message still names exactly
  // what landed. The property is unchanged; only the envelope is.
});

// ── move whitelist/blacklist (#241 point 3) ─────────────────────────────────

describe("move whitelist/blacklist: plan-time enforcement + apply-time re-check", () => {
  test("moveDenied (pure): segment-boundary prefixes, blacklist beats whitelist", () => {
    const cfg = triageConfigOf(withConfig({ moveWhitelist: ["Projects"], moveBlacklist: ["Projects/Frozen"] }));
    assert.equal(moveDenied("Projects/Active", cfg), null);
    assert.equal(moveDenied("Projects", cfg), null);
    assert.match(moveDenied("Projects2", cfg), /outside every configured moveWhitelist/);
    assert.match(moveDenied("Elsewhere", cfg), /outside every configured moveWhitelist/);
    assert.match(moveDenied("Projects/Frozen/sub", cfg), /moveBlacklist/);
    const bare = triageConfigOf(withConfig());
    assert.equal(moveDenied("Anywhere/At/All", bare), null, "default = any destination");
  });

  test("plan-time: a denied destination refuses move_denied, dry-run and apply alike", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: withConfig({ moveWhitelist: ["Projects"] }) });
    for (const dry_run of [undefined, false]) {
      const res = await server.tools
        .get("vault_triage_dispose")
        .handler({ path: item("x.md"), disposition: "move", target_path: "Elsewhere", dry_run });
      assert.equal(res.isError, true);
      assert.match(errText(res), /move_denied/);
    }
    assert.deepEqual(vault.log, []);
    const okRes = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "move", target_path: "Projects/Dest", dry_run: false });
    assert.equal(okRes.isError, undefined);
  });

  test("declared-row destinations are bounded too", async () => {
    const server = register(fakeVault({ [item("x.md")]: {} }), {
      config: withConfig({
        moveBlacklist: ["Records"],
        declaredDispositions: declared([
          { id: "archive", action: "move", destination: "Records/2026", description: "d" },
        ]),
      }),
    });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "archive" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /move_denied/);
  });

  test("APPLY-TIME RE-CHECK: a config that tightens between plan and apply still blocks the move", async () => {
    // The handler reads config once to plan and AGAIN inside the apply branch
    // (the ruling's re-check). Prove the second read is real: a config getter
    // that turns restrictive after the first read must still deny the move.
    const vault = fakeVault({ [item("x.md")]: {} });
    let reads = 0;
    // `config` is a THUNK read per call, so a counting function is enough:
    // first read (plan) permissive, later reads (the apply re-check)
    // blacklisted. The build-time read that snapshots the enum is counted too,
    // so the assertion below is on "at least two", as it always was.
    const server = register(vault, {
      config: () => {
        reads++;
        return reads <= 2 ? withConfig() : withConfig({ moveBlacklist: ["Projects"] });
      },
    });
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "move", target_path: "Projects/Dest", dry_run: false });
    assert.equal(res.isError, true);
    assert.match(errText(res), /move_denied/);
    assert.deepEqual(vault.log, [], "the re-check must fire BEFORE any write");
    assert.ok(reads >= 2, "apply must re-read the config");
  });
});

// ── declared choice rows (#241 point 2) ─────────────────────────────────────

describe("declared choice dispositions: the human-bound macro seam", () => {
  const CHOICE_CONFIG = withConfig({
    declaredDispositions: declared([
      { id: "file-bookmark", action: "choice", choice: "File bookmark", description: "run the bookmark filing macro" },
    ]),
  });

  test("a choice row CANNOT dry-run: the default refuses typed until dry_run: false", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: CHOICE_CONFIG });
    for (const args of [
      { path: item("x.md"), disposition: "file-bookmark" },
      { path: item("x.md"), disposition: "file-bookmark", dry_run: true },
    ]) {
      const res = await server.tools.get("vault_triage_dispose").handler(args);
      assert.equal(res.isError, true);
      assert.match(errText(res), /choice_dry_run_unsupported/);
    }
    assert.deepEqual(vault.log, []);
  });

  test("dry_run: false executes the bound choice through the seam with {path, disposition}", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: CHOICE_CONFIG });
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "file-bookmark", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [
      { op: "choice", binding: "File bookmark", variables: { path: item("x.md"), disposition: "file-bookmark" } },
    ]);
    const sc = res.structuredContent;
    assert.equal(sc.applied, true);
    assert.equal(sc.choice, "File bookmark");
    assert.equal(sc.plan.choice_binding, "File bookmark");
    assert.equal(sc.effects_unknown, true, "a script's effects are unknown to this tool");
    assert.ok(!("filesChanged" in sc), "no effects claim for an opaque script");
  });

  test("a choice row refuses a target, and inbox membership still binds", async () => {
    const server = register(fakeVault({ [item("x.md")]: {}, "Projects/y.md": {} }), { config: CHOICE_CONFIG });
    const withTarget = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "file-bookmark", target_path: "T", dry_run: false });
    assert.match(errText(withTarget), /target_unsupported/);
    const outside = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: "Projects/y.md", disposition: "file-bookmark", dry_run: false });
    assert.match(errText(outside), /not_inbox/);
  });

  test("seam refusals surface typed; a script throw surfaces as an ordinary failure", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    vault.source.runChoice = async () => ({ ok: false, code: "quickadd_unavailable", message: "QuickAdd is gone" });
    const server = register(vault, { config: CHOICE_CONFIG });
    const res = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "file-bookmark", dry_run: false });
    assert.equal(res.isError, true);
    assert.match(errText(res), /quickadd_unavailable/);

    vault.source.runChoice = async () => {
      throw new Error("the macro exploded");
    };
    const res2 = await server.tools
      .get("vault_triage_dispose")
      .handler({ path: item("x.md"), disposition: "file-bookmark", dry_run: false });
    assert.equal(res2.isError, true);
    assert.match(errText(res2), /the macro exploded/);
  });

  test("DENY-SET NON-WEAKENING: a raw command id or bare choice name is not a disposition", async () => {
    // The deny CONSTANTS themselves (OPAQUE_ACCEPT_COMMAND_IDS /
    // OPAQUE_ACCEPT_CLI_COMMANDS) are host code and are pinned exactly in the
    // host's tests/cli-policy.test.mjs — this plugin cannot import them and
    // must not carry a second copy of the list to compare against.
    //
    // What IS this plugin's to prove is that its own surface does not weaken
    // them: the agent-facing surface is the disposition id ONLY, so a QuickAdd
    // command id (or a bare choice NAME, even one a declared row binds) is not
    // in the merged table and refuses. The binding lives in human-only config;
    // an agent can pick from the human's menu and nothing else.
    const server = register(fakeVault({ [item("x.md")]: {} }), { config: CHOICE_CONFIG });
    for (const disposition of ["quickadd:choice:1234", "quickadd:runQuickAdd", "File bookmark"]) {
      const res = await server.tools
        .get("vault_triage_dispose")
        .handler({ path: item("x.md"), disposition, dry_run: false });
      assert.equal(res.isError, true, `${disposition} must refuse`);
      assert.match(errText(res), /unknown_disposition/);
    }
  });

  test("the inert source refuses choice execution typed (no live adapter)", async () => {
    const src = emptyTriageSource();
    const out = await src.runChoice("Anything", {});
    assert.equal(out.ok, false);
    assert.equal(out.code, "quickadd_unavailable");
  });
});

// ── scheme integration degrades cleanly (unchanged) ─────────────────────────

describe("triage_dispose: scheme integration degrades cleanly", () => {
  test("no schemeExpected seam ⇒ no scheme field; a throwing seam degrades to absent", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault);
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "trash" });
    assert.ok(!("scheme" in res.structuredContent));

    const server2 = register(vault, {
      schemeExpected: () => {
        throw new Error("scheme exploded");
      },
    });
    const res2 = await server2.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "trash" });
    assert.equal(res2.isError, undefined);
    assert.ok(!("scheme" in res2.structuredContent));
  });

  test("a schemeExpected answer lands as the advisory", async () => {
    const server = register(fakeVault({ [item("x.md")]: {} }), {
      schemeExpected: () => ({ address: "03.10", expected_folder: "00-09 System/03 Agents" }),
    });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "trash" });
    assert.deepEqual(res.structuredContent.scheme, { address: "03.10", expected_folder: "00-09 System/03 Agents" });
  });
});

// ── acceptance can never land (belt over belt) ──────────────────────────────

describe("acceptance can never reach a note through triage", () => {
  test("an acceptance-carrying stamp config degrades at coercion and refuses patch_unresolved", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: withConfig({ stampFrontmatter: '{"accepted-on": "2026-01-01"}' }) });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "stamp", dry_run: false });
    assert.equal(res.isError, true);
    // The poisoned patch degrades to the default (empty) ⇒ unconfigured stamp.
    assert.match(errText(res), /patch_unresolved/);
    assert.deepEqual(vault.log, [], "the acceptance field must never land");
  });

  test("an acceptance-carrying escalate config degrades to the clean default", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault, { config: withConfig({ escalateFrontmatter: '{"accepted-on": "2026-01-01"}' }) });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "escalate", dry_run: false });
    assert.equal(res.isError, undefined);
    assert.deepEqual(vault.log, [{ op: "frontmatter", path: item("x.md"), fm: { tags: ["attention/user"] } }]);
    assert.ok(!("accepted-on" in vault.state.get(item("x.md")).fm));
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

// ── the default-escalate builder (pure) ─────────────────────────────────────

describe("defaultEscalateRow", () => {
  test("stamp-in-place with the supplied patch", () => {
    const row = defaultEscalateRow({ tags: ["attention/user"] });
    assert.equal(row.id, "escalate");
    assert.equal(row.action, "stamp");
    assert.equal(row.inPlace, true);
    assert.deepEqual(row.patch, { tags: ["attention/user"] });
  });
});


// ── the publication contract (replaces the module-host conformance block) ────
//
// There is no module to mount any more. What takes its place is the contract
// with the Governor host: the names the two tools go on the wire under, the
// flags the host reads off them, and the argument shapes the host's guard can
// see. Each of these was a property the module got for free from the mount and
// now has to be asserted explicitly.

describe("publication: names, flags, and what the host's guard can scope", () => {
  const specs = () => buildTriageTools(emptyTriageSource(), { config: () => ({ ...DEFAULT_TRIAGE_CONFIG }) });

  test("the plugin id sanitizes to `vault_triage`, so the wire names are vault_triage_queue / _dispose", () => {
    assert.equal(OWNER, "vault_triage");
    assert.deepEqual(specs().map((t) => t.name), ["queue", "dispose"]);
    const { tools } = publishInto(specs());
    assert.deepEqual([...tools.keys()], ["vault_triage_queue", "vault_triage_dispose"]);
  });

  test("the queue CLAIMS read-only, and an untrusted claim registers as MUTATING", () => {
    // This is the whole reason the allowlist posture is what it is: the host
    // distrusts an external tool's readOnlyHint unless the raw publisher id is
    // in trustedReadOnlyPlugins, and a mutating tool with no path argument is
    // blocked outright under an allowlist.
    const untrusted = publishInto(specs()).tools;
    assert.equal(untrusted.get("vault_triage_queue").def.claimsReadOnly, true);
    assert.equal(untrusted.get("vault_triage_queue").def.annotations.readOnlyHint, false);
    const trusted = publishInto(specs(), { trusted: true }).tools;
    assert.equal(trusted.get("vault_triage_queue").def.annotations.readOnlyHint, true);
    // dispose never claims read-only, trusted or not.
    assert.equal(trusted.get("vault_triage_dispose").def.annotations.readOnlyHint, false);
  });

  test("dispose's path arguments are BOTH names the host's guard recognizes", () => {
    // The host's PATH_KEYS are ["path", "from", "to", "target_path",
    // "template_path", "subdir", "file_path", "output_folder"]. `path` was
    // always recognized; the destination folder was `target`, which is NOT,
    // and the module compensated with its own in-handler visibility check over
    // the computed destination. A satellite cannot reach the host's guard
    // settings, so the argument was renamed at this extraction to one the host
    // can see — the to_address / displace_to_address precedent.
    const HOST_PATH_KEYS = ["path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder"];
    const dispose = specs().find((t) => t.name === "dispose");
    const args = Object.keys(dispose.inputSchema);
    assert.ok(args.includes("path"), "the note path must stay `path`");
    assert.ok(args.includes("target_path"), "the destination folder must be a guard-recognized path key");
    assert.ok(!args.includes("target"), "`target` is invisible to the host's guard and must not come back");
    for (const key of ["path", "target_path"]) assert.ok(HOST_PATH_KEYS.includes(key));
  });

  test("the queue carries NO guard-recognized path key — under an allowlist the host blocks it wholesale", () => {
    // Stated as a pin rather than left implicit: `base`/`view`/`queue` are not
    // path keys, and the marker queue takes no path at all. That is fail-closed
    // and strictly stricter than the in-tool filter it replaces.
    const HOST_PATH_KEYS = ["path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder"];
    const queue = specs().find((t) => t.name === "queue");
    for (const key of Object.keys(queue.inputSchema)) {
      assert.ok(!HOST_PATH_KEYS.includes(key), `${key} would make the queue scopable — revisit the README's posture`);
    }
  });

  test("refusals throw with a lowercase-snake code, which the host renders as `Error [code]: message`", async () => {
    const server = register(fakeVault({}));
    const res = await server.tools.get("vault_triage_dispose").handler({ path: "Nowhere/x.md", disposition: "trash" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[not_inbox\]: /);
  });

  test("the limit bound is re-applied in the HANDLER, because the schema's does not survive the boundary", async () => {
    // The SDK converts zod to JSON Schema and the host converts it back through
    // a small subset: type, description and string enums survive; min, max,
    // default and pattern do not. So a `limit` of 10_000 reaches the handler
    // and must be clamped there. This is the vault_skills_release semver lesson.
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [item(`n${i}.md`), { ctime: i }]),
    );
    const server = register(fakeVault(files));
    const huge = await server.tools.get("vault_triage_queue").handler({ limit: 10_000 });
    assert.equal(huge.structuredContent.returned, 5, "a limit above the cap must not throw");
    const zero = await server.tools.get("vault_triage_queue").handler({ limit: 0 });
    assert.equal(zero.structuredContent.returned, 1, "a limit below the floor clamps to the minimum of 1");
    assert.equal(zero.structuredContent.total, 5, "the total is still reported honestly");
    assert.equal(zero.structuredContent.truncated, true);
  });

  test("the dry_run default is re-applied in the HANDLER for the same reason", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    const server = register(vault);
    // No dry_run key at all — the schema default never ran.
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "trash" });
    assert.equal(res.structuredContent.dry_run, true);
    assert.equal(res.structuredContent.applied, false);
    assert.deepEqual(vault.log, [], "an absent dry_run must never mean 'apply'");
  });

  test("a mid-sequence partial failure THROWS and names what already landed", async () => {
    // The module returned okError() — ok()'s structure plus isError. A published
    // handler can only return or throw, and reporting a partial write as a plain
    // success is the worse of the two, so it throws a typed
    // `dispose_partially_applied` carrying the facts in the message.
    const vault = fakeVault({ [item("x.md")]: {} });
    vault.source.move = async () => {
      throw new Error("disk full");
    };
    const server = register(vault, {
      config: withConfig({
        declaredDispositions: declared([
          { id: "c", action: "stamp", destination: "Tasks", patch: { s: 1 }, description: "d" },
        ]),
      }),
    });
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "c", dry_run: false });
    assert.equal(res.isError, true);
    const text = errText(res);
    assert.match(text, /^Error \[dispose_partially_applied\]: /);
    assert.match(text, /PARTIALLY APPLIED/);
    assert.match(text, /frontmatter patch .* was written/);
    assert.match(text, /disk full/);
    assert.match(text, new RegExp(item("x.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("a failure BEFORE any write says nothing landed", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    vault.source.trashNote = async () => {
      throw new Error("trash is full");
    };
    const server = register(vault);
    const res = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "trash", dry_run: false });
    assert.match(errText(res), /^Error \[dispose_failed\]: the trash failed and nothing was written: trash is full/);
  });

  test("config is read PER CALL, so a settings change lands without a reload", async () => {
    const vault = fakeVault({ [item("x.md")]: {} });
    let patch = '{"status": "seen"}';
    const server = register(vault, { config: () => withConfig({ stampFrontmatter: patch }) });
    const first = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "stamp" });
    assert.deepEqual(first.structuredContent.plan.frontmatter_patch, { status: "seen" });
    patch = '{"status": "triaged"}';
    const second = await server.tools.get("vault_triage_dispose").handler({ path: item("x.md"), disposition: "stamp" });
    assert.deepEqual(second.structuredContent.plan.frontmatter_patch, { status: "triaged" });
  });
});

// ── one-shot settings adoption from the host's modules.triage.config ─────────

describe("settings adoption (pure)", () => {
  const HOST = (config) => ({ modules: { triage: { enabled: false, config } } });

  test("adopts the recognized keys once and latches", () => {
    const out = adoptHostConfig(
      { config: {}, adoptedFromHost: false },
      HOST({ inboxMarkers: [" Inbox for "], moveBlacklist: ["Records"] }),
    );
    assert.deepEqual(out.config, { inboxMarkers: [" Inbox for "], moveBlacklist: ["Records"] });
    assert.equal(out.adoptedFromHost, true);
    assert.equal(adoptHostConfig(out, HOST({ inboxMarkers: ["changed"] })), null, "the latch is one-shot");
  });

  test("the satellite's OWN values win; adoption only fills gaps", () => {
    const out = adoptHostConfig(
      { config: { moveBlacklist: ["Mine"] }, adoptedFromHost: false },
      HOST({ moveBlacklist: ["Theirs"], moveWhitelist: ["Projects"] }),
    );
    assert.deepEqual(out.config, { moveBlacklist: ["Mine"], moveWhitelist: ["Projects"] });
  });

  test("an unrecognized host key is NOT copied", () => {
    const out = adoptHostConfig({ config: {}, adoptedFromHost: false }, HOST({ notAField: 1, moveWhitelist: ["P"] }));
    assert.deepEqual(out.config, { moveWhitelist: ["P"] });
    assert.deepEqual([...ADOPTABLE_KEYS].sort(), Object.keys(DEFAULT_TRIAGE_CONFIG).sort());
  });

  test("an ABSENT host adopts nothing and does NOT latch — the one chance survives", () => {
    assert.equal(adoptHostConfig({ config: {}, adoptedFromHost: false }, undefined), null);
    assert.equal(adoptHostConfig({ config: {}, adoptedFromHost: false }, null), null);
  });

  test("a host present with NO triage config still latches — the question was asked and answered", () => {
    const out = adoptHostConfig({ config: {}, adoptedFromHost: false }, { modules: {} });
    assert.deepEqual(out.config, {});
    assert.equal(out.adoptedFromHost, true);
  });

  test("settingsOf coerces a corrupt or hand-edited data.json to the defaults", () => {
    assert.deepEqual(settingsOf(null), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf([1, 2]), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf({ config: "nope", adoptedFromHost: "yes" }), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf({ config: { moveWhitelist: ["P"] }, adoptedFromHost: true }), {
      config: { moveWhitelist: ["P"] },
      adoptedFromHost: true,
    });
  });

  test("the settings-tab fields are the host manifest's eight keys, in order", () => {
    assert.deepEqual(TRIAGE_FIELDS.map((f) => f.key), [
      "inboxMarkers",
      "stampFrontmatter",
      "escalateFrontmatter",
      "moveWhitelist",
      "moveBlacklist",
      "declaredDispositions",
      "builtinDescriptions",
      "queues",
    ]);
    for (const f of TRIAGE_FIELDS) {
      assert.ok(f.label && f.help, `${f.key} must carry its label and help text`);
      assert.ok(["text", "lines"].includes(f.type));
    }
  });
});
