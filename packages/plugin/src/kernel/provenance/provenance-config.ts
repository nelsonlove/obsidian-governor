// provenance-config.ts — the provenance module's configuration shape and the
// pure mapping from a stored `modules.provenance.config` record to a typed
// ProvenanceConfig. Obsidian-free (no imports at all), so it moves with the
// rest of the pure core and is headless-testable.
//
// In the standalone `obsidian-provenance` CLI these were constants in
// `plugins.py` (`DEFAULT_NOTES_DIR`) and `render.py` (the generator +
// derivation-mode strings baked into the rendered audit frontmatter). Here the
// notes-dir becomes a config field (the one thing that varies per vault); the
// generator name and derivation mode stay constants — they identify the audit
// artifact's producer and are not a user knob.

/**
 * How the per-plugin notes are laid out under {@link ProvenanceConfig.notesDir}.
 *
 *   - `flat`      — one note per plugin directly in the folder (`{dir}/*.md`),
 *                   each carrying `plugin.id`. The Python CLI's only shape.
 *   - `jd-slots`  — one JD SLOT per repo (`{dir}/<slot>/<slot>.md`), the folder
 *                   note carrying `github-repo:` (and optionally `plugin.id`).
 *
 * `flat` is retained for compatibility and is no longer the default (#257).
 */
export type NotesSource = "flat" | "jd-slots";

/** The shipped notes layout. `jd-slots` — the shape the vault actually uses. */
export const DEFAULT_NOTES_SOURCE: NotesSource = "jd-slots";

/**
 * The plugin-notes root the reconcile/regen audit scans.
 *
 * Was `08.10 Obsidian plugins` (the Python `DEFAULT_NOTES_DIR`), a
 * previous-generation flat folder that no longer exists — the dead default that
 * made the audit inert and produced #257.
 *
 * NOTE THE PREFIX. `07 Repositories` is a top-level JD area *inside*
 * `00-09 System`, not a vault-root folder. Scouting the ruled value against the
 * real vault is what caught this: a bare `"07 Repositories"` resolves to nothing
 * and would have reintroduced the same dead-default shape this issue exists to
 * fix.
 */
export const DEFAULT_NOTES_DIR = "00-09 System/07 Repositories";

/**
 * The audit note's vault-relative path — a NOTE PATH, not a directory.
 *
 * It has to be a full path rather than a folder whose basename names the note.
 * "Name the note after its directory" IS the JD folder-note convention, so
 * deriving the audit's filename from a JD folder hits that folder's own
 * folder-note every time — here, `00-09 System/07 Repositories/07 Repositories.md`,
 * a human-accepted note the audit would have rewritten in place. The collision
 * is structural, not particular to this folder.
 *
 * The default is a sibling of `07.10 Repository index`, which is where the
 * ruling placed it.
 */
export const DEFAULT_AUDIT_NOTE = "00-09 System/07 Repositories/Plugin audit.md";

/**
 * FLAT mode's derived audit path: the note named after its own folder.
 *
 * Correct for a flat folder and destructive for a JD one — see
 * {@link DEFAULT_AUDIT_NOTE}. Lives here so config resolution can default to it
 * without reaching into regen.
 */
export function flatAuditPath(notesDir: string = DEFAULT_NOTES_DIR): string {
  const dir = notesDir.replace(/\/+$/, "") || notesDir;
  const base = dir.split("/").pop() || dir;
  return `${dir}/${base}.md`;
}

/**
 * Would `path` be matched by `pattern`? Structural, NOT existence-based.
 *
 * The witness needs "is the audit inside its own source glob", and asking
 * "does it exist in the resolved set" answers a different question: in jd-slots
 * mode the audit note sits beside the slots, never inside `{root}/*\/*.md`, so
 * an existence test reports "absent" forever and adds +1 on every single regen
 * — the note then reads permanently STALE and the deletion signal it carries
 * becomes a constant false alarm.
 */
