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
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
  {
    id: "retired-name: Assent as the framework outside annotated legacy context",
    pattern: /\bAssent\b/,
    // Legit mentions: the legacy/former-name annotation itself, and the
    // ASSENT_* legacy env-var aliases. The `00.89 Assent` folder USED to be a
    // legit bare mention (a real path holding the historical name); it was
    // renamed to `00.89 obsidian-governor` on 2026-08-19, so that escape hatch
    // is gone — a doc naming the old folder is now drift, not a real path.
    allowIf: /legacy|former|formerly|historical|ASSENT_/,
  },
  {
    id: "retired-key: modules.governance settings key outside migration context",
    pattern: /modules\.governance\b/,
    // The key was migrated to modules.acceptance in 0.12.0; only shim /
    // historical discussion may name it.
    allowIf: /legacy|historical|before 0\.12|0\.12\.0|shim|migrat/,
  },
  {
    id: "retired-path: ~/.claude/vault-mcp asserted as the canonical state dir",
    pattern: /~\/\.claude\/vault-mcp/,
    // Only grace-period / compat / legacy discussion may name the old dir.
    allowIf: /legacy|grace|compat|historical|old |pre-0\.12/,
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
    "retired-name: Assent as the framework outside annotated legacy context":
      "Assent names the broader framework the plugin realizes.",
    "retired-key: modules.governance settings key outside migration context":
      "the pane reads its config from `modules.governance.config`",
    "retired-path: ~/.claude/vault-mcp asserted as the canonical state dir":
      "the plugin listens on a per-vault socket in `~/.claude/vault-mcp/`",
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
  const rule = RULES.find((r) => r.id.startsWith("retired-name: Stewardship"));
  for (const line of legit) {
    assert.ok(
      !rule.pattern.test(line) || rule.allowIf.test(line),
      `legit legacy mention would be flagged: ${line}`
    );
  }
});

