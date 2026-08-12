/**
 * accept-guard.test.ts — the shared accept-forbidden predicate (issue #104)
 * and its integration into FilesystemBackend, the concrete gap this issue
 * closes: fs-failover mode (packages/server, used when Obsidian is down) used
 * to serve UNGUARDED writes because the guard previously lived only in the
 * plugin's ObsidianBackend. `acceptTransitionReason` / `acceptForbiddenReason`
 * / `frontmatterOf` here are the SAME functions the plugin's
 * write-notes-compose.ts now re-exports — see that file's
 * write-notes-compose.test.mjs for the exhaustive predicate-level coverage;
 * this file adds `parseGuardFrontmatter` (the fs-mode-only parser adapter)
 * and end-to-end FilesystemBackend coverage.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcceptForbiddenError,
  acceptTransitionReason,
  acceptForbiddenReason,
  parseGuardFrontmatter,
} from "../src/accept-guard.js";
import { FilesystemBackend } from "../src/fs-backend/filesystem-backend.js";

async function freshBackend(): Promise<{ backend: FilesystemBackend; vaultRoot: string }> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "accept-guard-fs-"));
  return { backend: new FilesystemBackend(vaultRoot), vaultRoot };
}

/**
 * Seed a note DIRECTLY on disk, bypassing the guarded backend entirely — the
 * only way an accepted-family value legitimately lands, since the guard
 * itself refuses any API write that would ORIGINATE one. Simulates "a human
 * accepted this note directly in Obsidian".
 */
async function seedDirectly(vaultRoot: string, relPath: string, content: string): Promise<void> {
  await writeFile(join(vaultRoot, relPath), content, "utf8");
}

describe("parseGuardFrontmatter", () => {
  test("parses scalars, quoted scalars, booleans, numbers", () => {
    const fm = parseGuardFrontmatter(
      '---\nname: N\nquoted: "hello world"\nflag: true\ncount: 3\n---\nbody',
    );
    assert.deepEqual(fm, { name: "N", quoted: "hello world", flag: true, count: 3 });
  });

  test("parses an inline array", () => {
    const fm = parseGuardFrontmatter("---\ntags: [a, b, c]\n---\nbody");
    assert.deepEqual(fm, { tags: ["a", "b", "c"] });
  });

  test("parses a block array", () => {
    const fm = parseGuardFrontmatter("---\ntags:\n  - a\n  - b\n---\nbody");
    assert.deepEqual(fm, { tags: ["a", "b"] });
  });

  test("parses an inline flow map (S3 value-type parity)", () => {
    const fm = parseGuardFrontmatter("---\nacceptance-status: {value: accepted}\n---\nbody");
    assert.deepEqual(fm, { "acceptance-status": { value: "accepted" } });
  });

  test("null when there is no leading fence", () => {
    assert.equal(parseGuardFrontmatter("just a body"), null);
  });

  test("null when `---` is not the very first line", () => {
    assert.equal(parseGuardFrontmatter("\n---\nname: N\n---\n"), null);
  });
});

// ── Fail-closed on constructs the subset does not model (issue #104 residual
// — "decide over the honored bytes") ────────────────────────────────────────
//
// Before this fix, a line the subset couldn't classify was silently SKIPPED
// — not refused — so `parseGuardFrontmatter` could report FEWER keys than
// the block actually has (down to zero), reading as "clean" when it wasn't.
// Every case below must now REFUSE (throw AcceptForbiddenError) rather than
// silently drop the line, whether or not the unclassifiable construct itself
// carries an acceptance assertion — once a fence has matched, the guard must
// be able to account for every line in it.
//
// SCOPE: this list is deliberately SHORT. Refusing is only correct where a
// confident classification is genuinely impossible without a full YAML
// document model. Constructs that are merely *nested* (block mappings, flow
// collections inside flow collections, sequences of mappings, block scalars)
// are PARSED, not refused — see the two describes that follow. Refusing those
// rejected 22.9% of a real vault while buying no safety, since parsing them is
// what actually lets the predicate SEE an assertion hidden inside one.

function assertRefusesUnclassifiable(markdown: string) {
  assert.throws(
    () => parseGuardFrontmatter(markdown),
    (e: unknown) => e instanceof AcceptForbiddenError && (e as AcceptForbiddenError).code === "accept_forbidden",
  );
}

