import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { registerJdScaffoldTools } from "../src/mcp/tools-jd-scaffold.ts";

function fakeSource({ allPaths = [], folders = [], now = "2026-08-19" } = {}) {
  const paths = new Set(allPaths);
  const created = [];
  const renamed = [];
  const foldersCreated = [];
  const source = {
    exists: (p) => paths.has(p),
    categoryFolders: () => folders,
    create: async (path, content) => {
      created.push({ path, content });
      paths.add(path);
    },
    createFolder: async (path) => {
      foldersCreated.push(path);
      paths.add(path);
    },
    renameFile: async (fromPath, toPath) => {
      renamed.push({ from: fromPath, to: toPath });
      paths.delete(fromPath);
      paths.add(toPath);
    },
    today: () => now,
  };
  return { source, created, renamed, foldersCreated };
}

function build({ allowlist = [], ...sourceOpts } = {}) {
  const server = fakeServer();
  const { source, created, renamed, foldersCreated } = fakeSource(sourceOpts);
  const ctx = { getSettings: () => ({ readOnly: false, allowlist }) };
  registerJdScaffoldTools(server, source, ctx);
  return { server, source, created, renamed, foldersCreated };
}

describe("obsidian_jd_standard_zeros", () => {
  test("dry_run: true reports the plan and writes nothing", async () => {
    const { server, created } = build();
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: true,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.creates.length, 10);
    assert.deepEqual(created, []);
  });

  test("dry_run: false creates every planned zero via source.create", async () => {
    const { server, created } = build();
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 10);
    assert.equal(res.structuredContent.created, 10);
  });

  test("a real existing target (via source.exists) is skipped, not recreated", async () => {
    const existing = "10-19 Personal/06 Digital tools/06.00 JDex for category 06.md";
    const { server, created } = build({ allPaths: [existing] });
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 9);
    assert.deepEqual(res.structuredContent.skipped, [existing]);
  });

  test("calling twice in a row: the second call skips every note the first one created", async () => {
    const { server, created } = build();
    await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.equal(created.length, 10);
    const res2 = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.equal(res2.structuredContent.created, 0);
    assert.equal(res2.structuredContent.skipped.length, 10);
    assert.equal(created.length, 10); // unchanged — nothing new written
  });

  test("out_of_allowlist refusal when folder_path is outside an active allowlist", async () => {
    const { server, created } = build({ allowlist: ["Somewhere Else"] });
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
    assert.deepEqual(created, []);
  });

  test("dry_run: false reports filesChanged/files for the journal's effects field", async () => {
    const { server } = build();
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.equal(res.structuredContent.filesChanged, 10);
    assert.equal(res.structuredContent.files.length, 10);
    assert.ok(res.structuredContent.files.every((p) => p.startsWith("10-19 Personal/06 Digital tools/")));
  });

  test("dry_run: true reports no filesChanged/files — a preview asserts nothing was written", async () => {
    const { server } = build();
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: true,
    });
    assert.equal(res.structuredContent.filesChanged, undefined);
    assert.equal(res.structuredContent.files, undefined);
  });

  test("dry_run: true's computed creates are allowlist-filtered too, matching what a real write would do", async () => {
    // Every computed path is a child of the already-checked folder_path, so
    // under normal prefix-matching nothing is ever actually dropped — this
    // just proves the preview can never diverge from applyCreates' own check.
    const { server } = build({ allowlist: ["10-19 Personal/06 Digital tools"] });
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: true,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.creates.length, 10);
  });

  test("one failing create doesn't block the rest — per-item isolation", async () => {
    const server = fakeServer();
    const created = [];
    const source = {
      exists: () => false,
      categoryFolders: () => [],
      create: async (path, content) => {
        if (path.includes("06.03")) throw new Error("disk full");
        created.push({ path, content });
      },
      createFolder: async () => {},
      renameFile: async () => {},
      today: () => "2026-08-19",
    };
    registerJdScaffoldTools(server, source, { getSettings: () => ({ readOnly: false, allowlist: [] }) });
    const res = await server.tools.get("obsidian_jd_standard_zeros").handler({
      folder_path: "10-19 Personal/06 Digital tools",
      prefix: "06",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.created, 9);
    assert.equal(res.structuredContent.failures.length, 1);
    assert.match(res.structuredContent.failures[0].error, /disk full/);
  });
});

