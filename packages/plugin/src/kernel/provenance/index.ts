// kernel/provenance — the pure provenance core, folded in from the standalone
// `obsidian-provenance` Python CLI (the vault-mcp module fold).
//
// Every file here is Obsidian-free: the freshness / reconcile / regen engines
// run over an injected `ProvenanceSource` (provenance-source.ts), exactly the
// seam pattern the vault-mcp module system already uses (SkillsSource /
// LinkSource / VocabSource / UidSource). The Obsidian-facing adapter and the
// three MCP tools live in mcp/tools-provenance.ts; the module registration +
// manifest live in mcp/modules-mount.ts. Nothing here imports `obsidian` or the
// MCP SDK.

export type {
  ProvenanceSource,
  ProvenanceWriter,
  ProvenanceBackend,
  FileStat,
} from "./provenance-source.js";
export { checkFreshness, SOURCE_COUNT_FIELD, type FreshnessVerdict } from "./freshness.js";
export { resolveSource, resolveEntries, latestMtime, isGlob, type ResolvedEntries } from "./sources.js";
export { reconcile, type Reconciliation, type PluginManifest } from "./plugins.js";
export { renderAudit, extractSections, reinsertSections } from "./render.js";
export { regenerateAudit, auditPath } from "./regen.js";
export {
  DEFAULT_NOTES_DIR,
  AUDIT_GENERATOR,
  AUDIT_DERIVATION_MODE,
  DEFAULT_PROVENANCE_CONFIG,
  auditDerivedFrom,
  provenanceConfigOf,
  validateProvenanceConfig,
  type ProvenanceConfig,
} from "./provenance-config.js";
