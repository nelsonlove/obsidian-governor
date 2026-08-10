import { createVaultAt } from "./vault.js";
import { IndexStore } from "./index-store.js";
import { AcceptForbiddenError, acceptTransitionReason, parseGuardFrontmatter } from "../accept-guard.js";
import type {
  VaultBackend,
  NoteRef,
  SearchHit,
  SearchMode,
  PatchAnchor,
  PatchOp,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  ManageFrontmatterResult,
  FrontmatterEditValue,
} from "../vault-backend.js";

/**
 * `FilesystemBackend` implements the `VaultBackend` interface over a plain
 * filesystem vault directory. It owns both the on-disk vault access
 * (via VaultImpl) and the in-memory index (via IndexStore), wiring them
 * together for operations like `moveNote` that need both.
 *
 * Per-instance: each FilesystemBackend holds its own VaultImpl + IndexStore,
 * so multiple instances in the same process can operate on different vault
 * roots without interfering. The module-level singletons in vault.ts and
 * index-store.ts (used by the server's legacy function-call API) are separate.
 *
 * Note: the index starts empty (status: "indexing"). Call `forceReindex()`
 * to populate it before using index-dependent operations (resolve, backlinks,
 * outlinks, searchByFrontmatter). The vault watcher (vault-watcher.ts) is NOT
 * auto-started here — it's infrastructure that the server layer manages.
 *
 * ── accept-forbidden guard (issue #104) ─────────────────────────────────────
 *
 * Before this fix, only the plugin's ObsidianBackend enforced the "the accept
 * verb is in no API" invariant — FilesystemBackend passed content straight to
 * disk, so packages/server's fs-failover mode (used when Obsidian is down)
 * served UNGUARDED writes: a write carrying `acceptance-status: accepted`
 * would land. The guard is now enforced HERE too, over the shared
 * `acceptTransitionReason` predicate (packages/core/src/accept-guard.ts) —
 * the SAME decision logic ObsidianBackend uses, so both backends refuse
 * identically. Guarded surfaces: `writeNote`, `appendNote` (both can make the
 * note's leading frontmatter fence), and `manageFrontmatter` with op:"set"
 * (can set `acceptance-status` / `accepted*` directly). `moveNote` and
 * `deleteNote` don't touch content; `manageFrontmatter` op:"delete" only
 * REMOVES a field, which the invariant does not forbid (mirrors
 * ObsidianBackend, which does not guard delete either).
 */
export class FilesystemBackend implements VaultBackend {
  private readonly vault: ReturnType<typeof createVaultAt>;
  private readonly index: IndexStore;
  private readonly vaultRootPath: string;

  constructor(vaultRoot: string) {
    this.vaultRootPath = vaultRoot;
    this.vault = createVaultAt(vaultRoot);
    this.index = new IndexStore(vaultRoot);
  }

  // ── accept-forbidden guard helpers ──────────────────────────────────────────

  /** The note's current on-disk content, or `null` when it doesn't exist / can't be read. */
  private async diskContent(relPath: string): Promise<string | null> {
    try {
      return await this.vault.readNote(relPath);
    } catch {
      return null;
    }
  }

  /**
   * Reject a full-content write whose RESULTING frontmatter introduces/changes
   * acceptance. Mirrors ObsidianBackend's `guardWrittenContent`: the on-disk
   * value is read ONLY when the result asserts acceptance at all (the common
   * write pays no extra read), so a legitimate edit carrying an existing
   * accepted value forward is allowed.
   */
  private async guardWrittenContent(relPath: string, resultingContent: string): Promise<void> {
    const after = parseGuardFrontmatter(resultingContent);
    if (!after || !acceptTransitionReason(null, after)) return;
    const before = await this.diskContent(relPath);
    const reason = acceptTransitionReason(before ? parseGuardFrontmatter(before) : null, after);
    if (reason) throw new AcceptForbiddenError(reason);
  }

  /** Reject a frontmatter-level edit (manage_frontmatter set) whose result introduces/changes acceptance. */
  private guardResultingFrontmatter(
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): void {
    const reason = acceptTransitionReason(before, after);
    if (reason) throw new AcceptForbiddenError(reason);
  }

  // ── Read: listing & navigation ─────────────────────────────────────────────

  async listNotes(
    subdir: string | undefined,
    limit: number,
    offset: number,
  ): Promise<{ total: number; notes: NoteRef[] }> {
    return this.vault.listNotes(subdir, limit, offset);
  }

  async listFolders(
    subdir: string | undefined,
  ): Promise<Array<{ path: string; note_count: number }>> {
    return this.vault.listFolders(subdir);
  }

  // ── Read: note reading ─────────────────────────────────────────────────────

  async readNote(relPath: string): Promise<string> {
    return this.vault.readNote(relPath);
  }

  // ── Read: search ───────────────────────────────────────────────────────────

