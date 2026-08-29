// SECRET SCAN — refuse a commit that carries live credentials.
//
// WHY THIS EXISTS (2026-08-27, a real incident, not a hypothetical):
// an agent session ran a full `zsh` environment dump and pasted the output into
// a design doc, which was committed and pushed to this PUBLIC repo. GitHub's
// secret-scanning partner program caught it within seconds and Anthropic and
// OpenAI both auto-revoked the exposed keys. SIX live credentials were in that
// one paste — two API keys, a GitHub OAuth token with `repo` and `workflow`
// scope, and three service tokens. The GitHub token was still live fifteen
// hours later, because nothing in this repo noticed.
//
// The lesson is narrow and worth stating exactly: the failure was not a config
// file checked in by mistake. It was COMMAND OUTPUT pasted into prose. No
// .gitignore rule can catch that, because the file was a legitimate document
// that legitimately belonged in the commit. Only a content scan catches it.
//
// SHAPE: this module is a PURE function over text, and the git plumbing lives
// in `.githooks/pre-commit`. That split is what makes the detection testable —
// `packages/plugin/tests/secret-scan.test.mjs` drives `findSecrets` against
// fixtures directly, including a planted positive per rule, so the scan is
// proven to fire BEFORE it is trusted to stay silent. A scanner that silently
// matches nothing is worse than no scanner, because it is believed.
//
// TUNING: every rule here is calibrated against the REAL false positives found
// while auditing this incident, which are kept as regression fixtures:
//
//   • `Czechoslovakian` matched a naive case-insensitive /AKIA/ — hence the
//     case-sensitive AWS rule with a strict 16-char uppercase tail.
//   • A log-REDACTION regex (`(r"\b(AKIA[A-Z0-9]{16})"` in another repo of
//     Nelson's) is code that MASKS keys — security code must not be flagged as
//     a leak, or the scanner trains people to bypass it.
//   • Documentation placeholders (`sk-ant-api03-xyz789...`, `sk-proj-abc123...`)
//     are how every honest config guide is written. Real keys are long; the
//     length floors below are what separate them, not a vibe.
//
// A false positive here is not a small cost. It is the thing that makes someone
// reach for `--no-verify` by reflex, and after that the scanner protects
// nothing.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A credential rule. `test` must be anchored to real key SHAPE, not a keyword. */
const RULES = [
  {
    id: "anthropic-api-key",
    // Real: sk-ant-api03-<~95 chars>. The placeholder `sk-ant-api03-xyz789...`
    // is ~7 tail chars, so the floor of 40 separates them without a guess.
    re: /sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{40,}/g,
    why: "Anthropic API key",
  },
  {
    id: "openai-project-key",
    re: /sk-proj-[A-Za-z0-9_-]{40,}/g,
    why: "OpenAI project key",
  },
  {
    id: "openai-legacy-key",
    // Legacy OpenAI keys are sk- + exactly 48 base62. Bounded on both sides so
    // it cannot swallow arbitrary sk-prefixed words.
    re: /\bsk-[A-Za-z0-9]{48}\b/g,
    why: "OpenAI legacy API key",
  },
  {
    id: "github-token",
    // gho_/ghp_/ghs_/ghu_/ghr_ + 36. This is the class that leaked with `repo`
    // and `workflow` scope, and the one nobody auto-revoked.
    re: /\bgh[posur]_[A-Za-z0-9]{36,}\b/g,
    why: "GitHub token",
  },
  {
    id: "github-fine-grained-pat",
    re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
    why: "GitHub fine-grained PAT",
  },
  {
    id: "aws-access-key-id",
    // CASE-SENSITIVE, and the tail must be exactly 16 uppercase alphanumerics.
    // `Czechoslovakian` fails on case; `AKIA[A-Z0-9]{16}` (a redaction regex)
    // fails because `[` is not in the class.
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    why: "AWS access key id",
  },
  {
    id: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    why: "Slack token",
  },
  {
    id: "private-key-block",
    re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
    why: "private key block",
  },
];

/**
 * Values that look like secrets but are how documentation is honestly written.
 * Checked against the VALUE half of a `NAME=value` assignment.
 */
const PLACEHOLDER = /^(?:<|\$\{|\$[A-Z]|""|''|\.\.\.|x{3,}|\*{3,})|(?:\.\.\.$)|^(?:your|my|the|example|placeholder|redacted|changeme|change_me|dummy|test|fake|sample|abc123|xyz789|insert|todo|none|null|unset|n\/a)/i;

/** Env-assignment names whose VALUES are credentials rather than config. */
const SENSITIVE_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHTOKEN|ACCESS_?KEY|PRIVATE_?KEY)$/;

/** Redact a matched value so a finding can be printed without re-leaking it. */
export function redact(value) {
  const s = String(value);
  if (s.length <= 10) return `${s.slice(0, 2)}<redacted:${s.length}>`;
  return `${s.slice(0, 7)}<redacted:${s.length} chars>`;
}

