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
// Kernel-module rules: pure, no "obsidian"/SDK imports; the `server` the
// registrar receives is a one-key object satisfying its structural need
// (`registerTool`), which is all those functions use.

import type { ModuleHostCtx, ModulePosture, ModuleSettingsSchema, ToolRegistrar, VaultModule } from "./module.js";

/** What an adapted registrar is handed as its `server`: exactly the one
 * method the registerXTools idiom uses. */
export interface RegistrarServer {
  registerTool: ToolRegistrar;
}

export interface AdapterMeta {
  id: string;
  capabilities: string[];
  enabled: boolean;
  /** Default "capability" — the only posture the v1 registry instantiates. */
  posture?: ModulePosture;
  settingsSchema?: ModuleSettingsSchema;
}

/**
 * A VaultModule from an existing `register(server, ctx)` function. `ctxOf`
 * builds the module's own ctx from the host context and the merged config —
 * the one place module-specific wiring lives.
 */
export function moduleFromRegistrar<C>(
  meta: AdapterMeta,
  registrar: (server: RegistrarServer, ctx: C) => void,
  ctxOf: (host: ModuleHostCtx, config: Record<string, unknown>) => C,
): VaultModule {
  return {
    id: meta.id,
    posture: meta.posture ?? "capability",
    capabilities: meta.capabilities,
    enabled: meta.enabled,
    ...(meta.settingsSchema ? { settingsSchema: meta.settingsSchema } : {}),
    register(reg, host, config) {
      registrar({ registerTool: reg }, ctxOf(host, config));
    },
  };
}
