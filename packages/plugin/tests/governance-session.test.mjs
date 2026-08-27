/**
 * governance-session.test.mjs — WP5, replica-local sessions (D01).
 *
 * The properties that carry the design: a session is REPLICA-LOCAL and its
 * links transfer no capability; liveness is decided at use against a supplied
 * clock (expiry needs no writer to have happened); transitions are one-way
 * with no resurrect; and the durable store is an append-only event log whose
 * fold survives garbage without inventing sessions.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  openSession,
  isLive,
  livenessOf,
  closeSession,
  revokeSession,
  expireSession,
  SessionNotLiveError,
  SESSION_TTL_MS,
} from "../src/governor/kernel/sessions/session.ts";
import { createSessionStore, foldSessionEvents } from "../src/governor/kernel/sessions/session-store.ts";
import { isUuidV7 } from "../src/governor/kernel/contracts/ids.ts";

const T0 = 1_700_000_000_000;
const RAND = new Uint8Array(10).fill(3);

function open(over = {}, at = T0, rand = RAND) {
  return openSession(
    {
      vaultId: "vault-1",
      replicaId: "install-abc",
      actor: { connection: "conn-1", clientClaim: "claude-code/1.0" },
      journalHead: "2026-08.jsonl:1234",
      scopeDigest: "d".repeat(64),
      ...over,
    },
    at,
    rand
  );
}

// ── the session object ───────────────────────────────────────────────────────

describe("session — replica-local by construction", () => {
  test("opens with a UUIDv7 id, bound to vault, replica, actor, base state, and scope", () => {
    const s = open();
    assert.ok(isUuidV7(s.id));
    assert.equal(s.vaultId, "vault-1");
    assert.equal(s.replicaId, "install-abc");
    assert.equal(s.actor.connection, "conn-1");
    assert.equal(s.baseState.journalHead, "2026-08.jsonl:1234");
    assert.equal(s.scopeDigest, "d".repeat(64));
    assert.equal(s.status, "open");
    assert.equal(s.expiresAt, T0 + SESSION_TTL_MS);
  });

  test("no mandate at open — activation is a separate human act", () => {
    assert.equal(open().mandateId, null);
    // The input type has no mandate field at all; this is the runtime echo of
    // that structural absence.
  });

  test("a continuation link transfers NO capability — nothing is inherited through it", () => {
    const first = open({ scopeDigest: "a".repeat(64) });
    // Opening a linked session REQUIRES its own scope, actor, base state —
    // there is no field to inherit through, which is the enforcement.
    // A later clock tick — two sessions minted at the same injected time with
    // the same injected randomness would share a UUIDv7, which is a property
    // of the determinism injection, not of sessions.
    const linked = open({ continuedFrom: first.id, scopeDigest: "b".repeat(64) }, T0 + 1);
    assert.equal(linked.continuedFrom, first.id);
    assert.notEqual(linked.scopeDigest, first.scopeDigest, "scope came from the new opening, not the link");
    assert.notEqual(linked.id, first.id);
    assert.equal(linked.mandateId, null, "no mandate travels through a link");
  });
});

describe("session — liveness is decided at use", () => {
  test("open and unexpired is live; past expiry is not, with no writer needed", () => {
    const s = open();
    assert.ok(isLive(s, T0 + 1000));
    assert.ok(!isLive(s, T0 + SESSION_TTL_MS), "expiry boundary is exclusive");
    assert.equal(livenessOf(s, T0 + SESSION_TTL_MS), "expired");
    assert.equal(livenessOf(s, T0 + 1), "open");
  });

  test("closed and revoked are never live, regardless of clock", () => {
    const s = open();
    assert.ok(!isLive(closeSession(s), T0 + 1));
    assert.ok(!isLive(revokeSession(s, "operator request"), T0 + 1));
  });
});

describe("session — transitions are one-way", () => {
  test("closing a closed session refuses with the typed error", () => {
    const closed = closeSession(open());
    assert.throws(() => closeSession(closed), SessionNotLiveError);
  });

  test("a revoked session stays revoked — revoke is idempotent, nothing resurrects", () => {
    const revoked = revokeSession(open(), "compromised");
    assert.equal(revokeSession(revoked, "again").status, "revoked");
    assert.equal(revoked.revokedReason, "compromised");
    assert.throws(() => closeSession(revoked), SessionNotLiveError);
  });

  test("expiry is explicit and refuses before its time", () => {
    const s = open();
    assert.throws(() => expireSession(s, T0 + 10));
    assert.equal(expireSession(s, T0 + SESSION_TTL_MS).status, "expired");
  });
});

// ── the durable store ────────────────────────────────────────────────────────

function memoryIo() {
  const lines = [];
  return {
    lines,
    async appendLine(line) {
      lines.push(line);
    },
    async readLines() {
      return [...lines];
    },
  };
}

describe("session store — append-only events, folded state", () => {
  test("open → get returns the session; close and revoke advance it durably", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    const s = open();
    await store.open(s, T0);
    assert.deepEqual(await store.get(s.id), s);

    await store.close(s.id, T0 + 100);
    assert.equal((await store.get(s.id)).status, "closed");

    // Every mutation is an APPENDED event — nothing rewritten.
    assert.equal(io.lines.length, 2);
    assert.match(io.lines[0], /"opened"/);
    assert.match(io.lines[1], /"closed"/);
  });

  test("a fresh store instance folds the same state from the same lines — restart survives", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    const s = open();
    await store.open(s, T0);
    await store.revoke(s.id, "operator", T0 + 5);

    const rebooted = createSessionStore(io);
    const after = await rebooted.get(s.id);
    assert.equal(after.status, "revoked");
    assert.equal(after.revokedReason, "operator");
  });

  test("markExpired records the observed expiry once; terminal states are left alone", async () => {
    const io = memoryIo();
    const store = createSessionStore(io);
    const s = open();
    await store.open(s, T0);
    await store.markExpired(s.id, T0 + SESSION_TTL_MS + 1);
    assert.equal((await store.get(s.id)).status, "expired");
    await store.markExpired(s.id, T0 + SESSION_TTL_MS + 2); // idempotent no-op
    assert.equal(io.lines.filter((l) => l.includes("expired")).length, 1);
  });

  test("duplicate open refuses; transitions on unknown ids refuse", async () => {
    const store = createSessionStore(memoryIo());
    const s = open();
    await store.open(s, T0);
    await assert.rejects(() => store.open(s, T0));
    await assert.rejects(() => store.close("no-such-id", T0), SessionNotLiveError);
    await assert.rejects(() => store.revoke("no-such-id", "x", T0), SessionNotLiveError);
  });
});

describe("session store — the fold survives garbage", () => {
  test("an unparseable line is skipped without losing prior sessions", () => {
    const s = open();
    const m = foldSessionEvents([JSON.stringify({ kind: "opened", at: T0, session: s }), "{corrupt", ""]);
    assert.equal(m.get(s.id)?.status, "open");
  });

  test("an event for an unknown session is ignored, never invented", () => {
    const m = foldSessionEvents([JSON.stringify({ kind: "closed", at: T0, sessionId: "ghost" })]);
    assert.equal(m.size, 0);
  });

  test("colliding history keeps the stronger state — a close after a revoke does not downgrade", () => {
    const s = open();
    const m = foldSessionEvents([
      JSON.stringify({ kind: "opened", at: T0, session: s }),
      JSON.stringify({ kind: "revoked", at: T0 + 1, sessionId: s.id, reason: "r" }),
      JSON.stringify({ kind: "closed", at: T0 + 2, sessionId: s.id }),
    ]);
    assert.equal(m.get(s.id)?.status, "revoked");
  });
});

// ── the dequeue check, behaviorally ──────────────────────────────────────────

describe("session liveness at dequeue — behavioral, not just a source pin", async () => {
  const { z } = await import("zod");
  const { makeGuarded, withKernelArgs } = await import("../src/mcp/guarded.ts");
  const { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } = await import("../src/kernel/index.ts");

  function fakeAdapter() {
    const files = new Map();
    return {
      async exists(p) { return files.has(p); },
      async mkdir() {},
      async write(p, d) { files.set(p, d); },
      async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
    };
  }
  const RW_DEF = { title: "w", description: "", annotations: { readOnlyHint: false } };
  const ACTOR = { transport: "mcp", connection: "c-1" };

  function fixture(liveness) {
    const kernel = new Kernel(new WriteQueue(1000), new WriteJournal(fakeAdapter(), "dir/journal"), null, new IdempotencyStore(), new LockStore());
    const seen = [];
    const guarded = makeGuarded({ getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR, sessionLive: liveness });
    const wrapped = guarded(withKernelArgs({ ...RW_DEF, inputSchema: { path: z.string() } }), async (args) => {
      seen.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    }, "obsidian_write_note");
    return { seen, call: (args) => wrapped(args, {}) };
  }

  test("a mutation whose session died refuses at dequeue with session_not_live — the handler never runs", async () => {
    // Async liveness, as the production path is: the check consults the
    // durable store, where a human's revocation lands.
    const { seen, call } = fixture(async () => ({ live: false, status: "revoked", sessionId: "s-1" }));
    const res = await call({ path: "A.md" });
    assert.ok(res.isError, "refused");
    assert.match(res.content[0].text, /session_not_live/);
    assert.match(res.content[0].text, /revoked/);
    assert.equal(seen.length, 0, "the handler never executed");
  });

  test("a live session's mutation proceeds untouched", async () => {
    const { seen, call } = fixture(async () => ({ live: true, status: "open", sessionId: "s-1" }));
    const res = await call({ path: "A.md" });
    assert.ok(!res.isError);
    assert.equal(seen.length, 1);
  });

  test("no session machinery at all means no check — tests and embeds keep working", async () => {
    const { seen, call } = fixture(undefined);
    const res = await call({ path: "A.md" });
    assert.ok(!res.isError);
    assert.equal(seen.length, 1);
  });
});

// ── the wiring, pinned at the source ─────────────────────────────────────────

describe("session wiring — pinned, because unwired machinery is the known failure mode", async () => {
  const fs = await import("node:fs");

  test("server.ts mints the session, threads it into the executor, journal actor, and dequeue check", () => {
    const server = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    assert.match(server, /openSession\(/, "the connection opens a session");
    assert.match(server, /sessionId: \(\) => session\?\.id \?\? null/, "the executor learns the session id");
    assert.match(server, /session: session\.id/, "the journal actor carries it");
    assert.match(server, /sessionLive,/, "the dequeue liveness check is wired into guardedOpts");
    assert.match(server, /onclose/, "the transport close ends the session");
  });

  test("main.ts wires the durable store into ctx", () => {
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    assert.match(main, /createSessionStore\(/);
    assert.match(main, /sessions\.jsonl/);
    assert.match(main, /journalHead: \(\) => journalHeadMarker\(\)/, "the base-state head marker is real, not a null stub");
  });

  test("the dequeue liveness check consults the STORE — revocation must reach a live connection", () => {
    // The first draft checked only the closure-captured session object, whose
    // status nothing ever mutates — a store-level revoke would never have
    // reached it, and only wall-clock expiry could refuse.
    const server = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    assert.match(server, /await ctx\.sessions\.get\(session\.id\)/, "sessionLive re-reads the folded store state");
  });
});
