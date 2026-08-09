/**
 * uid-index.test.mjs — slice 2.1: the identity substrate's `uid → path` store,
 * and uid-addressed tool access.
 *
 * Three surfaces, all Obsidian-free by design (the index is built over an
 * injected UidSource, so freshness is testable without a vault):
 *
 *   • UidIndex           — build, freshness per event type, duplicates
 *   • resolveUidArgs     — `uid:<value>` rewriting at the guarded wrapper
 *   • obsidian_resolve_uid — the lookup tool, in both directions
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Kernel,
  WriteQueue,
  WriteJournal,
  IdempotencyStore,
  LockStore,
  UidIndex,
  UidUnresolvedError,
  UidAmbiguousError,
  resolveUidArgs,
  uidRef,
  UID_PREFIX,
} from "../src/kernel/index.ts";
import { collectPaths, mapPaths } from "../src/guard.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { registerUidTools } from "../src/mcp/tools-uid.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };
const RW_DEF = { annotations: { readOnlyHint: false } };
const RO_DEF = { annotations: { readOnlyHint: true } };
const OPEN_SETTINGS = { readOnly: false, allowlist: [] };

/**
 * A hand-driven stand-in for Obsidian's metadata cache: a path → uid map the
 * test mutates directly, exactly as an edit in the vault would, before firing
 * the event the plugin wires up in main.ts.
 */
function fakeSource(entries = {}) {
  const uids = new Map(Object.entries(entries));
  return {
    uids,
    paths: () => [...uids.keys()],
    uidOf: (path) => uids.get(path),
    // Vault-shaped mutators, so each test reads as the edit it models.
    setUid(path, uid) { uids.set(path, uid); },
    clearUid(path) { uids.set(path, undefined); },
    remove(path) { uids.delete(path); },
    move(from, to) { const u = uids.get(from); uids.delete(from); uids.set(to, u); },
  };
}

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

