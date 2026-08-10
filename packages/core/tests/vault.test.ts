import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// VAULT_PATH must be set BEFORE the module is imported — vault.ts captures
// VAULT_ROOT at module load. Same dance as index-store.test.ts. On macOS,
// tmpdir() lives under /var → /private/var, so the vault root itself is
// behind a symlink — which exercises the realpath comparison for free.
let tmpRoot: string;
let outsideRoot: string;
let vault: typeof import("../src/fs-backend/vault.js");

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  outsideRoot = await mkdtemp(path.join(tmpdir(), "vault-outside-"));
  process.env.VAULT_PATH = tmpRoot;
  vault = await import("../src/fs-backend/vault.js");
});

beforeEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});

// Matches the accept-forbidden guard's refusal shape by CODE, not message text —
// AcceptForbiddenError's stringified form is "AcceptForbiddenError: <reason>. ...",
// which does not literally contain "accept_forbidden" (that's the `.code`
// property, per accept-guard.ts).
function isAcceptForbidden(e: unknown): boolean {
  return e instanceof Error && (e as { code?: string }).code === "accept_forbidden";
}

describe("resolveInVault — lexical guards", () => {
  test("resolves a plain relative path inside the vault", () => {
    const abs = vault.resolveInVault("Projects/Plan.md");
    assert.ok(abs.endsWith(path.join("Projects", "Plan.md")));
  });

  test("strips leading ../ rather than escaping", () => {
    const abs = vault.resolveInVault("../../etc/passwd");
    // Must stay inside the vault root, not resolve to the real /etc/passwd.
    assert.ok(abs.startsWith(tmpRoot + path.sep));
  });

  test("refuses ignored folders", () => {
    assert.throws(() => vault.resolveInVault(".obsidian/app.json"), /ignored folder/);
    assert.throws(() => vault.resolveInVault(".git/config"), /ignored folder/);
  });

  test("nonexistent nested path is allowed (writeNote creates parents)", () => {
    const abs = vault.resolveInVault("new/deeply/nested/note.md");
    assert.ok(abs.includes("nested"));
  });
});

describe("resolveInVault — symlink escape guard", () => {
  test("refuses a symlinked FILE pointing outside the vault", async () => {
    const secret = path.join(outsideRoot, "secret.md");
    await writeFile(secret, "outside the vault", "utf8");
    await symlink(secret, path.join(tmpRoot, "link.md"));
    assert.throws(() => vault.resolveInVault("link.md"), /symlink/);
  });

  test("refuses a path THROUGH a symlinked dir pointing outside the vault", async () => {
    const outDir = path.join(outsideRoot, "notes");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "note.md"), "outside", "utf8");
    await symlink(outDir, path.join(tmpRoot, "sub"));
    assert.throws(() => vault.resolveInVault("sub/note.md"), /symlink/);
  });

  test("refuses a NONEXISTENT path under a symlinked dir (write-side escape)", async () => {
    const outDir = path.join(outsideRoot, "writable");
    await mkdir(outDir, { recursive: true });
    await symlink(outDir, path.join(tmpRoot, "drop"));
    // drop/new.md doesn't exist yet — the guard must still catch the dir.
    assert.throws(() => vault.resolveInVault("drop/new.md"), /symlink/);
  });

  test("allows a symlink that stays within the vault", async () => {
    await writeFile(path.join(tmpRoot, "real.md"), "hello", "utf8");
    await symlink(path.join(tmpRoot, "real.md"), path.join(tmpRoot, "alias.md"));
    const abs = vault.resolveInVault("alias.md");
    assert.ok(abs.endsWith("alias.md"));
  });

  test("readNote through an escaping symlink fails", async () => {
    const secret = path.join(outsideRoot, "creds.md");
    await writeFile(secret, "token", "utf8");
    await symlink(secret, path.join(tmpRoot, "creds.md"));
    await assert.rejects(() => vault.readNote("creds.md"), /symlink/);
  });

  test("writeNote into an escaping symlinked dir fails and writes nothing outside", async () => {
    const outDir = path.join(outsideRoot, "target");
    await mkdir(outDir, { recursive: true });
    await symlink(outDir, path.join(tmpRoot, "evil"));
    await assert.rejects(() => vault.writeNote("evil/x.md", "payload", false), /symlink/);
  });
});

