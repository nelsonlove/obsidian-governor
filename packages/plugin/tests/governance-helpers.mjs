// Test helpers for the ported governance (Acceptance) logic (#83): a node-fs-backed BlobFs in a
// temp dir, and an in-memory accept-world fake. Ported from obsidian-stewardship/tests/helpers.mjs.
// Not a *.test.mjs file, so the test glob skips it.
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

// An in-memory note+baseline+quarantine+log world for exercising acceptNote/revertNote.
export function makeFakeWorld(initialNotes = {}) {
  const notes = new Map(Object.entries(initialNotes));
  const baselines = new Map();
  const quarantines = new Map();
  const log = [];
  let clock = "2026-08-09T12:00:00.000Z";

  const deps = {
    readNote: async (p) => {
      if (!notes.has(p)) throw new Error(`no note ${p}`);
      return notes.get(p);
    },
    writeNote: async (p, c) => { notes.set(p, c); },
    store: {
      get: (p) => baselines.get(p) ?? null,
      setBaseline: async (p, content, by, at = clock) => {
        const b = { path: p, content, hash: "h:" + content.length + ":" + hashish(content), acceptedAt: at, acceptedBy: by };
        baselines.set(p, b);
        return b;
      },
    },
    quarantine: async (p, content) => {
      const qp = `quarantine/${p.replace(/\//g, "__")}-${clock}.md`;
      quarantines.set(qp, content);
      return qp;
    },
    appendLog: async (r) => { log.push(r); },
    now: () => clock,
    user: "test-human",
  };
  return {
    deps, notes, baselines, quarantines, log,
    setClock: (c) => { clock = c; },
    seedBaseline: (p, content, by = "seed", at = "2026-08-09T00:00:00.000Z") => {
      baselines.set(p, { path: p, content, hash: "h:" + content.length + ":" + hashish(content), acceptedAt: at, acceptedBy: by });
    },
  };
}

function hashish(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h.toString(16); }
