/**
 * import-tools.test.mjs — obsidian_import_apple_notes (#252): drive the STOCK
 * community obsidian-importer plugin headlessly from vault-mcp.
 *
 * Fake-server pattern (tests/fake-server.mjs): register against a stand-in
 * server, invoke the captured handler directly. The importer plugin surface is
 * mocked structurally (the same touchpoints the version gate vouches for:
 * plugin.importers, null-element host construction, ready, notAvailable,
 * selectedFolders, dataPath/readableDataFolder); sqlite and osascript are the
 * injected `querySqlite`/`runAppleScript` seams, so no subprocess ever runs.
 *
 * tools-import.ts is obsidian-free (type-only `App` import), so no stub hook
 * is needed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { collectPaths } from "../src/guard.ts";
import {
  registerImportTools,
  importerVersionSupported,
  selectImportableFolders,
  buildDispositionScript,
  HeadlessImportContext,
  KNOWN_GOOD_IMPORTER_VERSIONS,
  AN_FOLDER_TYPE,
} from "../src/mcp/tools-import.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const KNOWN_GOOD = KNOWN_GOOD_IMPORTER_VERSIONS[0];
const DATA_PATH = "/fake/Library/Group Containers/group.com.apple.notes";

// One folder of every flavor: two plain, the Trash (by TYPE, with a
// deliberately non-English name — type-based exclusion must not care), a
// Smart folder, and the post-import "Exported" folder (plain type; excluded
// by NAME in move mode only).
const FOLDER_ROWS = [
  { pk: 1, title: "Notes", type: AN_FOLDER_TYPE.default },
  { pk: 2, title: "Zuletzt gelöscht", type: AN_FOLDER_TYPE.trash },
  { pk: 3, title: "Smart One", type: AN_FOLDER_TYPE.smart },
  { pk: 4, title: "Exported", type: AN_FOLDER_TYPE.default },
  { pk: 5, title: "Work", type: AN_FOLDER_TYPE.default },
];

function fakeQuerySqlite(calls = []) {
  return async (dbPath, sql) => {
    calls.push({ dbPath, sql });
    if (sql.includes("z_primarykey")) {
      return [
        { ent: 11, name: "ICFolder" },
        { ent: 12, name: "ICNote" },
        { ent: 13, name: "ICAccount" },
      ];
    }
    if (sql.includes("COUNT(*)")) {
      return [
        { folder: 1, notes: 10 },
        { folder: 4, notes: 2 },
        { folder: 5, notes: 3 },
      ];
    }
    if (sql.includes("zfoldertype")) {
      return FOLDER_ROWS.map(({ pk, title, type }) => ({ pk, title, type }));
    }
    throw new Error(`unexpected sql in test: ${sql}`);
  };
}

/**
 * A structurally-faithful stand-in for the stock AppleNotesImporter: records
 * construction (app, host), exposes ready/notAvailable/dataPath/
 * readableDataFolder/selectedFolders, and lets each test script what
 * `import(ctx)` reports.
 */
function makeFakeImporterClass({
  notAvailable = false,
  dataPath = null,
  readableDataFolder = () => DATA_PATH,
  onImport = () => {},
} = {}) {
  const instances = [];
  class FakeImporter {
    constructor(app, host) {
      instances.push(this);
      this.app = app;
      this.host = host;
      this.ready = Promise.resolve();
      this.notAvailable = notAvailable;
      this.dataPath = dataPath;
      this.selectedFolders = [];
      this.outputLocation = "";
      this.filePrefixFormat = "";
      this.importCalls = 0;
    }
    readableDataFolder() {
      return readableDataFolder();
    }
    async import(ctx) {
      this.importCalls++;
      this.importedWith = ctx;
      await onImport(ctx, this);
    }
  }
  return { FakeImporter, instances };
}

