/**
 * read-path-recognizer.test.ts — issue #150: the READ/INDEX paths must
 * recognize frontmatter wherever the vault does.
 *
 * This is the non-security half of #126's class. A guard that recognizes less
 * than the vault is a bypass; a *reader* that recognizes less is a silent
 * mis-read — the note's frontmatter is scanned as though it were prose. The
 * symptoms are quiet and easy to blame on the note:
 *
 *   - `parseAllFrontmatter` — the note indexes with NO frontmatter, so every
 *     `searchByFrontmatter` / alias / JD-id lookup misses it;
 *   - `parseOutlinks` — the fence is not stripped, so a `[[link]]` sitting in
 *     a frontmatter value is indexed as a real body outlink;
 *   - `extractTags` — `tags:` is never seen, so the note drops out of tag
 *     queries entirely.
 *
 * Each test therefore asserts the OBSERVABLE read result on an odd-byte note,
 * not merely that some recognizer was called. Every case pairs an ordinary
 * note with its BOM / CRLF / trailing-whitespace twin and demands the same
 * answer: the bytes differ, the reading must not.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAllFrontmatter, parseOutlinks } from "../src/fs-backend/index-store.js";
import { stripLeadingFrontmatter, leadingFrontmatterBlock } from "../src/accept-guard.js";

const BOM = "﻿";

/** The same note, spelled four ways the vault treats identically. */
function variants(fm: string, body: string): Array<[string, string]> {
  return [
    ["plain", `---\n${fm}\n---\n${body}`],
    ["leading BOM", `${BOM}---\n${fm}\n---\n${body}`],
    ["CRLF", `---\r\n${fm.replace(/\n/g, "\r\n")}\r\n---\r\n${body}`],
    ["trailing fence whitespace", `--- \n${fm}\n--- \n${body}`],
    ["BOM + CRLF", `${BOM}---\r\n${fm.replace(/\n/g, "\r\n")}\r\n---\r\n${body}`],
  ];
}

describe("#150 — parseAllFrontmatter reads odd-byte notes identically", () => {
  for (const [name, text] of variants("title: Note\naliases: [A, B]", "body text\n")) {
    test(`indexes frontmatter — ${name}`, () => {
      const fm = parseAllFrontmatter(text);
      assert.equal(fm.title, "Note", "a note that indexes with no frontmatter is invisible to every frontmatter query");
      assert.deepEqual(fm.aliases, ["A", "B"]);
    });
  }

  test("CRLF values carry no trailing \\r into the index", () => {
    // Recognizing a CRLF fence buys nothing if every value is then stored with
    // a stray \r — the lookup key would never match a caller's plain string.
    const fm = parseAllFrontmatter("---\r\ntitle: Note\r\nuid: abc-123\r\n---\r\nbody");
    assert.equal(fm.title, "Note");
    assert.equal(fm.uid, "abc-123");
    for (const v of Object.values(fm)) {
      if (typeof v === "string") assert.ok(!v.includes("\r"), `value carries a CR: ${JSON.stringify(v)}`);
    }
  });

  test("block-array values survive CRLF", () => {
    const fm = parseAllFrontmatter("---\r\naliases:\r\n  - One\r\n  - Two\r\n---\r\nbody");
    assert.deepEqual(fm.aliases, ["One", "Two"]);
  });

  test("a note with no frontmatter still reads as none", () => {
    assert.deepEqual(parseAllFrontmatter("just prose\n\nmore prose"), {});
    assert.deepEqual(parseAllFrontmatter(`${BOM}just prose`), {});
  });
});

describe("#150 — parseOutlinks strips the fence it should", () => {
  for (const [name, text] of variants("title: Note\nsource: \"[[Not A Body Link]]\"", "see [[Real Link]] here\n")) {
    test(`indexes body links only — ${name}`, () => {
      const links = parseOutlinks(text);
      assert.deepEqual(links, ["Real Link"], "a frontmatter link indexed as a body outlink is a fabricated edge");
    });
  }

  test("body links are still found when there is no frontmatter", () => {
    assert.deepEqual(parseOutlinks("see [[Real Link]] here"), ["Real Link"]);
  });

  test("code fences are still excluded (pre-existing behavior preserved)", () => {
    const text = "---\ntitle: N\n---\nreal [[Kept]]\n\n```\n[[InCode]]\n```\n";
    assert.deepEqual(parseOutlinks(text), ["Kept"]);
  });
});

describe("#150 — stripLeadingFrontmatter is the reader's half of the one recognizer", () => {
  test("removes the fence, and the BOM with it", () => {
    assert.equal(stripLeadingFrontmatter(`${BOM}---\na: 1\n---\nbody`), "body");
    assert.equal(stripLeadingFrontmatter("---\r\na: 1\r\n---\r\nbody"), "body");
    assert.equal(stripLeadingFrontmatter("--- \na: 1\n--- \nbody"), "body");
  });

  test("passes through text that has no leading fence", () => {
    assert.equal(stripLeadingFrontmatter("just prose"), "just prose");
    assert.equal(stripLeadingFrontmatter(`${BOM}just prose`), "just prose", "the BOM is never body content");
    // An embedded fence is not LEADING frontmatter and must survive.
    assert.equal(stripLeadingFrontmatter("intro\n---\na: 1\n---\n"), "intro\n---\na: 1\n---\n");
  });

  test("agrees with leadingFrontmatterBlock on what counts as a fence", () => {
    // The two halves must never disagree: if one sees a fence, the other must
    // remove exactly that fence.
    for (const [, text] of variants("a: 1", "body")) {
      assert.notEqual(leadingFrontmatterBlock(text), null);
      assert.equal(stripLeadingFrontmatter(text), "body");
    }
    for (const text of ["just prose", `${BOM}prose`, "----\na: 1\n---\n"]) {
      assert.equal(leadingFrontmatterBlock(text), null);
      assert.ok(stripLeadingFrontmatter(text).length > 0);
    }
  });
});
