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


// ---------------------------------------------------------------------------
// Invariant-claim allowlist ratchet (#152)
//
// LOOP.md's standard: invariant words in docs ("never", "every", "always",
// "cannot", "no way", "guarantee", "impossible") may only be published when
// the implementation substantiates them. Nothing enforced that, and it
// failed silently: #140 qualified "every mutating operation lands in an
// append-only journal" in README.md, because packages/server's FS-failover
// path writes with no journal (open: #92); hours later #149 rewrote the
// README and reintroduced the unqualified claim, with no mention of FS mode.
// It was caught only because the reviewer happened to remember that exact
// sentence from that morning.
//
// This check does NOT decide whether a claim is true — that stays a human
// judgement. It flags any span combining an invariant word with a
// security-relevant term, and fails CI unless that EXACT span text is in the
// checked-in allowlist below. The allowlist is a record of "a human looked
// at this sentence and deliberately decided it may be published" — not a
// truth assertion, and not a substitute for #92-style follow-through. A
// claim that changes even by a qualifying clause is a *different* span and
// needs its own approval; matching is exact-text on purpose, not fuzzy —
// deleting or adding a qualifier must trip the check, not slide past it.
// ---------------------------------------------------------------------------

const ALLOWLIST_PATH = join(REPO_ROOT, "packages", "plugin", "tests", "docs-invariant-claims-allowlist.md");

const INVARIANT_WORD_RE = /\b(never|every|always|cannot|no way|guarantees?|impossible)\b/i;
const SECURITY_TERM_RE = /\b(journal(?:ed|s|ing)?|accept(?:ed|ance)?|guard(?:s|ed|ing)?|audit(?:s|ed|ing)?|provenance)\b|every write/i;

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+/;

/**
 * Split markdown into pragmatic sentence-ish spans. Not a prose parser: a
 * blank line, an ATX heading, a list item, or a table row each starts a new
 * block (so a bulleted list or a table doesn't collapse into one giant
 * span); code fences are skipped entirely (claims inside code aren't prose).
 * Within a block, spans are split on sentence-ending punctuation followed by
 * a capital letter, digit, or markup opener — deterministic, not perfect.
 */
