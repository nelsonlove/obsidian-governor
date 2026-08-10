// The scope-provider module's read-only surface: five tools over the
// ScopeRegistry (kernel/scheme/registry.ts) — list the configured schemes,
// resolve an address in either direction, compute (never reserve) the next
// free address in a scope, list a scope's members and open slots, and check
// where an address (or a note) is expected to live.
//
// Nothing here mutates anything. `obsidian_next_address` in particular only
// COMPUTES — the actual exclusivity story is `obsidian_claim_scope`
// (tools-locks.ts, kernel v0's advisory claims), which this tool's
// description points callers at explicitly: two sessions racing this tool
// can compute the identical answer, and only a claim (or the note actually
// landing) settles who gets it.
//
// Allowlist-aware like tools-uid.ts and tools-links.ts, and for the same
// reason: the registry resolves addresses against the WHOLE vault listing, so
// an unfiltered surface would be a path oracle for whatever a sandboxed
// session cannot see. `ctx.notes()` is filtered through `visiblePaths` once
// per call, BEFORE it ever reaches a provider method — membersOf, nextFree,
// expectedFolder and registry.resolve all see only the visible set, so a note
// occupying a slot outside the allowlist is invisible to "what's free" the
// same way it is to "what's here" (no existence oracle: 0 visible candidates
// reads as not-found even when a hidden note carries the address). A `path`
// argument gets the same one-path check tools-uid.ts's reverse lookup uses,
// since a test can call these handlers directly, bypassing the outer guard
// wrapper server.ts installs.
//
// Imports nothing from `obsidian`: like tools-uid.ts and tools-links.ts, this
// module is Obsidian-free and unit-testable headlessly. `findings.ts` (the
// conformance rule-pack) is deliberately NOT imported here — it is rail
// material for a later task, not a tool.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, codedError } from "./helpers.js";
import { visiblePaths, type GuardSettings } from "../guard.js";
import type { Address, Scope, ScopeProvider } from "../kernel/scheme/provider.js";
import type { SchemeInstance, SchemeInstanceConfig, SchemeRegistry } from "../kernel/scheme/registry.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export interface SchemeToolsCtx {
  /** Rebuilt from settings per call — config edits land live, no reconnect needed. */
  registry: () => SchemeRegistry;
  /** Vault markdown paths; wired in server.ts from app.vault.getMarkdownFiles(). */
  notes: () => string[];
  /**
   * The guard's settings — the allowlist filter below — PLUS the raw scheme
   * configs (`schemes`), the same widened shape tools-core.ts's ServerCtx
   * exposes. `obsidian_schemes` reads the raw per-instance override out of
   * this (the registry itself only carries the *built* provider, not the
   * config that built it) — everything else here uses only the settings half.
   * Absent ⇒ unfiltered, and `obsidian_schemes` reports every config as `{}`.
   */
  getSettings?: () => GuardSettings & { schemes?: SchemeInstanceConfig[] };
}

/** A couple of example addresses in each known provider's own grammar, raw
 * (unprefixed) — `obsidian_schemes` prefixes them with each INSTANCE's own
 * id, so a scheme configured under a different id still gets correct
 * examples. Providers not listed here (none yet, besides "johnny-decimal")
 * get no examples rather than a guess. */
const PROVIDER_EXAMPLES: Record<string, string[]> = {
  "johnny-decimal": ["06.11", "92021.10", "00-09"],
};

type Pick_ = { instance: SchemeInstance } | { error: string };

/**
 * Select the scheme instance an argument names, or the sole configured
 * instance when none is given. The two "can't decide" cases (nothing
 * configured, several configured and none named) are both `{error}` — every
 * call site turns that into a `fail()`, since it is an argument problem, not
 * a scope problem (that's `invalid_scope`, below).
 */
function pickInstance(registry: SchemeRegistry, schemeArg?: string): Pick_ {
  if (schemeArg) {
    const instance = registry.get(schemeArg);
    return instance ? { instance } : { error: `unknown scheme id "${schemeArg}"` };
  }
  const instances = registry.instances();
  if (instances.length === 0) return { error: "no scheme instances are configured" };
  if (instances.length > 1) {
    return {
      error: `multiple scheme instances are configured (${instances.map((i) => i.id).join(", ")}) — specify \`scheme\``,
    };
  }
  return { instance: instances[0] };
}