/** A kernel wired to a uid index, plus a reader for the journal it writes. */
function kernelWith(index, { revs = new Map() } = {}) {
  const adapter = fakeAdapter();
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
  const kernel = new Kernel(
    new WriteQueue(1000),
    journal,
    { uid: () => undefined, rev: (p) => revs.get(p) },
    new IdempotencyStore(),
    new LockStore(),
    index
  );
  const records = () =>
    (adapter.files.get("dir/journal/2026-08.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { kernel, records };
}

// ── the index ─────────────────────────────────────────────────────────────────

describe("UidIndex — building", () => {
  test("maps uid → path and back, from the source's cache alone", () => {
    const src = fakeSource({ "Notes/A.md": "uid-a", "Notes/B.md": "uid-b" });
    const index = new UidIndex(src);
    index.rebuild();

    assert.equal(index.pathFor("uid-a"), "Notes/A.md");
    assert.equal(index.pathFor("uid-b"), "Notes/B.md");
    assert.equal(index.uidFor("Notes/A.md"), "uid-a");
    assert.equal(index.size, 2);
    assert.equal(index.uidCount, 2);
  });

  test("files without a uid are ignored, not recorded as uid-less", () => {
    const src = fakeSource({ "Notes/A.md": "uid-a", "Notes/plain.md": undefined, "Notes/empty.md": "" });
    const index = new UidIndex(src);
    index.rebuild();

    assert.equal(index.size, 1, "only the note that carries a uid is indexed");
    assert.equal(index.uidFor("Notes/plain.md"), undefined);
    assert.equal(index.pathFor(""), undefined, "an empty uid is not a uid");
  });

  test("an unknown uid resolves to nothing, without throwing", () => {
    const index = new UidIndex(fakeSource({ "A.md": "uid-a" }));
    index.rebuild();
    assert.deepEqual(index.resolve("nope"), { uid: "nope", paths: [] });
    assert.equal(index.pathFor("nope"), undefined);
  });

  test("rebuilding replaces the whole index rather than accumulating", () => {
    const src = fakeSource({ "A.md": "uid-a" });
    const index = new UidIndex(src);
    index.rebuild();
    src.remove("A.md");
    src.setUid("B.md", "uid-b");
    index.rebuild();

    assert.equal(index.pathFor("uid-a"), undefined, "the departed note is gone");
    assert.equal(index.pathFor("uid-b"), "B.md");
    assert.equal(index.size, 1);
  });
});

describe("UidIndex — duplicates are recorded, never repaired", () => {
  test("a uid on two notes keeps BOTH paths, first in precedence order", () => {
    const src = fakeSource({ "Zeta.md": "shared", "Alpha.md": "shared" });
    const index = new UidIndex(src);
    index.rebuild();

    // Sorted at build, so the winner is a property of the vault rather than of
    // whichever file the cache happened to warm first.
    assert.deepEqual(index.resolve("shared"), { uid: "shared", path: "Alpha.md", paths: ["Alpha.md", "Zeta.md"] });
    assert.equal(index.size, 2, "both notes are indexed");
    assert.equal(index.uidCount, 1, "…under one uid");
  });

  test("duplicates are queryable as a set, and nothing is rewritten", () => {
    const src = fakeSource({ "A.md": "dup", "B.md": "dup", "C.md": "solo" });
    const index = new UidIndex(src);
    index.rebuild();

    assert.deepEqual(index.duplicates(), [{ uid: "dup", paths: ["A.md", "B.md"] }]);
    assert.deepEqual(src.uids.get("A.md"), "dup", "the source's frontmatter is untouched — no auto-fix");
    assert.deepEqual(src.uids.get("B.md"), "dup");
  });

  test("addressing a duplicated uid is a typed refusal naming the candidates", () => {
    const index = new UidIndex(fakeSource({ "A.md": "dup", "B.md": "dup" }));
    index.rebuild();

    assert.throws(
      () => index.requireOne("dup"),
      (e) =>
        e instanceof UidAmbiguousError &&
        e.code === "uid_ambiguous" &&
        e.paths.length === 2 &&
        /A\.md/.test(e.message) &&
        /B\.md/.test(e.message) &&
        /Nothing ran/.test(e.message)
    );
  });

  test("an unknown uid is its own typed refusal", () => {
    const index = new UidIndex(fakeSource({}));
    index.rebuild();
    assert.throws(
      () => index.requireOne("ghost"),
      (e) => e instanceof UidUnresolvedError && e.code === "uid_unresolved" && /names no note/.test(e.message)
    );
  });

  test("resolving a duplicate down to one note makes it addressable again", () => {
    const src = fakeSource({ "A.md": "dup", "B.md": "dup" });
    const index = new UidIndex(src);
    index.rebuild();
    src.setUid("B.md", "distinct");
    index.onChanged("B.md");

    assert.equal(index.requireOne("dup"), "A.md");
    assert.deepEqual(index.duplicates(), []);
  });
});

describe("UidIndex — freshness, one event type at a time", () => {
  test("changed: a uid ADDED to a note enters the index", () => {
    const src = fakeSource({ "New.md": undefined });
    const index = new UidIndex(src);
    index.rebuild();
    assert.equal(index.size, 0);

    src.setUid("New.md", "uid-new");
    index.onChanged("New.md");
    assert.equal(index.pathFor("uid-new"), "New.md");
    assert.equal(index.uidFor("New.md"), "uid-new");
  });

  test("changed: a uid CHANGED on a note moves the mapping, leaving no ghost", () => {
    const src = fakeSource({ "A.md": "old" });
    const index = new UidIndex(src);
    index.rebuild();

    src.setUid("A.md", "new");
    index.onChanged("A.md");
    assert.equal(index.pathFor("new"), "A.md");
    assert.equal(index.pathFor("old"), undefined, "the old uid no longer resolves to anything");
    assert.equal(index.size, 1);
    assert.equal(index.uidCount, 1);
  });

  test("changed: a uid REMOVED drops the note from the index entirely", () => {
    const src = fakeSource({ "A.md": "uid-a" });
    const index = new UidIndex(src);
    index.rebuild();

    src.clearUid("A.md");
    index.onChanged("A.md");
    assert.equal(index.pathFor("uid-a"), undefined);
    assert.equal(index.uidFor("A.md"), undefined);
    assert.equal(index.size, 0);
  });

  test("changed: an edit that touched no uid is a no-op", () => {
    const src = fakeSource({ "A.md": "uid-a" });
    const index = new UidIndex(src);
    index.rebuild();
    index.onChanged("A.md");
    index.onChanged("A.md");
    assert.deepEqual(index.resolve("uid-a"), { uid: "uid-a", path: "A.md", paths: ["A.md"] });
  });

  test("rename: the uid travels with the note — the reason the index exists", () => {
    const src = fakeSource({ "Inbox/A.md": "uid-a" });
    const index = new UidIndex(src);
    index.rebuild();

    src.move("Inbox/A.md", "Projects/Alpha/A.md");
    index.onRenamed("Inbox/A.md", "Projects/Alpha/A.md");
    assert.equal(index.pathFor("uid-a"), "Projects/Alpha/A.md", "the uid now names the new location");
    assert.equal(index.uidFor("Inbox/A.md"), undefined, "…and nothing still answers at the old one");
    assert.equal(index.size, 1);
  });

  test("rename: works even when the source has not re-keyed onto the new path yet", () => {
    const src = fakeSource({ "A.md": "uid-a" });
    const index = new UidIndex(src);
    index.rebuild();

    // The event arrives before the cache moved: what we already knew must win.
    index.onRenamed("A.md", "B.md");
    assert.equal(index.pathFor("uid-a"), "B.md");
  });

  test("rename: a file that gained a uid while unindexed is picked up from the source", () => {
    const src = fakeSource({ "A.md": undefined });
    const index = new UidIndex(src);
    index.rebuild();

    src.move("A.md", "B.md");
    src.setUid("B.md", "uid-b");
    index.onRenamed("A.md", "B.md");
    assert.equal(index.pathFor("uid-b"), "B.md");
  });

  test("rename: onto an EXISTING note replaces that note's mapping", () => {
    const src = fakeSource({ "A.md": "uid-a", "B.md": "uid-b" });
    const index = new UidIndex(src);
    index.rebuild();

    src.move("A.md", "B.md"); // an overwriting move
    index.onRenamed("A.md", "B.md");
    assert.equal(index.pathFor("uid-a"), "B.md");
    assert.equal(index.pathFor("uid-b"), undefined, "the overwritten note's uid is gone with it");
    assert.equal(index.size, 1);
  });

  test("rename: a duplicate's precedence order survives an unrelated rename", () => {
    const src = fakeSource({ "A.md": "dup", "B.md": "dup" });
    const index = new UidIndex(src);
    index.rebuild();
    assert.deepEqual(index.resolve("dup").paths, ["A.md", "B.md"]);

    src.move("A.md", "Zzz.md");
    index.onRenamed("A.md", "Zzz.md");
    assert.deepEqual(index.resolve("dup").paths, ["Zzz.md", "B.md"], "renaming the winner does not demote it");
  });

  test("delete: the mapping goes with the note", () => {
    const src = fakeSource({ "A.md": "uid-a", "B.md": "uid-b" });
    const index = new UidIndex(src);
    index.rebuild();

    src.remove("A.md");
    index.onDeleted("A.md");
    assert.equal(index.pathFor("uid-a"), undefined);
    assert.equal(index.size, 1);
    index.onDeleted("A.md");
    assert.equal(index.size, 1, "deleting twice is a no-op, not a corruption");
  });

  test("delete: one of two duplicates leaves the survivor addressable", () => {
    const index = new UidIndex(fakeSource({ "A.md": "dup", "B.md": "dup" }));
    index.rebuild();

    index.onDeleted("A.md");
    assert.equal(index.requireOne("dup"), "B.md", "the duplication ended, so addressing works again");
    assert.deepEqual(index.duplicates(), []);
  });
});

// ── uid addressing ────────────────────────────────────────────────────────────

describe("uid references", () => {
  test("uidRef recognizes `uid:<value>` and nothing else", () => {
    assert.equal(UID_PREFIX, "uid:");
    assert.equal(uidRef("uid:019f-abc"), "019f-abc");
    assert.equal(uidRef("uid: 019f-abc "), "019f-abc", "surrounding space is not part of the uid");
    assert.equal(uidRef("Notes/A.md"), undefined);
    assert.equal(uidRef("uid:"), undefined, "a bare prefix names no uid, so it stays a literal path");
    assert.equal(uidRef("Notes/uid:A.md"), undefined, "the prefix only counts at the start");
    assert.equal(uidRef(42), undefined);
  });

  test("mapPaths rewrites every path-bearing shape the guard can see", () => {
    const args = {
      path: "A",
      nested: { moves: [{ from: "B", to: "C" }] },
      paths: ["D", "E"],
      content: "not a path",
    };
    const out = mapPaths(args, (p) => `${p}!`);
    assert.deepEqual(out, {
      path: "A!",
      nested: { moves: [{ from: "B!", to: "C!" }] },
      paths: ["D!", "E!"],
      content: "not a path",
    });
    // The set it rewrites and the set the allowlist scopes are one set.
    assert.deepEqual(collectPaths(args), ["A", "B", "C", "D", "E"]);
  });

  test("mapPaths returns the SAME object when it changes nothing", () => {
    const args = { path: "A", nested: { to: "B" } };
    assert.equal(mapPaths(args, (p) => p), args, "an unchanged call must not even reallocate");
  });

  test("resolveUidArgs rewrites uid references and reports what it resolved", () => {
    const index = new UidIndex(fakeSource({ "Notes/A.md": "uid-a", "Notes/B.md": "uid-b" }));
    index.rebuild();

    const { args, resolved } = resolveUidArgs({ from: "uid:uid-a", to: "uid:uid-b", overwrite: true }, index);
    assert.deepEqual(args, { from: "Notes/A.md", to: "Notes/B.md", overwrite: true });
    assert.deepEqual(resolved, [
      { uid: "uid-a", path: "Notes/A.md" },
      { uid: "uid-b", path: "Notes/B.md" },
    ]);
  });

  test("a call using no uid addressing is handed back its own args, untouched", () => {
    const index = new UidIndex(fakeSource({ "A.md": "uid-a" }));
    index.rebuild();
    const args = { path: "Notes/Ordinary.md", content: "x" };
    const out = resolveUidArgs(args, index);
    assert.equal(out.args, args, "behavior is unchanged when uid addressing is unused");
    assert.deepEqual(out.resolved, []);
  });

  test("without an index, a uid reference fails closed rather than becoming a filename", () => {
    assert.throws(
      () => resolveUidArgs({ path: "uid:whatever" }, null),
      (e) => e instanceof UidUnresolvedError && /no uid index is active/.test(e.message)
    );
  });
});

describe("uid addressing through the guarded wrapper", () => {
  function harness({ allowlist = [], entries = { "Notes/A.md": "uid-a" } } = {}) {
    const src = fakeSource(entries);
    const index = new UidIndex(src);
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist }),
      kernel,
      actor: () => ACTOR,
    });
    const seen = [];
    const handler = async (args) => {
      seen.push(args);
      return { content: [{ type: "text", text: "{}" }] };
    };
    return { src, index, kernel, records, guarded, seen, handler };
  }

  test("a WRITE addressed by uid reaches the handler with the resolved path", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:uid-a", content: "hi" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "Notes/A.md", content: "hi" }], "handlers never see a uid reference");
  });

  test("a READ addressed by uid resolves too — the same interception point covers both", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RO_DEF, handler, "obsidian_read_note")({ path: "uid:uid-a" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "Notes/A.md" }]);
  });

  test("uid addressing survives a rename — the point of the whole slice", async () => {
    const { src, index, guarded, seen, handler } = harness();
    src.move("Notes/A.md", "Archive/2026/A.md");
    index.onRenamed("Notes/A.md", "Archive/2026/A.md");

    await guarded(RO_DEF, handler, "obsidian_read_note")({ path: "uid:uid-a" }, {});
    assert.deepEqual(seen, [{ path: "Archive/2026/A.md" }], "the same reference now names the new location");
  });

  test("an UNRESOLVABLE uid is a typed error, and the handler never runs", async () => {
    const { guarded, seen, handler } = harness();
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:ghost", content: "x" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[uid_unresolved\]/);
    assert.deepEqual(seen, [], "nothing was written");
  });

  test("an AMBIGUOUS uid is a typed error listing the paths, and nothing runs", async () => {
    const { guarded, seen, handler } = harness({ entries: { "A.md": "dup", "B.md": "dup" } });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:dup", content: "x" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[uid_ambiguous\]/);
    assert.match(res.content[0].text, /A\.md/);
    assert.match(res.content[0].text, /B\.md/);
    assert.deepEqual(seen, []);
  });

  test("neither error is journaled as a vault failure, because no operation ran", async () => {
    const { guarded, handler, records } = harness();
    await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:ghost" }, {});
    await tick(5);
    assert.deepEqual(records(), [], "a refused reference never reached the queue");
  });

  test("the allowlist is checked against the RESOLVED path — a uid is not a way around it", async () => {
    const { guarded, seen, handler } = harness({
      allowlist: ["Projects"],
      entries: { "Archive/secret.md": "uid-secret" },
    });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:uid-secret" }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.deepEqual(seen, []);
  });

  test("…and the refusal does not disclose the path it resolved to", async () => {
    const { guarded, handler } = harness({
      allowlist: ["Projects"],
      entries: { "Archive/secret.md": "uid-secret" },
    });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:uid-secret" }, {});
    assert.equal(
      res.content[0].text.includes("Archive/secret.md"),
      false,
      "a sandboxed session must not learn paths outside its sandbox from an error message"
    );
    assert.match(res.content[0].text, /uid:uid-secret/, "it names the reference the caller actually gave");
  });

  test("an allowlisted session addressing INSIDE its allowlist by uid still works", async () => {
    const { guarded, seen, handler } = harness({
      allowlist: ["Projects"],
      entries: { "Projects/Alpha.md": "uid-alpha" },
    });
    const res = await guarded(RW_DEF, handler, "obsidian_write_note")({ path: "uid:uid-alpha" }, {});
    assert.equal(res.isError, undefined);
    assert.deepEqual(seen, [{ path: "Projects/Alpha.md" }]);
  });

  test("a multi-path operation resolves every reference it carries", async () => {
    const { guarded, seen, handler } = harness({ entries: { "A.md": "uid-a", "B.md": "uid-b" } });
    await guarded(RW_DEF, handler, "obsidian_read_notes")({ paths: ["uid:uid-a", "Literal.md", "uid:uid-b"] }, {});
    assert.deepEqual(seen, [{ paths: ["A.md", "Literal.md", "B.md"] }], "mixed literal and uid addressing is fine");
  });

  test("one bad reference in a batch refuses the WHOLE call", async () => {
    const { guarded, seen, handler } = harness({ entries: { "A.md": "uid-a" } });
    const res = await guarded(RW_DEF, handler, "obsidian_read_notes")({ paths: ["uid:uid-a", "uid:ghost"] }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /uid_unresolved/);
    assert.deepEqual(seen, [], "a partially-resolvable batch is not half-run");
  });
});

