// Per-note baseline blob store: note path → the last-ACCEPTED full content.
// This is the "base branch" of the PR analogy (see Assent ch.5). Accept advances it;
// human-attributed edits advance it silently; nothing else touches it.
//
// Layout: <baseDir>/<hash(path)>.json, one file per note, each holding the full blob.
// Hashing the path keeps filenames filesystem-safe (note paths contain "/", spaces, etc.)
// while the record carries the real path back. A tiny index.json lists path↔file so we
// never have to trust filename decoding.
//
// The store is storage-agnostic: it talks to an injected BlobFs so it unit-tests against
// node fs in a temp dir and runs against Obsidian's vault adapter in production.
//
// Ported verbatim from obsidian-stewardship/src/baseline-store.ts (#83, cycle 1). This is
// relocated PERSISTENCE substrate: `setBaseline` is the baseline-advance primitive, but it
// is a pure method over an injected BlobFs and is wired to NO MCP tool, NO plugin instance,
// and NO `app` this cycle — the accept/adopt gestures that reach it are cycle-2 work behind
// the accept-reachability review. ZERO baseline SURFACE is added by moving it.

import { contentHash } from "./hash.js";

export interface BlobFs {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(dir: string): Promise<string[]>; // full paths of files directly under dir
}

export interface Baseline {
  path: string;
  content: string;
  hash: string;
  acceptedAt: string; // ISO 8601
  acceptedBy: string;
}

function fileFor(baseDir: string, notePath: string): string {
  return `${baseDir}/${contentHash(notePath)}.json`;
}

export class BaselineStore {
  private cache = new Map<string, Baseline>();
  private loaded = false;

  constructor(private readonly fs: BlobFs, private readonly baseDir: string) {}

  async load(): Promise<void> {
    await this.ensureDir();
    this.cache.clear();
    let files: string[] = [];
    try { files = await this.fs.list(this.baseDir); } catch { files = []; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      if (f.endsWith("/index.json")) continue;
      try {
        const b = JSON.parse(await this.fs.read(f)) as Baseline;
        // D3 — a partial/malformed blob missing `content` would yield {content: undefined}
        // and mis-restore (wipe the note) on revert. Require both fields; else treat as
        // no-baseline (skip) so a corrupt file can never drive a destructive restore.
        if (b && typeof b.path === "string" && typeof b.content === "string") {
          this.cache.set(b.path, b);
        }
      } catch { /* skip corrupt baseline file */ }
    }
    this.loaded = true;
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.fs.exists(this.baseDir))) {
      await this.fs.mkdir(this.baseDir);
    }
  }

  has(path: string): boolean { return this.cache.has(path); }
  get(path: string): Baseline | null { return this.cache.get(path) ?? null; }
  all(): Baseline[] { return [...this.cache.values()]; }
  get size(): number { return this.cache.size; }

  // Advance (or create) the baseline for a note to `content`, attributed to `acceptedBy`.
  // This is the ONLY mutation of a baseline; both Accept and the silent human-edit path
  // funnel through here.
  async setBaseline(
    path: string,
    content: string,
    acceptedBy: string,
    acceptedAt: string = new Date().toISOString(),
  ): Promise<Baseline> {
    await this.ensureDir();
    const baseline: Baseline = {
      path,
      content,
      hash: contentHash(content),
      acceptedAt,
      acceptedBy,
    };
    await this.fs.write(fileFor(this.baseDir, path), JSON.stringify(baseline, null, 2));
    this.cache.set(path, baseline);
    return baseline;
  }

  isLoaded(): boolean { return this.loaded; }
}
