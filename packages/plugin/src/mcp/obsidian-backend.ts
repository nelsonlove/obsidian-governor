/**
 * ObsidianBackend — implements VaultBackend using Obsidian's live app.* APIs.
 *
 * Each of the 17 fs-expressible methods calls the same Obsidian API that the
 * previous inline tool handlers called. Behavior is unchanged; this is a
 * pure structural move so the shared registerFsTools registrar can drive them.
 *
 * ── The read boundary (slice 3.0) ────────────────────────────────────────────
 *
 * Half of these methods ENUMERATE the vault instead of being told a path:
 * `searchNotes` reads every markdown file, `listNotes` with no subdir lists them
 * all, `findByTag` / `searchByFrontmatter` sweep the metadata cache. The guard
 * checks the paths an operation NAMES IN ITS ARGUMENTS (guard.ts), so it never
 * saw any of them — a session allowlisted to `Projects` could call
 * `obsidian_search_notes` and read a secret straight out of a note it was
 * sandboxed away from. The allowlist was a write boundary and only half a read
 * boundary.
 *
 * So the backend bounds its own iteration, the same way `obsidian_repoint_link`
 * bounds its scan: `visible` is the injected filter (wired to `visiblePaths` in
 * server.ts) and it is applied BEFORE anything is read — a hidden note is never
 * opened, not merely omitted from the answer afterwards. Methods that RESOLVE a
 * path rather than discover one (`resolve`, `getOutlinks`) fail closed to
 * "unresolved" instead of naming where they landed, and `getBacklinks` filters
 * the linkers it reports: a note you can read must not name the notes you can't.
 *
 * `visible` defaults to identity, and `visiblePaths` returns the caller's own
 * array when no allowlist is configured — see `allowed()` below, which turns
 * that identity into "don't filter at all", so an unsandboxed session's reads
 * are unchanged down to the object.
 */

import { TFile, TFolder, getAllTags, parseYaml, type App } from "obsidian";
import { CHARACTER_LIMIT, deriveJdIdFromPath } from "@vault-mcp/core";
import { backlinkKeys } from "./helpers.js";
import { AcceptForbiddenError, acceptTransitionReason, frontmatterOf } from "./write-notes-compose.js";
import type {
  VaultBackend,
  NoteRef,
  SearchHit,
  SearchMode,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  FrontmatterEditValue,
  ManageFrontmatterResult,
  PatchAnchor,
  PatchOp,
} from "@vault-mcp/core";

/** Every markdown path under `folder`, so the count can be filtered before it is reported. */
function markdownPathsRecursive(folder: TFolder, out: string[] = []): string[] {
  for (const child of folder.children) {
    if (child instanceof TFolder) markdownPathsRecursive(child, out);
    else if (child instanceof TFile && child.extension === "md") out.push(child.path);
  }
  return out;
}

/**
 * The subset of `paths` a session may be told about. Injected rather than
 * imported so this class stays testable against a plain function, and so the
 * ONE rule lives in guard.ts. Identity by default (no allowlist ⇒ no boundary).
 */
export type VisibleFilter = (paths: string[]) => string[];

async function ensureParentFolders(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); } catch { /* exists / race */ }
    }
  }
}

// ── ObsidianBackend ───────────────────────────────────────────────────────────

export class ObsidianBackend implements VaultBackend {
  constructor(
    private readonly app: App,
    private readonly visible: VisibleFilter = (paths) => paths,
  ) {}

  /**
   * A membership test for `paths`, or `null` when nothing is being filtered.
   *
   * `visiblePaths` hands back the CALLER'S OWN ARRAY when no allowlist is
   * configured (guard.ts documents that identity), so a `null` here means "no
   * boundary is active" and every loop below skips the check entirely. That is
   * what keeps an unsandboxed vault-wide search exactly as cheap as it was.
   */
  private allowed(paths: string[]): Set<string> | null {
    const vis = this.visible(paths);
    return vis === paths ? null : new Set(vis);
  }

  /** One path's visibility, for the answers that name a single note. */
  private isVisible(path: string): boolean {
    return this.visible([path]).length === 1;
  }

  // ── accept-forbidden guard (the "accept verb is in no API" scar) ─────────────
  //
  // Enforced HERE, at the shared write primitive every fs-expressible write tool
  // (write_note / append / manage_frontmatter / patch / move) routes through —
  // and which obsidian_write_notes' per-item guarded dispatch also reaches via
  // writeNote — so the invariant holds on EVERY write surface, not just the one
  // it originally shipped on. The check is over the note that WOULD LAND ON DISK
  // (frontmatter parsed from the final markdown, a body-embedded fence included),
  // for every value-type, and it is a TRANSITION: introducing or changing
  // acceptance to the accepted-family is blocked; carrying an existing
  // (human-granted) accepted value forward UNCHANGED is allowed.

