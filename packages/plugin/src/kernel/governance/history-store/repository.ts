// HISTORY REPOSITORY — the interface proposal and admission services use (WP4).
//
// Repository-neutral: nothing here names isomorphic-git, and a system-git
// operator adapter could implement the same surface (D10's separate-operator
// possibility). Two deliberate absences shape the whole interface:
//
//   1. NO raw ref write. The only advancement is compare-and-swap, so a
 //     stale writer gets a typed RefCasError instead of silently clobbering
//      an admission another path just recorded. D08: no external tool — and
//      no careless internal one — advances Governor refs directly.
//   2. NO wall clock and NO identity. Timestamps arrive in CommitInput;
//      authorship is fixed by the adapter to Governor's own committer of
//      record, because authority never derives from Git author fields.
//
// Reads report absence and corruption as TYPED errors (ObjectMissingError /
// ObjectCorruptError) — a missing object is evidence about the store, never
// an empty result.

import type { CommitInput, CommitRecord, ObjectId, SnapshotFile, TreeDiffEntry, TreeEntry } from "./types.js";

export interface HistoryRepository {
  /** Store exact bytes; content-addressed, idempotent. */
  writeBlob(bytes: Uint8Array): Promise<ObjectId>;
  /** Exact bytes back, or ObjectMissingError / ObjectCorruptError. */
  readBlob(oid: ObjectId): Promise<Uint8Array>;

  writeTree(entries: TreeEntry[]): Promise<ObjectId>;
  readTree(oid: ObjectId): Promise<TreeEntry[]>;

  writeCommit(input: CommitInput): Promise<ObjectId>;
  readCommit(oid: ObjectId): Promise<CommitRecord>;

  /** Path-granular diff between two tree oids (null = empty tree). */
  diffTrees(before: ObjectId | null, after: ObjectId | null): Promise<TreeDiffEntry[]>;

  /** Current value of a ref, or null when it does not exist. */
  resolveRef(ref: string): Promise<ObjectId | null>;

  /**
   * Compare-and-swap ref advancement — the ONLY way a ref moves. `expected`
   * null means "the ref must not exist yet". Throws RefCasError when the ref
   * is not at its expected value; the caller re-reads and re-decides, never
   * retries blindly.
   *
   * The adapter serializes CAS internally (single writer per repository
   * instance); cross-process safety comes from the plugin being the one
   * writer to its own outside-vault git directory.
   */
  casRef(ref: string, expected: ObjectId | null, next: ObjectId): Promise<void>;

  /** Commit history from a ref, newest first, bounded. */
  log(ref: string, depth: number): Promise<CommitRecord[]>;

  /**
   * Record a snapshot of visible working-tree files onto a ref (D11: the
   * working tree is where proposed bytes live; the repository RECORDS them,
   * it never materializes anything into the vault). Missing files are
   * recorded as missing (D06: a disappearance is a fact, not a revocation).
   * Returns the new commit. CAS semantics on the ref via `expectedRef`.
   */
  recordSnapshot(args: {
    ref: string;
    files: SnapshotFile[];
    message: string;
    timestamp: number;
    expectedRef: ObjectId | null;
  }): Promise<CommitRecord>;
}
