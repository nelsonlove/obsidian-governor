// adapters.ts — the thin seam between the Module contract and the codebase's
// existing registration idiom, `registerXTools(server, ctx)` (tools-uid,
// tools-locks, the scope provider's registerSchemeTools, the vocabulary
// provider's tool layer). An adapter wraps one of those functions into a
// VaultModule WITHOUT touching its internals: the registrar function is
// imported as-is, and the module's ctx is built by a `ctxOf` closure from
// what the host provides plus the merged config.
//
// This is how scope + vocab become the registry's first contents at merge
// time — each lands as ~five lines of metadata + a ctxOf, no rewrite:
//
//   moduleFromRegistrar(
//     { id: "scheme", capabilities: ["addressing", "allocation"], enabled: true },
//     registerSchemeTools,
//     (host, config) => ({
//       getSettings: host.getSettings,
//       registry: () => new SchemeRegistry(config.schemes),
//       notes: host.sources?.["scheme"],
//     }),
//   )
//
// Two deliberate accommodations for the real signatures:
//
//   - The registrar's `server` parameter is typed `any`, not RegistrarServer.
//     The existing functions declare `server: McpServer` (the concrete SDK
//     class), and under strictFunctionTypes a McpServer-taking function is not
//     assignable to a RegistrarServer-taking parameter — the structural type
//     would force a cast at every adapter site, defeating "as-is". At runtime
//     the one-key object is sufficient: the idiom uses only `registerTool`.
//     RegistrarServer stays exported as the shape NEW registrars should
//     declare (a structurally-typed registrar needs no accommodation).
//
//   - A registrar with extra positional dependencies (registerLockTools takes
//     a third `actor` argument) does not fit the two-argument call — TypeScript
//     refuses the assignment (a 3-required-param function is not a 2-param
//     function), so the mistake cannot compile into a silent `undefined`.
//     Adapt those with a one-line closure, still zero change to the function:
//
//       moduleFromRegistrar(meta, (s, ctx: LockToolsCtx & { actor: ... }) =>
//         registerLockTools(s, ctx, ctx.actor), ctxOf)
//
// Kernel-module rules: pure, no "obsidian"/SDK imports; the `server` the
// registrar receives is a one-key object satisfying its structural need
// (`registerTool`), which is all those functions use.

import type { ModuleHostCtx, ModulePosture, ModuleSettingsSchema, ToolRegistrar, VaultModule } from "./module.js";
import type { ConfigBinding, ModuleManifest } from "./manifest.js";

/** What an adapted registrar is handed as its `server`: exactly the one
 * method the registerXTools idiom uses. New registrars should declare this
 * shape (or narrower) as their `server` parameter; existing McpServer-typed
 * ones adapt unchanged via the `any` accommodation documented above. */
export interface RegistrarServer {
  registerTool: ToolRegistrar;
}

export interface AdapterMeta {
  id: string;
  capabilities: string[];
  enabled: boolean;
  /** Default "capability" — the only posture the v1 registry instantiates. */
  posture?: ModulePosture;
  /** Declares this module may contribute mutating tools — see
   * `VaultModule.mutating`. The mount gate honors it; absent ⇒ read-only-only. */
  mutating?: boolean;
  /** @deprecated see manifest below. */
  settingsSchema?: ModuleSettingsSchema;
  /** The module's config-host subscription (manifest.ts) — typed config
   * fields + capability directory. */
  manifest?: ModuleManifest;
  /** Where this module's config actually lives, for a module whose config
   * predates the module host (manifest.ts's `ConfigBinding` doc). */
  configBinding?: ConfigBinding;
}

/**
 * A VaultModule from an existing `register(server, ctx)` function. `ctxOf`
 * builds the module's own ctx from the host context and the merged config —
 * the one place module-specific wiring lives.
 */
export function moduleFromRegistrar<C>(
  meta: AdapterMeta,
  // `server: any` — deliberate; see the header comment. The RegistrarServer
  // one-key object is what actually arrives.
  registrar: (server: any, ctx: C) => void,
  ctxOf: (host: ModuleHostCtx, config: Record<string, unknown>) => C,
): VaultModule {
  return {
    id: meta.id,
    posture: meta.posture ?? "capability",
    capabilities: meta.capabilities,
    enabled: meta.enabled,
    ...(meta.mutating ? { mutating: true } : {}),
    ...(meta.settingsSchema ? { settingsSchema: meta.settingsSchema } : {}),
    ...(meta.manifest ? { manifest: meta.manifest } : {}),
    ...(meta.configBinding ? { configBinding: meta.configBinding } : {}),
    register(reg, host, config) {
      registrar({ registerTool: reg }, ctxOf(host, config));
    },
  };
}
