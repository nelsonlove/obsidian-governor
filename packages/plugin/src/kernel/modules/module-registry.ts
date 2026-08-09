// module-registry.ts — ModuleRegistry: the host. Instantiates the ENABLED
// capability modules from plugin settings and exposes their tools to a served
// connection through the (guard-patched) registrar it is handed.
//
// Discipline mirrors the vocab registry's: settings and module lists are
// user-shaped inputs, so every defect — duplicate id, unknown id in settings,
// governance posture, tool-name collision, forbidden tool name, a throwing
// register() — is SKIPPED AND REPORTED via `problems`, never thrown. One bad
// module must not take the tool surface down, and a bad tool must not take
// its module down.
//
// Two refusals here are load-bearing policy, not hygiene:
//
//   1. Governance modules are refused at construction. The consolidation
//      ruling gates folding Stewardship in on a FRESH accept-reachability
//      review of the merged topology; until that review exists, the v1 host
//      simply cannot instantiate a governance module. (The posture is in the
//      type so the contract already models the asymmetry.)
//
//   2. The accept tripwire: "no module may contribute a baseline-advancing
//      callable to the shared surface" (the one hard rule of the merge). The
//      enforceable, testable form is a name check at registration — a tool
//      whose name mentions accept/approve/baseline is refused and reported.
//      This is a TRIPWIRE, not the security boundary: the boundary is that no
//      accept-capable code is reachable from any module the v1 registry will
//      instantiate. The tripwire exists so a future module that tries grows a
//      loud, greppable, test-pinned failure instead of a quiet registration.
//
// Kernel-module rules: pure TypeScript, no "obsidian" or SDK imports,
// headless-testable end to end.

import type {
  ModuleHostCtx,
  ToolDef,
  ToolHandler,
  ToolRegistrar,
  VaultModule,
} from "./module.js";
import { mergeModuleConfig, type ModuleSettings } from "./settings.js";

/** Tool names no module may register, whatever its posture: anything that
 * reads as advancing a baseline or minting acceptance. Case-insensitive
 * substring match on the registered name. */
const FORBIDDEN_NAME_FRAGMENTS = ["accept", "approve", "baseline"];

export function forbiddenToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_NAME_FRAGMENTS.some((f) => lower.includes(f));
}

/** One module's registry-eye view, for enumeration and the settings UI. */
export interface ModuleDescription {
  id: string;
  posture: VaultModule["posture"];
  capabilities: string[];
  enabled: boolean;
  /** Tool names the module actually contributed on the last registerAll
   * (empty before one ran, or when disabled). */
  tools: string[];
}

export class ModuleRegistry {
  /** Every defect found while constructing or registering — user-facing. */
  readonly problems: string[] = [];
  private readonly modules: VaultModule[] = [];
  private readonly settings: ModuleSettings;
  /** module id → tool names it contributed on the last registerAll. */
  private contributed = new Map<string, string[]>();

  constructor(modules: VaultModule[], settings: ModuleSettings = {}) {
    this.settings = settings;
    const seen = new Set<string>();
    for (const m of modules) {
      if (seen.has(m.id)) {
        this.problems.push(`duplicate module id '${m.id}' — first declaration wins`);
        continue;
      }
      if (m.posture === "governance") {
        this.problems.push(
          `module '${m.id}' declares posture 'governance' — refused: the v1 host holds capability modules only ` +
            `(governance integration is gated on an accept-reachability review)`,
        );
        continue;
      }
      seen.add(m.id);
      this.modules.push(m);
    }
    // Settings rows naming a module that does not exist are inert by
    // construction; say so rather than leaving the row silently dead.
    for (const id of Object.keys(settings)) {
      if (!modules.some((m) => m.id === id)) {
        this.problems.push(`settings name unknown module '${id}' — ignored`);
      }
    }
  }

  /** Effective enabled state: the settings override when present, else the
   * module's default. Unknown ids are not enabled. */
  isEnabled(id: string): boolean {
    const m = this.modules.find((x) => x.id === id);
    if (!m) return false;
    return this.settings[id]?.enabled ?? m.enabled;
  }

  /** The modules registerAll will call, in declaration order. */
  enabledModules(): VaultModule[] {
    return this.modules.filter((m) => this.isEnabled(m.id));
  }

  /** The module's schema defaults merged under the user's config. */
  configFor(id: string): Record<string, unknown> {
    const m = this.modules.find((x) => x.id === id);
    return mergeModuleConfig(m?.settingsSchema?.defaults, this.settings[id]?.config);
  }

  /**
   * Contribute every enabled module's tools through `reg` — per built server,
   * exactly like the hand-registered `registerXTools` calls, so per-connection
   * snapshots and conditional registration keep working unchanged.
   *
   * The registrar each module sees is WRAPPED: the host records what the
   * module contributed (for describe()), refuses cross-module name collisions
   * (first registration wins — two modules disagreeing about one name is a
   * packaging bug, not a runtime race), and refuses forbidden names (the
   * accept tripwire above). A module whose register() throws loses its own
   * remaining tools and nothing else.
   */
  registerAll(reg: ToolRegistrar, host: ModuleHostCtx): void {
    this.contributed = new Map();
    const taken = new Set<string>();
    for (const m of this.enabledModules()) {
      const config = this.configFor(m.id);
      const problems = m.settingsSchema?.validate?.(config) ?? [];
      for (const p of problems) this.problems.push(`module '${m.id}' config: ${p}`);
      const names: string[] = [];
      this.contributed.set(m.id, names);
      const scoped: ToolRegistrar = (name: string, def: ToolDef, handler: ToolHandler) => {
        if (forbiddenToolName(name)) {
          this.problems.push(
            `module '${m.id}' tried to register '${name}' — refused: accept/baseline-shaped tool names are ` +
              `forbidden on the shared surface`,
          );
          return;
        }
        if (taken.has(name)) {
          this.problems.push(`module '${m.id}' tried to register '${name}' — refused: name already registered`);
          return;
        }
        taken.add(name);
        names.push(name);
        reg(name, def, handler);
      };
      try {
        m.register(scoped, host, config);
      } catch (e) {
        this.problems.push(`module '${m.id}' register() threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Every known module (enabled or not), with what it contributed last. */
  describe(): ModuleDescription[] {
    return this.modules.map((m) => ({
      id: m.id,
      posture: m.posture,
      capabilities: [...m.capabilities],
      enabled: this.isEnabled(m.id),
      tools: [...(this.contributed.get(m.id) ?? [])],
    }));
  }
}
