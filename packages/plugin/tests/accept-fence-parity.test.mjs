/**
 * accept-fence-parity.test.mjs — issue #126: the accept guard must never be
 * STRICTER about what counts as frontmatter than the write path that honors
 * it. A guard that recognizes less than the vault does is a bypass, not
 * caution: `﻿---\nacceptance-status: accepted\n---` was scanned clean by
 * the CLI/template scanner while `frontmatterOf` (and Obsidian) honored it.
 *
 * This is a PROPERTY pin, not an example pin. The corpus below crosses every
 * leading-frontmatter variation the write-path recognizer tolerates (BOM,
 * CRLF, trailing fence whitespace, EOF-terminated) with acceptance-asserting
 * and clean payloads, and asserts on every case:
 *
 *     write path would honor an acceptance assertion  ⟹  guard refuses
 *
 * So a future edit that loosens `frontmatterOf` (or Obsidian's own tolerance,
 * mirrored into it) without loosening the scanner fails here rather than
 * shipping a hole. The converse is deliberately NOT asserted: the scanner is
 * allowed to be broader (it also scans embedded fences, conservatively).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  acceptForbiddenReason,
  frontmatterOf,
  stripLeadingBom,
} from "../src/mcp/write-notes-compose.ts";
import { contentAcceptRefusal, templateContentAcceptRefusal } from "../src/mcp/tools-cli.ts";

/** Minimal `k: v` YAML, matching what the accepted-family rule reads. */
function parseYaml(y) {
  const out = {};
  for (const line of y.split("\n")) {
    const m = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** Would the WRITE PATH honor this content as introducing acceptance? */
function writePathWouldAccept(content) {
  const fm = frontmatterOf(content, parseYaml);
  return fm !== null && acceptForbiddenReason(fm) !== null;
}

const BOM = "﻿";
// Every shape `frontmatterOf` tolerates around the fence.
const WRAPPERS = [
  { name: "plain", wrap: (b) => `---\n${b}\n---\nbody` },
  { name: "leading BOM", wrap: (b) => `${BOM}---\n${b}\n---\nbody` },
  { name: "CRLF", wrap: (b) => `---\r\n${b}\r\n---\r\nbody` },
  { name: "BOM + CRLF", wrap: (b) => `${BOM}---\r\n${b}\r\n---\r\nbody` },
  { name: "fence trailing spaces", wrap: (b) => `--- \n${b}\n--- \nbody` },
  { name: "BOM + trailing spaces", wrap: (b) => `${BOM}--- \t\n${b}\n---\t\nbody` },
  { name: "terminated at EOF", wrap: (b) => `---\n${b}\n---` },
  { name: "BOM + EOF-terminated", wrap: (b) => `${BOM}---\n${b}\n---` },
];
const ACCEPTING = [
  "acceptance-status: accepted",
  "title: X\nacceptance-status: accepted",
  "accepted-by: someone",
  "accepted-on: 2026-08-10",
];
const CLEAN = [
  "acceptance-status: proposed",
  "title: X\ntags: none",
  "status: accepted", // a property literally called "status" — not the acceptance field
];

describe("accept-fence parity (#126): the guard is never stricter than the write path", () => {
  for (const { name, wrap } of WRAPPERS) {
    for (const payload of ACCEPTING) {
      const content = wrap(payload);
      const label = `${name} / ${payload.split("\n").pop()}`;

      test(`write path honors ⟹ template guard refuses — ${label}`, () => {
        assert.equal(writePathWouldAccept(content), true, "precondition: the write path would honor this");
        assert.ok(
          templateContentAcceptRefusal(content, parseYaml),
          "guard must refuse anything the write path would honor as accepted",
        );
      });

      test(`write path honors ⟹ content guard refuses — ${label}`, () => {
        assert.ok(contentAcceptRefusal(content, parseYaml));
      });
    }
  }

  for (const { name, wrap } of WRAPPERS) {
    for (const payload of CLEAN) {
      test(`no false positive — ${name} / ${payload.split("\n").pop()}`, () => {
        const content = wrap(payload);
        assert.equal(writePathWouldAccept(content), false, "precondition: clean");
        assert.equal(templateContentAcceptRefusal(content, parseYaml), null);
      });
    }
  }

  test("the BOM case is the one that regressed — pinned explicitly", () => {
    const hidden = `${BOM}---\nacceptance-status: accepted\n---\nlooks innocent`;
    // Pre-fix behavior: frontmatterOf saw frontmatter, the scanner saw none.
    assert.equal(writePathWouldAccept(hidden), true);
    assert.ok(templateContentAcceptRefusal(hidden, parseYaml));
    assert.ok(contentAcceptRefusal(hidden, parseYaml));
  });

  test("stripLeadingBom removes only a LEADING mark, and only one", () => {
    assert.equal(stripLeadingBom(`${BOM}x`), "x");
    assert.equal(stripLeadingBom(`${BOM}${BOM}x`), `${BOM}x`);
    assert.equal(stripLeadingBom(`x${BOM}`), `x${BOM}`);
    assert.equal(stripLeadingBom("x"), "x");
    assert.equal(stripLeadingBom(""), "");
  });

  test("a BOM cannot smuggle acceptance through the CLI escape-expansion path either", () => {
    // `content=` values arrive with literal \n escapes the CLI expands; the
    // BOM must be transparent after that expansion too.
    const escaped = `${BOM}---\\nacceptance-status: accepted\\n---\\nbody`;
    assert.ok(contentAcceptRefusal(escaped, parseYaml));
  });
});