/**
 * `obsidian_resolve_address`'s `address` direction: a "jd:06.11"-shaped ref
 * resolves via the registry's own parseRef; a bare "06.11" resolves only when
 * EXACTLY one scheme instance is configured (this tool takes no `scheme`
 * argument — bare addressing needs no ambiguity to resolve). The error
 * message is tool-specific (there is no `scheme` argument to point a caller
 * at), which is why this doesn't just reuse `pickInstance`.
 */
function resolveBareOrRef(registry: SchemeRegistry, raw: string): { instance: SchemeInstance; addr: Address } | { error: string } {
  const viaRef = registry.parseRef(raw);
  if (viaRef) return viaRef;
  const instances = registry.instances();
  if (instances.length !== 1) {
    return {
      error:
        instances.length === 0
          ? `"${raw}" does not resolve to any address — no scheme instances are configured`
          : `"${raw}" is ambiguous as a bare address — ${instances.length} scheme instances are configured; prefix it, e.g. "${instances[0].id}:${raw}"`,
    };
  }
  const addr = instances[0].provider.parse(raw);
  return addr ? { instance: instances[0], addr } : { error: `"${raw}" does not parse as an address` };
}

/** `obsidian_expected_location`'s `address` direction: same as above but WITH
 * a `scheme` argument to fall back on, so it reuses `pickInstance` verbatim. */
function resolveAddressAndInstance(
  registry: SchemeRegistry,
  raw: string,
  schemeArg?: string
): { instance: SchemeInstance; addr: Address } | { error: string } {
  const viaRef = registry.parseRef(raw);
  if (viaRef) return viaRef;
  const pick = pickInstance(registry, schemeArg);
  if ("error" in pick) return pick;
  const addr = pick.instance.provider.parse(raw);
  return addr ? { instance: pick.instance, addr } : { error: `"${raw}" does not parse as an address` };
}

/** A scope token ("06", "90-99", "27") parsed through the provider's own
 * address grammar — a Scope is just an Address's {kind, raw} renamed
 * {kind, token} for the kinds that can contain things (area / category /
 * expanded-item); `nextFree`/`membersOf` handle any kind mismatch themselves
 * (returning null / no members) rather than this needing to know which kinds
 * are valid containers for every provider. Null only when the token doesn't
 * parse as an address AT ALL — that's the one case the brief calls
 * "unparseable", and the only one `invalid_scope` reports. */
function parseScopeToken(instance: SchemeInstance, raw: string): Scope | null {
  const addr = instance.provider.parse(raw);
  return addr ? { kind: addr.kind, token: addr.raw } : null;
}

function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * Up to 20 currently-open addresses in `scope`, via the provider's own
 * `nextFree` alone — no scheme-specific knowledge beyond the public
 * ScopeProvider contract. Each simulated slot is faked as a note
 * (`"<address> .gap-probe.md"`, a filename whose leading token round-trips
 * through the provider's own `addressOf`/`format`) so the NEXT call sees it
 * as taken; the probe never touches the real notes list, only a local copy.
 * For a plain (lowest-unused) category this enumerates true gaps; for an
 * expanded area/category (strictly max(used)+1 allocation) it enumerates the
 * next N sequential ids instead — there ARE no gaps to find there, and this
 * still answers "what would the next 20 calls return". `next` is `gaps[0]`
 * when non-empty — the same answer `obsidian_next_address` gives for the
 * same scope and notes.
 *
 * `truncated` mirrors tools-links.ts's convention (`MAX_ITEMS` + a boolean
 * flag on every capped list): the 20-item cap is a summary bound, not a
 * claim about how many slots are actually open, and a caller must be able to
 * tell "exactly 20 free" from "capped, more exist" — most visibly for an
 * expanded scope, where every entry past the cap is a synthetic sequential
 * id rather than a genuinely scarce gap. Costs one extra `nextFree` probe,
 * and only when the loop actually ran all 20 iterations.
 */
function computeFree(provider: ScopeProvider, scope: Scope, notes: string[]): { next: string | null; gaps: string[]; truncated: boolean } {
  const gaps: string[] = [];
  let working = notes;
  for (let i = 0; i < 20; i++) {
    const addr = provider.nextFree(scope, working);
    if (!addr) break;
    const formatted = provider.format(addr);
    gaps.push(formatted);
    working = [...working, `${formatted} .gap-probe.md`];
  }
  const truncated = gaps.length === 20 && provider.nextFree(scope, working) !== null;
  return { next: gaps[0] ?? null, gaps, truncated };
}

