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

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseAllFrontmatter } from "@vault-mcp/core";
import type { VocabNote } from "../kernel/vocab/blueprint.js";
import type { VaultSnapshot } from "./rule-pack.js";

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

export async function buildSnapshot(opts: SnapshotOpts): Promise<VaultSnapshot> {
  const excluded = opts.excludedRoots ?? [];
  const skip = new Set([...DEFAULT_SKIP, ...(opts.skipDirs ?? [])]);
  const notes: VocabNote[] = [];
  const paths: string[] = [];

  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never crash the run
    }
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const vaultPath = toVaultPath(opts.root, abs);
      if (isExcluded(vaultPath, excluded)) continue;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(abs);
        continue;
      }
      const isMd = entry.name.endsWith(".md");
      const isFileclass = entry.name.endsWith(".fileclass");
      if (!isMd && !isFileclass) continue;
      let text = "";
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue; // unreadable file — skip
      }
      const { frontmatter, body } = splitNote(text);
      notes.push({ path: vaultPath, frontmatter, body });
      if (isMd) paths.push(vaultPath);
    }
  }

  await walk(opts.root);
  notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  paths.sort();
  return { notes, paths };
}
