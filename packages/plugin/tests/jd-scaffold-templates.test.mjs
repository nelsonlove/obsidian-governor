import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scopeFor,
  buildContext,
  substitute,
  classifyTemplates,
  findZeroTemplate,
  findStemTemplate,
  findGenericTemplate,
  listStemCodes,
  sanitizeTitle,
  destPathForZero,
  destPathForStem,
  destPathForGenericId,
  findCategoryFolder,
  existingZeroIds,
  extractJdId,
} from "../src/kernel/jd-scaffold/templates.ts";

describe("scopeFor", () => {
  test("00 is the system", () => {
    assert.equal(scopeFor("00"), "the system");
  });
  test("X0 is an area", () => {
    assert.equal(scopeFor("10"), "area 10-19");
    assert.equal(scopeFor("70"), "area 70-79");
  });
  test("everything else is a plain category", () => {
    assert.equal(scopeFor("06"), "category 06");
    assert.equal(scopeFor("27"), "category 27");
  });
});

describe("buildContext", () => {
  test("ordinary id: fullId is prefix.id", () => {
    const ctx = buildContext({ prefix: "06", id: "13", folder: { path: "10-19 Personal/06 Digital tools", name: "06 Digital tools" }, customTitle: "Bar" });
    assert.equal(ctx.fullId, "06.13");
    assert.equal(ctx.title, "Bar");
    assert.equal(ctx.scope, "category 06");
  });

  test("stem id (starts with +): fullId is prefix.00+code", () => {
    const ctx = buildContext({ prefix: "06", id: "+DRAFT", folder: { path: "06 Digital tools", name: "06 Digital tools" } });
    assert.equal(ctx.fullId, "06.00+DRAFT");
  });

  test("zero spec supplies title/tag defaults, customTitle overrides", () => {
    const zero = { id: "01", name: "Inbox", tag: "jd/inbox", hasDir: true };
    const ctx1 = buildContext({ prefix: "06", id: "01", folder: { path: "x", name: "x" }, zero });
    assert.equal(ctx1.title, "Inbox");
    assert.equal(ctx1.tag, "jd/inbox");
    const ctx2 = buildContext({ prefix: "06", id: "01", folder: { path: "x", name: "x" }, zero, customTitle: "Override" });
    assert.equal(ctx2.title, "Override");
  });

  test("date/time/now default to empty strings when not injected", () => {
    const ctx = buildContext({ prefix: "06", id: "13", folder: { path: "x", name: "x" } });
    assert.equal(ctx.date, "");
    assert.equal(ctx.time, "");
    assert.equal(ctx.now, "");
  });
});

describe("substitute", () => {
  const ctx = buildContext({
    prefix: "06", id: "13", folder: { path: "10-19 Personal/06 Digital tools", name: "06 Digital tools" },
    customTitle: "Bar", date: "2026-08-19", time: "10:30", now: "2026-08-19T10:30",
  });

  test("{{var}} and %var% both substitute", () => {
    const r = substitute("Title: {{title}}, Tag: %tag%", { ...ctx, tag: "jd/foo" });
    assert.equal(r.text, "Title: Bar, Tag: jd/foo");
  });

  test("category is an alias for prefix", () => {
    const r = substitute("{{category}}", ctx);
    assert.equal(r.text, "06");
  });

  test("fullId / full-id both work", () => {
    assert.equal(substitute("{{fullId}}", ctx).text, "06.13");
    assert.equal(substitute("{{full-id}}", ctx).text, "06.13");
  });

  test("fixed-format date/time/now substitute from the injected context", () => {
    const r = substitute("{{date}} {{time}} {{now}}", ctx);
    assert.equal(r.text, "2026-08-19 10:30 2026-08-19T10:30");
  });

  test("an unknown placeholder is left as-is and reported in warnings", () => {
    const r = substitute("{{nonsense}}", ctx);
    assert.equal(r.text, "{{nonsense}}");
    assert.deepEqual(r.warnings, ["nonsense"]);
  });

  test("no warnings when every placeholder resolves", () => {
    const r = substitute("{{title}}", ctx);
    assert.deepEqual(r.warnings, []);
  });

  test("review fix: a %-shaped substring in a substituted VALUE is not re-substituted by the other dialect", () => {
    // Regression for the cross-dialect bug: two sequential .replace() passes
    // used to let the SECOND pass (%var%) re-scan the FIRST pass's ({{var}})
    // own output. A title containing a literal "%tag%" substring must stay
    // literal — it came from a caller-supplied VALUE, not template authorship.
    const r = substitute("# {{title}}", { ...ctx, title: "Q1 %tag% Report", tag: "jd/should-not-appear" });
    assert.equal(r.text, "# Q1 %tag% Report");
    assert.doesNotMatch(r.text, /jd\/should-not-appear/);
  });

  test("review fix: the reverse direction also holds — a {{-shaped substring in a %-substituted value stays literal", () => {
    const r = substitute("# %title%", { ...ctx, title: "Q1 {{tag}} Report", tag: "jd/should-not-appear" });
    assert.equal(r.text, "# Q1 {{tag}} Report");
  });
});

