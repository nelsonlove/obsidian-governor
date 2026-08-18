/**
 * governance-submit-revision.test.mjs — the ONE agent-expressible disposition
 * (#101): `governance_submit_revision`.
 *
 * Fake-server pattern (tools-pending-review.test.mjs) for the handler, PLUS
 * the real makeGuarded wrapper + a real Kernel (change-intent.test.mjs
 * harness) for the interception-point properties — so read-only mode, the
 * path allowlist, the queue and the journal are proven at the exact wrapper a
 * live client goes through.
 *
 * The acceptance perimeter, pinned from every direction it could regress:
 *   • happy path: revising → proposed + [!revision-request] removed +
 *     [!revision-report] inserted + journal record (intent carried);
 *   • not-revising refusal (typed), not-found, non-md path — nothing written;
 *   • accepted-family can NEVER ride through: a hostile summary lands quoted
 *     in the body (never as frontmatter), and the shared accept guard
 *     re-checks the (before, after) transition — the refusing branch is
 *     driven directly via revisionWriteRefusalReason;
 *   • unclassifiable frontmatter fails CLOSED (no write);
 *   • read-only mode + allowlist scoping refuse at the guard.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { fakeServer } from "./fake-server.mjs";
import {
  registerGovernanceRevisionTool,
  revisionWriteRefusalReason,
  acceptanceStatusOf,
} from "../src/mcp/tools-governance-revision.ts";
import { SUBMIT_REVISION_TOOL } from "../src/kernel/governance/dispositions.ts";
import { parseGuardFrontmatter } from "@vault-mcp/core";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } from "../src/kernel/index.ts";

const NOW = new Date("2026-08-18T12:00:00Z");
const REVISING =
  "---\nacceptance-status: revising\nuid: abc\n---\n" +
  "# Note\n\n> [!revision-request] Requested changes (2026-08-17)\n> tighten the intro\n\nBody text\n";

/** In-memory note store standing in for the vault. */
function toolServer(files = {}) {
  const notes = new Map(Object.entries(files));
  const writes = [];
  const server = fakeServer();
  registerGovernanceRevisionTool(server, {
    read: async (p) => notes.get(p) ?? null,
    write: async (p, content) => {
      writes.push([p, content]);
      notes.set(p, content);
    },
    now: () => NOW,
  });
  const call = (args) => server.tools.get(SUBMIT_REVISION_TOOL).handler(args, {});
  return { server, call, notes, writes };
}

// ── registration shape ────────────────────────────────────────────────────────

describe("registration shape", () => {
  test("registers exactly governance_submit_revision, MUTATING (readOnlyHint: false)", () => {
    const { server } = toolServer();
    assert.deepEqual([...server.tools.keys()], [SUBMIT_REVISION_TOOL]);
    const { def } = server.tools.get(SUBMIT_REVISION_TOOL);
    assert.equal(def.annotations.readOnlyHint, false, "must be mutating so the whole kernel perimeter binds");
    assert.equal(def.annotations.destructiveHint, false);
  });

  test("the description documents the agents' contract: feedback lives in the NOTE BODY, not frontmatter", () => {
    const { server } = toolServer();
    const desc = server.tools.get(SUBMIT_REVISION_TOOL).def.description;
    assert.match(desc, /NOTE BODY/);
    assert.match(desc, /\[!revision-request\]/);
    assert.match(desc, /no\s+.?requested-changes.?\s+property/i);
    assert.match(desc, /cannot accept/i);
    assert.match(desc, /not_revising/);
    assert.match(desc, /proposed/);
  });

  test("args are path + optional summary only (kernel args arrive via withKernelArgs, not here)", () => {
    const { server } = toolServer();
    assert.deepEqual(Object.keys(server.tools.get(SUBMIT_REVISION_TOOL).def.inputSchema).sort(), ["path", "summary"]);
  });
});

// ── happy path ────────────────────────────────────────────────────────────────

