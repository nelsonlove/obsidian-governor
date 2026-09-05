/**
 * link-healing.test.mjs — the satellite's own copy of the host's guarantee:
 * every move goes through `app.fileManager.renameFile`, Obsidian's
 * link-updating rename, and NEVER `app.vault.rename`, which moves the bytes and
 * leaves every backlink pointing at a note that is no longer there.
 *
 * While triage was a host module its `move` was the shared `moveOne` in
 * `tools-vault-write.ts`, covered by the host's own link-healing suite — which
 * includes a source scan globbing `packages/plugin/src/**\/*.ts`. That scan
 * cannot see this package. So the RULE came with the module even though the
 * FUNCTION could not (see the header of src/obsidian-source.ts for why
 * `moveOne` stayed behind: it has three other host callers, and it imports
 * `obsidian`, so it cannot be published through `@vault-mcp/core`, which is
 * obsidian-free by contract).
 *
 * Two halves, matching the host's:
 *
 *   • THE LIVE HANDLER — `obsidianTriageSource(app).move` is driven against a
 *     fake app whose `vault.rename` THROWS, so a future refactor reaching for
 *     it fails loudly here rather than silently orphaning backlinks in a real
 *     vault. Plus: parent folders are created, and an occupied destination
 *     fails rather than overwriting.
 *   • THE SOURCE SCAN — globs this package's own `src/**\/*.ts` for
 *     `vault.rename`, and PROVES the scan works by planting a violation in a
 *     scratch module and watching it fail.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { glob, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";

// The adapter imports live Obsidian classes, so the specifier is pointed at the
// stub BEFORE it is imported.
installObsidianStub();
const { obsidianTriageSource, moveNote } = await import("../src/obsidian-source.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolvePath(HERE, "../src");

/**
 * The three surfaces a move touches, each a spy. `vault.rename` exists and
 * throws — present so "it was never called" is a real assertion about a real
 * method rather than about a typo.
 */
function fakeApp({ files = ["Inbox/A.md"], folders = ["Inbox"] } = {}) {
  const tree = new Map(files.map((p) => [p, new TFile(p)]));
  const dirs = new Set(folders);
  const calls = { renameFile: [], vaultRename: [], createFolder: [], trashFile: [] };
  return {
    calls,
    tree,
    app: {
      vault: {
        getAbstractFileByPath: (p) => tree.get(p) ?? (dirs.has(p) ? new TFolder(p) : null),
        getMarkdownFiles: () => [...tree.values()],
        async createFolder(p) {
          calls.createFolder.push(p);
          dirs.add(p);
        },
        async rename(file, to) {
          calls.vaultRename.push([file.path, to]);
          throw new Error("vault.rename is not link-aware — moves must go through fileManager.renameFile");
        },
      },
      metadataCache: { getCache: () => null },
      fileManager: {
        async renameFile(file, to) {
          calls.renameFile.push([file.path, to]);
          tree.delete(file.path);
          tree.set(to, new TFile(to));
        },
        async trashFile(file) {
          calls.trashFile.push(file.path);
          tree.delete(file.path);
        },
        async processFrontMatter(file, mutate) {
          mutate({});
        },
      },
    },
  };
}

describe("in band: a triage move heals its own links", () => {
  test("move renames through fileManager.renameFile, never vault.rename", async () => {
    const { app, calls } = fakeApp();
    await obsidianTriageSource(app).move("Inbox/A.md", "Projects/A.md");
    assert.deepEqual(calls.renameFile, [["Inbox/A.md", "Projects/A.md"]]);
    assert.deepEqual(calls.vaultRename, [], "vault.rename would move the bytes and orphan every backlink");
  });

  test("missing parent folders are created before the rename", async () => {
    const { app, calls } = fakeApp();
    await moveNote(app, "Inbox/A.md", "Projects/2026/Q1/A.md");
    assert.deepEqual(calls.createFolder, ["Projects", "Projects/2026", "Projects/2026/Q1"]);
    assert.deepEqual(calls.renameFile, [["Inbox/A.md", "Projects/2026/Q1/A.md"]]);
  });

  test("an occupied destination FAILS — there is no overwrite parameter at all", async () => {
    const { app, calls } = fakeApp({ files: ["Inbox/A.md", "Projects/A.md"], folders: ["Inbox", "Projects"] });
    await assert.rejects(() => moveNote(app, "Inbox/A.md", "Projects/A.md"), /destination exists/);
    assert.deepEqual(calls.renameFile, [], "nothing may be renamed");
    assert.deepEqual(calls.vaultRename, []);
  });

  test("a missing source, a non-.md path, and a no-op move all refuse before touching the vault", async () => {
    const { app, calls } = fakeApp();
    await assert.rejects(() => moveNote(app, "Inbox/ghost.md", "Projects/x.md"), /not found/);
    await assert.rejects(() => moveNote(app, "Inbox/A.md", "Projects/x.txt"), /destination must end in \.md/);
    await assert.rejects(() => moveNote(app, "Inbox/A.txt", "Projects/x.md"), /source must end in \.md/);
    await assert.rejects(() => moveNote(app, "Inbox/A.md", "Inbox/A.md"), /same path/);
    assert.deepEqual(calls.renameFile, []);
    assert.deepEqual(calls.createFolder, []);
  });

  test("trash goes through fileManager.trashFile — Obsidian's recoverable trash, never a hard delete", async () => {
    const { app, calls } = fakeApp();
    await obsidianTriageSource(app).trashNote("Inbox/A.md");
    assert.deepEqual(calls.trashFile, ["Inbox/A.md"]);
  });
});

describe("the source scan: no move path in this package reaches for vault.rename", () => {
  /** Every `src/**\/*.ts` line matching `vault.rename(`, as `file: line`. */
  async function vaultRenameOffenders() {
    const offenders = [];
    for await (const rel of glob("**/*.ts", { cwd: SRC })) {
      const text = await readFile(resolvePath(SRC, rel), "utf8");
      for (const line of text.split("\n")) {
        // Skip prose: every mention in this package's comments is an
        // explanation of why NOT to call it.
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
        if (/vault\s*\.\s*rename\s*\(/.test(line)) offenders.push(`${rel}: ${code}`);
      }
    }
    return offenders;
  }

  test("no move path anywhere in this package's source reaches for vault.rename", async () => {
    assert.deepEqual(await vaultRenameOffenders(), [], "use app.fileManager.renameFile — vault.rename orphans backlinks");
  });

  test("the scan actually catches one: a planted vault.rename in a scratch module fails it", async () => {
    const planted = resolvePath(SRC, "__vault-rename-scratch.ts");
    try {
      await writeFile(
        planted,
        ["export async function bad(app: any, file: any, to: string) {", "  await app.vault.rename(file, to);", "}", ""].join("\n"),
        "utf8",
      );
      const offenders = await vaultRenameOffenders();
      assert.equal(offenders.length, 1, `the glob missed a planted violation: ${JSON.stringify(offenders)}`);
      assert.match(offenders[0], /__vault-rename-scratch\.ts: await app\.vault\.rename\(file, to\);/);
    } finally {
      await rm(planted, { force: true });
    }
  });
});
