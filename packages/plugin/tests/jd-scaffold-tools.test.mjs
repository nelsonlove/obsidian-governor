import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerJdScaffoldTools } = await import("../src/mcp/tools-jd-scaffold.ts");

function fakeFile(path) {
  const slash = path.lastIndexOf("/");
  return { path, name: path.slice(slash + 1), basename: path.slice(slash + 1).replace(/\.md$/, "") };
}

function fakeFolder(path, children = []) {
  const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return { path, name, children };
}

function build({ allPaths = [], folders = [], allowlist = [] } = {}) {
  const server = fakeServer();
  const created = [];
  const renamed = [];
  const foldersCreated = [];
  const paths = new Set(allPaths);
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (paths.has(p) ? fakeFile(p) : null),
      getAllLoadedFiles: () => folders,
      create: async (path, content) => {
        created.push({ path, content });
        paths.add(path);
      },
      createFolder: async (path) => {
        foldersCreated.push(path);
        paths.add(path);
      },
    },
    fileManager: {
      renameFile: async (file, newPath) => {
        renamed.push({ from: file.path, to: newPath });
        paths.delete(file.path);
        paths.add(newPath);
      },
    },
  };
  const ctx = { getSettings: () => ({ readOnly: false, allowlist }) };
  registerJdScaffoldTools(server, app, ctx);
  return { server, app, created, renamed, foldersCreated };
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

  test("dry_run: false creates every planned zero via app.vault.create", async () => {
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

  test("a real existing target (via app.vault.getAbstractFileByPath) is skipped, not recreated", async () => {
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

  test("one failing create doesn't block the rest — per-item isolation", async () => {
    const server = fakeServer();
    const created = [];
    const app = {
      vault: {
        getAbstractFileByPath: () => null,
        create: async (path, content) => {
          if (path.includes("06.03")) throw new Error("disk full");
          created.push({ path, content });
        },
      },
    };
    registerJdScaffoldTools(server, app, { getSettings: () => ({ readOnly: false, allowlist: [] }) });
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
        fakeFolder("10-19 Personal/06 Digital tools", []),
        fakeFolder("10-19 Personal/07 Health", [{ name: "07.00 Existing.md" }]),
      ],
    });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 1);
    assert.match(created[0].path, /^10-19 Personal\/06 Digital tools\/06\.00/);
  });

  test("a folder not matching the depth-2 XX-name pattern is ignored", async () => {
    const { server, created } = build({
      folders: [fakeFolder("10-19 Personal/06 Digital tools/Subfolder", [])],
    });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.deepEqual(created, []);
  });

  test("dry_run: true reports the plan and writes nothing", async () => {
    const { server, created } = build({ folders: [fakeFolder("10-19 Personal/06 Digital tools", [])] });
    const res = await server.tools.get("obsidian_jd_ensure_category_indexes").handler({ dry_run: true });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.creates.length, 1);
    assert.deepEqual(created, []);
  });
});

describe("obsidian_jd_promote_to_folder", () => {
  test("dry_run: false creates the folder and renames the file via app.fileManager.renameFile", async () => {
    const { server, renamed, foldersCreated } = build({ allPaths: ["06 Digital tools/06.13 Bar.md"] });
    const res = await server.tools.get("obsidian_jd_promote_to_folder").handler({
      path: "06 Digital tools/06.13 Bar.md",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.deepEqual(foldersCreated, ["06 Digital tools/06.13 Bar"]);
    assert.deepEqual(renamed, [{ from: "06 Digital tools/06.13 Bar.md", to: "06 Digital tools/06.13 Bar/06.13 Bar.md" }]);
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
