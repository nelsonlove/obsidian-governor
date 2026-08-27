/**
 * governance-live-mount.test.mjs — the PURE half of the governance pane's live mount/unmount fix.
 *
 * The bug: `wireGovernance` only ran at onload, so flipping the governance-enabled toggle did
 * nothing until a plugin reload. The fix mounts/unmounts the pane live from the toggle. The
 * obsidian-coupled part (registerView / addRibbonIcon / workspace calls / Component teardown) is
 * NOT headlessly testable and is verified by build + reasoning — but the transition DECISION and
 * its idempotency guards ARE pure, and that is what `mountAction` (src/mount-state.ts — host-side
 * since the suite split's S2, because the host drives the scheme panes with it too)
 * captures. main.ts drives its real mount/unmount off exactly this function, so pinning it here
 * pins the live behavior's decision core:
 *   - enable while unmounted → "mount"
 *   - disable while mounted   → "unmount"
 *   - enable while already mounted / disable while already unmounted → "none" (idempotent no-op:
 *     never a double-wire, never a double-teardown).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mountAction } from "../src/mount-state.ts";

describe("mountAction — the live mount/unmount transition decision", () => {
  test("enable while unmounted mounts", () => {
    assert.equal(mountAction(false, true), "mount");
  });

  test("disable while mounted unmounts", () => {
    assert.equal(mountAction(true, false), "unmount");
  });

  test("enable while already mounted is a no-op (idempotent — no double-wire)", () => {
    assert.equal(mountAction(true, true), "none");
  });

  test("disable while already unmounted is a no-op (idempotent — no double-teardown)", () => {
    assert.equal(mountAction(false, false), "none");
  });

  test("a mount then a redundant enable is a single mount (no second wire)", () => {
    // Model main.ts's applyGovernanceMount: mounted flips true only after a real "mount".
    let mounted = false;
    const step = (enabled) => {
      const a = mountAction(mounted, enabled);
      if (a === "mount") mounted = true;
      else if (a === "unmount") mounted = false;
      return a;
    };
    assert.equal(step(true), "mount"); // first enable wires
    assert.equal(step(true), "none"); // redundant enable does nothing
    assert.equal(step(false), "unmount"); // disable tears down
    assert.equal(step(false), "none"); // redundant disable does nothing
    assert.equal(step(true), "mount"); // re-enable wires afresh
    assert.equal(mounted, true);
  });
});
