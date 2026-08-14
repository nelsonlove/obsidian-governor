// kernel/health — the pure vault-health scanner core, folded in from the
// standalone `obsidian-vault-health` Bash+eval scanner (the vault-mcp module
// fold). READ-ONLY: it emits tiered findings and never mutates the vault (the
// fixing is a separate skill, out of scope).
//
// Every file here is Obsidian-free: the scan runs over an injected `HealthSource`
// (health-source.ts), exactly the seam pattern the vault-mcp module system uses
// (ProvenanceSource / SkillsSource / LinkSource / VocabSource). The Obsidian-
// facing adapter (`obsidianHealthBackend`) and the read-only MCP tools live in
// mcp/tools-health.ts; the module registration + manifest live in
// mcp/modules-mount.ts. Nothing here imports `obsidian` or the MCP SDK.

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
