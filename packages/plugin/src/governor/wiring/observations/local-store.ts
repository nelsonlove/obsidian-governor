// The LIVE replayable-payload adapter — Gate 0, WP2 (D16, D17).
//
// The one file in the observation stack that touches a filesystem. Everything
// above it is pure; this supplies the bytes.
//
// WHERE, and why it matters more than it looks:
//
// Replayable payloads contain exact note text — the material Governor returned
// to a client. They are stored under `~/.claude/governor/observations/<vault>/`,
// which is:
//
//   • OUTSIDE the vault, so Obsidian Sync never carries them. The design is
//     explicit that observation payloads stay replica-local by default and do
//     not enter the portable ledger; putting them under `.obsidian/plugins/`
//     would hand them to Sync the moment a user enables community-plugin data
//     synchronization, which is a privacy decision they never made.
//   • per-vault, so two vaults on one machine never share a payload store. The
//     content digest alone would happily collide two vaults' identical notes,
//     and the authorization policy that governs one is not the other's.
//   • beside the socket and the bridge, which is already the established
//     outside-vault namespace for this plugin rather than a new one.
//
// It is a plain content-addressed blob directory: one file per digest, named
// for the digest. That makes the store inspectable with `ls`, recoverable by
// copying a directory, and — most usefully — verifiable by anyone, since the
// filename IS the checksum of the contents.

import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir } from "../../../paths.js";
import type { BlobStore } from "../../../kernel/observations/store.js";

/**
 * A vault slug is one path SEGMENT. `vaultSlug()` already strips separators,
 * but it preserves dots — so a name that slugged to `..` would climb out of
 * the observation directory, and this function takes a plain string from
 * whatever calls it.
 *
 * Validated rather than trusted, for the same reason the digest is: a store
 * addressed by a caller-supplied string is a traversal surface, and "the
 * caller always passes a real slug" is an assumption, not a control.
 *
 * WHY THIS LOCATION, AND NOT THE VAULT (asked on #322; the answer is the
 * adopted design, not an accident):
 *
 * D16 requires replayable payloads in "content-addressed local storage", and
 * the normative docs sharpen where: payloads are "stored locally in
 * Governor-owned, content-addressed operational storage outside the ordinary
 * Obsidian Sync file set" (observations-and-replay), and "replayable
 * observations stay in replica-local protected storage by default because
 * they can contain the exact note text or metadata returned to a client"
 * (git-and-sync). This vault IS synced — so a store inside it, including
 * inside `.obsidian/plugins/governor/`, risks shipping captured note bodies
 * to every replica, which is the exact outcome the design forbids by
 * default. Exporting payloads is designed as a separate, explicit,
 * disclosed action — not a side effect of where the files happen to sit.
 *
 * The obvious counter — every synced device already HAS these notes, so
 * replication is duplication, not exposure — fails because an observation
 * OUTLIVES ITS SOURCE. Delete a note, or edit the sensitive paragraph out,
 * and the vault propagates that removal to every replica; a synced
 * observation would carry the old bytes to every device permanently, and
 * "delete it and it is gone" would quietly stop being true. Replica-local
 * bounds retained history to one machine. (Argument owed to the
 * governor-lead session's review of #322.)
 *
 * The real cost of this choice is also real: this directory is outside the
 * vault backup. That is a retention/recovery question (D16's "retention
 * controls", still to be built), and the answer to it is a deliberate
 * export/backup step for this store — not moving note-body copies into a
 * synced tree.
 */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

/** `~/.claude/governor/observations/<vault-slug>/` */
export function observationDir(vaultSlug: string): string {
  if (!SLUG.test(vaultSlug) || vaultSlug.includes("..")) {
    throw new Error(`refusing to place the observation store at vault slug '${vaultSlug}': not a single safe path segment`);
  }
  return path.join(stateDir(), "observations", vaultSlug);
}

/**
 * A digest is `sha256:<64 hex>`. The colon is not portable across every
 * filesystem this could land on, so the file name uses the hex alone — and
 * the prefix is re-attached on the way out, so callers only ever see the
 * canonical form.
 *
 * Anything that is not exactly that shape is refused rather than sanitized. A
 * store addressed by attacker-influenced strings is a path-traversal surface,
 * and "sanitize it" is how that becomes a subtle one instead of an obvious
 * one.
 */
const DIGEST = /^sha256:([0-9a-f]{64})$/;

/** Byte length of one stored payload, or 0 if it vanished mid-walk. */
async function readMaybeSize(
  io: Pick<typeof fs.promises, "readFile">,
  abs: string
): Promise<number> {
  try {
    return (await io.readFile(abs, "utf8")).length;
  } catch {
    return 0;
  }
}

