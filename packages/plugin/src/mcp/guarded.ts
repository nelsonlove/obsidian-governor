// The single interception point every registerTool call passes through (see the
// monkeypatch in server.ts). Six things bind here, in order:
//
//   1. uid addressing — `uid:<value>` path arguments resolve to real paths
//      through the uid index (slice 2.1), for READS and WRITES alike
//   2. scheme addressing — `jd:<address>` (and other configured scheme ids)
//      path arguments resolve to real paths through the scope-provider
//      registry, AFTER uid resolution (uid: is reserved and takes
//      precedence) and, like uid addressing, for READS and WRITES alike
//   3. guardCall  — read-only mode + path allowlist (pre-existing)
//   4. kernel arguments — `if_rev` / `idempotency_key` are peeled off the args
//      (kernel v0) so no tool handler ever sees them
//   5. write queue — mutating calls serialize plugin-wide (kernel v0)
//   6. write journal — one audit record per mutating call (kernel v0)
//
// Reads take paths 1–3 only and return immediately. Lives in its own module (not
// inline in server.ts) so it imports nothing from `obsidian` and can be
// unit-tested headlessly — server.ts cannot, since its tool registrars pull in
// live Obsidian classes.

import { z } from "zod";
import { guardCall, type GuardSettings } from "../guard.js";
import {
  IdempotencyMismatchError,
  RevConflictError,
  UidAmbiguousError,
  UidUnresolvedError,
  WriteTimeoutError,
  resolveUidArgs,
  type Kernel,
  type JournalActor,
  type JournalEffects,
  type UidIndex,
} from "../kernel/index.js";
import {
  AddressAmbiguousError,
  AddressUnresolvedError,
  SchemeUnavailableError,
  resolveSchemeArgs,
  type SchemeRegistry,
} from "../kernel/scheme/registry.js";

/** Guard/queue-level failure envelope: matches the `Error [code]: message` shape guardCall already emits. */
function codedError(code: string, message: string) {
  return { content: [{ type: "text" as const, text: `Error [${code}]: ${message}` }], isError: true as const };
}

// Argument keys that identify a NON-path target, MOST IDENTIFYING FIRST — a
// tool taking both `id` and `name` should journal the id. Pathless mutators
// (run a command, toggle a plugin, open a workspace) would otherwise journal
// `target: {}`. The mapping lives here, at the interception point, and is keyed
// on argument names rather than tool names — the kernel stays generic and an
// external tool taking `commandId` gets the same treatment for free.
const REF_KEYS = [
  "command_id",
  "commandId",
  "plugin_id",
  "pluginId",
  "command",
  // Advisory claims: `obsidian_claim_scope` journals `scope:<prefix>` and
  // `obsidian_release_scope` journals `lock:<id>` — the release call names only
  // the lock, so the scope it covers is not among its arguments.
  "lock_id",
  "lockId",
  "scope",
  "id",
  "workspace",
  "name",
  "kind",
];
const MAX_REF = 120;

/**
 * `plugin:dataview`, `command:editor:toggle-bold`, … — the label is the key
 * with any `_id`/`Id` suffix dropped, so no per-tool knowledge is encoded.
 */
function refOf(args: Record<string, unknown>): string | undefined {
  for (const key of REF_KEYS) {
    const value = args?.[key];
    if (typeof value !== "string" || !value) continue;
    const label = key.replace(/_?[Ii]d$/, "") || key;
    return `${label}:${value}`.slice(0, MAX_REF);
  }
  return undefined;
}

