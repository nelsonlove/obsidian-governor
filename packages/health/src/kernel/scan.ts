// scan.ts — the pure tiered-findings core of the vault-health scanner, ported
// verbatim (behavior-for-behavior) from the standalone `obsidian-vault-health`'s
// Python classifier. Obsidian-free: it runs over an injected `HealthSource`, so
// it is headless-testable against a synthetic vault. READ-ONLY — it emits
// findings and never mutates; the fixing is a separate skill, out of scope.
//
// Findings are tiered by FIX RISK (the standalone's whole point):
//
//   auto-safe        broken links whose target uniquely resolves to exactly one
//                    existing NOTE (stale full-path / renamed links) — guarded by
//                    a single-candidate check, and never an attachment ref.
//   approval-gated   empty / near-empty notes (body chars ≤ threshold, frontmatter
//                    excluded); orphan (unreferenced) attachments.
//   report-only      dangling links (no safe target), exact-duplicate note groups
//                    (same body), low-signal (used-once) tags.
//
// CAVEATS carried over from the standalone's README, surfaced here and echoed in
// the tool descriptions so consumers scope repoints safely:
//   - A unique-basename match is NOT proof a link *should* be repointed: in a
//     large vault with vendored / knowledge-base / template trees, a
//     `[[core.el]]`-style path reference can coincidentally match an unrelated
//     note. Consumers should scope auto-safe repoints to authored areas.
//   - Orphan attachments include files referenced ONLY via frontmatter / CSS
//     (those references are not in `resolvedLinks`) — verify before trashing, and
//     protect sensitive trees.

import type { HealthFile, HealthFileExt, HealthSource } from "./health-source.js";

/** Extensions that mark a link target as an *attachment* — so a missing one must
 *  never be repointed to a same-stem NOTE, and is reported as `attachment-ref`.
 *  An allowlist (not "any dotted suffix") because JD-numbered note titles like
 *  "08.05 Foo" or "00.12 IDs" have an `.05 Foo` / `.12 IDs` "extension" under
 *  splitext that contains spaces and is not a real extension token — those never
 *  appear here and stay classified as notes. Kept broad (media + documents + data
 *  + archives) so a real non-media attachment like Budget.xlsx or data.csv still
 *  gets the guard. Ported verbatim from the standalone's ATTACHMENT_EXTS. */
const ATTACHMENT_EXTS = new Set<string>([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "heic", "heif", "ico", "tiff", "tif",
  // audio
  "mp3", "wav", "m4a", "ogg", "oga", "flac", "aac", "3gp", "opus", "aiff", "wma",
  // video
  "mp4", "webm", "ogv", "mov", "mkv", "m4v", "avi", "mpeg", "mpg", "wmv", "flv",
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "tsv", "txt", "rtf",
  "odt", "ods", "odp", "epub", "pages", "numbers", "key",
  // data / archives / obsidian
  "json", "xml", "yaml", "yml", "zip", "tar", "gz", "tgz", "7z", "rar", "canvas", "base",
]);

/** A broken link the scan can auto-repoint: its target uniquely resolves to
 *  exactly one existing note. */
export interface RepointableLink {
  /** The note (vault-relative path) containing the broken link. */
  source: string;
  /** The unresolved link text, e.g. "Old Name" or "path/to/Old Name". */
  target: string;
  /** The single existing note the target resolves to. */
  resolvesTo: string;
}

/** Why a broken link is NOT auto-safe: `heading-or-block` (a bare `#h`/`^blk`
 *  with no note), `attachment-ref` (names a file with an attachment extension),
 *  `ambiguous` (2+ candidate notes), `has-subref` (a `#`/`^` sub-reference the
 *  repoint can't safely carry), or `no-match` (no candidate note at all). */
export type DanglingReason = "heading-or-block" | "attachment-ref" | "ambiguous" | "has-subref" | "no-match";

/** A broken link with no safe target — report-only. */
export interface DanglingLink {
  source: string;
  target: string;
  reason: DanglingReason;
  /** Candidate notes the target's stem/alias matched (empty for a clean no-match). */
  candidates: string[];
}

/** An empty / near-empty note: frontmatter-stripped, trimmed body ≤ threshold. */
export interface EmptyNote {
  path: string;
  /** Trimmed, frontmatter-stripped body length in characters. */
  bodyChars: number;
  /** The note file's byte size. */
  bytes: number;
}

/** A non-markdown file with zero inbound links/embeds in `resolvedLinks`. */
export interface OrphanAttachment {
  path: string;
  ext: string;
  bytes: number;
}

/** A tag used at most once — low-signal / likely-stray. */
export interface LowSignalTag {
  /** The tag including its leading `#` (as Obsidian's getTags reports it). */
  tag: string;
  count: number;
}

/** A group of notes with identical (frontmatter-stripped, trimmed) bodies. */
export type DuplicateGroup = string[];

export interface HealthCounts {
  notes: number;
  files: number;
  repointableLinks: number;
  danglingLinks: number;
  emptyNotes: number;
  orphanAttachments: number;
  lowSignalTags: number;
  duplicateGroups: number;
}

