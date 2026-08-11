/**
 * template-expansion-guard.test.mjs — issue #137.
 *
 * The template accept-guard scanned a template's RESOLVED BYTES for an accept
 * fence pre-exec, but the vault expands Templater `<% %>` tags AFTER the scan.
 * Templater's date-format facility honors moment's `[…]` literal escape, so a
 * single tag can emit arbitrary bytes — including an `acceptance-status:
 * accepted` assertion AND the `---` fence around it — from a template whose own
 * bytes contain NEITHER. A static scan of the wrong document is a floor, not a
 * proof (the #126 defect shape one level up).
 *
 * Nelson's ruling (Option 2): FAIL CLOSED on expansion tokens. A template whose
 * resolved bytes carry any Templater expansion token is refused outright,
 * because its expanded output cannot be inspected before it lands.
 *
 * These tests are fixtured on the EXPANSION BEHAVIOR, not on template text: the
 * regression case's bytes carry NO accept fence, and a faithful model of the
 * Templater literal-escape mechanism is used to show the SAME token WOULD
 * synthesize one — so the refusal is provably about expansion, not a fence that
 * happens to be in the bytes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  registerCliTools,
  templateExpansionRefusal,
  templateContentAcceptRefusal,
  templateAcceptRefusal,
} from "../src/mcp/tools-cli.ts";

// A real-enough YAML parser for the accepted-family scan: "k: v" lines only —
// the same shape the sibling guard tests use.
function parseYaml(y) {
  const out = {};
  for (const line of y.split("\n")) {
    const m = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const readerOf = (map) => async (name, _mode) => (name in map ? map[name] : null);

// ── The #137 mechanism, modeled concretely ───────────────────────────────────
//
// Templater's `<% tp.date.now("…") %>` runs the quoted string through moment's
// formatter, whose `[…]` sequences are emitted VERBATIM (and the string can
// carry newlines). So this one tag synthesizes a full frontmatter fence that is
// nowhere in the template's own bytes. The expander below models exactly that —
// it is the "WOULD produce" oracle the regression is fixtured on.
const FENCE_FROM_EXPANSION =
  "# Daily\n\n" +
  '<% tp.date.now("[---]\n[acceptance-status: accepted]\n[---]") %>\n';

function expandLikeTemplater(body) {
  return body.replace(/<%\s*tp\.date\.now\("([\s\S]*?)"\)\s*%>/g, (_all, fmt) =>
    fmt.replace(/\[([\s\S]*?)\]/g, "$1"),
  );
}

// Stripping the tags leaves the template's OWN, non-expanded bytes.
function stripExpansionTokens(body) {
  return body.replace(/<%[\s\S]*?%>/g, "");
}

describe("templateExpansionRefusal — the #137 fail-closed predicate", () => {
  test("refuses every Templater tag form (any `<%` opener)", () => {
    for (const tag of ["<% x %>", "<%* run() %>", "<%~ y %>", "<%+ z %>", "<%_ w -%>"]) {
      const r = templateExpansionRefusal(`prefix ${tag} suffix`);
      assert.ok(r, `must refuse ${tag}`);
      assert.match(r, /expansion token/i);
      assert.match(r, /expand it in Obsidian|without expansion tokens/i, "names the escape hatch");
    }
  });

  test("a template with no expansion token is clean", () => {
    assert.equal(templateExpansionRefusal("---\ntitle: X\n---\n## Notes\n"), null);
  });

  test("core Templates fields ({{title}}/{{date}}) are NOT expansion tokens", () => {
    // They expand a fixed, closed value set with no arbitrary-emission facility,
    // so refusing them would break ordinary template use.
    assert.equal(templateExpansionRefusal("---\ntitle: {{title}}\ndate: {{date}}\n---\n"), null);
  });
});

describe("#137 regression — fixtured on expansion BEHAVIOR, not template text", () => {
  test("precondition: the template's own bytes carry NO accept fence", () => {
    // With the tokens stripped, the residual bytes are clean — proving the
    // refusal below is about the token, not a fence sitting in the template.
    const withoutTokens = stripExpansionTokens(FENCE_FROM_EXPANSION);
    assert.equal(
      templateContentAcceptRefusal(withoutTokens, parseYaml),
      null,
      "the non-expanded bytes assert nothing",
    );
  });

  test("oracle: the SAME token WOULD expand into an acceptance assertion", () => {
    const expanded = expandLikeTemplater(FENCE_FROM_EXPANSION);
    assert.match(expanded, /\n---\nacceptance-status: accepted\n---/, "expansion synthesizes the fence");
    assert.ok(
      templateContentAcceptRefusal(expanded, parseYaml),
      "the expanded document DOES assert acceptance — the danger is real",
    );
  });

  test("so the template is REFUSED before it can land (fail closed on the token)", () => {
    const r = templateContentAcceptRefusal(FENCE_FROM_EXPANSION, parseYaml);
    assert.ok(r, "must refuse");
    assert.match(r, /expansion token/i, "refused via the expansion path, not a static fence");
  });

  test("control: a clean template with no token and no fence still creates", () => {
    const clean = "---\ntitle: {{title}}\ntags: [daily]\n---\n\n## Notes\n\n- \n";
    assert.equal(templateContentAcceptRefusal(clean, parseYaml), null);
  });

  test("preserved (#79/#105): a literal accept fence is still refused", () => {
    const literal = "---\nacceptance-status: accepted\n---\n# {{title}}\n";
    assert.ok(templateContentAcceptRefusal(literal, parseYaml), "existing static behavior intact");
  });
});

// ── Both guarded paths route through the ONE broadened predicate ──────────────

describe("guarded path 1 — the obsidian_cli create-from-template closure", () => {
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
    const exec = async (_bin, args) => (calls.push(args), { exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    registerCliTools(server, ctxWith(), { binary: "/bin/obsidian", exec, parseYaml, readTemplate });
    return { handler: server.tools.get("obsidian_cli").handler, calls };
  }

  test("templateAcceptRefusal refuses an expansion-token template, naming it", async () => {
    const r = await templateAcceptRefusal(
      "create",
      { name: "New", template: "Expando" },
      readerOf({ Expando: FENCE_FROM_EXPANSION }),
      parseYaml,
    );
    assert.ok(r && r.includes("'Expando'") && /expansion token/i.test(r));
  });

  test("the CLI handler refuses accept_forbidden and NEVER executes the command", async () => {
    const { handler, calls } = build(readerOf({ Expando: FENCE_FROM_EXPANSION }));
    const res = await handler({ command: "create", params: { name: "New", template: "Expando" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[accept_forbidden\]/);
    assert.match(res.content[0].text, /expansion token/i);
    assert.equal(calls.length, 0, "fail closed: the create must not run");
  });

  test("quickadd:run-template's path template gets the same expansion check", async () => {
    const r = await templateAcceptRefusal(
      "quickadd:run-template",
      { path: "T/expando.md" },
      readerOf({ "T/expando.md": FENCE_FROM_EXPANSION }),
      parseYaml,
    );
    assert.ok(r && r.includes("'T/expando.md'") && /expansion token/i.test(r));
  });
});

/**
 * guarded path 2 — the MCP obsidian_create_note_from_template tool. Its handler
 * needs Templater + a live app, so (as its own suite does) this is a SOURCE
 * SCAN: the handler must route template creation through the shared predicate,
 * which now carries the expansion check, BEFORE it invokes Templater.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp", "tools-integrations.ts");

describe("guarded path 2 — the MCP tool routes through the broadened predicate", () => {
  test("the handler calls templateContentAcceptRefusal before the Templater call", () => {
    const text = readFileSync(SRC, "utf8");
    const start = text.indexOf('"obsidian_create_note_from_template"');
    assert.ok(start > 0, "tool must still be registered under this name");
    const exec = text.indexOf("templater.create_new_note_from_template(", start);
    assert.ok(exec > start, "handler must still call Templater");
    const body = text.slice(start, exec);
    assert.match(body, /templateContentAcceptRefusal\s*\(/, "the shared (expansion-carrying) predicate is wired pre-exec");
  });
});