// ── reported effects ─────────────────────────────────────────────────────────
//
// The journal's `target` is derived from the paths an operation NAMES, which is
// right for nearly everything. `obsidian_repoint_link` is the exception: it
// names one target path and then discovers, rewrites and reports a set of notes
// of its own, so an argument-derived record describes a one-file operation that
// may have changed forty. The audit stream has to carry what actually happened.
//
// The convention is RESULT-shaped and lives here for the same reason REF_KEYS
// does: the kernel stays generic and only records what it is handed, while the
// knowledge of what this tool surface's envelopes look like stays at the
// boundary. A handler opts in simply by reporting `filesChanged` (and
// optionally `files`) in its structured result — nothing is inferred.
//
// A DRY RUN reports nothing: `filesChanged` then means "would change", and a
// record asserting effects for an operation that wrote nothing is worse than a
// record with no effects field at all.
const EFFECT_COUNT_KEY = "filesChanged";
const EFFECT_PATHS_KEY = "files";
// Same cap the journal applies to `target.paths` — the record keeps the shape,
// not the payload; `filesChanged` stays exact.
const MAX_EFFECT_PATHS = 20;

function reportedEffects(args: Record<string, unknown>, result: unknown): JournalEffects | undefined {
  if (args?.dry_run === true) return undefined;
  const structured = (result as { structuredContent?: unknown } | null | undefined)?.structuredContent;
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const body = structured as Record<string, unknown>;
  const count = body[EFFECT_COUNT_KEY];
  if (typeof count !== "number" || !Number.isFinite(count)) return undefined;
  const raw = body[EFFECT_PATHS_KEY];
  const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string").slice(0, MAX_EFFECT_PATHS) : [];
  return { filesChanged: count, ...(paths.length > 0 ? { paths } : {}) };
}

// ── kernel arguments ─────────────────────────────────────────────────────────
//
// `if_rev`, `idempotency_key` and `intent` are KERNEL arguments, not tool arguments: no
// handler knows about them, and adding them by hand to ~25 mutating schemas
// would guarantee that the next mutating tool forgets one. They are declared
// generically (withKernelArgs, applied to every mutating registration) and
// consumed generically (stripped from args here, passed to Kernel.runMutation).
//
// The declaration is not optional decoration: the MCP SDK validates a call's
// arguments against the tool's zod shape and z.object STRIPS unknown keys, so
// an undeclared `if_rev` would be silently discarded before the handler — and
// this wrapper — ever saw it. Code Mode's obsidian_call_tool parses against the
// same captured shape, so declaring once covers both surfaces.

const IF_REV = z
  .number()
  .optional()
  .describe(
    "Optimistic concurrency: only apply if the target is still at this `rev` (from a read). " +
      "A mismatch fails with Error [rev_conflict] and writes nothing. For multi-target ops, applies to the first target."
  );

const IDEMPOTENCY_KEY = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Retry safety for calls that RETURNED: a repeat call with the same key returns the first call's result " +
      "instead of running again, and a repeat sent while the first is still in flight waits for it and shares its " +
      "outcome. It does NOT cover a call that failed with Error [write_timeout] — that operation was abandoned " +
      "server-side and may still have landed, so its key is not held and a retry re-executes; re-read before " +
      "retrying. Same key + different arguments — or a different (or dropped) if_rev — is " +
      "Error [idempotency_mismatch], never a replay. " +
      "10-minute window, cleared on plugin reload. Use a fresh key per logical operation."
  );

const INTENT = z
  .string()
  .min(1)
  .max(2000)
  .optional()
  .describe(
    "Why this change is being made — advisory, agent-authored free text recorded in the write journal beside the " +
      "operation (the PR-description of a proposed change; review surfaces display it as \"agent says\"). " +
      "Journal-only: it is never written to the note, never trusted, and never an acceptance signal of any kind. " +
      "Unlike idempotency identity, a retried call may reword it freely."
  );

/** The kernel argument names, stripped from every mutating call's args.
 * RESERVED: the peel below strips these from every mutating call at runtime
 * regardless of the tool's own schema — withKernelArgs preserving a tool's own
 * declaration keeps the SCHEMA honest, but the value still never reaches the
 * handler. A mutating tool (built-in or external) must not name an argument
 * after one of these. */
export const KERNEL_ARG_KEYS = ["if_rev", "idempotency_key", "intent"] as const;