describe("obsidian_jd_ensure_category_indexes", () => {
  test("vault-wide: finds depth-2 XX-named folders missing their XX.00 and plans one each", async () => {
    const { server, created } = build({
      folders: [
        { path: "10-19 Personal/06 Digital tools", name: "06 Digital tools", prefix: "06", childBasenames: [] },
        { path: "10-19 Personal/07 Health", name: "07 Health", prefix: "07", childBasenames: ["07.00 Existing.md"] },
      ],
    });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 1);
    assert.match(created[0].path, /^10-19 Personal\/06 Digital tools\/06\.00/);
  });

  test("dry_run: true reports the plan and writes nothing", async () => {
    const { server, created } = build({
      folders: [{ path: "10-19 Personal/06 Digital tools", name: "06 Digital tools", prefix: "06", childBasenames: [] }],
    });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: true });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.creates.length, 1);
    assert.deepEqual(created, []);
  });

  test("a folder outside an active allowlist never reaches the planner — not even under dry_run", async () => {
    // The vulnerability this closes: this tool takes NO path argument (it's
    // vault-wide by design), so an allowlist-restricted session could
    // otherwise see category-folder paths from anywhere in the vault, in
    // both the preview and the real write's per-item failures.
    const { server, created } = build({
      folders: [
        { path: "10-19 Personal/06 Digital tools", name: "06 Digital tools", prefix: "06", childBasenames: [] },
        { path: "Archive/09 Hidden", name: "09 Hidden", prefix: "09", childBasenames: [] },
      ],
      allowlist: ["10-19 Personal"],
    });
    const dryRes = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: true });
    assert.equal(dryRes.structuredContent.creates.length, 1);
    assert.ok(!dryRes.structuredContent.creates.some((c) => c.path.startsWith("Archive/")));

    const writeRes = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: false });
    assert.equal(writeRes.structuredContent.created, 1);
    assert.deepEqual(writeRes.structuredContent.failures, []); // the hidden folder never became a failure entry either
    assert.ok(!created.some((c) => c.path.startsWith("Archive/")));
  });

  test("dry_run: false reports filesChanged/files for the journal's effects field", async () => {
    const { server } = build({
      folders: [{ path: "10-19 Personal/06 Digital tools", name: "06 Digital tools", prefix: "06", childBasenames: [] }],
    });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: false });
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.equal(res.structuredContent.files.length, 1);
  });
});

describe("obsidian_jd_promote_to_folder", () => {
  test("dry_run: false creates the folder and renames the file via source.renameFile", async () => {
    const { server, renamed, foldersCreated } = build({ allPaths: ["06 Digital tools/06.13 Bar.md"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.deepEqual(foldersCreated, ["06 Digital tools/06.13 Bar"]);
    assert.deepEqual(renamed, [{ from: "06 Digital tools/06.13 Bar.md", to: "06 Digital tools/06.13 Bar/06.13 Bar.md" }]);
    assert.equal(res.structuredContent.filesChanged, 2);
    assert.deepEqual(res.structuredContent.files, ["06 Digital tools/06.13 Bar", "06 Digital tools/06.13 Bar/06.13 Bar.md"]);
  });

  test("a renameFile failure after createFolder succeeds reports a clear promote_partial error, not a silent orphan", async () => {
    const server = fakeServer();
    const foldersCreated = [];
    const source = {
      exists: (p) => p === "06 Digital tools/06.13 Bar.md",
      categoryFolders: () => [],
      create: async () => {},
      createFolder: async (path) => { foldersCreated.push(path); },
      renameFile: async () => { throw new Error("note vanished mid-operation"); },
      today: () => "2026-08-19",
    };
    registerJdScaffoldTools(server, source, { getSettings: () => ({ readOnly: false, allowlist: [] }) });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: false,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[promote_partial\]/);
    assert.match(res.content[0].text, /note vanished mid-operation/);
    assert.match(res.content[0].text, /Remove the empty folder before retrying/);
    assert.deepEqual(foldersCreated, ["06 Digital tools/06.13 Bar"]); // confirms the scenario: folder WAS created
  });

  test("dry_run: true reports the plan and creates/renames nothing", async () => {
    const { server, renamed, foldersCreated } = build({ allPaths: ["06 Digital tools/06.13 Bar.md"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: true,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.folder_path, "06 Digital tools/06.13 Bar");
    assert.deepEqual(foldersCreated, []);
    assert.deepEqual(renamed, []);
  });

  test("a coded refusal (not a thrown error) when the note isn't a JD id note", async () => {
    const { server } = build({ allPaths: ["06 Digital tools/Not an id.md"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/Not an id.md",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[not_id_note\]/);
  });

  test("a coded refusal when the destination folder already exists", async () => {
    const { server } = build({ allPaths: ["06 Digital tools/06.13 Bar.md", "06 Digital tools/06.13 Bar"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[folder_exists\]/);
  });

  test("out_of_allowlist refusal when path is outside an active allowlist", async () => {
    const { server } = build({ allPaths: ["06 Digital tools/06.13 Bar.md"], allowlist: ["Somewhere Else"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
  });
});
