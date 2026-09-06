// obsidian-source.ts — the live vault adapter, the ONLY Obsidian coupling in
// this plugin. Split out of the moved `tools-health.ts` at the S7 extraction for
// the reason every satellite splits it (the triage/crosssession pattern):
// `tools.ts` stays obsidian-free and headless-testable, and only `main.ts`
// imports this file.
//
// It is also the one part not headlessly unit-tested — verify it against a
// running Obsidian. Duck-typed against `app` (no `obsidian` import) so a fake app
// object satisfies it if you ever want to drive it in a stub process.
//
// The live `metadataCache.resolvedLinks` / `unresolvedLinks` are returned
// DIRECTLY — the scan only READS them, and they already handle basename / alias /
// embed resolution, which is exactly why the standalone `obsidian-vault-health`
// scanner reached into the live app for this half rather than re-implementing a
// resolver on disk. Inside a plugin the standalone's whole launch / wait-for-
// metadataCache / eval / quit dance disappears: the cache is simply there.

import type { HealthSource, HealthFile, HealthFileExt } from "./kernel/index.js";

export function obsidianHealthBackend(app: {
  vault: {
    adapter: { read(path: string): Promise<string>; stat(path: string): Promise<{ type: "file" | "folder" } | null> };
    getMarkdownFiles(): Array<{ path: string; stat: { size: number } }>;
    getFiles(): Array<{ path: string; extension: string; stat: { size: number } }>;
  };
  metadataCache: {
    resolvedLinks: Record<string, Record<string, number>>;
    unresolvedLinks: Record<string, Record<string, number>>;
    // `getTags()` is real Obsidian API but not in the public `obsidian` types —
    // declared OPTIONAL here so the real `App` is structurally assignable, and
    // guarded at the call site.
    getTags?(): Record<string, number>;
    getCache(path: string): { frontmatter?: Record<string, unknown> } | null;
  };
}): HealthSource {
  const adapter = app.vault.adapter;
  return {
    resolvedLinks: () => app.metadataCache.resolvedLinks ?? {},
    unresolvedLinks: () => app.metadataCache.unresolvedLinks ?? {},
    tags: () => (app.metadataCache.getTags ? app.metadataCache.getTags() : {}),
    markdownFiles: (): HealthFile[] => app.vault.getMarkdownFiles().map((f) => ({ path: f.path, size: f.stat.size })),
    allFiles: (): HealthFileExt[] =>
      app.vault.getFiles().map((f) => ({ path: f.path, ext: (f.extension ?? "").toLowerCase(), size: f.stat.size })),
    aliases: () => {
      // Per-note frontmatter aliases, normalized to a string[] — mirrors the
      // standalone's alias extraction so a link naming a note by its alias still
      // resolves to a single candidate. `aliases` or the singular `alias`; a
      // scalar is wrapped; non-string entries are dropped.
      const out: Record<string, string[]> = {};
      for (const f of app.vault.getMarkdownFiles()) {
        const fm = app.metadataCache.getCache(f.path)?.frontmatter;
        if (!fm) continue;
        // `||` (not `??`), matching the standalone's alias extraction: a falsy
        // `aliases:` (e.g. an empty string) falls through to the singular
        // `alias`, rather than seeding a spurious `[""]` alias bucket.
        const a = fm.aliases || fm.alias;
        if (a == null) continue;
        const xs = (Array.isArray(a) ? a : [a]).filter((x): x is string => typeof x === "string");
        if (xs.length) out[f.path] = xs;
      }
      return out;
    },
    async noteBody(path) {
      try {
        const st = await adapter.stat(path);
        if (!st || st.type !== "file") return null;
        return await adapter.read(path);
      } catch {
        return null;
      }
    },
  };
}
