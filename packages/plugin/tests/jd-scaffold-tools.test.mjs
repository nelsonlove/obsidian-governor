import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { parseYaml } from "./obsidian-stub.mjs";
import { registerJdScaffoldTools } from "../src/mcp/tools-jd-scaffold.ts";

function fakeSource({ allPaths = [], folders = [], now = "2026-08-19", noteContent = {}, folderChildren = {}, clockValue = { date: "2026-08-19", time: "10:30", now: "2026-08-19T10:30" } } = {}) {
  const paths = new Set(allPaths);
  const created = [];
  const renamed = [];
  const foldersCreated = [];
  const modified = [];
  const notes = new Map(Object.entries(noteContent));
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
    allNotePaths: () => allPaths,
    read: async (p) => (notes.has(p) ? notes.get(p) : null),
    modify: async (p, content) => {
      modified.push({ path: p, content });
      notes.set(p, content);
    },
    listFolderChildren: (folderPath) => folderChildren[folderPath] ?? [],
    clock: () => clockValue,
  };
  return { source, created, renamed, foldersCreated, modified, notes };
}

function build({ allowlist = [], ...sourceOpts } = {}) {
  const server = fakeServer();
  const { source, created, renamed, foldersCreated, modified, notes } = fakeSource(sourceOpts);
  const ctx = { getSettings: () => ({ readOnly: false, allowlist }), parseYaml };
  registerJdScaffoldTools(server, source, ctx);
  return { server, source, created, renamed, foldersCreated, modified, notes };
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

describe("obsidian_jd_reindex_category", () => {
  test("dry_run: false rewrites the target's Contents section via source.modify", async () => {
    const allPaths = [
      "10-19 Personal/06 Digital tools/06.00 JDex.md",
      "10-19 Personal/06 Digital tools/06.13 Bar.md",
    ];
    const { server, modified } = build({
      allPaths,
      noteContent: { "10-19 Personal/06 Digital tools/06.00 JDex.md": "# JDex\n" },
    });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(modified.length, 1);
    assert.match(modified[0].content, /\[\[06\.13 Bar\]\]/);
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.deepEqual(res.structuredContent.files, ["10-19 Personal/06 Digital tools/06.00 JDex.md"]);
  });

  test("dry_run: true reports the new content without writing", async () => {
    const allPaths = ["10-19 Personal/06 Digital tools/06.00 JDex.md", "10-19 Personal/06 Digital tools/06.13 Bar.md"];
    const { server, modified } = build({
      allPaths,
      noteContent: { "10-19 Personal/06 Digital tools/06.00 JDex.md": "# JDex\n" },
    });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      dry_run: true,
    });
    assert.notEqual(res.isError, true);
    assert.match(res.structuredContent.new_content, /\[\[06\.13 Bar\]\]/);
    assert.deepEqual(modified, []);
  });

  test("a preserved description round-trips through the tool", async () => {
    const allPaths = ["10-19 Personal/06 Digital tools/06.00 JDex.md", "10-19 Personal/06 Digital tools/06.13 Bar.md"];
    const { server } = build({
      allPaths,
      noteContent: { "10-19 Personal/06 Digital tools/06.00 JDex.md": "## Contents\n\n- [[06.13 Bar]] *(the real one)*\n" },
    });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      dry_run: false,
    });
    assert.match(res.structuredContent.preserved[0].description, /the real one/);
  });

  test("a coded refusal when the path isn't XX.00-shaped", async () => {
    const { server } = build({ allPaths: ["06 Digital tools/Not an id note.md"] });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "06 Digital tools/Not an id note.md",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[not_index_file\]/);
  });

  test("out_of_allowlist refusal when path is outside an active allowlist", async () => {
    const { server } = build({ allPaths: ["10-19 Personal/06 Digital tools/06.00 JDex.md"], allowlist: ["Somewhere Else"] });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
  });

  test("the ordinary tier does NOT fetch every sibling index file — only its own content", async () => {
    let readCalls = [];
    const server = fakeServer();
    const source = {
      exists: () => false,
      categoryFolders: () => [],
      create: async () => {},
      createFolder: async () => {},
      renameFile: async () => {},
      today: () => "2026-08-19",
      allNotePaths: () => [
        "10-19 Personal/06 Digital tools/06.00 JDex.md",
        "10-19 Personal/06 Digital tools/06.13 Bar.md",
        "20-29 Work/20 Work management/20.00 Other index.md", // a SEPARATE category's XX.00 — must not be read
      ],
      read: async (p) => {
        readCalls.push(p);
        return p === "10-19 Personal/06 Digital tools/06.00 JDex.md" ? "# JDex\n" : null;
      },
      modify: async () => {},
    };
    registerJdScaffoldTools(server, source, { getSettings: () => ({ readOnly: false, allowlist: [] }) });
    await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      dry_run: true,
    });
    assert.deepEqual(readCalls, ["10-19 Personal/06 Digital tools/06.00 JDex.md"]);
  });

  test("the area-management tier DOES fetch sibling index files, to consolidate their Contents", async () => {
    let readCalls = [];
    const server = fakeServer();
    const allPaths = [
      "10-19 Personal/10 Foo/10.00 Area index.md",
      "10-19 Personal/06 Digital tools/06.00 JDex.md",
      "10-19 Personal/06 Digital tools/06.13 Bar.md",
    ];
    const notes = {
      "10-19 Personal/10 Foo/10.00 Area index.md": "## Contents\n\n",
      "10-19 Personal/06 Digital tools/06.00 JDex.md": "## Contents\n\n- [[06.13 Bar]]\n",
    };
    const source = {
      exists: () => false,
      categoryFolders: () => [],
      create: async () => {},
      createFolder: async () => {},
      renameFile: async () => {},
      today: () => "2026-08-19",
      allNotePaths: () => allPaths,
      read: async (p) => {
        readCalls.push(p);
        return notes[p] ?? null;
      },
      modify: async () => {},
    };
    registerJdScaffoldTools(server, source, { getSettings: () => ({ readOnly: false, allowlist: [] }) });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/10 Foo/10.00 Area index.md",
      dry_run: true,
    });
    assert.ok(readCalls.includes("10-19 Personal/06 Digital tools/06.00 JDex.md"));
    assert.match(res.structuredContent.new_content, /\[\[06\.13 Bar\]\]/);
  });

  test("review fix: refuses an ordinary note whose prefix merely LOOKS area-management-shaped (e.g. '10.13'), rather than overwriting it", async () => {
    // Before the fix: reindexTier("10.13 Something.md") returns
    // "area-management" (loose two-digit-prefix check), passing the tool's
    // gate; the path is never fetched into siblingContent (only strictly
    // XX.00-shaped paths are); planReindexCategory then resolves
    // categories.get("10") to whatever REAL 10.00 file exists and builds a
    // full area consolidation UNRELATED to "10.13 Something.md" — which a
    // non-dry-run call would then write straight over the note's real
    // content. The fix gates on isIndexFilePath (strict), not reindexTier
    // (loose), so this must refuse before any read/write happens.
    const modifyCalls = [];
    const server = fakeServer();
    const source = {
      exists: () => false,
      categoryFolders: () => [],
      create: async () => {},
      createFolder: async () => {},
      renameFile: async () => {},
      today: () => "2026-08-19",
      allNotePaths: () => ["10-19 Personal/10 Foo/10.00 Area index.md", "10-19 Personal/10 Foo/10.13 Something.md"],
      read: async () => "## Contents\n\n- [[10.13 Something]]\n",
      modify: async (p, content) => { modifyCalls.push({ path: p, content }); },
    };
    registerJdScaffoldTools(server, source, { getSettings: () => ({ readOnly: false, allowlist: [] }) });

    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/10 Foo/10.13 Something.md",
      dry_run: false,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[not_index_file\]/);
    assert.deepEqual(modifyCalls, []); // the note was NEVER touched
  });

  test("review fix: a sibling XX.00 file outside the allowlist is excluded from consolidation, and scoped_to_allowlist reports true", async () => {
    const allPaths = [
      "10-19 Personal/10 Foo/10.00 Area index.md",
      "10-19 Personal/06 Digital tools/06.00 JDex.md",
      "10-19 Personal/06 Digital tools/06.13 Bar.md",
      "Archive/09 Hidden/09.00 Hidden index.md", // outside the allowlist below
      "Archive/09 Hidden/09.05 Secret.md",
    ];
    const { server } = build({
      allPaths,
      allowlist: ["10-19 Personal"],
      noteContent: {
        "10-19 Personal/10 Foo/10.00 Area index.md": "## Contents\n\n",
        "10-19 Personal/06 Digital tools/06.00 JDex.md": "## Contents\n\n- [[06.13 Bar]]\n",
        "Archive/09 Hidden/09.00 Hidden index.md": "## Contents\n\n- [[09.05 Secret]] *(sensitive)*\n",
      },
    });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/10 Foo/10.00 Area index.md",
      dry_run: true,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.scoped_to_allowlist, true);
    assert.match(res.structuredContent.new_content, /\[\[06\.13 Bar\]\]/);
    assert.doesNotMatch(res.structuredContent.new_content, /09\.05 Secret/);
    assert.doesNotMatch(res.structuredContent.new_content, /09 Hidden/);
    assert.doesNotMatch(res.structuredContent.new_content, /sensitive/);
  });

  test("scoped_to_allowlist is false with no active allowlist", async () => {
    const { server } = build({
      allPaths: ["10-19 Personal/06 Digital tools/06.00 JDex.md"],
      noteContent: { "10-19 Personal/06 Digital tools/06.00 JDex.md": "# JDex\n" },
    });
    const res = await server.tools.get("obsidian_jd_reindex_category").handler({
      path: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      dry_run: true,
    });
    assert.equal(res.structuredContent.scoped_to_allowlist, false);
  });
});

