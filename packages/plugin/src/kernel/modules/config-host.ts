// config-host.ts — ConfigHost: the pure collector that turns a module list +
// stored settings into render-ready data for the generic settings-tab
// renderer (connection-ui.ts). See
// docs/superpowers/specs/2026-08-10-config-host-design.md §2.
//
// Deliberately independent of the ModuleRegistry INSTANCE: `registry.configFor`
// only ever sees the `modules.<id>.config` slice (`ModuleSettings`), never the
// plugin's FULL settings object — so it structurally cannot resolve a
// module's `ConfigBinding` (scheme's config lives at `settings.schemes[0]`,
// not `settings.modules.scheme.config`; see design §3, "no data migration in
// v1"). `collect` takes the same `VaultModule[]` + `ModuleSettings` inputs
// the registry is built from, PLUS the full settings object bindings need,
// and does its own two-line enablement resolution rather than growing the
// registry a settings-object-shaped dependency it has no other reason to
// carry (its own contract stays `modules.<id>.config`-scoped by design).
//
// No storage, no writes: `collect` only reads. connection-ui.ts owns the
// write path (a module's `ConfigBinding.write`, or the plain
// `modules.<id>.config` patch for an unbound module) — this file offers no
// setter at all, so there is no MCP-reachable (or any other) path to config
// through the host itself (design §2's pinned invariant; the host is not a
// tool and never will be).
//
// Kernel-module rules: pure, no `obsidian` imports, headlessly testable.

import type { ModulePosture, VaultModule } from "./module.js";
import type { ConfigField, SurfaceDoc, ToolDoc } from "./manifest.js";
import { mergeModuleConfig, type ModuleSettings } from "./settings.js";

// ConfigBinding itself lives in manifest.ts (re-exported from the barrel
// alongside it) — not here, and not in module.ts — so the three files form
// a plain DAG: module.ts and config-host.ts both depend on manifest.ts,
// never the reverse, and module.ts and config-host.ts never depend on each
// other's non-type exports.
export type { ConfigBinding } from "./manifest.js";

export interface HostedField extends ConfigField {
  /** The field's current EFFECTIVE value — defaults merged under the
   * stored override, same semantics as `ModuleRegistry.configFor`. */
  value: unknown;
}

export interface HostedDirectory {
  tools: ToolDoc[];
  addressForms: SurfaceDoc[];
  rulePacks: SurfaceDoc[];
  kernelArgs: SurfaceDoc[];
}

export interface HostedModule {
  id: string;
  posture: ModulePosture;
  capabilities: string[];
  enabled: boolean;
  summary: string;
  fields: HostedField[];
  /** Cross-field validation problems over the module's CURRENT merged
   * config — never thrown; a throwing `validate` is contained and reported
   * as one problem string, the same discipline `ModuleRegistry.registerAll`
   * applies to a throwing `ModuleSettingsSchema.validate`. */
  problems: string[];
  directory: HostedDirectory;
}

/**
 * Render-ready data for every module in `modules`, in declaration order —
 * ONE entry per module regardless of whether it declares any config fields:
 * a capability-directory-only module still gets an entry (`fields: []`, not
 * an absent module), and a module with no `manifest` at all yet still gets
 * a minimal entry (empty summary, no fields, no directory) rather than being
 * skipped. The renderer always has something to iterate.
 */
export function collect(modules: VaultModule[], moduleSettings: ModuleSettings, settings: unknown): HostedModule[] {
  return modules.map((m) => {
    const manifest = m.manifest;
    const enabled = moduleSettings[m.id]?.enabled ?? m.enabled;
    const declaredFields = manifest?.config?.fields ?? [];
    const merged: Record<string, unknown> = m.configBinding
      ? mergeModuleConfig(manifest?.config?.defaults, m.configBinding.read(settings))
      : mergeModuleConfig(manifest?.config?.defaults, moduleSettings[m.id]?.config);
    const fields: HostedField[] = declaredFields.map((f) => ({ ...f, value: merged[f.key] }));
    let problems: string[] = [];
    try {
      problems = manifest?.config?.validate?.(merged) ?? [];
    } catch (e) {
      problems = [`config validate() threw: ${e instanceof Error ? e.message : String(e)}`];
    }
    return {
      id: m.id,
      posture: m.posture,
      capabilities: [...m.capabilities],
      enabled,
      summary: manifest?.summary ?? "",
      fields,
      problems,
      directory: {
        tools: manifest?.directory?.tools ?? [],
        addressForms: manifest?.directory?.addressForms ?? [],
        rulePacks: manifest?.directory?.rulePacks ?? [],
        kernelArgs: manifest?.directory?.kernelArgs ?? [],
      },
    };
  });
}