/**
 * Declare the kernel arguments on a MUTATING tool's input schema. Read-only
 * tools are returned untouched — neither argument means anything without a
 * write. A tool that already declares one of the names keeps its own
 * declaration (nothing here may quietly redefine a tool's contract).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withKernelArgs(def: any): any {
  if (def?.annotations?.readOnlyHint !== false) return def;
  const inputSchema = { ...(def.inputSchema ?? {}) };
  if (!("if_rev" in inputSchema)) inputSchema.if_rev = IF_REV;
  if (!("idempotency_key" in inputSchema)) inputSchema.idempotency_key = IDEMPOTENCY_KEY;
  if (!("intent" in inputSchema)) inputSchema.intent = INTENT;
  return { ...def, inputSchema };
}

/** Split a call's arguments into the kernel's and the tool's. */
function splitKernelArgs(args: Record<string, unknown>): {
  toolArgs: Record<string, unknown>;
  ifRev?: number;
  idempotencyKey?: string;
  intent?: string;
} {
  const { if_rev: ifRev, idempotency_key: idempotencyKey, intent, ...toolArgs } = args;
  return {
    toolArgs,
    ...(typeof ifRev === "number" ? { ifRev } : {}),
    ...(typeof idempotencyKey === "string" && idempotencyKey ? { idempotencyKey } : {}),
    ...(typeof intent === "string" && intent ? { intent } : {}),
  };
}

export interface GuardedOpts {
  getSettings: () => GuardSettings;
  /**
   * Plugin-singleton kernel. Absent (tests, bare embeds) ⇒ no queue, no journal
   * — the guard still applies, and a mutating call carrying `if_rev` is refused
   * rather than written unconditionally (the precondition is unenforceable).
   */
  kernel?: Kernel | null;
  /** Actor for the journal, resolved per call: client identity is only known after initialize. */
  actor: () => JournalActor;
  /**
   * The uid index backing `uid:<value>` addressing. Defaults to the kernel's,
   * which is where it lives in the plugin; overridable so this wrapper can be
   * tested against an index without a kernel.
   */
  uids?: UidIndex | null;
  /**
   * The scope-provider registry backing `jd:<address>` (and other configured
   * scheme ids) addressing. Resolved PER CALL, like `getSettings`, so a
   * scheme config edit lands live — mirrors `registerSchemeTools`'s own
   * `registry()`. Absent ⇒ scheme addressing is skipped entirely and args
   * pass through byte-identical (tests, bare embeds).
   */
  schemes?: () => SchemeRegistry | null;
  /**
   * Vault markdown paths scheme addressing resolves an address against.
   * Called LAZILY by resolveSchemeArgs — only once per call, on the first
   * scheme-shaped value encountered, then reused for the rest of that call —
   * so an ordinary call never pays for enumerating the vault. Same source
   * `registerSchemeTools` uses. `opts.schemes` present without this ⇒ defaults
   * to `() => []`, so a scheme-shaped value FAILS CLOSED as `address_unresolved`
   * (0 candidates) rather than throwing — server.ts always wires both together,
   * so this is a defensive default for a misconfigured embed, not a supported
   * combination with its own test.
   */
  schemeNotes?: () => string[];
}

// ── uid addressing ───────────────────────────────────────────────────────────
//
// `path: "uid:019f…"` resolves through the index to the real path before
// ANYTHING else sees the call. Deliberately here and not in ~30 tool handlers:
// like the kernel arguments, per-tool support would mean the next path-taking
// tool silently lacks it. Because it is defined over the guard's own path walker
// (mapPaths), every argument the allowlist scopes is addressable and vice versa.
//
// It runs BEFORE guardCall so the allowlist checks the RESOLVED path — a uid
// must not be a way around a path sandbox. The REAL disclosure control is at
// the source, not at the refusal: resolution itself runs over the
// allowlist-VISIBLE candidates only (UidIndex.requireOne), so a resolved path
// is always already inside the allowlist and can never be the path guardCall
// itself blocks on — `uid_ambiguous` can only ever name paths this session
// could have named itself, and a uid carried solely outside the sandbox reads
// as `uid_unresolved` rather than confirming it exists. That is also what
// obsidian_resolve_uid reports, so looking a uid up and addressing by it agree.
//
// Resolved paths are ALSO folded back to their `uid:` form in the guard's
// refusal text (addressSafe, below, extended for scheme addressing) —
// belt-and-suspenders against a future guardCall message naming more than the
// one path it blocks on, not a hole open today.