describe("obsidian_jd_new_standard_zero", () => {
  function zeroFixture(overrides = {}) {
    return build({
      folderChildren: { Templates: ["Templates/inbox-template.md"] },
      noteContent: { "Templates/inbox-template.md": '---\njd-id: "{{category}}.01"\n---\n\n# {{title}} ({{fullId}})\n' },
      ...overrides,
    });
  }

  test("dry_run: true reports the substituted content without writing", async () => {
    const { server, created } = zeroFixture();
    const res = await server.tools.get("obsidian_jd_new_standard_zero").handler({
      folder_path: "10-19 Personal/06 Digital tools", prefix: "06", zero_id: "01", templates_folder: "Templates", dry_run: true,
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.dest_path, "10-19 Personal/06 Digital tools/06.01 Inbox for category 06/06.01 Inbox for category 06.md");
    assert.match(res.structuredContent.content, /# Inbox for category 06 \(06\.01\)/);
    assert.deepEqual(created, []);
  });

  test("dry_run: false creates the note via source.create and reports filesChanged/files", async () => {
    const { server, created } = zeroFixture();
    const res = await server.tools.get("obsidian_jd_new_standard_zero").handler({
      folder_path: "10-19 Personal/06 Digital tools", prefix: "06", zero_id: "01", templates_folder: "Templates", dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 1);
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.deepEqual(res.structuredContent.files, [created[0].path]);
  });

  test("refuses when the slot already exists", async () => {
    const dest = "10-19 Personal/06 Digital tools/06.01 Inbox for category 06/06.01 Inbox for category 06.md";
    const { server } = zeroFixture({ allPaths: [dest] });
    const res = await server.tools.get("obsidian_jd_new_standard_zero").handler({
      folder_path: "10-19 Personal/06 Digital tools", prefix: "06", zero_id: "01", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[already_exists\]/);
  });

  test("refuses when no template is classified for that zero slot", async () => {
    const { server } = build({ allPaths: ["Templates"], folderChildren: { Templates: [] } });
    const res = await server.tools.get("obsidian_jd_new_standard_zero").handler({
      folder_path: "10-19 Personal/06 Digital tools", prefix: "06", zero_id: "01", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[template_not_found\]/);
  });

  test("refuses an invalid zero_id", async () => {
    const { server } = zeroFixture();
    const res = await server.tools.get("obsidian_jd_new_standard_zero").handler({
      folder_path: "10-19 Personal/06 Digital tools", prefix: "06", zero_id: "99", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[invalid_zero_id\]/);
  });

  test("out_of_allowlist when templates_folder is hidden, even though folder_path is visible", async () => {
    const { server } = zeroFixture({ allowlist: ["10-19 Personal"] });
    const res = await server.tools.get("obsidian_jd_new_standard_zero").handler({
      folder_path: "10-19 Personal/06 Digital tools", prefix: "06", zero_id: "01", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
  });

  test("a hidden template file is excluded from discovery even when templates_folder itself is visible", async () => {
    // templates_folder is visible, but the one template file inside it is not
    // (an allowlist entry can be narrower than its containing folder listing
    // implies) — the hidden template must not be read or matched.
    const { server } = build({
      allowlist: ["Templates/other.md"],
      folderChildren: { Templates: ["Templates/inbox-template.md"] },
      noteContent: { "Templates/inbox-template.md": '---\njd-id: "{{category}}.01"\n---\n\nBody\n' },
    });
    const res = await server.tools.get("obsidian_jd_new_standard_zero").handler({
      folder_path: "Templates", prefix: "06", zero_id: "01", templates_folder: "Templates", dry_run: true,
    });
    // folder_path itself ("Templates") isn't in the allowlist either here, so
    // this refuses at the folder_path check first — the point is just that
    // no path in this test ever reaches source.read for the hidden template.
    assert.equal(res.isError, true);
  });
});

describe("obsidian_jd_new_generic_id", () => {
  function genericFixture(overrides = {}) {
    return build({
      folderChildren: { Templates: ["Templates/generic-template.md"] },
      noteContent: { "Templates/generic-template.md": '---\njd-id: "{{category}}.{{id}}"\n---\n\n# {{title}}\n' },
      ...overrides,
    });
  }

  test("dry_run: false creates 'XX.YY Title.md' with the sanitized title substituted", async () => {
    const { server, created } = genericFixture();
    const res = await server.tools.get("obsidian_jd_new_generic_id").handler({
      folder_path: "06 Digital tools", prefix: "06", id: "13", title: "  Bar  ", templates_folder: "Templates", dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(created[0].path, "06 Digital tools/06.13 Bar.md");
    assert.match(created[0].content, /# Bar/);
  });

  test("refuses an invalid (non-two-digit) id", async () => {
    const { server } = genericFixture();
    const res = await server.tools.get("obsidian_jd_new_generic_id").handler({
      folder_path: "06 Digital tools", prefix: "06", id: "1", title: "Bar", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[invalid_id\]/);
  });

  test("refuses a title that sanitizeTitle rejects", async () => {
    const { server } = genericFixture();
    const res = await server.tools.get("obsidian_jd_new_generic_id").handler({
      folder_path: "06 Digital tools", prefix: "06", id: "13", title: "a/b", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[invalid_title\]/);
  });

  test("dry_run: true reports unresolved placeholder warnings", async () => {
    const { server } = build({
      folderChildren: { Templates: ["Templates/generic-template.md"] },
      noteContent: { "Templates/generic-template.md": '---\njd-id: "{{category}}.{{id}}"\n---\n\n{{nonsense}}\n' },
    });
    const res = await server.tools.get("obsidian_jd_new_generic_id").handler({
      folder_path: "06 Digital tools", prefix: "06", id: "13", title: "Bar", templates_folder: "Templates", dry_run: true,
    });
    assert.deepEqual(res.structuredContent.placeholder_warnings, ["nonsense"]);
  });

  test("review fix: refuses to create from a template carrying an accepted fence — the note-creation accept-guard", async () => {
    // A template's frontmatter is copied through substitution into the new
    // note verbatim — without this guard, an accepted fence sitting in a
    // template file (however it got there) would land unscanned in a brand
    // new note. Same class of gap #79/#172 closed on the other two
    // "create from template" surfaces in this codebase.
    const { server, created } = build({
      folderChildren: { Templates: ["Templates/generic-template.md"] },
      noteContent: {
        "Templates/generic-template.md":
          '---\njd-id: "{{category}}.{{id}}"\nacceptance-status: accepted\naccepted-by: someone\naccepted-on: 2026-01-01\n---\n\n# {{title}}\n',
      },
    });
    const res = await server.tools.get("obsidian_jd_new_generic_id").handler({
      folder_path: "06 Digital tools", prefix: "06", id: "13", title: "Bar", templates_folder: "Templates", dry_run: false,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[accept_forbidden\]/);
    assert.deepEqual(created, []); // never written
  });

  test("review fix: the accept-guard refusal fires under dry_run too — a preview must never claim a plan this call would refuse", async () => {
    const { server } = build({
      folderChildren: { Templates: ["Templates/generic-template.md"] },
      noteContent: {
        "Templates/generic-template.md": '---\njd-id: "{{category}}.{{id}}"\nacceptance-status: accepted\n---\n\n# {{title}}\n',
      },
    });
    const res = await server.tools.get("obsidian_jd_new_generic_id").handler({
      folder_path: "06 Digital tools", prefix: "06", id: "13", title: "Bar", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[accept_forbidden\]/);
  });

  test("an ordinary, fence-free template is unaffected by the accept-guard", async () => {
    const { server, created } = genericFixture();
    const res = await server.tools.get("obsidian_jd_new_generic_id").handler({
      folder_path: "06 Digital tools", prefix: "06", id: "13", title: "Bar", templates_folder: "Templates", dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(created.length, 1);
  });
});

describe("obsidian_jd_new_stem", () => {
  function stemFixture(overrides = {}) {
    return build({
      folderChildren: { Templates: ["Templates/draft-template.md"] },
      noteContent: { "Templates/draft-template.md": "---\njd-id: XX.00+DRAFT\n---\n\n# {{title}}\n" },
      ...overrides,
    });
  }

  test("dry_run: false creates 'XX.00+CODE Name.md'", async () => {
    const { server, created } = stemFixture();
    const res = await server.tools.get("obsidian_jd_new_stem").handler({
      folder_path: "06 Digital tools", prefix: "06", stem_code: "DRAFT", name: "Session directives", templates_folder: "Templates", dry_run: false,
    });
    assert.notEqual(res.isError, true);
    assert.equal(created[0].path, "06 Digital tools/06.00+DRAFT Session directives.md");
  });

  test("refuses when no template matches the stem code", async () => {
    const { server } = stemFixture();
    const res = await server.tools.get("obsidian_jd_new_stem").handler({
      folder_path: "06 Digital tools", prefix: "06", stem_code: "NOPE", name: "Foo", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[template_not_found\]/);
  });

  test("out_of_allowlist when the computed destination is outside the allowlist", async () => {
    const { server } = stemFixture({ allowlist: ["Somewhere Else"] });
    const res = await server.tools.get("obsidian_jd_new_stem").handler({
      folder_path: "06 Digital tools", prefix: "06", stem_code: "DRAFT", name: "Foo", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
  });

  test("review fix: refuses a stem_code containing a path separator before it ever reaches destPathForStem's string concatenation", async () => {
    const { server, created, foldersCreated } = stemFixture();
    const res = await server.tools.get("obsidian_jd_new_stem").handler({
      folder_path: "06 Digital tools", prefix: "06", stem_code: "../../evil", name: "Foo", templates_folder: "Templates", dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[invalid_stem_code\]/);
    assert.deepEqual(created, []);
    assert.deepEqual(foldersCreated, []);
  });

  test("a real, regex-valid stem code (letters/digits/hyphen/underscore) is unaffected", async () => {
    const { server } = build({
      folderChildren: { Templates: ["Templates/draft-template.md"] },
      noteContent: { "Templates/draft-template.md": "---\njd-id: XX.00+co-de_2\n---\n\n# {{title}}\n" },
    });
    const res = await server.tools.get("obsidian_jd_new_stem").handler({
      folder_path: "06 Digital tools", prefix: "06", stem_code: "co-de_2", name: "Foo", templates_folder: "Templates", dry_run: true,
    });
    assert.notEqual(res.isError, true);
  });
});
