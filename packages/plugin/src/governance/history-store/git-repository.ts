// GIT REPOSITORY — the live HistoryRepository over isomorphic-git (WP4).
//
// The dependency was selected through the bounded spike D10's guide requires:
// isomorphic-git proved blob/tree/commit round-trips, ref reads and writes,
// merge-base inspection, tree diffs, and stock-git-readable loose objects,
// pure-JS, no system git binary, MIT, ~232 KB minified. The pure-JS
// requirement disqualified the native-binding alternatives. THIS IS THE ONLY
// GIT ADAPTER — a system-git operator adapter, if one ever exists, replaces
// this behind the same interface rather than coexisting with it.
//
// CAS: isomorphic-git has no native compare-and-swap, so it is implemented
// here as read-check-write inside a per-instance mutex. That is sound because
// the plugin is the single writer to its own outside-vault git directory —
// one process, one instance per vault, every mutation serialized. The mutex
// closes the same-instance interleaving; nothing else writes these refs.
//
// Identity: the committer of record is fixed to Governor. Authority NEVER
// derives from Git author fields; who authorized a change lives in the
// operation and admission records, not in commit metadata.

import git from "isomorphic-git";
import * as fs from "node:fs";
import {
  ObjectCorruptError,
  ObjectMissingError,
  RefCasError,
  type CommitInput,
  type CommitRecord,
  type ObjectId,
  type SnapshotFile,
  type TreeDiffEntry,
  type TreeEntry,
} from "../../kernel/governance/history-store/types.js";
import type { HistoryRepository } from "../../kernel/governance/history-store/repository.js";
import { normalizeVaultPath } from "../../kernel/governance/history-store/history-scope.js";

/** The fixed machine identity. Not an authority claim — see the header. */
const COMMITTER = { name: "governor", email: "governor@local" };

export interface GitRepositoryOpts {
  /** The outside-vault git directory (local-data-root.historyDir). */
  gitdir: string;
  /** The vault root — the visible working tree (D10/D11). */
  worktree: string;
  /** Injectable for tests; defaults to node:fs. */
  fsModule?: typeof fs;
}

