import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scanInboxes } from "../src/kernel/scheme/inbox.ts";

describe("scanInboxes", () => {
  test("finds an XX.01 Unsorted folder and counts its direct notes", () => {
    const notes = [
      "20-29 Personal/26 Divorce/26.01 Unsorted/foo.md",
      "20-29 Personal/26 Divorce/26.01 Unsorted/bar.md",
      "20-29 Personal/26 Divorce/26.10 Something/note.md",
    ];
    const groups = scanInboxes(notes);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].area, "20-29 Personal");
    assert.equal(groups[0].items.length, 1);
    assert.deepEqual(groups[0].items[0], {
      category: "26 Divorce",
      inboxFolder: "26.01 Unsorted",
      path: "20-29 Personal/26 Divorce/26.01 Unsorted",
      count: 2,
    });
  });

  test("also recognizes the 'Inbox' title (not just 'Unsorted')", () => {
    const notes = ["00-09 System/03 Agents/03.01 Inbox/a.md"];
    const groups = scanInboxes(notes);
    assert.equal(groups[0].items[0].inboxFolder, "03.01 Inbox");
  });

  test("a title that merely starts with the suffix still counts (prefix match, like the original)", () => {
    const notes = ["00-09 System/03 Agents/03.01 Inbox for the system/a.md"];
    const groups = scanInboxes(notes);
    assert.equal(groups[0].items[0].count, 1);
  });

  test("an id folder whose decimal isn't .01 is not an inbox", () => {
    const notes = ["00-09 System/03 Agents/03.02 Unsorted/a.md"];
    assert.deepEqual(scanInboxes(notes), []);
  });

  test("a .01 folder whose title doesn't start with Unsorted/Inbox is not an inbox", () => {
    const notes = ["00-09 System/03 Agents/03.01 Something Else/a.md"];
    assert.deepEqual(scanInboxes(notes), []);
  });

  test("the folder's own cover note is excluded from the count", () => {
    const notes = [
      "00-09 System/03 Agents/03.01 Inbox/03.01 Inbox.md",
      "00-09 System/03 Agents/03.01 Inbox/real-item.md",
    ];
    const groups = scanInboxes(notes);
    assert.equal(groups[0].items[0].count, 1);
  });

  test("an empty inbox (only its cover note) is omitted entirely", () => {
    const notes = ["00-09 System/03 Agents/03.01 Inbox/03.01 Inbox.md"];
    assert.deepEqual(scanInboxes(notes), []);
  });

  test("a subfolder nested under the inbox counts as ONE item regardless of how many notes are inside it", () => {
    const notes = [
      "00-09 System/03 Agents/03.01 Inbox/Sub/one.md",
      "00-09 System/03 Agents/03.01 Inbox/Sub/two.md",
      "00-09 System/03 Agents/03.01 Inbox/Sub/deeper/three.md",
    ];
    const groups = scanInboxes(notes);
    assert.equal(groups[0].items[0].count, 1);
  });

  test("area must sit at the vault root — an XX-YY-shaped folder nested deeper is not treated as an area", () => {
    const notes = ["00-09 System/20-29 Fake Nested Area/03 Agents/03.01 Unsorted/a.md"];
    // segs = ["00-09 System", "20-29 Fake Nested Area", "03 Agents", "03.01 Unsorted"];
    // segs[0] must be the area — it isn't AREA_RE-shaped alone at position 0 with position 1/2 lining up.
    assert.deepEqual(scanInboxes(notes), []);
  });

  test("busiest-first sort, both across items within an area and across areas", () => {
    const notes = [
      "20-29 Personal/26 Divorce/26.01 Unsorted/a.md",
      "20-29 Personal/27 Other/27.01 Unsorted/a.md",
      "20-29 Personal/27 Other/27.01 Unsorted/b.md",
      "20-29 Personal/27 Other/27.01 Unsorted/c.md",
      "30-39 Work/31 Job/31.01 Unsorted/a.md",
      "30-39 Work/31 Job/31.01 Unsorted/b.md",
    ];
    const groups = scanInboxes(notes);
    // 27 Other (3) beats 26 Divorce (1) within 20-29's own area group.
    assert.equal(groups[0].area, "20-29 Personal");
    assert.deepEqual(
      groups[0].items.map((i) => i.category),
      ["27 Other", "26 Divorce"],
    );
    // 30-39 Work's own busiest (31 Job, 2) is less than 20-29's busiest (27 Other, 3),
    // so 20-29 Personal's group appears first.
    assert.equal(groups[1].area, "30-39 Work");
  });

  test("multiple categories in the same area both surface, each under the shared area group", () => {
    const notes = [
      "00-09 System/01 A/01.01 Unsorted/a.md",
      "00-09 System/02 B/02.01 Unsorted/a.md",
    ];
    const groups = scanInboxes(notes);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 2);
  });

  test("no inboxes at all returns an empty array", () => {
    assert.deepEqual(scanInboxes([]), []);
    assert.deepEqual(scanInboxes(["00-09 System/03 Agents/03.10 Something/a.md"]), []);
  });

  test("a non-markdown-visible attachment sitting directly in the inbox is invisible to the count (documented reduction)", () => {
    // Only the cover note is markdown-visible; the count is 0 and the inbox is omitted,
    // even though a real (non-.md) attachment might genuinely sit in the folder.
    const notes = ["00-09 System/03 Agents/03.01 Inbox/03.01 Inbox.md"];
    assert.deepEqual(scanInboxes(notes), []);
  });

  test("a dot-prefixed name in the inbox is excluded from the count, matching the original", () => {
    const notes = [
      "00-09 System/03 Agents/03.01 Inbox/.hidden.md",
      "00-09 System/03 Agents/03.01 Inbox/real.md",
    ];
    const groups = scanInboxes(notes);
    assert.equal(groups[0].items[0].count, 1);
  });

  test("a +README leftover in the inbox is excluded from the count, matching the original", () => {
    const notes = [
      "00-09 System/03 Agents/03.01 Inbox/+README.md",
      "00-09 System/03 Agents/03.01 Inbox/real.md",
    ];
    const groups = scanInboxes(notes);
    assert.equal(groups[0].items[0].count, 1);
  });

  test("an inbox with only dot-files/+README (nothing real) is omitted entirely", () => {
    const notes = [
      "00-09 System/03 Agents/03.01 Inbox/03.01 Inbox.md",
      "00-09 System/03 Agents/03.01 Inbox/.hidden.md",
      "00-09 System/03 Agents/03.01 Inbox/+README.md",
    ];
    assert.deepEqual(scanInboxes(notes), []);
  });
});
