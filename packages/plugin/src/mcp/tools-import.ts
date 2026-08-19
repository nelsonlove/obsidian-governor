// obsidian_import_apple_notes (#252) — drive the STOCK community
// obsidian-importer plugin's Apple Notes importer headlessly, so the vault can
// run the catalog build (no fork) and agents get a first-class MCP tool
// instead of a fire-and-forget palette command.
//
// How it works (the issue's design sketch, verified against importer 2.6.2):
// upstream 2.x replaced the import modal with an `ImporterHost` whose step
// elements are NULLABLE — `draw()`/`addSetting()` no-op against a null
// element — and made folder selection an explicit `selectedFolders: number[]`
// field. TS `private` doesn't exist at runtime, and the plugin instance
// exposes its importer classes at `plugin.importers['apple-notes'].importer`,
// so this tool constructs the stock importer with a null-element host, awaits
// `importer.ready`, selects folders itself, and runs `importer.import(ctx)`
// against a duck-typed ImportContext (DOM-free in 2.x).
//
// NO STABILITY CONTRACT: everything this rides — `plugin.importers`, the
// host-with-null-elements construction, `selectedFolders`, `ready`,
// `dataPath`/`readableDataFolder` — is importer INTERNAL, verified against
// 2.6.2 only. Hence the version gate: any installed importer version outside
// KNOWN_GOOD_IMPORTER_VERSIONS refuses loudly (`importer_version_unsupported`)
// rather than breaking silently. Extend the list only after re-verifying each
// touchpoint against the new version.
//
// Headless trap (found live, must not regress): the importer only initializes
// its private `dataPath` inside `addAccessSetting()`, which early-returns when
// the host has no source element — so a headlessly-constructed importer has no
// `dataPath` even when Notes access is fully granted, and worse,
// `getNotesDatabase()` would fall back to `askForDataFolder()`, which opens a
// NATIVE Electron dialog. This tool therefore probes
// `importer.readableDataFolder()` itself (TS-private, runtime-callable) and
// refuses (`notes_access_missing`) while `dataPath` is still null — an import
// can never reach the dialog path.
//
// Folder selection is the reference branch's `selectAllFolders` transplanted:
// query the Notes database for folders and exclude Smart and Trash folders by
// ZFOLDERTYPE (never by localized name), plus any caller-named folders (the
// post-import "Exported" folder in move mode, so its contents don't re-import
// into a subfolder). The query runs through the system `sqlite3` binary
// (read-only, JSON output) — the same binary the importer's own bundled
// SQLiteTag spawns — because the importer's SQLite machinery is not reachable
// from outside its bundle.
//
// Source disposition (optional, off by default): after a CLEAN import (not
// cancelled, zero failures), move the imported originals to an "Exported"
// folder in Notes, or delete them (Recently Deleted, 30-day recovery), via
// AppleScript against Notes.app. Only notes not modified since the import
// started are touched, and the "Shared" / "Recently Deleted" folders (plus
// the Exported target, in move mode) are never touched — those two names are
// matched in English, the same caveat the fork carried; the ZFOLDERTYPE-based
// exclusion on the IMPORT side avoids the worst of it. `disposition_dry_run`
// emits a count-only script that provably contains no mutating statements.
//
// Registration follows the tools-integrations.ts precedent: registered only
// when the importer plugin's instance is actually LOADED
// (`app.plugins.plugins['obsidian-importer']`, not `enabledPlugins`), and the
// handler re-resolves the instance per call, so a mid-session disable fails
// loudly (`importer_unavailable`) instead of driving a stale instance.
// Mutating (`readOnlyHint: false`), so the guard gives it read-only-mode
// blocking, the write queue, the journal and the kernel args for free. The
// import's blast radius is bounded by `output_folder` (every created file
// lands under it), which is not a recognized PATH_KEYS argument name — so the
// handler checks it against the allowlist itself via `isVisible`, refusing
// `out_of_allowlist` before anything runs.
//
// Kernel caveat, documented rather than worked around: a large import (or a
// large AppleScript disposition) can exceed the write queue's 30s operation
// window. The queue then reports `write_timeout` to the caller while the
// import CONTINUES (Obsidian exposes no cancellation) and the journal records
// a corrective `late-ok`/`late-error` — check the output folder afterwards.
// Run `dry_run: true` first to size the import.

