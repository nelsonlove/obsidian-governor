/**
 * settings-migration.test.mjs — the 0.12.0 module-id rename shim
 * (`modules.governance` → `modules.acceptance`, migrateLegacyModuleIds).
 *
 * The contract pinned here:
 *   - a ≤0.11.x data.json (old key only) is adopted under the new id with its
 *     row VERBATIM — enabled flag, acceptedBy, gateMode,
 *     requiredFrontmatterKeys, and badge prefs all ride across untouched;
 *   - a present `acceptance` row always wins — the legacy row can never
 *     overwrite newer config (idempotence: running the shim twice is a no-op);
 *   - the legacy key is dropped from the returned object, so the next
 *     settings save persists the new shape only;
 *   - nothing-to-migrate returns the SAME object (byte-identical load for
 *     post-rename configs), and other module rows are never touched.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { migrateLegacyModuleIds } from "../src/kernel/modules/settings.ts";

describe("migrateLegacyModuleIds — governance → acceptance", () => {
  test("adopts a legacy governance row verbatim under acceptance and drops the old key", () => {
    // Nelson's live 0.11.x config shape — the exact row that must survive.
    const legacyRow = {
      enabled: true,
      config: {
        acceptedBy: "Nelson",
        gateMode: "soft",
        requiredFrontmatterKeys: ["uid", "title", "description"],
        showRibbonBadge: true,
        showViewTabBadge: false,
      },
    };
    const out = migrateLegacyModuleIds({ governance: legacyRow, scheme: { enabled: true } });
    assert.deepEqual(out.acceptance, legacyRow, "the row must ride across verbatim");
    assert.equal(out.governance, undefined, "the legacy key must be dropped");
    assert.deepEqual(out.scheme, { enabled: true }, "other module rows are untouched");
  });

  test("a present acceptance row wins — the legacy row never overwrites it", () => {
    const modules = {
      governance: { enabled: true, config: { acceptedBy: "old" } },
      acceptance: { enabled: false, config: { acceptedBy: "new" } },
    };
    const out = migrateLegacyModuleIds(modules);
    assert.deepEqual(out.acceptance, { enabled: false, config: { acceptedBy: "new" } });
    // The stale legacy key is left as-is in this branch (nothing is migrated);
    // it is inert — no reader consults `modules.governance` anymore.
    assert.equal(out, modules, "no migration ⇒ the same object back");
  });

  test("idempotent: running the shim on already-migrated settings is a no-op", () => {
    const migrated = migrateLegacyModuleIds({ governance: { enabled: true } });
    const twice = migrateLegacyModuleIds(migrated);
    assert.equal(twice, migrated, "second run returns the same object");
    assert.deepEqual(twice, { acceptance: { enabled: true } });
  });

  test("nothing to migrate returns the SAME object (no old key present)", () => {
    const modules = { acceptance: { enabled: true }, vocab: {} };
    assert.equal(migrateLegacyModuleIds(modules), modules);
    const empty = {};
    assert.equal(migrateLegacyModuleIds(empty), empty);
  });

  test("undefined modules section yields an empty object, never a throw", () => {
    assert.deepEqual(migrateLegacyModuleIds(undefined), {});
  });

  test("a disabled legacy row migrates too (enabled: false is config, not absence)", () => {
    const out = migrateLegacyModuleIds({ governance: { enabled: false } });
    assert.deepEqual(out, { acceptance: { enabled: false } });
  });
});