/** The full tiered findings — the structure both `vault_health_scan` and
 *  `vault_health_lint` return (lint returns a scope-filtered copy). */
export interface HealthFindings {
  counts: HealthCounts;
  autoSafe: { repointableLinks: RepointableLink[] };
  approvalGated: { emptyNotes: EmptyNote[]; orphanAttachments: OrphanAttachment[] };
  reportOnly: { danglingLinks: DanglingLink[]; lowSignalTags: LowSignalTag[]; duplicates: DuplicateGroup[] };
}

/** basename of a vault-relative path. */
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Strip ONLY a trailing `.md` — never a general splitext: a JD-numbered link
 *  target like "08.05 Foo" has no real extension, but splitext would treat
 *  ".05 Foo" as one and mangle the basename so it matches no note. (Python
 *  `stem`.) */
function stem(p: string): string {
  const b = basename(p);
  return b.toLowerCase().endsWith(".md") ? b.slice(0, -3) : b;
}

/** Lowercased extension of a link target, matching Python `os.path.splitext(note)[1]`
 *  on the basename: the substring after the last dot, but only when that dot is
 *  not the first character (a leading-dot name like ".foo" has no extension). */
function extOf(note: string): string {
  const b = basename(note);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(dot + 1).toLowerCase() : "";
}

/** The note portion of a link target, dropping any `#heading` / `^block` sub-ref
 *  (Python `re.split(r'[#^]', tgt, 1)[0].strip()`). */
