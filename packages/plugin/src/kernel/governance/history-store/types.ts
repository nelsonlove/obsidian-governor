// HISTORY STORE TYPES — repository-neutral object and ref contracts (WP4).
//
// D10: one vault-root repository, identity belonging to the vault. These types
// are what the proposal and admission services program against; the live
// isomorphic-git adapter implements them, and D08 keeps everything here
// INTERNAL — ref names, layouts, and these shapes carry no external
// compatibility promise. What IS promised externally is standard Git object
// compatibility: every object a repository stores must be readable by stock
// git, which the adapter tests prove.

/** A 40-hex SHA-1 Git object id — Git's own address, not Governor's. */
export type ObjectId = string;

const OID = /^[0-9a-f]{40}$/;

export function isObjectId(v: unknown): v is ObjectId {
  return typeof v === "string" && OID.test(v);
}

/** One entry in a tree. Modes are the Git standard trio Governor uses. */
export interface TreeEntry {
  mode: "100644" | "100755" | "040000";
  path: string;
  oid: ObjectId;
  type: "blob" | "tree";
}

/**
 * Commit metadata. The identity is FIXED — Governor is the committer of
 * record for machine commits, and authority never derives from Git author
 * fields (guide §8: "never derive identity from path or Git author"). The
 * timestamp is injected, never read from a wall clock inside the store.
 */
export interface CommitInput {
  message: string;
  tree: ObjectId;
  parents: ObjectId[];
  /** Epoch seconds, injected by the caller. */
  timestamp: number;
}

export interface CommitRecord {
  oid: ObjectId;
  message: string;
  tree: ObjectId;
  parents: ObjectId[];
  timestamp: number;
}

/** A change between two trees, path-granular. */
export interface TreeDiffEntry {
  path: string;
  before: ObjectId | null;
  after: ObjectId | null;
}

/** One file snapshotted into a proposal recording. */
export interface SnapshotFile {
  path: string;
  /** Exact bytes, or null for "recorded as missing". */
  bytes: Uint8Array | null;
}

// ── stable errors ────────────────────────────────────────────────────────────

/** A compare-and-swap ref advance found the ref not at its expected value. */
export class RefCasError extends Error {
  readonly code = "ref_cas_conflict";
  constructor(
    readonly ref: string,
    readonly expected: ObjectId | null,
    readonly actual: ObjectId | null
  ) {
    super(`ref ${ref} moved: expected ${expected ?? "<absent>"}, found ${actual ?? "<absent>"}`);
    this.name = "RefCasError";
  }
}

/** The object is not in the store. Absence is reported, never invented. */
export class ObjectMissingError extends Error {
  readonly code = "object_missing";
  constructor(readonly oid: string) {
    super(`object ${oid} is not in the history store`);
    this.name = "ObjectMissingError";
  }
}

/** The object exists but cannot be read back as what it claims to be. */
export class ObjectCorruptError extends Error {
  readonly code = "object_corrupt";
  constructor(readonly oid: string, detail: string) {
    super(`object ${oid} is corrupt: ${detail}`);
    this.name = "ObjectCorruptError";
  }
}

/** A ref name outside the validated internal namespace was refused. */
export class RefNameError extends Error {
  readonly code = "ref_name_invalid";
  constructor(detail: string) {
    super(`invalid ref name: ${detail}`);
    this.name = "RefNameError";
  }
}
