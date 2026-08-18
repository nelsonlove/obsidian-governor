import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerQuickAddTools } = await import("../src/mcp/tools-quickadd.ts");

// A minimal fake note: frontmatter + a resolvable-or-not set of wikilinks.
function fakeFile(path) {
  return { path, extension: "md" };
}

function build({ notes = [], links = {}, existingChoices = [] } = {}) {
  const server = fakeServer();
  const files = notes.map((n) => fakeFile(n.path));
  const saveSettingsCalls = [];
  const quickadd = {
    settings: { choices: existingChoices },
    saveSettings: async () => { saveSettingsCalls.push([...quickadd.settings.choices]); },
  };
  const app = {
    vault: { getMarkdownFiles: () => files },
    metadataCache: {
      getFileCache: (file) => {
        const n = notes.find((x) => x.path === file.path);
        return n ? { frontmatter: n.frontmatter } : null;
      },
      // links: { "[linktext]": "resolved/path.md" | null }
      getFirstLinkpathDest: (linktext) => {
        const resolved = links[linktext];
        return resolved ? fakeFile(resolved) : null;
      },
    },
    plugins: { plugins: { quickadd } },
  };
  const ctx = {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "test",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [] }),
  };
  registerQuickAddTools(server, app, ctx);
  return { handler: server.tools.get("obsidian_quickadd_compile").handler, quickadd, saveSettingsCalls };
}

function macroNote(path, name, scriptLink) {
  return {
    path,
    frontmatter: {
      "quickadd-type": "macro",
      name,
      steps: [{ kind: "userscript", script: `[[${scriptLink}]]` }],
    },
  };
}

describe("obsidian_quickadd_compile: dry_run", () => {
  test("dry_run: true reports the compiled result and writes nothing", async () => {
    const { handler, quickadd, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].name, "Stamp title");
    assert.deepEqual(quickadd.settings.choices, []);
    assert.deepEqual(saveSettingsCalls, []);
  });

  test("dry_run: false compiles and calls saveSettings", async () => {
    const { handler, quickadd, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(quickadd.settings.choices.length, 1);
    assert.equal(quickadd.settings.choices[0].name, "Stamp title");
    assert.equal(saveSettingsCalls.length, 1);
  });
});

describe("obsidian_quickadd_compile: scoped merge — never touches non-compiler-owned choices", () => {
  test("an existing hand-authored choice (no qan: id) survives a compile untouched", async () => {
    const handAuthored = { id: "some-uuid", name: "Hand Authored", type: "Macro" };
    const { handler, quickadd } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [handAuthored],
    });
    await handler({ dry_run: false });
    assert.deepEqual(quickadd.settings.choices.find((c) => c.id === "some-uuid"), handAuthored);
    assert.equal(quickadd.settings.choices.length, 2);
  });

  test("a compiler-owned choice whose note no longer declares it is removed on recompile", async () => {
    const stale = { id: "qan:Choices/Gone.md#choice", name: "Gone", type: "Macro" };
    const { handler, quickadd } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [stale],
    });
    await handler({ dry_run: false });
    assert.equal(quickadd.settings.choices.find((c) => c.id === "qan:Choices/Gone.md#choice"), undefined);
    assert.equal(quickadd.settings.choices.length, 1);
  });

  test("recompiling with no choice notes at all removes every compiler-owned choice, leaves the rest", async () => {
    const handAuthored = { id: "some-uuid", name: "Hand Authored", type: "Macro" };
    const stale = { id: "qan:Choices/Gone.md#choice", name: "Gone", type: "Macro" };
    const { handler, quickadd } = build({ notes: [], existingChoices: [handAuthored, stale] });
    await handler({ dry_run: false });
    assert.deepEqual(quickadd.settings.choices, [handAuthored]);
  });
});

describe("obsidian_quickadd_compile: per-choice error isolation", () => {
  test("an unresolvable script link fails only that note; the rest still compile", async () => {
    const { handler } = build({
      notes: [
        macroNote("Choices/Bad.md", "Bad", "nope"),
        macroNote("Choices/Good.md", "Good", "stamp-title"),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md" }, // "nope" deliberately absent
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].name, "Good");
    assert.equal(res.structuredContent.errors.length, 1);
    assert.equal(res.structuredContent.errors[0].notePath, "Choices/Bad.md");
  });

  test("a note with quickadd-type other than macro is ignored (Stage B+ territory), not an error", async () => {
    const { handler } = build({
      notes: [
        { path: "Choices/T.md", frontmatter: { "quickadd-type": "template", name: "T" } },
        macroNote("Choices/Good.md", "Good", "stamp-title"),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.errors.length, 0);
  });

  test("a note with no quickadd-type frontmatter at all is ignored, not an error", async () => {
    const { handler } = build({
      notes: [
        { path: "Some/Other/Note.md", frontmatter: { title: "Unrelated" } },
        macroNote("Choices/Good.md", "Good", "stamp-title"),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.errors.length, 0);
  });
});

describe("obsidian_quickadd_compile: name fallback", () => {
  test("a macro note missing name: falls back to the note's basename", async () => {
    const note = macroNote("Choices/Fallback Name.md", undefined, "stamp-title");
    delete note.frontmatter.name;
    const { handler } = build({ notes: [note], links: { "stamp-title": "Scripts/stamp-title.md" } });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices[0].name, "Fallback Name");
  });
});

describe("obsidian_quickadd_compile: QuickAdd unavailable", () => {
  test("a typed refusal when QuickAdd isn't installed/enabled", async () => {
    const server = fakeServer();
    const app = {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
      plugins: { plugins: {} },
    };
    const ctx = {
      pluginVersion: "0.0.0-test", socketPath: "/tmp/x.sock", vaultName: "test",
      enabledPlugins: () => [], getSettings: () => ({ readOnly: false, allowlist: [] }),
    };
    registerQuickAddTools(server, app, ctx);
    const res = await server.tools.get("obsidian_quickadd_compile").handler({ dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[quickadd_unavailable\]/);
  });

  test("a typed refusal when quickadd.settings.choices is missing entirely", async () => {
    const server = fakeServer();
    const quickadd = { settings: {}, saveSettings: async () => {} };
    const app = {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
      plugins: { plugins: { quickadd } },
    };
    const ctx = {
      pluginVersion: "0.0.0-test", socketPath: "/tmp/x.sock", vaultName: "test",
      enabledPlugins: () => [], getSettings: () => ({ readOnly: false, allowlist: [] }),
    };
    registerQuickAddTools(server, app, ctx);
    const res = await server.tools.get("obsidian_quickadd_compile").handler({ dry_run: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[quickadd_unavailable\]/);
  });

  test("a typed refusal when quickadd.settings.choices is not an array", async () => {
    const server = fakeServer();
    const quickadd = { settings: { choices: "not an array" }, saveSettings: async () => {} };
    const app = {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
      plugins: { plugins: { quickadd } },
    };
    const ctx = {
      pluginVersion: "0.0.0-test", socketPath: "/tmp/x.sock", vaultName: "test",
      enabledPlugins: () => [], getSettings: () => ({ readOnly: false, allowlist: [] }),
    };
    registerQuickAddTools(server, app, ctx);
    const res = await server.tools.get("obsidian_quickadd_compile").handler({ dry_run: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[quickadd_unavailable\]/);
  });
});