describe("the journal records both the uid and the resolved path", () => {
  test("a uid-addressed write journals target.path AND target.uid", async () => {
    const src = fakeSource({ "Notes/A.md": "uid-a" });
    const index = new UidIndex(src);
    index.rebuild();
    const { kernel, records } = kernelWith(index);
    const guarded = makeGuarded({ getSettings: () => OPEN_SETTINGS, kernel, actor: () => ACTOR });

    await guarded(RW_DEF, async () => ({ content: [{ type: "text", text: "{}" }] }), "obsidian_write_note")(
      { path: "uid:uid-a", content: "hi" },
      {}
    );

    await tick(5);
    const [rec] = records();
    assert.equal(rec.target.path, "Notes/A.md", "the resolved path");
    assert.equal(rec.target.uid, "uid-a", "…and the identity it was addressed by");
    assert.equal(rec.argsDigest.path, "Notes/A.md", "the digest shows what actually ran");
  });

  test("target.uid comes from the INDEX, not only a frontmatter probe at write time", async () => {
    const index = new UidIndex(fakeSource({ "Notes/A.md": "uid-a" }));
    index.rebuild();
    // The probe in kernelWith answers `undefined` for every uid, so anything
    // recorded here can only have come from the index.
    const { kernel, records } = kernelWith(index);

    await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "Notes/A.md" }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "{}" }] })
    );
    await tick(5);
    assert.equal(records()[0].target.uid, "uid-a");
  });

  test("a path the index does not know still journals, simply without a uid", async () => {
    const index = new UidIndex(fakeSource({}));
    index.rebuild();
    const { kernel, records } = kernelWith(index);

    await kernel.runMutation(
      { op: "obsidian_write_note", args: { path: "Brand/New.md" }, actor: ACTOR },
      async () => ({ content: [{ type: "text", text: "{}" }] })
    );
    await tick(5);
    assert.equal(records()[0].target.path, "Brand/New.md");
    assert.equal(records()[0].target.uid, undefined);
  });
});

