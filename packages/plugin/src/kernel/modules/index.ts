// kernel/modules — the module host: the Module contract, the registry that
// instantiates enabled modules from settings, and the adapter for the
// existing registerXTools idiom. Mounted since the module-host-mount step:
// mcp/modules-mount.ts assembles the built-in capability modules and
// server.ts registers them through the ModuleRegistry; kernel/index.ts
// re-exports this barrel.
export type {
  ModuleHostCtx,
  ModulePosture,
  ModuleSettingsSchema,
  ToolDef,
  ToolHandler,
  ToolRegistrar,
  VaultModule,
} from "./module.js";
export {
  ModuleRegistry,
  forbiddenToolName,
  type ModuleDescription,
} from "./module-registry.js";
export { moduleFromRegistrar, type AdapterMeta, type RegistrarServer } from "./adapters.js";
export {
  DEFAULT_MODULE_SETTINGS,
  mergeModuleConfig,
  migrateLegacyModuleIds,
  type ModuleInstanceSettings,
  type ModuleSettings,
} from "./settings.js";
export {
  toolDocDrift,
  toolDocReadOnlyDrift,
  safeValidate,
  type ConfigBinding,
  type ConfigField,
  type ConfigFieldType,
  type ModuleManifest,
  type SurfaceDoc,
  type ToolDoc,
} from "./manifest.js";
export {
  collect,
  type HostedDirectory,
  type HostedField,
  type HostedModule,
} from "./config-host.js";