function noteName(tgt: string): string {
  return tgt.split(/[#^]/)[0].trim();
}

/** Frontmatter-strip + normalize + trim, matching the standalone's on-disk
 *  duplicate/empty body computation: normalize CRLF/CR → LF, tolerate a leading
 *  BOM, remove a single leading `---\n … \n---\n` frontmatter block, then trim.
 *  A note with no frontmatter yields its whole trimmed content. */
const FRONTMATTER_RE = /^﻿?---\n[\s\S]*?\n---\n/;
function strippedBody(raw: string): string {
  const norm = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return norm.replace(FRONTMATTER_RE, "").trim();
}

/**
 * Run the full tiered health scan over the injected source. Async only because
 * the on-disk body reads (`noteBody`) are async; everything else is a pure map
 * over the resolver snapshot. The returned findings are deterministic — every
 * list is sorted so a report is a function of the vault, not of iteration order.
 */
export async function scanHealth(source: HealthSource, emptyChars: number): Promise<HealthFindings> {
  const resolved = source.resolvedLinks();
  const unresolved = source.unresolvedLinks();
  const mdFiles: HealthFile[] = source.markdownFiles();
  const allFiles: HealthFileExt[] = source.allFiles();
  const aliases = source.aliases();
  const tags = source.tags();

  const mdPaths = new Set(mdFiles.map((f) => f.path));
  const sizeByPath = new Map(mdFiles.map((f) => [f.path, f.size]));

  // Candidate indexes: stem → notes, alias → notes.
  const byStem = new Map<string, string[]>();
  for (const p of mdPaths) {
    const k = stem(p).toLowerCase();
    (byStem.get(k) ?? byStem.set(k, []).get(k)!).push(p);
  }
  const byAlias = new Map<string, string[]>();
  for (const [p, al] of Object.entries(aliases)) {
    for (const a of al) {
      const k = a.trim().toLowerCase();
      (byAlias.get(k) ?? byAlias.set(k, []).get(k)!).push(p);
    }
  }
  const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

  // ── broken links: repointable (unique existing NOTE) vs dangling ────────────
  const repointable: RepointableLink[] = [];
  const dangling: DanglingLink[] = [];
  for (const src of Object.keys(unresolved).sort()) {
    for (const tgt of Object.keys(unresolved[src]).sort()) {
      const note = noteName(tgt);
      if (!note) {
        dangling.push({ source: src, target: tgt, reason: "heading-or-block", candidates: [] });
        continue;
      }
      const hasSubref = /[#^]/.test(tgt);
      // A target naming a non-markdown file (an embed like ![[foo.png]]) must
      // never be repointed to a same-stem NOTE — that would rewrite a missing
      // attachment into a link to an unrelated note.
      const attachmentRef = ATTACHMENT_EXTS.has(extOf(note));
      const cands = uniqSorted(byStem.get(stem(note).toLowerCase()) ?? byAlias.get(note.toLowerCase()) ?? []);
      if (cands.length === 1 && !hasSubref && !attachmentRef) {
        repointable.push({ source: src, target: tgt, resolvesTo: cands[0] });
      } else {
        const reason: DanglingReason = attachmentRef
          ? "attachment-ref"
          : cands.length > 1
            ? "ambiguous"
            : hasSubref
              ? "has-subref"
              : "no-match";
        dangling.push({ source: src, target: tgt, reason, candidates: cands });
      }
    }
  }

  // ── empty / near-empty notes + duplicate bodies (one on-disk read per note) ──
  const emptyNotes: EmptyNote[] = [];
  const byBody = new Map<string, string[]>();
  for (const p of [...mdPaths].sort()) {
    const raw = await source.noteBody(p);
    if (raw === null) continue;
    const body = strippedBody(raw);
    if (body.length <= emptyChars) {
      emptyNotes.push({ path: p, bodyChars: body.length, bytes: sizeByPath.get(p) ?? 0 });
    }
    // Duplicate grouping ignores near-empty bodies — identical stubs are not an
    // interesting duplicate group (Python `if len(body) < empty_chars: continue`).
    if (body.length < emptyChars) continue;
    (byBody.get(body) ?? byBody.set(body, []).get(body)!).push(p);
  }
  emptyNotes.sort((a, b) => a.bodyChars - b.bodyChars || a.path.localeCompare(b.path));
  const duplicates: DuplicateGroup[] = [...byBody.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

  // ── orphan attachments: non-md files with zero inbound links/embeds ──────────
  const inbound = new Set<string>();
  for (const dests of Object.values(resolved)) for (const d of Object.keys(dests)) inbound.add(d);
  const orphanAttachments: OrphanAttachment[] = [];
  for (const f of allFiles) {
    if (mdPaths.has(f.path) || inbound.has(f.path)) continue;
    orphanAttachments.push({ path: f.path, ext: f.ext, bytes: f.size });
  }
  orphanAttachments.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  // ── low-signal tags: used at most once ──────────────────────────────────────
  const lowSignalTags: LowSignalTag[] = Object.entries(tags)
    .filter(([, c]) => c <= 1)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  return {
    counts: {
      notes: mdPaths.size,
      files: allFiles.length,
      repointableLinks: repointable.length,
      danglingLinks: dangling.length,
      emptyNotes: emptyNotes.length,
      orphanAttachments: orphanAttachments.length,
      lowSignalTags: lowSignalTags.length,
      duplicateGroups: duplicates.length,
    },
    autoSafe: { repointableLinks: repointable },
    approvalGated: { emptyNotes, orphanAttachments },
    reportOnly: { danglingLinks: dangling, lowSignalTags, duplicates },
  };
}

/** Is `path` inside (or equal to) the folder `scope`? Segment-boundary match, so
 *  scope "Foo" contains "Foo/bar.md" but not "Foobar.md". */
function underScope(path: string, scope: string): boolean {
  return path === scope || path.startsWith(scope + "/");
}

/**
 * Restrict findings to a single folder/note scope, for `vault_health_lint`. A pure
 * POST-filter over the full (globally-correct) scan — link resolution and the
 * orphan inbound-set are computed vault-wide first, so an attachment referenced
 * from OUTSIDE the scope is still (correctly) not an orphan.
 *
 * What "belongs to the scope":
 *   - broken links (both tiers): the SOURCE note (the note containing the link);
 *   - empty notes / orphan attachments: the file's own path;
 *   - duplicate groups: kept whole if ANY member is under the scope, so the user
 *     sees the full twin set including any out-of-scope member;
 *   - low-signal tags: DROPPED — tags are vault-wide and cannot be attributed to
 *     a folder (documented in the tool description).
 * Counts are recomputed from the filtered lists.
 */
export function filterFindingsToScope(findings: HealthFindings, scopeRaw: string): HealthFindings {
  const scope = scopeRaw.replace(/\/+$/, "");
  const repointableLinks = findings.autoSafe.repointableLinks.filter((r) => underScope(r.source, scope));
  const danglingLinks = findings.reportOnly.danglingLinks.filter((d) => underScope(d.source, scope));
  const emptyNotes = findings.approvalGated.emptyNotes.filter((e) => underScope(e.path, scope));
  const orphanAttachments = findings.approvalGated.orphanAttachments.filter((a) => underScope(a.path, scope));
  const duplicates = findings.reportOnly.duplicates.filter((g) => g.some((p) => underScope(p, scope)));
  return {
    counts: {
      notes: findings.counts.notes,
      files: findings.counts.files,
      repointableLinks: repointableLinks.length,
      danglingLinks: danglingLinks.length,
      emptyNotes: emptyNotes.length,
      orphanAttachments: orphanAttachments.length,
      lowSignalTags: 0,
      duplicateGroups: duplicates.length,
    },
    autoSafe: { repointableLinks },
    approvalGated: { emptyNotes, orphanAttachments },
    reportOnly: { danglingLinks, lowSignalTags: [], duplicates },
  };
}

/** A compact human-readable one-line-per-tier summary of the counts — the
 *  structured counts are the machine surface, this is the `content` text block. */
export function summarize(findings: HealthFindings): string {
  const c = findings.counts;
  return (
    `Vault health — ${c.notes} notes, ${c.files} files\n` +
    `  auto-safe: ${c.repointableLinks} repointable link(s)\n` +
    `  approval-gated: ${c.emptyNotes} empty/near-empty note(s), ${c.orphanAttachments} orphan attachment(s)\n` +
    `  report-only: ${c.danglingLinks} dangling link(s), ${c.duplicateGroups} duplicate group(s), ${c.lowSignalTags} low-signal tag(s)`
  );
}
