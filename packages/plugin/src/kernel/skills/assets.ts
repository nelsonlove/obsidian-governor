// Supporting files for skills, sourced from a parallel filesystem tree.
//
// A skill note at `<vault>/<dir>/<name>.md` may have a folder of supporting files
// (scripts, references, templates) at `<assetsRoot>/<dir>/<name>/` — the same relative
// path in a parallel tree (e.g. the Johnny Decimal ~/Documents tree that mirrors the
// vault). The exporter copies that folder's contents into the generated
// `skills/<genName>/` directory next to SKILL.md, so `${CLAUDE_PLUGIN_ROOT}`-relative
// references keep working.
//
// The parallel tree may live in iCloud Drive, where evicted files are represented on
// disk as `.<name>.icloud` placeholders. Those are materialized (via `brctl download`)
// before copying; files that fail to materialize within the timeout are skipped with a
// warning rather than failing the export.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

const ICLOUD_PLACEHOLDER = /^\.(.+)\.icloud$/;
const SKIP_NAMES = new Set([".DS_Store"]);

export interface AssetFile {
  /** Path relative to the asset dir (posix separators), e.g. "bin/sessions.py". */
  rel: string;
  abs: string;
}

export interface CollectAssetsResult {
  files: AssetFile[];
  /** Relative paths of files that could not be materialized from iCloud in time.
   *  The exporter keeps any previously exported copy of these instead of deleting it. */
  failed: string[];
  warnings: string[];
}

export interface CollectAssetsOptions {
  /** Request materialization of an evicted iCloud file (default: `brctl download`). */
  download?: (logicalPath: string) => void;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The parallel supporting-files dir for a note: `<assetsRoot>/<note dir>/<note basename>/`. */
export function assetDirFor(assetsRoot: string, notePath: string): string {
  const dir = path.dirname(notePath);
  const base = path.basename(notePath).replace(/\.md$/, "");
  return path.join(assetsRoot, dir === "." ? "" : dir, base);
}

function defaultDownload(logicalPath: string): void {
  // Fire-and-forget: brctl exits immediately; materialization is confirmed by polling.
  execFile("brctl", ["download", logicalPath], () => { /* polling decides the outcome */ });
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Recursively collect the supporting files under `dir`, materializing iCloud
 *  placeholders first. Returns an empty list if the dir doesn't exist. */
export async function collectAssets(dir: string, opts: CollectAssetsOptions = {}): Promise<CollectAssetsResult> {
  const warnings: string[] = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { files: [], failed: [], warnings };
  } catch {
    return { files: [], failed: [], warnings: [`${dir}: could not stat supporting-files dir — skipped`] };
  }

  const download = opts.download ?? defaultDownload;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // Pass 1: find placeholders and request their materialization.
  const pending: string[] = []; // logical (materialized) paths we're waiting on
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      const m = entry.name.match(ICLOUD_PLACEHOLDER);
      if (m) {
        const logical = path.join(d, m[1]);
        pending.push(logical);
        try { download(logical); } catch { /* polling decides the outcome */ }
      }
    }
  };
  walk(dir);

  // Pass 2: wait for the placeholders to become real files.
  const deadline = Date.now() + timeoutMs;
  let waiting = pending.filter((p) => !fs.existsSync(p));
  while (waiting.length && Date.now() < deadline) {
    await sleep(pollMs);
    waiting = waiting.filter((p) => !fs.existsSync(p));
  }
  const failed: string[] = [];
  for (const p of waiting) {
    failed.push(path.relative(dir, p).split(path.sep).join("/"));
    warnings.push(`${p}: could not materialize from iCloud within ${Math.round(timeoutMs / 1000)}s — skipped`);
  }

  // Pass 3: list the real files.
  const files: AssetFile[] = [];
  const list = (d: string, relBase: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { list(abs, rel); continue; }
      if (SKIP_NAMES.has(entry.name) || ICLOUD_PLACEHOLDER.test(entry.name)) continue;
      files.push({ rel, abs });
    }
  };
  list(dir, "");
  return { files, failed, warnings };
}

/** Copy an asset file, preserving its mode (scripts keep their executable bit). */
export function copyAsset(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, fs.statSync(src).mode);
}