// ── scheme addressing ────────────────────────────────────────────────────────
//
// `path: "jd:06.11"` (or any other configured scheme id) resolves through the
// scope-provider registry to the real path, mirroring uid addressing exactly
// and running immediately AFTER it — `uid:` is reserved (SchemeRegistry.parseRef
// returns null for it), so uid resolution always gets first look, and by the
// time scheme resolution runs no unresolved `uid:` value remains in the args:
// it either became a real path or the call already refused above.
//
// Also runs BEFORE guardCall, for the identical reason: the allowlist must
// check the RESOLVED path, not the address, or `jd:06.11` would be a sandbox
// bypass. Resolution itself runs over the allowlist-VISIBLE notes only
// (resolveSchemeArgs -> requireOneAddress over visiblePaths), so — exactly
// like a resolved uid path above — a resolved scheme path is always already
// inside the allowlist and can never be the path guardCall itself blocks on;
// that visibility gate is the real disclosure control, not the fold-back.
// What it actually buys: `address_ambiguous` can only ever name notes this
// session could have named itself, and an address whose only claimant is
// hidden reads as `address_unresolved` — never `out_of_allowlist`, which would
// confirm the address exists. That is also what obsidian_resolve_address
// reports, so looking an address up and addressing by it agree.
//
// Resolved scheme paths are ALSO folded back to their `jd:<address>` ref form
// in the guard's refusal text (addressSafe, below) — the same
// belt-and-suspenders as the uid case, combined into one pass rather than a
// second copy of the loop.
//
// A value that isn't scheme-shaped at all — an ordinary path, or one that
// merely contains a colon ("Notes/a:b.md") — is left untouched: parseRef
// returns null and resolveSchemeArgs never calls requireOneAddress on it.

/**
 * Put `uid:<value>` and `<scheme>:<address>` back where a resolved path
 * appears, so a refusal discloses neither. One pass over the combined
 * resolution lists — an allowlist refusal must hide everything either
 * addressing scheme resolved, not just whichever ran first.
 *
 * Exported so it can be tested DIRECTLY, independent of whether any given
 * guardCall message shape currently happens to route a resolved path through
 * it — see the "addressSafe" unit tests in scheme-addressing.test.mjs.
 */
export function addressSafe(
  message: string,
  uidResolved: Array<{ uid: string; path: string }>,
  schemeResolved: Array<{ ref: string; path: string }> = []
): string {
  let out = message;
  for (const { uid, path } of uidResolved) out = out.split(path).join(`uid:${uid}`);
  for (const { ref, path } of schemeResolved) out = out.split(path).join(ref);
  return out;
}

/**
 * Build the wrapper applied to every registered tool handler.
 *
 * `def.annotations.readOnlyHint === false` is the sole mutating test — the same
 * discriminant the guard has always used, so queue and journal cover exactly
 * the set read-only mode covers, including externally-published tools.
 */
