import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerQuickAddTools } = await import("../src/mcp/tools-quickadd.ts");

// A minimal fake note: frontmatter + a resolvable-or-not set of wikilinks.
// `extension` mirrors Obsidian's TFile — derived from the path, so a link
// target can be a non-markdown file (an attachment) the way it can live.
function fakeFile(path) {
  const dot = path.lastIndexOf(".");
  return { path, extension: dot > path.lastIndexOf("/") ? path.slice(dot + 1) : "" };
}

function build({ notes = [], links = {}, existingChoices = [], settings = {}, commandApi = true, commands = {} } = {}) {
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
    commands: { commands: Object.fromEntries(Object.entries(commands).map(([id, name]) => [id, { name }])) },
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

function macroNoteWithSteps(path, name, steps) {
  return { path, frontmatter: { "quickadd-type": "macro", name, steps } };
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

describe("obsidian_quickadd_compile: choice step", () => {
  test("resolves a choice: wikilink to the target note's derived choiceId", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Outer.md", "Outer", [{ kind: "choice", choice: "[[Inner]]" }]),
        macroNote("Choices/Inner.md", "Inner", "some-script"),
      ],
      links: { "Inner": "Choices/Inner.md", "some-script": "Scripts/some-script.md" },
    });
    const res = await handler({ dry_run: true });
    const outer = res.structuredContent.choices.find((c) => c.name === "Outer");
    assert.equal(outer.macro.commands[0].type, "Choice");
    assert.match(outer.macro.commands[0].choiceId, /^qan:Choices\/Inner\.md#choice$/);
  });

  test("an unresolvable choice: link is a per-note error", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/Bad.md", "Bad", [{ kind: "choice", choice: "[[Nope]]" }])],
      links: {},
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /could not resolve/);
  });

  test("the compiled command carries the TARGET note's own name, not the literal \"Choice\"", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Outer.md", "Outer", [{ kind: "choice", choice: "[[Inner]]" }]),
        macroNote("Choices/Inner.md", "Add UID to current note", "some-script"),
      ],
      links: { "Inner": "Choices/Inner.md", "some-script": "Scripts/some-script.md" },
    });
    const res = await handler({ dry_run: true });
    const outer = res.structuredContent.choices.find((c) => c.name === "Outer");
    assert.equal(outer.macro.commands[0].name, "Add UID to current note");
    assert.notEqual(outer.macro.commands[0].name, "Choice");
  });

  test("a target note with no name: frontmatter falls back to its basename", async () => {
    const inner = macroNote("Choices/Inner Note.md", undefined, "some-script");
    delete inner.frontmatter.name;
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Outer.md", "Outer", [{ kind: "choice", choice: "[[Inner Note]]" }]),
        inner,
      ],
      links: { "Inner Note": "Choices/Inner Note.md", "some-script": "Scripts/some-script.md" },
    });
    const res = await handler({ dry_run: true });
    const outer = res.structuredContent.choices.find((c) => c.name === "Outer");
    assert.equal(outer.macro.commands[0].name, "Inner Note");
  });

  test("a self-referencing choice: link is rejected with a clear error and does not compile", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/Self.md", "Self", [{ kind: "choice", choice: "[[Self]]" }])],
      links: { "Self": "Choices/Self.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.equal(res.structuredContent.errors.length, 1);
    assert.equal(res.structuredContent.errors[0].notePath, "Choices/Self.md");
    assert.match(res.structuredContent.errors[0].message, /same note/i);
    assert.match(res.structuredContent.errors[0].message, /loop forever/i);
  });

  test("a choice: link resolving to a non-markdown file is rejected, naming the resolved path", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/Bad.md", "Bad", [{ kind: "choice", choice: "[[diagram]]" }])],
      links: { "diagram": "Attachments/diagram.png" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /Attachments\/diagram\.png/);
    assert.match(res.structuredContent.errors[0].message, /not a markdown note/i);
  });
});

describe("obsidian_quickadd_compile: wait step", () => {
  test("time: defaults to 100 when omitted", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait" }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 100);
  });

  test("a valueless `time:` (YAML null) defaults to 100, not 0", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: null }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 100);
  });

  test("an empty-string time: defaults to 100, not 0", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: "" }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 100);
  });

  test("a whitespace-only time: defaults to 100, not 0", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: "   " }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 100);
  });

  test("an explicit time: 0 is still honored as 0, not turned into the default", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: 0 }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 0);
  });

  test("an explicit time: is used as-is", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: 500 }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices[0].macro.commands[0].time, 500);
  });

  test("a negative or non-numeric time: is a per-note error", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/W.md", "W", [{ kind: "wait", time: -5 }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /time/i);
  });
});

describe("obsidian_quickadd_compile: obsidian-command step", () => {
  test("resolves command_id to the currently-registered command's display name", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/O.md", "O", [{ kind: "obsidian-command", command_id: "obsidian-linter:lint-file-unless-ignored" }])],
      commands: { "obsidian-linter:lint-file-unless-ignored": "Linter: Lint the current file unless ignored" },
    });
    const res = await handler({ dry_run: true });
    const cmd = res.structuredContent.choices[0].macro.commands[0];
    assert.equal(cmd.type, "Obsidian");
    assert.equal(cmd.commandId, "obsidian-linter:lint-file-unless-ignored");
    assert.equal(cmd.name, "Linter: Lint the current file unless ignored");
  });

  test("an unregistered command_id is a per-note error", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/O.md", "O", [{ kind: "obsidian-command", command_id: "nope:nothing" }])],
      commands: {},
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /nope:nothing/);
  });
});

describe("obsidian_quickadd_compile: editor-command step", () => {
  test("a known editor_command value compiles", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/E.md", "E", [{ kind: "editor-command", editor_command: "Copy" }])] });
    const res = await handler({ dry_run: true });
    const cmd = res.structuredContent.choices[0].macro.commands[0];
    assert.equal(cmd.type, "EditorCommand");
    assert.equal(cmd.editorCommandType, "Copy");
  });

  test("an unknown editor_command value is a per-note error naming the value", async () => {
    const { handler } = build({ notes: [macroNoteWithSteps("Choices/E.md", "E", [{ kind: "editor-command", editor_command: "Not A Real One" }])] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /Not A Real One/);
  });
});