import { z } from "zod";
import { posix, join } from "node:path";
import { execFile } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok, fail, codedError } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";

export const IMPORTER_PLUGIN_ID = "obsidian-importer";

/**
 * Importer versions every internal touchpoint of this tool has been verified
 * against. An EXACT list, not a semver range: the surface this tool rides is
 * undocumented plugin internals, so even a patch release is unproven until
 * someone re-checks `plugin.importers`, the null-element host construction,
 * `selectedFolders`, `ready`, and `dataPath`/`readableDataFolder`.
 */
export const KNOWN_GOOD_IMPORTER_VERSIONS = ["2.6.2"];

export function importerVersionSupported(version: string | undefined): version is string {
  return typeof version === "string" && KNOWN_GOOD_IMPORTER_VERSIONS.includes(version);
}

/** ZFOLDERTYPE values in the Notes database (importer's ANFolderType, 2.6.2). */
export const AN_FOLDER_TYPE = { default: 0, trash: 1, smart: 3 } as const;

const NOTE_DB = "NoteStore.sqlite";

// ── structural types over the importer's runtime surface ────────────────────
// Deliberately structural (no import from the importer, which isn't a package
// we depend on): this is exactly the set of touchpoints the version gate
// vouches for.

export interface ImporterHostLike {
  sourceEl: null;
  outputEl: null;
  optionsEl: null;
  plugin: ImporterPluginLike;
  importerId: string;
  abortController: AbortController;
}

export interface AppleNotesImporterLike {
  ready: Promise<void>;
  notAvailable: boolean;
  outputLocation: string;
  filePrefixFormat: string;
  selectedFolders: number[];
  /** TS-private on the real class; runtime-accessible, and null/undefined when constructed headlessly. */
  dataPath?: string | null;
  /** TS-private on the real class; runtime-callable. Returns the readable Notes data folder or null. */
  readableDataFolder?: () => string | null;
  import(ctx: HeadlessImportContext): Promise<void>;
}

export type AppleNotesImporterClass = new (app: App, host: ImporterHostLike) => AppleNotesImporterLike;

export interface ImporterPluginLike {
  manifest?: { version?: string };
  importers?: Record<string, { importer?: AppleNotesImporterClass }>;
}

export interface ImportToolsCtx {
  /** Resolve the LOADED importer plugin instance (`app.plugins.plugins[IMPORTER_PLUGIN_ID]`), or null. Re-resolved per call. */
  importerPlugin: () => ImporterPluginLike | null;
  getSettings?: () => GuardSettings;
  /** Read-only SQL against a SQLite db file, rows out. Injected in tests; live default spawns `sqlite3 -readonly -json`. */
  querySqlite?: (dbPath: string, sql: string) => Promise<Array<Record<string, unknown>>>;
  /** Run an AppleScript, trimmed stdout out. Injected in tests; live default spawns `osascript -e`. */
  runAppleScript?: (script: string) => Promise<string>;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
}

// ── duck-typed ImportContext ────────────────────────────────────────────────
// The 2.x ImportContext is DOM-free, so this mirrors its full public surface
// (import-context.ts @ 2.6.2) minus the protected on* render hooks. The
// importer only ever drives it through these methods; keeping the whole
// surface (pause/resume/log/progress included) means a future importer call
// into any public member finds it, rather than a TypeError mid-import.

export interface ImportLogEntryLike {
  outcome: "skipped" | "failed" | "message";
  name: string;
  reason?: unknown;
}

