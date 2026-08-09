// The advisory-claims tool surface: claim / renew / release / list.
//
// Four tools over the plugin-singleton LockStore (kernel/locks.ts). The verbs
// are deliberate and closed: you CLAIM a scope, you RENEW it, you RELEASE it,
// you LIST what is claimed. There is no grant, no approve, no accept and no wait
// — a claim is a statement of intent that other callers can see, not a
// permission another actor hands out, and nothing anywhere blocks on one.
//
// Imports nothing from `obsidian`: the store is Obsidian-free and the actor is
// passed in, so this module is unit-testable headlessly like guarded.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail } from "./helpers.js";
import { guardCall, type GuardSettings } from "../guard.js";
import {
  expiresInSeconds,
  holderOf,
  LOCK_TTL_DEFAULT_MS,
  LOCK_TTL_MAX_MS,
  LOCK_TTL_MIN_MS,
  normalizeScope,
  type JournalActor,
  type Kernel,
  type Lock,
} from "../kernel/index.js";

// A claim mutates KERNEL state, not vault state — so why register it mutating?
//
// Because `readOnlyHint: false` is this plugin's single discriminant for
// "guarded, serialized, journaled" (see mcp/guarded.ts), and the audit stream is
// the thing that matters here: a claim is exactly the sort of act ch4 wants in
// the operation-centric record — who asserted what, over which scope, for what
// reason, when. Registering read-only would keep claims out of the journal
// entirely, which is the wrong trade. The cost is the write queue slot the claim
// takes, and that cost is microseconds against an in-memory Map.
//
// It has two visible consequences, both documented and both acceptable:
//   • read-only mode blocks claiming and releasing. In a session that cannot
//     write, there is nothing for a claim to disclose.
//   • claims and releases carry the generic kernel arguments (`if_rev`,
//     `idempotency_key`) that withKernelArgs adds to every mutating schema.
//     `if_rev` on a scope claim names no file and so fails closed, which is
//     harmless; `idempotency_key` collapses a retried claim, which is right.
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export interface LockToolsCtx {
  kernel?: Kernel | null;
  /**
   * The guard's settings. A claim is scoped to a path prefix, so it must be
   * bounded by the path allowlist for exactly the reason writes are — see
   * scopeAllowed. Absent ⇒ no allowlist ⇒ unrestricted, the pre-existing
   * behavior for every session that configures none.
   */
  getSettings?: () => GuardSettings;
}

/** Wire shape for a claim. snake_case, like every other structured result. */
function view(lock: Lock, now: number) {
  return {
    id: lock.id,
    scope: lock.scope,
    holder: lock.holder,
    reason: lock.reason,
    claimed_at: new Date(lock.claimedAt).toISOString(),
    expires_at: new Date(lock.expiresAt).toISOString(),
    expires_in_s: expiresInSeconds(lock, now),
  };
}

const NO_KERNEL = "advisory locks need the kernel, which is not active in this build";

/**
 * A claim is a statement ABOUT A REGION OF THE VAULT, and it is visible to every
 * other session: a notice stamped on their writes, an entry in their listings.
 * A session sandboxed to `Projects/` that could claim `Archive/` — or `""`, the
 * whole vault — would reach straight out of its sandbox, not to write, but to
 * make every other session's writes carry its name. So the scope goes through
 * the same allowlist check a path argument would.
 *
 * The whole-vault scope needs its own clause: it normalizes to `""`, which
 * collectPaths drops as empty, so the ordinary check would pass it. With no
 * allowlist configured nothing changes — including whole-vault claims.
 */
function scopeRefusal(scope: string, settings?: GuardSettings): { code: string; message: string } | null {
  if (!settings?.allowlist?.length) return null;
  const normalized = normalizeScope(scope);
  if (normalized === "") {
    return {
      code: "out_of_allowlist",
      message:
        "a whole-vault claim is outside the vault-mcp allowlist — claim a scope inside it instead. Nothing was claimed.",
    };
  }
  const blocked = guardCall({ isMutating: false, args: { path: normalized }, settings });
  return blocked ? { code: blocked.code, message: `${blocked.message}. Nothing was claimed.` } : null;
}

/** Guard-shaped failure envelope, matching the `Error [code]: message` the guard emits. */
function codedError(code: string, message: string) {
  return { content: [{ type: "text" as const, text: `Error [${code}]: ${message}` }], isError: true as const };
}