// ── Issue #104 — accept-forbidden guard reaches the ACTUAL production write
// path ────────────────────────────────────────────────────────────────────
//
// packages/server's fs-failover mode (fs-mode.ts's makeBackend()) wraps
// THESE module-level singleton functions directly — not the FilesystemBackend
// class. An independent review of the initial #104 patch found the guard
// wired only to FilesystemBackend, which this handler never calls. These
// tests exercise the functions fs-mode.ts actually uses, so a future
// regression that re-wires the guard to the wrong implementation fails here.

describe("accept-forbidden guard — module-level singleton functions (issue #104 production path)", () => {
  test("writeNote with acceptance-status: accepted is REFUSED", async () => {
    await assert.rejects(
      () => vault.writeNote("note.md", "---\nacceptance-status: accepted\n---\nbody", false),
      isAcceptForbidden,
    );
  });

  test("writeNote with a normal (non-accepted) payload SUCCEEDS", async () => {
    const result = await vault.writeNote("note.md", "---\nname: N\n---\nbody", false);
    assert.equal(result.created, true);
  });

  test("REFUSING the write means nothing lands on disk", async () => {
    await assert.rejects(() => vault.writeNote("note.md", "---\naccepted-by: an-agent\n---\nbody", false));
    await assert.rejects(() => vault.readNote("note.md"), /ENOENT|no such file/i);
  });

  test("appendNote creating a NEW note whose fence asserts acceptance is REFUSED", async () => {
    await assert.rejects(
      () => vault.appendNote("note.md", "---\nacceptance-status: accepted\n---\nbody"),
      isAcceptForbidden,
    );
  });

  test("appendNote with an ordinary body SUCCEEDS", async () => {
    const result = await vault.appendNote("note.md", "hello");
    assert.equal(result.created, true);
  });

  test("setFrontmatterField(acceptance-status, accepted) is REFUSED", async () => {
    await vault.writeNote("note.md", "---\nname: N\n---\nbody", false);
    await assert.rejects(
      () => vault.setFrontmatterField("note.md", "acceptance-status", "accepted"),
      isAcceptForbidden,
    );
    const value = await vault.getFrontmatterField("note.md", "acceptance-status");
    assert.equal(value, undefined, "the field must not have been written");
  });

  test("setFrontmatterField with an ordinary key/value SUCCEEDS", async () => {
    await vault.writeNote("note.md", "---\nname: N\n---\nbody", false);
    await vault.setFrontmatterField("note.md", "status", "active");
    assert.equal(await vault.getFrontmatterField("note.md", "status"), "active");
  });

  test("preserving an existing (human-set) accepted value verbatim via setFrontmatterField is ALLOWED", async () => {
    await writeFile(path.join(tmpRoot, "note.md"), "---\nacceptance-status: accepted\n---\nbody", "utf8");
    await vault.setFrontmatterField("note.md", "acceptance-status", "accepted");
    assert.equal(await vault.getFrontmatterField("note.md", "acceptance-status"), "accepted");
  });

  test("patchNote: an anchor resolving to the START of a fence-less note's body is REFUSED for op:\"prepend\" (broader than just the leading-block case)", async () => {
    // findBlock walks backward through contiguous non-blank lines from the
    // anchor, so a SHORT/leading paragraph makes range.start land at 0 even
    // though the anchor token itself is on a later line — the reviewer's
    // finding on the initial #104 patch. Content inserted at range.start=0
    // with no existing frontmatter becomes the note's real leading fence.
    await writeFile(path.join(tmpRoot, "note.md"), "some text\n^anchor\nmore text", "utf8");
    await assert.rejects(
      () =>
        vault.patchNote(
          "note.md",
          { type: "block", value: "anchor" },
          "prepend",
          "---\nacceptance-status: accepted\n---",
        ),
      isAcceptForbidden,
    );
    // And confirm the original content is untouched.
    assert.equal(await vault.readNote("note.md"), "some text\n^anchor\nmore text");
  });

  test("patchNote with an ordinary insertion SUCCEEDS", async () => {
    await writeFile(path.join(tmpRoot, "note.md"), "some text\n^anchor\nmore text", "utf8");
    const result = await vault.patchNote("note.md", { type: "block", value: "anchor" }, "prepend", "inserted");
    assert.equal(result.found, true);
  });
});