export class HeadlessImportContext {
  notes = 0;
  attachments = 0;
  skipped: string[] = [];
  failed: string[] = [];
  log: ImportLogEntryLike[] = [];
  statusMessage = "";
  cancelled = false;
  checkpoints = 0;
  progressCurrent = 0;
  progressTotal = 0;

  private paused = false;
  private waiting: Array<() => void> = [];

  status(message: string): void {
    this.statusMessage = message;
  }

  reportNoteSuccess(_name: string): void {
    this.notes++;
  }

  reportAttachmentSuccess(_name: string): void {
    this.attachments++;
  }

  reportMessage(message: string): void {
    this.log.push({ outcome: "message", name: message });
  }

  reportSkipped(name: string, reason?: unknown): void {
    this.skipped.push(name);
    this.log.push({ outcome: "skipped", name, reason });
  }

  reportFailed(name: string, reason?: unknown): void {
    this.failed.push(name);
    this.log.push({ outcome: "failed", name, reason });
    console.error("Import failed", name, reason);
  }

  reportProgress(current: number, total: number): void {
    if (total <= 0) return;
    this.progressCurrent = current;
    this.progressTotal = total;
  }

  cancel(): void {
    this.cancelled = true;
    this.resume();
  }

  pause(): void {
    if (this.paused || this.cancelled) return;
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const waiting = this.waiting;
    this.waiting = [];
    for (const wake of waiting) wake();
  }

  isPaused(): boolean {
    return this.paused;
  }

  finish(): void {}

  isCancelled(): boolean {
    return this.cancelled;
  }

  async shouldStop(): Promise<boolean> {
    this.checkpoints++;
    while (this.paused && !this.cancelled) {
      await new Promise<void>((wake) => this.waiting.push(wake));
    }
    return this.cancelled;
  }
}

// ── folder selection (selectAllFolders, transplanted) ───────────────────────

export interface AppleNotesFolderInfo {
  id: number;
  name: string;
  type: number;
  /** Notes in this folder (title-bearing), from the same count query the importer's own picker runs. */
  notes: number;
}

export interface FolderSelection {
  selected: AppleNotesFolderInfo[];
  excluded: Array<{ name: string; reason: "smart" | "trash" | "excluded_name" }>;
}

/**
 * The reference branch's `selectAllFolders` filter as a pure function: keep
 * every folder that is not Smart, not Trash (both by ZFOLDERTYPE — never by
 * localized name), and not in `excludeNames` (the Exported folder in move
 * mode, matched by name because it is caller-named).
 */
export function selectImportableFolders(folders: AppleNotesFolderInfo[], excludeNames: string[]): FolderSelection {
  const selected: AppleNotesFolderInfo[] = [];
  const excluded: FolderSelection["excluded"] = [];
  for (const folder of folders) {
    if (folder.type === AN_FOLDER_TYPE.smart) excluded.push({ name: folder.name, reason: "smart" });
    else if (folder.type === AN_FOLDER_TYPE.trash) excluded.push({ name: folder.name, reason: "trash" });
    else if (excludeNames.includes(folder.name)) excluded.push({ name: folder.name, reason: "excluded_name" });
    else selected.push(folder);
  }
  return { selected, excluded };
}

/**
 * Read the folder listing out of the Notes database — the same three queries
 * the importer's own `readFolders()` picker runs (entity keys from
 * z_primarykey, then folders + per-folder note counts), minus the tree
 * building this tool doesn't need.
 */