export function registerLockTools(server: McpServer, ctx: LockToolsCtx, actor: () => JournalActor): void {
  server.registerTool(
    "obsidian_claim_scope",
    {
      title: "Claim a scope",
      description:
        "Advisory claim over a vault path prefix, for a stated reason and a bounded time. ADVISORY ONLY: it blocks nothing " +
        "and refuses nobody — another session can still write inside your scope, and will simply be told that you claimed it " +
        "and why. Overlapping claims by different holders are allowed; the response lists any it overlaps, so you know who " +
        "else is working here. Expires on its own (default 5 minutes, maximum 30): extend it with obsidian_renew_scope, or " +
        "claim the same scope again — that REPLACES your existing claim on it (same id, restated reason, restarted clock) " +
        "rather than adding a second. obsidian_release_scope drops it early. While a path allowlist is configured, a claim " +
        "must fall inside it.",
      inputSchema: {
        scope: z
          .string()
          .describe("Vault path prefix to claim, e.g. 'Projects/Alpha' or 'Notes/A.md'. Empty means the whole vault."),
        reason: z
          .string()
          .min(1)
          .max(300)
          .describe("Why you are claiming it — this is shown to anyone whose write lands inside the scope."),
        ttl_ms: z
          .number()
          .int()
          .min(LOCK_TTL_MIN_MS)
          .max(LOCK_TTL_MAX_MS)
          .optional()
          .describe(`Claim lifetime in ms. Default ${LOCK_TTL_DEFAULT_MS} (5 min), maximum ${LOCK_TTL_MAX_MS} (30 min).`),
      },
      annotations: RW,
    },
    async (args) => {
      try {
        const locks = ctx.kernel?.locks;
        if (!locks) return fail(new Error(NO_KERNEL));
        const refused = scopeRefusal(args.scope ?? "", ctx.getSettings?.());
        if (refused) return codedError(refused.code, refused.message);
        const holder = holderOf(actor());
        const { lock, overlapping, replaced } = locks.claim({
          scope: args.scope ?? "",
          holder,
          reason: args.reason,
          ...(args.ttl_ms !== undefined ? { ttlMs: args.ttl_ms } : {}),
        });
        const now = Date.now();
        return ok({
          claim: view(lock, now),
          // True when this refreshed a claim you already held on this scope
          // rather than adding one — so a caller can tell a renewal from a new
          // claim without diffing ids.
          replaced: replaced === true,
          // The disclosure that makes an advisory claim useful: overlapping
          // claims are permitted, so the claimer is told about them rather than
          // refused because of them.
          overlapping: overlapping.map((l) => view(l, now)),
          advisory: "Advisory only: this does not block other sessions from writing inside the scope.",
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_renew_scope",
    {
      title: "Renew a scope claim",
      description:
        "Restart the clock on an advisory claim you hold, by its lock id. Scope, reason and id all stay as they are — " +
        "only the expiry moves. Use this while long work is still running, so the claim does not lapse and stop " +
        "disclosing. A claim that has already expired, or one held by another connection, cannot be renewed from here.",
      inputSchema: {
        lock_id: z.string().min(1).describe("The `id` returned by obsidian_claim_scope."),
        ttl_ms: z
          .number()
          .int()
          .min(LOCK_TTL_MIN_MS)
          .max(LOCK_TTL_MAX_MS)
          .optional()
          .describe(`New lifetime in ms, from now. Default ${LOCK_TTL_DEFAULT_MS} (5 min), maximum ${LOCK_TTL_MAX_MS} (30 min).`),
      },
      annotations: RW,
    },
    async (args) => {
      try {
        const locks = ctx.kernel?.locks;
        if (!locks) return fail(new Error(NO_KERNEL));
        const renewed = locks.renew(args.lock_id, args.ttl_ms, holderOf(actor()));
        if (!renewed)
          return fail(
            new Error(
              `no live claim '${args.lock_id}' held by this connection — it may have expired, already been released, or belong to another holder`
            )
          );
        return ok({ renewed: view(renewed, Date.now()) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_release_scope",
    {
      title: "Release a scope claim",
      description:
        "Drop an advisory claim you hold, by its lock id. Claims expire on their own, so releasing is a courtesy that " +
        "makes the disclosure accurate sooner. Another holder's claim cannot be released from here.",
      inputSchema: {
        lock_id: z.string().min(1).describe("The `id` returned by obsidian_claim_scope."),
      },
      annotations: RW,
    },
    async (args) => {
      try {
        const locks = ctx.kernel?.locks;
        if (!locks) return fail(new Error(NO_KERNEL));
        const released = locks.release(args.lock_id, holderOf(actor()));
        if (!released)
          return fail(
            new Error(
              `no live claim '${args.lock_id}' held by this connection — it may have expired, already been released, or belong to another holder`
            )
          );
        return ok({ released: view(released, Date.now()) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_list_scope_claims",
    {
      title: "List scope claims",
      description:
        "Every live advisory claim on this vault: scope, holder, reason and time left. Expired claims are already gone. " +
        "Read-only, and purely informational — nothing here blocks anything.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const locks = ctx.kernel?.locks;
        if (!locks) return fail(new Error(NO_KERNEL));
        const now = Date.now();
        const holder = holderOf(actor());
        return ok({
          holder,
          claims: locks.list().map((l) => ({ ...view(l, now), mine: l.holder === holder })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
