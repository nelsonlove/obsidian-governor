/**
 * pending-review.test.mjs — slice B3b: the READ-ONLY `obsidian_pending_review`
 * tool over the governance module's published review-queue index (#261: the
 * index moved from the retired Stewardship standalone's path to the vault-mcp
 * plugin dir, and absence became an EXPLICIT `published: false` — never a
 * silent empty queue).
 *
 * Same fake-server pattern as scheme-tools.test.mjs / uid-index.test.mjs:
 * register against a stand-in server, invoke the captured handler directly.
 * The tool is obsidian-free (defined over an injected PendingReviewSource), so
 * everything here runs headlessly — no live Obsidian.
 *
 * Covers: the pending list from a fixture index; the publish→read round-trip
 * against the REAL serializer the governance module uses; allowlist-filtering
 * drops paths outside the caller's visible set; explicit not-published /
 * unreadable states; schema-drift tolerance; and the plugin-dir-relative
 * adapter path.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  registerPendingReviewTools,
  parsePendingIndex,
  parsePendingIndexStrict,
  obsidianPendingReviewSource,
  PENDING_INDEX_REL,
} from "../src/mcp/tools-pending-review.ts";
import { serializePendingIndex } from "../src/kernel/governance/pending-index.ts";

// A well-formed index: the shape the governance module publishes.
const INDEX = {
  version: 1,
  generatedAt: "2026-08-10T12:00:00Z",
  pending: [
    { path: "Projects/alpha.md", status: "pending", agent: "claude", op: "write_note", when: "2026-08-10T11:00:00Z", writeCount: 3 },
    { path: "Archive/old.md", status: "pending", agent: "claude", op: "append_note", when: "2026-08-10T10:00:00Z", writeCount: 1 },
    { path: "Projects/beta.md", status: "pending", agent: "gpt", op: "move_note", when: "2026-08-10T09:00:00Z", writeCount: 2 },
  ],
};

/** A source that returns whatever raw text (or null) the test supplies. */
function sourceOf(raw) {
  return { read: async () => raw };
}

function toolServer({ raw = JSON.stringify(INDEX), settings = { readOnly: false, allowlist: [] } } = {}) {
  const server = fakeServer();
  registerPendingReviewTools(server, { source: sourceOf(raw), getSettings: () => settings });
  const call = (name = "obsidian_pending_review", args = {}) => server.tools.get(name).handler(args, {});
  return { server, call };
}

// ── registration shape ────────────────────────────────────────────────────────

describe("registration", () => {
  test("registers exactly obsidian_pending_review, read-only", () => {
    const { server } = toolServer();
    assert.deepEqual([...server.tools.keys()], ["obsidian_pending_review"]);
    const { def } = server.tools.get("obsidian_pending_review");
    assert.equal(def.annotations.readOnlyHint, true);
    assert.equal(def.annotations.destructiveHint, false);
  });

  test("takes no arguments — nothing a caller could use to change state", () => {
    const { server } = toolServer();
    assert.deepEqual(server.tools.get("obsidian_pending_review").def.inputSchema, {});
  });

  test("description promises read-only, no accept verb, and advisory-only", () => {
    const { server } = toolServer();
    const desc = server.tools.get("obsidian_pending_review").def.description.toLowerCase();
    assert.match(desc, /read-only/);
    assert.match(desc, /accept/); // it says it CANNOT accept
    assert.match(desc, /advisory|blocks nothing|avoid/);
  });
});

// ── happy path ────────────────────────────────────────────────────────────────