export async function openGitRepository(opts: GitRepositoryOpts): Promise<HistoryRepository> {
  const f = opts.fsModule ?? fs;
  const base = { fs: f, dir: opts.worktree, gitdir: opts.gitdir };

  // Idempotent: creates the git directory if absent, touches nothing in the
  // worktree (isomorphic-git's init writes only under gitdir).
  await git.init({ ...base, defaultBranch: "main" });

  // The CAS mutex: one chain, every ref mutation appended to it.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    // Failures must not wedge the chain — the NEXT caller starts regardless.
    chain = next.catch(() => undefined);
    return next;
  }

  async function resolveRefOrNull(ref: string): Promise<ObjectId | null> {
    try {
      return await git.resolveRef({ ...base, ref });
    } catch (e) {
      // ONLY genuine absence maps to null. An I/O failure (EACCES, EMFILE)
      // swallowed here would let a concurrent casRef(ref, null, …) read an
      // EXISTING ref as absent and force-write over it — the one interleaving
      // CAS exists to prevent, reintroduced by a transient read error.
      const name = (e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name ?? "";
      const msg = e instanceof Error ? e.message : String(e);
      if (name === "NotFoundError" || /Could not find/i.test(msg)) return null;
      throw e;
    }
  }

  function casRef(ref: string, expected: ObjectId | null, next: ObjectId): Promise<void> {
    return serialized(async () => {
      const actual = await resolveRefOrNull(ref);
      if (actual !== expected) throw new RefCasError(ref, expected, actual);
      await git.writeRef({ ...base, ref, value: next, force: true });
    });
  }

  async function readCommitRecord(oid: ObjectId): Promise<CommitRecord> {
    try {
      const r = await git.readCommit({ ...base, oid });
      return {
        oid,
        message: r.commit.message,
        tree: r.commit.tree,
        parents: r.commit.parent,
        timestamp: r.commit.committer.timestamp,
      };
    } catch (e) {
      throw translate(oid, e);
    }
  }

  return {
    async writeBlob(bytes) {
      return git.writeBlob({ ...base, blob: bytes });
    },

    async readBlob(oid) {
      try {
        const { blob } = await git.readBlob({ ...base, oid });
        return blob;
      } catch (e) {
        throw translate(oid, e);
      }
    },

    async writeTree(entries) {
      // isomorphic-git requires tree entries sorted per Git's own rule; it
      // sorts internally, so caller order is not meaning here.
      return git.writeTree({ ...base, tree: entries });
    },

    async readTree(oid) {
      try {
        const { tree } = await git.readTree({ ...base, oid });
        return tree.map((e) => ({ mode: e.mode as TreeEntry["mode"], path: e.path, oid: e.oid, type: e.type as TreeEntry["type"] }));
      } catch (e) {
        throw translate(oid, e);
      }
    },

    async writeCommit(input) {
      const author = { ...COMMITTER, timestamp: input.timestamp, timezoneOffset: 0 };
      return git.writeCommit({
        ...base,
        commit: { message: input.message, tree: input.tree, parent: input.parents, author, committer: author },
      });
    },

    readCommit: readCommitRecord,

    async diffTrees(before, after) {
      // The well-known empty tree is not present in a fresh object store —
      // materialize it before walking so `null` genuinely means "empty tree"
      // rather than "missing object". writeTree([]) yields exactly this oid.
      if (before === null || after === null) {
        const empty = await git.writeTree({ ...base, tree: [] });
        if (empty !== EMPTY_TREE_OID) throw new Error(`empty tree wrote as ${empty}; expected ${EMPTY_TREE_OID}`);
      }
      const trees = [
        git.TREE({ ref: before ?? EMPTY_TREE_OID }),
        git.TREE({ ref: after ?? EMPTY_TREE_OID }),
      ];
      const out: TreeDiffEntry[] = [];
      await git.walk({
        ...base,
        trees,
        map: async (p, [a, b]) => {
          if (p === ".") return;
          const at = a && (await a.type());
          const bt = b && (await b.type());
          // Descend through directories; report blobs only.
          if (at === "tree" || bt === "tree") return;
          const ao = a ? await a.oid() : null;
          const bo = b ? await b.oid() : null;
          if (ao !== bo) out.push({ path: p, before: ao, after: bo });
        },
      });
      return out;
    },

    resolveRef: resolveRefOrNull,

    casRef,

    async log(ref, depth) {
      const entries = await git.log({ ...base, ref, depth });
      return entries.map((r) => ({
        oid: r.oid,
        message: r.commit.message,
        tree: r.commit.tree,
        parents: r.commit.parent,
        timestamp: r.commit.committer.timestamp,
      }));
    },

    async recordSnapshot(args) {
      // Paths are validated with the SAME discipline the history scope
      // applies, and for the same reason refs.ts validates components: tree
      // entries are structural. Empirically, an empty segment ("a//b", "a/",
      // "") writes a tree stock git's fsck rejects as unparsable, and "../x"
      // writes a literal ".." entry — a write-outside-the-vault traversal
      // waiting for any future materializer. Duplicates after normalization
      // are refused rather than silently last-wins.
      const seen = new Set<string>();
      const files: SnapshotFile[] = args.files.map((file) => {
        // A trailing slash names a directory, and a snapshot file cannot be
        // one — normalization would silently strip it ("a/" → "a") and write
        // a blob where the caller described a folder, so it refuses instead.
        if (file.path.endsWith("/")) {
          throw new Error(`refusing snapshot path '${file.path}': a file path cannot end in '/'`);
        }
        const p = normalizeVaultPath(file.path);
        if (p === null || p === "" || p === "." || p.split("/").some((seg) => seg === "")) {
          throw new Error(`refusing snapshot path '${file.path}': not a clean vault-relative path`);
        }
        if (seen.has(p)) throw new Error(`refusing snapshot: path '${p}' appears twice`);
        seen.add(p);
        return { path: p, bytes: file.bytes };
      });

      // Objects first, ref last — a crash mid-way leaves content-addressed
      // objects without a ref (recovery: ref-behind / re-record), never a ref
      // naming objects that do not exist.
      const entries: TreeEntry[] = [];
      const missing: string[] = [];
      for (const file of files) {
        if (file.bytes === null) {
          // D06: a disappearance is recorded as a fact in the message, not
          // invented as empty content.
          missing.push(file.path);
          continue;
        }
        const oid = await git.writeBlob({ ...base, blob: file.bytes });
        entries.push({ mode: "100644", path: file.path, oid, type: "blob" });
      }
      const tree = await buildNestedTree(base, entries);
      const parent = args.expectedRef === null ? [] : [args.expectedRef];
      const message = missing.length === 0 ? args.message : `${args.message}\n\nmissing: ${missing.join(", ")}`;
      const author = { ...COMMITTER, timestamp: args.timestamp, timezoneOffset: 0 };
      const oid = await git.writeCommit({
        ...base,
        commit: { message, tree, parent, author, committer: author },
      });
      await casRef(args.ref, args.expectedRef, oid);
      return { oid, message, tree, parents: parent, timestamp: args.timestamp };
    },
  };
}

/** isomorphic-git's well-known empty tree oid. */
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Build a nested tree from flat path entries. Git trees are one level deep;
 * a path "a/b/c.md" needs a tree for "a" containing a tree for "b".
 */
async function buildNestedTree(
  base: { fs: typeof fs; dir: string; gitdir: string },
  entries: TreeEntry[]
): Promise<ObjectId> {
  interface Node {
    children: Map<string, Node>;
    blobs: TreeEntry[];
  }
  const root: Node = { children: new Map(), blobs: [] };
  for (const e of entries) {
    const parts = e.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), blobs: [] };
        node.children.set(part, child);
      }
      node = child;
    }
    node.blobs.push({ ...e, path: parts[parts.length - 1] });
  }
  async function writeNode(node: Node): Promise<ObjectId> {
    const tree: TreeEntry[] = [...node.blobs];
    for (const [name, child] of node.children) {
      tree.push({ mode: "040000", path: name, oid: await writeNode(child), type: "tree" });
    }
    return git.writeTree({ ...base, tree });
  }
  return writeNode(root);
}

/**
 * Map isomorphic-git's errors onto the typed contract.
 *
 * The principle, not a message-pattern list: for a well-formed oid, "not
 * found" is the ONLY non-corruption failure a read has — everything else
 * means the object exists but cannot be read back as what it claims to be.
 * isomorphic-git does not make this easy to do by pattern: a zlib failure
 * surfaces as a mangled TypeError ("Cannot create property 'caller' on
 * string 'incorrect header check'"), which no sane regex should be asked to
 * recognize. Classifying by the one distinguishable case is robust where
 * pattern-matching the library's error strings is not.
 */
function translate(oid: string, e: unknown): Error {
  const name = (e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "NotFoundError" || /Could not find/i.test(msg)) return new ObjectMissingError(oid);
  return new ObjectCorruptError(oid, msg);
}
