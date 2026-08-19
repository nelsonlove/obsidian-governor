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

function templateNote(path, name, extra = {}) {
  return { path, frontmatter: { "quickadd-type": "template", name, ...extra } };
}

function captureNote(path, name, extra = {}) {
  return { path, frontmatter: { "quickadd-type": "capture", name, ...extra } };
}

function multiNote(path, name, extra = {}) {
  return { path, frontmatter: { "quickadd-type": "multi", name, ...extra } };
}

describe("obsidian_quickadd_compile — Template discovery", () => {
  test("compiles a Template note with a resolved template: wikilink", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", { template: "[[Daily Template]]" })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const compiled = res.structuredContent.choices.find((c) => c.name === "Daily");
    assert.equal(compiled.type, "Template");
    assert.equal(compiled.templatePath, "Templates/Daily.md");
  });

  test("a template: wikilink that fails to resolve fails only that note", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Broken.md", "Broken", { template: "[[Missing]]" })],
      links: {},
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
    assert.equal(res.structuredContent.choices.length, 0);
  });

  test("a missing template: field fails with a clear error", async () => {
    const { handler } = build({ notes: [templateNote("Choices/NoTemplate.md", "NoTemplate")] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /template/i);
  });

  test("folder/file_name_format/open_file frontmatter fields are threaded through", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", {
        template: "[[Daily Template]]", folder: "Journal/Daily", file_name_format: "{{DATE}}", open_file: true,
      })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Daily");
    assert.deepEqual(compiled.folder.folders, ["Journal/Daily"]);
    assert.equal(compiled.openFile, true);
  });

  // The resolved target is whatever the wikilink points at, and
  // getFirstLinkpathDest happily returns an attachment.
  test("a template: wikilink resolving to a non-markdown file is rejected, naming the file", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Bad.md", "Bad", { template: "[[some-attachment.png]]" })],
      links: { "some-attachment.png": "Attachments/some-attachment.png" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /Attachments\/some-attachment\.png/);
    assert.match(res.structuredContent.errors[0].message, /non-markdown/i);
  });
});

describe("obsidian_quickadd_compile — exposed string fields: trimming and type", () => {
  test("a padded folder: is stored TRIMMED, not with its padding", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", {
        template: "[[Daily Template]]", folder: "  Journal/Daily  ",
      })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const compiled = res.structuredContent.choices.find((c) => c.name === "Daily");
    assert.deepEqual(compiled.folder.folders, ["Journal/Daily"]);
  });

  test("a padded file_name_format: is stored trimmed", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", {
        template: "[[Daily Template]]", file_name_format: "  {{DATE}}  ",
      })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Daily");
    assert.deepEqual(compiled.fileNameFormat, { enabled: true, format: "{{DATE}}" });
  });

  // QuickAdd matches insertAfter.after against a heading EXACTLY, so padding
  // here is a heading that can never be found.
  test("a padded insert_after_heading: is stored trimmed", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Log.md", "Log", { target: "[[Journal Log]]", insert_after_heading: "  ## Inbox  " })],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Log");
    assert.equal(compiled.insertAfter.after, "## Inbox");
  });

  test("a whitespace-only folder: reads as unset, not as an empty folder", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", { template: "[[Daily Template]]", folder: "   " })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Daily");
    assert.equal(compiled.folder.enabled, false);
    assert.deepEqual(compiled.folder.folders, []);
  });

  test("a wrong-typed folder: (a number) is a per-note error, never silently ignored", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", { template: "[[Daily Template]]", folder: 42 })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /folder/);
    assert.match(res.structuredContent.errors[0].message, /expected a string/i);
    assert.match(res.structuredContent.errors[0].message, /number/);
  });

  test("a wrong-typed insert_after_heading: on a Capture note is a per-note error too", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Log.md", "Log", { target: "[[Journal Log]]", insert_after_heading: ["## Inbox"] })],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /insert_after_heading/);
    assert.match(res.structuredContent.errors[0].message, /array/);
  });

  // `folder:` with no value parses to null in YAML — "not set", the same
  // reading resolveWaitStep gives a valueless `time:`.
  test("a valueless folder: (YAML null) reads as unset, not as a type error", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", { template: "[[Daily Template]]", folder: null })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].folder.enabled, false);
  });

  // Boolean fields keep the file's existing `=== true` convention: anything
  // that is not the literal boolean true is simply false, which is defined
  // and safe — deliberately NOT an error.
  test("a wrong-typed open_file: (the string \"true\") reads as false, not an error", async () => {
    const { handler } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", { template: "[[Daily Template]]", open_file: "true" })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].openFile, false);
  });
});