  /** Parse the leading frontmatter of a markdown string via Obsidian's own YAML parser. */
  private fmOf(markdown: string): Record<string, unknown> | null {
    return frontmatterOf(markdown, parseYaml);
  }

  /** The note's current on-disk frontmatter, parsed from its raw text; null when the note is new/absent/unparseable. */
  private async diskFrontmatter(path: string): Promise<Record<string, unknown> | null> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return null;
    try {
      return this.fmOf(await this.app.vault.read(f));
    } catch {
      return null;
    }
  }

  /**
   * Reject a full-content write whose RESULTING frontmatter introduces/changes
   * acceptance. The on-disk value is read ONLY when the result asserts
   * acceptance at all (the common write pays no extra read), and preservation is
   * tested against it so a legitimate edit carrying an existing accepted value
   * forward is allowed.
   */
  private async guardWrittenContent(path: string, resultingContent: string): Promise<void> {
    const after = this.fmOf(resultingContent);
    if (!after || !acceptTransitionReason(null, after)) return;
    const reason = acceptTransitionReason(await this.diskFrontmatter(path), after);
    if (reason) throw new AcceptForbiddenError(reason);
  }

  /** Reject a frontmatter-level edit (manage_frontmatter set / patch) whose result introduces/changes acceptance. */
  private guardResultingFrontmatter(before: Record<string, unknown> | null, after: Record<string, unknown>): void {
    const reason = acceptTransitionReason(before, after);
    if (reason) throw new AcceptForbiddenError(reason);
  }

  // ── listing & navigation ────────────────────────────────────────────────────

  async listNotes(
    subdir: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ total: number; notes: NoteRef[] }> {
    const prefix = subdir ? subdir.replace(/\/$/, "") + "/" : "";
    // Filtered BEFORE the page is cut, so `total` is the visible total: an
    // unfiltered count would still say how much lives outside the allowlist,
    // which is the cardinality oracle the uid totals already close.
    const all = this.visible(
      this.app.vault
        .getMarkdownFiles()
        .filter((f) => (prefix ? f.path.startsWith(prefix) : true))
        .map((f) => f.path),
    ).sort();
    const total = all.length;
    const page = all.slice(offset, offset + limit);
    return { total, notes: page.map((path) => ({ path })) };
  }

  async listFolders(
    subdir: string | undefined,
  ): Promise<Array<{ path: string; note_count: number }>> {
    const base = subdir
      ? this.app.vault.getAbstractFileByPath(subdir.replace(/\/$/, ""))
      : this.app.vault.getRoot();
    if (!(base instanceof TFolder)) throw new Error(`not a folder: ${subdir}`);
    const children = base.children.filter((c): c is TFolder => c instanceof TFolder);
    // With no subdir this is the vault ROOT — the one listing no argument can
    // scope. A folder outside the allowlist is neither named nor counted, and
    // the counts that survive count only visible notes, so neither the name nor
    // the size of a hidden area leaks. A folder that merely CONTAINS the
    // allowlist is outside it too, exactly as a `scope` is (tools-links.ts).
    const shown = this.allowed(children.map((f) => f.path));
    return children
      .filter((f) => !shown || shown.has(f.path))
      .map((f) => ({ path: f.path, note_count: this.visible(markdownPathsRecursive(f)).length }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  // ── note reading ────────────────────────────────────────────────────────────

  async readNote(relPath: string): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(relPath);
    if (!(f instanceof TFile)) throw new Error(`not found: ${relPath}`);
    const content = await this.app.vault.read(f);
    if (content.length > CHARACTER_LIMIT) {
      return (
        content.slice(0, CHARACTER_LIMIT) +
        `\n\n[truncated: note is ${content.length} chars, showing first ${CHARACTER_LIMIT}]`
      );
    }
    return content;
  }

  // ── search ──────────────────────────────────────────────────────────────────

  async searchNotes(query: string, limit: number, mode: SearchMode): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    // THE hole this slice closes: an argument-less search read every note in the
    // vault and returned matching LINES, so a sandboxed session could lift a
    // secret out of a note it had no path to. The filter is applied before
    // `cachedRead`, not to the hits afterwards — a hidden note is never opened.
    const files = this.app.vault.getMarkdownFiles();
    const shown = this.allowed(files.map((f) => f.path));
    outer: for (const f of files) {
      if (shown && !shown.has(f.path)) continue;
      const content = await this.app.vault.cachedRead(f);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ path: f.path, line: i + 1, snippet: lines[i].trim().slice(0, 300) });
          if (hits.length >= limit) break outer;
          if (mode === "one_per_note") continue outer;
        }
      }
    }
    return hits;
  }

  async findByTag(tag: string, limit: number): Promise<NoteRef[]> {
    const want = tag.replace(/^#/, "").toLowerCase();
    const notes: NoteRef[] = [];
    // Same boundary as searchNotes: the tag is the only argument, so the guard
    // has nothing to check and the sweep has to bound itself.
    const files = this.app.vault.getMarkdownFiles();
    const shown = this.allowed(files.map((f) => f.path));
    for (const f of files) {
      if (shown && !shown.has(f.path)) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache) continue;
      const tags = (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "").toLowerCase());
      if (tags.includes(want)) {
        notes.push({ path: f.path });
        if (notes.length >= limit) break;
      }
    }
    return notes;
  }

  async searchByFrontmatter(property: string, value: string): Promise<FrontmatterSearchResult[]> {
    const wantKey = property.toLowerCase();
    const results: FrontmatterSearchResult[] = [];
    // As above — and the leak here is wider than a path: the result carries the
    // matching note's WHOLE frontmatter block.
    const files = this.app.vault.getMarkdownFiles();
    const shown = this.allowed(files.map((f) => f.path));
    for (const f of files) {
      if (shown && !shown.has(f.path)) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm) continue;
      const key = Object.keys(fm).find((k) => k.toLowerCase() === wantKey);
      if (!key) continue;
      const fv = fm[key];
      const hit = Array.isArray(fv)
        ? fv.some((v) => String(v) === value)
        : String(fv) === value;
      if (hit) results.push({ path: f.path, frontmatter: fm });
    }
    // Intentionally uncapped: registerFsTools applies the limit.
    return results;
  }

  // ── link resolution ─────────────────────────────────────────────────────────

  async resolve(refs: string[], from?: string): Promise<ResolveResult[]> {
    // Obsidian's getFirstLinkpathDest(linkpath, sourcePath) uses the source note
    // path for context-sensitive resolution (e.g. preferring notes in the same
    // folder for ambiguous basenames). Pass `from` through so callers that
    // provide it get the context-aware result; fall back to "" (vault-root
    // context) when omitted.
    return refs.map((ref): ResolveResult => {
      // Strip [[ ]] wrapping then extract display alias (|Alias) and fragment (#...).
      let working = ref.replace(/^\[\[/, "").replace(/\]\]$/, "");

      let alias: string | undefined;
      const pipeIdx = working.indexOf("|");
      if (pipeIdx >= 0) {
        alias = working.slice(pipeIdx + 1).trim() || undefined;
        working = working.slice(0, pipeIdx);
      }

      const fragmentIdx = working.indexOf("#");
      const clean = fragmentIdx >= 0 ? working.slice(0, fragmentIdx) : working;
      const fragment = fragmentIdx >= 0 ? working.slice(fragmentIdx + 1) : undefined;

      const dest = this.app.metadataCache.getFirstLinkpathDest(clean, from ?? "");
      // A ref is link TEXT, not a path — `[[Projects]]` passes the guard's
      // prefix check and can still resolve to `Archive/Projects.md`, so the
      // resolver's answer is checked, not just the question. Out of the
      // allowlist reads as UNRESOLVED rather than as a refusal: refusing would
      // confirm that a note by that name exists somewhere you can't see.
      if (!dest || !this.isVisible(dest.path)) {
        return {
          ref,
          ...(fragment ? { fragment } : {}),
          ...(alias ? { alias } : {}),
        };
      }

      // Determine matched_by — mirrors the discriminants used by index-store._resolveRefs
      // so both backends emit the same vocabulary: "path" | "basename" | "alias" | "jd-id".
      // The JD id is derived from the filename + note-kind (filename-canonical),
      // not read from a frontmatter property.
      let matched_by: ResolveResult["matched_by"];
      if (clean === dest.path || clean + ".md" === dest.path) {
        matched_by = "path";
      } else {
        const jdId = deriveJdIdFromPath(dest.path, dest.basename);
        if (jdId !== undefined && jdId === clean) {
          matched_by = "jd-id";
        } else if (dest.basename.toLowerCase() === clean.toLowerCase()) {
          matched_by = "basename";
        } else {
          // Obsidian resolved via alias (or another indirect match)
          matched_by = "alias";
        }
      }

      return {
        ref,
        path: dest.path,
        matched_by,
        ...(fragment ? { fragment } : {}),
        ...(alias ? { alias } : {}),
      };
    });
  }

  async getBacklinks(notePath: string): Promise<string[]> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file) throw new Error(`not found: ${notePath}`);
    // getBacklinksForFile is not in the public obsidian types — cast required.
    // .data can be a Map (most Obsidian builds) or a plain object (some older
    // builds) — backlinkKeys handles both shapes defensively.
    const bl = (this.app.metadataCache as any).getBacklinksForFile(file);
    // The ARGUMENT is guarded; the ANSWER is a list of other notes' paths, and
    // "who links to this" is exactly how a visible note names hidden ones. A
    // linker you cannot read is not disclosed — the same fail-closed choice
    // `obsidian_check_links` makes about whose notes it reports from.
    return this.visible(backlinkKeys(bl?.data));
  }

  async getOutlinks(notePath: string): Promise<OutlinkEntry[]> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${notePath}`);
    const cache = this.app.metadataCache.getFileCache(file);
    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    // `ref` is the link text as WRITTEN in a note this session can read, so it
    // is reported verbatim — the same reasoning obsidian_check_links applies to
    // a dangling link's text. What is withheld is where it LANDS: a link out of
    // the allowlist comes back with no `resolved_path`, indistinguishable from
    // a dangling one. That leaves the same residual one-bit oracle the link
    // report already documents (a resolved link resolved to something), and no
    // path.
    return refs.map((r): OutlinkEntry => {
      const linkpath = r.link.split("#")[0];
      const dest = linkpath
        ? this.app.metadataCache.getFirstLinkpathDest(linkpath, notePath)
        : null;
      return { ref: r.link, resolved_path: dest && this.isVisible(dest.path) ? dest.path : undefined };
    });
  }

  // ── index management ────────────────────────────────────────────────────────

  async forceReindex(): Promise<void> {
    // No-op: Obsidian's metadata cache is always live; there is no index to rebuild.
  }

  // ── frontmatter ─────────────────────────────────────────────────────────────

  async manageFrontmatter(
    relPath: string,
    key: string,
    op: "get" | "set" | "delete",
    value?: FrontmatterEditValue,
  ): Promise<ManageFrontmatterResult> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${relPath}`);

    if (op === "get") {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return { value: fm ? fm[key] : undefined };
    }

    if (op === "set") {
      if (value === undefined) throw new Error("`value` is required for op='set'");
      const beforeFm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
      // Accept-forbidden guard over the RESULTING frontmatter (before with this
      // one field set): setting acceptance-status=accepted or an accepted-* field
      // is rejected unless the note already held that exact value.
      this.guardResultingFrontmatter(beforeFm, { ...(beforeFm ?? {}), [key]: value });
      const hadFm = !!beforeFm;
      let previous: FrontmatterEditValue | undefined;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        previous = fm[key];
        fm[key] = value;
      });
      return { previous, created_frontmatter: !hadFm };
    }

    // op === "delete"
    let existed = false;
    let previous: FrontmatterEditValue | undefined;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      existed = Object.prototype.hasOwnProperty.call(fm, key);
      previous = fm[key];
      delete fm[key];
    });
    return { previous, existed };
  }

  // ── patching ─────────────────────────────────────────────────────────────────

  async patchNote(
    relPath: string,
    anchor: PatchAnchor,
    op: PatchOp,
    content: string,
  ): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${relPath}`);
    const cache = this.app.metadataCache.getFileCache(file);
    const text = await this.app.vault.read(file);

    let start: number;
    let end: number;

    if (anchor.type === "heading") {
      const headings = cache?.headings ?? [];
      const idx = headings.findIndex((h) => h.heading === anchor.value);
      if (idx < 0) return { found: false, anchor, op };
      const h = headings[idx];
      start = h.position.end.offset; // just after the heading line
      end = text.length;
      for (let j = idx + 1; j < headings.length; j++) {
        if (headings[j].level <= h.level) { end = headings[j].position.start.offset; break; }
      }
    } else {
      const block = cache?.blocks?.[anchor.value];
      if (!block) return { found: false, anchor, op };
      start = block.position.start.offset;
      end = block.position.end.offset;
    }

    const previous = text.slice(start, end);
    let next: string;
    if (op === "replace") {
      const body = anchor.type === "heading" ? `\n\n${content}\n` : content;
      next = text.slice(0, start) + body + text.slice(end);
    } else if (op === "prepend") {
      const ins = anchor.type === "heading" ? `\n\n${content}` : `${content}\n`;
      next = text.slice(0, start) + ins + text.slice(start);
    } else {
      // append: preserve any blank line before a following heading
      const head = text.slice(0, end).replace(/\n*$/, "\n");
      const tail = text.slice(end);
      const sep = tail.length === 0 || tail.startsWith("\n") ? "\n" : "\n\n";
      next = head + content + sep + tail;
    }

    // Accept-forbidden guard: a patch anchors on a heading/block and cannot
    // normally touch the leading frontmatter, but the invariant is enforced over
    // the note that would land regardless — so the resulting frontmatter is
    // checked against the current one, and a preserved value passes untouched.
    this.guardResultingFrontmatter(this.fmOf(text), this.fmOf(next) ?? {});
    await this.app.vault.modify(file, next);
    return { found: true, anchor, op, previous };
  }

  // ── full note ops ────────────────────────────────────────────────────────────

  async writeNote(
    relPath: string,
    content: string,
    overwrite: boolean,
  ): Promise<{ path: string; created: boolean }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    // Accept-forbidden guard over the whole note being written (S1/S2): a body
    // that embeds `---\nacceptance-status: accepted\n---` lands verbatim, so the
    // guard parses the FINAL content, not a structured argument.
    await this.guardWrittenContent(relPath, content);
    const existing = this.app.vault.getAbstractFileByPath(relPath);
    if (existing instanceof TFile) {
      if (!overwrite) throw new Error(`exists (set overwrite=true to replace): ${relPath}`);
      await this.app.vault.modify(existing, content);
      return { path: relPath, created: false };
    }
    await ensureParentFolders(this.app, relPath);
    await this.app.vault.create(relPath, content);
    return { path: relPath, created: true };
  }

  async appendNote(
    relPath: string,
    content: string,
  ): Promise<{ path: string; created: boolean }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const existing = this.app.vault.getAbstractFileByPath(relPath);
    if (existing instanceof TFile) {
      // Appended text lands at the END of the note; a note's frontmatter is only
      // ever its leading fence, so an append can neither introduce nor change
      // acceptance on an existing note. No guard is needed (and none possible).
      await this.app.vault.append(existing, content);
      return { path: relPath, created: false };
    }
    // Creating the note: the appended content IS the whole note, so its own
    // leading fence would become real frontmatter — guard it like a write.
    await this.guardWrittenContent(relPath, content);
    await ensureParentFolders(this.app, relPath);
    await this.app.vault.create(relPath, content);
    return { path: relPath, created: true };
  }

  async moveNote(
    fromRel: string,
    toRel: string,
    options: { update_backlinks: boolean; overwrite: boolean },
  ): Promise<{
    from: string;
    to: string;
    backlinks_updated: number | null;
    backlinks_files_touched: number | null;
  }> {
    if (!fromRel.endsWith(".md")) throw new Error("source must end in .md");
    if (!toRel.endsWith(".md")) throw new Error("destination must end in .md");
    if (fromRel === toRel) throw new Error("from and to are the same path");

    const file = this.app.vault.getAbstractFileByPath(fromRel);
    if (!(file instanceof TFile)) throw new Error(`not found: ${fromRel}`);

    const dest = this.app.vault.getAbstractFileByPath(toRel);
    let trashedDest = false;
    if (dest) {
      if (!options.overwrite) throw new Error(`destination exists (set overwrite=true): ${toRel}`);
      // Recoverable delete: if the subsequent rename fails, the overwritten note is in trash.
      if (dest instanceof TFile) {
        await this.app.vault.trash(dest, true);
        trashedDest = true;
      }
    }

    await ensureParentFolders(this.app, toRel);
    try {
      // renameFile always rewrites backlinks regardless of update_backlinks.
      // When update_backlinks=false we still call renameFile (Obsidian has no
      // rename-without-backlink-rewrite API), so the param is best-effort.
      await this.app.fileManager.renameFile(file, toRel);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (trashedDest) {
        throw new Error(
          `${msg} (the note previously at '${toRel}' was already moved to the system trash and is recoverable there)`,
        );
      }
      throw e;
    }

    // Obsidian's renameFile rewrites backlinks internally but exposes no count.
    // Return null to signal "unknown, not zero" — the response layer omits these
    // fields rather than emitting a misleading 0.
    return { from: fromRel, to: toRel, backlinks_updated: null, backlinks_files_touched: null };
  }

  async deleteNote(relPath: string, confirm: true): Promise<{ path: string; deleted: true }> {
    if (!relPath.endsWith(".md")) throw new Error("path must end in .md");
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) throw new Error(`not found: ${relPath}`);
    await this.app.vault.delete(file);
    return { path: relPath, deleted: true };
  }
}

