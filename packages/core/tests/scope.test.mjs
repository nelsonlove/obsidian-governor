/**
 * scope.test.mjs — `resolveScope`, published into core at the read-tier
 * satellite extraction (suite split, S7).
 *
 * Two things this file exists to pin:
 *
 *   1. THE MOVE WAS BEHAVIOUR-PRESERVING. The host's copy was defined over
 *      `guardCall({isMutating: false, args: {path: prefix}, settings})`; core's
 *      is defined over `isVisible` directly, because with `isMutating: false`
 *      the read-only branch is dead and `collectPaths({path: prefix})` is
 *      exactly `[prefix]`. The refusal CODES and MESSAGES below are the
 *      host's, byte for byte — an extraction must not reword what an agent
 *      parses.
 *
 *   2. THE ONE NEW REFUSAL. A scope containing a backslash is now refused
 *      `invalid_scope`. It is the same class of fix the triage satellite
 *      applied to its `target_path` validator at the 2026-09-05 review: every
 *      check downstream of this one splits on "/" alone, so a backslash reads
 *      as one opaque segment here and as a traversal to whatever normalizes it
 *      later. Both callers — the host's `obsidian_check_links` and the
 *      `vault-health` satellite's lint — got stricter in the same motion, which
 *      is the whole point of there being one copy rather than two.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveScope } from "../src/scope.ts";

const ALLOW = (...allowlist) => ({ readOnly: false, allowlist });

describe("resolveScope: an omitted scope is how you ask for everything visible", () => {
  test("undefined resolves to no prefix and no refusal", () => {
    assert.deepEqual(resolveScope(undefined), {});
    assert.deepEqual(resolveScope(undefined, ALLOW("Projects")), {});
  });
});

describe("resolveScope: malformed scopes are refused, never silently repaired", () => {
  const malformed = [
    ["Projects\\..\\Secrets", "contains a backslash"],
    ["Projects\\Alpha", "contains a backslash"],
    ["\\", "contains a backslash"],
    [" Projects", "has leading or trailing whitespace"],
    ["Projects ", "has leading or trailing whitespace"],
    ["/Projects", "is an absolute path"],
    ["", "does not name a folder in this vault"],
    [".", "does not name a folder in this vault"],
    ["..", "does not name a folder in this vault"],
    ["../Elsewhere", "does not name a folder in this vault"],
    ["Projects/../..", "does not name a folder in this vault"],
  ];
  for (const [scope, why] of malformed) {
    test(`'${scope}' ⇒ invalid_scope (${why})`, () => {
      const { prefix, refusal } = resolveScope(scope);
      assert.equal(prefix, undefined, "a refused scope must not also resolve");
      assert.equal(refusal.code, "invalid_scope");
      assert.ok(refusal.message.includes(why), refusal.message);
      // The remediation sentence is part of the shipped envelope.
      assert.ok(refusal.message.endsWith("Nothing was reported."), refusal.message);
    });
  }

  test("the backslash check runs FIRST, before whitespace or absoluteness", () => {
    // Ordering matters only for the message a caller reads, but a caller acts
    // on that message: naming the backslash is actionable, naming the
    // whitespace on a backslashed path is not.
    assert.match(resolveScope(" Projects\\x ").refusal.message, /contains a backslash/);
    assert.match(resolveScope("/Projects\\x").refusal.message, /contains a backslash/);
  });
});

describe("resolveScope: normalization", () => {
  test("a well-formed scope resolves to its normalized prefix", () => {
    assert.deepEqual(resolveScope("Projects"), { prefix: "Projects" });
    assert.deepEqual(resolveScope("Projects/"), { prefix: "Projects" });
    assert.deepEqual(resolveScope("Projects//Alpha"), { prefix: "Projects/Alpha" });
    assert.deepEqual(resolveScope("Projects/./Alpha"), { prefix: "Projects/Alpha" });
    assert.deepEqual(resolveScope("Projects/Beta/../Alpha"), { prefix: "Projects/Alpha" });
  });

  test("a note path is a legal scope — lint restricts to one note this way", () => {
    assert.deepEqual(resolveScope("Projects/Note.md"), { prefix: "Projects/Note.md" });
  });
});

describe("resolveScope: the allowlist half", () => {
  test("no allowlist ⇒ every well-formed scope resolves", () => {
    assert.deepEqual(resolveScope("Archive/Secrets", ALLOW()), { prefix: "Archive/Secrets" });
    assert.deepEqual(resolveScope("Archive/Secrets"), { prefix: "Archive/Secrets" });
  });

  test("a scope inside the allowlist resolves", () => {
    assert.deepEqual(resolveScope("Projects/Alpha", ALLOW("Projects")), { prefix: "Projects/Alpha" });
    assert.deepEqual(resolveScope("Projects", ALLOW("Projects")), { prefix: "Projects" });
  });

  test("a scope outside it refuses out_of_allowlist, in the host's exact words", () => {
    const { prefix, refusal } = resolveScope("Archive/Secrets", ALLOW("Projects"));
    assert.equal(prefix, undefined);
    assert.equal(refusal.code, "out_of_allowlist");
    assert.equal(
      refusal.message,
      "path 'Archive/Secrets' is outside the governor allowlist — narrow the scope, or omit it. Nothing was reported.",
    );
  });

  test("a scope that merely CONTAINS the allowlist is out of it too", () => {
    // `Projects` under an allowlist of `Projects/Alpha` would report on
    // `Projects/Beta` as well. Narrow the scope, or omit it.
    const { refusal } = resolveScope("Projects", ALLOW("Projects/Alpha"));
    assert.equal(refusal.code, "out_of_allowlist");
  });

  test("normalization happens BEFORE the allowlist check — the traversal bypass", () => {
    // Without normalizing first, `Projects/../Archive` passes a naive
    // "starts with Projects" prefix test and then resolves elsewhere.
    const { refusal } = resolveScope("Projects/../Archive", ALLOW("Projects"));
    assert.equal(refusal.code, "out_of_allowlist");
    assert.match(refusal.message, /path 'Archive' is outside/);
  });

  test("a partial settings object means unrestricted, and never throws", () => {
    // `guardCall` used to read `settings.allowlist.length` unguarded, so a bag
    // with no `allowlist` key threw rather than allowing. Kept total here.
    assert.deepEqual(resolveScope("Anywhere", {}), { prefix: "Anywhere" });
    assert.deepEqual(resolveScope("Anywhere", { readOnly: true }), { prefix: "Anywhere" });
  });

  test("readOnly is irrelevant — this resolves a READ scope, never a mutation", () => {
    assert.deepEqual(resolveScope("Projects", { readOnly: true, allowlist: ["Projects"] }), {
      prefix: "Projects",
    });
  });
});
