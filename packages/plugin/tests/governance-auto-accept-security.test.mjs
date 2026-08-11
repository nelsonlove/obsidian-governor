// AUTO-ACCEPT SECURITY INVARIANTS (static scans) — the subset that binds the PURE modules
// folded in cycle 1 (src/kernel/governance/auto-accept/*.ts). Ported from
// obsidian-stewardship/tests/auto-accept-security.test.mjs (#83, cycle 1).
//
// Auto-accept is the ONE automated baseline advance — a violation here is a critical defect.
// The invariants that also bind the WIRING (main.ts's maybeAutoAccept / setClassEnabled /
// gesture-gated allowlist mutator, and the accept.ts/gesture.ts untouched-ness) are DEFERRED
// to cycle 2, when that wiring folds in under its own accept-reachability review — those files
// do not exist in vault-mcp yet. What DOES bind now:
//   - eligibility is computed from bytes only — NO agent-supplied field (`intent`) is read;
//   - the pure detector/eligibility/classes modules import no `obsidian` runtime;
//   - they register no command / protocol handler (they are pure, reachable from no surface).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const aaDir = path.join(here, "..", "src", "kernel", "governance", "auto-accept");
const readRaw = (p) => fs.readFileSync(p, "utf8");
const aaFiles = () => fs.readdirSync(aaDir).filter((f) => f.endsWith(".ts")).map((f) => path.join(aaDir, f));

// Strip comments so identifiers in the (extensive) invariant docs don't false-match.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/([^:])\/\/[^\n]*/g, "$1")
    .replace(/^\/\/[^\n]*/gm, "");
}
const code = (p) => stripComments(readRaw(p));

// ---------------------------------------------------------------------------
// (1) Advisory agent text is NEVER an eligibility input.
// ---------------------------------------------------------------------------
test("the pure eligibility/detector modules never reference `intent` or any agent field", () => {
  const files = aaFiles();
  assert.ok(files.length >= 3, "expected classes.ts + detectors.ts + eligibility.ts");
  for (const f of files) {
    const src = code(f);
    assert.ok(!/\bintent\b/.test(src), `${path.basename(f)} must not reference agent-supplied intent`);
    assert.ok(!/\bactor\b/.test(src), `${path.basename(f)} must not read the journal actor field`);
    assert.ok(!/\bargsDigest\b/.test(src), `${path.basename(f)} must not read agent args`);
  }
});

// ---------------------------------------------------------------------------
// (2) Pure modules: no obsidian runtime, no command / protocol registration.
// ---------------------------------------------------------------------------
test("auto-accept pure modules import no `obsidian` runtime", () => {
  for (const f of aaFiles()) {
    assert.ok(!/from\s+["']obsidian["']/.test(readRaw(f)), `${path.basename(f)} must not import obsidian`);
  }
});

test("auto-accept modules register ZERO commands / protocol handlers", () => {
  for (const f of aaFiles()) {
    const src = code(f);
    assert.ok(!/\.addCommand\s*\(/.test(src), `${path.basename(f)} must not call addCommand`);
    assert.ok(!/registerObsidianProtocolHandler\s*\(/.test(src), `${path.basename(f)} must not register a protocol handler`);
  }
});
