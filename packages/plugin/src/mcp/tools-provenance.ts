// tools-provenance.ts — the provenance module's tool surface, folded into
// vault-mcp from the standalone `obsidian-provenance` Python CLI. Three tools:
//
//   provenance_check     — general derived-content freshness of a note (read-only)
//   provenance_reconcile — the Obsidian plugin audit report (read-only)
//   provenance_regen     — regenerate the plugin-audit note; dry-run by default,
//                          `write: true` persists (MUTATING)
//
// The two read tools run the pure provenance core (kernel/provenance/*,
// Obsidian-free over an injected ProvenanceSource). `provenance_regen`'s write
// half persists a DERIVED artifact — a snapshot of the plugin audit.
//
// ── Derivation is NOT acceptance (the load-bearing distinction) ──────────────
//
// This module stamps DERIVATION metadata (`derived-from`, `generated`,
// `generator`, `derivation-mode`) — provenance of a generated artifact. That is
// ORTHOGONAL to ACCEPTANCE: it says "this note was derived from those sources at
// that time", never "a human accepted this". So:
//   - No tool here carries an accept/approve verb (the ModuleRegistry name
//     tripwire refuses those regardless).
//   - The one write tool (`provenance_regen --write`) routes through the SAME
//     accept-forbidden transition guard every vault write uses
//     (`acceptTransitionReason`, @vault-mcp/core), in `guardProvenanceWrite`
//     below — so a regen can NEVER introduce or change an `accepted` /
//     `accepted-by` / `accepted-on` field or set `acceptance-status` to an
//     accepted value, even though the rendered audit frontmatter never spells
//     one. The guard runs BEFORE the write; the write itself goes through the
//     guard-patched registrar (read-only mode, queue, journal, if_rev) because
//     it registers `readOnlyHint: false`.
//
// Obsidian-free by construction: vault state arrives through the injected
// ProvenanceBackend (structurally typed, like HealthSource / VocabSource), so
// every handler and the write guard are unit-testable headlessly. The Obsidian
// adapter is `obsidianProvenanceBackend(app)` — the only vault coupling.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AcceptForbiddenError, acceptTransitionReason, parseGuardFrontmatter } from "@vault-mcp/core";
import { ok, fail } from "./helpers.js";
import type { GuardSettings } from "../guard.js";
import {
  checkFreshness,
  reconcile,
  regenerateAudit,
  auditPath,
  provenanceConfigOf,
  type ProvenanceBackend,
  type ProvenanceSource,
  type FileStat,
  globSegmentRe,
  GENERATOR_FIELD,
  AUDIT_GENERATOR,
} from "../kernel/provenance/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export interface ProvenanceToolsCtx {
  /** The merged `modules.provenance.config` (defaults ∪ user override), as
   * `register()` receives it — resolved per connection like the module's
   * enabled state. */
  config: Record<string, unknown>;
  /** The guard's settings — retained for a future cycle that scopes the audit
   * read surface to the allowlist. The audit here
   * runs over the whole configured notes-dir (a partial audit is a misleading
   * one), so it is not applied today. Absent ⇒ unfiltered. */
  getSettings?: () => GuardSettings;
}