function fakePlugin({ version = KNOWN_GOOD, importerClass, importers } = {}) {
  return {
    manifest: { version },
    importers:
      importers !== undefined
        ? importers
        : { "apple-notes": { importer: importerClass ?? makeFakeImporterClass().FakeImporter } },
  };
}

function register({ plugin, querySqlite, runAppleScript, getSettings, now, sqliteCalls } = {}) {
  const server = fakeServer();
  const scriptCalls = [];
  registerImportTools(server, {}, {
    importerPlugin: typeof plugin === "function" ? plugin : () => plugin ?? null,
    querySqlite: querySqlite ?? fakeQuerySqlite(sqliteCalls ?? []),
    runAppleScript:
      runAppleScript ??
      (async (script) => {
        scriptCalls.push(script);
        return "0";
      }),
    ...(getSettings ? { getSettings } : {}),
    ...(now ? { now } : {}),
  });
  const tool = server.tools.get("obsidian_import_apple_notes");
  return { server, tool, scriptCalls };
}

function codeOf(res) {
  const text = res.content?.[0]?.text ?? "";
  const m = text.match(/^Error \[([a-z_]+)\]/);
  return m ? m[1] : null;
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("importer version gate", () => {
  test("known-good versions pass, everything else refuses", () => {
    for (const v of KNOWN_GOOD_IMPORTER_VERSIONS) assert.equal(importerVersionSupported(v), true);
    for (const v of ["2.6.1", "2.6.3", "2.7.0", "1.8.13", "", undefined]) {
      assert.equal(importerVersionSupported(v), false, `version ${v} must not pass the gate`);
    }
  });

  test("2.6.2 is in the known-good set (the version every touchpoint was verified against)", () => {
    assert.ok(KNOWN_GOOD_IMPORTER_VERSIONS.includes("2.6.2"));
  });
});

describe("selectImportableFolders", () => {
  test("excludes Smart and Trash by ZFOLDERTYPE, never by name", () => {
    const { selected, excluded } = selectImportableFolders(
      FOLDER_ROWS.map(({ pk, title, type }) => ({ id: pk, name: title, type, notes: 0 })),
      []
    );
    assert.deepEqual(selected.map((f) => f.id), [1, 4, 5]);
    assert.deepEqual(excluded, [
      { name: "Zuletzt gelöscht", reason: "trash" },
      { name: "Smart One", reason: "smart" },
    ]);
  });

  test("move mode additionally excludes the Exported folder by name", () => {
    const { selected, excluded } = selectImportableFolders(
      FOLDER_ROWS.map(({ pk, title, type }) => ({ id: pk, name: title, type, notes: 0 })),
      ["Exported"]
    );
    assert.deepEqual(selected.map((f) => f.id), [1, 5]);
    assert.ok(excluded.some((e) => e.name === "Exported" && e.reason === "excluded_name"));
  });
});

describe("buildDispositionScript", () => {
  const before = new Date(2026, 7, 19, 14, 30, 5);

  test("dry-run script contains no mutating statements", () => {
    for (const mode of ["move", "delete"]) {
      const script = buildDispositionScript(mode, before, "Exported", true);
      assert.ok(!script.includes("delete x"), `${mode} dry-run must not delete`);
      assert.ok(!script.includes("move x"), `${mode} dry-run must not move`);
      assert.ok(!script.includes("make new folder"), `${mode} dry-run must not create folders`);
      assert.ok(script.includes("return n"));
    }
  });

  test("move script moves to the Exported folder, creating it if missing", () => {
    const script = buildDispositionScript("move", before, "Exported", false);
    assert.ok(script.includes('move x to folder "Exported"'));
    assert.ok(script.includes('if not (exists folder "Exported") then make new folder'));
    // The target itself is protected from re-processing, alongside the fixed names.
    assert.ok(script.includes('fn is not "Exported" and fn is not "Shared" and fn is not "Recently Deleted"'));
  });

  test("delete script deletes and protects Shared / Recently Deleted", () => {
    const script = buildDispositionScript("delete", before, "Exported", false);
    assert.ok(script.includes("delete x"));
    assert.ok(script.includes('fn is not "Shared" and fn is not "Recently Deleted"'));
  });

  test("quotes and backslashes are stripped from the exported folder name (no script injection)", () => {
    const script = buildDispositionScript("move", before, 'Ex"por\\ted', false);
    assert.ok(!script.includes('"Ex"por'));
    assert.ok(script.includes('move x to folder "Exported"'));
  });

  test("cutoff encodes the import start time", () => {
    const script = buildDispositionScript("delete", before, "Exported", false);
    assert.ok(script.includes("set year of cutoff to 2026"));
    assert.ok(script.includes("set month of cutoff to 8"));
    assert.ok(script.includes("set day of cutoff to 19"));
    assert.ok(script.includes(`set time of cutoff to ${14 * 3600 + 30 * 60 + 5}`));
  });
});

describe("HeadlessImportContext", () => {
  test("mirrors the 2.x ImportContext counters and lists", async () => {
    const ctx = new HeadlessImportContext();
    ctx.reportNoteSuccess("A");
    ctx.reportNoteSuccess("B");
    ctx.reportAttachmentSuccess("img.png");
    ctx.reportSkipped("C", "unchanged");
    ctx.reportFailed("D", new Error("boom"));
    ctx.reportProgress(3, 5);
    ctx.status("working");
    assert.equal(ctx.notes, 2);
    assert.equal(ctx.attachments, 1);
    assert.deepEqual(ctx.skipped, ["C"]);
    assert.deepEqual(ctx.failed, ["D"]);
    assert.equal(ctx.progressCurrent, 3);
    assert.equal(ctx.statusMessage, "working");
    assert.equal(await ctx.shouldStop(), false);
    ctx.cancel();
    assert.equal(await ctx.shouldStop(), true);
    assert.equal(ctx.isCancelled(), true);
  });

  test("shouldStop blocks while paused and wakes on resume", async () => {
    const ctx = new HeadlessImportContext();
    ctx.pause();
    let settled = false;
    const p = ctx.shouldStop().then((v) => {
      settled = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, false, "shouldStop must block while paused");
    ctx.resume();
    assert.equal(await p, false);
  });
});

// ── registration gate ────────────────────────────────────────────────────────

describe("registration gate", () => {
  test("does not register when the importer plugin is not loaded", () => {
    const { tool } = register({ plugin: null });
    assert.equal(tool, undefined);
  });

  test("registers a mutating tool when the importer plugin is loaded", () => {
    const { tool } = register({ plugin: fakePlugin() });
    assert.ok(tool);
    assert.equal(tool.def.annotations.readOnlyHint, false);
    assert.equal(tool.def.annotations.openWorldHint, true);
    // destructive-but-recoverable convention (core's DESTRUCTIVE_RECOVERABLE /
    // obsidian_trash): the "delete" disposition can send source notes to
    // Recently Deleted, so the hint describes the capability, not the default.
    assert.equal(tool.def.annotations.destructiveHint, true);
    // dry_run is mandatory, matching the scheme-write tools' convention.
    assert.equal(tool.def.inputSchema.dry_run.isOptional(), false);
  });

  test("output_folder is a guard-recognized path argument with a schema default", () => {
    const { tool } = register({ plugin: fakePlugin() });
    // Schema default: every parsed call carries the landing folder, so the
    // kernel's collectPaths always finds it (journal target + lock consult).
    assert.equal(tool.def.inputSchema.output_folder.parse(undefined), "Apple Notes");
    // PATH_KEYS membership: the guard walker collects it like any named path.
    assert.deepEqual(collectPaths({ output_folder: "Apple Notes" }), ["Apple Notes"]);
  });
});

// ── handler refusals ─────────────────────────────────────────────────────────

describe("handler gates", () => {
  test("plugin disabled mid-session (loaded at register, gone at call) refuses importer_unavailable", async () => {
    let live = fakePlugin();
    const { tool } = register({ plugin: () => live });
    live = null;
    const res = await tool.handler({ dry_run: true, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, true);
    assert.equal(codeOf(res), "importer_unavailable");
  });

  test("version outside the known-good set refuses importer_version_unsupported, naming both sides", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass();
    const { tool } = register({ plugin: fakePlugin({ version: "2.7.0", importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, true);
    assert.equal(codeOf(res), "importer_version_unsupported");
    assert.ok(res.content[0].text.includes("2.7.0"), "must name the installed version");
    assert.ok(res.content[0].text.includes(KNOWN_GOOD), "must name the known-good set");
    assert.equal(instances.length, 0, "must refuse before constructing the importer");
  });

  test("missing apple-notes importer class refuses importer_unavailable", async () => {
    const { tool } = register({ plugin: fakePlugin({ importers: {} }) });
    const res = await tool.handler({ dry_run: true, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, true);
    assert.equal(codeOf(res), "importer_unavailable");
  });

  test("notAvailable importer (non-macOS) refuses without importing", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass({ notAvailable: true });
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, true);
    assert.equal(codeOf(res), "importer_unavailable");
    assert.equal(instances[0].importCalls, 0);
  });

  test("headless dataPath probe: readableDataFolder() fills the never-initialized dataPath", async () => {
    const calls = [];
    const { FakeImporter, instances } = makeFakeImporterClass();
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }), sqliteCalls: calls });
    const res = await tool.handler({ dry_run: true, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(instances[0].dataPath, DATA_PATH);
    assert.ok(
      calls.every((c) => c.dbPath === `${DATA_PATH}/NoteStore.sqlite`),
      "queries must target NoteStore.sqlite under the probed data path"
    );
  });

  test("no Notes access (readableDataFolder null) refuses notes_access_missing before import — never a dialog", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass({ readableDataFolder: () => null });
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, true);
    assert.equal(codeOf(res), "notes_access_missing");
    assert.equal(instances[0].importCalls, 0);
  });

  test("all folders excluded refuses no_importable_folders", async () => {
    const querySqlite = async (dbPath, sql) => {
      if (sql.includes("z_primarykey")) return [{ ent: 11, name: "ICFolder" }, { ent: 12, name: "ICNote" }];
      if (sql.includes("COUNT(*)")) return [];
      return [{ pk: 3, title: "Smart One", type: AN_FOLDER_TYPE.smart }];
    };
    const { tool } = register({ plugin: fakePlugin(), querySqlite });
    const res = await tool.handler({ dry_run: true, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, true);
    assert.equal(codeOf(res), "no_importable_folders");
  });

  test("output_folder escaping the vault refuses invalid_output_folder", async () => {
    const { tool } = register({ plugin: fakePlugin() });
    for (const bad of ["../outside", "/abs/path", "a/../../b"]) {
      const res = await tool.handler({
        dry_run: true,
        output_folder: bad,
        source_disposition: "none",
        disposition_dry_run: false,
      });
      assert.equal(res.isError, true, `'${bad}' must refuse`);
      assert.equal(codeOf(res), "invalid_output_folder");
    }
  });

  test("active allowlist not covering output_folder refuses out_of_allowlist; covering one proceeds", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass();
    const settings = { readOnly: false, allowlist: ["Elsewhere"] };
    const { tool } = register({
      plugin: fakePlugin({ importerClass: FakeImporter }),
      getSettings: () => settings,
    });
    const refused = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(refused.isError, true);
    assert.equal(codeOf(refused), "out_of_allowlist");
    assert.equal(instances.length, 0, "must refuse before constructing the importer");

    settings.allowlist = ["Apple Notes"];
    const allowed = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(allowed.isError, undefined, allowed.content?.[0]?.text);
    assert.equal(instances[0].importCalls, 1);
  });
});