describe("happy path: revising → proposed + callout swap", () => {
  test("status flips, request callout removed, report inserted with the run-clock date", async () => {
    const { call, notes, writes } = toolServer({ "Projects/note.md": REVISING });
    const res = await call({ path: "Projects/note.md", summary: "tightened the intro" });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.equal(writes.length, 1);
    const after = notes.get("Projects/note.md");
    assert.equal(
      after,
      "---\nacceptance-status: proposed\nuid: abc\n---\n" +
        "# Note\n\n> [!revision-report] Revision report (2026-08-18)\n> tightened the intro\n\nBody text\n",
    );
    assert.deepEqual(res.structuredContent, {
      path: "Projects/note.md",
      acceptance_status: "proposed",
      removed_requests: 1,
      report_inserted: true,
      filesChanged: 1,
      files: ["Projects/note.md"],
    });
  });

  test("no summary: resubmits without a report callout", async () => {
    const { call, notes } = toolServer({ "n.md": REVISING });
    const res = await call({ path: "n.md" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.report_inserted, false);
    assert.ok(!notes.get("n.md").includes("[!revision-report]"));
    assert.ok(!notes.get("n.md").includes("[!revision-request]"));
    assert.match(notes.get("n.md"), /acceptance-status: proposed/);
  });
});

// ── refusals (typed, nothing written) ────────────────────────────────────────

describe("refusals — typed, and the note is never written", () => {
  test("not_revising: a proposed note has nothing to submit", async () => {
    const { call, writes } = toolServer({ "n.md": "---\nacceptance-status: proposed\n---\nbody" });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_revising\]/);
    assert.match(res.content[0].text, /'proposed'/);
    assert.equal(writes.length, 0);
  });

  test("not_revising: a note with no acceptance-status at all", async () => {
    const { call, writes } = toolServer({ "n.md": "---\ntitle: x\n---\nbody" });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_revising\]/);
    assert.match(res.content[0].text, /\(none\)/);
    assert.equal(writes.length, 0);
  });

  test("not_revising: a note with no frontmatter", async () => {
    const { call, writes } = toolServer({ "n.md": "just a body" });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_revising\]/);
    assert.equal(writes.length, 0);
  });

  test("not_found: no note at the path", async () => {
    const { call, writes } = toolServer({});
    const res = await call({ path: "missing.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_found\]/);
    assert.equal(writes.length, 0);
  });

  test("invalid_path: not a markdown note", async () => {
    const { call, writes } = toolServer({});
    const res = await call({ path: "file.txt" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[invalid_path\]/);
    assert.equal(writes.length, 0);
  });

  test("unclassifiable frontmatter fails CLOSED (accept_forbidden), nothing written", async () => {
    // A YAML anchor needs a document model the guard reader refuses to guess at.
    const { call, writes } = toolServer({
      "n.md": "---\nacceptance-status: revising\nweird: &anchor x\n---\nbody",
    });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[accept_forbidden\]/);
    assert.equal(writes.length, 0);
  });
});

// ── the accept perimeter: accepted-family can never ride through ─────────────

