// regen.ts — regenerate the plugin-audit note text, preserving human sections.
// Port of the Python `regen.py`.

import type { ProvenanceSource } from "./provenance-source.js";
import { reconcile } from "./plugins.js";
import { renderAudit, extractSections, reinsertSections } from "./render.js";
import { resolveEntries } from "./sources.js";
import { DEFAULT_NOTES_DIR, auditDerivedFrom } from "./provenance-config.js";

/**
 * The vault-relative path of the audit note for a given notes dir.
 *
 * Python hardcoded `"08.10 Obsidian plugins.md"` regardless of `notes_dir`;
 * the port DERIVES the filename from the notes dir's own basename, which equals
 * the Python result for the default (`08.10 Obsidian plugins`) and generalizes
 * correctly to a non-default notes dir (the audit note is named after its
 * folder rather than mis-named after the default).
 */
export function auditPath(notesDir: string = DEFAULT_NOTES_DIR): string {
  // Trailing slashes are stripped from the DIRECTORY too, not just when deriving
  // the basename: `provenanceConfigOf` normalizes what reaches the tool, but this
  // is an exported kernel function with a defaulted argument, and a
  // `Meta/Plugins//Plugins.md` here would disagree with `auditDerivedFrom`'s
  // single-slash glob — enough to make the audit's own source count off by one.
  const dir = notesDir.replace(/\/+$/, "") || notesDir;
  const base = dir.split("/").pop() || dir;
  return `${dir}/${base}.md`;
}

/**
 * Render the audit note for the current vault state, carrying any existing
 * hand-written `<!-- human:start … -->` sections forward. Pure over the injected
 * source — returns the text; PERSISTING it (and the accept-guard that gates the
 * persist) is the tool layer's job.
 *
 * The audit is Governor's own derived note, so it stamps the
 * `derived-source-count` witness over its own `derived-from` set — resolved with
 * the same `resolveEntries` the freshness check uses, so a later
 * `provenance_check` can see a source DELETED out of the globbed set (the one
 * class of change no mtime comparison can detect).
 */
export async function regenerateAudit(
  source: ProvenanceSource,
  generated: string,
  notesDir: string = DEFAULT_NOTES_DIR,
): Promise<string> {
  const recon = await reconcile(source, notesDir);
  // This deliberately re-walks two globs `reconcile` just walked. The point is
  // that the witness is resolved by the SAME function `checkFreshness` will use,
  // over the SAME entry list the frontmatter declares — reusing reconcile's
  // internals would tie the count to what the audit happens to parse (a
  // malformed manifest it skips is still a source file) and let the two drift.
  const { files } = await resolveEntries(source, auditDerivedFrom(notesDir));
  // The audit note lives INSIDE its own `{notesDir}/*.md` source glob — it is a
  // source of itself. Count the set as it will be AFTER this regen lands, so a
  // first-ever regen (the note does not exist yet, so it resolves to one fewer
  // file than it will a moment later) does not witness one low and mask the next
  // deletion. Once the note exists, `files` already contains it and this is a
  // no-op.
  const self = auditPath(notesDir);
  const sourceCount = files.includes(self) ? files.length : files.length + 1;
  let rendered = renderAudit(recon, generated, notesDir, sourceCount);
  const existing = await source.read(auditPath(notesDir));
  if (existing !== null) rendered = reinsertSections(rendered, extractSections(existing));
  return rendered;
}
