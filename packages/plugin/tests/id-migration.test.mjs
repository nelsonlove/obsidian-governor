/**
 * id-migration.test.mjs — the 0.12.0 plugin-id data-folder migration
 * (`.obsidian/plugins/vault-mcp/` → `.obsidian/plugins/governor/`, #266).
 *
 * The highest-risk piece of the rename: the old folder holds the journal,
 * baselines, acceptance log, install-id, receipts, and settings. Pinned here
 * on the PURE planning logic (fixture listings) and on runFolderMigration
 * over an injected fake fs:
 *   - fresh install / marker present / no old data.json / new side already
 *     provisioned ⇒ skip (idempotent);
 *   - code artifacts (main.js, manifest.json, styles.css) never move;
 *   - ANY new-side conflict ⇒ abort, nothing moves;
 *   - success moves every data entry, then writes MIGRATED.md into the OLD
 *     folder (never deletes it);
 *   - a mid-sequence rename failure writes NO marker and reports exactly
 *     what moved.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  planFolderMigration,
  runFolderMigration,
  markerText,
  MIGRATION_MARKER,
  CODE_ARTIFACTS,
  LEGACY_PLUGIN_ID,
} from "../src/id-migration.ts";

const OLD = ".obsidian/plugins/vault-mcp";
const NEW = ".obsidian/plugins/governor";

// A realistic legacy folder: code artifacts + every data surface.
const LEGACY_FILES = ["main.js", "manifest.json", "styles.css", "data.json", "install-id.json", "acceptance-log.jsonl"];
const LEGACY_FOLDERS = ["journal", "baselines", "receipts"];
const FRESH_NEW = { files: ["main.js", "manifest.json"], folders: [] };

describe("planFolderMigration", () => {
  test("fresh install (no old folder) skips", () => {
    const plan = planFolderMigration(null, FRESH_NEW);
    assert.equal(plan.action, "skip");
  });

  test("marker present skips — idempotent second load", () => {
    const plan = planFolderMigration(
      { files: [...LEGACY_FILES, MIGRATION_MARKER], folders: LEGACY_FOLDERS },
      FRESH_NEW,
    );
    assert.equal(plan.action, "skip");
    assert.match(plan.reason, /already ran/);
  });

  test("old folder without data.json skips (nothing to adopt)", () => {
    const plan = planFolderMigration({ files: ["main.js", "manifest.json"], folders: [] }, FRESH_NEW);
    assert.equal(plan.action, "skip");
  });

  test("new side already has data.json ⇒ skip, both folders untouched", () => {
    const plan = planFolderMigration(
      { files: LEGACY_FILES, folders: LEGACY_FOLDERS },
      { files: ["main.js", "manifest.json", "data.json"], folders: [] },
    );
    assert.equal(plan.action, "skip");
    assert.match(plan.reason, /not a fresh install/);
  });

  test("happy path: moves every data entry, never a code artifact", () => {
    const plan = planFolderMigration({ files: LEGACY_FILES, folders: LEGACY_FOLDERS }, FRESH_NEW);
    assert.equal(plan.action, "migrate");
    assert.deepEqual(plan.entries.sort(), [
      "acceptance-log.jsonl",
      "baselines",
      "data.json",
      "install-id.json",
      "journal",
      "receipts",
    ]);
    for (const code of CODE_ARTIFACTS) {
      assert.ok(!plan.entries.includes(code), `${code} must never be moved onto the new plugin's code`);
    }
  });

  test("ANY new-side conflict aborts the WHOLE migration, naming the conflicts", () => {
    const plan = planFolderMigration(
      { files: LEGACY_FILES, folders: LEGACY_FOLDERS },
      { files: ["main.js", "manifest.json"], folders: ["journal"] },
    );
    assert.equal(plan.action, "abort");
    assert.match(plan.reason, /journal/);
  });

  test("a new-side FILE conflict aborts too (not only folders)", () => {
    const plan = planFolderMigration(
      { files: LEGACY_FILES, folders: [] },
      { files: ["main.js", "install-id.json"], folders: [] },
    );
    assert.equal(plan.action, "abort");
    assert.match(plan.reason, /install-id\.json/);
  });
});

// ── runFolderMigration over an injected fake fs ─────────────────────────────

function fakeFs(tree) {
  // tree: { [dirPath]: { files: [...basenames], folders: [...basenames] } }
  const renames = [];
  const writes = [];
  return {
    renames,
    writes,
    async exists(p) {
      return p in tree;
    },
    async list(p) {
      const d = tree[p];
      return {
        files: d.files.map((f) => `${p}/${f}`),
        folders: d.folders.map((f) => `${p}/${f}`),
      };
    },
    async rename(from, to) {
      renames.push([from, to]);
    },
    async write(p, data) {
      writes.push([p, data]);
    },
  };
}

describe("runFolderMigration", () => {
  test("moves contents old → new, then writes the marker into the OLD folder", async () => {
    const fs = fakeFs({
      [OLD]: { files: LEGACY_FILES, folders: LEGACY_FOLDERS },
      [NEW]: FRESH_NEW,
    });
    const r = await runFolderMigration(fs, OLD, NEW, () => new Date("2026-08-19T00:00:00Z"));
    assert.equal(r.plan.action, "migrate");
    assert.equal(r.failedEntry, undefined);
    assert.deepEqual(r.moved.sort(), ["acceptance-log.jsonl", "baselines", "data.json", "install-id.json", "journal", "receipts"]);
    for (const [from, to] of fs.renames) {
      assert.ok(from.startsWith(`${OLD}/`), `rename source in old dir: ${from}`);
      assert.ok(to.startsWith(`${NEW}/`), `rename target in new dir: ${to}`);
    }
    assert.equal(fs.writes.length, 1);
    const [markerPath, body] = fs.writes[0];
    assert.equal(markerPath, `${OLD}/${MIGRATION_MARKER}`, "the marker lands in the OLD folder");
    assert.match(body, /governor/);
    assert.match(body, /remove it by hand/);
  });

  test("no old dir ⇒ skip, zero fs mutations", async () => {
    const fs = fakeFs({ [NEW]: FRESH_NEW });
    const r = await runFolderMigration(fs, OLD, NEW);
    assert.equal(r.plan.action, "skip");
    assert.equal(fs.renames.length, 0);
    assert.equal(fs.writes.length, 0);
  });

  test("abort (conflict) ⇒ zero fs mutations — never a partial adopt", async () => {
    const fs = fakeFs({
      [OLD]: { files: LEGACY_FILES, folders: LEGACY_FOLDERS },
      [NEW]: { files: ["main.js", "manifest.json"], folders: ["journal"] },
    });
    const r = await runFolderMigration(fs, OLD, NEW);
    assert.equal(r.plan.action, "abort");
    assert.equal(fs.renames.length, 0);
    assert.equal(fs.writes.length, 0);
  });

  test("second run after success skips on the marker (idempotent)", async () => {
    const fs = fakeFs({
      [OLD]: { files: ["main.js", "manifest.json", MIGRATION_MARKER], folders: [] },
      [NEW]: { files: ["main.js", "manifest.json", "data.json"], folders: ["journal"] },
    });
    const r = await runFolderMigration(fs, OLD, NEW);
    assert.equal(r.plan.action, "skip");
    assert.equal(fs.renames.length, 0);
  });

  test("mid-sequence rename failure: no marker, reports what moved and what failed", async () => {
    const fs = fakeFs({
      [OLD]: { files: ["data.json", "install-id.json"], folders: ["journal"] },
      [NEW]: FRESH_NEW,
    });
    let n = 0;
    fs.rename = async (from, to) => {
      n += 1;
      if (n === 2) throw new Error("EPERM");
      fs.renames.push([from, to]);
    };
    const r = await runFolderMigration(fs, OLD, NEW);
    assert.equal(r.plan.action, "migrate");
    assert.equal(r.moved.length, 1, "exactly the pre-failure entry moved");
    assert.ok(r.failedEntry, "the failing entry is named");
    assert.equal(fs.writes.length, 0, "NO marker after a partial move");
  });

  test("markerText names the destination and every moved entry", () => {
    const body = markerText(new Date("2026-08-19T12:00:00Z"), OLD, NEW, ["data.json", "journal"]);
    assert.match(body, /2026-08-19T12:00:00/);
    assert.match(body, /`data\.json`/);
    assert.match(body, /`journal`/);
    assert.match(body, new RegExp(NEW.replace(/[.\\/]/g, "\\$&")));
  });

  test("LEGACY_PLUGIN_ID is the old folder name", () => {
    assert.equal(LEGACY_PLUGIN_ID, "vault-mcp");
  });
});