/**
 * Find credential-shaped content in `text`.
 *
 * Returns `[{ line, rule, why, sample }]`, `sample` already redacted. Pure: no
 * I/O, no git, no process state — which is what lets the test drive it.
 *
 * Two detector families, because the incident needed both:
 *   1. SHAPE rules (above) — a key recognizable on sight, wherever it appears.
 *   2. ASSIGNMENT rules — `NGROK_AUTHTOKEN=<48 chars>` has no recognizable
 *      prefix and no vendor would ever scan for it, but it is unmistakably a
 *      credential because of the NAME it is bound to. Three of the six secrets
 *      in the real incident were only catchable this way.
 */
export function findSecrets(text) {
  const findings = [];
  const lines = String(text).split("\n");

  lines.forEach((raw, i) => {
    const line = raw;
    const lineNo = i + 1;

    // An explicit, reviewable escape hatch. Deliberately verbose: it should be
    // easier to fix the leak than to remember this string.
    if (/secret-scan:\s*allow\b/.test(line)) return;

    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        findings.push({ line: lineNo, rule: rule.id, why: rule.why, sample: redact(m[0]) });
      }
    }

    // Assignment form: NAME=value, where NAME reads as a credential.
    const asn = /^\s*(?:\+|export\s+|declare\s+-x\s+)?([A-Za-z][A-Za-z0-9_]{2,})\s*=\s*(.*)$/.exec(line);
    if (asn) {
      const name = asn[1].toUpperCase();
      let value = asn[2].trim().replace(/[;,]$/, "");
      // Strip one layer of quoting, then re-check emptiness.
      const q = /^(['"])(.*)\1$/.exec(value);
      if (q) value = q[2];
      if (
        SENSITIVE_NAME.test(name) &&
        value.length >= 16 &&
        !PLACEHOLDER.test(value) &&
        // A value that is itself a variable reference is config, not a secret.
        !/^\$/.test(value) &&
        // Avoid double-reporting something a SHAPE rule already caught.
        !findings.some((f) => f.line === lineNo)
      ) {
        findings.push({
          line: lineNo,
          rule: "credential-assignment",
          why: `${asn[1]} assigned a literal value`,
          sample: redact(value),
        });
      }
    }
  });

  return findings;
}

/**
 * THE ENV-DUMP DETECTOR — the actual shape of the incident.
 *
 * A `typeset`/`env`/`set` dump is dozens of `NAME=value` lines arriving at
 * once. Individually most are harmless (`BROWSER=true`); collectively they are
 * a photograph of a live shell, and the next one may contain a credential this
 * scanner has no rule for. So the BLOCK is refused on its shape, independent of
 * whether any single line trips a rule above.
 *
 * This is the belt to the shape-rules' braces: it would have caught the real
 * incident even with every vendor prefix unknown.
 */
export function findEnvDump(text, threshold = 20) {
  const lines = String(text).split("\n");
  const assignments = lines.filter((l) => /^\s*\+?\s*[A-Z][A-Z0-9_]{2,}=/.test(l));
  if (assignments.length < threshold) return null;
  return {
    count: assignments.length,
    threshold,
    // Names only — never values.
    names: assignments
      .map((l) => (/^\s*\+?\s*([A-Z][A-Z0-9_]{2,})=/.exec(l) || [])[1])
      .filter(Boolean)
      .slice(0, 8),
  };
}

/** Extract only ADDED lines from a unified diff. What a commit is answerable for. */
export function addedLinesOf(diff) {
  return String(diff)
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

// ── CLI: reads a unified diff on stdin, exits non-zero on findings ───────────
//
// The entry-point check is `realpath`-compared rather than the usual
// `import.meta.url === \`file://${process.argv[1]}\``, because that idiom is
// FALSE whenever the script is invoked by a relative path — `node
// scripts/secret-scan.mjs` gives argv[1] = "scripts/secret-scan.mjs" while
// import.meta.url is absolute. The first version of this file used it, and the
// result was a scanner that exited 0 on a commit containing a live API key: the
// detection was correct and simply never ran.
//
// That is the defect this repo keeps meeting — a guard exists, but nothing
// proves the path REACHES it — and it is why `secret-scan.test.mjs` spawns this
// file as a subprocess instead of only testing the exported functions. A unit
// test of `findSecrets` cannot catch a broken `main` check.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const added = addedLinesOf(Buffer.concat(chunks).toString("utf8"));

  const findings = findSecrets(added);
  const dump = findEnvDump(added);

  if (findings.length === 0 && !dump) process.exit(0);

  console.error("\n\x1b[31mCOMMIT REFUSED — credential-shaped content in staged changes\x1b[0m\n");
  for (const f of findings) {
    console.error(`  ${f.why} (${f.rule})`);
    console.error(`    added line ${f.line}: ${f.sample}\n`);
  }
  if (dump) {
    console.error(`  environment dump: ${dump.count} NAME=value lines (threshold ${dump.threshold})`);
    console.error(`    e.g. ${dump.names.join(", ")}…`);
    console.error("    Shell environment output does not belong in a committed file.\n");
  }
  console.error("If a credential really was staged, it is compromised the moment it is pushed:");
  console.error("  ROTATE IT FIRST, then remove it from the change.\n");
  console.error("If this is a false positive, add a `secret-scan: allow` comment on that line,");
  console.error("or fix the rule in scripts/secret-scan.mjs. Use --no-verify only if you have");
  console.error("checked by hand that nothing real is exposed.\n");
  process.exit(1);
}
