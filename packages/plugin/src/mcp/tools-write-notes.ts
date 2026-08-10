// obsidian_write_notes — batch write + opt-in server-side stamping (slice B1).
//
// The MIRROR of obsidian_move_notes, but with one deliberate difference that is
// the whole point of the slice: every item gets its OWN journal record, so
// Stewardship sees each note individually. A batch move is one operation over
// many paths (one record, `target.paths`); a batch write is N independent
// writes that happen to be submitted together.
//
// ── why it dispatches instead of writing inline ──────────────────────────────
//
// To give each item its own record, each item must run through the kernel's
// runMutation — the SAME serialized queue + journal + if_rev + idempotency that
// backs every single write. But the guard monkeypatch (server.ts) already wraps
// every MUTATING registration in ONE runMutation, and the write queue is
// non-reentrant (a queued closure that enqueues again deadlocks behind itself).
//
// So this tool follows the obsidian_call_tool precedent exactly: it registers
// UNGUARDED (via the pre-monkeypatch registrar) so it takes no outer queue slot,
// and drives a per-item GUARDED single-writer itself. The per-item handler is a
// real makeGuarded wrapper, so uid addressing, read-only mode, the allowlist,
// if_rev, idempotency and the journal all bind per item exactly as on the full
// surface — nothing is reimplemented. A read-only session's items each fail with
// `read_only`; an out-of-allowlist path fails with `out_of_allowlist`; the batch
// never aborts on one item's failure.
//
// Obsidian-free by construction: the two Obsidian-touching concerns — reading a
// note's existing frontmatter from the metadata cache and serializing YAML — are
// injected by server.ts, so the dispatch/compose/stamp/accept-forbidden surface
// is unit-testable headlessly against a real Kernel and fake vault.

import { z } from "zod";
import { ok, okError } from "./helpers.js";
import { composeNote, AcceptForbiddenError, type ComposeResult } from "./write-notes-compose.js";

/** readOnlyHint:false is honest — this tool mutates. It bypasses the monkeypatch, not the truth. */
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** The guarded single-writer this tool drives, one call per item. Returns an MCP result envelope. */
export type GuardedWrite = (
  args: { path: string; content: string; overwrite: boolean; if_rev?: number; idempotency_key?: string },
  extra: unknown
) => Promise<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }>;

export interface WriteNotesDeps {
  /** Existing on-disk frontmatter for a path (metadata cache), or undefined. For stamp preservation. */
  readExistingFrontmatter: (path: string) => Record<string, unknown> | undefined;
  /** The revision (mtime ms) of a path after a write, for the per-item report. */
  revOf?: (path: string) => number | undefined;
  /** Serialize frontmatter to YAML — obsidian.stringifyYaml in production. */
  stringifyYaml: (obj: Record<string, unknown>) => string;
  /** Parse a YAML frontmatter block — obsidian.parseYaml in production. For the accept-forbidden body-injection check. */
  parseYaml?: (yaml: string) => unknown;
  /** Mint a created-seeded uid — uuidv7 in production. */
  mintUid: (createdMs: number) => string;
  /** Format an ms timestamp for frontmatter — formatLocalTimestamp in production. */
  formatTs: (ms: number) => string;
  /** Wall-clock now, ms. Injected for deterministic tests. */
  now?: () => number;
}

type PerItemResult =
  | { ok: true; path: string; created: boolean; stamped: boolean; rev?: number }
  | { ok: false; path: string; code: string; error: string };

/** Pull `Error [code]: message` out of a guarded-write error envelope. */
function decodeError(envelope: { content?: Array<{ text?: string }> }): { code: string; error: string } {
  const text = envelope.content?.[0]?.text ?? "error";
  const m = /^Error \[([^\]]+)\]:\s*([\s\S]*)$/.exec(text);
  if (m) return { code: m[1], error: m[2] };
  const bare = /^Error:\s*([\s\S]*)$/.exec(text);
  return { code: "error", error: bare ? bare[1] : text };
}

/**
 * Register obsidian_write_notes.
 *
 * @param register  the PRE-monkeypatch registrar (origRegister in server.ts) — so this
 *                  tool is not itself wrapped in runMutation (no outer queue slot).
 * @param guardedWrite  a makeGuarded-wrapped single-writer (server.ts builds it from
 *                  the real Kernel + backend); each item is dispatched through it.
 */
