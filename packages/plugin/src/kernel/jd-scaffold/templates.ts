// Ported from obsidian-jd-dashboard's src/lib/templates.ts: template-driven
// note creation. Reads templates classified by their `jd-id` frontmatter
// field, substitutes placeholders, computes the destination path.
//
// Supported placeholder dialects (both treated identically):
//   {{var}}        Templater / Core Templates style (preferred)
//   %var%          Legacy QuickAdd-ish style
//
// ONE deliberate scope narrowing from the original: `{{date:CUSTOM_FORMAT}}`/
// `%date:CUSTOM_FORMAT%` (arbitrary moment.js format tokens) is DROPPED —
// pulling in a date-formatting library just for this is not worth it for
// this stage, and the fixed-format `{{date}}`/`{{time}}`/`{{now}}` cases
// (the common case) still work, computed by the glue layer's clock (matching
// JdScaffoldSource.today()'s existing fixed-format precedent) and passed in
// pre-formatted. Same spirit as dropping `jd-id:` frontmatter in
// standard-zeros.ts — a documented, deliberate cut, not a silent omission.
//
// Templates are classified by their `jd-id` frontmatter field:
//   "{{category}}.NN"        -> standard zero, slot NN (NN a ZeroId)
//   "XX.00+CODE"              -> stem template, code CODE (\w+)
//   "{{category}}.{{id}}"    -> generic ID template
//
// Every TFile-shaped piece of the original (TemplateMatch.file, the
// destPathFor* folder params) is ported over plain vault-relative path
// strings instead — no `obsidian` import. Template DISCOVERY (reading a
// folder's children + frontmatter/content) is Obsidian-bound and lives in
// the glue layer; this module classifies an already-discovered listing.

import type { ZeroId, ZeroSpec } from "./types.js";

const ZERO_IDS: ReadonlySet<ZeroId> = new Set<ZeroId>(["00", "01", "02", "03", "04", "05", "06", "07", "08", "09"]);

function isZeroId(s: string): s is ZeroId {
  return (ZERO_IDS as ReadonlySet<string>).has(s);
}

/** Scope phrase for a category prefix: "00" -> "the system", "X0" (X>0) ->
 *  "area X0-X9", everything else -> "category XX". */
export function scopeFor(prefix: string): string {
  if (prefix === "00") return "the system";
  if (/^[1-9]0$/.test(prefix)) {
    const head = prefix[0];
    return `area ${head}0-${head}9`;
  }
  return `category ${prefix}`;
}

export interface PlaceholderContext {
  prefix: string;
  id: string;
  fullId: string;
  scope: string;
  folder: string;
  folderName: string;
  title: string;
  tag: string;
  date: string;
  time: string;
  now: string;
}

export interface BuildContextOpts {
  prefix: string;
  id: string;
  folder: { path: string; name: string };
  zero?: ZeroSpec;
  customTitle?: string;
  customTag?: string;
  /** Pre-formatted date/time strings — the glue layer's clock, matching
   *  JdScaffoldSource.today()'s existing fixed-format precedent. Defaults
   *  keep every field an explicit empty string rather than reaching for
   *  `new Date()` inline (kernel modules take their clock injected). */
  date?: string;
  time?: string;
  now?: string;
}

export function buildContext(opts: BuildContextOpts): PlaceholderContext {
  const isStem = opts.id.startsWith("+");
  const fullId = isStem ? `${opts.prefix}.00${opts.id}` : `${opts.prefix}.${opts.id}`;
  return {
    prefix: opts.prefix,
    id: opts.id,
    fullId,
    scope: scopeFor(opts.prefix),
    folder: opts.folder.path,
    folderName: opts.folder.name,
    title: opts.customTitle ?? opts.zero?.name ?? "",
    tag: opts.customTag ?? opts.zero?.tag ?? "",
    date: opts.date ?? "",
    time: opts.time ?? "",
    now: opts.now ?? "",
  };
}

