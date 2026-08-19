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

function build({ notes = [], links = {}, existingChoices = [], settings = {}, commandApi = true } = {}) {
  const server = fakeServer();
  const files = notes.map((n) => fakeFile(n.path));
  const saveSettingsCalls = [];
  const addedCommands = [];
  const removedCommands = [];
  const getMarkdownFilesCalls = [];
  const quickadd = {
    settings: { choices: existingChoices },
    saveSettings: async () => { saveSettingsCalls.push([...quickadd.settings.choices]); },
  };
  if (commandApi) {
    quickadd.addCommandForChoice = (c) => addedCommands.push(c);
    quickadd.removeCommandForChoice = (c) => removedCommands.push(c);
  }
  const app = {
    vault: { getMarkdownFiles: () => { getMarkdownFilesCalls.push(1); return files; } },
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
    getSettings: () => ({ readOnly: false, allowlist: [], ...settings }),
  };
  registerQuickAddTools(server, app, ctx);
  return {
    handler: server.tools.get("obsidian_quickadd_compile").handler,
    quickadd,
    saveSettingsCalls,
    addedCommands,
    removedCommands,
    getMarkdownFilesCalls,
  };
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

describe("obsidian_quickadd_compile: path allowlist", () => {
  test("refuses outright while a path allowlist is active, before enumerating anything", async () => {
    const { handler, getMarkdownFilesCalls, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      settings: { allowlist: ["Some/Path"] },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
    // Nothing ran: not even the vault enumeration the refusal exists to prevent.
    assert.deepEqual(getMarkdownFilesCalls, []);
    assert.deepEqual(saveSettingsCalls, []);
  });

  test("the refusal also applies to dry_run: false", async () => {
    const { handler, getMarkdownFilesCalls } = build({ settings: { allowlist: ["Some/Path"] } });
    const res = await handler({ dry_run: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]/);
    assert.deepEqual(getMarkdownFilesCalls, []);
  });
});

describe("obsidian_quickadd_compile: Obsidian command registration", () => {
  test("a fresh compile registers the command for each new choice", async () => {
    const { handler, addedCommands, removedCommands } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: false });
    assert.equal(res.structuredContent.commandsRegistered, true);
    assert.equal(addedCommands.length, 1);
    assert.equal(addedCommands[0].id, "qan:Choices/Stamp title.md#choice");
    assert.equal(addedCommands[0].name, "Stamp title");
    // Nothing was compiler-owned before, so nothing to deregister.
    assert.deepEqual(removedCommands, []);
  });

  test("a choice removed on recompile has its command deregistered", async () => {
    const stale = { id: "qan:Choices/Gone.md#choice", name: "Gone", type: "Macro" };
    const { handler, addedCommands, removedCommands } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [stale],
    });
    await handler({ dry_run: false });
    assert.deepEqual(removedCommands, [stale]);
    assert.equal(addedCommands.length, 1);
    assert.equal(addedCommands[0].id, "qan:Choices/Stamp title.md#choice");
  });

  test("a replaced choice is deregistered before the fresh one is registered", async () => {
    const previous = { id: "qan:Choices/Stamp title.md#choice", name: "Old name", type: "Macro" };
    const { handler, addedCommands, removedCommands } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [previous],
    });
    await handler({ dry_run: false });
    assert.deepEqual(removedCommands, [previous]);
    assert.equal(addedCommands.length, 1);
    assert.equal(addedCommands[0].name, "Stamp title");
  });

  test("dry_run: true registers and deregisters nothing", async () => {
    const stale = { id: "qan:Choices/Gone.md#choice", name: "Gone", type: "Macro" };
    const { handler, addedCommands, removedCommands } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [stale],
    });
    await handler({ dry_run: true });
    assert.deepEqual(addedCommands, []);
    assert.deepEqual(removedCommands, []);
  });

  test("a QuickAdd without the command API degrades to commandsRegistered: false, config still written", async () => {
    const { handler, quickadd, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      commandApi: false,
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.commandsRegistered, false);
    assert.equal(saveSettingsCalls.length, 1);
    assert.equal(quickadd.settings.choices.length, 1);
  });
});

