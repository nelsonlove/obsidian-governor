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
 * The SAME arbitrary-emission facility exists in the core Templates plugin — the
 * one the `create template=` CLI path actually uses — whose `{{date:FORMAT}}` /
 * `{{time:FORMAT}}` fields also run FORMAT through moment and honor the `[…]`
 * literal escape. The first #137 fix keyed only on Templater `<%` and EXEMPTED
 * `{{ }}` fields on a false "no arbitrary-emission facility" claim, leaving the
 * exact vector #137 is about OPEN. This correction fails closed on the whole
 * expansion-token class — `<%` OR `{{` — with no carve-out.
 *
 * Nelson's ruling (Option 2): FAIL CLOSED on expansion tokens. A template whose
 * resolved bytes carry any expansion token is refused outright, because its
 * expanded output cannot be inspected before it lands. Its stated cost — refusing
 * dated/titled templates, the common case — IS the ruling.
 *
 * These tests are fixtured on the EXPANSION BEHAVIOR, not on template text: each
 * regression case's bytes carry NO accept fence, and a faithful model of the
 * literal-escape mechanism (Templater AND core Templates) is used to show the
 * SAME token WOULD synthesize one — so the refusal is provably about expansion,
 * not a fence that happens to be in the bytes.
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

  test("core Templates `{{ }}` fields ARE refused — the whole class, no carve-out (#137)", () => {
    // The first #137 fix EXEMPTED these on a false "no arbitrary-emission
    // facility" claim. It is false: `{{date:FORMAT}}` runs FORMAT through moment,
    // which honors the `[…]` literal escape — arbitrary emission through the plain
    // `create template=` path. So the class fails closed, like the `<%` class.
    for (const field of ["{{title}}", "{{date}}", "{{time}}", "{{date:YYYY-MM-DD}}", "{{time:HH:mm}}"]) {
      const r = templateExpansionRefusal(`---\ntitle: ${field}\n---\n`);
      assert.ok(r, `must refuse ${field}`);
      assert.match(r, /expansion token/i);
      assert.match(r, /expand it in Obsidian|without expansion tokens/i, "names the escape hatch");
    }
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
    // No `<%` and no `{{` — a genuinely token-free template (dated/titled ones
    // now refuse by design, Option 2's stated cost), so this must stay clean.
    const clean = "---\ntitle: Daily note\ntags: [daily]\n---\n\n## Notes\n\n- \n";
    assert.equal(templateContentAcceptRefusal(clean, parseYaml), null);
  });

  test("preserved (#79/#105): a literal accept fence is still refused", () => {
    const literal = "---\nacceptance-status: accepted\n---\n# Body\n";
    assert.ok(templateContentAcceptRefusal(literal, parseYaml), "existing static behavior intact");
  });
});

// ── The #137 CORE-TEMPLATES mechanism, modeled concretely ─────────────────────
//
// The independent review of the first #137 fix reproduced the still-open vector:
// the `create template=` CLI path uses the core Templates plugin, whose
// `{{date:FORMAT}}` / `{{time:FORMAT}}` fields run FORMAT through moment. moment
// emits `[…]` sequences VERBATIM (literal escape), so a single field synthesizes
// a full acceptance fence — the `---` delimiters AND the `acceptance-status:
// accepted` line — that is nowhere in the template's own bytes. This is the SAME
// arbitrary-emission facility as Templater's date format, reached through a token
// the `<%`-only fix exempted. The expander below models exactly that emission.
const CORE_FENCE_FROM_EXPANSION =
  "# Daily\n\n" +
  "{{date:[---]}}\n{{date:[acceptance-status: accepted]}}\n{{date:[---]}}\n";

function expandLikeCoreTemplates(body) {
  // core Templates replaces {{date:FMT}} / {{time:FMT}} with moment(FMT); we
  // model only the `[literal]` escape the vector relies on.
  return body.replace(/\{\{(?:date|time)(?::([\s\S]*?))?\}\}/g, (_all, fmt) =>
    (fmt ?? "").replace(/\[([\s\S]*?)\]/g, "$1"),
  );
}

function stripCoreTemplateFields(body) {
  return body.replace(/\{\{[\s\S]*?\}\}/g, "");
}

describe("#137 core-Templates regression — the {{ }} class is refused, not carved out", () => {
  test("precondition: the template's own bytes (fields stripped) carry NO accept fence", () => {
    const withoutFields = stripCoreTemplateFields(CORE_FENCE_FROM_EXPANSION);
    assert.equal(
      templateContentAcceptRefusal(withoutFields, parseYaml),
      null,
      "the non-expanded bytes assert nothing — the danger is the expansion, not a static fence",
    );
  });

  test("oracle: the `{{date:[…]}}` fields WOULD expand into an acceptance fence via moment", () => {
    const expanded = expandLikeCoreTemplates(CORE_FENCE_FROM_EXPANSION);
    assert.match(expanded, /\n---\nacceptance-status: accepted\n---/, "the moment literal-escape synthesizes the fence");
    assert.ok(
      templateContentAcceptRefusal(expanded, parseYaml),
      "the expanded document DOES assert acceptance — the vector is real",
    );
  });

  test("so the core-Templates template is REFUSED before it can land (the vector the <%-only fix left OPEN)", () => {
    const r = templateContentAcceptRefusal(CORE_FENCE_FROM_EXPANSION, parseYaml);
    assert.ok(r, "must refuse — this returned null against the shipped predicate, leaving the note assertable");
    assert.match(r, /expansion token/i, "refused via the expansion path, not a static fence");
  });

  test("also refused through the CLI create-from-template guard, naming the template", async () => {
    const r = await templateAcceptRefusal(
      "create",
      { name: "New", template: "CoreExpando" },
      readerOf({ CoreExpando: CORE_FENCE_FROM_EXPANSION }),
      parseYaml,
    );
    assert.ok(r && r.includes("'CoreExpando'") && /expansion token/i.test(r));
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
      getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: false, rawCliProxy: true, ...settings }),
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
