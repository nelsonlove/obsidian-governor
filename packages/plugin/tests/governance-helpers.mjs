// Test helpers for the ported governance (Acceptance) logic (#83, cycle 1): a
// node-fs-backed BlobFs in a temp dir. Ported from obsidian-stewardship/tests/helpers.mjs
// (only makeTmpFs — the accept-world fake belongs with accept.ts, cycle 2). Not a
// *.test.mjs file, so the test glob skips it.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export async function makeTmpFs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-mcp-governance-test-"));
  const blobFs = {
    async read(p) { return fs.readFile(p, "utf8"); },
    async write(p, data) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); },
    async exists(p) { try { await fs.stat(p); return true; } catch { return false; } },
    async mkdir(p) { await fs.mkdir(p, { recursive: true }); },
    async list(dir) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
      return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
    },
  };
  return { root, blobFs, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
