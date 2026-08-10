/**
 * conformance-pack-port.test.mjs — the port_lint rule pack, a faithful TS port
 * of port_lint.py. Parity contract: for a line that is NOT historical, each of
 * the three patterns that matches yields a finding keyed
 * (port_lint, <pattern name>, <relpath>, <matched token>) — line number and
 * context are display-only, excluded from the key (matches the Python ratchet's
 * parse_port).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { portPack } from "../src/conformance/packs/port.ts";

const pack = portPack();
const note = (path, text) => ({ path, text, frontmatter: {}, body: text });
const run = (notes) => pack.run({ notes, paths: notes.map((n) => n.path) });

describe("portPack — pattern parity", () => {
  test("retired source-vault path is flagged; the live ~/obsidian is NOT", () => {
    const f = run([note("N.md", "see ~/obsidian-old/foo and ~/obsidian/bar\n")]);
    const tokens = f.map((x) => x.kind);
    assert.ok(tokens.includes("~/obsidian-old"), "flags retired ~/obsidian-old");
    assert.equal(tokens.some((t) => t === "~/obsidian" || t === "/obsidian"), false, "does not flag the live ~/obsidian");
    assert.equal(f[0].script, "port_lint");
    assert.equal(f[0].check, "retired source-vault path");
    assert.equal(f[0].target, "N.md");
  });

  test("/Users/nelson/obsidian-new is flagged too", () => {
    const f = run([note("N.md", "path /Users/nelson/obsidian-new/x\n")]);
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "/Users/nelson/obsidian-new");
  });

  test("old-vault agent-band addresses flagged (05.11/05.13/05.17/05.50/05.51/03.98), others not", () => {
    const f = run([note("N.md", "a 05.11 b 03.98 c 05.17 d 06.11 e 05.20\n")]);
    const toks = f.filter((x) => x.check === "old-vault address").map((x) => x.kind).sort();
    assert.deepEqual(toks, ["05.11"], "search = first hit per line per pattern");
  });

  test("retired tooling flagged", () => {
    const f = run([note("N.md", "uses Templater and Dataview Serializer\n")]);
    assert.ok(f.some((x) => x.check === "retired tooling" && x.kind === "Templater"));
  });

  test("a historical line passes (retired/tombstone/superseded/archived/…)", () => {
    const f = run([note("N.md", "Templater is retired — do not reintroduce ~/obsidian-old\n")]);
    assert.deepEqual(f, []);
  });

  test("frontmatter references are scanned too (full-text, line-numbered like the Python)", () => {
    const text = "---\nsource: ~/obsidian-old/note.md\n---\n\nbody\n";
    const f = run([note("N.md", text)]);
    assert.ok(f.some((x) => x.check === "retired source-vault path" && x.kind === "~/obsidian-old"));
  });

  test("multiple distinct patterns on one line each produce a finding", () => {
    const f = run([note("N.md", "05.17 with Metadata Menu\n")]);
    const checks = f.map((x) => x.check).sort();
    assert.deepEqual(checks, ["old-vault address", "retired tooling"]);
  });

  test("clean note yields nothing", () => {
    assert.deepEqual(run([note("N.md", "a normal note about ~/obsidian/06.11\n")]), []);
  });
});

describe("portPack — review fixes", () => {
  test(".fileclass (non-.md) notes are out of scope (Python walks *.md only)", () => {
    const p = portPack();
    const f = p.run({ notes: [{ path: "Reg/X.fileclass", text: "~/obsidian-old\n", frontmatter: {}, body: "" }], paths: [] });
    assert.deepEqual(f, []);
  });
  test("a snapshot note missing text throws (silent-zero class → loud failure)", () => {
    const p = portPack();
    assert.throws(() => p.run({ notes: [{ path: "N.md", frontmatter: {}, body: "" }], paths: ["N.md"] }), /no text/);
  });
});