describe("accepted-family payloads cannot ride through the tool", () => {
  test("a hostile summary lands QUOTED in the body — never as frontmatter, no acceptance assertion", async () => {
    const hostile = "done!\n---\naccepted-by: attacker\nacceptance-status: accepted\n---\naccepted: yes";
    const { call, notes } = toolServer({ "n.md": REVISING });
    const res = await call({ path: "n.md", summary: hostile });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    const after = notes.get("n.md");
    // Every summary line is `> `-quoted, so none can open a fence or become a property.
    assert.match(after, /> ---/);
    assert.match(after, /> accepted-by: attacker/);
    const fm = parseGuardFrontmatter(after);
    assert.deepEqual(Object.keys(fm).sort(), ["acceptance-status", "uid"]);
    assert.equal(fm["acceptance-status"], "proposed");
    // And the shared guard agrees the written transition was clean.
    assert.equal(revisionWriteRefusalReason(REVISING, after), null);
  });

  test("the guard hook REFUSES an accepted-family after-state (introduced field)", () => {
    const after = "---\nacceptance-status: proposed\naccepted-by: agent\n---\nbody";
    const reason = revisionWriteRefusalReason(REVISING, after);
    assert.match(reason, /accepted-by/);
  });

  test("the guard hook REFUSES acceptance-status set to an accepted value", () => {
    const after = "---\nacceptance-status: accepted\n---\nbody";
    const reason = revisionWriteRefusalReason(REVISING, after);
    assert.match(reason, /accepted/);
  });

  test("the guard hook ALLOWS the revising → proposed transition (the tool's own write)", () => {
    assert.equal(
      revisionWriteRefusalReason(REVISING, "---\nacceptance-status: proposed\nuid: abc\n---\nbody"),
      null,
    );
  });

  test("the guard hook ALLOWS a pre-existing human-granted accepted-by carried forward UNCHANGED", () => {
    const before = "---\nacceptance-status: revising\naccepted-by: nelson\n---\nbody";
    const after = "---\nacceptance-status: proposed\naccepted-by: nelson\n---\nbody";
    assert.equal(revisionWriteRefusalReason(before, after), null);
  });

  test("the guard hook fails CLOSED on an unclassifiable after-state", () => {
    const after = "---\nacceptance-status: proposed\n\tweird: tab-indent\n---\nbody";
    assert.notEqual(revisionWriteRefusalReason(REVISING, after), null);
  });

  test("the handler actually calls the guard hook before writing (source tripwire)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "..", "src", "mcp", "tools-governance-revision.ts"), "utf8");
    const handlerBody = src.slice(src.indexOf("async ({ path, summary }"));
    assert.match(handlerBody, /revisionWriteRefusalReason\(before, plan\.content\)/);
    assert.ok(
      handlerBody.indexOf("revisionWriteRefusalReason") < handlerBody.indexOf("source.write"),
      "the guard check must run BEFORE the write",
    );
  });
});

// ── acceptanceStatusOf ───────────────────────────────────────────────────────

describe("acceptanceStatusOf — key spelling tolerance", () => {
  test("hyphen, underscore, case variants; non-string values read as null", () => {
    assert.equal(acceptanceStatusOf({ "acceptance-status": "revising" }), "revising");
    assert.equal(acceptanceStatusOf({ acceptance_status: " revising " }), "revising");
    assert.equal(acceptanceStatusOf({ "Acceptance-Status": "proposed" }), "proposed");
    assert.equal(acceptanceStatusOf({ "acceptance-status": ["revising"] }), null);
    assert.equal(acceptanceStatusOf({ other: "x" }), null);
    assert.equal(acceptanceStatusOf(null), null);
  });
});

// ── through the REAL guard wrapper + kernel ──────────────────────────────────

const ACTOR = { transport: "mcp", client: "test-client/1.0.0", connection: "conn-1" };

function fakeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async write(p, d) { files.set(p, d); },
    async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
  };
}

