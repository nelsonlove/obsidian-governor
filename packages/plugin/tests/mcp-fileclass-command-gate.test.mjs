/**
 * mcp-fileclass-command-gate.test.mjs — #105 part 3.
 *
 * #105's own characterization: `obsidian_fileclass_insert_fields` is
 * `executeCommandById` in disguise, so it inherits `obsidian_run_command`'s
 * reachability while bypassing the gate #76 put on that surface. The fix is to
 * wire the EXISTING `runCommandRefusal` predicate in — not a second deny list,
 * because two lists means two things to keep in sync and only one that will be.
 *
 * ORDERING IS PART OF THE FIX, not incidental. #76 records that
 * `obsidian_run_command` refuses before the `file_path` open, because opening
 * the file leaks an action for a command that is about to be refused. This
 * handler opened the note first, so the check has to move above it.
 *
 * Source scan (the `link-healing.test.mjs` precedent): the handler needs a live
 * `app` and the Metadata Menu plugin, so it cannot be driven headlessly. Proven
 * non-vacuous by mutation — see the ordering test.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "tools-integrations.ts");

function fileclassHandler(text) {
  const start = text.indexOf('"obsidian_fileclass_insert_fields"');
  assert.ok(start > 0, "tool must still be registered under this name");
  const end = text.indexOf("executeCommandById(", start);
  assert.ok(end > start, "handler must still execute a command");
  return { body: text.slice(start, end), start, end };
}

describe("#105 part 3 — the fileclass command path is policy-gated", () => {
  test("runCommandRefusal is invoked in the handler before the command executes", () => {
    const { body } = fileclassHandler(readFileSync(SRC, "utf8"));
    assert.match(body, /runCommandRefusal\s*\(/, "handler must consult the command policy");
    assert.match(body, /cli_denied/, "refusal must use the shared coded shape, not a bespoke error");
  });

  test("the refusal precedes the file open — a refused command must not leak an action", () => {
    const text = readFileSync(SRC, "utf8");
    const { body } = fileclassHandler(text);
    const refusalAt = body.indexOf("runCommandRefusal(");
    const openAt = body.indexOf("openLinkText(");
    assert.ok(refusalAt >= 0 && openAt >= 0, "both must be present in the handler");
    assert.ok(refusalAt < openAt, "policy check must come BEFORE openLinkText (#76's reason)");
  });

  test("no second deny list was introduced — one policy object, one predicate", () => {
    const { body } = fileclassHandler(readFileSync(SRC, "utf8"));
    assert.match(body, /ctx\.getSettings\(\)\.cliPolicy/, "must read the same policy obsidian_cli uses");
  });
});
