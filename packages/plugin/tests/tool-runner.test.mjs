/**
 * tool-runner.test.mjs — the in-Obsidian dev tool-runner's pure half
 * (src/tool-runner-core.ts) plus its guarded-invocation contract.
 *
 * Covered headlessly:
 *   • tool-list capture: the picker's listing surfaces name/title/read-only
 *     marker/description, straight off the code-mode registry;
 *   • schema → form-field mapping: strings/numbers/booleans/enums/optional/
 *     JSON fallback, descriptions through wrapper order, kernel args excluded;
 *   • form-value parsing/assembly: required-missing, blank-optional omission,
 *     number/JSON/boolean parse failures reported per field;
 *   • the confirm-gate decision for mutating tools;
 *   • invocation goes through the GUARDED captured handler (the identical
 *     callCapturedTool path obsidian_call_tool uses): a mutating call in
 *     read-only mode is REFUSED through the runner, an out-of-allowlist write
 *     is refused, and accept-forbidden content is refused by the REAL
 *     ObsidianBackend write primitive registered through the same
 *     withKernelArgs + capture register server.ts uses.
 *
 * NOT covered here (un-headless by nature, verified live): the three modals
 * themselves (FuzzySuggestModal picker, args form, result modal) — they are
 * thin DOM shells over the functions tested here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { installObsidianStub, TFile } from "./obsidian-stub.mjs";

installObsidianStub();
const { makeGuarded, withKernelArgs, KERNEL_ARG_KEYS } = await import("../src/mcp/guarded.ts");
const { makeCaptureRegister } = await import("../src/mcp/tools-code-mode.ts");
const {
  listRunnerTools,
  formFieldsOf,
  parseFieldInput,
  buildRunArgs,
  needsConfirm,
  runsImmediately,
  runCapturedTool,
  renderResultText,
  errorLineOf,
} = await import("../src/tool-runner-core.ts");
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerFsTools } = await import("@vault-mcp/core");

const ACTOR = { transport: "mcp", client: "tool-runner", connection: "test" };

// ── a captured registry built EXACTLY the way server.ts builds one ───────────
// (makeGuarded wrap + makeCaptureRegister + withKernelArgs on every def), so
// what these tests exercise is the runner's real invocation path, not a fake.

function guardedRegistry({ settings = { readOnly: false, allowlist: [] }, kernel } = {}) {
  const registry = new Map();
  const guarded = makeGuarded({ getSettings: () => settings, actor: () => ACTOR, ...(kernel ? { kernel } : {}) });
  const capture = makeCaptureRegister(registry, guarded);
  const register = (name, def, handler) => capture(name, withKernelArgs(def), handler);
  return { registry, register };
}

const RO = { readOnlyHint: true };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ── tool listing ─────────────────────────────────────────────────────────────

describe("listRunnerTools", () => {
  test("surfaces name, title, description and the mutating marker, sorted", () => {
    const { registry, register } = guardedRegistry();
    register(
      "obsidian_write_x",
      { title: "Write X", description: "Writes a thing.", inputSchema: { path: z.string() }, annotations: RW },
      async () => ({ content: [] })
    );
    register(
      "obsidian_read_x",
      { title: "Read X", description: "Reads a thing.", inputSchema: { path: z.string() }, annotations: RO },
      async () => ({ content: [] })
    );
    const tools = listRunnerTools(registry);
    assert.deepEqual(
      tools.map((t) => [t.name, t.title, t.description, t.mutating]),
      [
        ["obsidian_read_x", "Read X", "Reads a thing.", false],
        ["obsidian_write_x", "Write X", "Writes a thing.", true],
      ]
    );
  });
});

// ── schema → form fields ─────────────────────────────────────────────────────

describe("formFieldsOf", () => {
  test("maps strings, numbers, booleans; JSON fallback for objects/arrays", () => {
    const fields = formFieldsOf({
      name: z.string().describe("The name."),
      count: z.number(),
      flag: z.boolean(),
      shape: z.object({ a: z.string() }),
      items: z.array(z.string()),
    });
    assert.deepEqual(
      fields.map((f) => [f.name, f.kind, f.optional]),
      [
        ["name", "string", false],
        ["count", "number", false],
        ["flag", "boolean", false],
        ["shape", "json", false],
        ["items", "json", false],
      ]
    );
    assert.equal(fields[0].description, "The name.");
  });

  test("optional flag and description survive either wrapper order", () => {
    const fields = formFieldsOf({
      inner: z.string().describe("inner-described").optional(),
      outer: z.string().optional().describe("outer-described"),
      dflt: z.number().default(3).describe("defaulted"),
    });
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    assert.equal(byName.inner.optional, true);
    assert.equal(byName.inner.description, "inner-described");
    assert.equal(byName.outer.optional, true);
    assert.equal(byName.outer.description, "outer-described");
    assert.equal(byName.dflt.optional, true);
    assert.equal(byName.dflt.kind, "number");
  });

  test("enums render as strings with their options in the description", () => {
    const [field] = formFieldsOf({ mode: z.enum(["source", "preview"]).describe("View mode.") });
    assert.equal(field.kind, "string");
    assert.match(field.description, /View mode\./);
    assert.match(field.description, /one of: source, preview/);
  });

  test("kernel args are excluded from the form — the wrapper peels them anyway", () => {
    // Run a real mutating def through withKernelArgs like server.ts does, so
    // the schema this asserts against is the CAPTURED shape.
    const def = withKernelArgs({ inputSchema: { path: z.string() }, annotations: RW });
    for (const key of KERNEL_ARG_KEYS) assert.ok(key in def.inputSchema, `${key} declared on the schema`);
    const fields = formFieldsOf(def.inputSchema);
    assert.deepEqual(fields.map((f) => f.name), ["path"]);
  });

  test("empty/absent schema yields no fields", () => {
    assert.deepEqual(formFieldsOf({}), []);
    assert.deepEqual(formFieldsOf(undefined), []);
  });
});

// ── form-value parsing / assembly ────────────────────────────────────────────

describe("parseFieldInput / buildRunArgs", () => {
  const fields = [
    { name: "path", kind: "string", optional: false },
    { name: "limit", kind: "number", optional: true },
    { name: "overwrite", kind: "boolean", optional: true },
    { name: "extra", kind: "json", optional: true },
  ];

  test("blank means missing for required, omit for optional", () => {
    assert.deepEqual(parseFieldInput(fields[0], ""), { error: "path: required" });
    assert.deepEqual(parseFieldInput(fields[1], ""), { omit: true });
    const built = buildRunArgs(fields, { path: "A.md" });
    assert.deepEqual(built, { args: { path: "A.md" } });
  });

  test("numbers, booleans and JSON parse; failures are per-field errors", () => {
    assert.deepEqual(parseFieldInput(fields[1], "5"), { value: 5 });
    assert.match(parseFieldInput(fields[1], "abc").error, /not a number/);
    assert.deepEqual(parseFieldInput(fields[2], "true"), { value: true });
    assert.deepEqual(parseFieldInput(fields[2], "false"), { value: false });
    assert.match(parseFieldInput(fields[2], "yep").error, /expected true or false/);
    assert.deepEqual(parseFieldInput(fields[3], '{"a":1}'), { value: { a: 1 } });
    assert.match(parseFieldInput(fields[3], "{nope").error, /invalid JSON/);
  });

  test("all field errors are reported at once", () => {
    const built = buildRunArgs(fields, { path: "", limit: "x", extra: "{" });
    assert.ok("errors" in built);
    assert.equal(built.errors.length, 3);
  });

  test("string values are passed through un-trimmed", () => {
    assert.deepEqual(parseFieldInput(fields[0], "  spaced.md "), { value: "  spaced.md " });
  });
});

// ── confirm-gate ─────────────────────────────────────────────────────────────

describe("confirm-gate for mutating tools", () => {
  test("needsConfirm ⇔ mutating", () => {
    assert.equal(needsConfirm({ mutating: true }), true);
    assert.equal(needsConfirm({ mutating: false }), false);
  });
  test("runs immediately only with zero fields AND read-only", () => {
    assert.equal(runsImmediately([], { mutating: false }), true);
    assert.equal(runsImmediately([], { mutating: true }), false, "a zero-arg mutating tool still confirms");
    assert.equal(runsImmediately([{ name: "p", kind: "string", optional: false }], { mutating: false }), false);
  });
});

// ── guarded invocation through the runner path ───────────────────────────────

describe("runCapturedTool — the guard travels", () => {
  test("a mutating call in read-only mode is REFUSED through the runner", async () => {
    let ran = false;
    const { registry, register } = guardedRegistry({ settings: { readOnly: true, allowlist: [] } });
    register(
      "obsidian_delete_note",
      { title: "Delete", inputSchema: { path: z.string() }, annotations: RW },
      async () => {
        ran = true;
        return { content: [{ type: "text", text: "deleted" }] };
      }
    );
    const run = await runCapturedTool(registry, "obsidian_delete_note", { path: "A.md" });
    assert.equal(run.result.isError, true);
    assert.match(run.result.content[0].text, /\[read_only\]/);
    assert.equal(ran, false, "the raw handler must never run");
  });

  test("an out-of-allowlist write is REFUSED through the runner", async () => {
    const { registry, register } = guardedRegistry({ settings: { readOnly: false, allowlist: ["Projects/"] } });
    register(
      "obsidian_write_note",
      { title: "Write", inputSchema: { path: z.string(), content: z.string() }, annotations: RW },
      async () => ({ content: [{ type: "text", text: "wrote" }] })
    );
    const run = await runCapturedTool(registry, "obsidian_write_note", { path: "Secret/A.md", content: "x" });
    assert.equal(run.result.isError, true);
    assert.match(run.result.content[0].text, /allowlist/i);
  });

  test("args are validated against the captured schema before the handler", async () => {
    let ran = false;
    const { registry, register } = guardedRegistry();
    register(
      "obsidian_read_note",
      { title: "Read", inputSchema: { path: z.string().min(1) }, annotations: RO },
      async () => {
        ran = true;
        return { content: [{ type: "text", text: "ok" }] };
      }
    );
    const run = await runCapturedTool(registry, "obsidian_read_note", {});
    assert.equal(run.result.isError, true);
    assert.match(run.result.content[0].text, /invalid args for 'obsidian_read_note'/);
    assert.equal(ran, false);
  });

  test("unknown tool refuses without running anything", async () => {
    const { registry } = guardedRegistry();
    const run = await runCapturedTool(registry, "nope", {});
    assert.equal(run.result.isError, true);
  });

  test("elapsedMs is measured and a thrown handler folds into an error envelope", async () => {
    const { registry, register } = guardedRegistry();
    register("obsidian_boom", { title: "Boom", inputSchema: {}, annotations: RO }, async () => {
      throw new Error("kaboom");
    });
    let t = 100;
    const run = await runCapturedTool(registry, "obsidian_boom", {}, () => (t += 7));
    assert.equal(run.elapsedMs, 7);
    assert.equal(run.result.isError, true);
    assert.match(run.result.content[0].text, /kaboom/);
  });
});

// ── accept-forbidden through the runner, against the REAL write primitive ────

function fakeApp(files = {}) {
  const store = new Map(Object.entries(files));
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p) : null),
      read: async (f) => store.get(f.path) ?? "",
      cachedRead: async (f) => store.get(f.path) ?? "",
      create: async (p, c) => {
        store.set(p, c);
      },
      modify: async (f, c) => {
        store.set(f.path, c);
      },
      append: async (f, c) => {
        store.set(f.path, (store.get(f.path) ?? "") + c);
      },
      createFolder: async () => {},
    },
    metadataCache: { getFileCache: () => ({}) },
    fileManager: {},
  };
  return { app, store };
}

describe("runCapturedTool — accept-forbidden refuses through the runner", () => {
  test("a body-injected accepted fence is refused and never lands", async () => {
    const { app, store } = fakeApp();
    const { registry, register } = guardedRegistry();
    // The same registration route server.ts takes: registerFsTools drives the
    // real ObsidianBackend through the guarded capture register.
    registerFsTools({ registerTool: register }, new ObsidianBackend(app), { decodeHtml: false });
    const run = await runCapturedTool(registry, "obsidian_write_note", {
      path: "New/A.md",
      content: "---\nacceptance-status: accepted\n---\nbody",
      overwrite: true,
    });
    assert.equal(run.result.isError, true);
    assert.match(run.result.content[0].text, /\[accept_forbidden\]/);
    assert.equal(store.has("New/A.md"), false, "a refused write must never land");
  });

  test("an ordinary write through the same path succeeds", async () => {
    const { app, store } = fakeApp();
    const { registry, register } = guardedRegistry();
    registerFsTools({ registerTool: register }, new ObsidianBackend(app), { decodeHtml: false });
    const run = await runCapturedTool(registry, "obsidian_write_note", {
      path: "New/B.md",
      content: "plain body",
      overwrite: true,
    });
    assert.notEqual(run.result.isError, true);
    assert.equal(store.get("New/B.md"), "plain body");
  });
});

// ── result rendering ─────────────────────────────────────────────────────────

describe("renderResultText / errorLineOf", () => {
  test("structured content wins, pretty-printed", () => {
    assert.equal(renderResultText({ structuredContent: { a: 1 } }), JSON.stringify({ a: 1 }, null, 2));
  });
  test("falls back to joined text blocks, then a placeholder", () => {
    assert.equal(renderResultText({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }), "one\ntwo");
    assert.equal(renderResultText({ content: [] }), "(no content)");
  });
  test("errorLineOf surfaces the typed refusal text only for errors", () => {
    assert.equal(errorLineOf({ isError: true, content: [{ type: "text", text: "Error [read_only]: blocked" }] }), "Error [read_only]: blocked");
    assert.equal(errorLineOf({ content: [{ type: "text", text: "fine" }] }), null);
    assert.equal(errorLineOf({ isError: true, content: [] }), "Error (no message)");
  });
});