function journalRecords(adapter) {
  const out = [];
  for (const [p, data] of adapter.files) {
    if (!p.endsWith(".jsonl")) continue;
    out.push(...data.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
}

function guardedHarness({ settings = { readOnly: false, allowlist: [] }, files = {} } = {}) {
  const { server, notes, writes } = (() => {
    const notes = new Map(Object.entries(files));
    const writes = [];
    const server = fakeServer();
    registerGovernanceRevisionTool(server, {
      read: async (p) => notes.get(p) ?? null,
      write: async (p, content) => { writes.push([p, content]); notes.set(p, content); },
      now: () => NOW,
    });
    return { server, notes, writes };
  })();
  const adapter = fakeAdapter();
  const kernel = new Kernel(
    new WriteQueue(1000),
    new WriteJournal(adapter, "dir/journal"),
    null,
    new IdempotencyStore(),
    new LockStore(),
  );
  const { def, handler } = server.tools.get(SUBMIT_REVISION_TOOL);
  const guarded = makeGuarded({ getSettings: () => settings, kernel, actor: () => ACTOR })(
    def,
    handler,
    SUBMIT_REVISION_TOOL,
  );
  return { call: (args) => guarded(args, {}), notes, writes, adapter };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("through the REAL makeGuarded wrapper (read-only mode / allowlist / journal)", () => {
  test("read-only mode refuses at the guard — the handler and the note are never touched", async () => {
    const { call, writes } = guardedHarness({
      settings: { readOnly: true, allowlist: [] },
      files: { "Projects/n.md": REVISING },
    });
    const res = await call({ path: "Projects/n.md", summary: "x" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[read_only\]/);
    assert.equal(writes.length, 0);
  });

  test("allowlist scoping: a path outside the allowlist refuses out_of_allowlist, no write", async () => {
    const { call, writes } = guardedHarness({
      settings: { readOnly: false, allowlist: ["Projects"] },
      files: { "Archive/n.md": REVISING },
    });
    const res = await call({ path: "Archive/n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.equal(writes.length, 0);
  });

  test("allowlist scoping: a path INSIDE the allowlist proceeds", async () => {
    const { call, writes } = guardedHarness({
      settings: { readOnly: false, allowlist: ["Projects"] },
      files: { "Projects/n.md": REVISING },
    });
    const res = await call({ path: "Projects/n.md" });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.equal(writes.length, 1);
  });

  test("the write journals like any mutating op — op, target, outcome ok, intent carried", async () => {
    const { call, adapter } = guardedHarness({ files: { "Projects/n.md": REVISING } });
    const res = await call({ path: "Projects/n.md", summary: "reworked", intent: "addressing the revision request" });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    await flush();
    const [rec] = journalRecords(adapter);
    assert.ok(rec, "a journal record must exist");
    assert.equal(rec.op, SUBMIT_REVISION_TOOL);
    assert.equal(rec.outcome, "ok");
    assert.equal(rec.target.path, "Projects/n.md");
    assert.equal(rec.intent, "addressing the revision request");
    // The effects convention: the record names what actually changed.
    assert.deepEqual(rec.effects, { filesChanged: 1, paths: ["Projects/n.md"] });
  });

  test("a refused call (not_revising) still journals with outcome ok=false side: isError result", async () => {
    // Typed tool-level refusals RETURN an isError envelope (they are not guard throws), so the
    // kernel journals the operation with its error outcome semantics for returned envelopes:
    // the record exists and the note was never written.
    const { call, writes, adapter } = guardedHarness({
      files: { "Projects/n.md": "---\nacceptance-status: proposed\n---\nbody" },
    });
    const res = await call({ path: "Projects/n.md" });
    assert.equal(res.isError, true);
    assert.equal(writes.length, 0);
    await flush();
    const [rec] = journalRecords(adapter);
    assert.ok(rec, "the refused mutating call still lands one journal record");
    assert.equal(rec.op, SUBMIT_REVISION_TOOL);
  });

  test("kernel args are declared on the registered schema via the interception point", async () => {
    // withKernelArgs is applied by server.ts's patched registerTool; here we assert the def is
    // mutating so that patch WILL declare if_rev/idempotency_key/intent on it — and that the
    // wrapper peels intent (the handler saw only path/summary; proven by the record above).
    const { withKernelArgs } = await import("../src/mcp/guarded.ts");
    const server = fakeServer();
    registerGovernanceRevisionTool(server, { read: async () => null, write: async () => {}, now: () => NOW });
    const def = withKernelArgs(server.tools.get(SUBMIT_REVISION_TOOL).def);
    for (const k of ["if_rev", "idempotency_key", "intent"]) {
      assert.ok(def.inputSchema[k], `kernel arg ${k} must be declared on the mutating schema`);
    }
    assert.ok(def.inputSchema.path instanceof z.ZodType);
  });
});