describe("obsidian_quickadd_compile — Capture discovery", () => {
  test("compiles a Capture note with a resolved target: wikilink", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Log.md", "Log", { target: "[[Journal Log]]" })],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const compiled = res.structuredContent.choices.find((c) => c.name === "Log");
    assert.equal(compiled.type, "Capture");
    assert.equal(compiled.captureTo, "Journal/Log.md");
  });

  test("a non-wikilink target: string is used verbatim (dynamic path)", async () => {
    const { handler } = build({ notes: [captureNote("Choices/Log.md", "Log", { target: "Journal/{{DATE}}.md" })] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const compiled = res.structuredContent.choices.find((c) => c.name === "Log");
    assert.equal(compiled.captureTo, "Journal/{{DATE}}.md");
  });

  // Same rationale as folder:/file_name_format:/insert_after_heading: — a
  // padded path is a path nobody has, and QuickAdd would create it verbatim.
  test("a padded literal target: string is trimmed", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Log.md", "Log", { target: "  Journal/{{DATE}}.md  " })],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].captureTo, "Journal/{{DATE}}.md");
  });

  // Other genuinely-literal shapes must keep compiling: the malformed-
  // wikilink guard keys on the "[[" substring and nothing else.
  for (const literal of ["Journal/{{DATE}}.md", "Inbox.md", "{{VALUE:folder}}/Log.md", "Journal/[2026]/Log.md"]) {
    test(`a literal target: "${literal}" still compiles verbatim`, async () => {
      const { handler } = build({ notes: [captureNote("Choices/Log.md", "Log", { target: literal })] });
      const res = await handler({ dry_run: true });
      assert.equal(res.structuredContent.errors.length, 0);
      assert.equal(res.structuredContent.choices[0].captureTo, literal);
    });
  }

  // `linkTarget` is anchored, so a near miss used to fall through to the
  // verbatim branch and compile a capture writing to a file literally named
  // `[[Journal Log].md`. `template:` hard-errors on the same shape.
  for (const malformed of ["[[Journal Log]", "[[Journal Log]] extra text", "prefix [[Journal Log]] suffix", "[[  ]]"]) {
    test(`a malformed wikilink target: ${JSON.stringify(malformed)} is a per-note error`, async () => {
      const { handler } = build({
        notes: [captureNote("Choices/Log.md", "Log", { target: malformed })],
        links: { "Journal Log": "Journal/Log.md" },
      });
      const res = await handler({ dry_run: true });
      assert.equal(res.structuredContent.choices.length, 0);
      assert.equal(res.structuredContent.errors.length, 1);
      assert.match(res.structuredContent.errors[0].message, /malformed \[\[wikilink\]\]/);
    });
  }

  test("a target: wikilink resolving to a non-markdown file is rejected, naming the file", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Bad.md", "Bad", { target: "[[some-attachment.png]]" })],
      links: { "some-attachment.png": "Attachments/some-attachment.png" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /Attachments\/some-attachment\.png/);
    assert.match(res.structuredContent.errors[0].message, /non-markdown/i);
  });

  test("a target: wikilink that fails to resolve fails only that note", async () => {
    const { handler } = build({ notes: [captureNote("Choices/Broken.md", "Broken", { target: "[[Missing]]" })] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
  });

  test("a missing target: field fails with a clear error", async () => {
    const { handler } = build({ notes: [captureNote("Choices/NoTarget.md", "NoTarget")] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
  });

  test("prepend/task/insert_after_heading/create_if_missing frontmatter fields are threaded through", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Log.md", "Log", {
        target: "[[Journal Log]]", prepend: true, task: true,
        insert_after_heading: "## Inbox", create_if_missing: true,
      })],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: true });
    const compiled = res.structuredContent.choices.find((c) => c.name === "Log");
    assert.equal(compiled.prepend, true);
    assert.equal(compiled.task, true);
    assert.equal(compiled.insertAfter.after, "## Inbox");
    assert.equal(compiled.createFileIfItDoesntExist.enabled, true);
  });
});

