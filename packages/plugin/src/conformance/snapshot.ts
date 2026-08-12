// snapshot.ts — the headless vault reader. The ONLY I/O in the engine: it
// walks a content root, reads .md + .fileclass files, parses frontmatter, and
// produces the VaultSnapshot the pure packs consume. No Obsidian — the rail
// runs headless (CI / cron / CLI).
//
// Frontmatter parsing REUSES @vault-mcp/core's `parseAllFrontmatter` (the same
// best-effort top-level YAML scalar/array reader the filesystem-only server
// uses) — no new dependency, and the same disk-frontmatter semantics the
// Python rail assumed.
//
// Two listings, deliberately:
//   • notes  — .md AND .fileclass, each with {path, frontmatter, body} — the
//     vocab pack's input (types live in .fileclass; glossary in .md bodies).
//   • paths  — .md ONLY — the scheme pack's input (addresses attach to notes).
//
// excludedRoots drops whole subtrees BEFORE any read (the seam that keeps the
// archaeology tree out of the rail, aligned with worker-3's schemes[].excludedRoots).
//
// TERRITORY GUARD (#157): `root` is checked against a declared boundary and a
// hard deny-list BEFORE any of the above happens — see `assertRootPermitted`.

import { opendir, readFile } from "node:fs/promises";
import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import { join, relative, resolve, dirname, basename, sep } from "node:path";
import { parseAllFrontmatter, stripLeadingFrontmatter } from "@vault-mcp/core";
import type { VocabNote } from "../kernel/vocab/blueprint.js";
import type { SourceFile, VaultSnapshot } from "./rule-pack.js";
import { intendedRealPath, isInside } from "./path-identity.js";

export interface SnapshotOpts {
  /** Absolute content root to walk. */
  root: string;
  /**
   * The boundary `root` must resolve inside (or equal). NOT optional in
   * effect: if this is omitted, `buildSnapshot` falls back to reading
   * `ASSENT_CONTENT_ROOT` / `ASSENT_VAULT_ROOT` from the environment, and if
   * NEITHER is present it refuses outright — see `assertRootPermitted`. There
   * is no further fallback: never `$HOME`, never the current working
   * directory, never a hardcoded path, and no upward filesystem walk to find
   * one. Pass this explicitly from programmatic callers (tests, one-off
   * corpus-measurement scripts); `cli.ts`'s own entry already has an
   * explicitly-resolved `root` and threads it through as its own boundary.
   */
  boundary?: string;
  /** Vault-relative path prefixes to exclude entirely (e.g. archaeology). */
  excludedRoots?: string[];
  /** Directory names skipped everywhere (VCS/config noise). */
  skipDirs?: string[];
}

const DEFAULT_SKIP = new Set([".git", ".obsidian", ".trash", "node_modules"]);

// ── territory guard (#157) ──────────────────────────────────────────────
//
// Filed against a real breach: a corpus measurement commissioned for #143
// read `~/obsidian-old` — 12,072 notes, including 2,998 files under
// `80-89 Divorce/` — to count frontmatter parse failures. Read-only, but the
// standing rule is flat: never `~/obsidian-old`, never `80-89` legal
// material, never anything under a hold.
//
// The bound is applied HERE, before `buildSnapshot` performs a single read —
// filtering the returned snapshot would be useless, because the exposure is
// the file CONTENTS that transit this process, not the aggregate this
// function returns.
//
// Identity is decided over the RESOLVED REAL PATH the filesystem reports,
// never a string prefix — the same technique `cli.ts`'s
// `intendedRealPath`/`isInside` pair uses to decide "is this the protected
// file" for the baseline-identity guard (#144: a string-comparison version of
// that exact question had three live bypasses — a decoupled `--root`, a
// hardlink, and a realpath-fallback that could be forced). Those helpers are
// not exported from `cli.ts`, and `cli.ts`'s baseline/rebaseline guard is live
// PATH IDENTITY IS IMPORTED, NEVER RE-IMPLEMENTED (#169).
//
// `realish`/`isWithin` used to live here as a fresh implementation of the same
// technique, because #144's helpers were unexported and that file is live
// acceptance-path code. They are exported now, so this imports them.
//
// The reason this matters more than ordinary DRY: the string-comparison
// predecessor of this comparison was bypassed THREE separate ways (#144 —
// caller-controlled `root`, hardlink/case alias, and a realpath fallback that
// could fabricate the record). Two copies of a security comparison means two
// places a future bypass has to be fixed, and only one of them will be.
//
// Verified equivalent before collapsing rather than assumed: a differential run
// over 12 path shapes (resolvable and dangling symlinks, a symlink loop, a
// non-existent path, `.`/`..`, the filesystem root) and 6 containment pairs
// found ZERO divergence. "Same technique" is not "same behaviour" — the two
// did differ cosmetically (`resolve` vs `join` on the re-appended basename;
// `isInside` resolves its inputs where `isWithin` assumed pre-resolved ones),
// and `isInside` is the strictly more defensive of the pair.

