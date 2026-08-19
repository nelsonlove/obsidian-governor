/**
 * record-immutable.test.mjs — the record-immutability guard (#264): a mutating
 * operation naming a note whose frontmatter carries `record: true` refuses at
 * the kernel's dequeue closure with `Error [record_immutable]`, UNLESS it is
 * the pure end-of-file append tool (`obsidian_append_note` — exemption by TOOL
 * identity, never by argument shape).
 *
 * Everything under test is Obsidian-free (the pure check core in
 * kernel/record-guard.ts, plus Kernel.runMutation over a duck-typed probe), so
 * these are real unit tests; only the probe adapter in obsidian-probe.ts needs
 * a live vault.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Kernel,
  WriteQueue,
  WriteJournal,
  RecordImmutableError,
  recordImmutableRefusal,
  isRecordFlag,
  RECORD_EXEMPT_OPS,
  IdempotencyStore,
  LockStore,
} from "../src/kernel/index.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };
const RW_DEF = { annotations: { readOnlyHint: false } };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// Stand-in for Obsidian's DataAdapter — the four methods WriteJournal narrows to.
function fakeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async write(p, d) { files.set(p, d); },
    async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
  };
}

/** A kernel over a probe whose `record` answers come from `recordPaths`. */
function recordKernel({ recordPaths = new Set(), record } = {}) {
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-19T12:00:00Z"));
  const probe = {
    uid: () => undefined,
    rev: () => 100,
    record: record ?? ((path) => (recordPaths.has(path) ? true : undefined)),
  };
  const kernel = new Kernel(new WriteQueue(1000), journal, probe, new IdempotencyStore(), new LockStore());
  const records = () =>
    (adapter.files.get("dir/journal/2026-08.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { kernel, records };
}

// ── the pure check core ───────────────────────────────────────────────────────

describe("recordImmutableRefusal (pure core)", () => {
  const record = (path) => (path === "Records/2026-08.md" ? true : undefined);

  test("a mutating op naming a record note refuses, naming path and the dated-append convention", () => {
    for (const op of [
      "obsidian_write_note",
      "obsidian_patch_note",
      "obsidian_manage_frontmatter",
      "obsidian_move_note",
      "obsidian_delete_note",
      "obsidian_trash_note",
      "obsidian_append_at_heading", // mid-file insert — NOT the exempt append
    ]) {
      const err = recordImmutableRefusal(op, ["Records/2026-08.md"], record);
      assert.ok(err instanceof RecordImmutableError, `${op} must refuse`);
      assert.equal(err.code, "record_immutable");
      assert.match(err.message, /Records\/2026-08\.md/, "the refusal must name the path");
      assert.match(err.message, /record: true/);
      assert.match(err.message, /append/i, "the refusal must point at the append convention");
      assert.match(err.message, /## YYYY-MM-DD/, "the refusal must name the dated-append convention");
      assert.match(err.message, /obsidian_append_note/, "the refusal must name the allowed tool");
    }
  });

  test("the append exemption is TOOL identity: obsidian_append_note passes on a record note", () => {
    assert.equal(recordImmutableRefusal("obsidian_append_note", ["Records/2026-08.md"], record), null);
    // ...and the exemption set is exactly that tool.
    assert.deepEqual([...RECORD_EXEMPT_OPS], ["obsidian_append_note"]);
  });

  test("crosssession_post is NOT exempt — pinned deliberately, not by oversight", () => {
    // The one other tool whose contract is a dated end-of-file append. It never
    // reaches this check today (its target arrives as `channel`, which is not a
    // PATH_KEY, so collectPaths yields nothing), so exempting it would widen a
    // protective set on a guess about a future argument shape. This test exists
    // so that if `channel` ever becomes path-keyed, the resulting refusal is a
    // decision someone makes here rather than a surprise in production.
    const err = recordImmutableRefusal("crosssession_post", ["Records/2026-08.md"], record);
    assert.ok(err instanceof RecordImmutableError, "unexempted today — change this only on purpose");
  });

  test("append-shaped ARGUMENTS on a different tool do not exempt it", () => {
    // The paths walked are the same either way; only the op name decides.
    const err = recordImmutableRefusal("obsidian_write_note", ["Records/2026-08.md"], record);
    assert.ok(err instanceof RecordImmutableError);
  });

  test("non-record notes pass untouched", () => {
    assert.equal(recordImmutableRefusal("obsidian_write_note", ["Notes/A.md"], record), null);
    assert.equal(recordImmutableRefusal("obsidian_write_note", [], record), null);
  });

  test("multi-path: ANY named record path refuses — a move onto or off a record alike", () => {
    // Source is the record (move it away):
    let err = recordImmutableRefusal("obsidian_move_note", ["Records/2026-08.md", "Archive/x.md"], record);
    assert.ok(err instanceof RecordImmutableError);
    assert.equal(err.path, "Records/2026-08.md");
    // Destination is the record (overwrite it):
    err = recordImmutableRefusal("obsidian_move_note", ["Notes/A.md", "Records/2026-08.md"], record);
    assert.ok(err instanceof RecordImmutableError);
    assert.equal(err.path, "Records/2026-08.md");
  });

  test("fail OPEN: an unreadable flag (undefined) or a THROWING probe never refuses", () => {
    assert.equal(recordImmutableRefusal("obsidian_write_note", ["Missing.md"], () => undefined), null);
    assert.equal(
      recordImmutableRefusal("obsidian_write_note", ["Broken.md"], () => {
        throw new Error("cache is on fire");
      }),
      null
    );
    // A throw on ONE path must not mask a positive answer on another.
    const flaky = (p) => {
      if (p === "Broken.md") throw new Error("boom");
      return p === "Records/2026-08.md" ? true : undefined;
    };
    const err = recordImmutableRefusal("obsidian_write_note", ["Broken.md", "Records/2026-08.md"], flaky);
    assert.ok(err instanceof RecordImmutableError);
  });

  test("an explicit false is not a record", () => {
    assert.equal(recordImmutableRefusal("obsidian_write_note", ["A.md"], () => false), null);
  });
});

describe("isRecordFlag", () => {
  test("boolean true and the quoted string form count; nothing else does", () => {
    assert.equal(isRecordFlag(true), true);
    assert.equal(isRecordFlag("true"), true);
    assert.equal(isRecordFlag(" TRUE "), true);
    assert.equal(isRecordFlag(false), false);
    assert.equal(isRecordFlag("false"), false);
    assert.equal(isRecordFlag("yes"), false);
    assert.equal(isRecordFlag(1), false);
    assert.equal(isRecordFlag(null), false);
    assert.equal(isRecordFlag(undefined), false);
    assert.equal(isRecordFlag(["true"]), false);
  });
});

// ── the kernel binding (dequeue closure) ──────────────────────────────────────

describe("Kernel.runMutation record immutability", () => {
  test("a write to a record note throws RecordImmutableError, runs nothing, and is journaled", async () => {
    const { kernel, records } = recordKernel({ recordPaths: new Set(["Records/2026-08.md"]) });
    let ran = false;
    const err = await kernel
      .runMutation(
        { op: "obsidian_write_note", args: { path: "Records/2026-08.md", content: "x" }, actor: ACTOR },
        async () => { ran = true; return { content: [] }; }
      )
      .then(() => assert.fail("a record write must refuse"), (e) => e);
    assert.ok(err instanceof RecordImmutableError);
    assert.equal(ran, false, "the handler must never run");
    await tick(0);
    const [rec] = records();
    assert.equal(rec.outcome, "error", "the refusal is journaled like its thrown-kernel-failure family");
    assert.match(rec.error, /record: true/);
    assert.match(rec.error, /Records\/2026-08\.md/);
  });

  test("obsidian_append_note on the same record note proceeds", async () => {
    const { kernel, records } = recordKernel({ recordPaths: new Set(["Records/2026-08.md"]) });
    const res = await kernel.runMutation(
      { op: "obsidian_append_note", args: { path: "Records/2026-08.md", content: "\n## 2026-08-19\n…" }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "appended" }] })
    );
    assert.equal(res.content[0].text, "appended");
    await tick(0);
    assert.equal(records()[0].outcome, "ok");
  });

  test("the check is at DEQUEUE: a note that becomes a record while queued refuses", async () => {
    const recordPaths = new Set();
    const { kernel } = recordKernel({ recordPaths });
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "Other.md" }, actor: ACTOR },
      async () => {
        // While the second call waits in the queue, the target gains record: true.
        recordPaths.add("Records/New.md");
        await gate;
        return { content: [] };
      }
    );
    const second = kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "Records/New.md" }, actor: ACTOR },
      async () => ({ content: [] })
    );
    release();
    await first;
    await assert.rejects(second, RecordImmutableError);
  });

  test("no `record` probe method (older fakes, bare embeds) means no enforcement — fail open", async () => {
    const adapter = fakeAdapter();
    const kernel = new Kernel(
      new WriteQueue(1000),
      new WriteJournal(adapter, "dir/journal"),
      { uid: () => undefined, rev: () => 100 } // no record()
    );
    const res = await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "Records/2026-08.md" }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "wrote" }] })
    );
    assert.equal(res.content[0].text, "wrote");
  });

  test("a throwing record probe fails OPEN — never promoted to a ProbeError refusal", async () => {
    const { kernel } = recordKernel({ record: () => { throw new Error("cache exploded"); } });
    const res = await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "wrote" }] })
    );
    assert.equal(res.content[0].text, "wrote");
  });

  test("multi-path through the kernel: a batch move touching a record refuses whole", async () => {
    const { kernel } = recordKernel({ recordPaths: new Set(["Records/2026-08.md"]) });
    let ran = false;
    await assert.rejects(
      kernel.runMutation(
        {
          op: "obsidian_move_notes",
          args: { moves: [{ from: "Notes/A.md", to: "B.md" }, { from: "Records/2026-08.md", to: "C.md" }] },
          actor: ACTOR,
        },
        async () => { ran = true; return { content: [] }; }
      ),
      RecordImmutableError
    );
    assert.equal(ran, false);
  });

  test("the queue stays free after a refusal", async () => {
    const { kernel } = recordKernel({ recordPaths: new Set(["Records/R.md"]) });
    await assert.rejects(
      kernel.runMutation({ op: "obsidian_write_note", args: { path: "Records/R.md" }, actor: ACTOR }, async () => ({ content: [] })),
      RecordImmutableError
    );
    const next = await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "A.md" }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    assert.equal(next.content[0].text, "ok");
  });
});

// ── the guarded wrapper: typed envelope, Code Mode by construction ───────────

describe("record_immutable through makeGuarded", () => {
  test("the refusal surfaces as a coded Error [record_immutable] envelope", async () => {
    const { kernel } = recordKernel({ recordPaths: new Set(["Records/2026-08.md"]) });
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    let ran = false;
    const res = await guarded(RW_DEF, async () => { ran = true; }, "obsidian_write_note")(
      { path: "Records/2026-08.md", content: "x" },
      {}
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[record_immutable\]: /);
    assert.match(res.content[0].text, /Records\/2026-08\.md/);
    assert.equal(ran, false);
  });

  test("the guarded append tool passes on a record note", async () => {
    const { kernel } = recordKernel({ recordPaths: new Set(["Records/2026-08.md"]) });
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });
    const res = await guarded(
      RW_DEF,
      async () => ({ content: [{ type: "text", text: "appended" }] }),
      "obsidian_append_note"
    )({ path: "Records/2026-08.md", content: "\n## 2026-08-19\n…" }, {});
    assert.equal(res.content[0].text, "appended");
  });
});
