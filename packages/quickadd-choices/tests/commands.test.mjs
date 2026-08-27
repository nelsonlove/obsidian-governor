/**
 * commands.test.mjs — the in-Obsidian palette commands (the human's own
 * way to compile).
 *
 * What matters here is not the compiling (tool.ts's 112 tests own that) but
 * the REPORTING: a human sees one Notice and nothing else, so that line has
 * to be honest about partial compiles, refusals, and stale palette commands.
 * "Absence rendering as success" is the failure this file exists to catch.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { buildCommands } = await import("../src/commands.ts");

/** A fake app whose QuickAdd + vault produce a chosen compile outcome. */
function appWith({ notes = [], links = {}, existingChoices = [], quickadd = undefined } = {}) {
  const fakeFile = (path) => {
    const dot = path.lastIndexOf(".");
    return { path, extension: dot > path.lastIndexOf("/") ? path.slice(dot + 1) : "" };
  };
  const qa =
    quickadd === undefined
      ? { settings: { choices: existingChoices }, saveSettings: async () => {}, addCommandForChoice: () => {}, removeCommandForChoice: () => {} }
      : quickadd;
  return {
    vault: { getMarkdownFiles: () => notes.map((n) => fakeFile(n.path)) },
    metadataCache: {
      getFileCache: (file) => {
        const n = notes.find((x) => x.path === file.path);
        return n ? { frontmatter: n.frontmatter } : null;
      },
      getFirstLinkpathDest: (t) => (links[t] ? fakeFile(links[t]) : null),
    },
    plugins: { plugins: qa === null ? {} : { quickadd: qa } },
    commands: { commands: {} },
  };
}

const macroNote = (path, name, script) => ({
  path,
  frontmatter: { "quickadd-type": "macro", name, steps: [{ kind: "userscript", script: `[[${script}]]` }] },
});

function commandsOf(app) {
  const list = buildCommands(app);
  return { list, byId: Object.fromEntries(list.map((c) => [c.id, c])) };
}

describe("the two commands exist and are distinguishable", () => {
  test("dry-run and apply, each named so the palette says which one mutates", () => {
    const { list, byId } = commandsOf(appWith());
    assert.equal(list.length, 2);
    assert.ok(byId["compile-dry-run"], "a dry-run command");
    assert.ok(byId["compile-apply"], "an apply command");
    assert.match(byId["compile-dry-run"].name, /dry run/i);
    assert.match(byId["compile-apply"].name, /apply/i);
  });
});

describe("the Notice tells the truth", () => {
  test("a clean dry run reports the diff and applies nothing", async () => {
    const app = appWith({
      notes: [macroNote("Choices/A.md", "A", "s")],
      links: { s: "Scripts/s.md" },
    });
    let saved = 0;
    app.plugins.plugins.quickadd.saveSettings = async () => { saved++; };
    const out = await commandsOf(app).byId["compile-dry-run"].run();
    assert.equal(out.isError, false);
    assert.match(out.text, /dry run/i);
    assert.match(out.text, /1 added/);
    assert.equal(saved, 0, "a dry run writes nothing");
  });

  test("a clean apply reports what is now live", async () => {
    const app = appWith({ notes: [macroNote("Choices/A.md", "A", "s")], links: { s: "Scripts/s.md" } });
    const out = await commandsOf(app).byId["compile-apply"].run();
    assert.equal(out.isError, false);
    assert.match(out.text, /compiled/i);
    assert.match(out.text, /1 added/);
    assert.match(out.text, /1 choice now live/);
  });

  test("PARTIAL COMPILE IS NEVER SILENT: a failing note surfaces in the Notice and flags the outcome", async () => {
    const app = appWith({
      notes: [
        macroNote("Choices/Good.md", "Good", "s"),
        macroNote("Choices/Bad.md", "Bad", "missing"), // link resolves to nothing
      ],
      links: { s: "Scripts/s.md" },
    });
    const out = await commandsOf(app).byId["compile-apply"].run();
    assert.equal(out.isError, true, "a partial compile is not a success");
    assert.match(out.text, /1 note failed|notes failed/i);
    assert.match(out.text, /Bad\.md/, "the Notice names the note, so it is actionable without a console");
    assert.ok(out.durationMs >= 12000, "a Notice with detail to read lingers");
  });

  test("a refusal shows its code and reason, and applies nothing", async () => {
    const app = appWith({ quickadd: null }); // QuickAdd absent
    const out = await commandsOf(app).byId["compile-apply"].run();
    assert.equal(out.isError, true);
    assert.match(out.text, /refused/i);
    assert.match(out.text, /quickadd_unavailable:/);
  });

  test("a mass-removal refusal reaches the human verbatim (the guard is the protection, and it must be READABLE)", async () => {
    const owned = ["a", "b", "c"].map((n) => ({ id: `qan:Choices/${n}.md#choice`, name: n, type: "Macro" }));
    const app = appWith({ notes: [], existingChoices: owned });
    const out = await commandsOf(app).byId["compile-apply"].run();
    assert.equal(out.isError, true);
    assert.match(out.text, /suspicious_mass_removal:/);
    assert.match(out.text, /metadata cache/i, "it tells the human what to do about it");
  });

  test("a stale command API is reported, not swallowed — the config wrote but the palette did not", async () => {
    const app = appWith({ notes: [macroNote("Choices/A.md", "A", "s")], links: { s: "Scripts/s.md" } });
    delete app.plugins.plugins.quickadd.addCommandForChoice;
    delete app.plugins.plugins.quickadd.removeCommandForChoice;
    const out = await commandsOf(app).byId["compile-apply"].run();
    assert.match(out.text, /stale until QuickAdd reloads/i);
  });

  test("run() NEVER throws — a command callback that rejects would be an unhandled rejection in the UI", async () => {
    const exploding = { get settings() { throw new Error("boom"); } };
    const app = appWith({ quickadd: exploding });
    const out = await commandsOf(app).byId["compile-apply"].run();
    assert.equal(out.isError, true);
    assert.match(out.text, /refused/i);
  });
});

describe("wiring and boundaries, pinned at the source", () => {
  const mainSrc = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const cmdSrc = fs.readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8");

  test("main.ts registers BOTH commands from buildCommands and shows each outcome as a Notice", () => {
    assert.match(mainSrc, /for \(const command of buildCommands\(this\.app\)\)/, "commands come from the one builder — never hand-listed");
    assert.match(mainSrc, /this\.addCommand\(/);
    assert.match(mainSrc, /new Notice\(outcome\.text, outcome\.durationMs\)/);
  });

  test("NO WATCHER: the plugin binds no vault/metadata event and no interval (compiling is asked for, never automatic)", () => {
    for (const forbidden of ["registerEvent", "registerInterval", "vault.on(", "metadataCache.on(", "setInterval", "onLayoutReady"]) {
      assert.ok(!mainSrc.includes(forbidden), `main.ts must not use ${forbidden} — auto-compiling would rewrite another plugin's config unasked`);
    }
  });

  test("commands.ts stays pure: no obsidian import, no DOM, no Notice of its own", () => {
    assert.ok(!/from "obsidian"/.test(cmdSrc.replace(/import type[^;]+;/g, "")), "only a TYPE import of obsidian is allowed");
    assert.ok(!/new Notice|document\.|window\./.test(cmdSrc), "the module returns text; main.ts does the showing");
  });
});