describe("parseGuardFrontmatter — fail-closed on unclassifiable constructs", () => {
  test("the known instance: a lone CR inside a scalar value — was 'zero keys read as clean', now REFUSED", () => {
    // /\r?\n/ does not consume a bare \r with no following \n, so it stays
    // embedded in the "line" string; the subset's key/value regex then fails
    // on it entirely (JS `.` excludes \r). Previously: `!km` → `continue` →
    // zero keys → guardWrittenContent read this as clean. Now: refused.
    const withLoneCr = "---\nacceptance-status: accepted\rXYZ\n---\nbody";
    assertRefusesUnclassifiable(withLoneCr);
  });

  test("a bare control character elsewhere in a value is refused", () => {
    assertRefusesUnclassifiable("---\nname: foo\x0bbar\n---\nbody");
  });

  test("a YAML anchor (&) is refused", () => {
    assertRefusesUnclassifiable("---\nname: &anchor value\n---\nbody");
  });

  test("a YAML alias (*) is refused", () => {
    assertRefusesUnclassifiable("---\nname: *anchor\n---\nbody");
  });

  test("an explicit YAML tag (!!) is refused", () => {
    assertRefusesUnclassifiable("---\nname: !!str hello\n---\nbody");
  });

  test("a multi-document end marker (...) inside the block is refused", () => {
    assertRefusesUnclassifiable("---\nname: N\n...\nmore: 1\n---\nbody");
  });

  test("an unquoted scalar starting with an indicator character inside a block array item is refused", () => {
    assertRefusesUnclassifiable("---\ntags:\n  - &anchor\n  - b\n---\nbody");
  });

  test("an unterminated quoted scalar is refused rather than guessed at", () => {
    assertRefusesUnclassifiable('---\nname: "unterminated\n---\nbody');
  });

  test("end-to-end: the lone-CR bypass is refused THROUGH writeNote, not just at the parser", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () =>
        backend.writeNote("note.md", "---\nacceptance-status: accepted\rXYZ\n---\nbody", false),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
    await assert.rejects(() => backend.readNote("note.md"), /ENOENT|not found|no such file/i);
  });
});

// ── Constructs that now PARSE instead of being refused ──────────────────────
//
// These all USED to throw (and were pinned as "refused" by earlier revisions
// of this file). Refusing them was the bug, not the safety rail: they are
// ordinary YAML that Obsidian honors, and blanket-refusing them rejected
// 336/1468 (22.9%) of a real vault. Each test asserts the resulting STRUCTURE,
// not merely that no exception was thrown — a parser that silently returned
// `{}` would satisfy "does not throw" while reopening the exact
// silent-divergence hole this whole change closes.