describe("returns the pending list from a fixture index", () => {
  test("no allowlist ⇒ every entry, fields passed through verbatim, published: true", async () => {
    const { call } = toolServer();
    const res = await call();
    assert.equal(res.structuredContent.published, true);
    assert.equal(res.structuredContent.count, 3);
    assert.deepEqual(res.structuredContent.pending, INDEX.pending);
    assert.equal(res.structuredContent.reason, undefined);
  });

  test("count matches the list length", async () => {
    const { call } = toolServer();
    const res = await call();
    assert.equal(res.structuredContent.count, res.structuredContent.pending.length);
  });

  test("is not an error result", async () => {
    const { call } = toolServer();
    const res = await call();
    assert.notEqual(res.isError, true);
  });

  test("an empty-but-published index is published: true, count 0 — distinguishable from absence", async () => {
    const { call } = toolServer({ raw: JSON.stringify({ version: 1, generatedAt: "2026-08-19T00:00:00Z", pending: [] }) });
    const res = await call();
    assert.equal(res.structuredContent.published, true);
    assert.equal(res.structuredContent.count, 0);
    assert.deepEqual(res.structuredContent.pending, []);
  });
});

// ── publish → read round-trip against the REAL serializer (#261) ──────────────

describe("round-trips the governance module's own published bytes", () => {
  const items = [
    {
      path: "Projects/alpha.md", title: "alpha", agent: "assent/1", op: "obsidian_append_note",
      when: "2026-08-19T11:34:59.009Z", writeCount: 2, writes: [], hadBaseline: true,
    },
    {
      path: "Archive/old.md", title: "old", agent: "claude", op: "obsidian_write_note",
      when: "2026-08-19T10:00:00.000Z", writeCount: 1, writes: [], hadBaseline: false,
    },
  ];

  test("serializePendingIndex bytes read back as the same entries, published: true", async () => {
    const raw = serializePendingIndex(items, "2026-08-19T12:00:00.000Z");
    const { call } = toolServer({ raw });
    const res = await call();
    assert.equal(res.structuredContent.published, true);
    assert.deepEqual(res.structuredContent.pending, [
      { path: "Projects/alpha.md", status: "pending", agent: "assent/1", op: "obsidian_append_note", when: "2026-08-19T11:34:59.009Z", writeCount: 2 },
      { path: "Archive/old.md", status: "pending", agent: "claude", op: "obsidian_write_note", when: "2026-08-19T10:00:00.000Z", writeCount: 1 },
    ]);
  });

  test("the round-trip still honors the allowlist filter", async () => {
    const raw = serializePendingIndex(items, "2026-08-19T12:00:00.000Z");
    const { call } = toolServer({ raw, settings: { readOnly: false, allowlist: ["Projects"] } });
    const res = await call();
    assert.equal(res.structuredContent.published, true);
    assert.deepEqual(res.structuredContent.pending.map((e) => e.path), ["Projects/alpha.md"]);
  });
});

// ── allowlist filtering (no path oracle) ───────────────────────────────────────

describe("allowlist-filtering drops paths outside the visible set", () => {
  test("a session scoped to Projects/ never learns about Archive/old.md", async () => {
    const { call } = toolServer({ settings: { readOnly: false, allowlist: ["Projects"] } });
    const res = await call();
    const paths = res.structuredContent.pending.map((e) => e.path);
    assert.deepEqual(paths, ["Projects/alpha.md", "Projects/beta.md"]);
    assert.equal(res.structuredContent.count, 2);
    assert.ok(!paths.includes("Archive/old.md"), "hidden path must not appear");
  });

  test("a scope with NO visible pending notes reads as an empty queue", async () => {
    const { call } = toolServer({ settings: { readOnly: false, allowlist: ["Somewhere/Else"] } });
    const res = await call();
    assert.deepEqual(res.structuredContent.pending, []);
    assert.equal(res.structuredContent.count, 0);
  });

  test("filter uses the shared guard rule — same set the read tools honor", async () => {
    // A deeper allowlist prefix that only matches one entry.
    const { call } = toolServer({ settings: { readOnly: false, allowlist: ["Projects/alpha.md"] } });
    const res = await call();
    assert.deepEqual(res.structuredContent.pending.map((e) => e.path), ["Projects/alpha.md"]);
  });

  test("read-only mode does not change the read (it was never a write)", async () => {
    const { call } = toolServer({ settings: { readOnly: true, allowlist: [] } });
    const res = await call();
    assert.equal(res.structuredContent.count, 3);
  });
});

