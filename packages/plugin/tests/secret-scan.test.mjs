/**
 * secret-scan.test.mjs — the credential scanner, proven before it is trusted.
 *
 * THE INCIDENT THIS ENCODES (2026-08-27): an agent session ran a full `zsh`
 * environment dump and pasted the output into a COMMIT MESSAGE — 249 lines, 96
 * NAME=value pairs — which was pushed to this PUBLIC repo. GitHub
 * secret-scanning caught it in seconds; Anthropic and OpenAI auto-revoked. SIX
 * live credentials were in that paste, and the GitHub OAuth token — `repo` +
 * `workflow` scope — was still live fifteen hours later because nothing here
 * noticed.
 *
 * "COMMIT MESSAGE" is the load-bearing word, and it was got wrong the first
 * time this file was written (it said "a design doc"). No file, tree, or branch
 * in this repo has ever contained that text, which is why the first pass of the
 * investigation concluded — incorrectly — that `main` was clean: it grepped the
 * file tree, the wrong instrument for a secret that lives in a message. The
 * commit reached `main` through a squash-merge and is in the permanent history
 * of a public repo. That is also why there are TWO hooks: a pre-commit scan of
 * `git diff --cached` is the obvious build and would have missed this entirely.
 *
 * The discipline this file follows is the same one `host-governor-boundary`
 * uses, and for the same reason: a scanner is a SAFETY instrument, and a safety
 * instrument that silently matches nothing is worse than none, because it is
 * believed. So every rule gets a PLANTED POSITIVE proving it fires, before any
 * test asserts it stays quiet.
 *
 * The negative cases are not invented. They are the actual false positives
 * found while auditing the real incident across 96 repos, kept as regression
 * fixtures — because the failure mode of a noisy scanner is that someone starts
 * typing `--no-verify` by reflex, and after that it protects nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findSecrets, findEnvDump, addedLinesOf, redact } from "../../../scripts/secret-scan.mjs";

// Synthetic credentials. Shaped like the real thing, valid nowhere.
const FAKE = {
  anthropic: "sk-ant-api03-" + "A1b2C3d4E5f6G7h8".repeat(6) + "AA",
  openaiProj: "sk-proj-" + "Zz9Yy8Xx7Ww6Vv5U".repeat(4),
  openaiLegacy: "sk-" + "a".repeat(48),
  github: "gho_" + "B".repeat(36),
  githubPat: "github_pat_" + "c".repeat(70),
  aws: "AKIA" + "ABCDEFGH12345678",
  // secret-scan: allow — synthetic fixture, valid nowhere; the scanner is
  // SUPPOSED to match this shape, which is why it needs the explicit exemption.
  slack: "xoxb-1234567890-abcdefghij", // secret-scan: allow
};

describe("secret-scan — VACUITY FIRST: every rule fires on a planted positive", () => {
  const planted = [
    ["anthropic-api-key", `ANTHROPIC_API_KEY=${FAKE.anthropic}`],
    ["openai-project-key", `OPENAI_API_KEY=${FAKE.openaiProj}`],
    ["openai-legacy-key", `key: ${FAKE.openaiLegacy}`],
    ["github-token", `GITHUB_PERSONAL_ACCESS_TOKEN=${FAKE.github}`],
    ["github-fine-grained-pat", `token = ${FAKE.githubPat}`],
    ["aws-access-key-id", `aws_access_key_id = ${FAKE.aws}`],
    ["slack-token", `SLACK=${FAKE.slack}`],
    ["private-key-block", "-----BEGIN OPENSSH PRIVATE KEY-----"], // secret-scan: allow
  ];

  for (const [rule, text] of planted) {
    test(`${rule} is detected`, () => {
      const found = findSecrets(text);
      assert.ok(
        found.some((f) => f.rule === rule),
        `rule ${rule} did not fire on its own planted positive: ${JSON.stringify(found)}`
      );
    });
  }

  test("a finding NEVER echoes the secret back", () => {
    // A scanner that prints what it found re-leaks it into CI logs and
    // terminal scrollback — which are themselves places secrets get harvested.
    for (const [, text] of planted) {
      for (const f of findSecrets(text)) {
        assert.ok(!text.includes(f.sample), "the sample must be redacted, not the raw match");
        assert.match(f.sample, /<redacted/, `sample not redacted: ${f.sample}`);
      }
    }
  });
});

describe("secret-scan — the REAL false positives, kept as regression fixtures", () => {
  test("'Czechoslovakian' is not an AWS key", () => {
    // Found in nelsonlove/balance-of-power's country data. A case-insensitive
    // /AKIA/ matched it, which is how a scanner earns a reputation for crying
    // wolf on its first day.
    assert.deepEqual(findSecrets("A resource held by the Czechoslovakian state"), []);
  });

  test("a log-REDACTION regex is not a leak", () => {
    // Found in nelsonlove/WHAM.studio. This is code that MASKS AWS keys —
    // security machinery. Flagging it teaches people the scanner is wrong.
    const line = String.raw`        (r"\b(AKIA[A-Z0-9]{16})", r"***AWS_KEY***"),`;
    assert.deepEqual(findSecrets(line), []);
  });

  test("documentation placeholders are not keys", () => {
    // Found in nelsonlove/seriesoftubes' configuration guide. This is how an
    // honest config doc is written, and it must stay writable.
    const doc = [
      "OPENAI_API_KEY=sk-proj-abc123...",
      "ANTHROPIC_API_KEY=sk-ant-api03-xyz789...",
      "OPENAI_API_KEY=sk-proj-...",
      "ANTHROPIC_API_KEY=sk-ant-...",
      "API_KEY=<your-key-here>",
      "TOKEN=${GITHUB_TOKEN}",
      "SECRET=changeme",
    ].join("\n");
    assert.deepEqual(findSecrets(doc), []);
  });

  test("ordinary config assignments are not credentials", () => {
    const cfg = ["BROWSER=true", "EDITOR=nvim", "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"].join("\n");
    assert.deepEqual(findSecrets(cfg), []);
  });

  test("a variable reference is config, not a secret", () => {
    assert.deepEqual(findSecrets("ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"), []);
  });
});

describe("secret-scan — the assignment rule catches what no vendor scans for", () => {
  // THREE of the six secrets in the real incident had no recognizable vendor
  // prefix. GitHub's own scanner would never have caught them; they are only
  // identifiable by the NAME they are bound to.
  const noPrefix = [
    ["NGROK_AUTHTOKEN", "2OLXfur" + "K".repeat(41)],
    ["SEMGREP_APP_TOKEN", "eb4bf05" + "d".repeat(57)],
    ["OPENCLAW_GATEWAY_TOKEN", "45cf86b" + "e".repeat(41)],
  ];

  for (const [name, value] of noPrefix) {
    test(`${name} is caught by its name, not its shape`, () => {
      const found = findSecrets(`${name}=${value}`);
      assert.ok(found.length > 0, `${name} was not caught`);
      assert.equal(found[0].rule, "credential-assignment");
    });
  }

  test("a short value is not treated as a credential", () => {
    assert.deepEqual(findSecrets("API_KEY=abc"), []);
  });

  test("one line yields one finding, not two", () => {
    // A key that trips BOTH a shape rule and the assignment rule must not be
    // reported twice — duplicated noise reads as a broken tool.
    const found = findSecrets(`ANTHROPIC_API_KEY=${FAKE.anthropic}`);
    assert.equal(found.length, 1);
  });
});

describe("secret-scan — the env-dump detector, the actual incident shape", () => {
  // Reconstructed from the real leaked commit: dozens of NAME=value lines from
  // a live shell. This must fail on SHAPE, so it would have caught the incident
  // even if every vendor prefix in it were unknown to us.
  const dump = [
    "AI_AGENT=claude-code_2-1-220_agent",
    "ALACRITTY_WINDOW_ID=34180334208",
    "BROWSER=true",
    "CLAUDECODE=1",
    "CLAUDE_CODE_ENTRYPOINT=cli",
    "CLAUDE_CODE_SESSION_ID=52332124-0a15-453d-8ffa-3e4cc4701845",
    ...Array.from({ length: 20 }, (_, i) => `SOME_VAR_${i}=value${i}`),
  ].join("\n");

  test("a shell environment dump is refused on its shape alone", () => {
    const d = findEnvDump(dump);
    assert.ok(d, "the env dump was not detected");
    assert.ok(d.count >= d.threshold);
  });

  test("it fires even when NO individual line trips a credential rule", () => {
    // This is the property that matters: the dump above contains no key at all,
    // and is still refused. The next dump's unknown-vendor token is why.
    assert.deepEqual(findSecrets(dump), [], "fixture sanity: no line-level finding");
    assert.ok(findEnvDump(dump), "but the block must still be refused");
  });

  test("a normal .env-style file is NOT an env dump", () => {
    const small = ["NODE_ENV=production", "PORT=3000", "LOG_LEVEL=debug"].join("\n");
    assert.equal(findEnvDump(small), null);
  });

  test("it reports NAMES only, never values", () => {
    const d = findEnvDump(dump);
    for (const n of d.names) assert.ok(!n.includes("="), "a name must not carry its value");
  });
});

describe("secret-scan — only ADDED lines are judged", () => {
  test("context and removed lines are ignored", () => {
    // Otherwise editing near a pre-existing match would fail every later
    // commit, and the fix would be to disable the hook.
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,3 +1,3 @@",
      ` OLD_KEY=${FAKE.github}`,
      `-REMOVED=${FAKE.aws}`,
      "+SAFE=hello",
    ].join("\n");
    assert.deepEqual(findSecrets(addedLinesOf(diff)), []);
  });

  test("an added secret IS judged", () => {
    const diff = ["--- a/f", "+++ b/f", "@@ -0,0 +1 @@", `+GITHUB_TOKEN=${FAKE.github}`].join("\n");
    assert.equal(findSecrets(addedLinesOf(diff)).length, 1);
  });

  test("the +++ header is not mistaken for an added line", () => {
    assert.equal(addedLinesOf("+++ b/some/file.ts").trim(), "");
  });
});

describe("secret-scan — the escape hatch is explicit and narrow", () => {
  test("`secret-scan: allow` suppresses that ONE line", () => {
    const text = [`A=${FAKE.github} // secret-scan: allow`, `B=${FAKE.github}`].join("\n");
    const found = findSecrets(text);
    assert.equal(found.length, 1, "only the un-annotated line should be reported");
    assert.equal(found[0].line, 2);
  });
});

describe("secret-scan — THE ENTRY POINT RUNS (a unit test cannot prove this)", () => {
  // This suite exists because the first version of the scanner was BROKEN in
  // exactly the way the unit tests above cannot see. Its main-module check was
  // the common `import.meta.url === \`file://${process.argv[1]}\`` idiom, which
  // is FALSE whenever the script is invoked by a relative path — so `node
  // scripts/secret-scan.mjs` never executed the CLI block and exited 0 on a
  // commit containing a live API key. Detection was perfect; nothing ran it.
  //
  // That is this repo's recurring defect: a guard exists, but no test proves a
  // path REACHES it. So these spawn the real file as a subprocess.
  const SCANNER = fileURLToPath(new URL("../../../scripts/secret-scan.mjs", import.meta.url));

  const run = (stdin, cwd) => {
    const r = spawnSync(process.execPath, [SCANNER], { input: stdin, encoding: "utf8", cwd });
    return { status: r.status, stderr: r.stderr ?? "" };
  };

  test("clean input exits 0", () => {
    assert.equal(run("+const x = 1;\n").status, 0);
  });

  test("a staged secret exits NON-ZERO", () => {
    const r = run(`+GITHUB_TOKEN=${FAKE.github}\n`);
    assert.equal(r.status, 1, "the CLI must refuse, not pass silently");
    assert.match(r.stderr, /COMMIT REFUSED/);
  });

  test("invoked by RELATIVE path it still refuses — the exact bug", () => {
    // Run with cwd at the repo root and a relative argv[1], reproducing the
    // invocation shape that silently did nothing.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const r = spawnSync(process.execPath, ["scripts/secret-scan.mjs"], {
      input: `+GITHUB_TOKEN=${FAKE.github}\n`,
      encoding: "utf8",
      cwd: repoRoot,
    });
    assert.equal(r.status, 1, "relative invocation must behave identically to absolute");
  });

  test("the CLI never prints the secret it found", () => {
    const r = run(`+GITHUB_TOKEN=${FAKE.github}\n`);
    assert.ok(!r.stderr.includes(FAKE.github), "stderr must not re-leak the credential");
  });

  test("THE REAL INCIDENT SHAPE: an env dump in a commit message is refused", () => {
    // 96 NAME=value lines was the real count. No individual line here carries a
    // recognizable vendor prefix — the block is refused on shape alone, which
    // is what makes this robust against the next unknown token format.
    const dump = Array.from({ length: 96 }, (_, i) => `+SOME_VAR_${i}=value${i}`).join("\n");
    const r = run(dump + "\n");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /environment dump/);
  });
});

describe("secret-scan — redaction is safe on every input length", () => {
  test("short values do not leak by being echoed whole", () => {
    assert.ok(!redact("abcdefgh").includes("cdefgh"));
  });
  test("long values expose at most a 7-char prefix", () => {
    const r = redact(FAKE.anthropic);
    assert.ok(r.startsWith("sk-ant-"));
    assert.ok(r.length < 40);
  });
});
