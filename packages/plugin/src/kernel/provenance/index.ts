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
export { checkFreshness, type FreshnessVerdict } from "./freshness.js";
export { resolveSource, resolveEntries, latestMtime, isGlob, type ResolvedEntries } from "./sources.js";
export { reconcile, type Reconciliation, type PluginManifest } from "./plugins.js";
export { renderAudit, extractSections, reinsertSections } from "./render.js";
export { regenerateAudit, auditPath } from "./regen.js";
export {
  DEFAULT_NOTES_DIR,
  DEFAULT_NOTES_SOURCE,
  DEFAULT_AUDIT_NOTE,
  notesGlob,
  globMatchesPath,
  globSegmentRe,
  flatAuditPath,
  AUDIT_GENERATOR,
  AUDIT_DERIVATION_MODE,
  SOURCE_COUNT_FIELD,
  DEFAULT_PROVENANCE_CONFIG,
  auditDerivedFrom,
  provenanceConfigOf,
  validateProvenanceConfig,
  type ProvenanceConfig,
  type NotesSource,
} from "./provenance-config.js";