describe("obsidian_quickadd_compile: would-be diff", () => {
  test("dry_run reports a removed entry for a compiler-owned choice whose note is gone", async () => {
    const stale = { id: "qan:Choices/Gone.md#choice", name: "Gone", type: "Macro" };
    const { handler, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [stale],
    });
    const res = await handler({ dry_run: true });
    assert.deepEqual(res.structuredContent.removed, [{ id: "qan:Choices/Gone.md#choice", name: "Gone" }]);
    assert.deepEqual(res.structuredContent.added, [
      { id: "qan:Choices/Stamp title.md#choice", name: "Stamp title" },
    ]);
    assert.deepEqual(res.structuredContent.changed, []);
    assert.deepEqual(saveSettingsCalls, []);
  });

  test("dry_run reports removed for a note that now FAILS to compile", async () => {
    const previous = { id: "qan:Choices/Bad.md#choice", name: "Bad", type: "Macro" };
    const { handler } = build({
      notes: [macroNote("Choices/Bad.md", "Bad", "nope")], // "nope" deliberately unresolvable
      links: {},
      existingChoices: [previous],
    });
    const res = await handler({ dry_run: true });
    assert.deepEqual(res.structuredContent.removed, [{ id: "qan:Choices/Bad.md#choice", name: "Bad" }]);
    assert.deepEqual(res.structuredContent.added, []);
    assert.equal(res.structuredContent.errors.length, 1);
  });

  test("a recompiled choice reports as changed, not added", async () => {
    const previous = { id: "qan:Choices/Stamp title.md#choice", name: "Stamp title", type: "Macro" };
    const { handler } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [previous],
    });
    const res = await handler({ dry_run: false });
    assert.deepEqual(res.structuredContent.added, []);
    assert.deepEqual(res.structuredContent.changed, [
      { id: "qan:Choices/Stamp title.md#choice", name: "Stamp title" },
    ]);
    assert.deepEqual(res.structuredContent.removed, []);
  });
});

describe("obsidian_quickadd_compile: mass-removal guard", () => {
  const owned = (n) => ({ id: `qan:Choices/${n}.md#choice`, name: n, type: "Macro" });

  test("0 fresh choices while removing 3+ refuses and writes nothing", async () => {
    const { handler, quickadd, saveSettingsCalls, removedCommands } = build({
      notes: [],
      existingChoices: [owned("A"), owned("B"), owned("C")],
    });
    const res = await handler({ dry_run: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[suspicious_mass_removal\]/);
    assert.deepEqual(saveSettingsCalls, []);
    assert.equal(quickadd.settings.choices.length, 3);
    assert.deepEqual(removedCommands, []);
  });

  test("dry_run still SHOWS the would-be mass removal instead of refusing", async () => {
    const { handler } = build({ notes: [], existingChoices: [owned("A"), owned("B"), owned("C")] });
    const res = await handler({ dry_run: true });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.removed.length, 3);
  });

  test("removing 2 with 0 fresh choices is below the threshold and applies normally", async () => {
    const { handler, quickadd, saveSettingsCalls } = build({
      notes: [],
      existingChoices: [owned("A"), owned("B")],
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(saveSettingsCalls.length, 1);
    assert.deepEqual(quickadd.settings.choices, []);
    assert.equal(res.structuredContent.removed.length, 2);
  });

  test("removing 3 while at least one fresh choice compiles is NOT suspicious", async () => {
    const { handler, saveSettingsCalls } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [owned("A"), owned("B"), owned("C")],
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(saveSettingsCalls.length, 1);
    assert.equal(res.structuredContent.removed.length, 3);
  });
});

describe("obsidian_quickadd_compile: partial-failure signaling", () => {
  test("a compile with an error returns isError while still reporting the good choices", async () => {
    const { handler } = build({
      notes: [
        macroNote("Choices/Bad.md", "Bad", "nope"),
        macroNote("Choices/Good.md", "Good", "stamp-title"),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const dry = await handler({ dry_run: true });
    assert.equal(dry.isError, true);
    assert.equal(dry.structuredContent.choices.length, 1);
    assert.equal(dry.structuredContent.choices[0].name, "Good");
    assert.equal(dry.structuredContent.errors.length, 1);

    const wet = await handler({ dry_run: false });
    assert.equal(wet.isError, true);
    assert.equal(wet.structuredContent.applied, 1);
    assert.equal(wet.structuredContent.errors.length, 1);
  });

  test("a fully clean compile is not an error", async () => {
    const { handler } = build({
      notes: [macroNote("Choices/Good.md", "Good", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
  });
});

describe("obsidian_quickadd_compile: hostile settings.choices entries", () => {
  test("a null / non-object / id-less entry is preserved untouched, never a TypeError", async () => {
    const junk = [null, "a string", 42, { name: "no id" }];
    const { handler, quickadd } = build({
      notes: [macroNote("Choices/Stamp title.md", "Stamp title", "stamp-title")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
      existingChoices: [...junk],
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.deepEqual(quickadd.settings.choices.slice(0, 4), junk);
    assert.equal(quickadd.settings.choices.length, 5);
  });
});

describe("obsidian_quickadd_compile: script wikilink subpaths", () => {
  test("[[script#Heading]] resolves to the note itself", async () => {
    const { handler } = build({
      notes: [macroNote("Choices/S.md", "S", "stamp-title#Usage")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].macro.commands[0].path, "Scripts/stamp-title.md");
  });

  test("[[script^block-id]] resolves to the note itself", async () => {
    const { handler } = build({
      notes: [macroNote("Choices/S.md", "S", "stamp-title^abc123")],
      links: { "stamp-title": "Scripts/stamp-title.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].macro.commands[0].path, "Scripts/stamp-title.md");
  });

  test("an unresolvable subpath link quotes the ORIGINAL raw text in the error", async () => {
    const { handler } = build({
      notes: [macroNote("Choices/S.md", "S", "nope#Usage")],
      links: {},
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /\[\[nope#Usage\]\]/);
  });
});