export function registerSchemeTools(server: McpServer, ctx: SchemeToolsCtx): void {
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());

  // ── obsidian_schemes ────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_schemes",
    {
      title: "List configured scope providers",
      description:
        "List every configured scheme instance: its id, provider, capabilities, the configuration override in effect, " +
        "and a couple of example addresses in its own grammar (prefixed with the instance's id, e.g. `jd:06.11`). " +
        "Start here to learn what `obsidian_resolve_address` / `obsidian_next_address` / `obsidian_list_scope` / " +
        "`obsidian_expected_location` accept. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const registry = ctx.registry();
        const rawSchemes = ctx.getSettings?.()?.schemes ?? [];
        const schemes = registry.instances().map((instance) => {
          const raw = rawSchemes.find((s) => s.id === instance.id);
          const examples = (PROVIDER_EXAMPLES[instance.providerName] ?? []).map((a) => `${instance.id}:${a}`);
          return {
            id: instance.id,
            provider: instance.providerName,
            capabilities: instance.provider.capabilities,
            config: raw?.config ?? {},
            examples,
          };
        });
        return ok({ schemes });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_resolve_address ────────────────────────────────────────────
  server.registerTool(
    "obsidian_resolve_address",
    {
      title: "Resolve a scheme address",
      description:
        "Look up a scheme address, in either direction. Give `address` (e.g. `jd:06.11`, or bare `06.11` when exactly " +
        "one scheme is configured) to get the note's current path (plus `duplicates` if more than one visible note " +
        "claims it); an address that parses but names no note reports `found: false` with the parsed shape, not an " +
        "error. Give `path` to get that note's address in whichever configured scheme recognizes it. Read-only: this " +
        "reports duplicates, it never repairs them.",
      inputSchema: {
        address: z.string().min(1).optional().describe('A scheme address, e.g. "jd:06.11" or bare "06.11".'),
        path: z.string().min(1).optional().describe("A vault-relative path to resolve to its address (the reverse direction)."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        if ((args.address && args.path) || (!args.address && !args.path)) {
          return fail(new Error("give `address` or `path`, not both — they are the two directions of one lookup"));
        }
        const registry = ctx.registry();
        const notes = visible(ctx.notes());

        if (args.address) {
          const resolved = resolveBareOrRef(registry, args.address);
          if ("error" in resolved) return fail(new Error(resolved.error));
          const { addr } = resolved;
          const candidates = registry.resolve(resolved.instance, addr, notes);
          if (candidates.length === 0) {
            return ok({ address: args.address, found: false, parsed: { kind: addr.kind, levels: addr.levels } });
          }
          return ok({
            address: args.address,
            found: true,
            path: candidates[0],
            // Present only when it matters, same convention as obsidian_resolve_uid.
            ...(candidates.length > 1 ? { duplicates: candidates, ambiguous: true } : {}),
          });
        }

        const path = args.path as string;
        if (visible([path]).length === 0) {
          return ok({ path, address: null, scheme: null });
        }
        for (const instance of registry.instances()) {
          const addr = instance.provider.addressOf(path);
          if (addr) return ok({ path, address: instance.provider.format(addr), scheme: instance.id });
        }
        return ok({ path, address: null, scheme: null });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_next_address ───────────────────────────────────────────────
  server.registerTool(
    "obsidian_next_address",
    {
      title: "Compute the next free address in a scope",
      description:
        "Compute the next unused address within a scope (e.g. category \"06\", area \"90-99\", expanded category " +
        "\"27\"). This COMPUTES ONLY — it reserves nothing, so a second call, or a competing session, can compute the " +
        "identical answer right up until a note actually lands there. Pair this with `obsidian_claim_scope` to hold " +
        "the slot exclusively while you create the note. Under a path allowlist, the address returned may already be " +
        "held by a note outside your allowlist, since a hidden note's slot cannot read as taken. Read-only.",
      inputSchema: {
        scope: z.string().min(1).describe('A scope token in the scheme\'s own grammar, e.g. "06", "90-99", "27".'),
        scheme: z
          .string()
          .min(1)
          .optional()
          .describe("Which configured scheme instance to use. Defaults to the single configured instance; required when several are configured."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        const registry = ctx.registry();
        const pick = pickInstance(registry, args.scheme);
        if ("error" in pick) return fail(new Error(pick.error));
        const { instance } = pick;
        const scope = parseScopeToken(instance, args.scope);
        if (!scope) return codedError("invalid_scope", `"${args.scope}" does not parse as a scope in scheme "${instance.id}"`);
        const notes = visible(ctx.notes());
        const next = instance.provider.nextFree(scope, notes);
        return next
          ? ok({ scope: args.scope, next: instance.provider.format(next), exhausted: false })
          : ok({ scope: args.scope, next: null, exhausted: true });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_list_scope ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_list_scope",
    {
      title: "List a scope's members and open slots",
      description:
        "List the visible notes that belong to a scope (e.g. category \"06\"), address-ordered, plus the next free " +
        "address and up to 20 currently-open slots (`free.truncated: true` when more exist beyond the cap). " +
        "Read-only; pair `free.next` with `obsidian_claim_scope` the same way `obsidian_next_address` does — this " +
        "tool computes, it does not reserve. Under a path allowlist, `members` omits notes you cannot see, so a slot " +
        "listed as free may already be held by one of them.",
      inputSchema: {
        scope: z.string().min(1).describe('A scope token in the scheme\'s own grammar, e.g. "06", "90-99", "27".'),
        scheme: z
          .string()
          .min(1)
          .optional()
          .describe("Which configured scheme instance to use. Defaults to the single configured instance; required when several are configured."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        const registry = ctx.registry();
        const pick = pickInstance(registry, args.scheme);
        if ("error" in pick) return fail(new Error(pick.error));
        const { instance } = pick;
        const scope = parseScopeToken(instance, args.scope);
        if (!scope) return codedError("invalid_scope", `"${args.scope}" does not parse as a scope in scheme "${instance.id}"`);
        const notes = visible(ctx.notes());
        const members = instance.provider.membersOf(scope, notes).map((m) => ({ address: m.address, path: m.path }));
        const free = computeFree(instance.provider, scope, notes);
        return ok({ scope: args.scope, members, free });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_expected_location ──────────────────────────────────────────
  server.registerTool(
    "obsidian_expected_location",
    {
      title: "Where an address (or a note) is expected to live",
      description:
        "Report whether a note is filed where the scheme expects, or where a (possibly still-unclaimed) address's " +
        "container currently lives. Give `path` to check an existing note against its own address; give `address` " +
        "(optionally with `scheme` for a bare one) to ask about that address directly. `expected_folder` is `null` " +
        "when it cannot be derived (nothing in the vault establishes the container yet), in which case `placed` is " +
        "also `null` — there is nothing to compare against. Read-only.",
      inputSchema: {
        path: z.string().min(1).optional().describe("A vault-relative path to check against its own address."),
        address: z.string().min(1).optional().describe('A scheme address to check directly, e.g. "jd:06.11" or bare "06.11".'),
        scheme: z
          .string()
          .min(1)
          .optional()
          .describe("Which configured scheme instance to use for a bare `address`, or to restrict `path`'s lookup. Defaults to the single configured instance."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        if ((args.path && args.address) || (!args.path && !args.address)) {
          return fail(new Error("give `path` or `address`, not both — they are the two ways to name what to check"));
        }
        const registry = ctx.registry();
        const notes = visible(ctx.notes());

        if (args.address) {
          const resolved = resolveAddressAndInstance(registry, args.address, args.scheme);
          if ("error" in resolved) return fail(new Error(resolved.error));
          const { instance, addr } = resolved;
          const address = instance.provider.format(addr);
          const expected_folder = instance.provider.expectedFolder(addr, notes);
          const candidates = registry.resolve(instance, addr, notes);
          const actual_folder = candidates.length > 0 ? folderOf(candidates[0]) : null;
          const placed = expected_folder === null ? null : expected_folder === actual_folder;
          return ok({ address, expected_folder, actual_folder, placed });
        }

        const path = args.path as string;
        if (visible([path]).length === 0) {
          return ok({ address: null, expected_folder: null, actual_folder: null, placed: null });
        }
        const pick = args.scheme ? pickInstance(registry, args.scheme) : null;
        if (pick && "error" in pick) return fail(new Error(pick.error));
        const candidateInstances = pick ? [pick.instance] : registry.instances();
        for (const instance of candidateInstances) {
          const addr = instance.provider.addressOf(path);
          if (!addr) continue;
          const address = instance.provider.format(addr);
          const expected_folder = instance.provider.expectedFolder(addr, notes);
          const actual_folder = folderOf(path);
          const placed = expected_folder === null ? null : expected_folder === actual_folder;
          return ok({ address, expected_folder, actual_folder, placed });
        }
        // A path outside every scheme scope with no address — nothing to
        // derive, but the caller already named the path, so its own folder
        // is not new information (unlike the invisible-path branch above,
        // which withholds everything about a path the caller cannot see).
        return ok({ address: null, expected_folder: null, actual_folder: folderOf(path), placed: null });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
