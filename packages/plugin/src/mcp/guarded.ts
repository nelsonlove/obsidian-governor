// The single interception point every registerTool call passes through (see the
// monkeypatch in server.ts). Three things bind here, in order:
//
//   1. guardCall  — read-only mode + path allowlist (pre-existing)
//   2. write queue — mutating calls serialize plugin-wide (kernel v0)
//   3. write journal — one audit record per mutating call (kernel v0)
//
// Reads take path 1 only and return immediately. Lives in its own module (not
// inline in server.ts) so it imports nothing from `obsidian` and can be
// unit-tested headlessly — server.ts cannot, since its tool registrars pull in
// live Obsidian classes.

import { guardCall, type GuardSettings } from "../guard.js";
import { WriteTimeoutError, type Kernel, type JournalActor } from "../kernel/index.js";

/** Guard/queue-level failure envelope: matches the `Error [code]: message` shape guardCall already emits. */
function codedError(code: string, message: string) {
  return { content: [{ type: "text" as const, text: `Error [${code}]: ${message}` }], isError: true as const };
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
    if (!isMutating || !opts.kernel) return handler(args, extra);
    try {
      return await opts.kernel.runMutation(
        { op: name ?? def?.title ?? "unknown", args: args ?? {}, actor: opts.actor() },
        () => handler(args, extra)
      );
    } catch (e) {
      // A wedged operation fails as a typed tool error; anything else the
      // handler threw keeps propagating to the SDK exactly as before.
      if (e instanceof WriteTimeoutError) return codedError(e.code, e.message);
      throw e;
    }
  };
}
