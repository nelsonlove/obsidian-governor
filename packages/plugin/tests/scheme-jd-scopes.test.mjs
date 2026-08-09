/**
 * scheme-jd-scopes.test.mjs — Task 2 of the scope-provider module: the five
 * vault-aware ScopeProvider methods on the Johnny Decimal provider —
 * scopeOf, chainOf, membersOf, expectedFolder, nextFree.
 *
 * A synthetic vault listing (NOTES) stands in for a real vault: every method
 * here is pure over `notes: string[]`, so no Obsidian app is needed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { jdProvider, DEFAULT_JD_CONFIG } from "../src/kernel/scheme/jd.js";

const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "Unfiled/loose.md",
];

const p = jdProvider(DEFAULT_JD_CONFIG);

// ── scopeOf ──────────────────────────────────────────────────────────────────

describe("scopeOf — deepest scheme scope containing a path", () => {
  test("a note two folders deep resolves to its category", () => {
    assert.deepEqual(p.scopeOf(NOTES[2]), { kind: "category", token: "06" });
  });

  test("a note directly under an area folder resolves to the area", () => {
    assert.deepEqual(p.scopeOf(NOTES[0]), { kind: "area", token: "00-09" });
  });

  test("an expanded-item folder (within an expanded area) is its own scope", () => {
    assert.deepEqual(p.scopeOf(NOTES[5]), { kind: "expanded-item", token: "92021" });
  });

  test("a path with no scheme segment resolves to null", () => {
    assert.equal(p.scopeOf("Unfiled/loose.md"), null);
  });

  test("the note's own filename is irrelevant — only folder segments count", () => {
    // scratch no address.md carries no address, but still lives under 06's folder.
    assert.deepEqual(p.scopeOf(NOTES[4]), { kind: "category", token: "06" });
  });

  test("an id's own attachment folder is NOT a nested category, even when its name looks like one", () => {
    // "11 Attachments" sits inside "06.11 Vault MCP" (an id's own folder), not
    // inside an area — "11" parses as a category token in isolation, but its
    // position (nested inside another category's territory) is invalid, so it
    // must not shadow the real, correctly-positioned category scope "06".
    const path = "00-09 System/06 Agent tooling/06.11 Vault MCP/11 Attachments/photo.md";
    assert.deepEqual(p.scopeOf(path), { kind: "category", token: "06" });
  });

  test("a category token nested one level too deep (inside another category) is not a scope", () => {
    // "06" here sits inside category "52"'s folder — not directly under an
    // area — so it can never be a valid category scope, however tempting the
    // bare token match looks.
    const path = "50-59 Something/52 Other/06 Rogue/06.01 Fake.md";
    assert.deepEqual(p.scopeOf(path), { kind: "category", token: "52" });
  });
});

// ── chainOf ──────────────────────────────────────────────────────────────────

describe("chainOf — enclosing scopes, self first, root last", () => {
  test("a category's chain is itself then its area", () => {
    assert.deepEqual(p.chainOf({ kind: "category", token: "06" }), [
      { kind: "category", token: "06" },
      { kind: "area", token: "00-09" },
    ]);
  });

  test("an area's chain is just itself", () => {
    assert.deepEqual(p.chainOf({ kind: "area", token: "00-09" }), [{ kind: "area", token: "00-09" }]);
  });

  test("an expanded-item in an expanded AREA chains straight to the area (no category level)", () => {
    assert.deepEqual(p.chainOf({ kind: "expanded-item", token: "92021" }), [
      { kind: "expanded-item", token: "92021" },
      { kind: "area", token: "90-99" },
    ]);
  });

  test("an expanded-item in an expanded CATEGORY chains through the category", () => {
    assert.deepEqual(p.chainOf({ kind: "expanded-item", token: "27001" }), [
      { kind: "expanded-item", token: "27001" },
      { kind: "category", token: "27" },
      { kind: "area", token: "20-29" },
    ]);
  });
});

// ── membersOf ────────────────────────────────────────────────────────────────

describe("membersOf — notes whose address falls inside the scope", () => {
  test("a category's members are its ids, sorted numerically by decimal", () => {
    const members = p.membersOf({ kind: "category", token: "06" }, NOTES);
    assert.deepEqual(
      members.map((m) => m.address),
      ["06.00", "06.11", "06.12"],
    );
    assert.deepEqual(
      members.map((m) => m.path),
      [
        "00-09 System/06 Agent tooling/06.00 JDex.md",
        "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
        "00-09 System/06 Agent tooling/06.12 Bridge.md",
      ],
    );
  });

  test("a note physically inside the scope's folder but with no address is excluded", () => {
    const members = p.membersOf({ kind: "category", token: "06" }, NOTES);
    assert.ok(!members.some((m) => m.path.includes("scratch no address")));
  });

  test("an expanded-item scope's members are its fractal-ids", () => {
    const members = p.membersOf({ kind: "expanded-item", token: "92021" }, NOTES);
    assert.deepEqual(
      members.map((m) => m.address),
      ["92021.10"],
    );
  });

  test("an empty scope has no members", () => {
    assert.deepEqual(p.membersOf({ kind: "category", token: "99" }, NOTES), []);
  });

  test("numeric sort, not lexical: a 3-digit decimal (110) sorts after 11 and 12, not before", () => {
    const notes = [
      "00-09 System/06 Agent tooling/06.110 Third.md",
      "00-09 System/06 Agent tooling/06.11 First.md",
      "00-09 System/06 Agent tooling/06.12 Second.md",
    ];
    assert.deepEqual(
      p.membersOf({ kind: "category", token: "06" }, notes).map((m) => m.address),
      ["06.11", "06.12", "06.110"],
    );
  });

  test("an expanded category's members are its 5-digit expanded-items", () => {
    const notes = [
      "20-29 Something/27 Expanded/27001 First.md",
      "20-29 Something/27 Expanded/27002 Second.md",
    ];
    assert.deepEqual(
      p.membersOf({ kind: "category", token: "27" }, notes).map((m) => m.address),
      ["27001", "27002"],
    );
  });
});

// ── expectedFolder ───────────────────────────────────────────────────────────

describe("expectedFolder — the folder an address's container actually lives in", () => {
  test("an id's expected folder is its category's actual folder", () => {
    assert.equal(p.expectedFolder(p.parse("06.13"), NOTES), "00-09 System/06 Agent tooling");
  });

  test("a category's expected folder is its area's actual folder", () => {
    assert.equal(p.expectedFolder(p.parse("06"), NOTES), "00-09 System");
  });

  test("an expanded-item in an expanded area expects the area's folder", () => {
    assert.equal(p.expectedFolder(p.parse("92022"), NOTES), "90-99 Projects");
  });

  test("a fractal-id expects its expanded-item's own folder", () => {
    assert.equal(p.expectedFolder(p.parse("92021.11"), NOTES), "90-99 Projects/92021 Big thing");
  });

  test("an area address has no container to find, and returns null", () => {
    assert.equal(p.expectedFolder(p.parse("00-09"), NOTES), null);
  });

  test("a rogue folder sharing the container's bare token, but wrongly positioned, is ignored", () => {
    // "06 Rogue" is nested inside category "52"'s folder, not directly under
    // an area — an invalid position for a category folder — so it must not
    // be mistaken for id "06.13"'s real container, even though it comes
    // first in listing order and its token matches.
    const notes = [
      "50-59 Something/52 Other/06 Rogue/06.01 Fake.md",
      "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
    ];
    assert.equal(p.expectedFolder(p.parse("06.13"), notes), "00-09 System/06 Agent tooling");
  });

  test("when two notes genuinely have a validly-positioned match, the first in listing order wins", () => {
    // Both folders are legitimately positioned category "06" folders (each
    // directly under its own matching area) — a genuine vault inconsistency
    // this method cannot resolve further. The documented, deterministic
    // tie-break is listing order, not path length or any other heuristic.
    const notes = [
      "00-09 System/06 First copy/06.01 A.md",
      "00-09 System/06 Second copy/06.02 B.md",
    ];
    assert.equal(p.expectedFolder(p.parse("06.13"), notes), "00-09 System/06 First copy");
  });

  test("a category with no folder anywhere in the listing returns null", () => {
    assert.equal(p.expectedFolder(p.parse("77.10"), NOTES), null);
  });
});

// ── nextFree ─────────────────────────────────────────────────────────────────

describe("nextFree — next unused address in a scope", () => {
  test("category scope: lowest unused decimal >= 10", () => {
    // 06.00 (reserved zero), 06.11, 06.12 used -> 06.10 is the lowest free content decimal.
    assert.equal(p.format(p.nextFree({ kind: "category", token: "06" }, NOTES)), "06.10");
  });

  test("standard zeros .00-.09 are reserved: a category with only 06.00 allocates 06.10", () => {
    const notes = ["00-09 System/06 Agent tooling/06.00 JDex.md"];
    assert.equal(p.format(p.nextFree({ kind: "category", token: "06" }, notes)), "06.10");
  });

  test("a full category (all 10..99 used) is exhausted -> null", () => {
    const notes = [];
    for (let n = 10; n <= 99; n++) {
      notes.push(`00-09 System/06 Agent tooling/06.${n} Filler.md`);
    }
    assert.equal(p.nextFree({ kind: "category", token: "06" }, notes), null);
  });

  test("an area scope (not expanded) cannot allocate -> null", () => {
    assert.equal(p.nextFree({ kind: "area", token: "00-09" }, NOTES), null);
  });

  test("an expanded area allocates the next 5-digit sequential id", () => {
    assert.equal(p.format(p.nextFree({ kind: "area", token: "90-99" }, NOTES)), "92022");
  });

  test("an expanded area with nothing used yet starts at <band-digit>0001", () => {
    assert.equal(p.format(p.nextFree({ kind: "area", token: "90-99" }, [])), "90001");
  });

  test("an expanded area exhausted at 99999 -> null", () => {
    const notes = ["90-99 Projects/99999 Last.md"];
    assert.equal(p.nextFree({ kind: "area", token: "90-99" }, notes), null);
  });

  test("an expanded category allocates the next 5-digit sequential id", () => {
    const notes = ["20-29 Something/27 Expanded/27001 First.md"];
    assert.equal(p.format(p.nextFree({ kind: "category", token: "27" }, notes)), "27002");
  });

  test("an expanded category with nothing used yet starts at <cat>001", () => {
    assert.equal(p.format(p.nextFree({ kind: "category", token: "27" }, [])), "27001");
  });

  test("an expanded category exhausted at <cat>999 -> null", () => {
    const notes = ["20-29 Something/27 Expanded/27999 Last.md"];
    assert.equal(p.nextFree({ kind: "category", token: "27" }, notes), null);
  });
});
