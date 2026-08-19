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
  /** Every vault path that already exists — the planner never overwrites. */
  existingPaths: Set<string>;
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
  existingPaths: Set<string>;
}

export type PromoteToFolderPlan =
  | { ok: true; folderPath: string; newFilePath: string }
  | { ok: false; reason: "not_id_note" | "already_cover_note" | "folder_exists" };
