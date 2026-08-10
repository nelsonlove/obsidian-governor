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
import { mkdtemp, writeFile } from "node:fs/promises";
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