describe("parseGuardFrontmatter — constructs that now PARSE (were over-broadly refused)", () => {
  test("a literal block scalar (|) parses, newlines preserved", () => {
    const fm = parseGuardFrontmatter("---\nsummary: |\n  line one\n  line two\n---\nbody");
    assert.deepEqual(fm, { summary: "line one\nline two" });
  });

  test("a folded block scalar (>) parses, lines folded onto one", () => {
    const fm = parseGuardFrontmatter("---\nsummary: >\n  line one\n  line two\n---\nbody");
    assert.deepEqual(fm, { summary: "line one line two" });
  });

  test("a flow sequence nested inside another parses to a nested array", () => {
    const fm = parseGuardFrontmatter("---\nitems: [[a, b], c]\n---\nbody");
    assert.deepEqual(fm, { items: [["a", "b"], "c"] });
  });

  test("flow mappings inside a flow sequence parse to an array of objects", () => {
    const fm = parseGuardFrontmatter("---\nitems: [{a: 1}, {b: 2}]\n---\nbody");
    assert.deepEqual(fm, { items: [{ a: 1 }, { b: 2 }] });
  });

  test("a block-style nested mapping parses recursively", () => {
    const fm = parseGuardFrontmatter("---\nmetadata:\n  owner: nelson\n  count: 2\n---\nbody");
    assert.deepEqual(fm, { metadata: { owner: "nelson", count: 2 } });
  });

  test("a sequence of mappings parses as ONE object per item, sibling keys grouped", () => {
    const fm = parseGuardFrontmatter(
      "---\nrelated:\n  - title: Foo\n    date: 2024-01-01\n  - title: Bar\n    date: 2024-02-02\n---\nbody",
    );
    assert.deepEqual(fm, {
      related: [
        { title: "Foo", date: "2024-01-01" },
        { title: "Bar", date: "2024-02-02" },
      ],
    });
  });

  test("a quoted element beside a NESTED bracket parses — the comma is not a splitter and the nesting is modeled", () => {
    const fm = parseGuardFrontmatter('---\ntags: ["a", ["b", "c"]]\n---\nbody');
    assert.deepEqual(fm, { tags: ["a", ["b", "c"]] });
  });

  test("an unquoted Obsidian wikilink (a nested flow sequence to YAML) parses", () => {
    // `projects: [[Some Note]]` is why nested-flow support is not academic —
    // it is the single most common nested collection in a real Obsidian vault.
    const fm = parseGuardFrontmatter("---\nprojects: [[Some Note]]\n---\nbody");
    assert.deepEqual(fm, { projects: [["Some Note"]] });
  });

  test("an empty flow mapping as the WHOLE frontmatter parses to no keys, not a refusal", () => {
    // `---\n{}\n---` is what an Apple Notes import writes; it asserts nothing,
    // so refusing it was a pure false positive.
    assert.deepEqual(parseGuardFrontmatter("---\n{}\n---\nbody"), {});
  });

  test("an empty flow sequence as the WHOLE frontmatter parses to no keys, not a refusal", () => {
    assert.deepEqual(parseGuardFrontmatter("---\n[]\n---\nbody"), {});
  });

  test("a non-empty flow MAPPING as the whole frontmatter parses to its keys", () => {
    assert.deepEqual(parseGuardFrontmatter("---\n{owner: nelson, count: 2}\n---\nbody"), {
      owner: "nelson",
      count: 2,
    });
  });

  test("a truly empty fence is still 'no frontmatter' (null), distinct from '{}' (no keys)", () => {
    assert.equal(parseGuardFrontmatter("---\n---\nbody"), null);
  });
});

// ── The security payoff: parsing beats refusing ─────────────────────────────
//
// This is the WHOLE reason the constructs above are parsed rather than
// refused. When the reader refused them it also could not SEE them, and the
// acceptance predicate ran over a tree with the construct missing. Now the
// predicate runs over the real structure, so an assertion hidden inside any of
// them is caught. Each case goes through the REAL guard path
// (FilesystemBackend.writeNote → guardWrittenContent), not just the parser, and
// asserts nothing landed on disk.

