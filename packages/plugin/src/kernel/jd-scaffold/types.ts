// Pure types for the jd-scaffold module (standard-zeros + promote-to-folder,
// Stage A of the jd-dashboard fold). No `obsidian` import anywhere in this
// file or its siblings — see packages/plugin/CLAUDE.md's kernel discipline.
// Vault I/O (existing-path listings, folder enumeration) happens in the glue
// layer (mcp/tools-jd-scaffold.ts); everything here works on already-resolved
// data.

export type ZeroId = "00" | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09";

export interface ZeroSpec {
  id: ZeroId;
  name: string;
  tag: `jd/${string}`;
  hasDir: boolean;
}

export interface PlannedCreate {
  path: string;
  content: string;
}

export interface PlanStandardZerosInput {
  folderPath: string;
  folderName: string;
  prefix: string;
  now: string;
  /** Existence check for a candidate path — the planner never overwrites.
   *  A predicate rather than a pre-built Set: the glue layer would otherwise
   *  have to independently enumerate the same 10 candidate paths this
   *  planner computes just to build the Set, risking the two falling out of
   *  sync. `(path) => !!app.vault.getAbstractFileByPath(path)` is the real
   *  implementation. */
  exists: (path: string) => boolean;
}

export interface PlanStandardZerosResult {
  creates: PlannedCreate[];
  /** Paths that already existed and were left alone. */
  skipped: string[];
}

/** One category folder as discovered by the glue layer — depth-2 `XX <name>`
 *  folders, per ensureCategoryIndexes' original scope. `childBasenames` is
 *  that folder's own immediate children's basenames (not a recursive
 *  listing) — enough to run the XX.00/XX.00.md/XX.00+SUF acceptance check. */
export interface CategoryFolderInput {
  path: string;
  name: string;
  prefix: string;
  childBasenames: string[];
}

export interface PlanEnsureResult {
  creates: PlannedCreate[];
}

export interface PlanPromoteInput {
  path: string;
  /** Existence check for the single computed folder-destination path — same
   *  predicate shape as PlanStandardZerosInput.exists, for the same reason:
   *  the glue layer checks the ONE real path via
   *  app.vault.getAbstractFileByPath directly, no pre-built listing. */
  exists: (path: string) => boolean;
}

export type PromoteToFolderPlan =
  | { ok: true; folderPath: string; newFilePath: string }
  | { ok: false; reason: "not_id_note" | "already_cover_note" | "folder_exists" };
