// kernel/modules — the module host: the Module contract, the registry that
// instantiates enabled modules from settings, and the adapter for the
// existing registerXTools idiom. Additive skeleton (nothing imports this
// yet); the server.ts mount and the kernel/index.ts re-export are the later,
// sequenced integration step.
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
  type ModuleInstanceSettings,
  type ModuleSettings,
} from "./settings.js";
