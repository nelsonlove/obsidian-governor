// The single interception point every registerTool call passes through (see the
// monkeypatch in server.ts). Four things bind here, in order:
//
//   1. guardCall  — read-only mode + path allowlist (pre-existing)
//   2. kernel arguments — `if_rev` / `idempotency_key` are peeled off the args
//      (kernel v0) so no tool handler ever sees them
//   3. write queue — mutating calls serialize plugin-wide (kernel v0)
//   4. write journal — one audit record per mutating call (kernel v0)
//
// Reads take path 1 only and return immediately. Lives in its own module (not
// inline in server.ts) so it imports nothing from `obsidian` and can be
// unit-tested headlessly — server.ts cannot, since its tool registrars pull in
// live Obsidian classes.

import { z } from "zod";
import { guardCall, type GuardSettings } from "../guard.js";
import {
  IdempotencyMismatchError,
  RevConflictError,
  WriteTimeoutError,
  type Kernel,
  type JournalActor,
} from "../kernel/index.js";

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
const REF_KEYS = ["command_id", "commandId", "plugin_id", "pluginId", "command", "id", "workspace", "name", "kind"];
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

// ── kernel arguments ─────────────────────────────────────────────────────────
//
// `if_rev` and `idempotency_key` are KERNEL arguments, not tool arguments: no
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
    "Retry safety: a repeat call with the same key returns the first call's result instead of running again " +
      "(10-minute window, cleared on plugin reload). Use a fresh key per logical operation."
  );

/** The kernel argument names, stripped from every mutating call's args. */
export const KERNEL_ARG_KEYS = ["if_rev", "idempotency_key"] as const;

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
  return { ...def, inputSchema };
}

/** Split a call's arguments into the kernel's and the tool's. */
function splitKernelArgs(args: Record<string, unknown>): {
  toolArgs: Record<string, unknown>;
  ifRev?: number;
  idempotencyKey?: string;
} {
  const { if_rev: ifRev, idempotency_key: idempotencyKey, ...toolArgs } = args;
  return {
    toolArgs,
    ...(typeof ifRev === "number" ? { ifRev } : {}),
    ...(typeof idempotencyKey === "string" && idempotencyKey ? { idempotencyKey } : {}),
  };
}

export interface GuardedOpts {
  getSettings: () => GuardSettings;
  /** Plugin-singleton kernel. Absent (tests, bare embeds) ⇒ no queue, no journal — guard still applies. */
  kernel?: Kernel | null;
  /** Actor for the journal, resolved per call: client identity is only known after initialize. */
  actor: () => JournalActor;
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
    const blocked = guardCall({ isMutating, args: args ?? {}, settings: opts.getSettings() });
    if (blocked) return codedError(blocked.code, blocked.message);
    // Kernel arguments never reach a handler — including on the no-kernel path,
    // so a tool's behavior does not depend on whether a kernel is present.
    const { toolArgs, ifRev, idempotencyKey } = splitKernelArgs(args ?? {});
    if (!isMutating || !opts.kernel) return handler(toolArgs, extra);
    try {
      return await opts.kernel.runMutation(
        {
          op: name ?? def?.title ?? "unknown",
          args: toolArgs,
          actor: opts.actor(),
          ref: refOf(toolArgs),
          ...(ifRev !== undefined ? { ifRev } : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
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
