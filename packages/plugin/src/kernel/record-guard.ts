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
 * (`obsidian_append_at_heading` CAN insert mid-file — its heading-absent +
 * create_if_missing branch happens to append at EOF, but the common branch
 * does not, and an exemption keyed on a tool whose contract is only
 * sometimes an append is exactly the guess this set avoids.)
 *
 * KNOWN, deliberately NOT exempted: `vault_crosssession_post` — the cross-
 * session channel plugin's posting tool (`packages/crosssession/src/tools.ts`;
 * spelled `crosssession_post` before the S6 satellite extraction, when it was
 * this plugin's own module tool). It is the one other tool whose whole
 * contract is a dated end-of-file append.
 *
 * It is UNREACHABLE by this check, and the extraction did not change that.
 * Two facts, both re-verified at S6:
 *
 *   1. IT WAS NEVER OUTSIDE THE KERNEL. As a module tool it registered on the
 *      same guard-patched `server.registerTool` every built-in rides, and as a
 *      published external tool it registers through the very same path
 *      (`external-tools.ts` → `makeGuarded`). "Unreachable" was never a claim
 *      that it bypassed the dequeue closure — it always ran through it.
 *   2. IT IS UNREACHABLE ON ARGUMENTS. Its target arrives as `channel`, which
 *      is not in guard.ts's PATH_KEYS, so `collectPaths({handle, channel,
 *      body})` yields an EMPTY list and the loop below has nothing to test.
 *      The file it actually appends to is DISCOVERED inside the handler (the
 *      channel folder's single entry-bearing log file) and is named by no
 *      argument at all.
 *
 * So exempting it would change no behavior now while WIDENING a protective set
 * on a guess about a future argument shape. The tripwire that ACTUALLY fires
 * lives host-side: guard.test.mjs asserts `collectPaths` over the
 * crosssession argument names is empty against the LIVE PATH_KEYS — the
 * satellite's own pin runs against a snapshot copy (its host-shim), which is
 * a review aid rather than a live check, and claiming otherwise was an
 * inflated guard-rail the 2026-09-05 review corrected. Pinned by a test below the
 * exemption test; the day `channel` becomes path-keyed (or the tool gains a
 * `path`), appending to a record-flagged channel note starts refusing and this
 * set is where that gets decided, on purpose, by a human.
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
