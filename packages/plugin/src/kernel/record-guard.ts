// The record-immutability guard (#264) — the durable, server-side half of the
// record-class write protection. A note whose frontmatter carries `record: true`
// is a RECORD: historical, byte-verified, never edited in place. The convention
// for extending one is a dated END-OF-FILE append (a new `## YYYY-MM-DD …`
// section), so the one mutation a record admits is `obsidian_append_note`; every
// other mutating operation that names a record note refuses with
// `Error [record_immutable]` before its handler runs.
//
// Same family as the accept-forbidden guard (@vault-mcp/core's
// acceptForbiddenReason): a protective refusal for FALLIBLE agents, not
// adversaries — the client-side hooks narrow the window, and this is the layer
// that holds for every client. It binds at the kernel's dequeue closure
// (kernel/index.ts, Kernel.runMutation), the same interception point where
// `if_rev` and the advisory-lock consult sample live vault state: an
// enqueue-time check would inspect the world the operations ahead of you are
// still changing.
//
// FAIL OPEN, deliberately — the mirror image of `if_rev`'s fail-closed. The
// check is protective, not load-bearing: a missing file, an unparsed
// frontmatter cache, or a throwing probe means "cannot show this is a record",
// and refusing unrelated operations over an unreadable probe would make a
// broken cache a vault-wide write outage. (`if_rev` fails closed because the
// caller EXPLICITLY asked for a precondition; nobody asked this check to
// block a note it cannot read.)
//
// Obsidian-free by construction, like every other kernel module: the decision
// runs over an injected `isRecord` lookup; the only adapter that touches
// `obsidian` is the probe in obsidian-probe.ts.

/**
 * Typed refusal: a mutating operation named a record note and is not the
 * append tool. Nothing ran; rendered as `Error [record_immutable]: …` by the
 * interception layer (mcp/guarded.ts), like the other kernel refusals.
 */
export class RecordImmutableError extends Error {
  readonly code = "record_immutable";
  constructor(
    readonly op: string,
    readonly path: string
  ) {
    // "names", not "would modify": collectPaths walks every path-key argument,
    // including ones an op only reads (a template_path flagged record: true
    // refuses the whole call — over-blocking is the safe direction, but the
    // message must not assert a write that wasn't going to happen).
    super(
      `'${op}' names '${path}', whose frontmatter carries record: true. Record notes are historical and ` +
        `append-only: nothing was written. Extend the record with a dated end-of-file append ` +
        `(obsidian_append_note, a new '## YYYY-MM-DD …' section) or write a NEW record note — never edit, ` +
        `move, or delete an existing one.`
    );
    this.name = "RecordImmutableError";
  }
}

/**
 * The operations exempt from the record check, by TOOL IDENTITY — the one
 * mutation a record note admits is a pure end-of-file append, and
 * `obsidian_append_note` is the only tool on the surface whose whole contract
 * is that. Deliberately keyed on the op name and never on argument shapes: an
 * argument-sniffed exemption ("looks like an append") is exactly the kind of
 * guess a different tool's arguments could satisfy while rewriting the file.
 * (`obsidian_append_at_heading` inserts MID-file, so it is not exempt.)
 */
export const RECORD_EXEMPT_OPS: ReadonlySet<string> = new Set(["obsidian_append_note"]);

/**
 * Whether a frontmatter `record` value marks the note as a record. The
 * metadata cache hands back parsed YAML, so the canonical form is the boolean
 * `true`; the quoted string form is honored too because the guard is
 * protective and a hand-typed `record: "true"` plainly meant to declare one.
 * Anything else — absent, false, prose — is not a record.
 */
export function isRecordFlag(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/**
 * The refusal for one mutating operation, or null when it may proceed.
 *
 * `paths` is EVERY path the operation names (guard.ts's collectPaths — the
 * uncapped list the advisory-lock consult already uses): a move whose
 * DESTINATION is a record note would overwrite it just as surely as a write to
 * it, so any record among the named paths refuses, first hit named.
 *
 * `isRecord` is the injected probe (`TargetProbe.record`). `undefined` means
 * the flag could not be read — no file, no parsed frontmatter — and a THROW is
 * swallowed per path: both fail OPEN (see the header). The check never reads
 * the vault itself.
 */
export function recordImmutableRefusal(
  op: string,
  paths: string[],
  isRecord: (path: string) => boolean | undefined
): RecordImmutableError | null {
  if (RECORD_EXEMPT_OPS.has(op)) return null;
  for (const path of paths) {
    let flagged: boolean | undefined;
    try {
      flagged = isRecord(path);
    } catch {
      flagged = undefined; // unreadable ⇒ not provably a record ⇒ fail open
    }
    if (flagged === true) return new RecordImmutableError(op, path);
  }
  return null;
}