function fileFor(dir: string, key: string): string {
  const m = DIGEST.exec(key);
  if (!m) throw new Error(`refusing to address the observation store with '${key}': not a sha256 digest`);
  return path.join(dir, `${m[1]}.json`);
}

export interface LocalBlobStoreOpts {
  /** Distinguishes vaults on one machine. */
  vaultSlug: string;
  /** Injected for tests; defaults to the real filesystem. */
  fsImpl?: Pick<typeof fs.promises, "readFile" | "writeFile" | "unlink" | "readdir" | "mkdir" | "access" | "rename">;
}

/**
 * A content-addressed blob directory.
 *
 * Writes go to a temporary name and are renamed into place, so a crash or a
 * full disk can leave a partial temp file but never a half-written payload at
 * a digest that claims to describe it. The store above verifies digests on
 * read regardless; this just means the common failure produces an absent
 * payload rather than a corrupt one, and absent is the honest state.
 *
 * Known residual: a process killed between `writeFile` and `rename` leaves a
 * temp file that nothing later removes. It can never be READ as a payload
 * (`keys()` matches the digest name exactly), so it costs disk rather than
 * correctness. Sweeping them belongs with the retention pass that will own
 * this directory's housekeeping, not here.
 */
export function createLocalBlobStore(opts: LocalBlobStoreOpts): BlobStore {
  const dir = observationDir(opts.vaultSlug);
  const io = opts.fsImpl ?? fs.promises;
  let ensured = false;

  async function ensureDir(): Promise<void> {
    if (ensured) return;
    await io.mkdir(dir, { recursive: true });
    ensured = true;
  }

  return {
    async put(key, data) {
      await ensureDir();
      const target = fileFor(dir, key);
      // NO "already exists, skip" short-circuit — and the reason is worth
      // stating, because the optimization is the obvious thing to write and it
      // is wrong here.
      //
      // The key is `digest(payload)`. The DATA is `{payload, sources}`. Same
      // key does NOT mean same data: `store.ts` re-puts an existing digest
      // precisely to union in a new note's provenance when two different notes
      // share content. An existence check would silently drop that update and
      // freeze the blob at whatever sources the FIRST capture recorded —
      // reintroducing, one layer down, the exact authorization bug `store.ts`'s
      // header documents as already found and fixed once: a payload captured
      // from `Secrets/b.md` replayable by a reader entitled only to
      // `Public/a.md`.
      //
      // The caller already avoids pointless writes (it skips the re-put when
      // the union is unchanged), so the adapter's job is to write what it is
      // handed. Deciding whether a write is needed is not the storage layer's
      // business, and guessing at it is how the guarantee above got lost.
      // `<hex>.json.tmp-<pid>-<random>` — deliberately a SUFFIX of the final
      // name, so `keys()`'s exact `<hex>.json` match excludes it by
      // construction rather than by a second exclusion rule that could drift.
      //
      // Two concurrent puts of the same digest both see "not present", write
      // distinct temp files and both rename onto the same target. That is
      // benign precisely because the store is content-addressed: whichever
      // rename lands last wrote identical bytes. The pid and random suffix
      // keep the two temp files from colliding with each other.
      const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      await io.writeFile(tmp, data, "utf8");
      try {
        await io.rename(tmp, target);
      } catch (e) {
        // Leave nothing half-done behind. A stray temp file is not a payload
        // and would never be read (the keys filter requires the digest name),
        // but it would accumulate silently.
        await io.unlink(tmp).catch(() => {});
        throw e;
      }
    },

    async get(key) {
      try {
        return await io.readFile(fileFor(dir, key), "utf8");
      } catch (e) {
        // ENOENT is "not stored", which the layer above turns into
        // `payload_missing`. Any other error is a real failure and must not be
        // laundered into "absent" — a permissions problem reading a payload is
        // not the same fact as the payload having been pruned.
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw e;
      }
    },

    async has(key) {
      try {
        await io.access(fileFor(dir, key));
        return true;
      } catch {
        return false;
      }
    },

    async remove(key) {
      try {
        await io.unlink(fileFor(dir, key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
      }
    },

    async totalBytes() {
      // A directory walk, called once per connection when capture is first
      // used — not per read. Cheap enough at that cadence, and it is the only
      // way to make the cap describe the store rather than the session.
      try {
        const names = await io.readdir(dir);
        let total = 0;
        for (const n of names) {
          if (!/^[0-9a-f]{64}\.json$/.test(n)) continue;
          total += await readMaybeSize(io, path.join(dir, n));
        }
        return total;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
        throw e;
      }
    },

    async keys() {
      try {
        const names = await io.readdir(dir);
        return names
          .filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
          .map((n) => `sha256:${n.slice(0, 64)}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw e;
      }
    },
  };
}