// ── explicit degrade (#261 — absence is NEVER a silent empty queue) ───────────

describe("absent / unreadable index is an EXPLICIT published: false, never a bare empty", () => {
  test("missing file (source ⇒ null) ⇒ published: false with a reason, not an error", async () => {
    const { call } = toolServer({ raw: null });
    const res = await call();
    assert.equal(res.structuredContent.published, false);
    assert.match(res.structuredContent.reason, /not-published/);
    assert.deepEqual(res.structuredContent.pending, []);
    assert.equal(res.structuredContent.count, 0);
    assert.notEqual(res.isError, true);
  });

  test("unparseable JSON ⇒ published: false (unreadable), not an error", async () => {
    const { call } = toolServer({ raw: "{ this is not json" });
    const res = await call();
    assert.equal(res.structuredContent.published, false);
    assert.match(res.structuredContent.reason, /unreadable/);
    assert.deepEqual(res.structuredContent.pending, []);
    assert.notEqual(res.isError, true);
  });

  test("empty string ⇒ published: false (unreadable)", async () => {
    const { call } = toolServer({ raw: "" });
    const res = await call();
    assert.equal(res.structuredContent.published, false);
    assert.match(res.structuredContent.reason, /unreadable/);
    assert.deepEqual(res.structuredContent.pending, []);
  });

  test("a recognizable root with drifted entries is still PUBLISHED (per-entry tolerance)", async () => {
    const { call } = toolServer({ raw: JSON.stringify({ pending: [null, { path: "keep.md" }] }) });
    const res = await call();
    assert.equal(res.structuredContent.published, true);
    assert.deepEqual(res.structuredContent.pending, [{ path: "keep.md" }]);
  });

  test("an unrecognizable root (no pending array) is UNREADABLE, not empty", async () => {
    const { call } = toolServer({ raw: JSON.stringify({ version: 1 }) });
    const res = await call();
    assert.equal(res.structuredContent.published, false);
    assert.match(res.structuredContent.reason, /unreadable/);
  });

  test("a throwing source still degrades to published: false, never an error", async () => {
    const server = fakeServer();
    registerPendingReviewTools(server, {
      source: { read: async () => { throw new Error("adapter blew up"); } },
      getSettings: () => ({ readOnly: false, allowlist: [] }),
    });
    const res = await server.tools.get("obsidian_pending_review").handler({}, {});
    assert.equal(res.structuredContent.published, false);
    assert.deepEqual(res.structuredContent.pending, []);
    assert.notEqual(res.isError, true);
  });

  test("parsePendingIndexStrict: null on non-index text, entries on a real index", () => {
    assert.equal(parsePendingIndexStrict("nope"), null);
    assert.equal(parsePendingIndexStrict(JSON.stringify({ version: 1 })), null);
    assert.equal(parsePendingIndexStrict(JSON.stringify([1, 2])), null);
    assert.deepEqual(parsePendingIndexStrict(JSON.stringify({ pending: [] })), []);
  });
});

// ── schema-drift tolerance ─────────────────────────────────────────────────────