function valueFor(ctx: PlaceholderContext, key: string): string | null {
  switch (key) {
    // `category` is an alias for `prefix` — the canonical field is `prefix`,
    // but JD-canon-style templates ask for `{{category}}`.
    case "category":
    case "prefix":
      return ctx.prefix;
    case "id":
      return ctx.id;
    case "full-id":
    case "fullId":
      return ctx.fullId;
    case "scope":
      return ctx.scope;
    case "folder":
      return ctx.folder;
    case "folder-name":
    case "folderName":
      return ctx.folderName;
    case "title":
      return ctx.title;
    case "tag":
      return ctx.tag;
    case "date":
      return ctx.date;
    case "time":
      return ctx.time;
    case "now":
      return ctx.now;
    default:
      return null;
  }
}

const PLACEHOLDER_BRACE = /\{\{([a-zA-Z][a-zA-Z-]*)\}\}/g;
const PLACEHOLDER_PERCENT = /%([a-zA-Z][a-zA-Z-]*)%/g;

/** Substitute placeholders in template content. Both {{var}} and %var% are
 *  accepted. Unknown placeholders are left as-is; `warnings` collects them
 *  so the caller can surface them (the original console.warn's — this pure
 *  function returns them instead so the glue layer decides how to report). */
export function substitute(content: string, ctx: PlaceholderContext): { text: string; warnings: string[] } {
  let out = content;
  const unknown = new Set<string>();

  out = out.replace(PLACEHOLDER_BRACE, (m, key) => {
    const v = valueFor(ctx, key);
    if (v === null) {
      unknown.add(key);
      return m;
    }
    return v;
  });
  out = out.replace(PLACEHOLDER_PERCENT, (m, key) => {
    const v = valueFor(ctx, key);
    if (v === null) {
      unknown.add(key);
      return m;
    }
    return v;
  });

  return { text: out, warnings: [...unknown] };
}

export type TemplateRole = { type: "zero"; zeroId: ZeroId } | { type: "stem"; stemCode: string } | { type: "generic" };

/** One discovered template — path + its own jd-id frontmatter value,
 *  already read by the glue layer (metadataCache first, cachedRead
 *  fallback — same discipline the original's listTemplates uses; that I/O
 *  stays in the glue layer, this module only classifies). */
export interface TemplateCandidate {
  path: string;
  jdId: string | null;
}

export interface TemplateMatch {
  path: string;
  role: TemplateRole;
}

/** Extract a `jd-id:` frontmatter value straight from raw file content — no
 *  metadataCache dependency. A deliberate simplification from the original
 *  (which prefers metadataCache, falling back to this same regex only when
 *  the cache hasn't indexed a brand-new file yet): a templates folder is
 *  small, so always reading raw content is negligible overhead, and it
 *  removes the metadataCache-vs-stale-cache fallback complexity entirely.
 *  Handles single- and double-quote wrapping; does not handle multi-line
 *  values (templates don't use them). Scoped to the leading `---`-delimited
 *  frontmatter block only — a `jd-id:` token in the body never matches. */
export function extractJdId(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const close = content.indexOf("\n---\n", 4);
  const fmText = close === -1 ? content.slice(4) : content.slice(4, close + 1);
  const m = fmText.match(/^jd-id:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
  return m ? m[1].trim() : null;
}

const ZERO_ID_RE = /^\{\{category\}\}\.(\d{2})$/;
// Stem codes: leading letter, then word chars or hyphens. Broader than
// folder-notes' `\w+` to accommodate hyphenated codes in the wild; the
// leading-letter requirement avoids `+1`-style anomalies.
const STEM_ID_RE = /^XX\.00\+([A-Za-z][\w-]*)$/;
const GENERIC_ID_RE = /^\{\{category\}\}\.\{\{id\}\}$/;

function classify(jdId: string | null): TemplateRole | null {
  if (!jdId) return null;
  const zero = jdId.match(ZERO_ID_RE);
  if (zero) {
    const id = zero[1];
    if (!isZeroId(id)) return null; // .10+ aren't valid zeros
    return { type: "zero", zeroId: id };
  }
  const stem = jdId.match(STEM_ID_RE);
  if (stem) return { type: "stem", stemCode: stem[1] };
  if (GENERIC_ID_RE.test(jdId)) return { type: "generic" };
  return null;
}

/** Classify every discovered candidate. `skipped` reports which candidates
 *  carried a jd-id but didn't match any known shape (the original's
 *  console.warn — surfaced as data instead of a log line). */
export function classifyTemplates(candidates: TemplateCandidate[]): { matches: TemplateMatch[]; skipped: string[] } {
  const matches: TemplateMatch[] = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    const role = classify(c.jdId);
    if (role) matches.push({ path: c.path, role });
    else if (c.jdId !== null) skipped.push(`${c.path} (jd-id="${c.jdId}")`);
  }
  return { matches, skipped };
}