describe("classifyTemplates", () => {
  test("classifies a zero template", () => {
    const { matches, skipped } = classifyTemplates([{ path: "Templates/inbox.md", jdId: "{{category}}.01" }]);
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].role, { type: "zero", zeroId: "01" });
    assert.deepEqual(skipped, []);
  });

  test("classifies a stem template", () => {
    const { matches } = classifyTemplates([{ path: "Templates/draft.md", jdId: "XX.00+DRAFT" }]);
    assert.deepEqual(matches[0].role, { type: "stem", stemCode: "DRAFT" });
  });

  test("classifies a generic id template", () => {
    const { matches } = classifyTemplates([{ path: "Templates/generic.md", jdId: "{{category}}.{{id}}" }]);
    assert.deepEqual(matches[0].role, { type: "generic" });
  });

  test("a jd-id of .10+ is not a valid zero (only 00-09 are)", () => {
    const { matches, skipped } = classifyTemplates([{ path: "Templates/bad.md", jdId: "{{category}}.10" }]);
    assert.equal(matches.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /Templates\/bad\.md/);
  });

  test("a file with no jd-id at all is silently skipped, not reported", () => {
    const { matches, skipped } = classifyTemplates([{ path: "Templates/unrelated.md", jdId: null }]);
    assert.equal(matches.length, 0);
    assert.deepEqual(skipped, []);
  });

  test("an unrecognized jd-id shape is reported in skipped", () => {
    const { skipped } = classifyTemplates([{ path: "Templates/weird.md", jdId: "not-a-real-shape" }]);
    assert.equal(skipped.length, 1);
  });
});

describe("findZeroTemplate / findStemTemplate / findGenericTemplate / listStemCodes", () => {
  const { matches } = classifyTemplates([
    { path: "Templates/inbox.md", jdId: "{{category}}.01" },
    { path: "Templates/draft.md", jdId: "XX.00+DRAFT" },
    { path: "Templates/note.md", jdId: "XX.00+NOTE" },
    { path: "Templates/generic.md", jdId: "{{category}}.{{id}}" },
  ]);

  test("findZeroTemplate finds by zero id", () => {
    assert.equal(findZeroTemplate(matches, "01").path, "Templates/inbox.md");
    assert.equal(findZeroTemplate(matches, "02"), null);
  });

  test("findStemTemplate finds by stem code", () => {
    assert.equal(findStemTemplate(matches, "DRAFT").path, "Templates/draft.md");
  });

  test("findGenericTemplate finds the one generic template", () => {
    assert.equal(findGenericTemplate(matches).path, "Templates/generic.md");
  });

  test("listStemCodes returns every stem code, sorted", () => {
    assert.deepEqual(listStemCodes(matches), ["DRAFT", "NOTE"]);
  });
});

describe("sanitizeTitle", () => {
  test("accepts an ordinary title, trimmed", () => {
    assert.equal(sanitizeTitle("  Config files  "), "Config files");
  });
  test("rejects empty/whitespace-only", () => {
    assert.equal(sanitizeTitle("   "), null);
  });
  test("rejects a leading dot", () => {
    assert.equal(sanitizeTitle(".hidden"), null);
  });
  test("rejects a .. substring", () => {
    assert.equal(sanitizeTitle("a..b"), null);
  });
  test("rejects path separators and Windows-forbidden characters", () => {
    for (const bad of ["a/b", "a\\b", "a:b", "a|b", "a?b", "a*b", "a<b", 'a"b']) {
      assert.equal(sanitizeTitle(bad), null, `expected ${bad} to be rejected`);
    }
  });
  test("does NOT reject a non-leading dot", () => {
    assert.equal(sanitizeTitle("foo.v2"), "foo.v2");
  });
});