describe("schema-drift tolerance", () => {
  test("missing `pending` ⇒ empty list", () => {
    assert.deepEqual(parsePendingIndex(JSON.stringify({ version: 1 })), []);
  });

  test("`pending` not an array ⇒ empty list", () => {
    assert.deepEqual(parsePendingIndex(JSON.stringify({ pending: "soon" })), []);
    assert.deepEqual(parsePendingIndex(JSON.stringify({ pending: 42 })), []);
    assert.deepEqual(parsePendingIndex(JSON.stringify({ pending: { path: "x.md" } })), []);
  });

  test("non-object root ⇒ empty list", () => {
    assert.deepEqual(parsePendingIndex(JSON.stringify([1, 2, 3])), []);
    assert.deepEqual(parsePendingIndex(JSON.stringify("nope")), []);
    assert.deepEqual(parsePendingIndex(JSON.stringify(null)), []);
  });

  test("unknown top-level fields are ignored; known entries survive", () => {
    const drifted = JSON.stringify({
      version: 99,
      futureField: { nested: true },
      pending: [{ path: "a.md", status: "pending" }],
    });
    assert.deepEqual(parsePendingIndex(drifted), [{ path: "a.md", status: "pending" }]);
  });

  test("unknown per-entry fields are dropped; known fields kept", () => {
    const drifted = JSON.stringify({
      pending: [{ path: "a.md", status: "pending", reviewer: "nelson", priority: 5, writeCount: 2 }],
    });
    assert.deepEqual(parsePendingIndex(drifted), [{ path: "a.md", status: "pending", writeCount: 2 }]);
  });

  test("entries with no path (unfilterable) are dropped, not surfaced", () => {
    const drifted = JSON.stringify({
      pending: [
        { status: "pending", agent: "claude" }, // no path
        { path: "", status: "pending" }, // empty path
        { path: "keep.md", status: "pending" },
      ],
    });
    assert.deepEqual(parsePendingIndex(drifted), [{ path: "keep.md", status: "pending" }]);
  });

  test("non-object array items are skipped", () => {
    const drifted = JSON.stringify({ pending: [null, "x", 3, { path: "keep.md" }] });
    assert.deepEqual(parsePendingIndex(drifted), [{ path: "keep.md" }]);
  });

  test("wrongly-typed known fields are dropped, not coerced", () => {
    const drifted = JSON.stringify({
      pending: [{ path: "a.md", status: 1, writeCount: "three", agent: null }],
    });
    assert.deepEqual(parsePendingIndex(drifted), [{ path: "a.md" }]);
  });

  test("null raw ⇒ empty list", () => {
    assert.deepEqual(parsePendingIndex(null), []);
  });
});

// ── the live adapter's path construction ───────────────────────────────────────

describe("obsidianPendingReviewSource", () => {
  test("reads from <plugin dir>/governance/pending-index.json when the host supplies the dir", async () => {
    const reads = [];
    const fakeApp = {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: async (p) => { reads.push(["exists", p]); return true; },
          read: async (p) => { reads.push(["read", p]); return JSON.stringify(INDEX); },
        },
      },
    };
    const src = obsidianPendingReviewSource(fakeApp, ".obsidian/plugins/vault-mcp");
    const raw = await src.read();
    const expected = `.obsidian/plugins/vault-mcp/${PENDING_INDEX_REL}`;
    assert.deepEqual(reads, [["exists", expected], ["read", expected]]);
    assert.deepEqual(JSON.parse(raw), INDEX);
  });

  test("no plugin dir supplied ⇒ falls back to <configDir>/plugins/governor (not hardwired .obsidian)", async () => {
    const seen = [];
    const fakeApp = {
      vault: {
        configDir: ".my-config",
        adapter: {
          exists: async (p) => { seen.push(p); return true; },
          read: async () => "{}",
        },
      },
    };
    await obsidianPendingReviewSource(fakeApp).read();
    assert.deepEqual(seen, [`.my-config/plugins/governor/${PENDING_INDEX_REL}`]);
  });

  test("absent file ⇒ null (never reads)", async () => {
    let readCalled = false;
    const fakeApp = {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: async () => false,
          read: async () => { readCalled = true; return "x"; },
        },
      },
    };
    const raw = await obsidianPendingReviewSource(fakeApp).read();
    assert.equal(raw, null);
    assert.equal(readCalled, false);
  });

  test("a throwing adapter degrades to null", async () => {
    const fakeApp = {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: async () => { throw new Error("fs error"); },
          read: async () => "x",
        },
      },
    };
    assert.equal(await obsidianPendingReviewSource(fakeApp).read(), null);
  });
});
