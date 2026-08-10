/**
 * docs-drift.test.mjs — conformance check for the rename/decommission class (#121).
 *
 * Docs drift from renames and retirements kept being re-filed as one-off issues
 * (#114 was the latest). This test makes the class regress-proof: retired names,
 * dead anchors, stale branch citations, and superseded architecture claims are
 * forbidden strings in the user-facing docs. A rename or decommission adds ONE
 * rule entry here instead of a future cleanup issue.
 *
 * Scope: docs/**·*.md (excluding docs/superpowers/ — dated design specs are
 * historical records) plus the root README.md. Code identifiers are NOT in
 * scope (the #115 rename owns those); this test guards prose.
 *
 * Rule shape: { id, pattern, allowIf } — a line matching `pattern` fails unless
 * it also matches `allowIf` (the annotated-legacy-context escape hatch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs");
const EXCLUDED_SUBTREES = [join(DOCS_DIR, "superpowers")];

const RULES = [
  {
    id: "retired-anchor: #the-stewardship-plugin",
    pattern: /#the-stewardship-plugin/,
    allowIf: null, // the anchor is gone; no context justifies linking it
  },
  {
    id: "retired-name: Stewardship outside annotated legacy context",
    pattern: /\bStewardship\b/,
    // Legit mentions: the legacy annotation itself, the repo name, the literal
    // published-index path, and references to the rename issue.
    allowIf: /legacy|formerly|obsidian-stewardship|stewardship\/pending-index|#115/,
  },
  {
    id: "stale-branch: assent/kernel-v0 cited in docs",
    pattern: /assent\/kernel-v0/,
    // The branch shipped to main in #65; docs may only mention it as history.
    allowIf: /shipped|merged|pre-ship|historical/,
  },
  {
    id: "superseded-claim: plugin separation as a security property",
    pattern: /security property, not tidiness/,
    allowIf: null, // reversed by the module-consolidation ruling (see #114)
  },
];

function mdFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (EXCLUDED_SUBTREES.some((ex) => p === ex || p.startsWith(ex + "/"))) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...mdFiles(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const FILES = [...mdFiles(DOCS_DIR), join(REPO_ROOT, "README.md")];

test("docs corpus is where we expect it", () => {
  assert.ok(FILES.length >= 8, `expected the docs tree + README, found ${FILES.length} files`);
});

test("no retired names, dead anchors, stale branches, or superseded claims in docs", () => {
  const violations = [];
  for (const file of FILES) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line) && !(rule.allowIf && rule.allowIf.test(line))) {
          violations.push(`${relative(REPO_ROOT, file)}:${i + 1} [${rule.id}] ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
  assert.deepEqual(violations, [], `docs drift:\n${violations.join("\n")}`);
});

test("every rule detects its own violation class (self-check)", () => {
  const fixtures = {
    "retired-anchor: #the-stewardship-plugin": "see [docs](README.md#the-stewardship-plugin)",
    "retired-name: Stewardship outside annotated legacy context": "Stewardship is the review surface.",
    "stale-branch: assent/kernel-v0 cited in docs": "lives on `assent/kernel-v0` as a draft",
    "superseded-claim: plugin separation as a security property": "as a security property, not tidiness",
  };
  for (const rule of RULES) {
    const fixture = fixtures[rule.id];
    assert.ok(fixture, `rule "${rule.id}" has no self-check fixture`);
    assert.ok(rule.pattern.test(fixture), `rule "${rule.id}" fails to match its own fixture`);
    if (rule.allowIf) {
      assert.ok(!rule.allowIf.test(fixture), `rule "${rule.id}" fixture is excused by its own allowIf`);
    }
  }
});

test("annotated legacy contexts stay allowed (no over-blocking)", () => {
  const legit = [
    "Acceptance (formerly *Stewardship* — tracked in #115)",
    "ships as a separate Obsidian plugin (repo `obsidian-stewardship`)",
    "index at `<config-dir>/plugins/stewardship/pending-index.json` (legacy id)",
  ];
  const rule = RULES.find((r) => r.id.startsWith("retired-name"));
  for (const line of legit) {
    assert.ok(
      !rule.pattern.test(line) || rule.allowIf.test(line),
      `legit legacy mention would be flagged: ${line}`
    );
  }
});