// ── the lookup tool ───────────────────────────────────────────────────────────

describe("obsidian_resolve_uid", () => {
  function uidServer({ entries = { "Notes/A.md": "uid-a" }, allowlist = [], kernel } = {}) {
    const index = new UidIndex(fakeSource(entries));
    index.rebuild();
    const calls = new Map();
    const k = kernel === undefined ? kernelWith(index).kernel : kernel;
    registerUidTools(
      { registerTool: (name, def, handler) => calls.set(name, { def, handler }) },
      { kernel: k, getSettings: () => ({ readOnly: false, allowlist }) }
    );
    return { index, calls, call: (args = {}) => calls.get("obsidian_resolve_uid").handler(args, {}) };
  }

  test("it is read-only, and the surface is one tool", () => {
    const { calls } = uidServer();
    assert.deepEqual([...calls.keys()], ["obsidian_resolve_uid"]);
    assert.equal(calls.get("obsidian_resolve_uid").def.annotations.readOnlyHint, true);
  });

  test("no accept/approve/grant verb anywhere in the vocabulary", () => {
    const { calls } = uidServer();
    const { def } = calls.get("obsidian_resolve_uid");
    const text = `obsidian_resolve_uid ${def.title} ${def.description}`.toLowerCase();
    for (const banned of ["grant", "approve", "accept"]) assert.equal(text.includes(banned), false, banned);
  });

  test("uid → path", async () => {
    const { call } = uidServer();
    const res = await call({ uid: "uid-a" });
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, { uid: "uid-a", found: true, path: "Notes/A.md" });
  });

  test("path → uid, the reverse direction", async () => {
    const { call } = uidServer();
    assert.deepEqual((await call({ path: "Notes/A.md" })).structuredContent, {
      path: "Notes/A.md",
      found: true,
      uid: "uid-a",
    });
    assert.deepEqual((await call({ path: "Notes/plain.md" })).structuredContent, {
      path: "Notes/plain.md",
      found: false,
      uid: null,
    });
  });

  test("an unknown uid reads as not-found rather than an error", async () => {
    const { call } = uidServer();
    assert.deepEqual((await call({ uid: "ghost" })).structuredContent, { uid: "ghost", found: false, path: null });
  });

  test("a duplicated uid reports every path and flags the ambiguity", async () => {
    const { call } = uidServer({ entries: { "A.md": "dup", "B.md": "dup" } });
    const res = await call({ uid: "dup" });
    assert.deepEqual(res.structuredContent, {
      uid: "dup",
      found: true,
      path: "A.md",
      duplicates: ["A.md", "B.md"],
      ambiguous: true,
    });
  });

  test("with no argument it reports the index's state and every duplicate", async () => {
    const { call } = uidServer({ entries: { "A.md": "dup", "B.md": "dup", "C.md": "solo" } });
    assert.deepEqual((await call()).structuredContent, {
      indexed_notes: 3,
      indexed_uids: 2,
      duplicate_count: 1,
      duplicates: [{ uid: "dup", paths: ["A.md", "B.md"] }],
    });
  });

  test("both directions at once is refused — they are two halves of one lookup", async () => {
    const { call } = uidServer();
    const res = await call({ uid: "uid-a", path: "Notes/A.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not both/);
  });

  test("the allowlist bounds what it will disclose: a uid outside it reads as unknown", async () => {
    const { call } = uidServer({ entries: { "Archive/secret.md": "uid-secret" }, allowlist: ["Projects"] });
    assert.deepEqual((await call({ uid: "uid-secret" })).structuredContent, {
      uid: "uid-secret",
      found: false,
      path: null,
    });
  });

  test("…and duplicates outside it are not listed either", async () => {
    const { call } = uidServer({
      entries: { "Archive/a.md": "dup", "Archive/b.md": "dup", "Projects/c.md": "ok" },
      allowlist: ["Projects"],
    });
    const res = await call();
    assert.deepEqual(res.structuredContent.duplicates, [], "a wholly out-of-bounds duplicate is invisible");
    assert.equal(res.structuredContent.duplicate_count, 0);
  });

  test("without a kernel it fails cleanly rather than throwing", async () => {
    const { call } = uidServer({ kernel: null });
    const res = await call({ uid: "uid-a" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /kernel/);
  });
});
