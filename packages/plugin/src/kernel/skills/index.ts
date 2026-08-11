// kernel/skills — the pure skills-export core, folded in from
// obsidian-vault-skills (cycle 2 of the vault-skills -> vault-mcp fold, #82).
//
// Every file here is Obsidian-free: the exporter/transform/transclude compiler
// runs over an injected `SkillsSource` (skills-source.ts), exactly the seam
// pattern the vault-mcp module system already uses (LinkSource / VocabSource /
// UidSource). The Obsidian-facing adapter and the six MCP tools live in
// mcp/tools-skills.ts; the module registration + manifest live in
// mcp/modules-mount.ts. Nothing here imports `obsidian` or the MCP SDK.

export type { SkillsSource, SourceNote, EmbedLookup } from "./skills-source.js";
export {
  analyzeVault,
  previewVault,
  runExport,
  readPluginVersion,
  markFrontmatter,
  applyMark,
  DEFAULT_FIELDS,
  DEFAULT_TAG_PREFIX,
  EXPORTABLE_TYPES,
  type Analysis,
  type PreviewResult,
  type PreviewEntry,
  type ExportSummary,
  type ExportOptions,
  type MarkInput,
  type MarkResult,
  type FieldConfig,
  type DetectConfig,
} from "./exporter.js";
export {
  DEFAULT_SKILLS_CONFIG,
  skillsConfigOf,
  fieldsOf,
  validateSkillsConfig,
  expandTilde,
  type SkillsConfig,
} from "./skills-config.js";