// ── folder selection wiring ──────────────────────────────────────────────────

describe("folder selection", () => {
  test("selectedFolders gets the importable ids; Smart/Trash excluded by type", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass();
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(instances[0].selectedFolders, [1, 4, 5]);
  });

  test("move disposition excludes the Exported folder from the import", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass();
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "move", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(instances[0].selectedFolders, [1, 5]);
  });
});

// ── dry run ──────────────────────────────────────────────────────────────────

describe("dry_run", () => {
  test("reports selection and counts without importing or disposing", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass();
    const { tool, scriptCalls } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: true, source_disposition: "move", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    const sc = res.structuredContent;
    assert.equal(sc.dry_run, true);
    assert.equal(sc.folders_selected, 2);
    assert.deepEqual(sc.folders, [
      { id: 1, name: "Notes", notes: 10 },
      { id: 5, name: "Work", notes: 3 },
    ]);
    assert.equal(sc.notes_in_selected_folders, 13);
    assert.ok(sc.excluded.some((e) => e.reason === "trash"));
    assert.equal(instances[0].importCalls, 0, "dry_run must not import");
    assert.equal(scriptCalls.length, 0, "dry_run must not run any AppleScript");
    assert.equal(sc.filesChanged, undefined, "a dry run reports no effects");
  });
});

