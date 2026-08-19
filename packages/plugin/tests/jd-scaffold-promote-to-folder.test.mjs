import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planPromoteToFolder } from "../src/kernel/jd-scaffold/promote-to-folder.ts";

describe("planPromoteToFolder", () => {
  // existingPaths is this test file's own convenience shape; planPromoteToFolder
  // itself takes an `exists` predicate over the single computed folder path
  // (see types.ts's own comment).
  function input({ existingPaths = new Set(["06 Digital tools/06.13 Bar.md"]), ...overrides } = {}) {
    return {
      path: "06 Digital tools/06.13 Bar.md",
      exists: (p) => existingPaths.has(p),
      ...overrides,
    };
  }

  test("happy path — XX.YY note in a folder promotes cleanly", () => {
    const plan = planPromoteToFolder(input());
    assert.equal(plan.ok, true);
    assert.equal(plan.folderPath, "06 Digital tools/06.13 Bar");
    assert.equal(plan.newFilePath, "06 Digital tools/06.13 Bar/06.13 Bar.md");
  });

  test("also accepts the 5-digit expanded-area id form", () => {
    const plan = planPromoteToFolder(input({ path: "10000-19999 Big area/10023 Something.md", existingPaths: new Set(["10000-19999 Big area/10023 Something.md"]) }));
    assert.equal(plan.ok, true);
    assert.equal(plan.folderPath, "10000-19999 Big area/10023 Something");
  });

  test("a root-level note (no parent folder segment) promotes with the folder at vault root", () => {
    const plan = planPromoteToFolder(input({ path: "06.13 Bar.md", existingPaths: new Set(["06.13 Bar.md"]) }));
    assert.equal(plan.ok, true);
    assert.equal(plan.folderPath, "06.13 Bar");
    assert.equal(plan.newFilePath, "06.13 Bar/06.13 Bar.md");
  });

  test("refuses a basename that isn't XX.YY or a 5-digit id", () => {
    const plan = planPromoteToFolder(input({ path: "06 Digital tools/Not an id note.md" }));
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "not_id_note");
  });

  test("refuses when the note is already its folder's cover note", () => {
    const plan = planPromoteToFolder(input({ path: "06 Digital tools/06.13 Bar/06.13 Bar.md", existingPaths: new Set(["06 Digital tools/06.13 Bar/06.13 Bar.md"]) }));
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "already_cover_note");
  });

  test("refuses when the destination folder already exists", () => {
    const plan = planPromoteToFolder(input({ existingPaths: new Set(["06 Digital tools/06.13 Bar.md", "06 Digital tools/06.13 Bar"]) }));
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "folder_exists");
  });
});
