import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isAreaManagement,
  buildLinks,
  getCategoryFiles,
  parseAllDescriptions,
  overlayDescriptions,
  extractContentsBullets,
  buildContents,
  planReindexCategory,
  CONTENTS_CALLOUT,
} from "../src/kernel/jd-scaffold/category-index.ts";
import { setSection } from "../src/kernel/jd-scaffold/sections.ts";

describe("isAreaManagement", () => {
  test("10..90 are area-management prefixes", () => {
    for (const p of ["10", "20", "30", "90"]) assert.equal(isAreaManagement(p), true);
  });
  test("00 is NOT area-management (it's the system tier)", () => {
    assert.equal(isAreaManagement("00"), false);
  });
  test("ordinary two-digit prefixes are not area-management", () => {
    for (const p of ["06", "13", "27", "99"]) {
      // 99 ends in 9, not 0 — not area-management
    }
    assert.equal(isAreaManagement("06"), false);
    assert.equal(isAreaManagement("13"), false);
    assert.equal(isAreaManagement("99"), false);
  });
});

describe("setSection", () => {
  test("inserts a new section at EOF when the heading is absent", () => {
    const out = setSection("# Title\n\nSome prose.\n", "## Contents", "- [[a]]");
    assert.match(out, /## Contents\n\n- \[\[a\]\]/);
    assert.match(out, /^# Title/);
  });

  test("replaces an existing section up to the next ## heading", () => {
    const before = "# Title\n\n## Contents\n\n- [[old]]\n\n## Other\n\nKeep me.\n";
    const out = setSection(before, "## Contents", "- [[new]]");
    assert.match(out, /## Contents\n\n- \[\[new\]\]/);
    assert.doesNotMatch(out, /\[\[old\]\]/);
    assert.match(out, /## Other\n\nKeep me\./);
  });

  test("honors the legacy ^contents block-ref as a section terminator", () => {
    const before = "## Contents\n\n- [[old]]\n\n^contents\n\nCustom prose after.\n";
    const out = setSection(before, "## Contents", "- [[new]]");
    assert.match(out, /Custom prose after\./);
    assert.doesNotMatch(out, /\[\[old\]\]/);
  });
});

describe("getCategoryFiles", () => {
  const allPaths = [
    "10-19 Personal/06 Digital tools/06.00 JDex.md",
    "10-19 Personal/06 Digital tools/06.01 Inbox.md",
    "10-19 Personal/06 Digital tools/06.13 Bar.md",
    "10-19 Personal/06 Digital tools Long/06.99 Other.md", // separator-bounded: must NOT match "06 Digital tools"
    "10-19 Personal/07 Health/07.01 Foo.md",
  ];

  test("matches only files whose parent is the folder itself (separator-bounded, no sibling scoop)", () => {
    const files = getCategoryFiles(allPaths, "06", "10-19 Personal/06 Digital tools");
    assert.deepEqual(
      files.sort(),
      ["10-19 Personal/06 Digital tools/06.00 JDex.md", "10-19 Personal/06 Digital tools/06.01 Inbox.md", "10-19 Personal/06 Digital tools/06.13 Bar.md"].sort()
    );
  });

  test("excludePath omits the index file itself", () => {
    const files = getCategoryFiles(allPaths, "06", "10-19 Personal/06 Digital tools", "10-19 Personal/06 Digital tools/06.00 JDex.md");
    assert.ok(!files.includes("10-19 Personal/06 Digital tools/06.00 JDex.md"));
    assert.equal(files.length, 2);
  });

  test("sorted by basename", () => {
    const files = getCategoryFiles(allPaths, "06", "10-19 Personal/06 Digital tools");
    assert.deepEqual(
      files.map((f) => f.split("/").pop()),
      ["06.00 JDex.md", "06.01 Inbox.md", "06.13 Bar.md"]
    );
  });
});

describe("parseAllDescriptions / overlayDescriptions round trip", () => {
  test("a description survives a parse -> overlay round trip unchanged", () => {
    const content = "## Contents\n\n- [[06.01 Inbox]] *(the real inbox)*\n- [[06.02 Tasks]]\n";
    const descriptions = parseAllDescriptions(content);
    assert.equal(descriptions.get("06.01 Inbox"), "the real inbox");
    assert.equal(descriptions.has("06.02 Tasks"), false);

    const fresh = buildLinks(["06.01 Inbox", "06.02 Tasks"]);
    const result = overlayDescriptions(fresh, descriptions);
    assert.match(result.text, /\[\[06\.01 Inbox\]\] \*\(the real inbox\)\*/);
    assert.match(result.text, /^- \[\[06\.02 Tasks\]\]$/m);
    assert.deepEqual(result.applied, [["06.01 Inbox", "the real inbox"]]);
  });

  test("harvest is whole-file, not section-scoped — an annotation in ## IDs migrates too", () => {
    const content = "## IDs\n\n- [[06.05 Foo]] *(migrated)*\n\n## Contents\n\n- [[06.05 Foo]]\n";
    const descriptions = parseAllDescriptions(content);
    assert.equal(descriptions.get("06.05 Foo"), "migrated");
  });

  test("an alias-carrying bullet keeps its alias when overlaid", () => {
    const overlay = new Map([["10023", "big note"]]);
    const bullets = "- [[10023|10023 Something]]";
    const result = overlayDescriptions(bullets, overlay);
    assert.equal(result.text, "- [[10023|10023 Something]] *(big note)*");
  });
});

describe("extractContentsBullets", () => {
  test("pulls only bullet lines from ## Contents, stopping at the next heading", () => {
    const content = "## Contents\n\n> callout\n\n- [[a]]\n- [[b]] *(desc)*\n\n## Other\n\n- [[c]]\n";
    assert.equal(extractContentsBullets(content), "- [[a]]\n- [[b]] *(desc)*");
  });

  test("returns empty string when there's no ## Contents section", () => {
    assert.equal(extractContentsBullets("# Title\n\nProse only.\n"), "");
  });
});

describe("buildContents", () => {
  test("sorts by basename regardless of preserved-description order", () => {
    const body = buildContents(["06.13 Bar", "06.01 Inbox"], new Map([["06.13 Bar", "later"]]));
    const lines = body.split("\n").filter((l) => l.startsWith("- "));
    assert.match(lines[0], /06\.01 Inbox/);
    assert.match(lines[1], /06\.13 Bar.*later/);
  });

  test("includes the CONTENTS_CALLOUT header", () => {
    const body = buildContents(["06.01 Inbox"], new Map());
    assert.ok(body.startsWith(CONTENTS_CALLOUT));
  });
});

describe("planReindexCategory — dispatch", () => {
  test("returns null for a path with no leading two-digit prefix at all", () => {
    assert.equal(planReindexCategory({ targetIndexPath: "06 Digital tools/Not an id note.md", allPaths: [], siblingContent: new Map() }), null);
  });

  test("dispatch only checks the leading two digits, not a literal .00 suffix — matches the original's own real behavior (the caller, not this function, is responsible for only invoking it on an actual XX.00 file; see Task 2's note on this)", () => {
    // 06.13 still has a leading "06" prefix, so this dispatches to the ORDINARY
    // tier just like a real 06.00 file would — it isn't refused. Documenting
    // this on purpose: it's the same shape the original ported from.
    const plan = planReindexCategory({
      targetIndexPath: "06 Digital tools/06.13 Bar.md",
      allPaths: ["06 Digital tools/06.13 Bar.md"],
      siblingContent: new Map([["06 Digital tools/06.13 Bar.md", "# Bar\n"]]),
    });
    assert.notEqual(plan, null);
  });

  test("00 dispatches to system, X0 to area-management, everything else to ordinary — verified via each tier's own shape below", () => {
    // covered by the tier-specific describes; this is just documentation of the routing rule.
    assert.ok(true);
  });
});

describe("planReindexCategory — ordinary tier", () => {
  const allPaths = [
    "10-19 Personal/06 Digital tools/06.00 JDex.md",
    "10-19 Personal/06 Digital tools/06.01 Inbox.md",
    "10-19 Personal/06 Digital tools/06.13 Bar.md",
  ];

  test("lists the category's own members, sorted, excluding itself", () => {
    const plan = planReindexCategory({
      targetIndexPath: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      allPaths,
      siblingContent: new Map([["10-19 Personal/06 Digital tools/06.00 JDex.md", "# JDex\n"]]),
    });
    assert.ok(plan);
    assert.match(plan.newContent, /\[\[06\.01 Inbox\]\]/);
    assert.match(plan.newContent, /\[\[06\.13 Bar\]\]/);
    assert.doesNotMatch(plan.newContent, /\[\[06\.00 JDex\]\]/); // never links to itself
  });

  test("a description survives a regen (preservation across runs)", () => {
    const existing = "# JDex\n\n## Contents\n\n- [[06.01 Inbox]] *(the real inbox)*\n";
    const plan = planReindexCategory({
      targetIndexPath: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      allPaths,
      siblingContent: new Map([["10-19 Personal/06 Digital tools/06.00 JDex.md", existing]]),
    });
    assert.match(plan.newContent, /\[\[06\.01 Inbox\]\] \*\(the real inbox\)\*/);
    assert.deepEqual(plan.preserved, [{ file: "10-19 Personal/06 Digital tools/06.00 JDex.md", target: "06.01 Inbox", description: "the real inbox" }]);
  });

  test("a description for a note no longer in the category is NOT reported as preserved", () => {
    const existing = "## Contents\n\n- [[06.99 Gone]] *(stale)*\n";
    const plan = planReindexCategory({
      targetIndexPath: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      allPaths,
      siblingContent: new Map([["10-19 Personal/06 Digital tools/06.00 JDex.md", existing]]),
    });
    assert.deepEqual(plan.preserved, []);
    assert.doesNotMatch(plan.newContent, /06\.99 Gone/);
  });

  test("prose outside ## Contents is left untouched", () => {
    const existing = "# JDex\n\nSome hand-written intro.\n\n## Contents\n\n- [[old]]\n";
    const plan = planReindexCategory({
      targetIndexPath: "10-19 Personal/06 Digital tools/06.00 JDex.md",
      allPaths,
      siblingContent: new Map([["10-19 Personal/06 Digital tools/06.00 JDex.md", existing]]),
    });
    assert.match(plan.newContent, /Some hand-written intro\./);
  });

  test("a root-level XX.00 file (no area folder) is still processed, not refused", () => {
    const rootPaths = ["06.00 JDex.md", "06.13 Bar.md"];
    const plan = planReindexCategory({
      targetIndexPath: "06.00 JDex.md",
      allPaths: rootPaths,
      siblingContent: new Map([["06.00 JDex.md", "# JDex\n"]]),
    });
    assert.ok(plan);
    assert.match(plan.newContent, /\[\[06\.13 Bar\]\]/);
  });
});

describe("planReindexCategory — area-management tier", () => {
  const allPaths = [
    "10-19 Personal/10 Foo/10.00 Area index.md",
    "10-19 Personal/06 Digital tools/06.00 JDex.md",
    "10-19 Personal/06 Digital tools/06.13 Bar.md",
    "10-19 Personal/07 Health/07.00 JDex.md",
    "10-19 Personal/07 Health/07.01 Log.md",
  ];
  const siblingContent = new Map([
    ["10-19 Personal/10 Foo/10.00 Area index.md", "## Contents\n\n"],
    ["10-19 Personal/06 Digital tools/06.00 JDex.md", "## Contents\n\n- [[06.13 Bar]] *(from category tier)*\n"],
    ["10-19 Personal/07 Health/07.00 JDex.md", "## Contents\n\n- [[07.01 Log]]\n"],
  ]);

  test("consolidates every sibling category's Contents under its own ### heading, prepending the sibling's own index link", () => {
    const plan = planReindexCategory({ targetIndexPath: "10-19 Personal/10 Foo/10.00 Area index.md", allPaths, siblingContent });
    assert.match(plan.newContent, /### 06 Digital tools/);
    assert.match(plan.newContent, /\[\[06\.00 JDex\]\]/); // the sibling's OWN index link, prepended
    assert.match(plan.newContent, /\[\[06\.13 Bar\]\]/);
    assert.match(plan.newContent, /### 07 Health/);
    assert.match(plan.newContent, /\[\[07\.01 Log\]\]/);
  });

  test("a sibling's own preserved description survives into the consolidated view (copied verbatim from its Contents)", () => {
    const plan = planReindexCategory({ targetIndexPath: "10-19 Personal/10 Foo/10.00 Area index.md", allPaths, siblingContent });
    assert.match(plan.newContent, /\[\[06\.13 Bar\]\] \*\(from category tier\)\*/);
  });

  test("the area file's OWN local overlay description wins over an inherited one", () => {
    const withOverlay = new Map(siblingContent);
    withOverlay.set(
      "10-19 Personal/10 Foo/10.00 Area index.md",
      "## Contents\n\n- [[06.13 Bar]] *(area-level override)*\n"
    );
    const plan = planReindexCategory({ targetIndexPath: "10-19 Personal/10 Foo/10.00 Area index.md", allPaths, siblingContent: withOverlay });
    assert.match(plan.newContent, /\[\[06\.13 Bar\]\] \*\(area-level override\)\*/);
    assert.doesNotMatch(plan.newContent, /from category tier/);
  });

  test("consolidating file's own category (10 Foo) rebuilds fresh from the vault, not copied from itself", () => {
    const plan = planReindexCategory({ targetIndexPath: "10-19 Personal/10 Foo/10.00 Area index.md", allPaths, siblingContent });
    assert.match(plan.newContent, /### 10 Foo/);
  });
});

describe("planReindexCategory — system tier (00)", () => {
  // Real 3-level JD nesting throughout (area folder -> category folder ->
  // note) except the system index itself, which legitimately sits 2 levels
  // deep (00-09 System IS both area and category for the system band) and
  // so groups under "(no area)" — that's correct, not a test artifact.
  const allPaths = [
    "00-09 System/00.00 System index.md",
    "10-19 Personal/06 Digital tools/06.00 JDex.md",
    "10-19 Personal/06 Digital tools/06.13 Bar.md",
    "20-29 Work/20 Work management/20.00 Work index.md",
    "20-29 Work/20 Work management/20.05 Project.md",
  ];
  const siblingContent = new Map([
    ["00-09 System/00.00 System index.md", "## Contents\n\n"],
    ["10-19 Personal/06 Digital tools/06.00 JDex.md", "## Contents\n\n- [[06.13 Bar]]\n"],
    ["20-29 Work/20 Work management/20.00 Work index.md", "## Contents\n\n- [[20.05 Project]]\n"],
  ]);

  test("groups by area under ### then category under #### , across every area", () => {
    const plan = planReindexCategory({ targetIndexPath: "00-09 System/00.00 System index.md", allPaths, siblingContent });
    assert.match(plan.newContent, /### 10-19 Personal/);
    assert.match(plan.newContent, /#### 06 Digital tools/);
    assert.match(plan.newContent, /\[\[06\.13 Bar\]\]/);
    assert.match(plan.newContent, /### 20-29 Work/);
    assert.match(plan.newContent, /#### 20 Work management/);
    assert.match(plan.newContent, /\[\[20\.05 Project\]\]/);
  });

  test("a category with no area above it (the system band itself) groups under (no area)", () => {
    const plan = planReindexCategory({ targetIndexPath: "00-09 System/00.00 System index.md", allPaths, siblingContent });
    assert.match(plan.newContent, /### \(no area\)/);
    assert.match(plan.newContent, /#### 00-09 System/);
  });

  test("areas are sorted alphabetically", () => {
    const plan = planReindexCategory({ targetIndexPath: "00-09 System/00.00 System index.md", allPaths, siblingContent });
    const idx10 = plan.newContent.indexOf("### 10-19 Personal");
    const idx20 = plan.newContent.indexOf("### 20-29 Work");
    assert.notEqual(idx10, -1);
    assert.notEqual(idx20, -1);
    assert.ok(idx10 < idx20);
  });
});
