// Pure composition + stamping logic for obsidian_write_notes (slice B1).
//
// Obsidian-free by construction: everything here operates on plain objects and
// injected functions (`mintUid`, `formatTs`, `stringifyYaml`), so the whole
// stamp/accept-forbidden/canonical-order surface is unit-testable headlessly,
// exactly like the rest of the kernel-adjacent logic. The one Obsidian-touching
// concern — reading a note's existing frontmatter from the metadata cache and
// serializing YAML — is injected by tools-write-notes.ts.
//
// ── The invariants this file is the point of ─────────────────────────────────
//
//  1. `stamp` NEVER writes acceptance. It defaults `acceptance-status: proposed`
//     ONLY when the field is absent from BOTH the payload and the existing note,
//     and it NEVER mints or elevates to `accepted`. An existing acceptance-status
//     on disk is PRESERVED verbatim (including a human-granted `accepted`) —
//     changing it would destroy the human's decision, which the invariant equally
//     forbids ("never change an existing acceptance-status value"). The only way
//     `accepted` reaches disk through this tool is if it was already there; a
//     caller can never inject it (invariant 2).
//
//  2. Accept-forbidden guard (stamped or not): a payload whose frontmatter sets
//     `acceptance-status: accepted` (or an `accepted-*` variant) or carries any
//     `accepted` / `accepted-by` / `accepted-on` field is REJECTED before any
//     write. The transport must never persist acceptance — this defends the
//     "the accept verb goes in no API" scar at the write path.
//
//  3. `stamp` is opt-in per call — the caller passes it; nothing here turns it
//     on. A uid on a template merge-payload mass-corrupts instance uids, so a
//     write that must not be stamped simply omits the flag.

// ── the accept-forbidden guard, over RESULTING vs on-disk frontmatter ─────────
//
// The scar is "the accept verb is in no API": no MCP write may INTRODUCE or
// CHANGE a note's acceptance to the accepted-family. Extracted to
// packages/core/src/accept-guard.ts (issue #104) so FilesystemBackend inherits
// the SAME predicate ObsidianBackend uses — re-exported here unchanged so
// every existing import of this module (obsidian-backend.ts, tools-cli.ts,
// tests) keeps working without a call-site change. See accept-guard.ts for
// the full invariant writeup and the (before, after) transition semantics
// (preserve an existing accepted value verbatim is allowed; introduce/change
// is not).
import {
  AcceptForbiddenError,
  acceptTransitionReason,
  acceptForbiddenReason,
  frontmatterOf,
} from "@vault-mcp/core";
export { AcceptForbiddenError, acceptTransitionReason, acceptForbiddenReason, frontmatterOf };

// ── canonical frontmatter field order ────────────────────────────────────────
//
// name/title, uid, created, modified, then everything else in its existing
// order, with acceptance-status pinned LAST — matching the vault's own
// convention (see any stamped note's frontmatter). This makes the SERVER the
// single owner of field order, so every agent stops reimplementing it.
const CANONICAL_HEAD = ["name", "title", "uid", "created", "modified"];
const CANONICAL_TAIL = ["acceptance-status"];

/** Reorder a frontmatter object into canonical field order; object identity of values is preserved. */
export function canonicalOrder(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const head = new Set(CANONICAL_HEAD);
  const tail = new Set(CANONICAL_TAIL);
  for (const k of CANONICAL_HEAD) if (k in fm) out[k] = fm[k];
  for (const k of Object.keys(fm)) if (!head.has(k) && !tail.has(k)) out[k] = fm[k];
  for (const k of CANONICAL_TAIL) if (k in fm) out[k] = fm[k];
  return out;
}