export function globMatchesPath(pattern: string, path: string): boolean {
  const pSegs = pattern.split("/");
  const xSegs = path.split("/");
  if (pSegs.length !== xSegs.length) return false;
  return pSegs.every((seg, i) => {
    if (!/[*?[]/.test(seg)) return seg === xSegs[i];
    const re = new RegExp(
      "^" + seg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$",
    );
    return re.test(xSegs[i]);
  });
}

/** The `generator:` stamp on the rendered audit note — identifies what produced
 *  the derived artifact. Constant (Python `render.py`). */
export const AUDIT_GENERATOR = "obsidian-plugin-audit";

/** The `derivation-mode:` stamp on the rendered audit note. Constant. A
 *  DERIVATION field — orthogonal to acceptance; the accept-guard never lets a
 *  regen write an `accepted`-family field. */
export const AUDIT_DERIVATION_MODE = "snapshot";

/** The optional frontmatter field a derived note may carry to witness how many
 *  source files its `derived-from` set resolved to at generation time — read by
 *  the freshness engine (freshness.ts), stamped by `renderAudit`. Opt-in: absent
 *  ⇒ the glob half of the deletion check degrades to pre-witness behavior. */
export const SOURCE_COUNT_FIELD = "derived-source-count";

/**
 * The audit note's own `derived-from` entries, for a given notes dir — the ONE
 * definition of what the audit is derived from.
 *
 * `renderAudit` emits this list into the note's frontmatter and `regenerateAudit`
 * resolves the SAME list to count the sources it stamps as
 * `derived-source-count`, so the witness can never describe a different set from
 * the one `provenance_check` will later resolve.
 */
export function auditDerivedFrom(
  notesDir: string = DEFAULT_NOTES_DIR,
  notesSource: NotesSource = DEFAULT_NOTES_SOURCE,
): string[] {
  return [notesGlob(notesDir, notesSource), ".obsidian/plugins/*/manifest.json", ".obsidian/community-plugins.json"];
}

/**
 * The ONE definition of which notes a layout enumerates. Both `reconcile` (what
 * the audit reads) and `auditDerivedFrom` (what it declares it read) call this,
 * so the declaration cannot describe a different set from the scan — the same
 * reason `regenerateAudit` re-resolves its witness through `resolveEntries`.
 *
 * `jd-slots` is one level deep on purpose: `{dir}/<slot>/<slot>.md`. The glob
 * expander walks segment by segment and a wildcard never crosses `/`, so this
 * enumerates slot folders and their notes without descending further.
 */
export function notesGlob(
  notesDir: string = DEFAULT_NOTES_DIR,
  notesSource: NotesSource = DEFAULT_NOTES_SOURCE,
): string {
  // Trailing slashes are stripped HERE, not only in `provenanceConfigOf`: these
  // are exported kernel functions with a defaulted argument, so a caller that
  // skips the config coercion must still get `Meta/Plugins/*.md`, never
  // `Meta/Plugins//*.md` — which would make the scan and the declared
  // `derived-from` disagree about the same folder and throw the count off by one.
  const dir = notesDir.replace(/\/+$/, "") || notesDir;
  return notesSource === "jd-slots" ? `${dir}/*/*.md` : `${dir}/*.md`;
}

/** The provenance module's config, stored under `modules.provenance.config` and
 *  merged over the manifest defaults. */
export interface ProvenanceConfig {
  /** The plugin-notes directory reconcile/regen audit. `~`-expansion does NOT
   *  apply — this is a vault-relative path, not a filesystem one. */
  notesDir: string;
  /** How the notes are laid out under {@link notesDir}. */
  notesSource: NotesSource;
  /** The audit note's vault-relative path. A NOTE path, not a folder — see
   *  {@link DEFAULT_AUDIT_NOTE} for why deriving it from a folder is unsafe. */
  auditNote: string;
}

/** The module's config defaults. Fed to the manifest as `config.defaults`, so
 *  the config tab renders them and `register()` receives them merged under any
 *  user override. */
export const DEFAULT_PROVENANCE_CONFIG: ProvenanceConfig = {
  notesDir: DEFAULT_NOTES_DIR,
  notesSource: DEFAULT_NOTES_SOURCE,
  auditNote: DEFAULT_AUDIT_NOTE,
};

/** Coerce a merged config record (defaults + user override, as `register()`
 *  receives it) into a typed ProvenanceConfig, falling back to the default for
 *  a value of the wrong shape — a hand-edited data.json must never crash a
 *  tool, only degrade to the default (the skills/vocab/scheme skip-and-report
 *  discipline). A blank notesDir degrades to the default too: an empty vault
 *  path would resolve the audit to the vault root, not what any user means. */
export function provenanceConfigOf(config: Record<string, unknown>): ProvenanceConfig {
  const raw = config.notesDir;
  const picked = typeof raw === "string" && raw.trim() !== "" ? raw : DEFAULT_PROVENANCE_CONFIG.notesDir;
  // Strip trailing slash(es): a `Meta/Plugins/` config value would otherwise
  // make `auditPath` interpolate `Meta/Plugins//Plugins.md`, which Obsidian's
  // getAbstractFileByPath never matches (it stores the single-slash form) —
  // silently breaking human-section preservation and the create-vs-modify
  // branch on `provenance_regen --write`.
  const notesDir = picked.replace(/\/+$/, "") || DEFAULT_PROVENANCE_CONFIG.notesDir;

  // An unrecognized layout degrades to the default rather than scanning nothing:
  // a typo'd `"jd_slots"` must not silently produce an empty `noted` set that
  // reads exactly like "no plugin has a note". validate() reports it loudly for
  // anyone looking at the config tab.
  const rawSource = config.notesSource;
  const notesSource: NotesSource =
    rawSource === "flat" || rawSource === "jd-slots" ? rawSource : DEFAULT_PROVENANCE_CONFIG.notesSource;

  // The audit note is a FILE path; a trailing slash means someone typed a
  // folder, and writing to `…/.md` is not recoverable into an intent. Degrade.
  //
  // The DEFAULT depends on the layout, and an explicit value is honoured in
  // BOTH layouts. An earlier revision derived flat mode's destination
  // unconditionally, which made a configured `auditNote` a field the config tab
  // renders, validate() accepts, and the code silently ignores — the exact
  // shape this module exists to stop.
  const rawAudit = config.auditNote;
  const explicit =
    typeof rawAudit === "string" && rawAudit.trim() !== "" && !rawAudit.trim().endsWith("/") ? rawAudit.trim() : null;
  const fallback = notesSource === "flat" ? flatAuditPath(notesDir) : DEFAULT_AUDIT_NOTE;
  // Append `.md` only when there is no extension at all: `Audit.markdown` is a
  // deliberate filename, and `Audit.markdown.md` is nobody's intent.
  const auditNote =
    explicit === null ? fallback : /\.[A-Za-z0-9]+$/.test(explicit) ? explicit : `${explicit}.md`;

  return { notesDir, notesSource, auditNote };
}

/** Validate a merged config for the config tab (manifest.config.validate).
 *  Loud, never coercing: a blank notes-dir is REPORTED so the user sees the
 *  consequence (it would resolve the audit note to the vault root). An absolute
 *  path is rejected — the notes-dir is vault-relative. */
export function validateProvenanceConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const raw = config.notesDir;
  if (raw !== undefined) {
    if (typeof raw !== "string") {
      problems.push("notesDir must be a string (a vault-relative folder path)");
    } else if (raw.trim() === "") {
      problems.push("notesDir must not be blank — it is the vault-relative plugin-notes folder the audit scans");
    } else if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
      problems.push("notesDir must be vault-relative, not an absolute filesystem path");
    }
  }

  const src = config.notesSource;
  if (src !== undefined && src !== "flat" && src !== "jd-slots") {
    problems.push(`notesSource must be "flat" or "jd-slots" (got ${JSON.stringify(src)}) — an unknown layout scans nothing`);
  }

  const audit = config.auditNote;
  if (audit !== undefined) {
    if (typeof audit !== "string") {
      problems.push("auditNote must be a string (a vault-relative path to the audit NOTE, not its folder)");
    } else if (audit.trim() === "") {
      problems.push("auditNote must not be blank — it is the vault-relative path the audit note is written to");
    } else if (audit.startsWith("/") || /^[A-Za-z]:[\\/]/.test(audit)) {
      problems.push("auditNote must be vault-relative, not an absolute filesystem path");
    } else if (audit.trim().endsWith("/")) {
      problems.push("auditNote is a NOTE path, not a folder — give the full path including the .md filename");
    }
  }
  return problems;
}
