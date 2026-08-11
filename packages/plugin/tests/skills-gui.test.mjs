/**
 * skills-gui.test.mjs — the pure, headless-testable halves of the skills GUI fold
 * (#82 residuals: the human affordances the 0.8.2 fold left out).
 *
 * The ItemView rendering (pane.ts) and the command/modal UX (commands.ts) are
 * Obsidian-coupled and verified by reasoning + build. What IS pure and covered here:
 *
 *   1. `debounce` — the trailing-debounce coalescing + `cancel()` (export-on-save and the
 *      preview pane both depend on it collapsing a rename's event burst into one run);
 *   2. `handleNoteChanged` — the change-relevance predicate that decides whether an edited
 *      note triggers a (debounced) export: gated on enabled, kind-detected through the
 *      configured field/tag mode, or a transcluded source;
 *   3. `bumpPatch` — the release version helper;
 *   4. the `exportOnSave` config field — coerced OFF for anything but a literal `true`, so a
 *      hand-edited data.json can never turn the GUI's on-save export on by accident.
 *
 * These files import nothing from `obsidian`, so they load directly in node.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { debounce, handleNoteChanged } from "../src/skills/export-trigger.ts";
import { bumpPatch } from "../src/skills/version.ts";
import { skillsConfigOf, DEFAULT_SKILLS_CONFIG } from "../src/kernel/skills/skills-config.ts";

// ── 1. debounce ─────────────────────────────────────────────────────────────

describe("debounce", () => {
  test("coalesces a burst into a single trailing call", async () => {
    let calls = 0;
    const d = debounce(() => { calls++; }, 20);
    d(); d(); d();
    assert.equal(calls, 0, "must not fire synchronously");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 1, "a burst collapses into one run");
  });

  test("cancel() drops a pending call", async () => {
    let calls = 0;
    const d = debounce(() => { calls++; }, 20);
    d();
    d.cancel();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 0, "a cancelled pending call never fires");
  });

  test("fires again after the window settles", async () => {
    let calls = 0;
    const d = debounce(() => { calls++; }, 15);
    d();
    await new Promise((r) => setTimeout(r, 40));
    d();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(calls, 2);
  });
});

// ── 2. handleNoteChanged ─────────────────────────────────────────────────────

const PREFIX = { mode: "prefix", prefix: "", key: "vault-skills", typeSource: "frontmatter", tagPrefix: "agent/" };

function tracker(overrides = {}) {
  let exports = 0;
  const deps = {
    isEnabled: () => true,
    fields: () => PREFIX,
    getFrontmatter: () => undefined,
    requestExport: () => { exports++; },
    ...overrides,
  };
  return { deps, exports: () => exports };
}

describe("handleNoteChanged", () => {
  test("disabled: never requests an export", () => {
    const t = tracker({ isEnabled: () => false, getFrontmatter: () => ({ type: "skill" }) });
    handleNoteChanged({ path: "S.md" }, t.deps);
    assert.equal(t.exports(), 0);
  });

  test("a skill/agent/policy/command note triggers an export (frontmatter mode)", () => {
    for (const type of ["skill", "agent", "policy", "command"]) {
      const t = tracker({ getFrontmatter: () => ({ type }) });
      handleNoteChanged({ path: "N.md" }, t.deps);
      assert.equal(t.exports(), 1, `type: ${type} should trigger`);
    }
  });

  test("a note with no frontmatter, or an unrelated type, does NOT trigger", () => {
    const noFm = tracker({ getFrontmatter: () => undefined });
    handleNoteChanged({ path: "Plain.md" }, noFm.deps);
    assert.equal(noFm.exports(), 0);

    const unrelated = tracker({ getFrontmatter: () => ({ type: "meeting" }) });
    handleNoteChanged({ path: "M.md" }, unrelated.deps);
    assert.equal(unrelated.exports(), 0, "a bare unrelated type must not false-positive");
  });

  test("a transcluded source note triggers even without a skill/agent kind", () => {
    const t = tracker({ getFrontmatter: () => undefined, isSource: (p) => p === "Included.md" });
    handleNoteChanged({ path: "Included.md" }, t.deps);
    assert.equal(t.exports(), 1);
  });

  test("tags mode: the kind tag decides", () => {
    const tags = { mode: "prefix", prefix: "", key: "vault-skills", typeSource: "tags", tagPrefix: "agent/" };
    const t = tracker({ fields: () => tags, getFrontmatter: () => ({ tags: ["agent/skill"] }) });
    handleNoteChanged({ path: "T.md" }, t.deps);
    assert.equal(t.exports(), 1);

    const noKind = tracker({ fields: () => tags, getFrontmatter: () => ({ tags: ["project"] }) });
    handleNoteChanged({ path: "T2.md" }, noKind.deps);
    assert.equal(noKind.exports(), 0);
  });
});

// ── 3. bumpPatch ─────────────────────────────────────────────────────────────

describe("bumpPatch", () => {
  test("increments the patch of a valid semver", () => {
    assert.equal(bumpPatch("1.2.3"), "1.2.4");
    assert.equal(bumpPatch("0.0.9"), "0.0.10");
  });
  test("falls back to 0.1.0 for missing/malformed input", () => {
    assert.equal(bumpPatch(undefined), "0.1.0");
    assert.equal(bumpPatch(""), "0.1.0");
    assert.equal(bumpPatch("1.2"), "0.1.0");
    assert.equal(bumpPatch("v1.2.3"), "0.1.0");
  });
});

// ── 4. exportOnSave config coercion ──────────────────────────────────────────

describe("skillsConfigOf: exportOnSave", () => {
  test("defaults OFF", () => {
    assert.equal(DEFAULT_SKILLS_CONFIG.exportOnSave, false);
    assert.equal(skillsConfigOf({}).exportOnSave, false);
  });
  test("only a literal true enables it", () => {
    assert.equal(skillsConfigOf({ exportOnSave: true }).exportOnSave, true);
    // Anything else — a stray string, 1, "true" — degrades to off.
    for (const v of ["true", 1, "yes", null, {}]) {
      assert.equal(skillsConfigOf({ exportOnSave: v }).exportOnSave, false, `${JSON.stringify(v)} must not enable`);
    }
  });
});