export function makeGuarded(opts: GuardedOpts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (def: any, handler: any, name?: string) => async (args: any, extra: any) => {
    const isMutating = def?.annotations?.readOnlyHint === false;
    const settings = opts.getSettings();
    // 1. uid addressing. A call using none is handed back the SAME args object,
    //    so nothing below can behave differently for an ordinary path call.
    //    Resolution is bounded by the session's own allowlist (see requireOne):
    //    a uid carried by a note this session cannot see is not a candidate, so
    //    neither refusal below can name a path the caller was never entitled to.
    let addressed;
    try {
      addressed = resolveUidArgs(args ?? {}, opts.uids ?? opts.kernel?.uids ?? null, settings);
    } catch (e) {
      // Unknown or duplicated uid: refuse, and run nothing. Both are typed, and
      // the ambiguous one names the candidates so the caller can disambiguate.
      if (e instanceof UidUnresolvedError || e instanceof UidAmbiguousError) return codedError(e.code, e.message);
      throw e;
    }
    // 1b. scheme addressing (`jd:<address>`), over the possibly uid-rewritten
    //     args. opts.schemes absent ⇒ skipped entirely, so callArgs stays the
    //     SAME object resolveUidArgs handed back and behavior is unchanged.
    let callArgs = addressed.args;
    let schemeResolved: Array<{ ref: string; path: string }> = [];
    if (opts.schemes) {
      try {
        const schemed = resolveSchemeArgs(callArgs, opts.schemes(), opts.schemeNotes ?? (() => []), settings);
        callArgs = schemed.args;
        schemeResolved = schemed.resolved;
      } catch (e) {
        // Unresolvable or ambiguous address, or a ref naming a SKIPPED
        // instance (#88 — configured but no live instance, e.g. an unknown
        // provider or invalid config): refuse, and run nothing — same
        // contract as the uid case above.
        if (e instanceof AddressUnresolvedError || e instanceof AddressAmbiguousError || e instanceof SchemeUnavailableError) {
          return codedError(e.code, e.message);
        }
        throw e;
      }
    }
    const blocked = guardCall({ isMutating, args: callArgs, settings });
    if (blocked) return codedError(blocked.code, addressSafe(blocked.message, addressed.resolved, schemeResolved));
    // Kernel arguments are always PEELED OFF, kernel or not, so no handler ever
    // sees one. What differs without a kernel is whether they can be honored:
    //
    //   • `if_rev` is FAIL-CLOSED. Without a kernel there is no probe and no
    //     dequeue check, so the precondition cannot be evaluated at all — and
    //     its whole purpose is to stop a write that would clobber someone
    //     else's. Ignoring it would write unconditionally while the caller
    //     believes it was guarded, which is the exact lost update the argument
    //     exists to prevent. Refuse instead.
    //   • `idempotency_key` degrades quietly to no collapsing, because its
    //     failure mode is at-least-once (the pre-kernel status quo), not a
    //     destructive one: the operation still does what the caller asked, a
    //     retry just isn't deduplicated.
    const { toolArgs, ifRev, idempotencyKey, intent } = splitKernelArgs(callArgs);
    if (isMutating && !opts.kernel && ifRev !== undefined) {
      return codedError(
        "precondition_unsupported",
        `'${name ?? def?.title ?? "this tool"}' cannot enforce if_rev: no kernel is active in this build, so the ` +
          `target's revision cannot be checked. Nothing was written — retry without if_rev to write unconditionally.`
      );
    }
    if (!isMutating || !opts.kernel) return handler(toolArgs, extra);
    try {
      return await opts.kernel.runMutation(
        {
          op: name ?? def?.title ?? "unknown",
          args: toolArgs,
          actor: opts.actor(),
          ref: refOf(toolArgs),
          effectsOf: (result) => reportedEffects(toolArgs, result),
          ...(ifRev !== undefined ? { ifRev } : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          ...(intent !== undefined ? { intent } : {}),
        },
        () => handler(toolArgs, extra)
      );
    } catch (e) {
      // Kernel-level failures are typed tool errors; anything else the handler
      // threw keeps propagating to the SDK exactly as before.
      if (e instanceof WriteTimeoutError) return codedError(e.code, e.message);
      if (e instanceof RevConflictError) return codedError(e.code, e.message);
      if (e instanceof IdempotencyMismatchError) return codedError(e.code, e.message);
      throw e;
    }
  };
}
