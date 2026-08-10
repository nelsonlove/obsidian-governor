/**
 * write-notes.test.mjs — obsidian_write_notes end-to-end through the REAL kernel
 * (slice B1). The dispatcher is driven with a real Kernel (write queue + journal
 * + if_rev + idempotency) and a fake in-memory vault, so these assertions prove
 * the invariants against the actual machinery, not a re-implementation:
 *
 *   • per-item journal records (Stewardship sees each note individually)
 *   • an if_rev conflict on one item leaves the others untouched
 *   • idempotency dedupe replays instead of re-writing
 *   • stamp mints uid/created/modified + default proposed, end-to-end on disk
 *   • the accept-forbidden guard rejects an item WITHOUT dispatching (no record)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ok } from "../src/mcp/helpers.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } from "../src/kernel/index.ts";
import { registerWriteNotesTool } from "../src/mcp/tools-write-notes.ts";
import { parseYaml } from "./obsidian-stub.mjs";

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "conn-1" };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const fakeYaml = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

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

/**
 * A harness: a real Kernel over a fake vault (path → {content, rev}) whose rev
 * is a monotonic clock bumped on each write, plus the guarded single-writer and
 * the registered obsidian_write_notes handler.
 */
function harness({ existing = new Map() } = {}) {
  const vault = new Map();        // path -> { content, rev }
  const existingFm = new Map();   // path -> parsed frontmatter (metadata cache stand-in)
  let clock = 100;
  for (const [path, { rev, content, frontmatter }] of existing) {
    vault.set(path, { content: content ?? "", rev });
    if (frontmatter) existingFm.set(path, frontmatter);
    clock = Math.max(clock, rev);
  }

  const writeCalls = [];
  function writeNote(path, content, overwrite) {
    writeCalls.push(path);
    const existed = vault.has(path);
    if (existed && !overwrite) throw new Error(`exists: ${path}`);
    clock += 1;
    vault.set(path, { content, rev: clock });
    return { path, created: !existed };
  }

  const probe = { uid: () => undefined, rev: (path) => vault.get(path)?.rev };
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
  const kernel = new Kernel(new WriteQueue(1000), journal, probe, new IdempotencyStore(), new LockStore());
  const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
  const guardedWrite = guarded(
    { annotations: RW, inputSchema: {} },
    async ({ path, content, overwrite }) => ok(writeNote(path, content, overwrite ?? true)),
    "obsidian_write_notes"
  );

  let handler;
  registerWriteNotesTool((_name, _def, h) => { handler = h; }, guardedWrite, {
    readExistingFrontmatter: (path) => existingFm.get(path),
    revOf: (path) => vault.get(path)?.rev,
    stringifyYaml: fakeYaml,
    parseYaml,
    mintUid: (ms) => `uid-${ms}`,
    formatTs: (ms) => `TS(${ms})`,
    now: () => 42,
  });

  const records = () => (adapter.files.get("dir/journal/2026-08.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const call = (args) => handler(args, {});
  return { call, vault, records, writeCalls, kernel };
}

const structured = (res) => JSON.parse(res.content[0].text);

describe("obsidian_write_notes — batch happy path", () => {
  test("writes every item and journals one record per note", async () => {
    const { call, vault, records } = harness();
    const res = await call({
      notes: [
        { path: "Inbox/A.md", frontmatter: { name: "A" }, body: "aaa" },
        { path: "Inbox/B.md", frontmatter: { name: "B" }, body: "bbb" },
        { path: "Inbox/C.md", body: "ccc" },
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.count, 3);
    assert.equal(body.error_count, 0);
    assert.equal(res.isError, undefined);
    assert.deepEqual(body.written.map((w) => w.path), ["Inbox/A.md", "Inbox/B.md", "Inbox/C.md"]);
    for (const w of body.written) {
      assert.equal(w.created, true);
      assert.equal(typeof w.rev, "number", "each written item reports its post-write rev");
    }
    assert.equal(vault.get("Inbox/A.md").content, `---\nname: "A"\n---\naaa`);

    await tick();
    const recs = records();
    assert.equal(recs.length, 3, "each note gets its OWN journal record");
    assert.ok(recs.every((r) => r.op === "obsidian_write_notes"));
    assert.deepEqual(recs.map((r) => r.target.path).sort(), ["Inbox/A.md", "Inbox/B.md", "Inbox/C.md"]);
    assert.ok(recs.every((r) => r.outcome === "ok"));
  });
});

describe("obsidian_write_notes — if_rev conflict isolates to one item", () => {
  test("a stale if_rev fails only its item; the rest still write and journal", async () => {
    const existing = new Map([["Notes/X.md", { rev: 100, content: "old" }]]);
    const { call, vault, records } = harness({ existing });
    const res = await call({
      notes: [
        { path: "Notes/X.md", frontmatter: { name: "X" }, body: "new", if_rev: 999 }, // stale → conflict
        { path: "Notes/Y.md", frontmatter: { name: "Y" }, body: "yyy" },              // unaffected
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.count, 1);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].path, "Notes/X.md");
    assert.equal(body.errors[0].code, "rev_conflict");
    assert.equal(vault.get("Notes/X.md").content, "old", "the conflicting note must be untouched");
    assert.equal(body.written[0].path, "Notes/Y.md");
    assert.equal(vault.get("Notes/Y.md").content, `---\nname: "Y"\n---\nyyy`);

    await tick();
    const recs = records();
    const x = recs.find((r) => r.target.path === "Notes/X.md");
    const y = recs.find((r) => r.target.path === "Notes/Y.md");
    assert.equal(x.outcome, "conflict", "the stale item is journaled as a conflict");
    assert.equal(y.outcome, "ok");
  });
});

describe("obsidian_write_notes — idempotency dedupe", () => {
  test("a repeat call with the same key replays instead of writing again", async () => {
    const { call, vault, records, writeCalls } = harness();
    const item = { path: "Once/N.md", frontmatter: { name: "N" }, body: "v1", idempotency_key: "K1" };

    const first = structured(await call({ notes: [item], stamp: false }));
    assert.equal(first.count, 1);
    const revAfterFirst = vault.get("Once/N.md").rev;

    const second = structured(await call({ notes: [item], stamp: false }));
    assert.equal(second.count, 1, "the replay still reports success");
    assert.equal(vault.get("Once/N.md").rev, revAfterFirst, "the note must not be re-written");
    assert.equal(writeCalls.filter((p) => p === "Once/N.md").length, 1, "the underlying write ran exactly once");

    await tick();
    const recs = records();
    const deduped = recs.filter((r) => r.outcome === "deduped");
    assert.equal(deduped.length, 1, "the replay is journaled as deduped");
    assert.ok(deduped[0].dedupeOf, "the deduped record names the original it replayed");
  });
});

describe("obsidian_write_notes — stamp end-to-end", () => {
  test("stamp mints uid + created/modified + default proposed and orders the block", async () => {
    const { call, vault, records } = harness();
    const res = await call({
      notes: [{ path: "Stamp/S.md", frontmatter: { name: "S" }, body: "hi" }],
      stamp: true,
    });
    const body = structured(res);
    assert.equal(body.count, 1);
    assert.equal(body.stamped, true);
    assert.equal(body.written[0].stamped, true);

    const content = vault.get("Stamp/S.md").content;
    // canonical order: name, uid, created, modified, acceptance-status
    assert.match(content, /^---\nname: "S"\nuid: "uid-42"\ncreated: "TS\(42\)"\nmodified: "TS\(42\)"\nacceptance-status: "proposed"\n---\nhi$/);

    await tick();
    const recs = records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].op, "obsidian_write_notes");
    assert.equal(recs[0].outcome, "ok");
  });

  test("stamp preserves an existing uid and acceptance-status (never overwritten)", async () => {
    const existing = new Map([
      ["Keep/K.md", { rev: 100, content: "old", frontmatter: { uid: "KEEP-UID", created: "2019-01-01T00:00:00", "acceptance-status": "accepted" } }],
    ]);
    const { call, vault } = harness({ existing });
    await call({ notes: [{ path: "Keep/K.md", frontmatter: { name: "K" }, body: "rewritten" }], stamp: true });
    const content = vault.get("Keep/K.md").content;
    assert.match(content, /uid: "KEEP-UID"/, "existing uid preserved");
    assert.match(content, /created: "2019-01-01T00:00:00"/, "existing created preserved");
    assert.match(content, /acceptance-status: "accepted"/, "existing acceptance-status preserved, not reset to proposed");
    assert.match(content, /modified: "TS\(42\)"/, "modified is refreshed to now");
  });
});

describe("obsidian_write_notes — accept-forbidden guard", () => {
  for (const [label, frontmatter] of [
    ["acceptance-status: accepted", { "acceptance-status": "accepted" }],
    ["accepted-by", { name: "N", "accepted-by": "nelson" }],
    ["accepted-on", { name: "N", "accepted-on": "2026-08-09" }],
  ]) {
    test(`rejects ${label} without dispatching, other items proceed`, async () => {
      const { call, vault, records, writeCalls } = harness();
      const res = await call({
        notes: [
          { path: "Bad/Reject.md", frontmatter, body: "x" },
          { path: "Good/Ok.md", frontmatter: { name: "OK" }, body: "y" },
        ],
        stamp: true,
      });
      const body = structured(res);
      assert.equal(body.error_count, 1);
      assert.equal(body.errors[0].path, "Bad/Reject.md");
      assert.equal(body.errors[0].code, "accept_forbidden");
      assert.equal(vault.has("Bad/Reject.md"), false, "a rejected item must never be written");
      assert.equal(writeCalls.includes("Bad/Reject.md"), false);
      assert.equal(body.count, 1);
      assert.equal(vault.has("Good/Ok.md"), true, "the clean item still writes");

      await tick();
      const recs = records();
      assert.equal(recs.some((r) => r.target.path === "Bad/Reject.md"), false, "a rejected item takes no journal record");
      assert.equal(recs.filter((r) => r.target.path === "Good/Ok.md").length, 1);
    });
  }

  test("rejects a body-injected accepted fence (S2) per-item; sibling proceeds", async () => {
    const { call, vault, writeCalls } = harness();
    const res = await call({
      notes: [
        { path: "Bad/Inject.md", body: "---\nacceptance-status: accepted\n---\nsneaky" },
        { path: "Good/Clean.md", frontmatter: { name: "C" }, body: "y" },
      ],
      stamp: false,
    });
    const body = structured(res);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].path, "Bad/Inject.md");
    assert.equal(body.errors[0].code, "accept_forbidden");
    assert.equal(writeCalls.includes("Bad/Inject.md"), false, "a rejected item never dispatches");
    assert.equal(body.count, 1);
    assert.equal(vault.has("Good/Clean.md"), true);
  });

  for (const [label, frontmatter] of [
    ["array value-type [accepted]", { "acceptance-status": ["accepted"] }],
    ["map value-type {value: accepted}", { "acceptance-status": { value: "accepted" } }],
  ]) {
    test(`rejects the ${label} form (S3)`, async () => {
      const { call } = harness();
      const res = await call({ notes: [{ path: "Bad/Type.md", frontmatter, body: "x" }], stamp: false });
      const body = structured(res);
      assert.equal(body.error_count, 1);
      assert.equal(body.errors[0].code, "accept_forbidden");
    });
  }

  test("ALLOWS preserving an existing accepted under stamp (no laundering block on a legitimate edit)", async () => {
    const existing = new Map([
      ["Keep/Acc.md", { rev: 100, content: "old", frontmatter: { "acceptance-status": "accepted" } }],
    ]);
    const { call, vault } = harness({ existing });
    const res = await call({ notes: [{ path: "Keep/Acc.md", frontmatter: { name: "A" }, body: "edited" }], stamp: true });
    const body = structured(res);
    assert.equal(body.error_count, 0, "carrying an existing accepted forward is allowed");
    assert.equal(body.count, 1);
    assert.match(vault.get("Keep/Acc.md").content, /acceptance-status: "accepted"/);
  });

  test("a total-failure batch carries the MCP error flag", async () => {
    const { call } = harness();
    const res = await call({
      notes: [{ path: "Bad/Only.md", frontmatter: { accepted: true }, body: "x" }],
      stamp: false,
    });
    assert.equal(res.isError, true);
    const body = structured(res);
    assert.equal(body.count, 0);
    assert.equal(body.error_count, 1);
    assert.equal(body.errors[0].code, "accept_forbidden");
  });
});

describe("obsidian_write_notes — B2 batch intent", () => {
  test("a batch-level intent lands on every per-item journal record", async () => {
    const { call, records } = harness();
    const res = await call({
      notes: [
        { path: "Inbox/A.md", frontmatter: { name: "A" }, body: "aaa" },
        { path: "Inbox/B.md", frontmatter: { name: "B" }, body: "bbb" },
      ],
      intent: "seed the inbox pair for the 03.12 migration",
    });
    assert.equal(structured(res).error_count, 0);
    await new Promise((r) => setTimeout(r, 10));
    const recs = records();
    assert.equal(recs.length, 2);
    for (const rec of recs) {
      assert.equal(rec.intent, "seed the inbox pair for the 03.12 migration");
    }
  });

  test("no intent — per-item records carry no intent field", async () => {
    const { call, records } = harness();
    await call({ notes: [{ path: "Inbox/C.md", frontmatter: { name: "C" }, body: "c" }] });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal("intent" in records()[0], false);
  });
});