export function registerWriteNotesTool(
  register: (name: string, def: unknown, handler: unknown) => unknown,
  guardedWrite: GuardedWrite,
  deps: WriteNotesDeps
): void {
  const now = deps.now ?? (() => Date.now());

  register(
    "obsidian_write_notes",
    {
      title: "Write multiple notes (with optional server-side stamping)",
      description:
        "Write several notes in one call, each as {path, frontmatter?, body}. Every item is an INDEPENDENT write routed " +
        "through the same serialized write queue, write journal and if_rev/idempotency machinery as a single write — so " +
        "each note gets its OWN journal record and Stewardship sees it individually. Items are processed sequentially; a " +
        "failed item (out-of-allowlist, if_rev conflict, accept-forbidden) is reported in `errors` and does NOT abort the " +
        "batch. Each item may carry its own `if_rev` (optimistic concurrency) and `idempotency_key` (retry-safety). " +
        "Existing notes are REPLACED (this writes whole notes, like obsidian_write_note). " +
        "Set `stamp: true` to make the server the single owner of frontmatter conventions: it mints a created-seeded " +
        "UUIDv7 `uid` only when absent (an existing uid is never overwritten), sets `created` (if missing) and `modified` " +
        "(always), enforces canonical field order, and defaults `acceptance-status: proposed` only when absent. Stamping " +
        "NEVER writes acceptance, and any item whose frontmatter sets accepted/accepted-by/accepted-on is REJECTED " +
        "(Error [accept_forbidden]) — acceptance is a human gesture, in no API. `stamp` is opt-in per call; leave it off " +
        "for templates/blueprints, where a uid on a merge-payload would corrupt every instance.",
      inputSchema: {
        notes: z
          .array(
            z.object({
              path: z.string().min(1).describe("Vault-relative path ending in .md (or uid:<value>)."),
              frontmatter: z
                .record(z.unknown())
                .optional()
                .describe("Frontmatter key/values. Under stamp:true the server fills uid/created/modified and canonical order."),
              body: z.string().default("").describe("Markdown body below the frontmatter."),
              if_rev: z
                .number()
                .optional()
                .describe("Per-item optimistic concurrency: only write if the note is still at this rev (from a read); else Error [rev_conflict], nothing written."),
              idempotency_key: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .describe("Per-item retry-safety key: a repeat with the same key replays the first result instead of writing again."),
            })
          )
          .min(1)
          .max(50)
          .describe("The notes to write, e.g. [{path:'Inbox/A.md', frontmatter:{name:'A'}, body:'…'}]."),
        stamp: z
          .boolean()
          .default(false)
          .describe("Opt-in server-side stamping: uid (v7, created-seeded, only if absent) + created/modified + canonical order + default acceptance-status:proposed. Never writes acceptance."),
      },
      annotations: RW,
    },
    async (
      { notes, stamp }: { notes: Array<{ path: string; frontmatter?: Record<string, unknown>; body?: string; if_rev?: number; idempotency_key?: string }>; stamp?: boolean },
      extra: unknown
    ) => {
      const doStamp = stamp === true;
      const results: PerItemResult[] = [];

      for (const item of notes) {
        // Compose + accept-forbidden guard run OUTSIDE the queue: a rejected item
        // never dispatches, so it takes no slot and writes no journal record.
        let composed: ComposeResult;
        try {
          composed = composeNote({
            frontmatter: item.frontmatter,
            body: item.body ?? "",
            stamp: doStamp,
            existing: deps.readExistingFrontmatter(item.path),
            now: now(),
            mintUid: deps.mintUid,
            formatTs: deps.formatTs,
            stringifyYaml: deps.stringifyYaml,
            parseYaml: deps.parseYaml,
          });
        } catch (e) {
          if (e instanceof AcceptForbiddenError) {
            results.push({ ok: false, path: item.path, code: e.code, error: e.message });
            continue;
          }
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ ok: false, path: item.path, code: "compose_failed", error: msg });
          continue;
        }

        // Dispatch through the guarded single-writer: uid addressing, read-only,
        // allowlist, if_rev, idempotency, queue and journal all bind here, per item.
        try {
          const envelope = await guardedWrite(
            {
              path: item.path,
              content: composed.content,
              overwrite: true,
              ...(item.if_rev !== undefined ? { if_rev: item.if_rev } : {}),
              ...(item.idempotency_key !== undefined ? { idempotency_key: item.idempotency_key } : {}),
            },
            extra
          );
          if (envelope?.isError) {
            const { code, error } = decodeError(envelope);
            results.push({ ok: false, path: item.path, code, error });
          } else {
            const created = envelope?.structuredContent?.created === true;
            results.push({
              ok: true,
              path: item.path,
              created,
              stamped: composed.stamped,
              ...(deps.revOf ? { rev: deps.revOf(item.path) } : {}),
            });
          }
        } catch (e) {
          // A guarded-write should return an envelope, not throw; if it does,
          // one item's crash must not sink the batch.
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ ok: false, path: item.path, code: "error", error: msg });
        }
      }

      const written = results.filter((r): r is Extract<PerItemResult, { ok: true }> => r.ok);
      const errors = results.filter((r): r is Extract<PerItemResult, { ok: false }> => !r.ok);
      const payload = {
        count: written.length,
        error_count: errors.length,
        stamped: doStamp,
        written: written.map(({ path, created, stamped, rev }) => ({ path, created, stamped, ...(rev !== undefined ? { rev } : {}) })),
        errors: errors.map(({ path, code, error }) => ({ path, code, error })),
      };
      // Partial failure is tolerated; total failure carries the MCP error flag
      // (okError keeps the structured per-item report, which fail() would flatten).
      return written.length === 0 && errors.length > 0 ? okError(payload) : ok(payload);
    }
  );
}