  async searchNotes(query: string, limit: number, mode: SearchMode): Promise<SearchHit[]> {
    return this.vault.searchNotes(query, limit, mode);
  }

  async findByTag(tag: string, limit: number): Promise<NoteRef[]> {
    return this.vault.findByTag(tag, limit);
  }

  async searchByFrontmatter(property: string, value: string): Promise<FrontmatterSearchResult[]> {
    const matches = this.index.searchByFrontmatter(property, value);
    return matches.map((n) => ({ path: n.path, frontmatter: n.frontmatter }));
  }

  // ── Read: link resolution ──────────────────────────────────────────────────

  async resolve(refs: string[], _from?: string): Promise<ResolveResult[]> {
    // `from` is accepted for interface parity but ignored by the filesystem
    // backend: the index-based resolver does not yet perform source-note-aware
    // disambiguation. Callers on the FS backend get best-effort resolution.
    return this.index.resolveRefs(refs);
  }

  async getBacklinks(notePath: string): Promise<string[]> {
    return this.index.getBacklinks(notePath);
  }

  async getOutlinks(notePath: string): Promise<OutlinkEntry[]> {
    return this.index.getOutlinks(notePath);
  }

  // ── Read: index management ─────────────────────────────────────────────────

  async forceReindex(): Promise<void> {
    await this.index.buildIndex();
  }

  // ── Write: frontmatter ─────────────────────────────────────────────────────

  async manageFrontmatter(
    relPath: string,
    key: string,
    op: "get" | "set" | "delete",
    value?: FrontmatterEditValue,
  ): Promise<ManageFrontmatterResult> {
    if (op === "get") {
      const v = await this.vault.getFrontmatterField(relPath, key);
      return { value: v };
    }
    if (op === "delete") {
      return this.vault.deleteFrontmatterField(relPath, key);
    }
    // op === "set"
    if (value === undefined) {
      throw new Error("`value` is required for op='set'");
    }
    // Accept-forbidden guard over the RESULTING frontmatter (current disk
    // state with this one field set): setting acceptance-status=accepted or
    // an accepted-* field is rejected unless the note already held that exact
    // value. Read the current content ourselves (rather than letting
    // setFrontmatterField's own read happen first) so the guard runs BEFORE
    // any write.
    const current = await this.diskContent(relPath);
    const beforeFm = current ? parseGuardFrontmatter(current) : null;
    this.guardResultingFrontmatter(beforeFm, { ...(beforeFm ?? {}), [key]: value });
    return this.vault.setFrontmatterField(relPath, key, value);
  }

  // ── Write: patching ────────────────────────────────────────────────────────

  async patchNote(
    relPath: string,
    anchor: PatchAnchor,
    op: PatchOp,
    content: string,
  ): Promise<{ found: boolean; anchor: PatchAnchor; op: PatchOp; previous?: string }> {
    return this.vault.patchNote(relPath, anchor, op, content);
  }

  // ── Write: full note ops ───────────────────────────────────────────────────

  async writeNote(
    relPath: string,
    content: string,
    overwrite: boolean,
  ): Promise<{ path: string; created: boolean }> {
    // Accept-forbidden guard over the whole note being written: a body that
    // embeds `---\nacceptance-status: accepted\n---` lands verbatim, so the
    // guard parses the FINAL content, not a structured argument — same shape
    // as ObsidianBackend.writeNote.
    await this.guardWrittenContent(relPath, content);
    return this.vault.writeNote(relPath, content, overwrite);
  }

  async appendNote(
    relPath: string,
    content: string,
  ): Promise<{ path: string; created: boolean }> {
    // Appended text lands at the END, so it normally cannot touch frontmatter
    // — EXCEPT when the note is empty/new, where the appended leading `---`
    // fence becomes the note's real frontmatter. Guard the FINAL content
    // (existing + appended, matching VaultImpl.appendNote's own "\n" join)
    // uniformly, mirroring ObsidianBackend.appendNote.
    const existing = await this.diskContent(relPath);
    const resulting = existing === null ? content : `${existing}\n${content}`;
    await this.guardWrittenContent(relPath, resulting);
    return this.vault.appendNote(relPath, content);
  }

  async moveNote(
    fromRel: string,
    toRel: string,
    options: { update_backlinks: boolean; overwrite: boolean },
  ): Promise<{
    from: string;
    to: string;
    backlinks_updated: number;
    backlinks_files_touched: number;
  }> {
    return this.vault.moveNote(fromRel, toRel, {
      update_backlinks: options.update_backlinks,
      overwrite: options.overwrite,
      backlinks_provider: (p) => this.index.getBacklinks(p),
      resolve_ref: (ref) => this.index.resolveRefs([ref])[0]?.path,
    });
  }

  async deleteNote(relPath: string, confirm: true): Promise<{ path: string; deleted: true }> {
    return this.vault.deleteNote(relPath, confirm);
  }
}