describe("an acceptance assertion hidden inside a now-parsed construct is still CAUGHT", () => {
  async function assertRefusedAndNothingWritten(content: string) {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", content, false),
      (e: unknown) => e instanceof AcceptForbiddenError && (e as AcceptForbiddenError).code === "accept_forbidden",
    );
    await assert.rejects(() => backend.readNote("note.md"), /ENOENT|not found|no such file/i);
  }

  test("acceptance-status whose value is a LITERAL block scalar", async () => {
    await assertRefusedAndNothingWritten("---\nacceptance-status: |\n  accepted\n---\nbody");
  });

  test("acceptance-status whose value is a FOLDED block scalar", async () => {
    await assertRefusedAndNothingWritten("---\nacceptance-status: >\n  accepted\n---\nbody");
  });

  test("acceptance-status hidden one level down in a NESTED flow sequence", async () => {
    await assertRefusedAndNothingWritten("---\nacceptance-status: [[accepted]]\n---\nbody");
  });

  test("acceptance-status hidden in a flow MAPPING inside a flow sequence", async () => {
    await assertRefusedAndNothingWritten("---\nacceptance-status: [{v: accepted}]\n---\nbody");
  });

  test("acceptance-status hidden in a block-style nested mapping", async () => {
    await assertRefusedAndNothingWritten("---\nacceptance-status:\n  value: accepted\n---\nbody");
  });

  test("acceptance-status hidden in a SEQUENCE OF MAPPINGS", async () => {
    await assertRefusedAndNothingWritten(
      "---\nacceptance-status:\n  - by: nelson\n    value: accepted\n---\nbody",
    );
  });

  test("an accepted-by KEY whose value is a nested block mapping", async () => {
    await assertRefusedAndNothingWritten("---\naccepted-by:\n  name: nelson\n---\nbody");
  });

  test("a QUOTED acceptance key is unquoted before the predicate sees it", async () => {
    // `"accepted-by": nelson` — without unquoting, the key reads as the literal
    // `"accepted-by"` (quotes included), which `isAcceptedKey` does not match,
    // and the assertion walks straight past the guard. Found by differential-
    // testing this reader against PyYAML over the real vault.
    await assertRefusedAndNothingWritten('---\n"accepted-by": nelson\n---\nbody');
  });

  test("acceptance-status asserted from a flow MAPPING at the document root", async () => {
    await assertRefusedAndNothingWritten("---\n{acceptance-status: accepted}\n---\nbody");
  });

  test("NOT a false positive: a NESTED acceptance-status is a DIFFERENT property and is ALLOWED", async () => {
    // Obsidian reads the TOP-LEVEL `acceptance-status` property; `metadata`
    // holding a sub-key of the same name is a different property entirely, so
    // refusing it would be a false positive. The rule is: acceptance-family
    // KEYS at the top level, recursing into their VALUES — decide over what
    // the honorer honors, not more.
    const { backend } = await freshBackend();
    const result = await backend.writeNote(
      "note.md",
      "---\nmetadata:\n  acceptance-status: accepted\n---\nbody",
      false,
    );
    assert.equal(result.created, true);
    assert.match(await backend.readNote("note.md"), /acceptance-status: accepted/);
  });

  test("an empty-flow-collection frontmatter is a legitimate write and SUCCEEDS", async () => {
    const { backend } = await freshBackend();
    assert.equal((await backend.writeNote("a.md", "---\n{}\n---\nbody", false)).created, true);
    assert.equal((await backend.writeNote("b.md", "---\n[]\n---\nbody", false)).created, true);
  });
});

/**
 * The closing fence is prefix-matched by the vault, and the guard must see
 * what the vault sees.
 *
 * The recognizer used to demand the closer be `---` plus at most spaces/tabs
 * before the line break. Obsidian closes on the first line whose first three
 * bytes are `---`, whatever follows. So every note below carries frontmatter
 * the vault parses and honors, while the guard saw no frontmatter at all and
 * refused nothing — the #126 class (a guard narrower than the vault is a
 * bypass, not caution) on the other fence.
 *
 * Each closer form is asserted twice on purpose: that the guard REFUSES the
 * acceptance assertion hiding behind it, and that nothing was written. A test
 * that only checked the throw would still pass if the write happened first.
 */
