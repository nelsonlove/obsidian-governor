// plugins.ts — the Obsidian plugin-audit RECONCILE, over the injected
// ProvenanceSource. Port of the Python `plugins.py`.
//
// Compares three views of the vault's plugins:
//   - INSTALLED: `.obsidian/plugins/*/manifest.json` (id + version)
//   - ENABLED:   `.obsidian/community-plugins.json` (an array of ids)
//   - NOTED:     the plugin notes under `{notesDir}`, in either layout —
//                 `flat` (`{dir}/*.md`, each carrying `plugin.id`) or
//                 `jd-slots` (`{dir}/<slot>/<slot>.md`, the folder note
//                 carrying `github-repo:`). See `notesGlob`.
// and reports what is installed-but-unnoted, where a note's recorded
// `plugin.version` has drifted from the installed manifest's version, and
// (jd-slots) which repo slots match no installed plugin.

import type { ProvenanceSource } from "./provenance-source.js";
import { DEFAULT_NOTES_DIR, DEFAULT_NOTES_SOURCE, notesGlob, type NotesSource } from "./provenance-config.js";

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
  /** jd-slots only: folder-note paths that name a `github-repo:` matching no
   *  installed plugin, sorted. REPORTED rather than dropped — a slot the audit
   *  cannot place is exactly the thing a human needs to see, and silence here
   *  is what made the old audit useless. Always empty in `flat` mode. */
  unmatchedSlots: string[];
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

/**
 * The repo name a JD slot's folder note points at, from `github-repo:
 * owner/repo`. Returns null when the field is absent or not `owner/repo`.
 */
function repoNameOf(fm: Record<string, unknown> | null): string | null {
  const raw = fm?.["github-repo"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/**
 * Which installed plugin id a slot's repo name denotes, or null.
 *
 * DELIBERATELY CONSERVATIVE. Only three spellings count as the same thing:
 * the id itself, the id with the community `obsidian-` prefix, and the repo
 * name with that prefix removed. Anything looser (substring, fuzzy, longest
 * common prefix) would silently attach an audit row to the wrong plugin, and a
 * wrong match is worse here than no match: an unmatched slot is reported, a
 * mismatched one is believed. A slot that means something this cannot see
 * should say so explicitly with `plugin.id`, which always wins.
 */
function matchInstalledId(repo: string, installedIds: Set<string>): string | null {
  const candidates = [repo, `obsidian-${repo}`, repo.replace(/^obsidian-/, "")];
  for (const c of candidates) if (c && installedIds.has(c)) return c;
  return null;
}

/** Is this note its folder's FOLDER NOTE (`<slot>/<slot>.md`)? */
function isFolderNote(path: string): boolean {
  const segs = path.split("/");
  const base = segs.pop() ?? "";
  const folder = segs.pop() ?? "";
  return base === `${folder}.md`;
}

export async function reconcile(
  source: ProvenanceSource,
  notesDir: string = DEFAULT_NOTES_DIR,
  notesSource: NotesSource = DEFAULT_NOTES_SOURCE,
): Promise<Reconciliation> {
  const installed = await readInstalled(source);
  const enabled = await readEnabled(source);

  const noted: Record<string, string> = {};
  const notedVersion: Record<string, string> = {};
  const unmatchedSlots: string[] = [];
  const installedIds = new Set(Object.keys(installed));

  for (const path of await source.glob(notesGlob(notesDir, notesSource))) {
    const fm = source.noteFrontmatter(path);
    const p = pluginFm(fm);

    // An explicit `plugin.id` is authoritative in BOTH layouts — it is the note
    // saying what it is, rather than this code inferring it from a repo name.
    if (typeof p.id === "string" && p.id) {
      noted[p.id] = path;
      if (p.version !== undefined) notedVersion[p.id] = String(p.version);
      continue;
    }

    if (notesSource !== "jd-slots") continue;
    // A slot folder holds more than its folder note; only the folder note
    // represents the repo.
    if (!isFolderNote(path)) continue;

    const repo = repoNameOf(fm);
    if (repo === null) continue; // not a repo slot at all (an inbox, an index) — not a finding
    const id = matchInstalledId(repo, installedIds);
    if (id === null) {
      unmatchedSlots.push(path);
      continue;
    }
    noted[id] = path;
    const v = p.version ?? fm?.["plugin-version"];
    if (v !== undefined) notedVersion[id] = String(v);
  }
  unmatchedSlots.sort();

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

  return { installed, enabled, noted, unnoted, staleVersion, unmatchedSlots };
}