describe("obsidian_quickadd_compile — Multi discovery", () => {
  test("a sibling capture/template/macro note directly in a Multi's folder nests, not top-level", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/My Multi/My Multi.md", "My Multi"),
        captureNote("Choices/My Multi/A Capture.md", "A Capture", { target: "some/path.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    // ONE top-level choice — the Multi. The Capture note does NOT ALSO
    // appear top-level.
    assert.equal(res.structuredContent.choices.length, 1);
    const multi = res.structuredContent.choices[0];
    assert.equal(multi.type, "Multi");
    assert.equal(multi.choices.length, 1);
    assert.equal(multi.choices[0].name, "A Capture");
  });

  test("multiple siblings nest in alphabetical order by path", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/My Multi/My Multi.md", "My Multi"),
        captureNote("Choices/My Multi/Zebra.md", "Zebra", { target: "z.md" }),
        captureNote("Choices/My Multi/Apple.md", "Apple", { target: "a.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    const multi = res.structuredContent.choices[0];
    assert.deepEqual(multi.choices.map((c) => c.name), ["Apple", "Zebra"]);
  });

  test("Multi-in-Multi: a subfolder anchored by its own multi-note nests as a nested Multi", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/Outer/Outer.md", "Outer"),
        multiNote("Choices/Outer/Inner/Inner.md", "Inner"),
        captureNote("Choices/Outer/Inner/Leaf.md", "Leaf", { target: "leaf.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices.length, 1);
    const outer = res.structuredContent.choices[0];
    assert.equal(outer.choices.length, 1);
    const inner = outer.choices[0];
    assert.equal(inner.type, "Multi");
    assert.equal(inner.choices.length, 1);
    assert.equal(inner.choices[0].name, "Leaf");
  });

  test("a note in a folder with NO multi-note stays top-level (regression check)", async () => {
    const { handler } = build({
      notes: [captureNote("Choices/Plain/A Capture.md", "A Capture", { target: "x.md" })],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].type, "Capture");
  });

  test("an ambiguous folder (2 multi-notes claiming the same folder) fails BOTH notes; siblings stay top-level", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/Ambiguous/First.md", "First"),
        multiNote("Choices/Ambiguous/Second.md", "Second"),
        captureNote("Choices/Ambiguous/Sibling.md", "Sibling", { target: "s.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 2);
    assert.ok(res.structuredContent.errors.every((e) => /ambiguous/i.test(e.message)));
    // The sibling capture note is unaffected — it's neither an ambiguous
    // multi-note nor claimed by one (an ambiguous folder is treated as
    // UNCLAIMED for membership purposes), so it stays top-level.
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].name, "Sibling");
  });

  test("a Macro choice: step CANNOT target a Multi choice — still a dangling-reference error", async () => {
    const { handler } = build({
      notes: [
        multiNote("Choices/My Multi/My Multi.md", "My Multi"),
        macroNoteWithSteps("Choices/Referrer.md", "Referrer", [{ kind: "choice", choice: "[[My Multi]]" }]),
      ],
      links: { "My Multi": "Choices/My Multi/My Multi.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /does not declare a quickadd-type this compiler compiles/);
  });

  test("an empty Multi folder (no members) compiles a Multi with an empty choices array", async () => {
    const { handler } = build({ notes: [multiNote("Choices/Empty/Empty.md", "Empty")] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.deepEqual(res.structuredContent.choices[0].choices, []);
  });

  // parentFolder("") === "" (idempotent at the vault-root boundary), so a
  // multi-note living directly at vault root has ownFolder === "" and its
  // "grandparent" would ALSO be "" — the same value that note itself
  // anchors. Without a guard this reads as self-claiming and the note (plus
  // every other root-level note it would have claimed) silently vanishes
  // from the compile with zero errors. This is the vault-root analogue of
  // the ordinary "sibling nests, not top-level" case above.
  test("a root-level Multi note claims a root-level sibling as a member (vault-root boundary)", async () => {
    const { handler } = build({
      notes: [
        multiNote("Multi.md", "Multi"),
        captureNote("Capture.md", "Capture", { target: "some/path.md" }),
      ],
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices.length, 1);
    const multi = res.structuredContent.choices[0];
    assert.equal(multi.type, "Multi");
    assert.equal(multi.choices.length, 1);
    assert.equal(multi.choices[0].name, "Capture");
  });

  test("a LONE root-level Multi note with no siblings compiles as an empty Multi, not vanishing", async () => {
    const { handler } = build({ notes: [multiNote("Multi.md", "Multi")] });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].type, "Multi");
    assert.deepEqual(res.structuredContent.choices[0].choices, []);
  });
});

describe("obsidian_quickadd_compile — mixed choice types in one compile", () => {
  test("Macro, Template, and Capture notes all compile together", async () => {
    const { handler } = build({
      notes: [
        macroNote("Choices/M.md", "M", "stamp-title"),
        templateNote("Choices/T.md", "T", { template: "[[Tmpl]]" }),
        captureNote("Choices/C.md", "C", { target: "[[Cap]]" }),
      ],
      links: { "stamp-title": "Scripts/stamp-title.md", "Tmpl": "Templates/Tmpl.md", "Cap": "Capture/Cap.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices.length, 3);
    assert.ok(res.structuredContent.choices.some((c) => c.type === "Macro"));
    assert.ok(res.structuredContent.choices.some((c) => c.type === "Template"));
    assert.ok(res.structuredContent.choices.some((c) => c.type === "Capture"));
  });
});

describe("obsidian_quickadd_compile — Template/Capture apply path (dry_run: false)", () => {
  test("a Template choice actually lands in quickadd.settings.choices and registers its command", async () => {
    const { handler, quickadd, saveSettingsCalls, addedCommands } = build({
      notes: [templateNote("Choices/Daily.md", "Daily", { template: "[[Daily Template]]", folder: "Journal/Daily" })],
      links: { "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(saveSettingsCalls.length, 1);
    assert.equal(quickadd.settings.choices.length, 1);
    const applied = quickadd.settings.choices[0];
    assert.equal(applied.type, "Template");
    assert.equal(applied.id, "qan:Choices/Daily.md#choice");
    assert.equal(applied.templatePath, "Templates/Daily.md");
    assert.deepEqual(applied.folder.folders, ["Journal/Daily"]);
    assert.deepEqual(addedCommands, [applied]);
  });

  test("a Capture choice actually lands in quickadd.settings.choices and registers its command", async () => {
    const { handler, quickadd, saveSettingsCalls, addedCommands } = build({
      notes: [captureNote("Choices/Log.md", "Log", { target: "[[Journal Log]]", insert_after_heading: "## Inbox" })],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: false });
    assert.notEqual(res.isError, true);
    assert.equal(saveSettingsCalls.length, 1);
    assert.equal(quickadd.settings.choices.length, 1);
    const applied = quickadd.settings.choices[0];
    assert.equal(applied.type, "Capture");
    assert.equal(applied.id, "qan:Choices/Log.md#choice");
    assert.equal(applied.captureTo, "Journal/Log.md");
    assert.equal(applied.insertAfter.after, "## Inbox");
    assert.deepEqual(addedCommands, [applied]);
  });

  test("a failing Template note applies nothing while a good Capture note beside it still lands", async () => {
    const { handler, quickadd } = build({
      notes: [
        templateNote("Choices/Broken.md", "Broken", { template: "[[Missing]]" }),
        captureNote("Choices/Log.md", "Log", { target: "[[Journal Log]]" }),
      ],
      links: { "Journal Log": "Journal/Log.md" },
    });
    const res = await handler({ dry_run: false });
    assert.equal(res.isError, true);
    assert.deepEqual(quickadd.settings.choices.map((c) => c.name), ["Log"]);
  });
});

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

  // `multi` used to be this test's example of an "unrecognized" type before
  // Stage D made it discoverable — it no longer fits here (see the "Multi
  // discovery" describe block above for its own coverage, including
  // folder-anchoring). This test now uses a genuinely unrecognized type.
  test("a note with an unrecognized quickadd-type is ignored, not an error", async () => {
    const { handler } = build({
      notes: [
        { path: "Choices/M.md", frontmatter: { "quickadd-type": "unknown-type", name: "M" } },
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

  test("a choice: link to an ordinary markdown note (no quickadd-type) is rejected", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Bad.md", "Bad", [{ kind: "choice", choice: "[[Plain]]" }]),
        { path: "Notes/Plain.md", frontmatter: { title: "Plain" } },
      ],
      links: { "Plain": "Notes/Plain.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /Notes\/Plain\.md/);
    assert.match(res.structuredContent.errors[0].message, /quickadd-type this compiler compiles/);
  });

  // QuickAdd's ChoiceExecutor.execute() switches on the referenced choice's
  // own type with real cases for Template, Capture, Macro and Multi — a Choice
  // step is NOT restricted to Macro targets. Anything this compiler actually
  // compiles is a legitimate target.
  test("a choice: link to a quickadd-type: template note compiles", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Outer.md", "Outer", [{ kind: "choice", choice: "[[Tmpl]]" }]),
        templateNote("Choices/Tmpl.md", "Tmpl", { template: "[[Daily Template]]" }),
      ],
      links: { "Tmpl": "Choices/Tmpl.md", "Daily Template": "Templates/Daily.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const outer = res.structuredContent.choices.find((c) => c.name === "Outer");
    assert.equal(outer.macro.commands[0].type, "Choice");
    assert.equal(outer.macro.commands[0].choiceId, "qan:Choices/Tmpl.md#choice");
    assert.equal(outer.macro.commands[0].name, "Tmpl");
  });

  test("a choice: link to a quickadd-type: capture note compiles", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Outer.md", "Outer", [{ kind: "choice", choice: "[[Log]]" }]),
        captureNote("Choices/Log.md", "Log", { target: "Journal/Log.md" }),
      ],
      links: { "Log": "Choices/Log.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    const outer = res.structuredContent.choices.find((c) => c.name === "Outer");
    assert.equal(outer.macro.commands[0].type, "Choice");
    assert.equal(outer.macro.commands[0].choiceId, "qan:Choices/Log.md#choice");
    assert.equal(outer.macro.commands[0].name, "Log");
  });

  // Stage D: quickadd-type: multi notes are now discovered and compiled (a
  // Multi choice, here an empty one — see the "Multi discovery" describe
  // block above), so the Multi note itself DOES appear in `choices`. What's
  // still rejected is using it as a choice: step TARGET (native QuickAdd's
  // own restriction — a Multi is opened, not invoked from a Macro step).
  test("a choice: link to a quickadd-type: multi note is rejected as a choice: step target", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/Bad.md", "Bad", [{ kind: "choice", choice: "[[Folder]]" }]),
        { path: "Choices/Folder.md", frontmatter: { "quickadd-type": "multi", name: "Folder" } },
      ],
      links: { "Folder": "Choices/Folder.md" },
    });
    const res = await handler({ dry_run: true });
    // ONE compiled choice — the empty "Folder" Multi. "Bad" lives in the
    // same folder Folder.md anchors, so it's claimed as a NESTED member of
    // Folder rather than evaluated as a would-be top-level entry; its
    // failed choice: step surfaces as a nested error bubbled up through
    // transformMulti, and it is omitted from Folder's own (empty) `choices`.
    assert.equal(res.structuredContent.choices.length, 1);
    assert.equal(res.structuredContent.choices[0].type, "Multi");
    assert.equal(res.structuredContent.errors.length, 1);
    assert.match(res.structuredContent.errors[0].message, /quickadd-type this compiler compiles/);
    assert.match(res.structuredContent.errors[0].message, /macro, template, capture/);
  });

  test("a choice: link to a note with NO frontmatter cache at all is rejected, never a TypeError", async () => {
    const { handler } = build({
      // "Ghost.md" is a link target with no entry in `notes`, so getFileCache
      // returns null for it — the cold-cache shape.
      notes: [macroNoteWithSteps("Choices/Bad.md", "Bad", [{ kind: "choice", choice: "[[Ghost]]" }])],
      links: { "Ghost": "Notes/Ghost.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.choices.length, 0);
    assert.match(res.structuredContent.errors[0].message, /quickadd-type this compiler compiles/);
  });
});

describe("obsidian_quickadd_compile: multi-note choice cycles", () => {
  test("two notes referencing each other fail BOTH, naming both paths", async () => {
    const { handler } = build({
      notes: [
        macroNoteWithSteps("Choices/A.md", "A", [{ kind: "choice", choice: "[[B]]" }]),
        macroNoteWithSteps("Choices/B.md", "B", [{ kind: "choice", choice: "[[A]]" }]),
      ],
      links: { "A": "Choices/A.md", "B": "Choices/B.md" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.choices.length, 0);
    assert.equal(res.structuredContent.errors.length, 2);
    assert.deepEqual(res.structuredContent.errors.map((e) => e.notePath).sort(), [
      "Choices/A.md",
      "Choices/B.md",
    ]);
    for (const e of res.structuredContent.errors) {
      assert.match(e.message, /reference cycle/i);
      // Not the single-note self-reference message.
      assert.doesNotMatch(e.message, /same note/i);
      assert.match(e.message, /Choices\/A\.md/);
      assert.match(e.message, /Choices\/B\.md/);
    }
  });

  test("a cycle is never applied — a non-dry-run writes neither of the two choices", async () => {
    const { handler, quickadd } = build({
      notes: [
        macroNoteWithSteps("Choices/A.md", "A", [{ kind: "choice", choice: "[[B]]" }]),
        macroNoteWithSteps("Choices/B.md", "B", [{ kind: "choice", choice: "[[A]]" }]),
        macroNote("Choices/Fine.md", "Fine", "stamp-title"),
      ],
      links: {
        "A": "Choices/A.md",
        "B": "Choices/B.md",
        "stamp-title": "Scripts/stamp-title.md",
      },
    });
    const res = await handler({ dry_run: false });
    assert.equal(res.isError, true);
    assert.deepEqual(quickadd.settings.choices.map((c) => c.name), ["Fine"]);
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

  // The registry is a plain object, so `constructor` / `toString` / `valueOf`
  // all answer an Object.prototype member whose `.name` IS a truthy string.
  // A raw lookup would pass the "no registered command" check and compile a
  // dead Obsidian command that only fails at QuickAdd run time.
  for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    test(`an Object.prototype member ("${inherited}") reads as NOT registered`, async () => {
      const { handler } = build({
        notes: [macroNoteWithSteps("Choices/O.md", "O", [{ kind: "obsidian-command", command_id: inherited }])],
        commands: { "some:real-command": "Some real command" },
      });
      const res = await handler({ dry_run: true });
      assert.equal(res.structuredContent.choices.length, 0);
      assert.equal(res.structuredContent.errors.length, 1);
      assert.match(res.structuredContent.errors[0].message, /no registered command/);
      assert.match(res.structuredContent.errors[0].message, new RegExp(inherited));
    });
  }

  test("an OWN property named like a prototype member still resolves normally", async () => {
    const { handler } = build({
      notes: [macroNoteWithSteps("Choices/O.md", "O", [{ kind: "obsidian-command", command_id: "toString" }])],
      commands: { "toString": "A plugin really did register this" },
    });
    const res = await handler({ dry_run: true });
    assert.equal(res.structuredContent.errors.length, 0);
    assert.equal(res.structuredContent.choices[0].macro.commands[0].name, "A plugin really did register this");
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
