// regen.ts — regenerate the plugin-audit note text, preserving human sections.
// Port of the Python `regen.py`.

import type { ProvenanceSource } from "./provenance-source.js";
import { reconcile } from "./plugins.js";
import { renderAudit, extractSections, reinsertSections } from "./render.js";
import { DEFAULT_NOTES_DIR } from "./provenance-config.js";

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
  const base = notesDir.replace(/\/+$/, "").split("/").pop() || notesDir;
  return `${notesDir}/${base}.md`;
}

/**
 * Render the audit note for the current vault state, carrying any existing
 * hand-written `<!-- human:start … -->` sections forward. Pure over the injected
 * source — returns the text; PERSISTING it (and the accept-guard that gates the
 * persist) is the tool layer's job.
 */
export async function regenerateAudit(
  source: ProvenanceSource,
  generated: string,
  notesDir: string = DEFAULT_NOTES_DIR,
): Promise<string> {
  const recon = await reconcile(source, notesDir);
  let rendered = renderAudit(recon, generated, notesDir);
  const existing = await source.read(auditPath(notesDir));
  if (existing !== null) rendered = reinsertSections(rendered, extractSections(existing));
  return rendered;
}