// ── Recognition parity (issue #104 / #126 class) ────────────────────────────
//
// The guard must recognize every leading-fence VARIANT the write path itself
// would honor — a guard narrower than reality is a bypass, not caution. These
// pin the three known divergence classes (BOM, CRLF, trailing fence
// whitespace) plus the plain control case, each asserting the write-path
// REFUSES an accepted-family value carried behind that variant. A literal
// U+FEFF byte is never written into this file's source — `"\uFEFF"` is the
// escape, matching accept-guard.ts's own `stripLeadingBom`.

describe("accept-forbidden guard — recognition parity across fence variants", () => {
  const ACCEPTED_BODY = "acceptance-status: accepted\n---\nbody";

  test("plain control case: no BOM/CRLF/trailing-ws is refused", async () => {
    await assert.rejects(() => vault.writeNote("a.md", `---\n${ACCEPTED_BODY}`, false), isAcceptForbidden);
  });

  test("a leading BOM (U+FEFF), stripped exactly once, is refused", async () => {
    const withBom = "\uFEFF---\n" + ACCEPTED_BODY;
    await assert.rejects(() => vault.writeNote("b.md", withBom, false), isAcceptForbidden);
  });

  test("a SECOND leading BOM is content, not a marker — NOT stripped, and correctly leaves the fence unrecognized", async () => {
    // Only ONE BOM is a marker. After stripping it, the text still starts
    // with a second \uFEFF, not `---` — so this is genuinely NOT a
    // recognized frontmatter fence (matches Obsidian, which also only looks
    // past a single BOM). The write succeeds because there is truly no
    // frontmatter to guard, not because the guard failed to look.
    const doubleBom = "\uFEFF\uFEFF---\n" + ACCEPTED_BODY;
    const result = await vault.writeNote("c.md", doubleBom, false);
    assert.equal(result.created, true);
  });

  test("CRLF line endings are refused", async () => {
    const crlf = "---\r\n" + ACCEPTED_BODY.replace(/\n/g, "\r\n");
    await assert.rejects(() => vault.writeNote("d.md", crlf, false), isAcceptForbidden);
  });

  test("trailing spaces/tabs after the opening and closing --- are refused", async () => {
    const trailing = "--- \t\n" + "acceptance-status: accepted\n" + "---\t\nbody";
    await assert.rejects(() => vault.writeNote("e.md", trailing, false), isAcceptForbidden);
  });
});

// ── locateFrontmatter parity — the frontmatter EDITOR recognizes what the
// guard/Obsidian recognize (issue #104 sibling-audit: a narrower editor
// prepends a SECOND frontmatter block instead of editing the real one) ──────

describe("locateFrontmatter parity — frontmatter-edit writes never duplicate an existing fence", () => {
  test("setFrontmatterField on a BOM-prefixed note edits the EXISTING frontmatter, not a duplicate", async () => {
    const withBom = "\uFEFF---\nname: N\n---\nbody";
    await writeFile(path.join(tmpRoot, "bom.md"), withBom, "utf8");
    await vault.setFrontmatterField("bom.md", "status", "active");
    const after = await vault.readNote("bom.md");
    const fenceMarkerCount = (after.match(/---/g) || []).length;
    assert.equal(fenceMarkerCount, 2, "exactly one frontmatter block (2 fence markers) — not a second block prepended");
    assert.match(after, /status: active/);
    assert.match(after, /name: N/);
  });

  test("setFrontmatterField on a CRLF note edits the EXISTING frontmatter, not a duplicate", async () => {
    const crlf = "---\r\nname: N\r\n---\r\nbody";
    await writeFile(path.join(tmpRoot, "crlf.md"), crlf, "utf8");
    await vault.setFrontmatterField("crlf.md", "status", "active");
    const after = await vault.readNote("crlf.md");
    const fenceMarkerCount = (after.match(/---/g) || []).length;
    assert.equal(fenceMarkerCount, 2, "exactly one frontmatter block — not a second block prepended");
    assert.match(after, /status: active/);
  });

  test("setFrontmatterField on a note with trailing fence whitespace edits the EXISTING frontmatter, not a duplicate", async () => {
    const trailing = "--- \t\nname: N\n---\t\nbody";
    await writeFile(path.join(tmpRoot, "trailing.md"), trailing, "utf8");
    await vault.setFrontmatterField("trailing.md", "status", "active");
    const after = await vault.readNote("trailing.md");
    const fenceMarkerCount = (after.match(/---/g) || []).length;
    assert.equal(fenceMarkerCount, 2, "exactly one frontmatter block — not a second block prepended");
    assert.match(after, /status: active/);
  });
});

