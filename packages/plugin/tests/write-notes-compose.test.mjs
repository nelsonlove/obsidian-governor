/**
 * write-notes-compose.test.mjs — the pure composition/stamping logic behind
 * obsidian_write_notes (slice B1). Obsidian-free, so this is a real unit test:
 * uuidv7 minting, canonical field order, the accept-forbidden guard, and the
 * stamp merge (mint-only-when-absent, preserve identity, default proposed).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  uuidv7,
  formatLocalTimestamp,
  canonicalOrder,
  acceptForbiddenReason,
  composeNote,
  AcceptForbiddenError,
} from "../src/mcp/write-notes-compose.ts";

// A deterministic YAML stand-in — enough to assert on, key order preserved.
const fakeYaml = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7 (created-seeded)", () => {
  test("has version 7, RFC variant, and canonical shape", () => {
    const id = uuidv7(1723200000000, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    assert.match(id, UUID_RE);
  });

  test("the 48-bit timestamp field is seeded from the argument", () => {
    const ms = 1723200000000;
    const id = uuidv7(ms, new Uint8Array(10));
    const tsHex = id.slice(0, 8) + id.slice(9, 13); // first 6 bytes = 12 hex chars
    assert.equal(parseInt(tsHex, 16), ms, "the timestamp field must decode back to the seed");
  });

  test("is deterministic for a given seed + randomness", () => {
    const rand = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    assert.equal(uuidv7(42, rand), uuidv7(42, rand));
  });

  test("distinct random bytes give distinct ids at the same timestamp", () => {
    const a = uuidv7(42, new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
    const b = uuidv7(42, new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]));
    assert.notEqual(a, b);
    assert.equal(a.slice(0, 13), b.slice(0, 13), "the timestamp prefix is shared");
  });
});

describe("formatLocalTimestamp", () => {
  test("is second-precision, no zone suffix", () => {
    assert.match(formatLocalTimestamp(1723200000000), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("canonicalOrder", () => {
  test("name/title, uid, created, modified, …rest, acceptance-status last", () => {
    const ordered = canonicalOrder({
      z: 1,
      "acceptance-status": "proposed",
      uid: "u",
      extra: 2,
      name: "N",
      created: "c",
      modified: "m",
      title: "T",
    });
    assert.deepEqual(Object.keys(ordered), [
      "name",
      "title",
      "uid",
      "created",
      "modified",
      "z",
      "extra",
      "acceptance-status",
    ]);
  });

  test("omits absent canonical keys, keeps value identity", () => {
    const val = { deep: true };
    const ordered = canonicalOrder({ uid: "u", ref: val });
    assert.deepEqual(Object.keys(ordered), ["uid", "ref"]);
    assert.equal(ordered.ref, val);
  });
});

describe("acceptForbiddenReason", () => {
  for (const [label, fm, forbidden] of [
    ["acceptance-status: accepted", { "acceptance-status": "accepted" }, true],
    ["acceptance-status: accepted-provisionally", { "acceptance-status": "accepted-provisionally" }, true],
    ["accepted-by field", { "accepted-by": "nelson" }, true],
    ["accepted-on field", { "accepted-on": "2026-08-09" }, true],
    ["bare accepted field", { accepted: true }, true],
    ["accepted_by underscore variant", { accepted_by: "x" }, true],
    ["acceptance-status: proposed", { "acceptance-status": "proposed" }, false],
    ["ordinary frontmatter", { name: "x", tags: ["a"] }, false],
    ["empty", {}, false],
  ]) {
    test(`${label} → ${forbidden ? "forbidden" : "clean"}`, () => {
      const reason = acceptForbiddenReason(fm);
      assert.equal(reason !== null, forbidden);
    });
  }
});

describe("composeNote — accept-forbidden guard (stamped or not)", () => {
  for (const stamp of [false, true]) {
    test(`rejects an accepted payload with stamp:${stamp}`, () => {
      assert.throws(
        () =>
          composeNote({
            frontmatter: { "acceptance-status": "accepted" },
            body: "b",
            stamp,
            now: 0,
            mintUid: () => "UID",
            formatTs: () => "TS",
            stringifyYaml: fakeYaml,
          }),
        (e) => e instanceof AcceptForbiddenError && e.code === "accept_forbidden"
      );
    });
    test(`rejects an accepted-by payload with stamp:${stamp}`, () => {
      assert.throws(
        () =>
          composeNote({
            frontmatter: { name: "N", "accepted-by": "nelson" },
            body: "b",
            stamp,
            now: 0,
            mintUid: () => "UID",
            formatTs: () => "TS",
            stringifyYaml: fakeYaml,
          }),
        (e) => e instanceof AcceptForbiddenError
      );
    });
  }
});

describe("composeNote — stamp:false is verbatim", () => {
  test("writes exactly the payload frontmatter + body, no identity fields added", () => {
    const { content, frontmatter, stamped } = composeNote({
      frontmatter: { name: "N" },
      body: "hello",
      stamp: false,
      now: 0,
      mintUid: () => "UID",
      formatTs: () => "TS",
      stringifyYaml: fakeYaml,
    });
    assert.equal(stamped, false);
    assert.deepEqual(Object.keys(frontmatter), ["name"]);
    assert.equal(content, `---\nname: "N"\n---\nhello`);
  });

  test("no frontmatter ⇒ just the body", () => {
    const { content } = composeNote({
      frontmatter: undefined,
      body: "just body",
      stamp: false,
      now: 0,
      mintUid: () => "UID",
      formatTs: () => "TS",
      stringifyYaml: fakeYaml,
    });
    assert.equal(content, "just body");
  });
});

describe("composeNote — stamp mints and orders", () => {
  test("a new note gets uid, created, modified, default acceptance-status:proposed, canonical order", () => {
    const { frontmatter, stamped } = composeNote({
      frontmatter: { name: "N" },
      body: "hi",
      stamp: true,
      existing: undefined,
      now: 5,
      mintUid: () => "MINTED",
      formatTs: (ms) => `TS(${ms})`,
      stringifyYaml: fakeYaml,
    });
    assert.equal(stamped, true);
    assert.equal(frontmatter.uid, "MINTED");
    assert.equal(frontmatter.created, "TS(5)");
    assert.equal(frontmatter.modified, "TS(5)");
    assert.equal(frontmatter["acceptance-status"], "proposed");
    assert.deepEqual(Object.keys(frontmatter), ["name", "uid", "created", "modified", "acceptance-status"]);
  });

  test("uid is seeded from the note's created timestamp", () => {
    let seed;
    composeNote({
      frontmatter: { created: "2020-01-01T00:00:00Z" },
      body: "",
      stamp: true,
      now: 999,
      mintUid: (ms) => { seed = ms; return "MINTED"; },
      formatTs: (ms) => `TS(${ms})`,
      stringifyYaml: fakeYaml,
    });
    assert.equal(seed, Date.parse("2020-01-01T00:00:00Z"));
  });
});

describe("composeNote — stamp never overwrites existing identity", () => {
  test("an existing on-disk uid is preserved, never re-minted", () => {
    let minted = false;
    const { frontmatter } = composeNote({
      frontmatter: {},
      body: "",
      stamp: true,
      existing: { uid: "OLD-UID", created: "2019-06-01T00:00:00" },
      now: 5,
      mintUid: () => { minted = true; return "MINTED"; },
      formatTs: (ms) => `TS(${ms})`,
      stringifyYaml: fakeYaml,
    });
    assert.equal(frontmatter.uid, "OLD-UID");
    assert.equal(frontmatter.created, "2019-06-01T00:00:00", "existing created is preserved");
    assert.equal(frontmatter.modified, "TS(5)", "modified is always set to now");
    assert.equal(minted, false, "mintUid must not run when a uid already exists");
  });

  test("an existing acceptance-status is preserved verbatim, never changed to proposed", () => {
    const { frontmatter } = composeNote({
      frontmatter: { name: "N" },
      body: "",
      stamp: true,
      existing: { "acceptance-status": "accepted" },
      now: 5,
      mintUid: () => "MINTED",
      formatTs: (ms) => `TS(${ms})`,
      stringifyYaml: fakeYaml,
    });
    assert.equal(
      frontmatter["acceptance-status"],
      "accepted",
      "stamp must preserve an existing acceptance-status, not default it to proposed"
    );
  });

  test("a payload uid is used when no on-disk uid exists (still not minted)", () => {
    let minted = false;
    const { frontmatter } = composeNote({
      frontmatter: { uid: "PAYLOAD-UID" },
      body: "",
      stamp: true,
      existing: undefined,
      now: 5,
      mintUid: () => { minted = true; return "MINTED"; },
      formatTs: (ms) => `TS(${ms})`,
      stringifyYaml: fakeYaml,
    });
    assert.equal(frontmatter.uid, "PAYLOAD-UID");
    assert.equal(minted, false);
  });

  test("a caller's non-accepted acceptance-status is honored (not overridden by proposed)", () => {
    const { frontmatter } = composeNote({
      frontmatter: { "acceptance-status": "rejected" },
      body: "",
      stamp: true,
      now: 5,
      mintUid: () => "MINTED",
      formatTs: (ms) => `TS(${ms})`,
      stringifyYaml: fakeYaml,
    });
    assert.equal(frontmatter["acceptance-status"], "rejected");
  });
});
