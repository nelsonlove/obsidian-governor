/**
 * crosssession-module.test.mjs — the vault-crosssession satellite (#232):
 * src/kernel/* (parsing, ordering, unread computation, receipts) and
 * src/tools.ts (the four published tools), all headless.
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
 *   • post: happy path (byte-exact entry format), the typed `stale_read`
 *     refusal with nothing written, no_log_file / log_ambiguous, the reported
 *     effects;
 *   • the `visible` seam (dormant in the shipped configuration, supplied here
 *     so it cannot rot): a hidden channel is invisible — absent from discovery,
 *     `channel_unresolved` to delta/attest/post — and a hidden member file
 *     contributes no entries;
 *   • THE PUBLICATION CONTRACT: the wire names, the untrusted read-only claim,
 *     the fact that NO argument is a host path key (which is what makes the
 *     host block the whole surface under an allowlist), and the coded-error
 *     rendering;
 *   • both one-shot adoptions — the host's `modules.crosssession.config` and
 *     the host's `crosssession-receipts.json`.
 *
 * NOT covered here on purpose:
 *   • the host's kernel, journal, write queue, read-only mode, path allowlist
 *     and record-immutability guard. Those are HOST code with host tests; a
 *     second copy could drift into asserting a posture the host does not
 *     enforce. What this package owns — the argument names the host's guard
 *     reads — is pinned in the publication block instead.
 *   • obsidianCrosssessionSource / obsidianReceiptStore, the duck-typed
 *     Obsidian adapters (un-headless — verify live).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isVisible } from "@vault-mcp/core";
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
  DEFAULT_CROSSSESSION_CONFIG,
} from "../src/kernel/index.ts";
import {
  buildCrosssessionTools,
  formatEntryStamp,
  handleRefusal,
  bodyRefusal,
  emptyCrosssessionSource,
} from "../src/tools.ts";
import {
  adoptHostConfig,
  settingsOf,
  ADOPTABLE_KEYS,
  CROSSSESSION_FIELDS,
  DEFAULT_PLUGIN_SETTINGS,
} from "../src/settings.ts";
import { publishInto, OWNER, HOST_PATH_KEYS } from "./host-shim.mjs";

/** The host's `visiblePaths`, reproduced over core's published `isVisible` —
 *  the one-path predicate both sides share. It feeds the DORMANT `visible`
 *  seam so the seam's behaviour cannot rot; nothing supplies it in the shipped
 *  plugin (see tools.ts). */
const visiblePaths = (paths, settings) =>
  !settings?.allowlist?.length ? paths : paths.filter((p) => isVisible(p, settings));

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

/**
 * Build the four specs and publish them through the host shim, so every
 * assertion below reads the ENVELOPE an agent actually sees (`ok()` /
 * `fail()`'s `Error [code]: message`) rather than a raw return value.
 *
 * `call` takes the BARE name and prefixes it, so the test bodies stay readable
 * while the wire name is still what is exercised; `publication` below pins the
 * prefix itself.
 */
