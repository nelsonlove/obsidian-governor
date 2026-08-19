import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  suffixFor,
  standardZeros,
  buildZeroFrontmatter,
  planStandardZeros,
  planEnsureCategoryIndexes,
} from "../src/kernel/jd-scaffold/standard-zeros.ts";

describe("suffixFor / standardZeros — ported verbatim", () => {
  test("suffixFor: system vs category", () => {
    assert.equal(suffixFor("00"), "for the system");
    assert.equal(suffixFor("06"), "for category 06");
  });

  test("standardZeros: exactly the fixed 00-09 set, in order", () => {
    const zeros = standardZeros("06", suffixFor("06"));
    assert.deepEqual(zeros.map((z) => z.id), ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]);
  });

  test("only 01/03/06/09 have hasDir: true", () => {
    const zeros = standardZeros("06", suffixFor("06"));
    const withDir = zeros.filter((z) => z.hasDir).map((z) => z.id);
    assert.deepEqual(withDir, ["01", "03", "06", "09"]);
  });
});

describe("buildZeroFrontmatter — jd-id line dropped (this fold's own ruling)", () => {
  test("no jd-id: field anywhere in the output", () => {
    const zero = standardZeros("06", suffixFor("06")).find((z) => z.id === "01");
    const text = buildZeroFrontmatter(zero, "06", "06 Digital tools", "2026-08-19");
    assert.doesNotMatch(text, /jd-id/);
  });

  test("every other original field is preserved: title, created, modified, tags, aliases, linter-yaml-title-alias", () => {
    const zero = standardZeros("06", suffixFor("06")).find((z) => z.id === "01");
    const text = buildZeroFrontmatter(zero, "06", "06 Digital tools", "2026-08-19");
    assert.match(text, /^title: Inbox for category 06$/m);
    assert.match(text, /^created: 2026-08-19$/m);
    assert.match(text, /^modified: 2026-08-19$/m);
    assert.match(text, /^ {2}- jd\/inbox$/m);
    assert.match(text, /^linter-yaml-title-alias: Inbox for category 06$/m);
  });

  test("the 00 zero's aliases include both its own name and the folder name (ported behavior)", () => {
    const zero = standardZeros("06", suffixFor("06")).find((z) => z.id === "00");
    const text = buildZeroFrontmatter(zero, "06", "06 Digital tools", "2026-08-19");
    assert.match(text, /aliases:\n {2}- JDex for category 06\n {2}- 06 Digital tools/);
  });
});

describe("planStandardZeros", () => {
  function input(overrides = {}) {
    return {
      folderPath: "10-19 Personal/06 Digital tools",
      folderName: "06 Digital tools",
      prefix: "06",
      now: "2026-08-19",
      existingPaths: new Set(),
      ...overrides,
    };
  }

  test("no existing files: plans all 10 creates, zero skips", () => {
    const plan = planStandardZeros(input());
    assert.equal(plan.creates.length, 10);
    assert.equal(plan.skipped.length, 0);
  });

  test("hasDir zeros get a nested folder path; hasDir:false zeros sit flat in the category folder", () => {
    const plan = planStandardZeros(input());
    const zeroOne = plan.creates.find((c) => c.path.includes("06.01 "));
    const zeroTwo = plan.creates.find((c) => c.path.includes("06.02 "));
    assert.equal(zeroOne.path, "10-19 Personal/06 Digital tools/06.01 Inbox for category 06/06.01 Inbox for category 06.md");
    assert.equal(zeroTwo.path, "10-19 Personal/06 Digital tools/06.02 Task & project management for category 06.md");
  });

  test("an already-existing target path is SKIPPED, not overwritten", () => {
    const zeroZeroPath = "10-19 Personal/06 Digital tools/06.00 JDex for category 06.md";
    const plan = planStandardZeros(input({ existingPaths: new Set([zeroZeroPath]) }));
    assert.equal(plan.creates.length, 9);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0], zeroZeroPath);
  });

  test("every planned create's content has no jd-id field", () => {
    const plan = planStandardZeros(input());
    for (const c of plan.creates) assert.doesNotMatch(c.content, /jd-id/);
  });
});

describe("planEnsureCategoryIndexes", () => {
  function folder(overrides = {}) {
    return { path: "10-19 Personal/06 Digital tools", name: "06 Digital tools", prefix: "06", childBasenames: [], ...overrides };
  }

  test("a category folder missing its XX.00 gets one planned", () => {
    const plan = planEnsureCategoryIndexes([folder()], "2026-08-19");
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0].path, "10-19 Personal/06 Digital tools/06.00 JDex for category 06.md");
    assert.doesNotMatch(plan.creates[0].content, /jd-id/);
  });

  test("accepts XX.00 Title.md, XX.00.md, and XX.00+SUF Title.md as already-present (ported acceptance rule)", () => {
    for (const existing of ["06.00 Anything.md", "06.00.md", "06.00+SUF Whatever.md"]) {
      const plan = planEnsureCategoryIndexes([folder({ childBasenames: [existing] })], "2026-08-19");
      assert.equal(plan.creates.length, 0, `expected no create when ${existing} already present`);
    }
  });

  test("a misfiled 07.00 inside 06's folder does NOT suppress 06's own index (ported edge case)", () => {
    const plan = planEnsureCategoryIndexes([folder({ childBasenames: ["07.00 Misfiled.md"] })], "2026-08-19");
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0].path, "10-19 Personal/06 Digital tools/06.00 JDex for category 06.md");
  });

  test("multiple folders each get their own independent plan entry", () => {
    const plan = planEnsureCategoryIndexes(
      [folder({ path: "a/06 Foo", name: "06 Foo", prefix: "06" }), folder({ path: "a/07 Bar", name: "07 Bar", prefix: "07" })],
      "2026-08-19"
    );
    assert.equal(plan.creates.length, 2);
  });
});
