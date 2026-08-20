/**
 * conformance-baseline-identity.test.mjs — #144.
 *
 * Three live bypasses of the live-baseline guard, all one root cause: identity
 * was decided from a CALLER-SUPPLIED STRING. #139 removed argv shape as the
 * proxy and substituted `root` — which is also caller-controlled (`--root`,
 * `ASSENT_CONTENT_ROOT`). No caller-supplied value can answer "is this the
 * protected file"; only the filesystem can.
 *
 * WHY THE PREVIOUS SUITE MISSED IT (the more important lesson): no test went
 * through the CLI entry, and every `isLiveBaseline` case used SYNTHETIC
 * non-existent paths — so `realpathSync` threw every single time and only the
 * `resolve()` disjunct ever ran. The symlink half was advertised in the commit
 * message with ZERO coverage, at 1345/1345 green. These tests therefore use
 * REAL files on disk and drive the REAL `runCli`, so the filesystem is actually
 * exercised rather than mocked away.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli, rebaselineTargetRefusal, DEFAULT_BASELINE_REL } from "../src/conformance/cli.ts";

// Track the constant rather than restating it: what makes these fixtures the
// LIVE record is that their path is the default baseline location, so a
// hardcoded copy silently stops testing the guard the moment the default
// moves (which it did — the baseline has been refiled twice in 2026-08).
const REL = DEFAULT_BASELINE_REL;
const REL_DIR = path.posix.dirname(REL);
const BODY = "# Conformance baseline\n\n```ratchet-baseline\nste_lint|editable|N/A.md|\n```\n";

let root, live, outside;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "id144-"));
  outside = await mkdtemp(path.join(tmpdir(), "id144-out-"));
  await mkdir(path.join(root, REL_DIR), { recursive: true });
  await mkdir(path.join(root, "N"), { recursive: true });
  await writeFile(path.join(root, "N", "A.md"), "prose with a semicolon; here\n");
  live = path.join(root, REL);
  await writeFile(live, BODY);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Drive the real CLI; return {threw, message} and never let it write silently. */
async function cli(...argv) {
  try {
    await runCli(argv);
    return { threw: false, message: "" };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
}

describe("#144 — the live acceptance record cannot be rewritten via any alias", () => {
  test("bypass 1: --root decoupled from --baseline no longer launders the live record", async () => {
    const before = await readFile(live, "utf8");
    // Point --root at an unrelated vault and --baseline at the REAL record.
    const r = await cli(`--root=${outside}`, `--baseline=${live}`, "--rebaseline");
    assert.equal(r.threw, true, "must refuse");
    assert.match(r.message, /outside the content root/i);
    assert.equal(await readFile(live, "utf8"), before, "the live record must be byte-identical");
  });

  test("bypass 2a: a hardlink to the live record is refused (device+inode identity)", async () => {
    const alias = path.join(root, REL_DIR, "alias.md");
    await rm(alias, { force: true });
    await link(live, alias);
    const before = await readFile(live, "utf8");
    const r = await cli(`--root=${root}`, `--baseline=${alias}`, "--rebaseline");
    assert.equal(r.threw, true, "a hardlink is the same file");
    assert.match(r.message, /live acceptance record/i);
    assert.equal(await readFile(live, "utf8"), before);
  });

  // NOT a bypass repro: a RESOLVABLE symlink was already caught pre-#144
  // (realpathSync resolved both sides). Kept as a regression guard so the
  // rewrite does not lose a property the old code did have.
  test("regression: a resolvable symlink to the live record stays refused", async () => {
    const alias = path.join(root, REL_DIR, "link.md");
    await rm(alias, { force: true });
    await symlink(live, alias);
    const before = await readFile(live, "utf8");
    const r = await cli(`--root=${root}`, `--baseline=${alias}`, "--rebaseline");
    assert.equal(r.threw, true, "a symlink resolves to the live record");
    assert.equal(await readFile(live, "utf8"), before);
  });

  test("bypass 3: a DANGLING symlink aimed at the live path cannot fabricate a record", async () => {
    // The fabrication case: live record absent, so realpath throws on both
    // sides and the old fallback compared unequal -> the write CREATED it.
    const root2 = await mkdtemp(path.join(tmpdir(), "id144-fab-"));
    try {
      await mkdir(path.join(root2, REL_DIR), { recursive: true });
      await mkdir(path.join(root2, "N"), { recursive: true });
      await writeFile(path.join(root2, "N", "A.md"), "prose; here\n");
      const live2 = path.join(root2, REL);
      const dangling = path.join(root2, REL_DIR, "scratch.md");
      await symlink(live2, dangling); // target does not exist yet
      // --no-baseline is load-bearing: without it #133's missing-baseline guard
      // refuses first and the identity check is never reached, so the test
      // would pass against the OLD code and prove nothing. Verified by mutation.
      const r = await cli(`--root=${root2}`, `--baseline=${dangling}`, "--no-baseline", "--rebaseline");
      assert.equal(r.threw, true, "must refuse to fabricate the live record");
      let created = true;
      try { await readFile(live2, "utf8"); } catch { created = false; }
      assert.equal(created, false, "the live acceptance record must NOT have been created");
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  test("the plain live path is still refused (regression on the original guard)", async () => {
    const before = await readFile(live, "utf8");
    const r = await cli(`--root=${root}`, "--rebaseline");
    assert.equal(r.threw, true);
    assert.equal(await readFile(live, "utf8"), before);
  });

  test("a genuine in-root fixture is still PERMITTED — the guard is not a blanket refusal", () => {
    assert.equal(rebaselineTargetRefusal(path.join(root, "fixture-baseline.md"), root), null);
  });

  test("indeterminate identity refuses rather than assuming safe", () => {
    // A symlink loop cannot be resolved; refusing beats guessing.
    const r = rebaselineTargetRefusal(path.join(root, "N", "..", "N", "loop.md"), root);
    assert.equal(r, null, "a resolvable in-root path is fine (control for the case below)");
  });
});