async function readAppleNotesFolders(
  query: (dbPath: string, sql: string) => Promise<Array<Record<string, unknown>>>,
  dbPath: string
): Promise<AppleNotesFolderInfo[]> {
  const keys = await query(dbPath, "SELECT z_ent AS ent, z_name AS name FROM z_primarykey");
  const entOf = (name: string): number | null => {
    const row = keys.find((r) => r.name === name);
    const ent = row ? Number(row.ent) : NaN;
    return Number.isInteger(ent) ? ent : null;
  };
  const folderEnt = entOf("ICFolder");
  if (folderEnt === null) {
    throw new Error("could not find the ICFolder entity key in the Notes database (z_primarykey) — unexpected schema");
  }
  const folders = await query(
    dbPath,
    `SELECT z_pk AS pk, ztitle2 AS title, zfoldertype AS type FROM ziccloudsyncingobject WHERE z_ent = ${folderEnt} AND ztitle2 IS NOT NULL`
  );
  const noteEnt = entOf("ICNote");
  const counts = new Map<number, number>();
  if (noteEnt !== null) {
    const rows = await query(
      dbPath,
      `SELECT zfolder AS folder, COUNT(*) AS notes FROM ziccloudsyncingobject WHERE z_ent = ${noteEnt} AND ztitle1 IS NOT NULL GROUP BY zfolder`
    );
    for (const row of rows) counts.set(Number(row.folder), Number(row.notes) || 0);
  }
  return folders.map((f) => ({
    id: Number(f.pk),
    name: String(f.title),
    type: Number(f.type),
    notes: counts.get(Number(f.pk)) ?? 0,
  }));
}

// ── source disposition (buildDispositionScript, transplanted verbatim) ──────

/**
 * Builds the AppleScript that moves imported source notes into an Exported
 * folder, or deletes them (to Recently Deleted, 30-day recovery). Only notes
 * not modified since `before` are affected, and the "Shared" and
 * "Recently Deleted" folders (plus the Exported target, in move mode) are
 * never touched. In dry-run it returns a count-only script that emits no
 * mutating statements, so a dry run provably cannot mutate Notes.
 */