export function findZeroTemplate(templates: TemplateMatch[], zeroId: ZeroId): TemplateMatch | null {
  return templates.find((t) => t.role.type === "zero" && t.role.zeroId === zeroId) ?? null;
}

export function findStemTemplate(templates: TemplateMatch[], stemCode: string): TemplateMatch | null {
  return templates.find((t) => t.role.type === "stem" && t.role.stemCode === stemCode) ?? null;
}

export function findGenericTemplate(templates: TemplateMatch[]): TemplateMatch | null {
  return templates.find((t) => t.role.type === "generic") ?? null;
}

export function listStemCodes(templates: TemplateMatch[]): string[] {
  type StemMatch = TemplateMatch & { role: Extract<TemplateRole, { type: "stem" }> };
  return templates
    .filter((t): t is StemMatch => t.role.type === "stem")
    .map((t) => t.role.stemCode)
    .sort();
}

/** Reject titles that would write outside the intended folder or produce an
 *  Obsidian/OS-incompatible filename. Returns the trimmed title on success
 *  or null on rejection. Ported verbatim (already pure — no TFile). */
export function sanitizeTitle(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(".")) return null;
  if (trimmed.includes("..")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[/\\:|?*<>"\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
}

export function destPathForZero(folderPath: string, prefix: string, zero: ZeroSpec): string {
  const basename = `${prefix}.${zero.id} ${zero.name}`;
  return zero.hasDir ? `${folderPath}/${basename}/${basename}.md` : `${folderPath}/${basename}.md`;
}

export function destPathForStem(folderPath: string, prefix: string, code: string, name: string): string {
  return `${folderPath}/${prefix}.00+${code} ${name}.md`;
}

export function destPathForGenericId(folderPath: string, prefix: string, id: string, title: string): string {
  return `${folderPath}/${prefix}.${id} ${title}.md`;
}

/** Category folder for a note: walk up from its own containing folder
 *  looking for a folder named `XX <name>` — ported from
 *  new-from-template.ts's findCategoryFolder, over plain path strings
 *  instead of TFolder.parent chains. Returns null if no ancestor matches
 *  (including the vault root itself). */
export function findCategoryFolder(notePath: string): { folderPath: string; prefix: string } | null {
  let cur = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  while (cur !== "") {
    const name = cur.includes("/") ? cur.slice(cur.lastIndexOf("/") + 1) : cur;
    const m = name.match(/^(\d{2})\s/);
    if (m) return { folderPath: cur, prefix: m[1] };
    cur = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : "";
  }
  return null;
}

/** Which two-digit zero ids already exist as children of `folderPath`,
 *  given that folder's own immediate child basenames — ported from
 *  new-from-template.ts's existingZeroIds over plain basenames instead of
 *  TFolder.children. */
export function existingZeroIds(childBasenames: string[], prefix: string): Set<string> {
  const out = new Set<string>();
  const head = `${prefix}.`;
  for (const name of childBasenames) {
    if (!name.startsWith(head)) continue;
    const d0 = name.charCodeAt(head.length);
    const d1 = name.charCodeAt(head.length + 1);
    if (!isAsciiDigit(d0) || !isAsciiDigit(d1)) continue;
    const after = name.charAt(head.length + 2);
    if (after !== "" && after !== " " && after !== "." && after !== "+") continue;
    out.add(name.slice(head.length, head.length + 2));
  }
  return out;
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
