/**
 * Scheme panes live-mount WIRING pins (governor#286 / PR #289).
 *
 * The decision core (`mountAction`) is already pinned by governance-live-mount.test.mjs and is
 * REUSED here, so this file pins the part that is easy to regress silently: the wiring in main.ts.
 * Source scans, the repo's established shape for "this call site must keep existing" invariants
 * (cf. the link-healing glob scan and the registration-surface seals) — the live Obsidian mount
 * itself is un-headless.
 *
 * Three properties, each of which was a real defect class before #289:
 *   1. the module toggle DISPATCHES to the scheme panes at all (the #286 bug: the enabled flag was
 *      read once at onload, so toggling did nothing until a plugin reload);
 *   2. the scheme panes have their OWN reconcile chain — sharing governance's would let a rapid
 *      toggle of one pane interleave with the other's mount/unmount;
 *   3. both mount paths go through `mountAction`, so enable-while-mounted and disable-while-
 *      unmounted stay idempotent no-ops rather than double-wiring or double-tearing-down.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

describe("scheme panes: live-mount wiring (#286)", () => {
  test("the module toggle dispatches to BOTH the acceptance pane and the scheme panes", () => {
    const dispatch = main.slice(main.indexOf("async onModuleEnabledChanged"));
    const body = dispatch.slice(0, dispatch.indexOf("\n  }"));
    assert.match(body, /moduleId === "acceptance"[\s\S]*setGovernanceMounted\(enabled\)/);
    assert.match(
      body,
      /moduleId === "scheme"[\s\S]*setSchemePanesMounted\(enabled\)/,
      "toggling the scheme module must drive the panes live — the #286 bug was that it did not",
    );
  });

  test("the scheme panes serialize on their OWN chain, not governance's", () => {
    assert.match(main, /private schemePanesReconcile: Promise<void>/);
    assert.match(main, /this\.schemePanesReconcile\s*\.then\(|this\.schemePanesReconcile\.then\(/);
    // The interleave guard: the scheme path must never reuse the governance chain.
    // Slice exactly the setSchemePanesMounted body, anchored on the next member declaration — a
    // missing anchor would silently widen the slice and pass vacuously, so assert it was found.
    const schemeMount = main.slice(main.indexOf("async setSchemePanesMounted"));
    const end = schemeMount.indexOf("private async applySchemePanesMount");
    assert.ok(end > 0, "anchor for the end of setSchemePanesMounted not found — update this pin");
    const upToNextMember = schemeMount.slice(0, end);
    assert.doesNotMatch(
      upToNextMember,
      /governanceReconcile/,
      "sharing the governance chain would let one pane's rapid toggle interleave with the other's",
    );
  });

  test("both mount paths decide through the idempotent mountAction helper", () => {
    assert.match(main, /mountAction\(this\.governanceComponent !== null, enabled\)/);
    assert.match(main, /mountAction\(this\.schemePanesComponent !== null, enabled\)/);
  });

  test("unmount is removeChild on the returned child Component (not a bespoke teardown)", () => {
    assert.match(main, /this\.removeChild\(this\.schemePanesComponent!\)/);
  });
});