// ── real runs ────────────────────────────────────────────────────────────────

describe("import run", () => {
  test("clean import reports counters, effects, and importer configuration", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass({
      onImport: (ctx) => {
        ctx.reportNoteSuccess("A");
        ctx.reportNoteSuccess("B");
        ctx.reportAttachmentSuccess("img.png");
        ctx.reportSkipped("C", "unchanged");
      },
    });
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({
      dry_run: false,
      output_folder: "Inbox/Apple",
      file_prefix_format: "",
      source_disposition: "none",
      disposition_dry_run: false,
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    const sc = res.structuredContent;
    assert.equal(sc.imported, 2);
    assert.equal(sc.attachments, 1);
    assert.equal(sc.skipped, 1);
    assert.equal(sc.failed, 0);
    assert.equal(sc.cancelled, false);
    assert.equal(sc.disposed, 0);
    assert.equal(sc.filesChanged, 3, "effects convention: created notes + attachments");
    assert.equal(typeof sc.finishedAt, "string");
    assert.equal(instances[0].outputLocation, "Inbox/Apple");
    assert.equal(instances[0].filePrefixFormat, "", "an explicit empty prefix must not fall back to the default");
  });

  test("defaults: output folder 'Apple Notes', prefix 'YYYY-MM-DD'", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass();
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(instances[0].outputLocation, "Apple Notes");
    assert.equal(instances[0].filePrefixFormat, "YYYY-MM-DD");
  });

  test("failed imports are reported with capped names", async () => {
    const { FakeImporter } = makeFakeImporterClass({
      onImport: (ctx) => {
        ctx.reportNoteSuccess("ok");
        ctx.reportFailed("bad-1", new Error("x"));
        ctx.reportFailed("bad-2", new Error("y"));
      },
    });
    const { tool } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "none", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.failed, 2);
    assert.deepEqual(res.structuredContent.failed_names, ["bad-1", "bad-2"]);
  });
});