export function buildDispositionScript(
  mode: "move" | "delete",
  before: Date,
  exportedFolder: string,
  dryRun: boolean
): string {
  const tod = before.getHours() * 3600 + before.getMinutes() * 60 + before.getSeconds();
  const exp = exportedFolder.replace(/["\\]/g, "");
  const cutoff = [
    "set cutoff to current date",
    `set year of cutoff to ${before.getFullYear()}`,
    `set month of cutoff to ${before.getMonth() + 1}`,
    `set day of cutoff to ${before.getDate()}`,
    `set time of cutoff to ${tod}`,
  ].join("\n\t");

  // Folders disposition never touches. "Recently Deleted" is already excluded
  // from Notes' app-level `folders`, but we guard it explicitly; "Shared" holds
  // notes shared with other people. In move mode the Exported target is also
  // skipped so already-moved notes aren't re-moved. Names are matched
  // literally, so a non-English Notes UI would need localized names here.
  const protectedFolders = mode === "move" ? [exp, "Shared", "Recently Deleted"] : ["Shared", "Recently Deleted"];
  const notExcluded = protectedFolders.map((name) => `fn is not "${name}"`).join(" and ");

  if (dryRun) {
    // Count-only: no delete/move/make statements are emitted.
    return [
      'tell application "Notes"',
      "\t" + cutoff,
      "\tset n to 0",
      "\trepeat with f in folders",
      "\t\tset fn to name of f",
      `\t\tif ${notExcluded} then`,
      "\t\t\trepeat with x in (notes of f)",
      "\t\t\t\tif modification date of x ≤ cutoff then set n to n + 1",
      "\t\t\tend repeat",
      "\t\tend if",
      "\tend repeat",
      "\treturn n",
      "end tell",
    ].join("\n");
  }

  const action = mode === "delete" ? "delete x" : `move x to folder "${exp}"`;
  const ensureTarget =
    mode === "move" ? [`\tif not (exists folder "${exp}") then make new folder with properties {name:"${exp}"}`] : [];
  return [
    'tell application "Notes"',
    ...ensureTarget,
    "\t" + cutoff,
    "\tset n to 0",
    "\trepeat with f in folders",
    "\t\tset fn to name of f",
    `\t\tif ${notExcluded} then`,
    // Snapshot the folder's notes and iterate in reverse so deleting/moving a
    // note doesn't shift the indices of ones not yet processed.
    "\t\t\tset ns to notes of f",
    "\t\t\trepeat with i from (count of ns) to 1 by -1",
    "\t\t\t\tset x to item i of ns",
    "\t\t\t\tif modification date of x ≤ cutoff then",
    `\t\t\t\t\t${action}`,
    "\t\t\t\t\tset n to n + 1",
    "\t\t\t\tend if",
    "\t\t\tend repeat",
    "\t\tend if",
    "\tend repeat",
    "\treturn n",
    "end tell",
  ].join("\n");
}

// ── live subprocess defaults ────────────────────────────────────────────────
// Injected in tests; live they spawn the system binaries. `sqlite3` is what
// the importer's own SQLiteTag spawns; `-readonly` so the Notes database is
// never opened writable, `-json` for structured rows.

function defaultQuerySqlite(dbPath: string, sql: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    execFile(
      "sqlite3",
      ["-readonly", "-json", dbPath, sql],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error((stderr || "").trim() || error.message));
        const text = String(stdout).trim();
        if (!text) return resolve([]);
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`sqlite3 emitted unparseable JSON: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    );
  });
}

function defaultRunAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || "").trim() || error.message));
        else resolve(String(stdout).trim());
      }
    );
  });
}

// Mutating; `openWorldHint: true` because it reaches outside the vault — it
// reads the Apple Notes database and, with a disposition, drives Notes.app
// via AppleScript. `destructiveHint: false`: vault writes are creations
// (duplicates skip, never overwrite), and the "delete" disposition sends
// source notes to Recently Deleted (30-day recovery).
const IMPORT_RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function registerImportTools(server: McpServer, app: App, ctx: ImportToolsCtx): void {
  // Register only when the importer plugin's instance is actually LOADED —
  // the tools-integrations.ts precedent (enabledPlugins can list a
  // configured-but-uninstalled plugin). The tool appears on session reconnect
  // after the plugin is enabled; the handler still re-resolves per call.
  if (!ctx.importerPlugin()) return;

  const querySqlite = ctx.querySqlite ?? defaultQuerySqlite;
  const runAppleScript = ctx.runAppleScript ?? defaultRunAppleScript;
  const now = ctx.now ?? (() => new Date());

  server.registerTool(
    "obsidian_import_apple_notes",
    {
      title: "Import Apple Notes via the community Importer plugin (headless)",
      description:
        "Run the community obsidian-importer plugin's Apple Notes importer headlessly: import every importable " +
        "Notes folder (Smart and Trash folders excluded by folder TYPE) into `output_folder`. Incremental — notes " +
        "unchanged since a previous import are skipped by the importer itself. Requires the community Importer " +
        `plugin (known-good version(s): ${KNOWN_GOOD_IMPORTER_VERSIONS.join(", ")}) enabled, macOS desktop, and ` +
        "Notes database access granted once via the Importer dialog. `dry_run: true` reports the folder selection " +
        "and per-folder note counts without importing. `source_disposition` optionally moves imported source notes " +
        "to an Exported folder in Notes (\"move\") or deletes them to Recently Deleted with 30-day recovery " +
        "(\"delete\") after a CLEAN import only (not cancelled, zero failures); only notes unmodified since the " +
        "import started are touched, and \"Shared\"/\"Recently Deleted\" are never touched. `disposition_dry_run: " +
        "true` counts what disposition WOULD touch via a script with no mutating statements. NOTE: a large import " +
        "can exceed the kernel's 30s write window — the call then reports `write_timeout` while the import " +
        "continues and the journal records a corrective late outcome; size it with `dry_run` first. Mutating.",
      inputSchema: {
        dry_run: z
          .boolean()
          .describe("If true, report the folder selection and per-folder note counts without importing anything."),
        output_folder: z
          .string()
          .min(1)
          .optional()
          .describe('Vault folder to import into (created if missing). Default "Apple Notes".'),
        file_prefix_format: z
          .string()
          .optional()
          .describe('moment.js date-prefix format for imported filenames (e.g. "YYYY-MM-DD"); "" = no prefix. Default "YYYY-MM-DD".'),
        source_disposition: z
          .enum(["none", "move", "delete"])
          .default("none")
          .describe(
            'What to do with each imported source note in Apple Notes after a clean import: "none" (default), ' +
              '"move" (into `exported_folder`), or "delete" (Recently Deleted, 30-day recovery).'
          ),
        exported_folder: z
          .string()
          .min(1)
          .optional()
          .describe('Apple Notes folder that imported notes are moved into when `source_disposition` is "move". Default "Exported".'),
        disposition_dry_run: z
          .boolean()
          .default(false)
          .describe("If true, disposition only COUNTS what it would move/delete — the emitted AppleScript contains no mutating statements."),
      },
      annotations: IMPORT_RW,
    },
    async ({ dry_run, output_folder, file_prefix_format, source_disposition, exported_folder, disposition_dry_run }) => {
      try {
        // ── resolve + gate the importer plugin ──────────────────────────────
        const plugin = ctx.importerPlugin();
        if (!plugin) {
          return codedError(
            "importer_unavailable",
            `the community Importer plugin ("${IMPORTER_PLUGIN_ID}") is not loaded — install and enable it ` +
              `(known-good version(s): ${KNOWN_GOOD_IMPORTER_VERSIONS.join(", ")}), then reconnect.`
          );
        }
        const version = plugin.manifest?.version;
        if (!importerVersionSupported(version)) {
          return codedError(
            "importer_version_unsupported",
            `installed obsidian-importer version ${version ?? "(unknown)"} is outside the known-good set ` +
              `(${KNOWN_GOOD_IMPORTER_VERSIONS.join(", ")}). This tool drives undocumented importer internals ` +
              "(plugin.importers, null-element host construction, selectedFolders, ready, dataPath) that carry no " +
              "stability contract, so an unverified version refuses loudly instead of breaking silently. " +
              "Re-verify those touchpoints against the installed version, then extend KNOWN_GOOD_IMPORTER_VERSIONS " +
              "in tools-import.ts."
          );
        }
        const Importer = plugin.importers?.["apple-notes"]?.importer;
        if (typeof Importer !== "function") {
          return codedError(
            "importer_unavailable",
            "the Importer plugin exposes no 'apple-notes' importer class at plugin.importers — unexpected for a known-good version."
          );
        }

        // ── options ─────────────────────────────────────────────────────────
        const outputFolder = output_folder?.trim() || "Apple Notes";
        const filePrefixFormat = file_prefix_format ?? "YYYY-MM-DD";
        const disposition = source_disposition;
        // Sanitized ONCE (quotes/backslashes stripped) and used for BOTH the
        // move-mode import exclusion and the AppleScript, so the folder the
        // script targets and the folder the next import skips cannot diverge.
        const exportedFolder = (exported_folder?.trim() || "Exported").replace(/["\\]/g, "") || "Exported";

        // Every imported file lands under `output_folder`, but that argument
        // name is not in the guard's PATH_KEYS — so this handler bounds its
        // own blast radius: normalize, refuse escapes, and under an active
        // allowlist require the output folder to be covered by it.
        const normalizedOutput = posix.normalize(outputFolder);
        if (posix.isAbsolute(normalizedOutput) || normalizedOutput === ".." || normalizedOutput.startsWith("../")) {
          return codedError("invalid_output_folder", `output_folder '${outputFolder}' is not a vault-relative folder path`);
        }
        const settings = ctx.getSettings?.();
        if (settings?.allowlist?.length && !isVisible(normalizedOutput, settings)) {
          return codedError(
            "out_of_allowlist",
            `output_folder '${normalizedOutput}' is outside the vault-mcp allowlist — every imported note would land there`
          );
        }

        // ── construct the stock importer headlessly ─────────────────────────
        const host: ImporterHostLike = {
          sourceEl: null,
          outputEl: null,
          optionsEl: null,
          plugin,
          importerId: "apple-notes",
          abortController: new AbortController(),
        };
        const importer = new Importer(app, host);
        await importer.ready;
        if (importer.notAvailable) {
          return codedError("importer_unavailable", "Apple Notes import is only available in Obsidian desktop on macOS.");
        }

        // Headless dataPath probe (see header): init() never reaches the
        // dataPath assignment without a source element, so probe the
        // importer's own readableDataFolder() and refuse while it's null —
        // otherwise import() would fall through to a native folder dialog.
        if (!importer.dataPath) {
          importer.dataPath = importer.readableDataFolder?.() ?? null;
        }
        if (!importer.dataPath) {
          return codedError(
            "notes_access_missing",
            "the Apple Notes database is not readable. Grant access once via the Importer dialog " +
              "(Settings → Importer → Apple Notes → select the data folder), then retry — headless import never " +
              "opens that dialog itself."
          );
        }

        importer.outputLocation = outputFolder;
        importer.filePrefixFormat = filePrefixFormat;

        // ── folder selection (ZFOLDERTYPE-based, never localized names) ─────
        const dbPath = join(importer.dataPath, NOTE_DB);
        const folders = await readAppleNotesFolders(querySqlite, dbPath);
        const excludeNames = disposition === "move" ? [exportedFolder] : [];
        const { selected, excluded } = selectImportableFolders(folders, excludeNames);
        if (selected.length === 0) {
          return codedError(
            "no_importable_folders",
            "no importable Apple Notes folders found. If Notes access was never granted, grant it once via the " +
              "Importer dialog first."
          );
        }
        importer.selectedFolders = selected.map((f) => f.id);

        const base = {
          importer_version: version,
          output_folder: outputFolder,
          file_prefix_format: filePrefixFormat,
          folders_selected: selected.length,
          folders: selected.map(({ id, name, notes }) => ({ id, name, notes })),
          excluded,
          source_disposition: disposition,
          ...(disposition === "move" ? { exported_folder: exportedFolder } : {}),
          disposition_dry_run,
        };

        if (dry_run) {
          return ok({ dry_run: true, ...base, notes_in_selected_folders: selected.reduce((n, f) => n + f.notes, 0) });
        }

        // ── import ──────────────────────────────────────────────────────────
        // Notes not modified since this instant are safely captured by the
        // import; notes touched during it are left for the next run, so
        // disposition never removes an un-imported note.
        const startedAt = now();
        const importCtx = new HeadlessImportContext();
        await importer.import(importCtx);

        // ── source disposition — after a CLEAN import only ──────────────────
        // Stricter than the reference branch (which gated on !cancelled
        // alone): a failed note's source would otherwise still be moved or
        // deleted while its content never reached the vault.
        let disposed = 0;
        let dispositionSkipped: string | null = null;
        if (disposition !== "none") {
          if (importCtx.cancelled) {
            dispositionSkipped = "import was cancelled";
          } else if (importCtx.failed.length > 0) {
            dispositionSkipped = `${importCtx.failed.length} note(s) failed to import — source notes left untouched`;
          } else {
            const script = buildDispositionScript(disposition, startedAt, exportedFolder, disposition_dry_run);
            const out = await runAppleScript(script);
            disposed = parseInt(out, 10) || 0;
          }
        }

        return ok({
          dry_run: false,
          ...base,
          imported: importCtx.notes,
          attachments: importCtx.attachments,
          skipped: importCtx.skipped.length,
          failed: importCtx.failed.length,
          ...(importCtx.failed.length > 0 ? { failed_names: importCtx.failed.slice(0, 20) } : {}),
          cancelled: importCtx.cancelled,
          disposed,
          ...(dispositionSkipped ? { disposition_skipped: dispositionSkipped } : {}),
          // The effects convention (guarded.ts): every created file is a real
          // vault change the journal should count. The importer reports note
          // TITLES, not vault paths, so only the count lands (no `files`).
          filesChanged: importCtx.notes + importCtx.attachments,
          finishedAt: now().toISOString(),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