describe("accept guard — acceptance behind an unusual CLOSING fence is refused (perimeter)", () => {
  const CLOSERS = [
    ["four dashes", "----"],
    ["adjacent text", "---x"],
    ["spaced text", "--- x"],
    ["trailing space", "--- "],
    ["CRLF + four dashes", "----\r"],
  ];

  for (const [name, closer] of CLOSERS) {
    test(`a NEW note asserting acceptance behind a \`${closer.replace(/\r/, "\\r")}\` closer is REFUSED — ${name}`, async () => {
      const { backend, vaultRoot } = await freshBackend();
      const eol = closer.endsWith("\r") ? "\r\n" : "\n";
      const content = `---${eol}acceptance-status: accepted${eol}${closer}\nbody`;

      await assert.rejects(
        () => backend.writeNote("note.md", content, false),
        AcceptForbiddenError,
        `the vault honors this frontmatter; a guard that does not see it is a bypass (closer ${JSON.stringify(closer)})`,
      );
      await assert.rejects(
        () => readFile(join(vaultRoot, "note.md"), "utf8"),
        "the refusal must happen BEFORE the write, not after",
      );
    });
  }

  /**
   * A lone `\r` is a line break to Obsidian's FENCE SCAN — probed live:
   * `---\nzz: 9\r---\n` parses as `{zz: 9}`, and so does an all-CR document.
   * The guard required `\r?\n`, so it saw no frontmatter and wrote the note.
   *
   * Found by review of this change: the same class, one axis over from the
   * closer shape. Worth stating why it hid — every earlier pass asked "is the
   * closer's SHAPE right?" and none asked "what counts as the line it sits
   * on?" A rule has as many boundaries as it has terms.
   */
  test("a lone CR before the closer does not hide an acceptance assertion", async () => {
    const { backend, vaultRoot } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", "---\nacceptance-status: accepted\r---\nbody", false),
      AcceptForbiddenError,
      "Obsidian honors a lone CR as the fence's line break; a guard that requires \\n does not see this frontmatter at all",
    );
    await assert.rejects(() => readFile(join(vaultRoot, "note.md"), "utf8"));
  });

  test("an all-CR document asserting acceptance is refused", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", "---\racceptance-status: accepted\r---\rbody", false),
      AcceptForbiddenError,
    );
  });

  test("a lone CR still makes a block OPAQUE when it lands inside a value (#104 unchanged)", () => {
    // Widening the fence must not widen what the subset parser silently
    // accepts: a CR the parser cannot classify still fails closed.
    assert.throws(
      () => parseGuardFrontmatter("---\nacceptance-status: accepted\rXYZ\n---\nbody"),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
  });

  test("an accepted-family KEY behind such a closer is refused too, not just the status value", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", "---\naccepted-by: nelson\n----\nbody", false),
      AcceptForbiddenError,
    );
  });

  test("an ORDINARY note using such a closer still writes — the fix widens recognition, not refusal", async () => {
    const { backend } = await freshBackend();
    const result = await backend.writeNote("note.md", "---\ntitle: N\n----\nbody", false);
    assert.equal(result.created, true);
    // And the leftover dash is BODY, per the vault: it must survive verbatim.
    assert.equal(await backend.readNote("note.md"), "---\ntitle: N\n----\nbody");
  });

  test("the frontmatter behind such a closer is actually PARSED, not merely refused by accident", () => {
    // If this returned null the refusals above could be passing for the wrong
    // reason (e.g. some unrelated opacity check), so pin the recognition too.
    assert.deepEqual(parseGuardFrontmatter("---\ntitle: N\n----\nbody"), { title: "N" });
    assert.deepEqual(parseGuardFrontmatter("---\ntitle: N\n--- x\nbody"), { title: "N" });
  });
});

// ── Non-regression: ordinary frontmatter still parses and still ALLOWS
// legitimate writes ──────────────────────────────────────────────────────────

describe("parseGuardFrontmatter — non-regression on ordinary constructs", () => {
  test("strings, lists, quoted values all still parse", () => {
    const fm = parseGuardFrontmatter(
      '---\ntitle: My Note\ntags: [a, b]\nquoted: "hello, world"\n---\nbody',
    );
    assert.deepEqual(fm, { title: "My Note", tags: ["a", "b"], quoted: "hello, world" });
  });

  test("a quoted array element CONTAINING a comma is parsed as ONE element, not split", () => {
    const fm = parseGuardFrontmatter('---\ntags: ["a, b", "c"]\n---\nbody');
    assert.deepEqual(fm, { tags: ["a, b", "c"] });
  });

  test("a nested (flow) map still parses — key: {sub: val}", () => {
    const fm = parseGuardFrontmatter("---\nmetadata: {owner: nelson, count: 2}\n---\nbody");
    assert.deepEqual(fm, { metadata: { owner: "nelson", count: 2 } });
  });

  test("CRLF line endings throughout the block still parse", () => {
    const fm = parseGuardFrontmatter("---\r\nname: N\r\ntags: [a, b]\r\n---\r\nbody");
    assert.deepEqual(fm, { name: "N", tags: ["a", "b"] });
  });

  test("a leading BOM still parses", () => {
    const fm = parseGuardFrontmatter("\uFEFF---\nname: N\n---\nbody");
    assert.deepEqual(fm, { name: "N" });
  });

  test("trailing whitespace on the fence lines still parses", () => {
    const fm = parseGuardFrontmatter("--- \t\nname: N\n---\t\nbody");
    assert.deepEqual(fm, { name: "N" });
  });

  test("a block array of quoted scalars containing colons is allowed (quoting disambiguates from a mapping item)", () => {
    const fm = parseGuardFrontmatter('---\nnotes:\n  - "Note: Draft"\n  - plain\n---\nbody');
    assert.deepEqual(fm, { notes: ["Note: Draft", "plain"] });
  });

  describe("legitimate writes through FilesystemBackend still succeed with these ordinary constructs", () => {
    test("CRLF + BOM + quoted-comma frontmatter on a NEW note succeeds", async () => {
      const { backend } = await freshBackend();
      const content = "\uFEFF---\r\ntitle: N\r\ntags: [\"a, b\", c]\r\n---\r\nbody";
      const result = await backend.writeNote("note.md", content, false);
      assert.equal(result.created, true);
    });

    test("preserving an existing accepted value verbatim on an UNRELATED edit is still ALLOWED, even with ordinary nested-flow-map frontmatter alongside it", async () => {
      const { backend, vaultRoot } = await freshBackend();
      await seedDirectly(
        vaultRoot,
        "note.md",
        "---\nacceptance-status: accepted\nmetadata: {owner: nelson}\n---\noriginal",
      );
      const result = await backend.writeNote(
        "note.md",
        "---\nacceptance-status: accepted\nmetadata: {owner: nelson}\n---\nedited body",
        true,
      );
      assert.equal(result.created, false);
      assert.match(await backend.readNote("note.md"), /edited body/);
    });
  });
});