test("annotated legacy contexts stay allowed for the 0.12.0 rename rules (no over-blocking)", () => {
  const cases = [
    ["retired-name: Assent as the framework outside annotated legacy context", [
      "(*Assent*, the framework's former name, is legacy vocabulary)",
      "`00.89 Assent` is the former folder name, renamed to `00.89 obsidian-governor`",
      "overridable via `GOVERNOR_VAULT_CONVENTIONS` (legacy alias `ASSENT_VAULT_CONVENTIONS`)",
    ]],
    ["retired-key: modules.governance settings key outside migration context", [
      "a legacy `modules.governance` row is adopted once by the settings shim",
      "migrated from `modules.governance` in 0.12.0",
    ]],
    ["retired-path: ~/.claude/vault-mcp asserted as the canonical state dir", [
      "a grace-period compat surface at the old `~/.claude/vault-mcp/` state dir",
      "writes a legacy discovery copy into `~/.claude/vault-mcp/`",
    ]],
  ];
  for (const [id, lines] of cases) {
    const rule = RULES.find((r) => r.id === id);
    assert.ok(rule, `rule "${id}" exists`);
    for (const line of lines) {
      assert.ok(
        !rule.pattern.test(line) || rule.allowIf.test(line),
        `legit legacy mention would be flagged by "${id}": ${line}`
      );
    }
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

// docs/vision-walkthrough.md (#154's bannered vision doc) was RETIRED by the 2026-08-23
// documentation migration — its content is owned by getting-started.md and user-guide.md per
// the migration map — so its genre-based exclusion retired with it. The imported target-state
// corpus is handled the other way (the way the exclusion's own rationale said aspiration must
// NOT be handled at scale): every flagged span is tracked, not approved, in the allowlist's
// "Imported documentation corpus" section, pending the operator's span-by-span review, with
// docs/status-and-compatibility.md as the corpus-level honesty anchor. No file is excluded.
const INVARIANT_CHECK_EXCLUDED_FILES = [];
const INVARIANT_CHECK_FILES = FILES.filter((f) => !INVARIANT_CHECK_EXCLUDED_FILES.includes(f));

const INVARIANT_WORD_RE = /\b(never|every|always|cannot|no way|guarantee(?:s|d|ing)?|impossible)\b/i;
const SECURITY_TERM_RE = /\b(journal(?:ed|s|ing)?|accept(?:ed|ance|s)?|guard(?:s|ed|ing)?|audit(?:s|ed|ing)?|provenance|every write)\b/i;

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
  // Injects the LITERAL markdown #149 reintroduced into README.md after #140 had
  // qualified it against the unjournaled FS-failover path (#92) — not a hand-simplified
  // stand-in sentence. An earlier version of this test used a clean one-line fixture
  // ("Every mutating operation lands in an append-only journal, with no exceptions.")
  // that does not match how extractSpans actually segments this bullet: the real markdown
  // has a **bold** lead-in directly abutting the sentence-ending period with no following
  // whitespace ("everything.** Every"), so the split regex's `(?<=[.!?])\s+` lookbehind
  // never fires there and the bold lead-in stays fused to the flagged sentence. A fixture
  // that skips the bold prefix is testing a span shape that doesn't occur in production,
  // which is weaker than it looks — this test verifies by injection (real markdown through
  // the real pipeline, asserted against the real extracted string) instead.
  const regressionMarkdown = [
    "## What you get",
    "",
    "- **A paper trail for everything.** Every mutating operation lands in an append-only journal:",
    "  what happened, to which note, by which agent, in which session — and, when the agent says so,",
    '  *why*. "What did it do while I was out" becomes a file you can read.',
    "- **Nothing gets accepted without you.** Unrelated next bullet, present to prove the block",
    "  boundary around the fixture span is exactly where extractSpans says it is.",
    "",
  ].join("\n");

  const spans = extractSpans(regressionMarkdown);

  // Lock in the EXACT span the real pipeline produces for this real markdown — including the
  // fused bold lead-in — so a future change to the splitter can't silently narrow the fixture
  // back into an idealized sentence without this assertion catching it.
  const expectedSpanText =
    "**A paper trail for everything.** Every mutating operation lands in an append-only " +
    "journal: what happened, to which note, by which agent, in which session — and, when the " +
    "agent says so, *why*.";
  const regressionSpan = spans.find((s) => s.text === expectedSpanText);
  assert.ok(
    regressionSpan,
    `extractSpans did not produce the expected fused span from injected markdown; got:\n${spans.map((s) => s.text).join("\n---\n")}`
  );

  assert.equal(
    isInvariantSecurityClaim(regressionSpan.text),
    true,
    "the injected regression span must be recognized as an invariant+security claim"
  );

  const allowlist = loadAllowlist();
  assert.equal(
    allowlist.has(normalizeClaim(regressionSpan.text)),
    false,
    `the unqualified journal claim must never be pre-approved in the allowlist: "${regressionSpan.text}"`
  );
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
  const violations = findUnapprovedClaims(INVARIANT_CHECK_FILES, allowlist);
  assert.deepEqual(
    violations,
    [],
    violations.length ? `unapproved invariant security claims:\n\n${violations.map(formatViolation).join("\n\n")}` : ""
  );
});

test("the invariant-claims check covers EVERY docs file — the retired vision-doc exclusion stays retired", () => {
  // vision-walkthrough.md was retired with the 2026-08-23 corpus migration and its exclusion
  // with it. This pin holds the stronger property that replaced it: no file is exempt from
  // the invariant-claims check (an exclusion list that silently regrew would recreate the
  // scan-what-passes hazard at corpus scale), and the retired file stays gone rather than
  // resurrecting unscanned.
  assert.equal(INVARIANT_CHECK_EXCLUDED_FILES.length, 0, "no docs file is excluded from the invariant-claims check");
  assert.equal(INVARIANT_CHECK_FILES.length, FILES.length, "the check's file list IS the docs corpus");
  assert.ok(!existsSync(join(DOCS_DIR, "vision-walkthrough.md")), "vision-walkthrough.md stays retired (owned by getting-started/user-guide per the migration map)");
});

// The imported-corpus pending section is a DIFFERENT TIER from the approved sections, and the
// parser is flat — so without these pins the distinction lives only in prose (twelfth instance:
// a header stating a distinction the mechanism does not make, inside the control whose job is
// stopping documentation from claiming more than the code does; governor-lead planted a fresh
// no-evidence overclaim in the pending section and the suite stayed green). The pins: the
// pending section's entry count is EXACT (a 49th entry is a visible decision, not a quiet ride;
// promotions decrement it; zero retires the section), and every pending entry carries its
// evidence note.
const PENDING_SECTION_HEADING = "## Imported documentation corpus (2026-08-23)";
const PENDING_IMPORT_ENTRIES = 51; // 48 imported 2026-08-23 + 3 from the coherence-audit fix pass (C-006 alignment + install-id path correction reworded flagged spans — see the section's dated note). Decrement as the operator promotes entries; delete section + pins at zero

function parsePendingSection(raw) {
  const at = raw.indexOf(PENDING_SECTION_HEADING);
  if (at === -1) return null;
  const rest = raw.slice(at);
  const next = rest.indexOf("\n## ", 1);
  const body = next === -1 ? rest : rest.slice(0, next);
  const lines = body.split("\n");
  const entries = [];
  lines.forEach((line, i) => {
    const m = /^-\s+(.*)$/.exec(line);
    if (m) entries.push({ text: m[1], hasNote: /^\s+tracked by:/.test(lines[i + 1] ?? "") });
  });
  return entries;
}

test("the pending-import section is pinned: exact entry count, every entry carries its evidence note", () => {
  const raw = readFileSync(ALLOWLIST_PATH, "utf8");
  const entries = parsePendingSection(raw);
  assert.ok(entries !== null, "the pending-import section exists (retire these pins when the operator's promotion review empties it)");
  assert.equal(
    entries.length,
    PENDING_IMPORT_ENTRIES,
    `the pending section holds exactly ${PENDING_IMPORT_ENTRIES} entries — adding one is a visible decision (bump the pin consciously); promoting one decrements it`
  );
  const noteless = entries.filter((e) => !e.hasNote).map((e) => e.text.slice(0, 80));
  assert.deepEqual(noteless, [], "every pending entry must carry its indented 'tracked by:' evidence note");
});

test("VACUITY: the pending-section pins catch the planted 49th and the missing evidence note", () => {
  const raw = readFileSync(ALLOWLIST_PATH, "utf8");
  // Governor-lead's exact plant: a fresh overclaim appended to the pending section, no note.
  const planted = raw + "\n- Governor guarantees that no agent can ever bypass the acceptance perimeter under any circumstances\n";
  const entries = parsePendingSection(planted);
  assert.equal(entries.length, PENDING_IMPORT_ENTRIES + 1, "the count pin sees the 49th");
  assert.ok(entries.some((e) => !e.hasNote), "the evidence-note pin sees the noteless plant");
  // And a plant WITH a forged note still trips the count pin — the note check alone is not the defence.
  const plantedWithNote = raw + "\n- Another overclaim\n  tracked by: nothing real\n";
  assert.equal(parsePendingSection(plantedWithNote).length, PENDING_IMPORT_ENTRIES + 1, "a note-carrying plant still trips the exact count");
});

// The orphan detector, extracted so the check and its vacuity leg run the SAME
// code. When a leg re-implements (or merely re-states) the predicate, gutting
// the real loop leaves the leg green — which is exactly what happened here.
function readInvariantDocs() {
  return INVARIANT_CHECK_FILES.map((f) => normalizeClaim(readFileSync(f, "utf8")));
}

function findOrphanEntries(raw, docs) {
  const orphans = [];
  for (const line of raw.split("\n")) {
    const m = /^-\s+(.*)$/.exec(line);
    if (!m) continue;
    const claim = normalizeClaim(m[1]);
    if (!docs.some((d) => d.includes(claim))) orphans.push(claim.slice(0, 90));
  }
  return orphans;
}

test("every allowlist entry appears in some doc — an orphaned entry is a standing pre-approval for a sentence nobody has written", () => {
  // Fourteenth instance (governor-lead): a reworded doc span left its old
  // allowlist entry behind, and the "no dead entries" test's TITLE promised
  // orphan coverage while its code only checked text-liveness — the
  // docs→allowlist direction ran, the allowlist→docs direction did not
  // exist. An orphan is exempt-forever: if anyone ever re-writes that exact
  // sentence (an old-copy restore, an agent "fixing" a path back), it lands
  // pre-approved and the ratchet stays silent. So: every entry, both tiers,
  // must appear verbatim (normalized) in at least one scanned doc.
  const raw = readFileSync(ALLOWLIST_PATH, "utf8");
  assert.deepEqual(
    findOrphanEntries(raw, readInvariantDocs()),
    [],
    "orphaned allowlist entries (in no doc) — delete them or restore their sentence"
  );
});

test("VACUITY: gutting the orphan detector makes the plant survive — the leg runs the REAL loop", () => {
  // Fifteenth instance, and it was in the fix for the fourteenth: the first
  // version of this leg asserted `!docs.some(d => d.includes(planted))` and
  // then re-computed that SAME expression as its "the predicate fires" check.
  // It never called the detector, so `if (false) orphans.push(...)` left the
  // whole file green — the guard could have been deleted outright and nothing
  // would have noticed. A vacuity leg that re-states the claim instead of
  // exercising the code proves only that the sentence was well-chosen.
  //
  // So plant a genuine orphan INTO the allowlist text and run the real loop.
  const raw = readFileSync(ALLOWLIST_PATH, "utf8");
  const docs = readInvariantDocs();
  const plant = "- Governor guarantees this exact sentence appears in no scanned doc anywhere.";
  assert.deepEqual(findOrphanEntries(raw, docs), [], "sanity: the unplanted allowlist is orphan-free");
  assert.deepEqual(
    findOrphanEntries(raw + "\n" + plant + "\n", docs),
    [normalizeClaim(plant.slice(2)).slice(0, 90)],
    "the detector must flag the planted orphan — and ONLY it"
  );
});

test("allowlist entries are unique and each still reads as an invariant claim (text-liveness, not doc-presence — orphans are the NEXT test)", () => {
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
