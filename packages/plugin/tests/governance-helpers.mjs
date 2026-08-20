// Test helpers for the ported governance (Acceptance) logic (#83): a node-fs-backed BlobFs in a
// temp dir, and an in-memory accept-world fake. Ported from obsidian-stewardship/tests/helpers.mjs.
// Not a *.test.mjs file, so the test glob skips it.
//
// The acceptance convergence (#221/#164) extends the fake world with the deps the context-aware
// acceptNote takes: `stampAccepted` (a processFrontMatter-equivalent over the in-memory note —
// production wires Obsidian's real app.fileManager.processFrontMatter), `nowLocal` (the
// minutes-precision local clock) and `requiredFrontmatterKeys` (the conformance gate, default
// empty). Baseline hashes now use the REAL contentHash so computeQueue-based fold tests can
// compare fake baselines against recomputed queues.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { contentHash } from "../src/kernel/governance/hash.ts";

export async function makeTmpFs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-mcp-governance-test-"));
  const blobFs = {
    async read(p) { return fs.readFile(p, "utf8"); },
    async write(p, data) { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); },
    async exists(p) { try { await fs.stat(p); return true; } catch { return false; } },
    async mkdir(p) { await fs.mkdir(p, { recursive: true }); },
    async remove(p) { await fs.rm(p, { force: true }); },
  async list(dir) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
      return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
    },
  };
  return { root, blobFs, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

// A minimal processFrontMatter-equivalent over an in-memory note string: parse the leading
// `---` block into a scalar key→value object (order preserved), run the mutator, re-serialize.
// Enough for the simple scalar frontmatter the accept tests use — the REAL production writer
// is Obsidian's own app.fileManager.processFrontMatter (wiring.ts stampAcceptedFrontmatter).
export function fakeProcessFrontmatter(content, mutate) {
  const lines = content.split("\n");
  if (lines[0] !== "---") throw new Error("fakeProcessFrontmatter: note has no frontmatter");
  const close = lines.indexOf("---", 1);
  if (close === -1) throw new Error("fakeProcessFrontmatter: unclosed frontmatter");
  const fm = {};
  const order = [];
  for (const line of lines.slice(1, close)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) { fm[m[1].trim()] = m[2]; order.push(m[1].trim()); }
  }
  mutate(fm);
  const keys = [...order.filter((k) => k in fm), ...Object.keys(fm).filter((k) => !order.includes(k))];
  const rebuilt = ["---", ...keys.map((k) => `${k}: ${fm[k]}`), "---", ...lines.slice(close + 1)];
  return rebuilt.join("\n");
}

// An in-memory note+baseline+quarantine+log world for exercising acceptNote/revertNote.
export function makeFakeWorld(initialNotes = {}) {
  const notes = new Map(Object.entries(initialNotes));
  const baselines = new Map();
  const quarantines = new Map();
  const log = [];
  const stampCalls = [];
  let clock = "2026-08-09T12:00:00.000Z";
  let localClock = "2026-08-09T14:07";

  const deps = {
    readNote: async (p) => {
      if (!notes.has(p)) throw new Error(`no note ${p}`);
      return notes.get(p);
    },
    writeNote: async (p, c) => { notes.set(p, c); },
    stampAccepted: async (p, fields) => {
      stampCalls.push({ path: p, ...fields });
      notes.set(p, fakeProcessFrontmatter(notes.get(p), (fm) => {
        fm["acceptance-status"] = fields.status;
        fm["accepted-by"] = fields.by;
        fm["accepted-on"] = fields.on;
      }));
    },
    store: {
      get: (p) => baselines.get(p) ?? null,
      setBaseline: async (p, content, by, at = clock) => {
        const b = { path: p, content, hash: contentHash(content), acceptedAt: at, acceptedBy: by };
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
    nowLocal: () => localClock,
    user: "test-human",
    requiredFrontmatterKeys: [],
  };
  return {
    deps, notes, baselines, quarantines, log, stampCalls,
    setClock: (c) => { clock = c; },
    setLocalClock: (c) => { localClock = c; },
    seedBaseline: (p, content, by = "seed", at = "2026-08-09T00:00:00.000Z") => {
      baselines.set(p, { path: p, content, hash: contentHash(content), acceptedAt: at, acceptedBy: by });
    },
  };
}
