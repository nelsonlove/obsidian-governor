/**
 * scheme-tools.test.mjs — Task 6 of the scope-provider module: the five
 * read-only tools over the ScopeRegistry — obsidian_schemes,
 * obsidian_resolve_address, obsidian_next_address, obsidian_list_scope,
 * obsidian_expected_location.
 *
 * Same fixture shape as scheme-jd-scopes.test.mjs (a synthetic vault
 * listing), driven through the fake-server pattern tests/uid-index.test.mjs
 * uses for obsidian_resolve_uid: register against a stand-in server, invoke
 * the captured handler directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { registerSchemeTools } from "../src/mcp/tools-scheme.ts";
import { makeRegistry, DEFAULT_SCHEMES } from "../src/kernel/scheme/registry.ts";

const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "90-99 Projects/92021 Big thing/92021.11 Other.md",
  "Unfiled/loose.md",
];

function toolServer({ schemes = DEFAULT_SCHEMES, notes = NOTES, settings = { readOnly: false, allowlist: [] } } = {}) {
  const server = fakeServer();
  registerSchemeTools(server, {
    registry: () => makeRegistry(schemes),
    notes: () => notes,
    getSettings: () => ({ ...settings, schemes }),
  });
  const call = (name, args = {}) => server.tools.get(name).handler(args, {});
  return { server, call };
}

const TWO_SCHEMES = [
  { id: "jd", provider: "johnny-decimal" },
  { id: "jd2", provider: "johnny-decimal", config: { expandedCategories: [] } },
];

// ── registration shape ───────────────────────────────────────────────────────

describe("registration", () => {
  test("registers exactly the five expected tools, all read-only", () => {
    const { server } = toolServer();
    assert.deepEqual(
      [...server.tools.keys()].sort(),
      [
        "obsidian_expected_location",
        "obsidian_list_scope",
        "obsidian_next_address",
        "obsidian_resolve_address",
        "obsidian_schemes",
      ].sort(),
    );
    for (const [name, { def }] of server.tools) {
      assert.equal(def.annotations.readOnlyHint, true, `${name} must be read-only`);
    }
  });

  test("obsidian_next_address's description says it computes only, reserves nothing, and pairs with obsidian_claim_scope", () => {
    const { server } = toolServer();
    const desc = server.tools.get("obsidian_next_address").def.description.toLowerCase();
    assert.match(desc, /comput/);
    assert.match(desc, /reserves nothing/);
    assert.match(desc, /obsidian_claim_scope/);
  });

  test("obsidian_next_address's description warns that a proposed address may be held outside the allowlist", () => {
    const { server } = toolServer();
    const desc = server.tools.get("obsidian_next_address").def.description.toLowerCase();
    assert.match(desc, /allowlist/);
  });

  test("obsidian_list_scope's description warns that a free slot may be held outside the allowlist, and mentions truncated", () => {
    const { server } = toolServer();
    const desc = server.tools.get("obsidian_list_scope").def.description.toLowerCase();
    assert.match(desc, /allowlist/);
    assert.match(desc, /truncated/);
  });

  test("obsidian_next_address's description documents the allocatable vs exhausted distinction (item 3)", () => {
    const { server } = toolServer();
    const desc = server.tools.get("obsidian_next_address").def.description.toLowerCase();
    assert.match(desc, /allocatable/);
  });

  test("obsidian_list_scope's description documents the allocatable vs exhausted distinction (item 3)", () => {
    const { server } = toolServer();
    const desc = server.tools.get("obsidian_list_scope").def.description.toLowerCase();
    assert.match(desc, /allocatable/);
  });
});

// ── obsidian_schemes ──────────────────────────────────────────────────────────

describe("obsidian_schemes", () => {
  test("reports the single configured instance, its capabilities, and JD examples", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_schemes");
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.schemes, [
      {
        id: "jd",
        provider: "johnny-decimal",
        capabilities: { validate: true, itemAddresses: true, allocate: true, ordered: true },
        config: {},
        examples: ["jd:06.11", "jd:92021.10", "jd:00-09"],
      },
    ]);
  });

  test("reports the raw per-instance config override, and a non-default id in the examples", async () => {
    const schemes = [{ id: "numbering", provider: "johnny-decimal", config: { contentDecimalFloor: 20 } }];
    const { call } = toolServer({ schemes });
    const res = await call("obsidian_schemes");
    assert.deepEqual(res.structuredContent.schemes[0].config, { contentDecimalFloor: 20 });
    assert.deepEqual(res.structuredContent.schemes[0].examples, ["numbering:06.11", "numbering:92021.10", "numbering:00-09"]);
  });

  test("no configured schemes reports an empty list, not an error", async () => {
    const { call } = toolServer({ schemes: [] });
    const res = await call("obsidian_schemes");
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.schemes, []);
  });
});

// ── obsidian_resolve_address ─────────────────────────────────────────────────

describe("obsidian_resolve_address", () => {
  test("address, bare — resolves when exactly one scheme is configured", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", { address: "06.11" });
    assert.deepEqual(res.structuredContent, {
      address: "06.11",
      found: true,
      path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
    });
  });

  test("address, prefixed — same result as bare", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", { address: "jd:06.11" });
    assert.equal(res.structuredContent.path, "00-09 System/06 Agent tooling/06.11 Vault MCP.md");
  });

  test("address, bare — refused when several schemes are configured (no `scheme` argument on this tool)", async () => {
    const { call } = toolServer({ schemes: TWO_SCHEMES });
    const res = await call("obsidian_resolve_address", { address: "06.11" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ambiguous/);
  });

  test("address, prefixed — still resolves unambiguously with several schemes configured", async () => {
    const { call } = toolServer({ schemes: TWO_SCHEMES });
    const res = await call("obsidian_resolve_address", { address: "jd:06.11" });
    assert.equal(res.structuredContent.found, true);
  });

  test("address that parses but resolves to zero notes is a parse-only report, not an error", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", { address: "06.99" });
    assert.deepEqual(res.structuredContent, {
      address: "06.99",
      found: false,
      parsed: { kind: "id", levels: ["00-09", "06", "99"] },
    });
  });

  test("address that does not parse at all is a typed refusal", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", { address: "not an address" });
    assert.equal(res.isError, true);
  });

  test("a duplicated address reports every visible path and flags the ambiguity", async () => {
    const dup = [...NOTES, "Unfiled/06.11 Also claims it.md"];
    const { call } = toolServer({ notes: dup });
    const res = await call("obsidian_resolve_address", { address: "06.11" });
    assert.deepEqual(res.structuredContent, {
      address: "06.11",
      found: true,
      path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
      duplicates: ["00-09 System/06 Agent tooling/06.11 Vault MCP.md", "Unfiled/06.11 Also claims it.md"],
      ambiguous: true,
    });
  });

  test("path → address, the reverse direction", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", { path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md" });
    assert.deepEqual(res.structuredContent, {
      path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
      address: "06.11",
      scheme: "jd",
    });
  });

  test("path with no recognizable address reports address: null, scheme: null", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", { path: "Unfiled/loose.md" });
    assert.deepEqual(res.structuredContent, { path: "Unfiled/loose.md", address: null, scheme: null });
  });

  test("both address and path is refused — they are the two directions of one lookup", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", { address: "06.11", path: "x.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not both/);
  });

  test("neither address nor path is refused", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_resolve_address", {});
    assert.equal(res.isError, true);
  });

  test("allowlist: a hidden note's address resolves as not-found, not as a leak", async () => {
    const { call } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_resolve_address", { address: "92021.10" });
    assert.equal(res.structuredContent.address, "92021.10");
    assert.equal(res.structuredContent.found, false, "the note exists but lives outside the allowlist");
    assert.deepEqual(res.structuredContent.parsed, { kind: "fractal-id", levels: ["90-99", "92021", "10"] });
  });

  test("allowlist: a duplicate outside the allowlist is invisible — the visible one resolves cleanly", async () => {
    const dup = [...NOTES, "90-99 Projects/92021 Big thing/06.11 Also claims it.md"];
    const { call } = toolServer({ notes: dup, settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_resolve_address", { address: "06.11" });
    assert.deepEqual(res.structuredContent, {
      address: "06.11",
      found: true,
      path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
    });
  });

  test("allowlist: given a path outside the allowlist, the reverse direction withholds its address", async () => {
    const { call } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_resolve_address", { path: "90-99 Projects/92021 Big thing/92021.10 Sub.md" });
    assert.deepEqual(res.structuredContent, {
      path: "90-99 Projects/92021 Big thing/92021.10 Sub.md",
      address: null,
      scheme: null,
    });
  });
});

// ── obsidian_next_address ────────────────────────────────────────────────────

describe("obsidian_next_address", () => {
  test("category scope: lowest unused content decimal", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_next_address", { scope: "06" });
    assert.deepEqual(res.structuredContent, { scope: "06", next: "06.10", exhausted: false, allocatable: true });
  });

  test("a full category reports exhausted: true, next: null, allocatable: true (it CAN allocate, it's just full)", async () => {
    const filler = [];
    for (let n = 10; n <= 99; n++) filler.push(`00-09 System/06 Agent tooling/06.${n} Filler.md`);
    const { call } = toolServer({ notes: filler });
    const res = await call("obsidian_next_address", { scope: "06" });
    assert.deepEqual(res.structuredContent, { scope: "06", next: null, exhausted: true, allocatable: true });
  });

  // ── Item 3: allocatable — never-allocatable scopes distinguished from full ones ──

  test("a plain (non-expanded) area is allocatable: false, exhausted: false, with a hint", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_next_address", { scope: "00-09" });
    assert.deepEqual(res.structuredContent, {
      scope: "00-09",
      next: null,
      exhausted: false,
      allocatable: false,
      hint: "a plain area has no address of its own — allocate within one of its categories",
    });
  });

  test("a category folded into an expanded area's band (item 1) is allocatable: false, hinting the band scope by name", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_next_address", { scope: "92" });
    assert.deepEqual(res.structuredContent, {
      scope: "92",
      next: null,
      exhausted: false,
      allocatable: false,
      hint: 'allocate via scope "90-99"',
    });
  });

  test("an unparseable scope is a coded invalid_scope refusal", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_next_address", { scope: "not a scope!" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[invalid_scope\]/);
  });

  test("scheme defaults to the single configured instance", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_next_address", { scope: "90-99" });
    assert.equal(res.structuredContent.next, "92022");
  });

  test("several configured schemes require `scheme` to be named", async () => {
    const { call } = toolServer({ schemes: TWO_SCHEMES });
    const res = await call("obsidian_next_address", { scope: "06" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /specify `scheme`/);
  });

  test("an unknown `scheme` id is refused", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_next_address", { scope: "06", scheme: "nope" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unknown scheme/);
  });

  test("allowlist: a hidden note's slot is not counted as used", async () => {
    // 06.11 lives under "00-09 System", visible under this allowlist — this
    // just pins that the allowlist plumbing runs; the interesting hiding case
    // is exercised on obsidian_list_scope below, where the freed slot shows.
    const { call } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_next_address", { scope: "06" });
    assert.equal(res.structuredContent.next, "06.10");
  });
});

// ── obsidian_list_scope ──────────────────────────────────────────────────────

describe("obsidian_list_scope", () => {
  test("members are address-ordered, plus free.next and free.gaps", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_list_scope", { scope: "06" });
    assert.deepEqual(res.structuredContent.members, [
      { address: "06.00", path: "00-09 System/06 Agent tooling/06.00 JDex.md" },
      { address: "06.11", path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md" },
      { address: "06.12", path: "00-09 System/06 Agent tooling/06.12 Bridge.md" },
    ]);
    assert.equal(res.structuredContent.free.next, "06.10");
    assert.equal(res.structuredContent.free.gaps[0], "06.10");
    assert.equal(res.structuredContent.free.gaps[1], "06.13");
    assert.equal(res.structuredContent.free.gaps.length, 20, "gaps are capped at 20");
  });

  test("a scope with more than 20 free slots reports gaps.length === 20 and truncated: true", async () => {
    // Category "06" here has 96 open decimals (10..99 minus 11,12) — far more
    // than the cap, so the flag must say so.
    const { call } = toolServer();
    const res = await call("obsidian_list_scope", { scope: "06" });
    assert.equal(res.structuredContent.free.gaps.length, 20);
    assert.equal(res.structuredContent.free.truncated, true);
  });

  test("a scope with at most 20 free slots reports truncated: false", async () => {
    const filler = [];
    for (let n = 10; n <= 99; n++) {
      if (n === 50 || n === 70 || n === 90) continue;
      filler.push(`00-09 System/06 Agent tooling/06.${n} Filler.md`);
    }
    const { call } = toolServer({ notes: filler });
    const res = await call("obsidian_list_scope", { scope: "06" });
    assert.deepEqual(res.structuredContent.free.gaps, ["06.50", "06.70", "06.90"]);
    assert.equal(res.structuredContent.free.next, "06.50");
    assert.equal(res.structuredContent.free.truncated, false);
  });

  test("a fully-exhausted scope (0 free slots) also reports truncated: false, allocatable: true", async () => {
    const filler = [];
    for (let n = 10; n <= 99; n++) filler.push(`00-09 System/06 Agent tooling/06.${n} Filler.md`);
    const { call } = toolServer({ notes: filler });
    const res = await call("obsidian_list_scope", { scope: "06" });
    assert.deepEqual(res.structuredContent.free, { next: null, gaps: [], truncated: false, allocatable: true });
  });

  // ── Item 3: allocatable — never-allocatable scopes distinguished from full ones ──

  test("a plain (non-expanded) area's free block reports allocatable: false with a hint, no gap probing", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_list_scope", { scope: "00-09" });
    assert.deepEqual(res.structuredContent.free, {
      next: null,
      gaps: [],
      truncated: false,
      allocatable: false,
      hint: "a plain area has no address of its own — allocate within one of its categories",
    });
  });

  test("a category folded into an expanded area's band still lists its own members, but free.allocatable is false", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_list_scope", { scope: "92" });
    // membersOf stays coherent (item 1's note): the fractal-id under 92021 is
    // still a member of category "92" even though "92" itself can't allocate.
    assert.deepEqual(
      res.structuredContent.members.map((m) => m.address),
      ["92021.10", "92021.11"],
    );
    assert.deepEqual(res.structuredContent.free, {
      next: null,
      gaps: [],
      truncated: false,
      allocatable: false,
      hint: 'allocate via scope "90-99"',
    });
  });

  test("an expanded scope's synthetic sequential ids are truncated too, past the cap", async () => {
    // Expanded area "90-99": nextFree allocates strictly max(used)+1, so the
    // "gaps" here are 20 sequential ids, not genuine skipped numbers — the
    // flag still applies, since there is no upper bound on how many more the
    // scheme could allocate.
    const { call } = toolServer();
    const res = await call("obsidian_list_scope", { scope: "90-99" });
    assert.equal(res.structuredContent.free.gaps.length, 20);
    assert.equal(res.structuredContent.free.gaps[0], "92022");
    assert.equal(res.structuredContent.free.truncated, true);
  });

  test("an empty scope has no members but a computable free slot", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_list_scope", { scope: "99" });
    assert.deepEqual(res.structuredContent.members, []);
  });

  test("an unparseable scope is a coded invalid_scope refusal", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_list_scope", { scope: "###" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[invalid_scope\]/);
  });

  test("allowlist: a hidden member is excluded from the listing, and its slot reads as free (no existence oracle)", async () => {
    // A note that genuinely occupies .10, but sits outside the allowlist
    // (unlike its siblings, individually admitted). It must not appear in
    // `members`, and — since notes() is filtered before it ever reaches the
    // provider — it must not block .10 from reading as the next free slot
    // either: a session sandboxed away from it cannot be told it exists,
    // including implicitly by having its slot skipped.
    const withHidden = [...NOTES, "00-09 System/06 Agent tooling/06.10 SecretlyTaken.md"];
    const allowEverythingElse = NOTES.filter((p) => p.startsWith("00-09 System"));

    const open = toolServer({ notes: withHidden });
    const openRes = await open.call("obsidian_list_scope", { scope: "06" });
    assert.ok(openRes.structuredContent.members.some((m) => m.address === "06.10"), "sanity: the note is really there");

    const { call } = toolServer({ notes: withHidden, settings: { readOnly: false, allowlist: allowEverythingElse } });
    const res = await call("obsidian_list_scope", { scope: "06" });
    assert.ok(!res.structuredContent.members.some((m) => m.address === "06.10"), "the hidden member is excluded");
    assert.equal(res.structuredContent.free.next, "06.10", "a hidden occupant does not block its own slot from reading free");
  });
});

// ── obsidian_expected_location ───────────────────────────────────────────────

describe("obsidian_expected_location", () => {
  test("path: a correctly-placed note reports placed: true", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_expected_location", { path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md" });
    assert.deepEqual(res.structuredContent, {
      address: "06.11",
      expected_folder: "00-09 System/06 Agent tooling",
      actual_folder: "00-09 System/06 Agent tooling",
      placed: true,
    });
  });

  test("path: a misfiled note reports placed: false", async () => {
    const misfiled = [...NOTES, "Random/06.13 Oops.md"];
    const { call } = toolServer({ notes: misfiled });
    const res = await call("obsidian_expected_location", { path: "Random/06.13 Oops.md" });
    assert.deepEqual(res.structuredContent, {
      address: "06.13",
      expected_folder: "00-09 System/06 Agent tooling",
      actual_folder: "Random",
      placed: false,
    });
  });

  test("path: no address and outside every scope — address/expected_folder/placed are null, actual_folder is still the caller's own path", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_expected_location", { path: "Unfiled/loose.md" });
    assert.deepEqual(res.structuredContent, {
      address: null,
      expected_folder: null,
      actual_folder: "Unfiled",
      placed: null,
    });
  });

  test("address: an allocated address reports the note that claims it", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_expected_location", { address: "06.11" });
    assert.deepEqual(res.structuredContent, {
      address: "06.11",
      expected_folder: "00-09 System/06 Agent tooling",
      actual_folder: "00-09 System/06 Agent tooling",
      placed: true,
    });
  });

  test("address: an unclaimed but derivable address reports placed: false, actual_folder: null", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_expected_location", { address: "06.50" });
    assert.deepEqual(res.structuredContent, {
      address: "06.50",
      expected_folder: "00-09 System/06 Agent tooling",
      actual_folder: null,
      placed: false,
    });
  });

  test("both path and address is refused", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_expected_location", { path: "x.md", address: "06.11" });
    assert.equal(res.isError, true);
  });

  test("neither path nor address is refused", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_expected_location", {});
    assert.equal(res.isError, true);
  });

  test("an unknown `scheme` id is refused", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_expected_location", { path: "x.md", scheme: "nope" });
    assert.equal(res.isError, true);
  });

  test("allowlist: a hidden path withholds everything, including its own folder", async () => {
    const { call } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_expected_location", { path: "90-99 Projects/92021 Big thing/92021.10 Sub.md" });
    assert.deepEqual(res.structuredContent, { address: null, expected_folder: null, actual_folder: null, placed: null });
  });
});
