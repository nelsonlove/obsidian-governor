// modules-mount.ts — the module host's mount: the two built-in capability
// modules (scope-provider, vocabulary provider) assembled as VaultModules and
// registered THROUGH the ModuleRegistry (ruled decision #2 realized — they
// are settings-toggleable units behind the host's tripwire/collision checks,
// no longer direct registerXTools calls in server.ts).
//
// Pure and headless-testable: no `obsidian` imports — the vault-facing
// dependencies (note listings, the vocab source) arrive injected via
// MountDeps, exactly as tools-scheme/tools-vocab already take them; server.ts
// contributes only the live adapters and the patched registerTool.
//
// ── The hard security gate this file answers (recorded by the orchestrator
//    on the module-host merge; verified by test where testable) ─────────────
//
//  1. HANDLER reachability: every tool either module contributes is
//     `readOnlyHint: true` — a read-only registration cannot reach the write
//     queue, the write primitive, or the accept-guard's territory at all (the
//     guard routes ONLY `readOnlyHint === false` calls to the kernel's
//     mutation path). Pinned by test: the mount refuses to expose a module
//     tool whose annotations are not read-only (`nonReadOnlyTools` below), so
//     a future module slipping a mutating handler in fails loudly rather than
//     registering quietly.
//  2. The host ctx handed to modules is MINIMAL: `getSettings` + `visible`
//     and nothing else — no kernel, no raw server, no registerTool, no
//     baseline/accept surface. Pinned by test over `mountHost`'s keys.
//  3. Modules register ONLY through the registry: server.ts no longer calls
//     registerSchemeTools/registerVocabTools directly (pinned by a source
//     scan in the test suite), so the tripwire and collision checks cannot be
//     bypassed for module tools.
//  4. Capability modules only — nothing here declares (or could smuggle) a
//     governance posture; the registry refuses that posture at construction
//     anyway.

import type { GuardSettings } from "../guard.js";
import { visiblePaths } from "../guard.js";
import {
  ModuleRegistry,
  moduleFromRegistrar,
  type ModuleHostCtx,
  type ModuleSettings,
  type ToolRegistrar,
  type VaultModule,
} from "../kernel/modules/index.js";
import { makeRegistry, DEFAULT_SCHEMES, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import type { VocabInstanceSettings } from "../kernel/index.js";
import { registerSchemeTools } from "./tools-scheme.js";
import { registerVocabTools, type VocabSource, type VocabToolsCtx } from "./tools-vocab.js";

/** What the mount needs from the live plugin (server.ts supplies the Obsidian
 * adapters; tests supply fakes). The same per-call freshness discipline as
 * the direct registrations it replaces: everything is a thunk, so a settings
 * edit lands live without a reconnect. */
export interface MountDeps {
  getSettings: () => GuardSettings & {
    schemes?: SchemeInstanceConfig[];
    modules?: ModuleSettings;
  };
  /** The `vocabularies` settings array. Absent ⇒ the vocab module's defaults. */
  getVocabularies?: () => VocabInstanceSettings[];
  /** Vault markdown paths, for the scheme module's placement/membership answers. */
  schemeNotes: () => string[];
  /** The vocab module's injected vault reader (obsidianVocabSource live). */
  vocabSource: VocabSource;
}

/** The ModuleHostCtx modules receive — deliberately minimal (gate point 2).
 * Exported so the test suite can pin its exact key set: a key added here is a
 * key handed to every module, and must survive the same review this shape
 * did. */
export function mountHost(deps: MountDeps): ModuleHostCtx {
  return {
    getSettings: deps.getSettings,
    visible: (paths: string[]) => visiblePaths(paths, deps.getSettings()),
  };
}

/** The built-in capability modules, adapted without touching their tool
 * layers (module-host adapters doc): scope-provider in its exact
 * `register(server, ctx)` shape, vocab via the documented one-line closure
 * for its injected-source middle parameter. */
export function builtinModules(deps: MountDeps): VaultModule[] {
  return [
    moduleFromRegistrar(
      { id: "scheme", capabilities: ["addressing", "allocation"], enabled: true },
      registerSchemeTools,
      () => ({
        registry: () => makeRegistry(deps.getSettings().schemes ?? DEFAULT_SCHEMES),
        notes: deps.schemeNotes,
        getSettings: deps.getSettings,
      }),
    ),
    moduleFromRegistrar(
      { id: "vocab", capabilities: ["vocabulary"], enabled: true },
      // The documented closure form for a registrar with an injected middle
      // parameter — `server` is `any` per the adapter contract, so the
      // McpServer-typed signature needs no cast.
      (server: any, ctx: VocabToolsCtx) => registerVocabTools(server, deps.vocabSource, ctx),
      () => ({
        getSettings: deps.getSettings,
        ...(deps.getVocabularies ? { getVocabularies: deps.getVocabularies } : {}),
      }),
    ),
  ];
}

/**
 * Mount the built-in modules through a fresh ModuleRegistry and register the
 * enabled ones' tools via `registerTool` — which, from server.ts, is the
 * PATCHED `server.registerTool`, so every module tool lands at the same
 * guard/queue/journal interception point as every hand-registered tool
 * (kernel args declared, allowlist enforced, Code Mode captured alike).
 *
 * The registrar handed to the registry additionally REFUSES any module tool
 * whose annotations are not explicitly read-only (gate point 1): the two v1
 * modules are read-only by design, and a module that stops being so must
 * fail this mount loudly and re-earn it through review, not drift in.
 * Refusals land in `problems` (and the tool is not registered) — the
 * registry's own skip-and-report discipline.
 *
 * Returns the registry so the caller (settings UI, diagnostics) can read
 * `describe()` and `problems`.
 */
export function mountModules(registerTool: ToolRegistrar, deps: MountDeps): ModuleRegistry {
  const registry = new ModuleRegistry(builtinModules(deps), deps.getSettings().modules ?? {});
  const readOnlyOnly: ToolRegistrar = (name, def, handler) => {
    if (def?.annotations?.readOnlyHint !== true) {
      registry.report(
        `module tool '${name}' is not explicitly read-only — refused: v1 capability modules are read-only by ` +
          `design (readOnlyHint: true); a mutating module tool needs its own reachability review before mounting`,
      );
      return;
    }
    registerTool(name, def, handler);
  };
  registry.registerAll(readOnlyOnly, mountHost(deps));
  return registry;
}
