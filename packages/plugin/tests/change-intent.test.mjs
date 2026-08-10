/**
 * change-intent.test.mjs — B2: the agent change-intent kernel argument.
 *
 * `intent` is advisory agent-authored text riding the KERNEL-ARGS mechanism
 * (withKernelArgs schema injection + the guarded wrapper's peel), recorded on
 * the journal record beside op/actor. The invariants under test are the spec's
 * constraints, each pinned from the direction it could regress:
 *
 *   • journal-only — the handler NEVER receives `intent`, so it structurally
 *     cannot land in note frontmatter;
 *   • every record carries its own call's intent (a deduped replay's record
 *     keeps the replayer's text, the winner's keeps the winner's);
 *   • advisory, not identity — a replay with a DIVERGENT intent still dedupes
 *     (unlike `if_rev`, where divergence is a mismatch): advisory text does
 *     not change what was written;
 *   • never an accept signal — nothing in the kernel reads it back;
 *   • degrades quietly without a kernel (peeled, dropped): unlike `if_rev`
 *     there is nothing destructive about losing a description.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  Kernel,
  WriteQueue,
  WriteJournal,
  IdempotencyStore,
  LockStore,
} from "../src/kernel/index.ts";
import { makeGuarded, withKernelArgs, KERNEL_ARG_KEYS } from "../src/mcp/guarded.ts";

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };
const RW_DEF = { annotations: { readOnlyHint: false } };
const OPEN = { readOnly: false, allowlist: [] };

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

function records(adapter) {
  const out = [];
  for (const [path, data] of adapter.files) {
    if (!path.endsWith(".jsonl")) continue;
    out.push(...data.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
}

function harness() {
  const adapter = fakeAdapter();
  const kernel = new Kernel(
    new WriteQueue(1000),
    new WriteJournal(adapter, "dir/journal"),
    null,
    new IdempotencyStore(),
    new LockStore()
  );
  const seen = [];
  const guarded = makeGuarded({ getSettings: () => OPEN, kernel, actor: () => ACTOR });
  const wrapped = guarded(
    withKernelArgs({ ...RW_DEF, inputSchema: { path: z.string() } }),
    async (args) => {
      seen.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    },
    "obsidian_write_note"
  );
  return { adapter, kernel, seen, call: (args) => wrapped(args, {}) };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("intent: schema surface", () => {
  test("intent is a kernel arg, declared on mutating registrations only", () => {
    assert.ok(KERNEL_ARG_KEYS.includes("intent"));
    const rw = withKernelArgs({ ...RW_DEF, inputSchema: {} });
    assert.ok(rw.inputSchema.intent);
    const ro = withKernelArgs({ annotations: { readOnlyHint: true }, inputSchema: {} });
    assert.equal(ro.inputSchema?.intent, undefined);
  });

  test("a tool's own `intent` declaration is not overridden", () => {
    const own = z.number();
    const def = withKernelArgs({ ...RW_DEF, inputSchema: { intent: own } });
    assert.equal(def.inputSchema.intent, own);
  });
});

describe("intent: journal-only", () => {
  test("the handler never sees intent; the journal record carries it", async () => {
    const { adapter, seen, call } = harness();
    await call({ path: "Notes/A.md", intent: "retitle per the 03.12 convention" });
    await flush();
    assert.equal(seen.length, 1);
    assert.equal("intent" in seen[0], false);
    const [rec] = records(adapter);
    assert.equal(rec.intent, "retitle per the 03.12 convention");
    assert.equal(rec.op, "obsidian_write_note");
  });

  test("no intent supplied — the field is absent, not empty", async () => {
    const { adapter, call } = harness();
    await call({ path: "Notes/A.md" });
    await flush();
    const [rec] = records(adapter);
    assert.equal("intent" in rec, false);
  });

  test("without a kernel, intent is peeled and dropped quietly (no refusal)", async () => {
    const seen = [];
    const guarded = makeGuarded({ getSettings: () => OPEN });
    const wrapped = guarded(
      withKernelArgs({ ...RW_DEF, inputSchema: {} }),
      async (args) => {
        seen.push(args);
        return { content: [] };
      },
      "t"
    );
    const res = await wrapped({ intent: "advisory" }, {});
    assert.equal(res.isError, undefined);
    assert.equal("intent" in seen[0], false);
  });
});

describe("intent: advisory, not identity", () => {
  test("a replay with a divergent intent still dedupes, each record keeping its own text", async () => {
    const { adapter, seen, call } = harness();
    await call({ path: "Notes/A.md", idempotency_key: "k1", intent: "first description" });
    await call({ path: "Notes/A.md", idempotency_key: "k1", intent: "second description" });
    await flush();
    assert.equal(seen.length, 1); // deduped — ran once
    const recs = records(adapter);
    assert.equal(recs.length, 2);
    const ok = recs.find((r) => r.outcome === "ok");
    const deduped = recs.find((r) => r.outcome === "deduped");
    assert.equal(ok.intent, "first description");
    assert.equal(deduped.intent, "second description");
    assert.equal(deduped.dedupeOf, ok.ts);
  });
});