// ── source disposition ───────────────────────────────────────────────────────

describe("source disposition", () => {
  const cleanImport = (ctx) => {
    ctx.reportNoteSuccess("A");
  };

  test("runs after a clean import and reports the disposed count", async () => {
    const { FakeImporter } = makeFakeImporterClass({ onImport: cleanImport });
    const scripts = [];
    const { tool } = register({
      plugin: fakePlugin({ importerClass: FakeImporter }),
      runAppleScript: async (script) => {
        scripts.push(script);
        return "4";
      },
      now: () => new Date(2026, 7, 19, 12, 0, 0),
    });
    const res = await tool.handler({ dry_run: false, source_disposition: "move", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.disposed, 4);
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0].includes('move x to folder "Exported"'));
    assert.ok(scripts[0].includes("set year of cutoff to 2026"));
  });

  test("delete disposition emits a delete script", async () => {
    const { FakeImporter } = makeFakeImporterClass({ onImport: cleanImport });
    const scripts = [];
    const { tool } = register({
      plugin: fakePlugin({ importerClass: FakeImporter }),
      runAppleScript: async (s) => (scripts.push(s), "2"),
    });
    const res = await tool.handler({ dry_run: false, source_disposition: "delete", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.disposed, 2);
    assert.ok(scripts[0].includes("delete x"));
  });

  test("disposition_dry_run emits the count-only script (no mutating statements)", async () => {
    const { FakeImporter } = makeFakeImporterClass({ onImport: cleanImport });
    const scripts = [];
    const { tool } = register({
      plugin: fakePlugin({ importerClass: FakeImporter }),
      runAppleScript: async (s) => (scripts.push(s), "7"),
    });
    const res = await tool.handler({ dry_run: false, source_disposition: "delete", disposition_dry_run: true });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.disposed, 7);
    assert.equal(res.structuredContent.disposition_dry_run, true);
    assert.ok(!scripts[0].includes("delete x"));
    assert.ok(!scripts[0].includes("move x"));
    assert.ok(!scripts[0].includes("make new folder"));
  });

  test("skipped when any note failed to import — source notes must survive their content not landing", async () => {
    const { FakeImporter } = makeFakeImporterClass({
      onImport: (ctx) => {
        ctx.reportNoteSuccess("ok");
        ctx.reportFailed("bad", new Error("boom"));
      },
    });
    const { tool, scriptCalls } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "delete", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.disposed, 0);
    assert.ok(res.structuredContent.disposition_skipped.includes("failed"));
    assert.equal(scriptCalls.length, 0, "no AppleScript may run after a failed import");
  });

  test("skipped when the import was cancelled", async () => {
    const { FakeImporter } = makeFakeImporterClass({
      onImport: (ctx) => {
        ctx.reportNoteSuccess("A");
        ctx.cancel();
      },
    });
    const { tool, scriptCalls } = register({ plugin: fakePlugin({ importerClass: FakeImporter }) });
    const res = await tool.handler({ dry_run: false, source_disposition: "move", disposition_dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.cancelled, true);
    assert.equal(res.structuredContent.disposed, 0);
    assert.ok(res.structuredContent.disposition_skipped.includes("cancelled"));
    assert.equal(scriptCalls.length, 0);
  });

  test("exported_folder is sanitized once — the import exclusion and the script agree", async () => {
    const { FakeImporter, instances } = makeFakeImporterClass({ onImport: cleanImport });
    const scripts = [];
    // Folder listing includes a folder whose name matches the SANITIZED form.
    const querySqlite = async (dbPath, sql) => {
      if (sql.includes("z_primarykey")) return [{ ent: 11, name: "ICFolder" }, { ent: 12, name: "ICNote" }];
      if (sql.includes("COUNT(*)")) return [];
      return [
        { pk: 1, title: "Notes", type: AN_FOLDER_TYPE.default },
        { pk: 9, title: "Done", type: AN_FOLDER_TYPE.default },
      ];
    };
    const { tool } = register({
      plugin: fakePlugin({ importerClass: FakeImporter }),
      querySqlite,
      runAppleScript: async (s) => (scripts.push(s), "1"),
    });
    const res = await tool.handler({
      dry_run: false,
      source_disposition: "move",
      exported_folder: 'Do"ne',
      disposition_dry_run: false,
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(instances[0].selectedFolders, [1], "the sanitized Exported name must be excluded from import");
    assert.ok(scripts[0].includes('move x to folder "Done"'));
  });
});
