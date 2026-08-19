// id-migration.ts — the 0.12.0 plugin-id migration (`vault-mcp` → `governor`,
// issue #266): adopt the OLD plugin folder's data into the new plugin dir on
// first load.
//
// The old folder (`.obsidian/plugins/vault-mcp/`) holds everything that must
// not be lost: `data.json` (settings), `journal/` (the append-only write
// journal), `install-id.json`, the acceptance module's baseline store and
// acceptance log, cross-session receipts — whatever lives beside the plugin's
// own data. On load, BEFORE settings load and before the kernel opens the
// journal, the plugin moves that folder's CONTENTS (adapter `rename`, an fs
// rename on desktop — atomic per entry, no copy) into its own dir, then
// leaves a `MIGRATED.md` marker in the old folder. The old folder itself is
// NOT deleted — a human removes it after live verification.
//
// Safety posture, in order:
//   - PLAN before touching anything (planFolderMigration is pure + fixture-
//     tested); the plan either skips, aborts, or names every move up front.
//   - The old plugin's CODE artifacts (main.js, manifest.json, styles.css)
//     never move — they would overwrite the new plugin's own code.
//   - If ANY move target already exists on the new side, the whole migration
//     ABORTS loudly and moves nothing (never overwrite; never half-adopt an
//     ambiguous state).
//   - Idempotent: the marker (or an old folder with no data.json, or a new
//     dir that already has data.json) ⇒ skip.
//   - A failure must never fail the plugin load — the caller logs and
//     continues with a fresh state; the old folder is still intact.

/** Marker left in the old folder after a successful migration. */
export const MIGRATION_MARKER = "MIGRATED.md";

/** The plugin's own id (0.12.0+). Single source of truth for code that must
 * name itself — the self-preservation refusals (don't disable/reload/uninstall
 * the plugin hosting the connection) and the receipt store's plugin-dir
 * default. Must match manifest.json's `id`. */
export const PLUGIN_ID = "governor";

/** The old plugin folder name under `<configDir>/plugins/`. */
export const LEGACY_PLUGIN_ID = "vault-mcp";

/** Old-plugin code artifacts that must never be moved onto the new plugin's
 * own files. Everything else in the old folder is treated as data. */
export const CODE_ARTIFACTS = new Set(["main.js", "manifest.json", "styles.css"]);

export type MigrationPlan =
  | { action: "skip"; reason: string }
  | { action: "abort"; reason: string }
  | { action: "migrate"; entries: string[] };

export interface FolderListing {
  /** Basenames of files directly in the folder. */
  files: string[];
  /** Basenames of subfolders directly in the folder. */
  folders: string[];
}

/**
 * Decide what (if anything) to move. Pure — operates on listings only.
 *
 * `oldDir === null` means the old folder does not exist.
 */
export function planFolderMigration(
  oldDir: FolderListing | null,
  newDir: FolderListing,
): MigrationPlan {
  if (oldDir === null) {
    return { action: "skip", reason: "no legacy vault-mcp plugin folder — fresh install" };
  }
  if (oldDir.files.includes(MIGRATION_MARKER)) {
    return { action: "skip", reason: `legacy folder already carries ${MIGRATION_MARKER} — migration already ran` };
  }
  if (!oldDir.files.includes("data.json")) {
    return { action: "skip", reason: "legacy folder has no data.json — nothing to adopt" };
  }
  if (newDir.files.includes("data.json")) {
    return {
      action: "skip",
      reason:
        "the governor plugin dir already has its own data.json — not a fresh install; leaving both folders untouched",
    };
  }
  const entries = [
    ...oldDir.files.filter((f) => f !== MIGRATION_MARKER && !CODE_ARTIFACTS.has(f)),
    ...oldDir.folders,
  ];
  const newSide = new Set([...newDir.files, ...newDir.folders]);
  const conflicts = entries.filter((e) => newSide.has(e));
  if (conflicts.length > 0) {
    return {
      action: "abort",
      reason:
        `refusing to migrate: these entries already exist in the governor plugin dir and would be ` +
        `overwritten: ${conflicts.join(", ")}. Reconcile by hand, then reload.`,
    };
  }
  if (entries.length === 0) {
    // data.json is in oldDir.files and not a code artifact, so this cannot
    // happen; kept as a defensive terminal rather than an empty "migrate".
    return { action: "skip", reason: "legacy folder has nothing to move" };
  }
  return { action: "migrate", entries };
}

/** The adapter surface the migration needs — Obsidian's DataAdapter satisfies
 * it structurally; tests inject a fake. All paths vault-relative. */
export interface MigrationFs {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rename(from: string, to: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
}

export interface MigrationResult {
  plan: MigrationPlan;
  /** Entries actually moved (basenames), in order. */
  moved: string[];
  /** Set when a rename failed mid-sequence: the entry that failed. The
   * marker is NOT written in that case, and `moved` names what already
   * landed on the new side so a human can reconcile. */
  failedEntry?: string;
}

function base(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

async function listing(fs: MigrationFs, dir: string): Promise<FolderListing | null> {
  if (!(await fs.exists(dir))) return null;
  const l = await fs.list(dir);
  return { files: l.files.map(base), folders: l.folders.map(base) };
}

export function markerText(now: Date, oldDir: string, newDir: string, moved: string[]): string {
  return [
    "# Migrated to the `governor` plugin folder",
    "",
    `On ${now.toISOString()} the Governor plugin (0.12.0 id migration, vault-mcp → governor)`,
    `moved this folder's data into \`${newDir}\`:`,
    "",
    ...moved.map((m) => `- \`${m}\``),
    "",
    "Only the old plugin's own code files (main.js, manifest.json, styles.css) and this",
    "marker remain. This folder is left in place deliberately — remove it by hand after",
    `verifying the migrated data under \`${newDir}\`.`,
    "",
  ].join("\n");
}

/**
 * Run the migration `oldDir` → `newDir`. Callers gate on nothing: every
 * skip/abort decision lives in the plan. Throws only on unexpected fs errors
 * during listing; rename failures are captured in the result (loudly logged
 * by the caller) so a partial move is always reported, never hidden.
 */
export async function runFolderMigration(
  fs: MigrationFs,
  oldDir: string,
  newDir: string,
  now: () => Date = () => new Date(),
): Promise<MigrationResult> {
  const oldListing = await listing(fs, oldDir);
  const newListing = (await listing(fs, newDir)) ?? { files: [], folders: [] };
  const plan = planFolderMigration(oldListing, newListing);
  if (plan.action !== "migrate") return { plan, moved: [] };

  const moved: string[] = [];
  for (const entry of plan.entries) {
    try {
      await fs.rename(`${oldDir}/${entry}`, `${newDir}/${entry}`);
      moved.push(entry);
    } catch {
      return { plan, moved, failedEntry: entry };
    }
  }
  // Marker only after EVERY entry landed — a partial move must stay
  // re-inspectable, not be stamped "done".
  await fs.write(`${oldDir}/${MIGRATION_MARKER}`, markerText(now(), oldDir, newDir, moved));
  return { plan, moved };
}