/** A single path SEGMENT (one directory or file name — no separators) that is
 * refused EVEN WHEN it falls inside a declared boundary and even when the
 * caller asks for it explicitly by name — the one case where an explicit
 * request is exactly what should be refused (issue #157). Returns the human
 * name of the violated territory, or null when nothing matched. No syscall:
 * used both against a RESOLVED real path's segments (`deniedTerritory`) and,
 * during the walk, against an already-verified-real directory's own name
 * (cheap — no need to re-resolve a real path for something that is already
 * known not to be a symlink). */
function deniedSegment(seg: string): string | null {
  if (seg.toLowerCase() === "obsidian-old") return "the retired ~/obsidian-old vault";
  if (/^80-89\b/.test(seg)) return "80-89 legal material";
  if (/\bholds?\b/i.test(seg)) return "a path under a hold";
  return null;
}

/** Every segment of the RESOLVED real path, checked with `deniedSegment` — so
 * a symlink cannot launder past this either. Returns the human name of the
 * violated territory, or null when nothing matched. */
function deniedTerritory(realPath: string): string | null {
  for (const seg of realPath.split(sep)) {
    if (!seg) continue;
    const hit = deniedSegment(seg);
    if (hit) return hit;
  }
  return null;
}

/** The declared boundary `root` must resolve inside, or null when none is
 * declared. NO fallback: `opts.boundary`'s absence does not default to
 * `$HOME`, the current working directory, or any hardcoded path, and there is
 * no upward filesystem walk to find one — an undeclared boundary is a
 * refusal, decided by the caller (`assertRootPermitted`), not a default
 * decided here. */
function declaredBoundary(opts: SnapshotOpts): string | null {
  return opts.boundary ?? process.env.ASSENT_CONTENT_ROOT ?? process.env.ASSENT_VAULT_ROOT ?? null;
}

/**
 * Throws if `opts.root` may not be walked; otherwise returns the resolved
 * REAL boundary path, so the walk below can re-run the same checks against
 * anything it discovers mid-tree (a symlinked file, or a plainly-named
 * denied subdirectory a few levels down) — checking `root` alone is not
 * "unconditional": it bounds what `root` may equal, not what the walk may
 * actually read. Called as the FIRST statement of `buildSnapshot`, before any
 * filesystem read.
 *
 * Three independent refusals, checked in this order:
 *
 * 1. The root's real path cannot be established at all — refuse rather than
 *    guess (an indeterminate identity is not a permitted one).
 * 2. The root's real path falls inside a denied territory
 *    (`~/obsidian-old`, `80-89*`, anything under a hold) — refused
 *    UNCONDITIONALLY, before the boundary is even consulted, so this holds
 *    even when a boundary was declared that would otherwise have permitted
 *    it, and even when the caller names the territory explicitly.
 * 3. No boundary is declared, or the root's real path resolves outside the
 *    declared boundary's real path.
 *
 * Refusal messages name WHICH rule was violated so the fix is obvious, but
 * never print a resolved real path that differs from what the caller
 * supplied — a symlink's true target is not something a caller pointing at
 * the symlink is necessarily entitled to see echoed back.
 */
function assertRootPermitted(opts: SnapshotOpts): string {
  const realRoot = intendedRealPath(opts.root);
  if (realRoot === null) {
    throw new Error(
      `buildSnapshot: refusing to walk ${opts.root} — its real path could not be established (unreadable ` +
        `ancestor or a symlink loop). An indeterminate root is refused, never assumed safe.`,
    );
  }

  const denied = deniedTerritory(realRoot);
  if (denied) {
    throw new Error(
      `buildSnapshot: refusing to walk ${opts.root} — it resolves into a permanently denied territory ` +
        `(${denied}). This is refused even when explicitly requested and even when it falls inside a declared ` +
        `boundary.`,
    );
  }

  const boundary = declaredBoundary(opts);
  if (!boundary) {
    throw new Error(
      "buildSnapshot: refusing to walk — no content-root boundary declared. Pass `boundary` explicitly, or set " +
        "ASSENT_CONTENT_ROOT (or ASSENT_VAULT_ROOT). There is no default to $HOME, the current working " +
        "directory, or any hardcoded path, and no upward filesystem walk to find one.",
    );
  }

  const realBoundary = intendedRealPath(boundary);
  if (realBoundary === null) {
    throw new Error(
      `buildSnapshot: refusing to walk — the declared boundary could not be resolved. An indeterminate ` +
        `boundary is refused, never assumed to permit everything.`,
    );
  }

  if (!isInside(realBoundary, realRoot)) {
    throw new Error(
      `buildSnapshot: refusing to walk ${opts.root} — it resolves outside the declared content-root boundary. ` +
        `A corpus measurement may only read notes within the vault its boundary declares.`,
    );
  }

  return realBoundary;
}

function toVaultPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function isExcluded(vaultPath: string, excluded: string[]): boolean {
  return excluded.some((e) => vaultPath === e || vaultPath.startsWith(e.replace(/\/$/, "") + "/"));
}

/** The leading frontmatter block's parsed contents and the body after it.
 *
 * BOTH halves bind to core's shared recognizer (`parseAllFrontmatter` /
 * `stripLeadingFrontmatter`, #150) rather than one of them re-deriving the
 * fence locally. That is not tidiness: when the two disagree the note is
 * neither skipped nor read correctly — it is read with its own frontmatter
 * still inside the body, so every H2/vocab check runs over YAML as if it were
 * prose. That split brain is precisely what a local copy of the pattern
 * produces the moment the shared one is widened (a BOM-tolerant parser beside
 * a BOM-blind body regex), which is how it nearly shipped here.
 *
 * The CRLF pre-normalization is kept because downstream checks index by line
 * offsets into this body and expect LF; the recognizer itself is CRLF-native
 * either way. */
function splitNote(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  return {
    frontmatter: parseAllFrontmatter(text) as Record<string, unknown>,
    body: stripLeadingFrontmatter(text),
  };
}

/** One directory's entries in RAW order (the OS `readdir`/`scandir` order), via
 * `opendir` iteration. This is deliberate, not `readdir`: libuv SORTS
 * `fs.readdir` results, whereas Python's `Path.rglob`/`os.scandir` (which the
 * drift pack's traversal-ordered uid checks must match byte-for-byte) yields
 * raw directory order. `opendir` iteration preserves that raw order, verified
 * identical to CPython `rglob` over the live vault. */
async function rawEntries(absDir: string) {
  const out: import("node:fs").Dirent[] = [];
  let dir;
  try {
    dir = await opendir(absDir);
  } catch {
    return out; // unreadable dir — skip, never crash the run
  }
  try {
    for await (const entry of dir) out.push(entry);
  } catch {
    return out;
  }
  return out;
}

