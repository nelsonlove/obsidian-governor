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

import { opendir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseAllFrontmatter } from "@vault-mcp/core";
import type { VocabNote } from "../kernel/vocab/blueprint.js";
import type { SourceFile, VaultSnapshot } from "./rule-pack.js";

export interface SnapshotOpts {
  /** Absolute content root to walk. */
  root: string;
  /** Vault-relative path prefixes to exclude entirely (e.g. archaeology). */
  excludedRoots?: string[];
  /** Directory names skipped everywhere (VCS/config noise). */
  skipDirs?: string[];
}

const DEFAULT_SKIP = new Set([".git", ".obsidian", ".trash", "node_modules"]);

function toVaultPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function isExcluded(vaultPath: string, excluded: string[]): boolean {
  return excluded.some((e) => vaultPath === e || vaultPath.startsWith(e.replace(/\/$/, "") + "/"));
}

/** The `---\n…\n---` block's parsed frontmatter (via core) and the body after
 * it. CRLF is normalized to LF FIRST: both the body regex and core's
 * `parseAllFrontmatter` anchor on `---\n`, so a CRLF-authored note (`---\r\n`)
 * would otherwise parse to empty frontmatter and silently skip every vocab
 * check — exactly the silent zero the engine's sentinels exist to prevent. */
function splitNote(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  const frontmatter = parseAllFrontmatter(text) as Record<string, unknown>;
  const body = m ? text.slice(m[0].length) : text;
  return { frontmatter, body };
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