// ── UUIDv7, created-seeded ────────────────────────────────────────────────────
//
// The 48-bit big-endian millisecond timestamp is seeded from the note's
// `created` rather than from wall-clock now, so a uid minted for an old note
// sorts by when the note was authored, not when it was stamped. Version (7) and
// variant (10) bits are set per RFC 9562; the remaining 74 bits are random.
// Randomness is injected so the mint is deterministic under test.

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // Renderer + Node 18+ both expose a Web Crypto `crypto.getRandomValues`.
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** A UUIDv7 whose timestamp field is `ms`. `rand` (≥10 bytes) is injectable for deterministic tests. */
export function uuidv7(ms: number, rand?: Uint8Array): string {
  const r = rand ?? defaultRandomBytes(10);
  const b = new Uint8Array(16);
  const t = Math.max(0, Math.floor(ms));
  b[0] = Math.floor(t / 2 ** 40) & 0xff;
  b[1] = Math.floor(t / 2 ** 32) & 0xff;
  b[2] = Math.floor(t / 2 ** 24) & 0xff;
  b[3] = Math.floor(t / 2 ** 16) & 0xff;
  b[4] = Math.floor(t / 2 ** 8) & 0xff;
  b[5] = t & 0xff;
  for (let i = 0; i < 10; i++) b[6 + i] = r[i] ?? 0;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── local timestamp formatting ────────────────────────────────────────────────
//
// `YYYY-MM-DDTHH:mm:ss`, local time, no zone suffix — matching the vault's
// visible convention (Templater/Obsidian defaults). Injected into compose so a
// test can pin the value; production uses this.
export function formatLocalTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface ComposeArgs {
  /** The caller's frontmatter payload for this note (may be omitted). */
  frontmatter?: Record<string, unknown>;
  /** The markdown body below the frontmatter. */
  body: string;
  /** Opt-in server-side stamping. Never automatic. */
  stamp: boolean;
  /** The note's existing on-disk frontmatter (from the metadata cache), for stamp preservation. */
  existing?: Record<string, unknown> | null;
  /** Wall-clock now, ms — `modified` and any defaulted `created` derive from it. */
  now: number;
  /** Mint a uid seeded from a created-timestamp (ms). Injected; production = uuidv7. */
  mintUid: (createdMs: number) => string;
  /** Format an ms timestamp for frontmatter. Injected; production = formatLocalTimestamp. */
  formatTs: (ms: number) => string;
  /** Serialize a frontmatter object to YAML (trailing newline). Injected; production = obsidian.stringifyYaml. */
  stringifyYaml: (obj: Record<string, unknown>) => string;
  /**
   * Parse a YAML frontmatter block — production = obsidian.parseYaml. Used ONLY
   * to read a body-embedded leading `---` fence for the accept-forbidden guard
   * (the stamp:false injection path). Optional: when absent, a body that carries
   * its own frontmatter is not parsed here — the shared backend write primitive
   * re-checks the final content with a real parser regardless, so the guarantee
   * does not rest on this seam being wired.
   */
  parseYaml?: (yaml: string) => unknown;
}

export interface ComposeResult {
  content: string;
  /** The final frontmatter that was written — for the per-item report. */
  frontmatter: Record<string, unknown>;
  /** True when stamping actually ran (i.e. args.stamp). */
  stamped: boolean;
}

/** Parse a `created` value to ms for the uid seed; fall back to `now` when it is missing or unparseable. */
function seedMs(created: unknown, now: number): number {
  if (typeof created === "string") {
    const p = Date.parse(created);
    if (!Number.isNaN(p)) return p;
  } else if (typeof created === "number" && Number.isFinite(created)) {
    return created;
  }
  return now;
}

/**
 * Compose the final note text for one write item.
 *
 * Throws AcceptForbiddenError (invariant 2) when the note that WOULD LAND ON DISK
 * introduces or changes acceptance to the accepted-family — checked over the
 * resulting frontmatter (a body-embedded leading fence included, so the
 * stamp:false injection path is caught) against the note's existing on-disk
 * frontmatter, so preserving a human-granted `accepted` verbatim is allowed.
 *
 * Under `stamp`, fills uid (uuidv7, created-seeded, only when absent — an
 * existing on-disk uid always wins so it is NEVER overwritten), `created` (when
 * missing) and `modified` (always now), defaults `acceptance-status: proposed`
 * only when absent from both payload and disk, and enforces canonical field
 * order. Without `stamp`, the note is written verbatim from the payload.
 */
export function composeNote(args: ComposeArgs): ComposeResult {
  const payload: Record<string, unknown> = { ...(args.frontmatter ?? {}) };

  let structuredFm: Record<string, unknown>;
  let content: string;
  let stamped: boolean;

  if (!args.stamp) {
    structuredFm = payload;
    content = renderNote(payload, args.body, args.stringifyYaml);
    stamped = false;
  } else {
    const existing = args.existing ?? {};
    const merged: Record<string, unknown> = { ...payload };

    // created: keep payload's, else preserve existing, else default to now.
    const created = merged.created ?? existing.created ?? args.formatTs(args.now);
    merged.created = created;

    // modified: always now.
    merged.modified = args.formatTs(args.now);

    // uid: never overwrite an existing uid — the on-disk uid wins, then the
    // payload's, then a fresh created-seeded uuidv7. Minted only when truly absent.
    const existingUid = typeof existing.uid === "string" && existing.uid ? existing.uid : undefined;
    const payloadUid = typeof merged.uid === "string" && merged.uid ? (merged.uid as string) : undefined;
    merged.uid = existingUid ?? payloadUid ?? args.mintUid(seedMs(created, args.now));

    // acceptance-status: payload's value, else preserve the existing on-disk
    // value VERBATIM (never changed — including a human-granted `accepted`),
    // else default `proposed`. The accept-forbidden guard below rejects an
    // accepted value the payload introduces; a preserved existing one is allowed.
    if (!("acceptance-status" in merged)) {
      if ("acceptance-status" in existing) merged["acceptance-status"] = existing["acceptance-status"];
      else merged["acceptance-status"] = "proposed";
    }

    structuredFm = canonicalOrder(merged);
    content = renderNote(structuredFm, args.body, args.stringifyYaml);
    stamped = true;
  }

  // Invariant 2 — accept-forbidden guard over the note that WOULD LAND ON DISK.
  // The resulting frontmatter is the structured block when there is one; when
  // there is none, the body's own leading `---` fence becomes the note's real
  // frontmatter (the stamp:false body-injection path), so it is parsed and
  // checked too. Rejection is a TRANSITION: introducing or changing acceptance
  // to the accepted-family is blocked, preserving an existing value verbatim
  // (compared against args.existing) is allowed.
  const resultingFm =
    Object.keys(structuredFm).length > 0
      ? structuredFm
      : frontmatterOf(args.body, args.parseYaml ?? (() => null)) ?? {};
  const reason = acceptTransitionReason(args.existing ?? null, resultingFm);
  if (reason) throw new AcceptForbiddenError(reason);

  return { content, frontmatter: structuredFm, stamped };
}

/** `---\n<yaml>---\n<body>`, or just the body when there is no frontmatter. */
function renderNote(
  fm: Record<string, unknown>,
  body: string,
  stringifyYaml: (obj: Record<string, unknown>) => string
): string {
  if (Object.keys(fm).length === 0) return body;
  let yaml = stringifyYaml(fm);
  if (!yaml.endsWith("\n")) yaml += "\n";
  return `---\n${yaml}---\n${body}`;
}