function extractSpans(text) {
  const lines = text.split("\n");
  const blocks = [];
  let buf = [];
  let bufStartLine = 0;
  let inFence = false;

  function flush() {
    const joined = buf.join(" ").trim();
    if (joined) blocks.push({ text: joined, line: bufStartLine });
    buf = [];
  }

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      flush();
      return;
    }
    if (inFence) return;
    const trimmed = line.trim();
    const startsBlock =
      trimmed === "" || /^#{1,6}\s/.test(trimmed) || LIST_ITEM_RE.test(line) || trimmed.startsWith("|");
    if (startsBlock) {
      flush();
      if (trimmed === "" || /^#{1,6}\s/.test(trimmed)) return;
      // strip the list marker itself so spans read as prose, not "- - text"
      buf.push(trimmed.replace(/^(?:[-*+]|\d+\.)\s+/, ""));
      bufStartLine = i + 1;
      return;
    }
    if (buf.length === 0) bufStartLine = i + 1;
    buf.push(trimmed);
  });
  flush();

  const spans = [];
  for (const block of blocks) {
    const parts = block.text.split(/(?<=[.!?])\s+(?=[A-Z0-9`"'*_\[])/);
    for (const part of parts) {
      const t = part.trim();
      if (t) spans.push({ text: t, line: block.line });
    }
  }
  return spans;
}

// Both conditions required — the point is security claims, not "every" in
// prose like "every rename" or "the guard" without any invariant language.
function isInvariantSecurityClaim(span) {
  return INVARIANT_WORD_RE.test(span) && SECURITY_TERM_RE.test(span);
}

function normalizeClaim(s) {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Allowlist file format: `## <relative-path>` headings group approved
 * claims by the doc they live in, purely for reviewability — matching
 * itself is a flat set of exact normalized claim text (the same sentence
 * approved once covers it wherever it appears). `- ` bullets are entries;
 * everything else (headings, blank lines, prose comments) is ignored. This
 * is deliberately the literal sentence, not a hash — a bare hash list is
 * unreviewable, and review is the entire point of this file.
 */
function parseAllowlist(raw) {
  const set = new Set();
  for (const line of raw.split("\n")) {
    const m = /^-\s+(.*)$/.exec(line);
    if (m) set.add(normalizeClaim(m[1]));
  }
  return set;
}

function loadAllowlist() {
  return parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
}

// The core check: every invariant+security span found in `files` that is
// not present (exact text) in `allowlist` is a violation.
function findUnapprovedClaims(files, allowlist) {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const span of extractSpans(text)) {
      if (!isInvariantSecurityClaim(span.text)) continue;
      if (allowlist.has(normalizeClaim(span.text))) continue;
      violations.push({ file, line: span.line, text: span.text });
    }
  }
  return violations;
}

function formatViolation(v) {
  return (
    `${relative(REPO_ROOT, v.file)}:${v.line} — unapproved invariant+security claim:\n` +
    `    "${v.text}"\n` +
    `  → verify the current implementation and perimeter tests substantiate this claim, then add\n` +
    `    it deliberately to packages/plugin/tests/docs-invariant-claims-allowlist.md — or narrow/\n` +
    `    qualify the sentence in the doc instead.`
  );
}

test("invariant-claim predicate requires BOTH an invariant word and a security term", () => {
  assert.equal(
    isInvariantSecurityClaim("every rename heals its own backlinks automatically"),
    false,
    "invariant word alone (prose, no security term) must not flag"
  );
  assert.equal(
    isInvariantSecurityClaim("the guard checks the frontmatter configuration"),
    false,
    "security term alone (no invariant word) must not flag"
  );
  assert.equal(isInvariantSecurityClaim("every write is journaled"), true, "both together must flag");
});

test("pinned regression: reintroducing the unqualified #140/#149 journal claim fails the check", () => {
  // The literal sentence #149 reintroduced into README.md after #140 had
  // qualified it against the unjournaled FS-failover path (#92). This must
  // never again slip past the check silently.
  const regressionFixture = "Every mutating operation lands in an append-only journal, with no exceptions.";
  const spans = extractSpans(regressionFixture);
  const flagged = spans.filter((s) => isInvariantSecurityClaim(s.text));
  assert.ok(flagged.length >= 1, "the regression sentence must be recognized as an invariant+security claim");

  const allowlist = loadAllowlist();
  for (const span of flagged) {
    assert.equal(
      allowlist.has(normalizeClaim(span.text)),
      false,
      `the unqualified journal claim must never be pre-approved in the allowlist: "${span.text}"`
    );
  }
});

test("a claim whose scope changes is a different claim and needs its own approval", () => {
  const original = "Every mutating operation lands in an append-only journal.";
  const scopeWidened = "Every mutating operation through the plugin's guarded path lands in an append-only journal.";
  assert.ok(isInvariantSecurityClaim(original) && isInvariantSecurityClaim(scopeWidened), "both fixtures must be flaggable");

  const allowlist = new Set([normalizeClaim(original)]);
  assert.ok(allowlist.has(normalizeClaim(original)), "sanity: the unmodified claim is approved");
  assert.equal(
    allowlist.has(normalizeClaim(scopeWidened)),
    false,
    "adding a qualifying clause must produce a span the original approval does not cover"
  );
});

test("every invariant+security claim currently in README.md / docs/*.md is on the allowlist", () => {
  const allowlist = loadAllowlist();
  const violations = findUnapprovedClaims(FILES, allowlist);
  assert.deepEqual(
    violations,
    [],
    violations.length ? `unapproved invariant security claims:\n\n${violations.map(formatViolation).join("\n\n")}` : ""
  );
});

test("allowlist has no duplicate entries and no dead (no-longer-flaggable) entries", () => {
  const raw = readFileSync(ALLOWLIST_PATH, "utf8");
  const seen = new Set();
  const dupes = [];
  const notFlaggable = [];
  for (const line of raw.split("\n")) {
    const m = /^-\s+(.*)$/.exec(line);
    if (!m) continue;
    const claim = normalizeClaim(m[1]);
    if (seen.has(claim)) dupes.push(claim);
    seen.add(claim);
    if (!isInvariantSecurityClaim(claim)) notFlaggable.push(claim);
  }
  assert.deepEqual(dupes, [], `duplicate allowlist entries:\n${dupes.join("\n")}`);
  assert.deepEqual(
    notFlaggable,
    [],
    `allowlist entries that no longer match the invariant+security predicate (remove them):\n${notFlaggable.join("\n")}`
  );
});
