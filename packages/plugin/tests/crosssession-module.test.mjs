/**
 * crosssession-module.test.mjs — the cross-session channel module (#232):
 * kernel/crosssession/* (parsing, ordering, unread computation, receipts) and
 * mcp/tools-crosssession.ts (the four tools), all headless.
 *
 * Covered:
 *   • entry parsing over REAL-SHAPED fixtures: frontmatter, the live file's
 *     rules preamble (plain `##` headings are not entries), EVENT segments,
 *     imprecise `:2x` stamps, per-message-note filenames;
 *   • stamp ordering as OPAQUE strings (orderKey; file form vs filename form);
 *   • discovery by fileclass + `audience:` frontmatter — never by path;
 *   • delta correctness: position tracking, the cap + `more` marker, own
 *     entries exempt;
 *   • attest round-trip + disk persistence (ReceiptStore over a fake adapter);
 *   • post: happy path THROUGH the guarded registrar (fake kernel — the
 *     journal record lands), the typed `stale_read` refusal with nothing
 *     written, read-only mode blocking, no_log_file / log_ambiguous;
 *   • allowlist: a hidden channel is invisible (absent from discovery,
 *     `channel_unresolved` to delta/attest/post), a hidden member file
 *     contributes no entries.
 *
 * NOT covered (un-headless — verify live): obsidianCrosssessionSource /
 * obsidianReceiptStore, the duck-typed Obsidian adapters.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  orderKey,
  stripFrontmatter,
  parseLogEntries,
  parseMessageNote,
  sortEntries,
  unreadFor,
  newestStamp,
  discoverChannels,
  fileClassMatches,
  ReceiptStore,
  memoryReceiptStore,
} from "../src/kernel/crosssession/index.ts";
import {
  registerCrosssessionTools,
  formatEntryStamp,
  handleRefusal,
  bodyRefusal,
  emptyCrosssessionSource,
} from "../src/mcp/tools-crosssession.ts";
import { visiblePaths } from "../src/guard.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } from "../src/kernel/index.ts";
import { fakeServer } from "./fake-server.mjs";

// ── fixtures: a real-shaped fleet channel + a per-project channel ────────────

const FLEET_DIR = "00-09 System/03 Agents/03.16 Cross-session log";
const FLEET_NOTE = `${FLEET_DIR}/03.16 Cross-session log.md`;
const FLEET_LOG = `${FLEET_DIR}/CROSS-SESSION.md`;
const FLEET_MSG = `${FLEET_DIR}/2026-08-18T1500 · tracker.md`;
const PROJ_DIR = "Projects/widget/.02 Tasks/Widget log";
const PROJ_NOTE = `${PROJ_DIR}/Widget log.md`;
const PROJ_LOG = `${PROJ_DIR}/LOG.md`;

// Mirrors the live CROSS-SESSION.md's quirks: frontmatter, a rules document as
// preamble (plain `##` headings carry no ` · ` and are NOT entries), an entry
// heading with an EVENT segment, an imprecise `:2x` stamp, and a plain `##`
// heading INSIDE an entry body.
const FLEET_LOG_TEXT = `---
name: CROSS-SESSION
uid: 019fe8ce-0660-7d53-9142-925127ff98c8
tags: []
---

# CROSS-SESSION

A coordination event log, not a group chat.

## Principle

Post only information that can change another live session's behavior.

## Message format

\`\`\`
## <ISO timestamp> · <handle> · <EVENT>
\`\`\`

## 2026-08-18T13:40 · alpha · CLAIM

**Scope:** issue 232

Taking the build.

## 2026-08-18T14:2x · beta

Imprecise stamp — some of us post these.

## Note

A plain heading inside an entry stays in that entry's body.

## 2026-08-18T15:10 · alpha

Third entry.

\`\`\`
## 2026-08-18T15:11 · phantom
\`\`\`
`;

const FLEET_MSG_TEXT = `---
uid: 01a015ed-5b49-78c0-a8a3-e26003e51248
fileClass: Agent/Log/CrossSession
---

Per-message note body.
`;

const PROJ_LOG_TEXT = `## 2026-08-01T09:00 · alpha

Project channel entry.
`;

function fixtureFiles() {
  return {
    [FLEET_NOTE]: "# folder note\n",
    [FLEET_LOG]: FLEET_LOG_TEXT,
    [FLEET_MSG]: FLEET_MSG_TEXT,
    [PROJ_NOTE]: "# project log folder note\n",
    [PROJ_LOG]: PROJ_LOG_TEXT,
    "Projects/widget/README.md": "not a channel\n",
  };
}

const FLEET_UID = "01a015f2-55e0-7b02-ba58-850180d6ee69";

function fixtureFms() {
  return {
    [FLEET_NOTE]: { fileClass: "Collection/Log", audience: "fleet", uid: FLEET_UID },
    [FLEET_MSG]: { fileClass: "Agent/Log/CrossSession" },
    [PROJ_NOTE]: { fileClass: "Collection/Log", audience: "project", projects: ["[[Widget]]"] },
    // A path-lookalike that must NEVER be discovered by its name alone: right
    // shape of folder, no channel fileclass/audience frontmatter.
    "Projects/widget/README.md": { fileClass: "Note" },
  };
}

function fakeSource(files, fms) {
  return {
    paths: () => Object.keys(files),
    frontmatter: (p) => fms[p] ?? null,
    read: async (p) => files[p] ?? null,
    append: async (p, text) => {
      if (!(p in files)) throw new Error(`not a note: ${p}`);
      const d = files[p];
      files[p] = (d === "" || d.endsWith("\n") ? d : d + "\n") + text;
    },
  };
}

const NOW = () => new Date(2026, 7, 18, 16, 0); // local 2026-08-18T16:00

function build({ files = fixtureFiles(), fms = fixtureFms(), allowlist, config = {}, receipts = memoryReceiptStore(), now = NOW } = {}) {
  const server = fakeServer();
  const source = fakeSource(files, fms);
  const settings = { readOnly: false, allowlist: allowlist ?? [] };
  registerCrosssessionTools(server, source, {
    config,
    getSettings: () => settings,
    visible: (paths) => visiblePaths(paths, settings),
    receipts,
    now,
  });
  const call = (name, args = {}) => server.tools.get(name).handler(args);
  return { server, source, files, receipts, call };
}

const errText = (res) => res.content[0].text;

// ── entry parsing ────────────────────────────────────────────────────────────

describe("parseLogEntries over the real-shaped fleet log", () => {
  const entries = parseLogEntries(FLEET_LOG_TEXT, FLEET_LOG);

  test("finds exactly the three entries, in file order — the rules preamble is not entries", () => {
    assert.deepEqual(entries.map((e) => e.stamp), ["2026-08-18T13:40", "2026-08-18T14:2x", "2026-08-18T15:10"]);
    assert.deepEqual(entries.map((e) => e.handle), ["alpha", "beta", "alpha"]);
  });

  test("an EVENT segment lands in `event`, not in the handle", () => {
    assert.equal(entries[0].handle, "alpha");
    assert.equal(entries[0].event, "CLAIM");
    assert.equal(entries[1].event, undefined);
  });

  test("a plain `##` heading inside an entry stays in that entry's body", () => {
    assert.ok(entries[1].body.includes("## Note"));
    assert.ok(entries[1].body.includes("stays in that entry's body"));
  });

  test("bodies are captured in full", () => {
    assert.ok(entries[0].body.includes("**Scope:** issue 232"));
    assert.ok(entries[0].body.includes("Taking the build."));
    assert.ok(entries[2].body.startsWith("Third entry."));
  });

  test("a fenced heading is never an entry — preamble fence and in-entry fence alike", () => {
    // The live file's Message-format section contains a fenced literal
    // `## <ISO timestamp> · <handle> · <EVENT>` line, and the fixture's third
    // entry carries a fenced heading-shaped line too: code-fence tracking
    // keeps both as content (the count of 3 above pins the preamble case).
    assert.ok(!entries.some((e) => e.stamp.includes("<ISO")));
    assert.ok(!entries.some((e) => e.handle === "phantom"));
    assert.ok(entries[2].body.includes("phantom"));
  });

  test("frontmatter is stripped, not parsed as entries", () => {
    assert.ok(!entries.some((e) => e.stamp.includes("uid")));
  });
});

describe("parseMessageNote", () => {
  test("stamp + handle from the filename, body minus frontmatter", () => {
    const e = parseMessageNote(FLEET_MSG, FLEET_MSG_TEXT);
    assert.equal(e.stamp, "2026-08-18T1500");
    assert.equal(e.handle, "tracker");
    assert.equal(e.body, "Per-message note body.");
    assert.equal(e.form, "note");
  });

  test("a filename without the separator is not a message", () => {
    assert.equal(parseMessageNote("dir/README.md", "x"), null);
  });
});

describe("stamps are opaque ordered strings (orderKey)", () => {
  test("the file form and the filename form of one minute compare equal", () => {
    assert.equal(orderKey("2026-08-18T13:40"), orderKey("2026-08-18T1340"));
  });

  test("an imprecise `:2x` stamp orders deterministically after `:25`", () => {
    assert.ok(orderKey("2026-08-18T14:2x") > orderKey("2026-08-18T14:25"));
  });

  test("sortEntries merges forms by key, stable", () => {
    const sorted = sortEntries([
      { stamp: "2026-08-18T15:10", handle: "a", body: "", source: "l", form: "log" },
      { stamp: "2026-08-18T13:40", handle: "a", body: "", source: "l", form: "log" },
      { stamp: "2026-08-18T1500", handle: "t", body: "", source: "n", form: "note" },
    ]);
    assert.deepEqual(sorted.map((e) => e.stamp), ["2026-08-18T13:40", "2026-08-18T1500", "2026-08-18T15:10"]);
  });

  test("stripFrontmatter leaves an unterminated opener alone", () => {
    assert.equal(stripFrontmatter("---\nno close"), "---\nno close");
  });
});

describe("unreadFor", () => {
  const entries = parseLogEntries(FLEET_LOG_TEXT, FLEET_LOG);

  test("no receipt: every foreign entry is unread; own entries exempt", () => {
    assert.equal(unreadFor(entries, null, "gamma").length, 3);
    assert.deepEqual(unreadFor(entries, null, "alpha").map((e) => e.stamp), ["2026-08-18T14:2x"]);
  });

  test("a receipt covers everything at or before it", () => {
    assert.deepEqual(unreadFor(entries, "2026-08-18T14:2x", "gamma").map((e) => e.stamp), ["2026-08-18T15:10"]);
    assert.equal(unreadFor(entries, "2026-08-18T15:10", "gamma").length, 0);
  });

  test("newestStamp is the channel-order maximum", () => {
    assert.equal(newestStamp(entries), "2026-08-18T15:10");
    assert.equal(newestStamp([]), null);
  });
});

// ── discovery ────────────────────────────────────────────────────────────────

describe("channel discovery is by frontmatter, never by path", () => {
  test("finds fleet + project channels; skips notes without fileclass/audience", () => {
    const chans = discoverChannels(Object.keys(fixtureFiles()), (p) => fixtureFms()[p] ?? null, "Collection/Log");
    assert.deepEqual(chans.map((c) => [c.audience, c.path]), [
      ["fleet", FLEET_NOTE],
      ["project", PROJ_NOTE],
    ]);
    assert.equal(chans[0].uid, FLEET_UID);
    assert.deepEqual(chans[1].projects, ["[[Widget]]"]);
  });

  test("an audience-less Collection/Log note is not a channel; an array fileClass matches", () => {
    const chans = discoverChannels(
      ["a/x/x.md", "b/y/y.md"],
      (p) =>
        p === "a/x/x.md"
          ? { fileClass: "Collection/Log" } // no audience
          : { fileClass: ["Something", "Collection/Log"], audience: "fleet" },
      "Collection/Log",
    );
    assert.deepEqual(chans.map((c) => c.path), ["b/y/y.md"]);
    assert.ok(fileClassMatches(["Collection/Log"], "Collection/Log"));
    assert.ok(!fileClassMatches(undefined, "Collection/Log"));
  });

  test("crosssession_channels reports uid, audience, projects, entry count, newest stamp", async () => {
    const { call } = build();
    const res = await call("crosssession_channels");
    const chans = res.structuredContent.channels;
    assert.equal(chans.length, 2);
    const fleet = chans.find((c) => c.audience === "fleet");
    assert.equal(fleet.uid, FLEET_UID);
    assert.equal(fleet.entry_count, 4); // 3 log sections + 1 per-message note
    assert.equal(fleet.newest_stamp, "2026-08-18T15:10");
    assert.deepEqual(fleet.log_files, [FLEET_LOG]);
    const proj = chans.find((c) => c.audience === "project");
    assert.deepEqual(proj.projects, ["[[Widget]]"]);
    assert.equal(proj.entry_count, 1);
  });

  test("with a handle: read position + unread count; receipts list which handles are behind", async () => {
    const receipts = memoryReceiptStore();
    const { call } = build({ receipts });
    await call("crosssession_attest", { handle: "beta", channel: FLEET_UID, through_stamp: "2026-08-18T13:40" });
    const res = await call("crosssession_channels", { handle: "gamma" });
    const fleet = res.structuredContent.channels.find((c) => c.audience === "fleet");
    assert.equal(fleet.read_position, null);
    assert.equal(fleet.unread_count, 4);
    // beta attested through 13:40: behind by 15:00 (note) + 15:10 — its own
    // 14:2x entry is exempt.
    assert.deepEqual(fleet.receipts, [
      { handle: "beta", through: "2026-08-18T13:40", at: NOW().toISOString(), behind: 2 },
    ]);
  });
});

// ── delta ────────────────────────────────────────────────────────────────────

describe("crosssession_delta", () => {
  test("serves every foreign entry oldest-first when no receipt exists, both forms merged", async () => {
    const { call } = build();
    const res = await call("crosssession_delta", { handle: "gamma", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.equal(ch.read_position, null);
    assert.deepEqual(ch.entries.map((e) => [e.stamp, e.handle, e.form]), [
      ["2026-08-18T13:40", "alpha", "log"],
      ["2026-08-18T14:2x", "beta", "log"],
      ["2026-08-18T1500", "tracker", "note"],
      ["2026-08-18T15:10", "alpha", "log"],
    ]);
    assert.equal(ch.entries[0].body.includes("Taking the build."), true);
    assert.equal(ch.more, false);
  });

  test("own entries are exempt", async () => {
    const { call } = build();
    const res = await call("crosssession_delta", { handle: "alpha", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.deepEqual(ch.entries.map((e) => e.handle), ["beta", "tracker"]);
  });

  test("position tracking: attest moves the cursor", async () => {
    const { call } = build();
    await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T14:2x" });
    const res = await call("crosssession_delta", { handle: "gamma", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.equal(ch.read_position, "2026-08-18T14:2x");
    assert.deepEqual(ch.entries.map((e) => e.stamp), ["2026-08-18T1500", "2026-08-18T15:10"]);
  });

  test("the cap truncates with more:true + next_stamp, and attest-then-again continues", async () => {
    const { call } = build({ config: { deltaCap: 2 } });
    const res = await call("crosssession_delta", { handle: "gamma", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.equal(ch.unread_count, 4);
    assert.equal(ch.entries.length, 2);
    assert.equal(ch.more, true);
    assert.equal(ch.next_stamp, "2026-08-18T14:2x");
    await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: ch.next_stamp });
    const res2 = await call("crosssession_delta", { handle: "gamma", channel: FLEET_UID });
    const [ch2] = res2.structuredContent.channels;
    assert.deepEqual(ch2.entries.map((e) => e.stamp), ["2026-08-18T1500", "2026-08-18T15:10"]);
    assert.equal(ch2.more, false);
  });

  test("channel accepts uid, folder-note path, or folder; omit ⇒ all visible channels", async () => {
    const { call } = build();
    for (const ref of [FLEET_UID, FLEET_NOTE, FLEET_DIR]) {
      const res = await call("crosssession_delta", { handle: "gamma", channel: ref });
      assert.equal(res.structuredContent.channels[0].channel.uid, FLEET_UID, `ref: ${ref}`);
    }
    const all = await call("crosssession_delta", { handle: "gamma" });
    assert.equal(all.structuredContent.channels.length, 2);
  });

  test("an unknown channel is a typed channel_unresolved refusal", async () => {
    const { call } = build();
    const res = await call("crosssession_delta", { handle: "gamma", channel: "no-such-uid" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [channel_unresolved]:"));
  });

  test("a malformed handle is a typed invalid_handle refusal", async () => {
    const { call } = build();
    const res = await call("crosssession_delta", { handle: "a · b", channel: FLEET_UID });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [invalid_handle]:"));
  });
});

// ── attest ───────────────────────────────────────────────────────────────────

describe("crosssession_attest", () => {
  test("round-trip: attest is readable back and keyed by channel UID", async () => {
    const receipts = memoryReceiptStore();
    const { call } = build({ receipts });
    const res = await call("crosssession_attest", { handle: "gamma", channel: FLEET_NOTE, through_stamp: "2026-08-18T15:10" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.unread_after, 0);
    // Keyed by the channel's uid (a reorg move keeps read state), even though
    // the caller addressed it by path.
    assert.equal((await receipts.get(FLEET_UID, "gamma")).through, "2026-08-18T15:10");
  });

  test("attesting ahead of the newest entry refuses stamp_ahead", async () => {
    const { call } = build();
    const res = await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T23:59" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [stamp_ahead]:"));
  });

  test("attesting an empty channel refuses stamp_ahead (nothing to attest)", async () => {
    const files = { "c/c.md": "# note\n" };
    const fms = { "c/c.md": { fileClass: "Collection/Log", audience: "fleet", uid: "u-empty" } };
    const { call } = build({ files, fms });
    const res = await call("crosssession_attest", { handle: "g", channel: "u-empty", through_stamp: "2026-08-18T00:00" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [stamp_ahead]:"));
  });

  test("a channel without a uid keys receipts by path", async () => {
    const receipts = memoryReceiptStore();
    const { call } = build({ receipts });
    await call("crosssession_attest", { handle: "g", channel: PROJ_NOTE, through_stamp: "2026-08-01T09:00" });
    assert.equal((await receipts.get(`path:${PROJ_NOTE}`, "g")).through, "2026-08-01T09:00");
  });
});

describe("ReceiptStore persistence (module state, on disk beside the journal)", () => {
  function diskAdapter() {
    const files = new Map();
    const dirs = new Set(["plugdir"]);
    return {
      files,
      async exists(p) { return files.has(p) || dirs.has(p); },
      async read(p) { return files.get(p); },
      async mkdir(p) { dirs.add(p); },
      async write(p, d) { files.set(p, d); },
    };
  }

  test("a receipt written by one store instance is read by a fresh one (per-connection stores share the file)", async () => {
    const adapter = diskAdapter();
    const a = new ReceiptStore(adapter, "plugdir");
    await a.set("uid-1", "gamma", "2026-08-18T14:00", "2026-08-18T16:00:00.000Z");
    const b = new ReceiptStore(adapter, "plugdir");
    assert.deepEqual(await b.get("uid-1", "gamma"), { through: "2026-08-18T14:00", at: "2026-08-18T16:00:00.000Z" });
    assert.ok(adapter.files.has("plugdir/crosssession-receipts.json"));
  });

  test("a corrupt state file degrades to empty instead of failing the operation", async () => {
    const adapter = diskAdapter();
    adapter.files.set("plugdir/crosssession-receipts.json", "{not json");
    const store = new ReceiptStore(adapter, "plugdir");
    const orig = console.error;
    console.error = () => {};
    try {
      assert.equal(await store.get("uid-1", "gamma"), null);
      await store.set("uid-1", "gamma", "2026-08-18T14:00", "t");
    } finally {
      console.error = orig;
    }
    assert.equal((await store.get("uid-1", "gamma")).through, "2026-08-18T14:00");
  });
});

// ── post ─────────────────────────────────────────────────────────────────────

describe("crosssession_post", () => {
  test("happy path: appends one `## <stamp> · <handle>` section and auto-attests through it", async () => {
    const receipts = memoryReceiptStore();
    const { call, files } = build({ receipts });
    await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const res = await call("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "FINDING — all clear." });
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.posted, {
      channel: { uid: FLEET_UID, path: FLEET_NOTE },
      path: FLEET_LOG,
      stamp: "2026-08-18T16:00",
      handle: "gamma",
    });
    assert.ok(files[FLEET_LOG].endsWith("\n## 2026-08-18T16:00 · gamma\n\nFINDING — all clear.\n"));
    // Auto-attested: an immediate second post needs no interleaved attest.
    assert.equal(res.structuredContent.attested_through, "2026-08-18T16:00");
    assert.equal((await receipts.get(FLEET_UID, "gamma")).through, "2026-08-18T16:00");
    const again = await call("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "Second." });
    assert.equal(again.isError, undefined);
  });

  test("stale poster: typed stale_read refusal BEFORE any write — the file is untouched", async () => {
    const { call, files } = build();
    const before = files[FLEET_LOG];
    const res = await call("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "I did not read." });
    assert.equal(res.isError, true);
    const text = errText(res);
    assert.ok(text.startsWith("Error [stale_read]:"), text);
    assert.ok(text.includes("4 entries"));
    assert.ok(text.includes("2026-08-18T13:40 · alpha"));
    assert.equal(files[FLEET_LOG], before, "nothing may be written on a stale refusal");
  });

  test("a partially-behind receipt still refuses, naming only the uncovered entries", async () => {
    const { call, files } = build();
    const before = files[FLEET_LOG];
    await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T14:2x" });
    const res = await call("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "Still behind." });
    assert.equal(res.isError, true);
    const text = errText(res);
    assert.ok(text.startsWith("Error [stale_read]:"));
    assert.ok(text.includes("2 entries"));
    assert.ok(!text.includes("13:40"), "covered entries are not renamed in the refusal");
    assert.equal(files[FLEET_LOG], before);
  });

  test("the poster's own entries are exempt from staleness", async () => {
    const { call } = build();
    // alpha attests through beta's 14:2x; the only remaining foreign entry is
    // tracker's 15:00 note... so attest through 15:00; alpha's own 15:10 entry
    // must NOT block the post.
    await call("crosssession_attest", { handle: "alpha", channel: FLEET_UID, through_stamp: "2026-08-18T1500" });
    const res = await call("crosssession_post", { handle: "alpha", channel: FLEET_UID, body: "Own entries exempt." });
    assert.equal(res.isError, undefined);
  });

  test("a channel with no log file refuses no_log_file", async () => {
    const files = { "c/c.md": "# note\n", [`c/2026-08-18T1200 · x.md`]: "msg\n" };
    const fms = {
      "c/c.md": { fileClass: "Collection/Log", audience: "fleet", uid: "u-nolog" },
      [`c/2026-08-18T1200 · x.md`]: { fileClass: "Agent/Log/CrossSession" },
    };
    const { call } = build({ files, fms });
    await call("crosssession_attest", { handle: "g", channel: "u-nolog", through_stamp: "2026-08-18T1200" });
    const res = await call("crosssession_post", { handle: "g", channel: "u-nolog", body: "x" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [no_log_file]:"));
  });

  test("a stray entry-less note does not make the log ambiguous; two real logs do", async () => {
    const files = fixtureFiles();
    const fms = fixtureFms();
    files[`${FLEET_DIR}/scratch.md`] = "no entries here\n";
    const { call, files: f1 } = build({ files, fms });
    await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const ok1 = await call("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "Narrowed to the real log." });
    assert.equal(ok1.isError, undefined);
    assert.ok(f1[FLEET_LOG].includes("Narrowed to the real log."));
    assert.ok(!f1[`${FLEET_DIR}/scratch.md`].includes("Narrowed"));

    const files2 = fixtureFiles();
    files2[`${FLEET_DIR}/SECOND-LOG.md`] = "## 2026-08-18T10:00 · x\n\nentry\n";
    const { call: call2 } = build({ files: files2, fms: fixtureFms() });
    await call2("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const res2 = await call2("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "x" });
    assert.equal(res2.isError, true);
    assert.ok(errText(res2).startsWith("Error [log_ambiguous]:"));
  });

  test("a body that would parse as an entry heading refuses invalid_body", async () => {
    const { call } = build();
    await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const res = await call("crosssession_post", {
      handle: "gamma",
      channel: FLEET_UID,
      body: "Quoting:\n## 2026-08-18T13:40 · alpha\nphantom",
    });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [invalid_body]:"));
  });
});

// ── allowlist discipline ─────────────────────────────────────────────────────

describe("allowlist: a hidden channel is invisible, not refused-by-name", () => {
  test("discovery omits a channel whose folder note is outside the allowlist", async () => {
    const { call } = build({ allowlist: ["Projects"] });
    const res = await call("crosssession_channels");
    assert.deepEqual(res.structuredContent.channels.map((c) => c.audience), ["project"]);
  });

  test("delta/attest/post answer channel_unresolved for a hidden channel — same as nonexistent", async () => {
    const { call } = build({ allowlist: ["Projects"] });
    for (const [tool, args] of [
      ["crosssession_delta", { handle: "g", channel: FLEET_UID }],
      ["crosssession_attest", { handle: "g", channel: FLEET_UID, through_stamp: "2026-08-18T13:40" }],
      ["crosssession_post", { handle: "g", channel: FLEET_UID, body: "x" }],
    ]) {
      const res = await call(tool, args);
      assert.equal(res.isError, true, tool);
      assert.ok(errText(res).startsWith("Error [channel_unresolved]:"), tool);
    }
  });

  test("a hidden member file contributes no entries even when the channel is visible", async () => {
    // Allowlist admits the folder note + the log file but NOT the per-message
    // note: its entry must vanish from counts and deltas alike.
    const { call } = build({ allowlist: [FLEET_NOTE, FLEET_LOG] });
    const res = await call("crosssession_delta", { handle: "gamma", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.ok(!ch.entries.some((e) => e.handle === "tracker"));
    assert.equal(ch.entries.length, 3);
  });
});

// ── the guarded path: queue + journal bind on post/attest ────────────────────

describe("post through the guarded registrar (fake kernel): the journal record lands", () => {
  function journalAdapter() {
    const files = new Map();
    const dirs = new Set();
    return {
      files,
      async exists(p) { return files.has(p) || dirs.has(p); },
      async read(p) { return files.get(p); },
      async mkdir(p) { dirs.add(p); },
      async write(p, d) { files.set(p, d); },
      async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
    };
  }
  const records = (adapter) =>
    (adapter.files.get("dir/journal/2026-08.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // The journal append settles on its own microtask chain after the call's
  // envelope returns — give it a macrotask turn before reading records.
  const settle = () => new Promise((r) => setTimeout(r, 5));

  function guardedBuild({ readOnly = false } = {}) {
    const adapter = journalAdapter();
    const kernel = new Kernel(
      new WriteQueue(1000),
      new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-18T12:00:00Z")),
      { uid: () => undefined, rev: () => undefined },
      new IdempotencyStore(),
      new LockStore(),
    );
    const settings = { readOnly, allowlist: [] };
    const guarded = makeGuarded({
      getSettings: () => settings,
      kernel,
      actor: () => ({ transport: "mcp", client: "test/1.0", connection: "c1" }),
    });
    const server = fakeServer();
    const files = fixtureFiles();
    const source = fakeSource(files, fixtureFms());
    const receipts = memoryReceiptStore();
    registerCrosssessionTools(
      { registerTool: (n, d, h) => server.registerTool(n, d, guarded(d, h, n)) },
      source,
      { config: {}, visible: (p) => visiblePaths(p, settings), receipts, now: NOW },
    );
    return { server, files, adapter, receipts, call: (n, a) => server.tools.get(n).handler(a) };
  }

  test("a guarded post takes a queue slot and journals op=crosssession_post, outcome ok", async () => {
    const { call, files, adapter } = guardedBuild();
    const attest = await call("crosssession_attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    assert.equal(attest.isError, undefined);
    const res = await call("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "Through the guard." });
    assert.equal(res.isError, undefined);
    assert.ok(files[FLEET_LOG].includes("Through the guard."));
    await settle();
    const recs = records(adapter);
    // Both mutating calls journaled: the attest (module state, the lock-claim
    // precedent) and the post.
    assert.deepEqual(recs.map((r) => [r.op, r.outcome]), [
      ["crosssession_attest", "ok"],
      ["crosssession_post", "ok"],
    ]);
    assert.equal(recs[1].actor.client, "test/1.0");
  });

  test("a stale guarded post journals an error outcome and writes nothing to the vault", async () => {
    const { call, files, adapter } = guardedBuild();
    const before = files[FLEET_LOG];
    const res = await call("crosssession_post", { handle: "gamma", channel: FLEET_UID, body: "Stale." });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [stale_read]:"));
    assert.equal(files[FLEET_LOG], before);
    await settle();
    assert.deepEqual(records(adapter).map((r) => [r.op, r.outcome]), [["crosssession_post", "error"]]);
  });

  test("read-only mode blocks post AND attest (both mutating); the read tools still answer", async () => {
    const { call, files } = guardedBuild({ readOnly: true });
    const before = files[FLEET_LOG];
    for (const [tool, args] of [
      ["crosssession_post", { handle: "g", channel: FLEET_UID, body: "x" }],
      ["crosssession_attest", { handle: "g", channel: FLEET_UID, through_stamp: "2026-08-18T13:40" }],
    ]) {
      const res = await call(tool, args);
      assert.equal(res.isError, true, tool);
      assert.ok(errText(res).includes("read-only"), tool);
    }
    assert.equal(files[FLEET_LOG], before);
    const channels = await call("crosssession_channels", {});
    assert.equal(channels.isError, undefined);
    const delta = await call("crosssession_delta", { handle: "g", channel: FLEET_UID });
    assert.equal(delta.isError, undefined);
  });
});

// ── small pure helpers ───────────────────────────────────────────────────────

describe("helpers", () => {
  test("formatEntryStamp: local minutes precision, the live convention's shape", () => {
    assert.equal(formatEntryStamp(new Date(2026, 7, 18, 9, 5)), "2026-08-18T09:05");
  });

  test("handleRefusal: empty, multi-line, and separator-carrying handles refuse", () => {
    assert.ok(handleRefusal(""));
    assert.ok(handleRefusal("a\nb"));
    assert.ok(handleRefusal("a · b"));
    assert.equal(handleRefusal("assent-worker-3"), null);
  });

  test("bodyRefusal: an entry-heading-shaped line refuses; quoted excerpts pass", () => {
    assert.ok(bodyRefusal("## 2026-08-18T13:40 · alpha"));
    assert.equal(bodyRefusal("> ## 2026-08-18T13:40 · alpha\n\nquoted is fine"), null);
    assert.ok(bodyRefusal("   "));
  });

  test("emptyCrosssessionSource: no channels, append throws", async () => {
    const s = emptyCrosssessionSource();
    assert.deepEqual(s.paths(), []);
    await assert.rejects(() => s.append("x.md", "y"));
  });
});