describe("acceptTransitionReason / acceptForbiddenReason (re-exported from core)", () => {
  test("introducing acceptance-status:accepted is blocked", () => {
    assert.ok(acceptTransitionReason(null, { "acceptance-status": "accepted" }));
  });
  test("preserving an existing accepted verbatim is allowed", () => {
    assert.equal(
      acceptTransitionReason({ "acceptance-status": "accepted" }, { "acceptance-status": "accepted" }),
      null,
    );
  });
  test("a map-wrapped accepted value is recognized once parsed", () => {
    assert.ok(acceptTransitionReason(null, { "acceptance-status": { value: "accepted" } }));
  });
  test("acceptForbiddenReason flags a caller payload carrying accepted-by", () => {
    assert.ok(acceptForbiddenReason({ "accepted-by": "nelson" }));
  });
});

describe("FilesystemBackend.writeNote — accept-forbidden guard (issue #104)", () => {
  test("a NEW note carrying acceptance-status: accepted is REFUSED (no way to originate one via API)", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", "---\nacceptance-status: accepted\n---\nbody", false),
      (e: unknown) => e instanceof AcceptForbiddenError && (e as AcceptForbiddenError).code === "accept_forbidden",
    );
  });

  test("a NEW note carrying a bare accepted-by field is REFUSED", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", "---\naccepted-by: an-agent\n---\nbody", false),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
  });

  test("the array value-type form [accepted] is REFUSED (S3 parity)", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", "---\nacceptance-status: [accepted]\n---\nbody", false),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
  });

  test("the map value-type form {value: accepted} is REFUSED (S3 parity)", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.writeNote("note.md", "---\nacceptance-status: {value: accepted}\n---\nbody", false),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
  });

  test("a normal non-accepted write SUCCEEDS", async () => {
    const { backend } = await freshBackend();
    const result = await backend.writeNote("note.md", "---\nname: N\n---\nhello world", false);
    assert.equal(result.created, true);
    assert.equal(await backend.readNote("note.md"), "---\nname: N\n---\nhello world");
  });

  test("a write with NO frontmatter at all SUCCEEDS", async () => {
    const { backend } = await freshBackend();
    const result = await backend.writeNote("plain.md", "just a body, no frontmatter", false);
    assert.equal(result.created, true);
  });

  test("REFUSING the write means nothing lands on disk", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(() =>
      backend.writeNote("note.md", "---\nacceptance-status: accepted\n---\nbody", false),
    );
    await assert.rejects(() => backend.readNote("note.md"), /ENOENT|not found|no such file/i);
  });

  test("changing proposed → accepted on an EXISTING note is REFUSED", async () => {
    const { backend } = await freshBackend();
    await backend.writeNote("note.md", "---\nacceptance-status: proposed\n---\nbody", false);
    await assert.rejects(
      () => backend.writeNote("note.md", "---\nacceptance-status: accepted\n---\nedited", true),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
  });

  test("preserving an existing (human-set) accepted value verbatim through an edit is ALLOWED", async () => {
    const { backend, vaultRoot } = await freshBackend();
    // Seed directly — a human accepting the note in Obsidian, not an API write.
    await seedDirectly(vaultRoot, "note.md", "---\nacceptance-status: accepted\nname: N\n---\noriginal");
    const result = await backend.writeNote(
      "note.md",
      "---\nacceptance-status: accepted\nname: N\n---\nedited body",
      true,
    );
    assert.equal(result.created, false);
    assert.match(await backend.readNote("note.md"), /edited body/);
  });

  test("moving AWAY from accepted (accepted → proposed) is ALLOWED — the guard only blocks the accept direction", async () => {
    // Matches the predicate's existing semantics (write-notes-compose.test.mjs:
    // "a non-accepted status transition is clean") — the invariant is "never
    // LAUNDER a write INTO accepted", not "never touch an accepted note".
    const { backend, vaultRoot } = await freshBackend();
    await seedDirectly(vaultRoot, "note.md", "---\nacceptance-status: accepted\n---\noriginal");
    await backend.writeNote("note.md", "---\nacceptance-status: proposed\n---\nedited", true);
    assert.match(await backend.readNote("note.md"), /acceptance-status: proposed/);
  });
});

