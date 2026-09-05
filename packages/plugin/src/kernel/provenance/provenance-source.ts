// The ProvenanceSource seam: everything the provenance core reads from the
// vault, expressed as an injected dependency so the freshness / reconcile /
// regen engines run with no `obsidian` / `app` / `metadataCache` import. The
// Obsidian-backed implementation is `obsidianProvenanceBackend(app)`
// (mcp/tools-provenance.ts); tests inject an in-memory fake. This mirrors the
// injected-source pattern the vault-mcp module system is built around
// (LinkSource / VocabSource / UidSource).
//
// Ported from the standalone `obsidian-provenance` Python CLI, whose
// `frontmatter.py` / `sources.py` / `plugins.py` read the vault filesystem
// directly. Here those reads become the four primitives below, and the pure
// engines (freshness.ts, plugins.ts, regen.ts) compose them.

/** A file's kind + modification time. `mtime` is epoch milliseconds — the unit
 *  Obsidian's `DataAdapter.stat` reports, and what freshness compares against a
 *  note's `generated` timestamp (also normalized to ms). Python used epoch
 *  SECONDS (`st_mtime`); the port standardizes on ms end-to-end so the two
 *  sides of every `>` comparison agree. */
export interface FileStat {
  type: "file" | "folder";
  /** Epoch milliseconds. */
  mtime: number;
}

/**
 * The vault reads the provenance core depends on. Four functions:
 *
 *   - `noteFrontmatter` — parsed frontmatter of a markdown note (Obsidian's
 *     metadataCache in the adapter; a map in tests). Feeds freshness's
 *     `derived-from` / `generated` read, reconcile's `plugin.id` / `.version`
 *     scan, and the accept-guard's BEFORE image on regen. Replaces the Python
 *     `frontmatter.load_note` YAML parse — the parse now lives in the host.
 *   - `read` — raw UTF-8 text of any vault file (plugin `manifest.json`,
 *     `community-plugins.json`, the existing audit note for human-section
 *     preservation). `null` when absent / not a file.
 *   - `stat` — a file's kind + mtime, for freshness's staleness compare and to
 *     tell a literal file source from a folder. `null` when absent.
 *   - `glob` — expand a vault-root-relative glob (`*?[` semantics, like Python
 *     `Path.glob`) to sorted vault-relative FILE paths. Used for the plugin
 *     manifest + `{notesDir}/*.md` enumerations and for a wildcard
 *     `derived-from` source entry.
 */
export interface ProvenanceSource {
  /** Parsed frontmatter of a markdown note at a vault-relative path; null when
   *  the note has none / is absent. */
  noteFrontmatter(path: string): Record<string, unknown> | null;
  /** Raw UTF-8 text of a vault file; null when absent / not a file. */
  read(path: string): Promise<string | null>;
  /** File kind + mtime for a vault-relative path; null when absent. */
  stat(path: string): Promise<FileStat | null>;
  /** Vault-root-relative glob → sorted vault-relative FILE paths (`*?[`). */
  glob(pattern: string): Promise<string[]>;
}

/** The write half of the provenance backend — what `provenance_regen --write`
 *  needs on top of the read-only ProvenanceSource. Kept structural (no
 *  `obsidian` import) so the handler stays headless-testable against a fake. */
export interface ProvenanceWriter {
  /** Create-or-replace a note at a vault-relative path with `text`. The write
   *  goes through the guard-patched registrar (queue / journal / if_rev) at the
   *  interception point; the accept-forbidden CONTENT guard runs in the handler
   *  BEFORE this is called (see `guardProvenanceWrite`). */
  writeNote(path: string, text: string): Promise<void>;
}

/** The full backend the provenance tools drive: the read seam plus the regen
 *  write primitive. */
export type ProvenanceBackend = ProvenanceSource & ProvenanceWriter;