describe("destPathForZero / destPathForStem / destPathForGenericId", () => {
  test("destPathForZero: hasDir true nests in its own folder", () => {
    const zero = { id: "01", name: "Inbox", tag: "jd/inbox", hasDir: true };
    assert.equal(destPathForZero("10-19 Personal/06 Digital tools", "06", zero), "10-19 Personal/06 Digital tools/06.01 Inbox/06.01 Inbox.md");
  });
  test("destPathForZero: hasDir false sits flat", () => {
    const zero = { id: "02", name: "Task & project management", tag: "jd/tasks", hasDir: false };
    assert.equal(destPathForZero("06 Digital tools", "06", zero), "06 Digital tools/06.02 Task & project management.md");
  });
  test("destPathForStem", () => {
    assert.equal(destPathForStem("06 Digital tools", "06", "DRAFT", "Session directives"), "06 Digital tools/06.00+DRAFT Session directives.md");
  });
  test("destPathForGenericId", () => {
    assert.equal(destPathForGenericId("06 Digital tools", "06", "13", "Bar"), "06 Digital tools/06.13 Bar.md");
  });
});

describe("findCategoryFolder", () => {
  test("finds the nearest ancestor folder matching 'XX name'", () => {
    const cat = findCategoryFolder("10-19 Personal/06 Digital tools/Subfolder/note.md");
    assert.deepEqual(cat, { folderPath: "10-19 Personal/06 Digital tools", prefix: "06" });
  });
  test("finds it when the note is a direct child", () => {
    const cat = findCategoryFolder("10-19 Personal/06 Digital tools/06.13 Bar.md");
    assert.deepEqual(cat, { folderPath: "10-19 Personal/06 Digital tools", prefix: "06" });
  });
  test("returns null when no ancestor matches", () => {
    assert.equal(findCategoryFolder("Random Folder/note.md"), null);
  });
  test("returns null for a root-level note", () => {
    assert.equal(findCategoryFolder("note.md"), null);
  });
});

describe("existingZeroIds", () => {
  // existingZeroIds' actual contract (matching the original faithfully): it
  // extracts ANY two-digit code directly after "<prefix>." with a valid
  // boundary character following it (space/./+/end) — it does NOT itself
  // validate the code is one of the 10 real zero slots (00-09). That
  // validation happens at the CALL SITE (ZeroPickerModal cross-references
  // against standardZeros()'s own fixed id set) — "13" being present in this
  // function's output is harmless there since no zero spec has id "13" to
  // match against. Kept faithful to the original rather than "fixed" to be
  // stricter than its real, working behavior.
  test("finds two-digit codes with a valid boundary character following them", () => {
    const ids = existingZeroIds(["06.00 JDex.md", "06.01 Inbox", "06.13 Bar.md", "Not a zero.md"], "06");
    assert.deepEqual([...ids].sort(), ["00", "01", "13"]);
  });
  test("a stem-suffixed zero-shaped name still counts (06.00+DRAFT)", () => {
    const ids = existingZeroIds(["06.00+DRAFT Something.md"], "06");
    assert.ok(ids.has("00"));
  });
  test("a non-digit right after the prefix is excluded (boundary check on the CODE itself, not just what follows it)", () => {
    const ids = existingZeroIds(["06.ab Something.md"], "06");
    assert.equal(ids.size, 0);
  });
});

describe("extractJdId", () => {
  test("extracts a double-quoted value", () => {
    assert.equal(extractJdId('---\ntitle: Foo\njd-id: "{{category}}.01"\n---\n\nBody\n'), "{{category}}.01");
  });
  test("extracts a single-quoted value", () => {
    assert.equal(extractJdId("---\njd-id: 'XX.00+DRAFT'\n---\n"), "XX.00+DRAFT");
  });
  test("extracts an unquoted value", () => {
    assert.equal(extractJdId("---\njd-id: {{category}}.{{id}}\n---\n"), "{{category}}.{{id}}");
  });
  test("returns null when there's no frontmatter at all", () => {
    assert.equal(extractJdId("# Title\n\njd-id: not-really-frontmatter\n"), null);
  });
  test("returns null when frontmatter has no jd-id field", () => {
    assert.equal(extractJdId("---\ntitle: Foo\n---\n"), null);
  });
  test("a jd-id-shaped line in the BODY is never matched (scoped to the frontmatter block only)", () => {
    const content = "---\ntitle: Foo\n---\n\nSome text.\n\njd-id: {{category}}.99\n";
    assert.equal(extractJdId(content), null);
  });
});
