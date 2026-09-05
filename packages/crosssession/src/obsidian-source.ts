// obsidian-source.ts — the live vault adapters, the only Obsidian coupling in
// this package (the triage satellite's obsidian-source.ts pattern: a separate
// file so tools.ts stays obsidian-free and headless-testable; only main.ts
// imports this).
//
// Both adapters are DUCK-TYPED against `app` rather than importing `obsidian`
// types, exactly as they were in the host — it keeps them loadable in a plain
// node test process if a future test ever wants to drive them, and it costs
// nothing.
//
// THE APPEND PRIMITIVE IS THE ONE THING THAT MAY NOT DRIFT. `vault.process` is
// Obsidian's atomic read-modify-write, so a concurrent editor save and this
// append cannot interleave mid-file; the missing-trailing-newline fixup keeps a
// hand-edited log (or one last written by a shell `>>` heredoc) from gluing a
// new `## <stamp> · <handle>` heading onto the previous line. The fleet's live
// CROSS-SESSION.md is written by this plugin AND by hand AND by shell appends,
// and all three have to produce the same file.

import type { ReceiptAdapter } from "./kernel/index.js";
import { ReceiptStore } from "./kernel/index.js";
import type { CrosssessionSource } from "./tools.js";

/** Duck-typed against `app` (no `obsidian` import) so this file needs no type
 * gymnastics and stays loadable outside Obsidian. */
export function obsidianCrosssessionSource(app: {
  vault: {
    adapter: { stat(p: string): Promise<{ type: "file" | "folder" } | null>; read(p: string): Promise<string> };
    getMarkdownFiles(): Array<{ path: string }>;
    getAbstractFileByPath(path: string): unknown;
    process(file: unknown, fn: (data: string) => string): Promise<string>;
  };
  metadataCache: { getCache(path: string): { frontmatter?: Record<string, unknown> } | null };
}): CrosssessionSource {
  return {
    paths: () => app.vault.getMarkdownFiles().map((f) => f.path),
    frontmatter: (p) => app.metadataCache.getCache(p)?.frontmatter ?? null,
    async read(p) {
      const st = await app.vault.adapter.stat(p);
      if (!st || st.type !== "file") return null;
      try {
        return await app.vault.adapter.read(p);
      } catch {
        return null;
      }
    },
    async append(p, entryText) {
      const f = app.vault.getAbstractFileByPath(p);
      if (!f) throw new Error(`not a note: ${p}`);
      // vault.process is Obsidian's atomic read-modify-write — a concurrent
      // editor save and this append cannot interleave mid-file.
      await app.vault.process(f, (data) => (data === "" || data.endsWith("\n") ? data : data + "\n") + entryText);
    },
  };
}

/**
 * The receipt store over THIS plugin's own data directory.
 *
 * `pluginDir` is `this.manifest.dir` from main.ts and MUST be preferred over
 * the id-derived fallback: an in-place plugin-id change leaves the folder name
 * and the manifest id diverged, and receipts written to the id-derived path
 * would sit outside the live plugin dir — never migrated, and silently
 * discarded when the human deletes the stray folder, which re-serves
 * cross-session entries this session already attested. The fallback exists only
 * for a host that reports no dir.
 *
 * The fallback id is THIS plugin's (`vault-crosssession`), not the Governor
 * host's. Before the S6 extraction this store lived in the HOST's plugin dir
 * and the fallback used the host's `PLUGIN_ID`; the host's copy is now adopted
 * once by main.ts and thereafter untouched.
 */
export function obsidianReceiptStore(
  app: { vault: { adapter: ReceiptAdapter; configDir: string } },
  pluginDir?: string,
): ReceiptStore {
  return new ReceiptStore(app.vault.adapter, pluginDir ?? `${app.vault.configDir}/plugins/vault-crosssession`);
}