// ── glob over the vault filesystem (adapter-only; the one untestable seam) ────
// The segment matcher is the KERNEL's (provenance-config.ts) — one definition,
// so the expander and the witness's `globMatchesPath` cannot disagree.
//
// Translates a single glob segment (`*`, `?`, `[…]`) to an anchored RegExp,
// matching Python `fnmatch`/`Path.glob` for the patterns provenance uses
// (`.obsidian/plugins/*/manifest.json`, `{notesDir}/*.md`, a wildcard
// `derived-from` entry). `**` is not needed by any provenance pattern and is
// treated as a literal `*` segment.
interface VaultAdapter {
  stat(path: string): Promise<{ type: "file" | "folder"; mtime: number } | null>;
  read(path: string): Promise<string>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

async function safeList(adapter: VaultAdapter, dir: string): Promise<{ files: string[]; folders: string[] }> {
  try {
    return await adapter.list(dir === "" ? "/" : dir);
  } catch {
    return { files: [], folders: [] };
  }
}

/** Expand a vault-root-relative glob to sorted vault-relative FILE paths.
 * Walks the pattern one `/`-segment at a time: a wildcard non-terminal segment
 * descends into matching FOLDERS; the terminal segment matches names in the
 * candidate dirs, and a final stat pass keeps only files (Python's
 * `if p.is_file()`). */
async function globVaultRoot(adapter: VaultAdapter, pattern: string): Promise<string[]> {
  const segs = pattern.split("/").filter((s) => s.length > 0);
  let dirs: string[] = [""]; // "" = vault root
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const next: string[] = [];
    if (!/[*?[]/.test(seg)) {
      for (const d of dirs) next.push(d ? `${d}/${seg}` : seg);
    } else {
      const re = globSegmentRe(seg);
      for (const d of dirs) {
        const listing = await safeList(adapter, d);
        const names = last ? [...listing.files, ...listing.folders] : listing.folders;
        for (const full of names) {
          const name = full.split("/").pop() ?? full;
          if (re.test(name)) next.push(full);
        }
      }
    }
    dirs = next;
  }
  const out: string[] = [];
  for (const p of dirs) {
    const st = await adapter.stat(p);
    if (st && st.type === "file") out.push(p);
  }
  return out.sort();
}

/** The Obsidian adapter — the ONLY vault coupling for provenance in vault-mcp,
 * and (like the health satellite's `obsidianHealthBackend`, which was this
 * file's sibling until S7) the one part not headlessly unit-tested;
 * verify it against a running Obsidian. Duck-typed against `app` (no `obsidian`
 * import) so this file stays headless-testable. */
export function obsidianProvenanceBackend(app: {
  vault: {
    adapter: VaultAdapter;
    getAbstractFileByPath(path: string): unknown;
    modify(file: unknown, data: string): Promise<void>;
    create(path: string, data: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
  };
  metadataCache: {
    getCache(path: string): { frontmatter?: Record<string, unknown> } | null;
  };
}): ProvenanceBackend {
  const adapter = app.vault.adapter;
  return {
    noteFrontmatter(path) {
      return app.metadataCache.getCache(path)?.frontmatter ?? null;
    },
    async read(path) {
      const st = await adapter.stat(path);
      if (!st || st.type !== "file") return null;
      try {
        return await adapter.read(path);
      } catch {
        return null;
      }
    },
    async stat(path): Promise<FileStat | null> {
      const s = await adapter.stat(path);
      return s ? { type: s.type, mtime: s.mtime } : null;
    },
    glob(pattern) {
      return globVaultRoot(adapter, pattern);
    },
    async writeNote(path, text) {
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing) {
        await app.vault.modify(existing, text);
        return;
      }
      // Ensure the parent folder exists before creating a new note.
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !app.vault.getAbstractFileByPath(parent)) {
        try {
          await app.vault.createFolder(parent);
        } catch {
          /* already exists / race — proceed to create */
        }
      }
      await app.vault.create(path, text);
    },
  };
}

/**
 * The accept-forbidden guard for `provenance_regen --write`, pure and headless.
 *
 * Parses the frontmatter the regen WOULD land (`parseGuardFrontmatter`, the same
 * reader every write path uses — it THROWS `AcceptForbiddenError` on an
 * unclassifiable block rather than under-reading it) and runs the shared
 * `acceptTransitionReason` predicate against the audit note's BEFORE-on-disk
 * frontmatter. A rendered audit that introduced or changed an accepted-family
 * assertion is REFUSED and nothing is written. The rendered frontmatter carries
 * only DERIVATION fields, so a clean regen always passes — running the guard is
 * the load-bearing invariant, not a filter the tool expects to trip.
 */
export function guardProvenanceWrite(
  before: Record<string, unknown> | null,
  text: string,
): void {
  const after = parseGuardFrontmatter(text);
  const reason = acceptTransitionReason(before, after);
  if (reason) throw new AcceptForbiddenError(reason);
}

/** Refused when the audit's configured destination is a note the audit did not
 *  write. Thrown BEFORE any write, like the accept-forbidden guard. */
export class AuditDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditDestinationError";
  }
}

/**
 * Refuse to regenerate OVER a note this generator did not produce.
 *
 * The destination is configuration, and a configuration mistake here is
 * destructive rather than merely wrong: a regen replaces the whole body, and
 * human-section preservation saves nothing from a note that has no
 * `<!-- human:start -->` markers. The reachable case that prompted this —
 * `notesSource: "flat"` with the shipped JD notes root derives onto
 * `00-09 System/07 Repositories/07 Repositories.md`, the area's own folder note
 * — but the guard is deliberately general, because "the destination points at
 * someone's note" is the hazard, not that one spelling of it.
 *
 * An earlier attempt refused paths of the FOLDER-NOTE SHAPE instead. That was
 * wrong: `flatAuditPath` names the note after its folder by construction, so
 * every flat derivation has that shape and the check refused all of them. The
 * question is not what the path looks like — it is whether something else
 * already owns the file. Only the tool layer can ask that.
 *
 * A note carrying this generator's own stamp is ours to rewrite; anything else
 * — including a note with no frontmatter at all — is refused by name.
 */
export function guardAuditDestination(before: Record<string, unknown> | null, path: string): void {
  if (before === null) return; // absent, or not a note: a first-ever regen
  const gen = before[GENERATOR_FIELD];
  if (gen === AUDIT_GENERATOR) return;
  throw new AuditDestinationError(
    `refusing to regenerate over ${path}: it exists and was not generated by ${AUDIT_GENERATOR}` +
      (gen === undefined ? " (it carries no generator stamp)" : ` (generator: ${String(gen)})`) +
      ". Set the provenance module's auditNote to a path the audit owns.",
  );
}

/** Local ISO timestamp to seconds precision — the port of Python
 * `datetime.now().isoformat(timespec="seconds")`, stamped into `generated:`. */
function nowStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function registerProvenanceTools(
  server: McpServer,
  source: ProvenanceBackend,
  ctx: ProvenanceToolsCtx,
): void {
  const cfg = provenanceConfigOf(ctx.config);

  server.registerTool(
    "provenance_check",
    {
      title: "Check a derived note's freshness",
      description:
        "Report whether a derived note is FRESH or STALE against its own `derived-from:` sources. Reads the note's " +
        "`derived-from` (vault-relative globs/paths) and `generated:` timestamp and flags any source file modified " +
        "after `generated` (`changed`), any NON-GLOB entry that no longer resolves to a file (`missing` — a deleted " +
        "or moved source), and — when the note stamps the optional `derived-source-count:` witness — a source set " +
        "that has SHRUNK since generation (`sourcesRemoved`). Without that witness, deletions inside a GLOB entry " +
        "cannot be seen, and the result says so (`globDeletionsUndetectable: true`). Read-only.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Vault-relative path of the derived note to check (the Python CLI's `check <artifact>`)."),
      },
      annotations: RO,
    },
    async ({ path }) => {
      try {
        const v = await checkFreshness(source as ProvenanceSource, path);
        // Additive in SHAPE: `changed` / `sources` / `generated` keep their names
        // and meaning, and the deleted-source fields are new keys beside them.
        // `fresh` keeps its name but is deliberately STRICTER — `missing` empty
        // and no `sourcesRemoved` are new conditions, which is the whole point:
        // a note whose plain-path source was deleted used to read fresh.
        return ok({
          path,
          fresh: v.fresh,
          changed: v.changed,
          missing: v.missing,
          sources: v.sources,
          generated: new Date(v.generatedMs).toISOString(),
          ...(v.expectedSourceCount !== undefined ? { expectedSourceCount: v.expectedSourceCount } : {}),
          ...(v.sourcesRemoved ? { sourcesRemoved: v.sourcesRemoved } : {}),
          globDeletionsUndetectable: v.globDeletionsUndetectable,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "provenance_reconcile",
    {
      title: "Audit installed vs noted Obsidian plugins",
      description:
        "Compare installed plugins (.obsidian/plugins/*/manifest.json), enabled plugins " +
        "(.obsidian/community-plugins.json), and the plugin notes in the configured notes directory. Reports counts " +
        "plus which installed plugins have no note (unnoted) and which notes' versions have drifted from the " +
        "installed manifest (stale). Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const r = await reconcile(source as ProvenanceSource, cfg.notesDir, cfg.notesSource);
        return ok({
          notesDir: cfg.notesDir,
          notesSource: cfg.notesSource,
          unmatchedSlots: r.unmatchedSlots,
          // Named, like `staleVersion` two lines down — a payload that names
          // everything else must not hand an agent bare positional arrays.
          collidingSlots: r.collidingSlots.map(([id, note]) => ({ id, note })),
          counts: {
            installed: Object.keys(r.installed).length,
            enabled: r.enabled.length,
            noted: Object.keys(r.noted).length,
            unnoted: r.unnoted.length,
            staleVersion: r.staleVersion.length,
          },
          unnoted: r.unnoted,
          staleVersion: r.staleVersion.map(([id, noteVersion, manifestVersion]) => ({ id, noteVersion, manifestVersion })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "provenance_regen",
    {
      title: "Regenerate the plugin-audit note",
      description:
        "Regenerate the plugin-audit note's text for the current vault state, preserving hand-written " +
        "`<!-- human:start … -->` sections. DRY-RUN by default (returns the text without writing); `write: true` " +
        "persists it to the audit note. The write routes through the accept-forbidden guard and the guard-patched " +
        "registrar (queue, journal) — it stamps DERIVATION metadata only and can never write an acceptance field. " +
        "Mutating.",
      inputSchema: {
        write: z
          .boolean()
          .optional()
          .describe("Persist the regenerated audit note. Omitted / false ⇒ dry-run (return the text, write nothing)."),
      },
      annotations: RW,
    },
    async ({ write }) => {
      try {
        // The destination is `cfg.auditNote` in BOTH layouts — flat's default
        // still derives, inside provenanceConfigOf, but the tool never derives
        // again here.
        //
        // Branching on the mode was a half-applied fix and strictly worse than
        // the bug it replaced: `regenerateAudit` read the existing note's
        // human sections from `cfg.auditNote` while this wrote to the derived
        // path, so a flat vault with a configured auditNote had one note's
        // hand-written sections copied over a DIFFERENT note, destroying the
        // target's own. One path, read and written, or they drift.
        const path = cfg.auditNote;
        const text = await regenerateAudit(
          source as ProvenanceSource,
          nowStamp(),
          cfg.notesDir,
          cfg.notesSource,
          cfg.auditNote,
        );
        if (!write) return ok({ dryRun: true, path, text });
        // Accept-forbidden guard: refuses a regen whose rendered frontmatter
        // would introduce/change an acceptance assertion — nothing is written.
        guardAuditDestination(source.noteFrontmatter(path), path);
        guardProvenanceWrite(source.noteFrontmatter(path), text);
        await source.writeNote(path, text);
        return ok({ written: path });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
