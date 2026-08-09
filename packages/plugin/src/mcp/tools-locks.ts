// The advisory-claims tool surface: claim / release / list.
//
// Three tools over the plugin-singleton LockStore (kernel/locks.ts). The verbs
// are deliberate and closed: you CLAIM a scope, you RELEASE it, you LIST what is
// claimed. There is no grant, no approve, no accept and no wait — a claim is a
// statement of intent that other callers can see, not a permission another actor
// hands out, and nothing anywhere blocks on one.
//
// Imports nothing from `obsidian`: the store is Obsidian-free and the actor is
// passed in, so this module is unit-testable headlessly like guarded.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail } from "./helpers.js";
import {
  expiresInSeconds,
  holderOf,
  LOCK_TTL_DEFAULT_MS,
  LOCK_TTL_MAX_MS,
  LOCK_TTL_MIN_MS,
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

/** Just the kernel — this surface needs nothing else from ServerCtx. */
export interface LockToolsCtx {
  kernel?: Kernel | null;
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

export function registerLockTools(server: McpServer, ctx: LockToolsCtx, actor: () => JournalActor): void {
  server.registerTool(
    "obsidian_claim_scope",
    {
      title: "Claim a scope",
      description:
        "Advisory claim over a vault path prefix, for a stated reason and a bounded time. ADVISORY ONLY: it blocks nothing " +
        "and refuses nobody — another session can still write inside your scope, and will simply be told that you claimed it " +
        "and why. Overlapping claims by different holders are allowed; the response lists any it overlaps, so you know who " +
        "else is working here. Expires on its own (default 5 minutes, maximum 30) — renew by claiming again, or release when done.",
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
        const holder = holderOf(actor());
        const { lock, overlapping } = locks.claim({
          scope: args.scope ?? "",
          holder,
          reason: args.reason,
          ...(args.ttl_ms !== undefined ? { ttlMs: args.ttl_ms } : {}),
        });
        const now = Date.now();
        return ok({
          claim: view(lock, now),
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
