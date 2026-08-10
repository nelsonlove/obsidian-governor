/**
 * register-fs-tools.test.mjs — the read half of optimistic concurrency.
 *
 * `RegisterFsToolsOpts.rev` lets a host that tracks revisions (the Obsidian
 * plugin: file mtime) hand the note's current `rev` back with its content, so
 * the caller can pass it as `if_rev` on a following write. Hosts that supply no
 * `rev` — the filesystem server — must see byte-identical responses to before.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerFsTools } from "../src/register-fs-tools.ts";

/** Minimal ToolRegistrar: collect handlers by name instead of serving them. */
function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, meta, handler) {
      handlers.set(name, handler);
      return { name, meta };
    },
    call(name, args) {
      const h = handlers.get(name);
      if (!h) throw new Error(`no handler registered for ${name}`);
      return h(args);
    },
  };
}

/** Only the methods the read handlers touch; the other 15 are never invoked. */
function fakeBackend(notes) {
  return {
    async readNote(path) {
      const content = notes.get(path);
      if (content === undefined) throw new Error(`not found: ${path}`);
      return content;
    },
  };
}

const NOTES = new Map([
  ["A.md", "# A"],
  ["B.md", "# B"],
]);

describe("registerFsTools rev exposure", () => {
  test("obsidian_read_note carries the note's rev when the host supplies one", async () => {
    const server = fakeServer();
    registerFsTools(server, fakeBackend(NOTES), { rev: (p) => (p === "A.md" ? 1700 : undefined) });

    const res = await server.call("obsidian_read_note", { path: "A.md" });
    assert.deepEqual(res.structuredContent, { path: "A.md", content: "# A", rev: 1700 });

    // A path the host has no revision for simply carries no rev field.
    const other = await server.call("obsidian_read_note", { path: "B.md" });
    assert.deepEqual(other.structuredContent, { path: "B.md", content: "# B" });
  });

  test("without a rev source the response is exactly what it always was", async () => {
    const server = fakeServer();
    registerFsTools(server, fakeBackend(NOTES), {});
    const res = await server.call("obsidian_read_note", { path: "A.md" });
    assert.deepEqual(res.structuredContent, { path: "A.md", content: "# A" });
    assert.equal("rev" in res.structuredContent, false);
  });

  test("obsidian_read_notes carries a rev per note, and errors are unaffected", async () => {
    const server = fakeServer();
    const revs = new Map([["A.md", 1700], ["B.md", 1800]]);
    registerFsTools(server, fakeBackend(NOTES), { rev: (p) => revs.get(p) });

    const res = await server.call("obsidian_read_notes", { paths: ["A.md", "missing.md", "B.md"] });
    const { notes, errors } = res.structuredContent;
    assert.deepEqual(
      notes.map((n) => [n.path, n.rev]),
      [["A.md", 1700], ["B.md", 1800]],
      "each note must carry its own revision, in input order",
    );
    assert.equal(notes[0].truncated, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, "missing.md");
    assert.equal("rev" in errors[0], false);
  });

  test("read errors still fail cleanly with a rev source present", async () => {
    const server = fakeServer();
    registerFsTools(server, fakeBackend(NOTES), { rev: () => 1700 });
    const res = await server.call("obsidian_read_note", { path: "missing.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not found: missing\.md/);
  });
});
