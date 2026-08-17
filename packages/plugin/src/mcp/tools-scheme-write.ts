// The scope-provider module's WRITE surface: three mutating tools over the
// ScopeRegistry (kernel/scheme/registry.ts) and the pure planning core
// (kernel/scheme/mutate.ts) — assign a note the next free address in a scope,
// refile a note back to where its own address says it belongs, and renumber a
// note to a specific target address (optionally displacing whatever already
// occupies it).
//
// Each tool is a thin PLAN-then-APPLY shell: the planning half
// (planAssign/planRefile/planRenumber) is pure and lives in mutate.ts —
// nothing here recomputes "what should move where", it only decides whether
// to preview the plan (`dry_run: true`) or execute it via `moveOne`
// (tools-vault-write.ts's move primitive, reused rather than re-implemented).
//
// Cannot register through modules-mount.ts: that host's `registerAll` gate
// refuses any tool whose `annotations.readOnlyHint !== true` (its own header
// comment, point 1, pinned by its own test suite). These three tools mutate
// by design, so they register directly in server.ts, exactly the way
// `registerVaultWriteTools`'s `obsidian_move_notes`/`obsidian_repoint_link`
// already do — not a workaround, the same shape the existing write tools use.
//
// Allowlist-aware like tools-scheme.ts's read tools: `ctx.notes()` is
// filtered through `visiblePaths` before it ever reaches a provider method or
// a planning function, and the note being OPERATED ON (`path`) gets the same
// one-path check tools-uid.ts's reverse lookup uses — rejected with a coded
// `out_of_allowlist` refusal before any planning runs, so a hidden note can be
// neither read as "what's there" nor written to by these tools.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok, fail, codedError } from "./helpers.js";
import { visiblePaths, type GuardSettings } from "../guard.js";
import { pickInstance, parseScopeToken } from "./tools-scheme.js";
import { moveOne, RW } from "./tools-vault-write.js";
import { planAssign, planRefile, planRenumber, type MoveStep, type OnOccupied } from "../kernel/scheme/mutate.js";
import type { Address } from "../kernel/scheme/provider.js";
import type { SchemeRegistry, SchemeInstanceConfig } from "../kernel/scheme/registry.js";

export interface SchemeWriteToolsCtx {
  /** Rebuilt from settings per call — config edits land live, no reconnect needed. */
  registry: () => SchemeRegistry;
  /** Vault markdown paths; wired in server.ts from app.vault.getMarkdownFiles(). */
  notes: () => string[];
  getSettings?: () => GuardSettings & { schemes?: SchemeInstanceConfig[] };
}

function moveErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerSchemeWriteTools(server: McpServer, app: App, ctx: SchemeWriteToolsCtx): void {
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());
  const outOfAllowlist = (path: string) =>
    codedError("out_of_allowlist", `path '${path}' is outside the vault-mcp allowlist`);

  // ── obsidian_assign_address ─────────────────────────────────────────────
  server.registerTool(
    "obsidian_assign_address",
    {
      title: "Assign a note the next free address in a scope",
      description:
        "Move a note into a scope (e.g. category \"06\"), assigning it the next free address the scope's own " +
        "grammar computes (same answer `obsidian_next_address` would give for the same scope right now). " +
        "`dry_run: true` reports the address and the move that would happen without touching the vault; " +
        "`dry_run: false` performs it. Never overwrites — planning always targets a FREE address, so a race where " +
        "something now occupies the computed path fails the move rather than clobbering it. Mutating.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to assign an address to."),
        scope: z.string().min(1).describe('A scope token in the scheme\'s own grammar, e.g. "06", "90-99", "27".'),
        scheme: z
          .string()
          .min(1)
          .optional()
          .describe("Which configured scheme instance to use. Defaults to the single configured instance; required when several are configured."),
        dry_run: z.boolean().describe("If true, report the computed address and move without performing it."),
      },
      annotations: RW,
    },
    async ({ path, scope, scheme, dry_run }) => {
      try {
        const registry = ctx.registry();
        const pick = pickInstance(registry, scheme);
        if ("unavailable" in pick) return codedError("scheme_unavailable", pick.unavailable);
        if ("error" in pick) return fail(new Error(pick.error));
        const { instance } = pick;

        const parsedScope = parseScopeToken(instance, scope);
        if (!parsedScope) return codedError("invalid_scope", `"${scope}" does not parse as a scope in scheme "${instance.id}"`);

        if (visible([path]).length === 0) return outOfAllowlist(path);

        const visibleNotes = visible(ctx.notes());
        const outcome = planAssign(instance.provider, parsedScope, path, visibleNotes);
        if (!outcome.ok) return fail(new Error(outcome.error));
        const { result } = outcome;

        if (dry_run) return ok({ dry_run: true, address: result.address, moves: [result.step] });

        try {
          await moveOne(app, result.step.from, result.step.to, false);
        } catch (e) {
          return fail(e);
        }
        return ok({ dry_run: false, address: result.address, moves: [result.step] });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_refile_address ─────────────────────────────────────────────
  server.registerTool(
    "obsidian_refile_address",
    {
      title: "Refile a note back to where its own address says it belongs",
      description:
        "Move a note to the folder its OWN address (the leading token in its filename) says it should live in — " +
        "the fix for a misfiled note `obsidian_expected_location` reports as `placed: false`. No `scope`/`scheme` " +
        "argument: the note's address decides which configured scheme instance and which scope apply. Already " +
        "correctly filed reports `already_correct: true` with no move, regardless of `dry_run`. `dry_run: true` " +
        "reports the move that would happen without performing it. Mutating.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to refile."),
        dry_run: z.boolean().describe("If true, report the computed move without performing it."),
      },
      annotations: RW,
    },
    async ({ path, dry_run }) => {
      try {
        if (visible([path]).length === 0) return outOfAllowlist(path);

        const registry = ctx.registry();
        let instance = null;
        for (const inst of registry.instances()) {
          if (inst.provider.addressOf(path)) {
            instance = inst;
            break;
          }
        }
        if (!instance) return fail(new Error("note has no address in any configured scheme"));

        const visibleNotes = visible(ctx.notes());
        const outcome = planRefile(instance.provider, path, visibleNotes);
        if (!outcome.ok) return fail(new Error(outcome.error));
        const { result } = outcome;

        if (result.alreadyCorrect) {
          return ok({ dry_run, address: result.address, moves: [], already_correct: true });
        }
        const step = result.step;
        if (!step) return fail(new Error("planRefile reported a move with no step"));

        if (dry_run) return ok({ dry_run: true, address: result.address, moves: [step] });

        try {
          await moveOne(app, step.from, step.to, false);
        } catch (e) {
          return fail(e);
        }
        return ok({ dry_run: false, address: result.address, moves: [step] });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_renumber_address ───────────────────────────────────────────
  server.registerTool(
    "obsidian_renumber_address",
    {
      title: "Renumber a note to a specific target address",
      description:
        "Move a note to a specific target address `to`, in the resolved scheme instance's own grammar (not a bare " +
        "guess — `to`/`displace_to` are parsed through that instance's `provider.parse`). If `to` is already " +
        "occupied, `on_occupied` decides what happens: \"fail\" (default) refuses; \"auto\" displaces the occupant " +
        "to the next free address in ITS OWN scope; \"manual\" displaces the occupant to `displace_to`, which must " +
        "be given and free. Whenever an occupant is displaced, its move always runs BEFORE the source note's own " +
        "move, both in the reported plan and in execution order. `dry_run: true` reports the moves without " +
        "performing them; `dry_run: false` executes them sequentially — never in parallel, so a failure partway " +
        "through cannot race the remaining steps. Mutating.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to renumber."),
        to: z.string().min(1).describe('The target address in the scheme\'s own grammar, e.g. "06.20".'),
        scheme: z
          .string()
          .min(1)
          .optional()
          .describe("Which configured scheme instance to use. Defaults to the single configured instance; required when several are configured."),
        dry_run: z.boolean().describe("If true, report the computed move(s) without performing them."),
        on_occupied: z
          .enum(["auto", "manual", "fail"])
          .default("fail")
          .describe('What to do if `to` is already occupied: "fail" (default, refuse), "auto" (displace the occupant to its own scope\'s next free slot), or "manual" (displace the occupant to `displace_to`).'),
        displace_to: z
          .string()
          .min(1)
          .optional()
          .describe('Where to displace the current occupant of `to`, in the scheme\'s own grammar. Required (and used) only when `on_occupied` is "manual".'),
      },
      annotations: RW,
    },
    async ({ path, to, scheme, dry_run, on_occupied, displace_to }) => {
      try {
        const registry = ctx.registry();
        const pick = pickInstance(registry, scheme);
        if ("unavailable" in pick) return codedError("scheme_unavailable", pick.unavailable);
        if ("error" in pick) return fail(new Error(pick.error));
        const { instance } = pick;

        const parsedTo = instance.provider.parse(to);
        if (!parsedTo) return fail(new Error(`"${to}" does not parse as an address in scheme "${instance.id}"`));

        let parsedDisplaceTo: Address | undefined;
        if (on_occupied === "manual" && displace_to !== undefined) {
          const parsed = instance.provider.parse(displace_to);
          if (!parsed) {
            return fail(new Error(`"${displace_to}" does not parse as an address in scheme "${instance.id}"`));
          }
          parsedDisplaceTo = parsed;
        }

        if (visible([path]).length === 0) return outOfAllowlist(path);

        const visibleNotes = visible(ctx.notes());
        const outcome = planRenumber(
          instance.provider,
          path,
          parsedTo,
          visibleNotes,
          on_occupied as OnOccupied,
          parsedDisplaceTo
        );
        if (!outcome.ok) return fail(new Error(outcome.error));
        const { result } = outcome;

        if (dry_run) return ok({ dry_run: true, moves: result.steps, displaced: result.displaced });

        const completed: MoveStep[] = [];
        for (const step of result.steps) {
          try {
            await moveOne(app, step.from, step.to, false);
            completed.push(step);
          } catch (e) {
            if (completed.length === 0) return fail(e);
            const failedStep = step;
            const priorDescription = completed.map((s) => `'${s.from}' -> '${s.to}'`).join(", ");
            return fail(
              new Error(
                `vault is in an inconsistent state: already moved ${priorDescription}, but failed to move ` +
                  `'${failedStep.from}' to '${failedStep.to}': ${moveErrorMessage(e)}`
              )
            );
          }
        }
        return ok({ dry_run: false, moves: result.steps, displaced: result.displaced });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
