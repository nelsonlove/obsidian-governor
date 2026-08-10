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

const readerOf = (map) => async (name) => (name in map ? map[name] : null);

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

  test("resolves literal path, then name.md, then the templates folder", async () => {
    const files = {
      "T/direct.md": { content: "direct" },
      "loose.md": { content: "loose" },
      "Templates/Meeting.md": { content: "meeting" },
    };
    const read = obsidianTemplateReader(fakeApp(files, "Templates"));
    assert.equal(await read("T/direct.md"), "direct");
    assert.equal(await read("loose"), "loose");
    assert.equal(await read("Meeting"), "meeting");
  });

  test("skips folders, returns null on misses and read failures — never throws", async () => {
    const files = {
      Templates: { children: [] },
      "Templates/Broken.md": { get content() { throw new Error("io"); } },
    };
    const read = obsidianTemplateReader(fakeApp(files, "Templates"));
    assert.equal(await read("Ghost"), null);
    assert.equal(await read("Templates"), null);
    assert.equal(await read("Broken"), null);
  });

  test("no templates folder configured: literal candidates only", async () => {
    const read = obsidianTemplateReader({
      internalPlugins: {},
      vault: { getAbstractFileByPath: () => null, cachedRead: async () => "" },
    });
    assert.equal(await read("Anything"), null);
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
