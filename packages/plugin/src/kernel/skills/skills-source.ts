// The SkillsSource seam: everything the skills exporter reads from the vault, expressed as an
// injected dependency so the compiler core (exporter.ts) runs with no `obsidian` / `app` /
// `metadataCache` import. The Obsidian-backed implementation is `obsidianSkillsSource(app)`
// (obsidian-skills-source.ts); tests inject an in-memory fake. This mirrors the injected-source
// pattern the vault-mcp module system is built around (LinkSource / VocabSource / UidSource) — and
// the embed half was already this shape (transclude.ts's `EmbedLookup`, whose Obsidian adapter was
// `embedLookup(app)`).

import type { EmbedLookup } from "./transclude.js";

export type { EmbedLookup };

/** One markdown note as the exporter sees it: vault path, parsed frontmatter (undefined when the
 *  note has none — collectNotes skips those), and the raw body (frontmatter not yet stripped). */
export interface SourceNote {
  path: string;
  frontmatter: Record<string, unknown> | undefined;
  body: string;
}

/** The vault reads the skills exporter core depends on. Four functions that used to take `app`
 *  (`resolveParents`, `embedLookup`, `collectNotes`, `collectAndTransform`) are now defined over
 *  this interface instead. */
export interface SkillsSource {
  /** Every markdown note (frontmatter + raw body). → collectNotes */
  notes(): Promise<SourceNote[]>;
  /** Resolve a linkpath relative to a source note to a vault path; null when unresolved.
   *  → resolveParents (a null becomes the `⟂unresolved:` marker the transform reports). */
  resolveLink(linkpath: string, fromPath: string): string | null;
  /** Resolve + read an embed target — already the transclude `EmbedLookup` shape. → transclusions */
  embed: EmbedLookup;
  /** Absolute filesystem path of the vault, baked into exported agents; null if unavailable.
   *  → vault.adapter.getBasePath() */
  basePath(): string | null;
}
