// The HealthSource seam: everything the vault-health scan reads, expressed as an
// injected dependency so the pure tiered-findings core (scan.ts) runs with no
// `obsidian` / `app` / `metadataCache` import. The Obsidian-backed implementation
// is `obsidianHealthBackend(app)` (src/obsidian-source.ts); tests inject an
// in-memory fake. This mirrors the injected-source pattern the Governor module
// system was built around (ProvenanceSource / LinkSource / VocabSource) and that
// every satellite in the suite keeps.
//
// Ported from the standalone `obsidian-vault-health` Bash+eval scanner, whose
// live half read Obsidian's resolver via one Advanced-URI `eval` (link/attachment/
// tag state) and whose on-disk half read the vault directory (empty notes,
// duplicate bodies). Here that whole launch/readiness/quit dance disappears — the
// plugin holds a LIVE `app.metadataCache` (`resolvedLinks`/`unresolvedLinks`) and
// vault adapter directly, so the adapter reads the cache natively and the on-disk
// pass reads through the vault adapter. This is a READ-ONLY seam: nothing here
// (or in the core, or in the tools) ever writes the vault — the scan only emits
// findings; the fixing is a separate skill, out of scope for this plugin.

/** A vault file's path and byte size — the shape both `markdownFiles()` and
 *  `allFiles()` yield (allFiles additionally carries the lowercased extension). */
export interface HealthFile {
  /** Vault-relative path. */
  path: string;
  /** Byte size (`TFile.stat.size`). */
  size: number;
}

/** A vault file plus its lowercased extension (no leading dot), for the
 *  orphan-attachment tier which must tell notes from attachments. */
export interface HealthFileExt extends HealthFile {
  /** Lowercased extension with no leading dot (`TFile.extension`), e.g. "png". */
  ext: string;
}

/**
 * The vault reads the health scan depends on. All read-only:
 *
 *   - `resolvedLinks` — Obsidian's `metadataCache.resolvedLinks`
 *     (`{source: {dest: count}}`, links + embeds that DID resolve). Feeds the
 *     orphan-attachment tier's inbound-reference set.
 *   - `unresolvedLinks` — Obsidian's `metadataCache.unresolvedLinks`
 *     (`{source: {target: count}}`, links that did NOT resolve). The broken-link
 *     tiers (auto-safe repointable vs report-only dangling) are computed from this.
 *   - `tags` — used-tag counts (`metadataCache.getTags()`, `{'#tag': count}`),
 *     for the low-signal (used-once) report-only tier.
 *   - `markdownFiles` — every markdown note's path + size.
 *   - `allFiles` — every vault file (notes + attachments) path + ext + size.
 *   - `aliases` — `{notePath: [alias, …]}`, so a broken link naming a note by its
 *     alias still resolves to a single candidate (Obsidian's resolver honors
 *     aliases; the standalone read them out of frontmatter for the same reason).
 *   - `noteBody` — raw UTF-8 text of a markdown note (via the vault adapter). The
 *     core strips frontmatter and trims to compute the near-empty body-char count
 *     and the duplicate-body hash. `null` when absent / unreadable.
 */
export interface HealthSource {
  resolvedLinks(): Record<string, Record<string, number>>;
  unresolvedLinks(): Record<string, Record<string, number>>;
  tags(): Record<string, number>;
  markdownFiles(): HealthFile[];
  allFiles(): HealthFileExt[];
  aliases(): Record<string, string[]>;
  /** Raw UTF-8 text of a markdown note at a vault-relative path; null when
   *  absent / not a file / unreadable. */
  noteBody(path: string): Promise<string | null>;
}