export async function buildSnapshot(opts: SnapshotOpts): Promise<VaultSnapshot> {
  const realBoundary = assertRootPermitted(opts);
  const excluded = opts.excludedRoots ?? [];
  const skip = new Set([...DEFAULT_SKIP, ...(opts.skipDirs ?? [])]);
  const notes: VocabNote[] = [];
  const paths: string[] = [];
  // Raw source text for the ported legacy packs (structure/port/ste). The `.md`
  // raw text feeds port/ste (line-by-line regex scans over the whole file,
  // frontmatter included); `.blueprint` raw text feeds the structure pack.
  // Universal-newline-normalized so `^---\n` anchors bite on CRLF-authored
  // files, matching Python's `Path.read_text`.
  const sources: SourceFile[] = [];
  const blueprints: SourceFile[] = [];
  // Drift-pack inputs. `files`/`dirs` are the `.exists()` universe; `walkOrder`
  // is the `.md` paths in raw traversal order (drift's E/F embed a
  // traversal-ordered sample in their finding key). See rule-pack.ts.
  const files: string[] = [];
  const dirs: string[] = [];
  const walkOrder: string[] = [];

  // pathlib `rglob("*.md")` traversal: for each directory in pre-order DFS
  // (siblings in raw scandir order), yield that directory's matching files
  // BEFORE descending into its subdirectories. Reproduced as two passes per
  // directory (files first, then subdirs), both in raw `opendir` order, so
  // `walkOrder` matches CPython's order exactly.
  async function walk(absDir: string): Promise<void> {
    const entries = await rawEntries(absDir);
    // Pass 1 — files (raw order).
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const abs = join(absDir, entry.name);
      const vaultPath = toVaultPath(opts.root, abs);
      if (isExcluded(vaultPath, excluded)) continue;
      // A symlinked FILE is the one entry shape the root-level territory
      // guard cannot see: `entry.isDirectory()` is false for it regardless of
      // its target, so it reaches this loop untouched by anything above. Its
      // REAL target — not its in-tree location — is what `readFile` below
      // will actually honor, so it gets the identical checks `root` got,
      // BEFORE that read happens.
      if (entry.isSymbolicLink()) {
        const real = intendedRealPath(abs);
        if (real === null) {
          throw new Error(
            `buildSnapshot: refusing to read ${vaultPath} — its real path could not be established (unreadable ` +
              `ancestor or a symlink loop). An indeterminate target is refused, never assumed safe.`,
          );
        }
        const denied = deniedTerritory(real);
        if (denied) {
          throw new Error(
            `buildSnapshot: refusing to read ${vaultPath} — it is a symlink resolving into a permanently denied ` +
              `territory (${denied}). This is refused even though it sits inside an otherwise-permitted tree.`,
          );
        }
        if (!isInside(realBoundary, real)) {
          throw new Error(
            `buildSnapshot: refusing to read ${vaultPath} — it is a symlink resolving outside the declared ` +
              `content-root boundary.`,
          );
        }
      }
      files.push(vaultPath);
      const isMd = entry.name.endsWith(".md");
      const isFileclass = entry.name.endsWith(".fileclass");
      const isBlueprint = entry.name.endsWith(".blueprint");
      if (!isMd && !isFileclass && !isBlueprint) continue;
      let text = "";
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue; // unreadable file — skip
      }
      // Universal-newline normalize (CRLF/CR → LF) up front, so both the parsed
      // listing and the raw sources see the same LF text Python's read_text saw.
      //
      // KNOWN PARITY EDGE (#125 item 3, carried forward from the superseded
      // `de1868e`): the ported packs then split this on \n, whereas Python's
      // `str.splitlines()` — which the original rail used — ALSO breaks on
      // \v, \f, \x85, U+2028 and U+2029. A note containing any of those would
      // give the TS packs one line where Python saw two, so a finding whose
      // regex is line-anchored could differ. Verified zero live occurrences
      // across the parity runs, which is why the ports were accepted as
      // byte-equal; it is a latent edge, not a live one. Deliberately NOT
      // "fixed" by widening the split: that would change keys for a case that
      // does not occur, and the Python rail it had to match is now retired.
      // Tracked with the other latent parity edges in #112.
      const raw = text.replace(/\r\n?/g, "\n");
      if (isBlueprint) {
        blueprints.push({ path: vaultPath, text: raw });
        continue; // blueprints are not vocab/scheme notes
      }
      const { frontmatter, body } = splitNote(raw);
      notes.push({ path: vaultPath, frontmatter, body });
      if (isMd) {
        paths.push(vaultPath);
        sources.push({ path: vaultPath, text: raw });
        walkOrder.push(vaultPath); // raw traversal order (drift E/F)
      }
    }
    // Pass 2 — subdirectories (raw order).
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const abs = join(absDir, entry.name);
      const vaultPath = toVaultPath(opts.root, abs);
      if (isExcluded(vaultPath, excluded)) continue;
      if (skip.has(entry.name)) continue;
      const denied = deniedSegment(entry.name);
      if (denied) {
        throw new Error(
          `buildSnapshot: refusing to descend into ${vaultPath} — it is a permanently denied territory ` +
            `(${denied}). This is refused even though it sits inside an otherwise-permitted tree.`,
        );
      }
      dirs.push(vaultPath);
      await walk(abs);
    }
  }

  await walk(opts.root);
  const obsidianConfig = await readObsidianConfig(opts.root);
  notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  paths.sort();
  const byPath = (a: SourceFile, b: SourceFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  sources.sort(byPath);
  blueprints.sort(byPath);
  // notes/paths/sources/blueprints are SORTED (order-independent consumers);
  // files/dirs/walkOrder keep TRAVERSAL order (drift's `.exists()` set is a
  // Set, but walkOrder's order is load-bearing — leave it unsorted).
  return { notes, paths, sources, blueprints, files, dirs, walkOrder, obsidianConfig };
}

/** The fixed set of `.obsidian` config files the drift pack reads. These live
 * under a skip-dir (`.obsidian`), so the walk never sees them; we read exactly
 * this set. The plugins directory is enumerated in raw `opendir` order to match
 * Python's per-subdirectory manifest glob scandir order (matters only for the
 * last-wins tiebreak when two plugins share a display name). Missing files are
 * silently omitted — the pack degrades per Python (B guards on the note; A on
 * the quickadd config being present). */
async function readObsidianConfig(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const single = [".obsidian/community-plugins.json", ".obsidian/plugins/quickadd/data.json"];
  for (const rel of single) {
    try {
      out.push({ path: rel, text: await readFile(join(root, rel), "utf8") });
    } catch {
      /* absent — omit */
    }
  }
  for (const entry of await rawEntries(join(root, ".obsidian/plugins"))) {
    if (!entry.isDirectory()) continue;
    const rel = `.obsidian/plugins/${entry.name}/manifest.json`;
    try {
      out.push({ path: rel, text: await readFile(join(root, rel), "utf8") });
    } catch {
      /* no manifest — omit */
    }
  }
  return out;
}
