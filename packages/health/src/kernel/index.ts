// src/kernel — the pure vault-health scanner core, folded in from the standalone
// `obsidian-vault-health` Bash+eval scanner (first as a Governor capability
// module, since the suite split's S7 as this satellite's kernel). READ-ONLY: it
// emits tiered findings and never mutates the vault (the fixing is a separate
// skill, out of scope).
//
// Every file here is Obsidian-free: the scan runs over an injected `HealthSource`
// (health-source.ts), the seam pattern the host's module system used
// (ProvenanceSource / LinkSource / VocabSource) and the one every satellite
// keeps. The Obsidian-facing adapter (`obsidianHealthBackend`) lives in
// `src/obsidian-source.ts`, the two published tool specs in `src/tools.ts`, and
// the settings tab that used to be the host's generic config tab in
// `src/settings-tab.ts`. Nothing here imports `obsidian` or the MCP SDK.

export type {
  HealthSource,
  HealthFile,
  HealthFileExt,
} from "./health-source.js";
export {
  scanHealth,
  filterFindingsToScope,
  summarize,
  type HealthFindings,
  type HealthCounts,
  type RepointableLink,
  type DanglingLink,
  type DanglingReason,
  type EmptyNote,
  type OrphanAttachment,
  type LowSignalTag,
  type DuplicateGroup,
} from "./scan.js";
export {
  DEFAULT_EMPTY_CHARS,
  DEFAULT_HEALTH_CONFIG,
  healthConfigOf,
  validateHealthConfig,
  type HealthConfig,
} from "./health-config.js";
