/**
 * cli-template-guard.test.mjs — the create-from-template closure: the template
 * a call only NAMES is resolved, read, and scanned with the same
 * accepted-family rule as direct content, BEFORE the command runs.
 *
 * Load-bearing properties:
 *   • template-carrying calls (create template=, quickadd:run-template path=)
 *     are scanned; everything else is untouched;
 *   • an acceptance-carrying template refuses accept_forbidden pre-exec;
 *   • an unresolvable/unreadable template FAILS CLOSED, as does a build with
 *     no template reader at all;
 *   • the live reader resolves literal path → name.md → templates-folder
 *     candidates, skips folders, and returns null (never throws) on misses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  registerCliTools,
  templateAcceptRefusal,
  obsidianTemplateReader,
} from "../src/mcp/tools-cli.ts";

// A real-enough YAML parser for the accepted-family scan (the same shape the
// obsidian stub provides elsewhere): "k: v" lines only.
function parseYaml(y) {
  const out = {};
  for (const line of y.split("\n")) {
    const m = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const ACCEPTED_TEMPLATE = "---\nacceptance-status: accepted\n---\nbody";
const CLEAN_TEMPLATE = "---\nacceptance-status: proposed\ntags: []\n---\nbody";

const readerOf = (map) => async (name, _mode) => (name in map ? map[name] : null);

describe("templateAcceptRefusal", () => {
  test("non-template commands and template-less creates are untouched, reader or not", async () => {
    assert.equal(await templateAcceptRefusal("create", { name: "X", content: "hi" }, undefined, parseYaml), null);
    assert.equal(await templateAcceptRefusal("append", { path: "Evil.md" }, undefined, parseYaml), null);
    assert.equal(await templateAcceptRefusal("help", undefined, undefined, parseYaml), null);
  });

  test("an acceptance-carrying template refuses, naming the template", async () => {
    const r = await templateAcceptRefusal(
      "create",
      { name: "New", template: "Bad" },
      readerOf({ Bad: ACCEPTED_TEMPLATE }),
      parseYaml,
    );
    assert.ok(r && r.includes("'Bad'") && /accept/i.test(r));
  });

  test("a clean template passes", async () => {
    const r = await templateAcceptRefusal(
      "create",
      { name: "New", template: "Good" },
      readerOf({ Good: CLEAN_TEMPLATE }),
      parseYaml,
    );
    assert.equal(r, null);
  });

  test("quickadd:run-template's path param gets the same scan", async () => {
    const reader = readerOf({ "T/qa.md": ACCEPTED_TEMPLATE });
    const r = await templateAcceptRefusal("quickadd:run-template", { path: "T/qa.md" }, reader, parseYaml);
    assert.ok(r && r.includes("'T/qa.md'"));
  });

  test("fail closed: unresolvable template, throwing reader, and missing reader all refuse", async () => {
    const unresolvable = await templateAcceptRefusal("create", { template: "Ghost" }, readerOf({}), parseYaml);
    assert.ok(unresolvable && unresolvable.includes("could not be resolved"));
    const throwing = await templateAcceptRefusal(
      "create",
      { template: "Boom" },
      async () => { throw new Error("io"); },
      parseYaml,
    );
    assert.ok(throwing && throwing.includes("could not be resolved"));
    const noReader = await templateAcceptRefusal("create", { template: "Any" }, undefined, parseYaml);
    assert.ok(noReader && noReader.includes("cannot be inspected"));
  });

  test("no parser: a fenced template fails closed through the content rule", async () => {
    const r = await templateAcceptRefusal(
      "create",
      { template: "Fenced" },
      readerOf({ Fenced: "---\nanything: here\n---\n" }),
      undefined,
    );
    assert.ok(r && r.includes("cannot be verified"));
  });

  test("no escape-expansion on file bytes: literal backslash-n prose cannot manufacture a fence", async () => {
    // The CLI param scan expands \n escapes (the CLI un-escapes them before
    // writing); real template bytes must NOT be expanded — prose discussing
    // escapes would otherwise fabricate a fence and false-positive.
    const prose = 'Use "\\n---\\nacceptance-status: accepted\\n---\\n" to write fences in content params.';
    const r = await templateAcceptRefusal("create", { template: "Prose" }, readerOf({ Prose: prose }), parseYaml);
    assert.equal(r, null);
  });

  test("a non-string template param is coerced, not skipped (the CLI receives template=123 too)", async () => {
    // No reader entry for "123" ⇒ resolution fails ⇒ fail closed — the point
    // is the guard ENGAGES rather than treating a number as template-less.
    const r = await templateAcceptRefusal("create", { template: 123 }, readerOf({}), parseYaml);
    assert.ok(r && r.includes("'123'"));
  });
});

describe("obsidianTemplateReader", () => {
  function fakeApp(files, folder) {
    return {
      internalPlugins: { plugins: { templates: { instance: { options: { folder } } } } },
      vault: {
        getAbstractFileByPath: (p) => (p in files ? files[p] : null),
        cachedRead: async (f) => f.content,
      },
    };
  }

  test("templates-folder mode resolves ONLY inside the configured folder — a root decoy is never scanned", async () => {
    const files = {
      "Foo.md": { content: "decoy at root" },
      "Templates/Foo.md": { content: "the real template" },
      "Templates/Meeting.md": { content: "meeting" },
    };
    const read = obsidianTemplateReader(fakeApp(files, "Templates"));
    // The CLI resolves `template=Foo` in the Templates folder; so do we.
    assert.equal(await read("Foo", "templates-folder"), "the real template");
    assert.equal(await read("Meeting", "templates-folder"), "meeting");
    // A folder-less vault cannot resolve template names at all: fail closed
    // upstream rather than guessing at a literal path the CLI would not use.
    const noFolder = obsidianTemplateReader(fakeApp(files, undefined));
    assert.equal(await noFolder("Foo", "templates-folder"), null);
  });

  test("literal-path mode resolves the exact path (and path.md), nothing else", async () => {
    const files = {
      "T/qa.md": { content: "qa template" },
      "Templates/qa.md": { content: "wrong one" },
    };
    const read = obsidianTemplateReader(fakeApp(files, "Templates"));
    assert.equal(await read("T/qa.md", "literal-path"), "qa template");
    assert.equal(await read("T/qa", "literal-path"), "qa template");
    assert.equal(await read("qa", "literal-path"), null);
  });

  test("skips folders, returns null on misses, read failures AND resolver throws — never rejects", async () => {
    const files = {
      "Templates/Sub": { children: [] },
      "Templates/Broken.md": { get content() { throw new Error("io"); } },
    };
    const read = obsidianTemplateReader(fakeApp(files, "Templates"));
    assert.equal(await read("Ghost", "templates-folder"), null);
    assert.equal(await read("Sub", "templates-folder"), null);
    assert.equal(await read("Broken", "templates-folder"), null);
    // A resolver that throws (hostile name, host quirk) resolves null too —
    // the try wraps the whole probe, not just the read.
    const throwing = obsidianTemplateReader({
      internalPlugins: { plugins: { templates: { instance: { options: { folder: "T" } } } } },
      vault: { getAbstractFileByPath: () => { throw new Error("host"); }, cachedRead: async () => "" },
    });
    assert.equal(await throwing("Anything", "templates-folder"), null);
  });
});

describe("handler integration", () => {
  function ctxWith(settings = {}) {
    return {
      pluginVersion: "0.0.0-test",
      socketPath: "/tmp/x.sock",
      vaultName: "testvault",
      enabledPlugins: () => [],
      getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: false, ...settings }),
    };
  }

  function build(readTemplate) {
    const server = fakeServer();
    const calls = [];
    const exec = async (bin, args) => (calls.push(args), { exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    registerCliTools(server, ctxWith(), { binary: "/bin/obsidian", exec, parseYaml, readTemplate });
    return { handler: server.tools.get("obsidian_cli").handler, calls };
  }

  test("create from an acceptance-carrying template refuses accept_forbidden, never executes", async () => {
    const { handler, calls } = build(readerOf({ Bad: ACCEPTED_TEMPLATE }));
    const res = await handler({ command: "create", params: { name: "New", template: "Bad" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[accept_forbidden\]/);
    assert.equal(calls.length, 0);
  });

  test("create from a clean template runs", async () => {
    const { handler, calls } = build(readerOf({ Good: CLEAN_TEMPLATE }));
    const res = await handler({ command: "create", params: { name: "New", template: "Good" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("a build without a template reader fails closed on template-carrying calls only", async () => {
    const { handler, calls } = build(undefined);
    const refused = await handler({ command: "create", params: { name: "New", template: "Any" } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /accept_forbidden/);
    const plain = await handler({ command: "create", params: { name: "New", content: "hi" } });
    assert.notEqual(plain.isError, true);
    assert.equal(calls.length, 1);
  });
});