function build({ files = fixtureFiles(), fms = fixtureFms(), allowlist, config = {}, receipts = memoryReceiptStore(), now = NOW } = {}) {
  const source = fakeSource(files, fms);
  const settings = { readOnly: false, allowlist: allowlist ?? [] };
  const { tools } = publishInto(
    buildCrosssessionTools(source, {
      config: () => config,
      getSettings: () => settings,
      visible: (paths) => visiblePaths(paths, settings),
      receipts,
      now,
    }),
  );
  const call = (bare, args = {}) => tools.get(`${OWNER}_${bare}`).handler(args);
  return { tools, source, files, receipts, call };
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

  test("stripFrontmatter: a `----` rule inside the block is not a closer", () => {
    assert.equal(stripFrontmatter("---\nkey: |\n  ----\n---\nbody"), "body");
  });

  test("fences are marker-matched: a ~~~ block showing ``` lines does not mis-toggle", () => {
    const text = [
      "## 2026-08-18T10:00 · a",
      "",
      "~~~",
      "```",
      "## 2026-08-18T10:01 · phantom",
      "```",
      "~~~",
      "",
      "## 2026-08-18T10:02 · b",
      "",
      "real",
      "",
    ].join("\n");
    const es = parseLogEntries(text, "l");
    assert.deepEqual(es.map((e) => e.handle), ["a", "b"]);
    assert.ok(es[0].body.includes("phantom"));
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

  test("vault_crosssession_channels reports uid, audience, projects, entry count, newest stamp", async () => {
    const { call } = build();
    const res = await call("channels");
    const chans = res.structuredContent.channels;
    assert.equal(chans.length, 2);
    const fleet = chans.find((c) => c.audience === "fleet");
    assert.equal(fleet.uid, FLEET_UID);
    assert.equal(fleet.entry_count, 4); // 3 log sections + 1 per-message note
    assert.equal(fleet.newest_stamp, "2026-08-18T15:10");
    assert.deepEqual(fleet.log_candidates, [FLEET_LOG]);
    const proj = chans.find((c) => c.audience === "project");
    assert.deepEqual(proj.projects, ["[[Widget]]"]);
    assert.equal(proj.entry_count, 1);
  });

  test("with a handle: read position + unread count; receipts list which handles are behind", async () => {
    const receipts = memoryReceiptStore();
    const { call } = build({ receipts });
    await call("attest", { handle: "beta", channel: FLEET_UID, through_stamp: "2026-08-18T13:40" });
    const res = await call("channels", { handle: "gamma" });
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

describe("vault_crosssession_delta", () => {
  test("serves every foreign entry oldest-first when no receipt exists, both forms merged", async () => {
    const { call } = build();
    const res = await call("delta", { handle: "gamma", channel: FLEET_UID });
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
    const res = await call("delta", { handle: "alpha", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.deepEqual(ch.entries.map((e) => e.handle), ["beta", "tracker"]);
  });

  test("position tracking: attest moves the cursor", async () => {
    const { call } = build();
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T14:2x" });
    const res = await call("delta", { handle: "gamma", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.equal(ch.read_position, "2026-08-18T14:2x");
    assert.deepEqual(ch.entries.map((e) => e.stamp), ["2026-08-18T1500", "2026-08-18T15:10"]);
  });

  test("the cap truncates with more:true + next_stamp, and attest-then-again continues", async () => {
    const { call } = build({ config: { deltaCap: 2 } });
    const res = await call("delta", { handle: "gamma", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.equal(ch.unread_count, 4);
    assert.equal(ch.entries.length, 2);
    assert.equal(ch.more, true);
    assert.equal(ch.next_stamp, "2026-08-18T14:2x");
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: ch.next_stamp });
    const res2 = await call("delta", { handle: "gamma", channel: FLEET_UID });
    const [ch2] = res2.structuredContent.channels;
    assert.deepEqual(ch2.entries.map((e) => e.stamp), ["2026-08-18T1500", "2026-08-18T15:10"]);
    assert.equal(ch2.more, false);
  });

  test("the cap never bisects a same-stamp group: the slice extends to complete it", async () => {
    // Three entries share one minute; a cap of 2 would otherwise cut the run
    // in half — attesting through next_stamp (strictly-greater coverage on
    // orderKey) would then mark the unserved third entry read without ever
    // serving it. The slice must extend through the equal-key group.
    const files = {
      "c/c.md": "# note\n",
      "c/LOG.md": [
        "## 2026-08-18T12:00 · a\n\none\n",
        "## 2026-08-18T12:00 · b\n\ntwo\n",
        "## 2026-08-18T12:00 · c\n\nthree\n",
        "## 2026-08-18T12:01 · d\n\nfour\n",
      ].join("\n"),
    };
    const fms = { "c/c.md": { fileClass: "Collection/Log", audience: "fleet", uid: "u-run" } };
    const { call } = build({ files, fms, config: { deltaCap: 2 } });
    const res = await call("delta", { handle: "gamma", channel: "u-run" });
    const [ch] = res.structuredContent.channels;
    assert.deepEqual(ch.entries.map((e) => e.handle), ["a", "b", "c"], "the 12:00 group is served whole");
    assert.equal(ch.more, true);
    assert.equal(ch.next_stamp, "2026-08-18T12:00");
    // Attest through next_stamp, call again: the remainder arrives, nothing lost.
    await call("attest", { handle: "gamma", channel: "u-run", through_stamp: ch.next_stamp });
    const res2 = await call("delta", { handle: "gamma", channel: "u-run" });
    assert.deepEqual(res2.structuredContent.channels[0].entries.map((e) => e.handle), ["d"]);
  });

  test("channel accepts uid, folder-note path, or folder; omit ⇒ all visible channels", async () => {
    const { call } = build();
    for (const ref of [FLEET_UID, FLEET_NOTE, FLEET_DIR]) {
      const res = await call("delta", { handle: "gamma", channel: ref });
      assert.equal(res.structuredContent.channels[0].channel.uid, FLEET_UID, `ref: ${ref}`);
    }
    const all = await call("delta", { handle: "gamma" });
    assert.equal(all.structuredContent.channels.length, 2);
  });

  test("an unknown channel is a typed channel_unresolved refusal", async () => {
    const { call } = build();
    const res = await call("delta", { handle: "gamma", channel: "no-such-uid" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [channel_unresolved]:"));
  });

  test("a malformed handle is a typed invalid_handle refusal", async () => {
    const { call } = build();
    const res = await call("delta", { handle: "a · b", channel: FLEET_UID });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [invalid_handle]:"));
  });
});

// ── attest ───────────────────────────────────────────────────────────────────

describe("vault_crosssession_attest", () => {
  test("round-trip: attest is readable back and keyed by channel UID", async () => {
    const receipts = memoryReceiptStore();
    const { call } = build({ receipts });
    const res = await call("attest", { handle: "gamma", channel: FLEET_NOTE, through_stamp: "2026-08-18T15:10" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.unread_after, 0);
    // Keyed by the channel's uid (a reorg move keeps read state), even though
    // the caller addressed it by path.
    assert.equal((await receipts.get(FLEET_UID, "gamma")).through, "2026-08-18T15:10");
  });

  test("attesting ahead of the newest entry refuses stamp_ahead", async () => {
    const { call } = build();
    const res = await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T23:59" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [stamp_ahead]:"));
  });

  test("attesting an empty channel refuses stamp_ahead (nothing to attest)", async () => {
    const files = { "c/c.md": "# note\n" };
    const fms = { "c/c.md": { fileClass: "Collection/Log", audience: "fleet", uid: "u-empty" } };
    const { call } = build({ files, fms });
    const res = await call("attest", { handle: "g", channel: "u-empty", through_stamp: "2026-08-18T00:00" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [stamp_ahead]:"));
  });

  test("a channel without a uid keys receipts by path", async () => {
    const receipts = memoryReceiptStore();
    const { call } = build({ receipts });
    await call("attest", { handle: "g", channel: PROJ_NOTE, through_stamp: "2026-08-01T09:00" });
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

describe("vault_crosssession_post", () => {
  test("happy path: appends one `## <stamp> · <handle>` section and auto-attests through it", async () => {
    const receipts = memoryReceiptStore();
    const { call, files } = build({ receipts });
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const res = await call("post", { handle: "gamma", channel: FLEET_UID, body: "FINDING — all clear." });
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
    const again = await call("post", { handle: "gamma", channel: FLEET_UID, body: "Second." });
    assert.equal(again.isError, undefined);
  });

  test("stale poster: typed stale_read refusal BEFORE any write — the file is untouched", async () => {
    const { call, files } = build();
    const before = files[FLEET_LOG];
    const res = await call("post", { handle: "gamma", channel: FLEET_UID, body: "I did not read." });
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
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T14:2x" });
    const res = await call("post", { handle: "gamma", channel: FLEET_UID, body: "Still behind." });
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
    await call("attest", { handle: "alpha", channel: FLEET_UID, through_stamp: "2026-08-18T1500" });
    const res = await call("post", { handle: "alpha", channel: FLEET_UID, body: "Own entries exempt." });
    assert.equal(res.isError, undefined);
  });

  test("a channel with no log file refuses no_log_file", async () => {
    const files = { "c/c.md": "# note\n", [`c/2026-08-18T1200 · x.md`]: "msg\n" };
    const fms = {
      "c/c.md": { fileClass: "Collection/Log", audience: "fleet", uid: "u-nolog" },
      [`c/2026-08-18T1200 · x.md`]: { fileClass: "Agent/Log/CrossSession" },
    };
    const { call } = build({ files, fms });
    await call("attest", { handle: "g", channel: "u-nolog", through_stamp: "2026-08-18T1200" });
    const res = await call("post", { handle: "g", channel: "u-nolog", body: "x" });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [no_log_file]:"));
  });

  test("a stray entry-less note does not make the log ambiguous; two real logs do", async () => {
    const files = fixtureFiles();
    const fms = fixtureFms();
    files[`${FLEET_DIR}/scratch.md`] = "no entries here\n";
    const { call, files: f1 } = build({ files, fms });
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const ok1 = await call("post", { handle: "gamma", channel: FLEET_UID, body: "Narrowed to the real log." });
    assert.equal(ok1.isError, undefined);
    assert.ok(f1[FLEET_LOG].includes("Narrowed to the real log."));
    assert.ok(!f1[`${FLEET_DIR}/scratch.md`].includes("Narrowed"));

    const files2 = fixtureFiles();
    files2[`${FLEET_DIR}/SECOND-LOG.md`] = "## 2026-08-18T10:00 · x\n\nentry\n";
    const { call: call2 } = build({ files: files2, fms: fixtureFms() });
    await call2("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const res2 = await call2("post", { handle: "gamma", channel: FLEET_UID, body: "x" });
    assert.equal(res2.isError, true);
    assert.ok(errText(res2).startsWith("Error [log_ambiguous]:"));
  });

  test("a body that would parse as an entry heading refuses invalid_body; a FENCED excerpt passes", async () => {
    const { call } = build();
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const res = await call("post", {
      handle: "gamma",
      channel: FLEET_UID,
      body: "Quoting:\n## 2026-08-18T13:40 · alpha\nphantom",
    });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [invalid_body]:"));
    // The same excerpt inside a BALANCED fence is content to the parser, so it
    // is content to the hygiene check too.
    const fenced = await call("post", {
      handle: "gamma",
      channel: FLEET_UID,
      body: "Quoting:\n```\n## 2026-08-18T13:40 · alpha\n```\ndone",
    });
    assert.equal(fenced.isError, undefined);
  });

  test("a body with an UNBALANCED code fence refuses invalid_body (it would swallow later entries)", async () => {
    const { call, files } = build();
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const before = files[FLEET_LOG];
    const res = await call("post", {
      handle: "gamma",
      channel: FLEET_UID,
      body: "Half a snippet:\n```\nconsole.log(1)",
    });
    assert.equal(res.isError, true);
    assert.ok(errText(res).startsWith("Error [invalid_body]:"));
    assert.ok(errText(res).includes("unbalanced"));
    assert.equal(files[FLEET_LOG], before);
  });

  test("post reports its discovered append target as effects (filesChanged/files)", async () => {
    const { call } = build();
    await call("attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "2026-08-18T15:10" });
    const res = await call("post", { handle: "gamma", channel: FLEET_UID, body: "Effects." });
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.deepEqual(res.structuredContent.files, [FLEET_LOG]);
  });
});

// ── allowlist discipline ─────────────────────────────────────────────────────

describe("allowlist: a hidden channel is invisible, not refused-by-name", () => {
  test("discovery omits a channel whose folder note is outside the allowlist", async () => {
    const { call } = build({ allowlist: ["Projects"] });
    const res = await call("channels");
    assert.deepEqual(res.structuredContent.channels.map((c) => c.audience), ["project"]);
  });

  test("delta/attest/post answer channel_unresolved for a hidden channel — same as nonexistent", async () => {
    const { call } = build({ allowlist: ["Projects"] });
    for (const [tool, args] of [
      ["delta", { handle: "g", channel: FLEET_UID }],
      ["attest", { handle: "g", channel: FLEET_UID, through_stamp: "2026-08-18T13:40" }],
      ["post", { handle: "g", channel: FLEET_UID, body: "x" }],
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
    const res = await call("delta", { handle: "gamma", channel: FLEET_UID });
    const [ch] = res.structuredContent.channels;
    assert.ok(!ch.entries.some((e) => e.handle === "tracker"));
    assert.equal(ch.entries.length, 3);
  });
});

// ── the publication contract (replaces the module-host conformance block) ────
//
// There is no module to mount any more. What takes its place is the contract
// with the Governor host: the names the four tools go on the wire under, the
// flags the host reads off them, and the argument shapes the host's guard can
// see. Each of these was a property the module got for free from the mount and
// now has to be asserted explicitly.
//
// The host's own machinery — write queue, journal, read-only mode, path
// allowlist, record-immutability guard — is NOT reproduced here. It is host
// code with host tests, and external mutating tools ride the same guarded
// registration path as built-ins, so the behaviour is the host's to pin. What
// this package owns is the half below: what its arguments are NAMED.

describe("publication: names, flags, and what the host's guard can scope", () => {
  const specs = () => buildCrosssessionTools(emptyCrosssessionSource(), { config: () => ({}), receipts: memoryReceiptStore() });

  test("the plugin id sanitizes to `vault_crosssession`, so the wire names are vault_crosssession_*", () => {
    assert.equal(OWNER, "vault_crosssession");
    assert.deepEqual(specs().map((t) => t.name), ["channels", "delta", "attest", "post"]);
    const { tools } = publishInto(specs());
    assert.deepEqual([...tools.keys()], [
      "vault_crosssession_channels",
      "vault_crosssession_delta",
      "vault_crosssession_attest",
      "vault_crosssession_post",
    ]);
  });

  test("channels/delta CLAIM read-only, and an untrusted claim registers as MUTATING", () => {
    // This is the whole reason the allowlist posture is what it is: the host
    // distrusts an external tool's readOnlyHint unless the raw publisher id is
    // in trustedReadOnlyPlugins, and a mutating tool with no path argument is
    // blocked outright under an allowlist.
    const untrusted = publishInto(specs()).tools;
    for (const bare of ["channels", "delta"]) {
      assert.equal(untrusted.get(`vault_crosssession_${bare}`).def.claimsReadOnly, true, bare);
      assert.equal(untrusted.get(`vault_crosssession_${bare}`).def.annotations.readOnlyHint, false, bare);
    }
    const trusted = publishInto(specs(), { trusted: true }).tools;
    assert.equal(trusted.get("vault_crosssession_delta").def.annotations.readOnlyHint, true);
    // attest and post never claim read-only, trusted or not.
    for (const bare of ["attest", "post"]) {
      assert.equal(trusted.get(`vault_crosssession_${bare}`).def.annotations.readOnlyHint, false, bare);
    }
  });

  test("NOT ONE argument is a host path key — so under an allowlist the host blocks all four wholesale", () => {
    // The decision, pinned. `channel` is a REF (uid | folder-note path |
    // folder), not a path, and it was deliberately NOT renamed into a path key
    // at the extraction: (1) it would not scope the write, since `post` appends
    // to a log file it DISCOVERS and no argument ever names; (2) a uid value
    // would be prefix-matched as a path and refuse every uid-addressed call;
    // (3) it would expose the tool to the record-immutability guard on the
    // folder NOTE rather than the appended file. See tools.ts and CLAUDE.md.
    // If this test ever fails, the README's and settings tab's fail-closed
    // posture is wrong and the record-guard question is reopened.
    for (const spec of specs()) {
      for (const key of Object.keys(spec.inputSchema ?? {})) {
        assert.ok(
          !HOST_PATH_KEYS.includes(key),
          `${spec.name}.${key} would make the tool scopable — revisit the README's posture AND the host's RECORD_EXEMPT_OPS`,
        );
      }
    }
    assert.ok(!HOST_PATH_KEYS.includes("channel"), "the pin is only meaningful while `channel` is not a host path key");
  });

  test("refusals throw with a lowercase-snake code, which the host renders as `Error [code]: message`", async () => {
    const { call } = build();
    const res = await call("delta", { handle: "gamma", channel: "no-such-uid" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[channel_unresolved\]: /);
  });

  test("the `.min(1)` bounds are re-applied in the HANDLER, because the schema's do not survive the boundary", async () => {
    // The SDK converts zod to JSON Schema and the host converts it back through
    // a small subset: type, description and string enums survive; min, max,
    // default and pattern do not. So an empty-string `channel` reaches the
    // handler and must refuse there. This is the vault_skills_release semver
    // lesson.
    const { call } = build();
    for (const [bare, args, bad] of [
      ["delta", { handle: "gamma", channel: "" }, "channel"],
      ["attest", { handle: "gamma", channel: FLEET_UID, through_stamp: "  " }, "through_stamp"],
      ["post", { handle: "gamma", channel: FLEET_UID, body: "" }, "body"],
      ["post", { handle: "", channel: FLEET_UID, body: "x" }, "handle"],
    ]) {
      const res = await call(bare, args);
      assert.equal(res.isError, true, `${bare}/${bad}`);
      assert.match(errText(res), /^Error \[invalid_(argument|handle)\]: /, `${bare}/${bad}`);
    }
  });

  test("a traversal-shaped channel ref resolves to nothing — the refs are matched by EQUALITY, never joined", async () => {
    // There is no path-validation surface here to harden (no tool takes a
    // path), and that is structural rather than lucky: `channel` is compared
    // for exact equality against the uid / folder-note path / folder of an
    // already-DISCOVERED channel, so a "../.." string can only fail to match.
    const { call, files } = build();
    const before = { ...files };
    for (const ref of ["../../etc/passwd", "00-09 System/../00-09 System/03 Agents/03.16 Cross-session log", "x\\..\\y"]) {
      const res = await call("post", { handle: "gamma", channel: ref, body: "x" });
      assert.equal(res.isError, true, ref);
      assert.ok(errText(res).startsWith("Error [channel_unresolved]:"), ref);
    }
    assert.deepEqual(files, before, "nothing may be written by an unresolvable ref");
  });

  test("config is read PER CALL, so a settings change lands without a reload", async () => {
    let config = {};
    const source = fakeSource(fixtureFiles(), fixtureFms());
    const { tools } = publishInto(
      buildCrosssessionTools(source, { config: () => config, receipts: memoryReceiptStore(), now: NOW }),
    );
    const call = (bare, args = {}) => tools.get(`${OWNER}_${bare}`).handler(args);
    const first = await call("delta", { handle: "gamma", channel: FLEET_UID });
    assert.equal(first.structuredContent.channels[0].entries.length, 4);
    config = { deltaCap: 1 };
    const second = await call("delta", { handle: "gamma", channel: FLEET_UID });
    assert.equal(second.structuredContent.channels[0].entries.length, 1, "the new cap took effect with no republish");
    // A renamed channel fileClass takes effect per call too — discovery is not
    // frozen at publish time even though the DESCRIPTION is.
    config = { channelFileclass: "Nothing/Matches" };
    const third = await call("channels");
    assert.deepEqual(third.structuredContent.channels, []);
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

  test("bodyRefusal: an entry-heading-shaped line refuses; quoted/fenced excerpts pass; unbalanced fences refuse", () => {
    assert.ok(bodyRefusal("## 2026-08-18T13:40 · alpha"));
    assert.equal(bodyRefusal("> ## 2026-08-18T13:40 · alpha\n\nquoted is fine"), null);
    assert.equal(bodyRefusal("```\n## 2026-08-18T13:40 · alpha\n```"), null);
    assert.ok(bodyRefusal("```\nhalf-open"));
    assert.ok(bodyRefusal("   "));
  });

  test("emptyCrosssessionSource: no channels, append throws", async () => {
    const s = emptyCrosssessionSource();
    assert.deepEqual(s.paths(), []);
    await assert.rejects(() => s.append("x.md", "y"));
  });
});

// ── one-shot config adoption from the host's modules.crosssession.config ─────

describe("settings adoption (pure)", () => {
  const HOST = (config) => ({ modules: { crosssession: { enabled: true, config } } });
  const fresh = () => ({ ...DEFAULT_PLUGIN_SETTINGS, config: {} });

  test("adopts the recognized keys once and latches", () => {
    const out = adoptHostConfig(fresh(), HOST({ channelFileclass: "Log/Channel", deltaCap: 5 }));
    assert.deepEqual(out.config, { channelFileclass: "Log/Channel", deltaCap: 5 });
    assert.equal(out.adoptedFromHost, true);
    assert.equal(adoptHostConfig(out, HOST({ channelFileclass: "changed" })), null, "the latch is one-shot");
  });

  test("the satellite's OWN values win; adoption only fills gaps", () => {
    const out = adoptHostConfig(
      { ...fresh(), config: { deltaCap: 99 } },
      HOST({ deltaCap: 5, messageFileclass: "Theirs" }),
    );
    assert.deepEqual(out.config, { deltaCap: 99, messageFileclass: "Theirs" });
  });

  test("an unrecognized host key is NOT copied", () => {
    const out = adoptHostConfig(fresh(), HOST({ notAField: 1, deltaCap: 7 }));
    assert.deepEqual(out.config, { deltaCap: 7 });
    assert.deepEqual([...ADOPTABLE_KEYS].sort(), Object.keys(DEFAULT_CROSSSESSION_CONFIG).sort());
  });

  test("an ABSENT host adopts nothing and does NOT latch — the one chance survives", () => {
    assert.equal(adoptHostConfig(fresh(), undefined), null);
    assert.equal(adoptHostConfig(fresh(), null), null);
  });

  test("a host present with NO crosssession config still latches — the question was asked and answered", () => {
    // This is the LIVE operator's case: `modules.crosssession` is `{enabled:
    // true}` with no `config` key at all, so there is nothing to adopt and the
    // shipped defaults (which mirror that vault's conventions) apply.
    const out = adoptHostConfig(fresh(), { modules: { crosssession: { enabled: true } } });
    assert.deepEqual(out.config, {});
    assert.equal(out.adoptedFromHost, true);
  });

  test("the receipt latch is INDEPENDENT of the config latch", () => {
    // The two sources are present independently — a host may carry receipts and
    // no config override, which is exactly the live case.
    const out = adoptHostConfig(fresh(), HOST({ deltaCap: 5 }));
    assert.equal(out.adoptedReceiptsFromHost, false, "config adoption must not latch the receipt adoption");
  });

  test("settingsOf coerces a corrupt or hand-edited data.json to the defaults", () => {
    assert.deepEqual(settingsOf(null), { config: {}, adoptedFromHost: false, adoptedReceiptsFromHost: false });
    assert.deepEqual(settingsOf([1, 2]), { config: {}, adoptedFromHost: false, adoptedReceiptsFromHost: false });
    assert.deepEqual(settingsOf({ config: "nope", adoptedFromHost: "yes" }), {
      config: {},
      adoptedFromHost: false,
      adoptedReceiptsFromHost: false,
    });
    assert.deepEqual(settingsOf({ config: { deltaCap: 7 }, adoptedFromHost: true, adoptedReceiptsFromHost: true }), {
      config: { deltaCap: 7 },
      adoptedFromHost: true,
      adoptedReceiptsFromHost: true,
    });
  });

  test("the settings-tab fields are the host manifest's three keys, in order", () => {
    assert.deepEqual(CROSSSESSION_FIELDS.map((f) => f.key), ["channelFileclass", "messageFileclass", "deltaCap"]);
    for (const f of CROSSSESSION_FIELDS) {
      assert.ok(f.label && f.help, `${f.key} must carry its label and help text`);
      assert.ok(["text", "number"].includes(f.type));
    }
  });
});

// ── one-shot READ-RECEIPT adoption from the host's plugin directory ──────────
//
// The thing neither predecessor satellite had: live operational state outside
// data.json. Losing it is not cosmetic — every affected handle's next delta
// re-serves entries it already read, and its next post refuses `stale_read` on
// entries it already attested.

describe("receipt adoption from the host's plugin dir", () => {
  function diskAdapter(seed = {}) {
    const files = new Map(Object.entries(seed));
    const dirs = new Set(["mine", "hostdir"]);
    return {
      files,
      writes: [],
      async exists(p) { return files.has(p) || dirs.has(p); },
      async read(p) { return files.get(p); },
      async mkdir(p) { dirs.add(p); },
      async write(p, d) { this.writes.push(p); files.set(p, d); },
    };
  }
  const R = (through, at = "t") => ({ through, at });
  const HOST_FILE = "hostdir/crosssession-receipts.json";
  const MINE = "mine/crosssession-receipts.json";

  test("loadFrom reads the host's file without writing it, and merge adopts every pair", async () => {
    const adapter = diskAdapter({ [HOST_FILE]: JSON.stringify({ "uid-1": { alpha: R("2026-08-19T04:1x") } }) });
    const store = new ReceiptStore(adapter, "mine");
    const incoming = await store.loadFrom("hostdir");
    assert.deepEqual(incoming, { "uid-1": { alpha: R("2026-08-19T04:1x") } });
    assert.equal(await store.merge(incoming), 1);
    assert.deepEqual(await store.get("uid-1", "alpha"), R("2026-08-19T04:1x"));
    // Rule 1: the host's copy is never written. Structural, not merely
    // intended — there is no write counterpart that takes a directory.
    assert.deepEqual(adapter.writes, [MINE]);
    assert.equal(adapter.files.get(HOST_FILE), JSON.stringify({ "uid-1": { alpha: R("2026-08-19T04:1x") } }));
  });

  test("OWN values win per (channel, handle); only the gaps are filled", async () => {
    const adapter = diskAdapter({ [MINE]: JSON.stringify({ "uid-1": { alpha: R("2026-08-30T09:00") } }) });
    const store = new ReceiptStore(adapter, "mine");
    const adopted = await store.merge({ "uid-1": { alpha: R("2026-08-19T04:1x"), beta: R("2026-08-24T01:0x") } });
    assert.equal(adopted, 1, "only beta is new");
    assert.deepEqual(await store.get("uid-1", "alpha"), R("2026-08-30T09:00"), "a newer own receipt is never rolled back");
    assert.deepEqual(await store.get("uid-1", "beta"), R("2026-08-24T01:0x"));
  });

  test("nothing to adopt writes nothing at all", async () => {
    const adapter = diskAdapter();
    const store = new ReceiptStore(adapter, "mine");
    assert.deepEqual(await store.loadFrom("hostdir"), {}, "an absent host file is empty, never a throw");
    assert.equal(await store.merge({}), 0);
    assert.deepEqual(adapter.writes, []);
  });

  test("a corrupt host file adopts nothing rather than failing the load", async () => {
    const adapter = diskAdapter({ [HOST_FILE]: "{not json" });
    const store = new ReceiptStore(adapter, "mine");
    assert.deepEqual(await store.loadFrom("hostdir"), {});
  });

  test("a malformed row in the host's file is dropped, not imported", async () => {
    const adapter = diskAdapter({
      [HOST_FILE]: JSON.stringify({ "uid-1": { good: R("s"), bad: { through: 7 } }, "uid-2": "nope" }),
    });
    const store = new ReceiptStore(adapter, "mine");
    assert.deepEqual(await store.loadFrom("hostdir"), { "uid-1": { good: R("s") } });
  });

  test("adopted receipts silence the staleness gate the way they did in the host", async () => {
    // The end-to-end point of the adoption: a handle that attested through the
    // newest entry BEFORE the extraction must still be able to post after it.
    const adapter = diskAdapter({
      [HOST_FILE]: JSON.stringify({ [FLEET_UID]: { gamma: R("2026-08-18T15:10") } }),
    });
    const store = new ReceiptStore(adapter, "mine");
    await store.merge(await store.loadFrom("hostdir"));
    const { call, files } = build({ receipts: store });
    const res = await call("post", { handle: "gamma", channel: FLEET_UID, body: "Post-migration." });
    assert.equal(res.isError, undefined, errText(res));
    assert.ok(files[FLEET_LOG].endsWith("\n## 2026-08-18T16:00 · gamma\n\nPost-migration.\n"));
  });
});
