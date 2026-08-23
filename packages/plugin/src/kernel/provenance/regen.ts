// regen.ts — regenerate the plugin-audit note text, preserving human sections.
// Port of the Python `regen.py`.

import type { ProvenanceSource } from "./provenance-source.js";
import { reconcile } from "./plugins.js";
import { renderAudit, extractSections, reinsertSections } from "./render.js";
import { resolveEntries } from "./sources.js";
import {
  DEFAULT_NOTES_DIR,
  DEFAULT_NOTES_SOURCE,
  DEFAULT_AUDIT_NOTE,
  auditDerivedFrom,
  notesGlob,
  globMatchesPath,
  type NotesSource,
} from "./provenance-config.js";

/**
 * The vault-relative path of the audit note for a FLAT notes dir, derived from
 * the folder's own basename.
 *
 * RETAINED FOR `flat` MODE ONLY. Deriving a note's name from its folder is
 * exactly the JD folder-note convention, so pointing this at a JD slot root
 * resolves to that folder's own folder note and a regen would rewrite it in
 * place. In `jd-slots` mode the destination is configuration
 * ({@link ProvenanceConfig.auditNote}), never derived — see
 * {@link DEFAULT_AUDIT_NOTE}.
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
  notesSource: NotesSource = DEFAULT_NOTES_SOURCE,
  auditNote: string = DEFAULT_AUDIT_NOTE,
): Promise<string> {
  const recon = await reconcile(source, notesDir, notesSource);
  // This deliberately re-walks two globs `reconcile` just walked. The point is
  // that the witness is resolved by the SAME function `checkFreshness` will use,
  // over the SAME entry list the frontmatter declares — reusing reconcile's
  // internals would tie the count to what the audit happens to parse (a
  // malformed manifest it skips is still a source file) and let the two drift.
  const { files } = await resolveEntries(source, auditDerivedFrom(notesDir, notesSource));
  // The audit note lives INSIDE its own `{notesDir}/*.md` source glob — it is a
  // source of itself. Count the set as it will be AFTER this regen lands, so a
  // first-ever regen (the note does not exist yet, so it resolves to one fewer
  // file than it will a moment later) does not witness one low and mask the next
  // deletion. Once the note exists, `files` already contains it and this is a
  // no-op.
  // The audit note may or may not sit inside its own source glob: in `flat`
  // mode it always does (it lives in the notes dir); with the shipped jd-slots
  // default it NEVER does (it sits beside the slots, not inside
  // `{root}/<slot>/`).
  //
  // The +1 exists for one case only: a FIRST-EVER regen, where the note does not
  // exist yet and so resolves one low. Asking `files.includes(self)` conflates
  // that with "structurally outside the glob", so under the default it added +1
  // on every regen forever and the audit read permanently STALE — turning the
  // deletion signal the witness carries into a constant false alarm. Ask the
  // structural question instead.
  const self = auditNote;
  const inOwnGlob = globMatchesPath(notesGlob(notesDir, notesSource), self);
  const sourceCount = inOwnGlob && !files.includes(self) ? files.length + 1 : files.length;
  let rendered = renderAudit(recon, generated, notesDir, sourceCount, notesSource);
  const existing = await source.read(self);
  if (existing !== null) rendered = reinsertSections(rendered, extractSections(existing));
  return rendered;
}
