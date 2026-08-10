/**
 * mcp-template-accept-guard.test.mjs — #105 part 1.
 *
 * #79 gated the `obsidian_cli` template path (`create template=<t>`), and the
 * scope-check on #105 recorded part 1 as closed by it. It was not: the issue is
 * about the MCP tool `obsidian_create_note_from_template`, which lives in
 * tools-integrations.ts — a file with ZERO guard imports. It calls Templater
 * directly, so it reaches neither the CLI guard nor ObsidianBackend's.
 *
 * This pins the RULE the handler must apply, at the level the handler applies
 * it: an accepted-family fence in the template body must refuse BEFORE exec,
 * and an unreadable template must refuse rather than fail open (the precedent
 * `templateAcceptRefusal` already sets for the CLI surface).
 *
 * SCOPE, deliberately narrow: this closes the STATIC half only. The scan reads
 * the template body PRE-RENDER, so #137 (expansion emits acceptance from a
 * template containing neither) applies to this surface exactly as it does to
 * the CLI one. "Closed against static accepted fences" — never "closed".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { templateContentAcceptRefusal } from "../src/mcp/tools-cli.ts";

const parseYaml = (s) => {
  const out = {};
  for (const line of s.split("\n")) {
    const m = /^([^:\s][^:]*):(.*)$/.exec(line);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return Object.keys(out).length ? out : s;
};

describe("#105 part 1 — the rule the MCP template tool must apply pre-exec", () => {
  test("a template whose frontmatter asserts acceptance is refused", () => {
    const body = "---\nacceptance-status: accepted\n---\n# {{title}}\n";
    assert.ok(templateContentAcceptRefusal(body, parseYaml), "must refuse");
  });

  test("a template carrying an accepted-family provenance key is refused", () => {
    assert.ok(templateContentAcceptRefusal("---\naccepted-by: nelson\n---\nbody\n", parseYaml));
  });

  test("an embedded fence later in the template is refused too (broader sweep)", () => {
    const body = "# Note\n\nprose\n\n---\nacceptance-status: accepted\n---\n";
    assert.ok(templateContentAcceptRefusal(body, parseYaml));
  });

  test("an ordinary template is NOT refused — the guard must not break normal use", () => {
    const body = "---\ntitle: {{title}}\ntags: [daily]\n---\n\n## Notes\n\n- \n";
    assert.equal(templateContentAcceptRefusal(body, parseYaml), null);
  });

  test("prose containing thematic breaks is not refused", () => {
    assert.equal(templateContentAcceptRefusal("# T\n\na\n\n---\n\nb\n", parseYaml), null);
  });

  test("with no parser the presence of a fence is refused, not waved through", () => {
    const r = templateContentAcceptRefusal("---\ntitle: x\n---\nbody\n", undefined);
    assert.ok(r, "no parser ⇒ a fence cannot be verified ⇒ refuse (fail closed)");
  });
});

/**
 * WIRING, not just the rule.
 *
 * The tests above pin `templateContentAcceptRefusal`'s behaviour — and would
 * ALL still pass if someone deleted the call from the handler. That is the
 * vacuous-test shape this repo has hit repeatedly: an assertion about a helper
 * is not an assertion that the helper is reached.
 *
 * The handler cannot be driven headlessly (it needs Templater and a live
 * `app`), so this is a SOURCE SCAN, the precedent `link-healing.test.mjs` sets
 * for exactly this situation — and like that one, it is proven non-vacuous by
 * planting the violation (see the second test).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "tools-integrations.ts");

/** The handler body for obsidian_create_note_from_template. */
function templateHandlerSource(text) {
  const start = text.indexOf('"obsidian_create_note_from_template"');
  assert.ok(start > 0, "tool must still be registered under this name");
  // The real INVOCATION, not the name in the explanatory comment above it —
  // matching a string that also appears in prose is how this test first
  // failed against correct code. Anchor on the receiver.
  const exec = text.indexOf("templater.create_new_note_from_template(", start);
  assert.ok(exec > start, "handler must still call Templater");
  return text.slice(start, exec);
}

describe("the guard is actually WIRED, and runs before Templater executes", () => {
  test("the accept scan appears in the handler before the Templater call", () => {
    const body = templateHandlerSource(readFileSync(SRC, "utf8"));
    assert.match(body, /templateContentAcceptRefusal\s*\(/, "handler must invoke the accept scan");
    assert.match(body, /could not be read for pre-exec inspection/, "unreadable template must fail closed");
  });

  test("the scan is non-vacuous: with the call removed, the check above fails", () => {
    const planted = readFileSync(SRC, "utf8").replace(/templateContentAcceptRefusal\s*\(/g, "noopRefusal(");
    const body = templateHandlerSource(planted);
    assert.doesNotMatch(body, /templateContentAcceptRefusal\s*\(/, "planted violation removed the call");
    // and the first test's assertion would therefore fail — proven, not assumed.
  });
});