describe("FilesystemBackend.appendNote — accept-forbidden guard", () => {
  test("appending to create a NEW note whose fence asserts acceptance is REFUSED", async () => {
    const { backend } = await freshBackend();
    await assert.rejects(
      () => backend.appendNote("note.md", "---\nacceptance-status: accepted\n---\nbody"),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
    await assert.rejects(() => backend.readNote("note.md"), /ENOENT|not found|no such file/i);
  });

  test("a normal append to an existing note SUCCEEDS and does not touch frontmatter", async () => {
    const { backend } = await freshBackend();
    await backend.writeNote("note.md", "---\nname: N\n---\nline one", false);
    await backend.appendNote("note.md", "line two");
    assert.match(await backend.readNote("note.md"), /line one[\s\S]*line two/);
  });

  test("appending a normal body to a brand-new note SUCCEEDS", async () => {
    const { backend } = await freshBackend();
    await backend.appendNote("fresh.md", "hello");
    assert.equal(await backend.readNote("fresh.md"), "hello");
  });
});

describe("FilesystemBackend.manageFrontmatter(set) — accept-forbidden guard", () => {
  test("setting acceptance-status=accepted directly is REFUSED", async () => {
    const { backend } = await freshBackend();
    await backend.writeNote("note.md", "---\nname: N\n---\nbody", false);
    await assert.rejects(
      () => backend.manageFrontmatter("note.md", "acceptance-status", "set", "accepted"),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
    const after = await backend.manageFrontmatter("note.md", "acceptance-status", "get");
    assert.equal(after.value, undefined, "the field must not have been written");
  });

  test("setting an accepted-by field directly is REFUSED", async () => {
    const { backend } = await freshBackend();
    await backend.writeNote("note.md", "---\nname: N\n---\nbody", false);
    await assert.rejects(
      () => backend.manageFrontmatter("note.md", "accepted-by", "set", "an-agent"),
      (e: unknown) => e instanceof AcceptForbiddenError,
    );
  });

  test("setting an ordinary field SUCCEEDS", async () => {
    const { backend } = await freshBackend();
    await backend.writeNote("note.md", "---\nname: N\n---\nbody", false);
    await backend.manageFrontmatter("note.md", "status", "set", "active");
    const result = await backend.manageFrontmatter("note.md", "status", "get");
    assert.equal(result.value, "active");
  });

  test("re-setting acceptance-status to the SAME already-accepted (human-set) value is ALLOWED (preserve)", async () => {
    const { backend, vaultRoot } = await freshBackend();
    await seedDirectly(vaultRoot, "note.md", "---\nacceptance-status: accepted\n---\nbody");
    await backend.manageFrontmatter("note.md", "acceptance-status", "set", "accepted");
    const result = await backend.manageFrontmatter("note.md", "acceptance-status", "get");
    assert.equal(result.value, "accepted");
  });
});
