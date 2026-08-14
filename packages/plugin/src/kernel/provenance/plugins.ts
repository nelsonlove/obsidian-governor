// plugins.ts — the Obsidian plugin-audit RECONCILE, over the injected
// ProvenanceSource. Port of the Python `plugins.py`.
//
// Compares three views of the vault's plugins:
//   - INSTALLED: `.obsidian/plugins/*/manifest.json` (id + version)
//   - ENABLED:   `.obsidian/community-plugins.json` (an array of ids)
//   - NOTED:     the `{notesDir}/*.md` plugin notes carrying `plugin.id`
// and reports what is installed-but-unnoted and where a note's recorded
// `plugin.version` has drifted from the installed manifest's version.

import type { ProvenanceSource } from "./provenance-source.js";
import { DEFAULT_NOTES_DIR } from "./provenance-config.js";

/** A parsed plugin manifest — only the two fields the audit uses. */
export interface PluginManifest {
  id: string;
  version: string;
  [k: string]: unknown;
}

export interface Reconciliation {
  /** id → manifest, for every installed plugin. */
  installed: Record<string, PluginManifest>;
  /** enabled plugin ids, sorted. */
  enabled: string[];
  /** id → note path, for every plugin note carrying `plugin.id`. */
  noted: Record<string, string>;
  /** installed ids with no plugin note, sorted. */
  unnoted: string[];
  /** [id, noteVersion, manifestVersion] where a noted version drifted from the
   *  installed manifest, sorted by id. */
  staleVersion: Array<[string, string, string]>;
}

async function readInstalled(source: ProvenanceSource): Promise<Record<string, PluginManifest>> {
  const out: Record<string, PluginManifest> = {};
  for (const path of await source.glob(".obsidian/plugins/*/manifest.json")) {
    const text = await source.read(path);
    if (text === null) continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue; // a malformed manifest is skipped, not fatal (headless-safe)
    }
    if (data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string") {
      const m = data as PluginManifest;
      out[m.id] = m;
    }
  }
  return out;
}

async function readEnabled(source: ProvenanceSource): Promise<string[]> {
  const text = await source.read(".obsidian/community-plugins.json");
  if (text === null) return [];
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return [...new Set(arr.filter((x): x is string => typeof x === "string"))].sort();
  } catch {
    /* malformed → treat as none enabled */
  }
  return [];
}

/** The `plugin` frontmatter sub-map of a note — `{ id, version }` in the
 *  plugin-note convention. Tolerates the field being absent or non-object. */
function pluginFm(fm: Record<string, unknown> | null): { id?: string; version?: string } {
  const p = fm?.plugin;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as { id?: string; version?: string }) : {};
}

export async function reconcile(
  source: ProvenanceSource,
  notesDir: string = DEFAULT_NOTES_DIR,
): Promise<Reconciliation> {
  const installed = await readInstalled(source);
  const enabled = await readEnabled(source);

  const noted: Record<string, string> = {};
  const notedVersion: Record<string, string> = {};
  for (const path of await source.glob(`${notesDir}/*.md`)) {
    const p = pluginFm(source.noteFrontmatter(path));
    if (typeof p.id === "string" && p.id) {
      noted[p.id] = path;
      if (p.version !== undefined) notedVersion[p.id] = String(p.version);
    }
  }

  const unnoted = Object.keys(installed).filter((id) => !(id in noted)).sort();

  const staleVersion: Array<[string, string, string]> = [];
  for (const [id] of Object.entries(noted)) {
    if (id in installed) {
      const nv = notedVersion[id] ?? "";
      const mv = installed[id].version !== undefined ? String(installed[id].version) : "";
      if (nv && mv && nv !== mv) staleVersion.push([id, nv, mv]);
    }
  }
  staleVersion.sort((a, b) => a[0].localeCompare(b[0]));

  return { installed, enabled, noted, unnoted, staleVersion };
}
