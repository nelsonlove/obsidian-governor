// skills-config.ts — the skills module's configuration shape and the pure
// mapping from a stored `modules.skills.config` record to the exporter's
// DetectConfig. Obsidian-free (node built-ins only), so it moves with the
// rest of the pure core and is headless-testable.
//
// In the STANDALONE vault-skills plugin this logic lived in `settings.ts`
// (coupled to `PluginSettingTab`) and `paths.ts`. Here only the pure halves
// come across: the settings-tab UI is replaced by the config-host's generic,
// manifest-driven renderer (SKILLS_MANIFEST in mcp/modules-mount.ts), and the
// on-save export trigger (`exportOnSave`) is dropped — a vault-mcp module is
// tool-triggered, it has no vault-side save hook.

import * as os from "node:os";
import * as path from "node:path";
import type { DetectConfig } from "./exporter.js";

/** The skills module's config, as stored under `modules.skills.config` and
 * merged over the manifest defaults. A superset of what the exporter needs:
 * the field/detection config plus the two write destinations (export +
 * release) and the optional supporting-files root. */
export interface SkillsConfig {
  /** Where `vault_skills_export` writes the generated Claude Code plugin. `~` expanded. */
  outputDir: string;
  /** Claude Code plugin name — also the command/subagent namespace. */
  pluginName: string;
  /** How a note declares its kind: the `type` frontmatter field, or a kind tag. */
  typeSource: "frontmatter" | "tags";
  /** Tags mode: `#{tagPrefix}{kind}` (e.g. `agent/` -> `#agent/skill`). */
  tagPrefix: string;
  /** How the vault-skills frontmatter fields are namespaced. */
  fieldMode: "prefix" | "nested";
  /** prefix mode: prefixes each field (blank => bare top-level fields). */
  fieldPrefix: string;
  /** nested mode: nests every field under this one key. */
  fieldKey: string;
  /** Root of a parallel filesystem tree of skills' supporting files. Blank => none. `~` expanded. */
  assetsRoot: string;
  /** A git checkout `vault_skills_release` targets. Blank => release disabled. `~` expanded. */
  releaseDir: string;
}

/** The module's config defaults — mirrors the standalone plugin's
 * DEFAULT_SETTINGS (minus `exportOnSave`). Fed to the manifest as
 * `config.defaults`, so the config tab renders them and `register()` receives
 * them merged under any user override. */
export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  outputDir: "~/.claude/skills/vault-skills",
  pluginName: "vault-skills",
  typeSource: "frontmatter",
  tagPrefix: "agent/",
  fieldMode: "prefix",
  fieldPrefix: "",
  fieldKey: "vault-skills",
  assetsRoot: "",
  releaseDir: "",
};

/** Coerce a merged config record (defaults + user override, as `register()`
 * receives it) into a typed SkillsConfig, falling back to the default for any
 * value of the wrong shape — a hand-edited data.json must never crash a tool,
 * only degrade to the default (the vocab/scheme skip-and-report discipline). */
export function skillsConfigOf(config: Record<string, unknown>): SkillsConfig {
  const str = (k: keyof SkillsConfig): string =>
    typeof config[k] === "string" ? (config[k] as string) : (DEFAULT_SKILLS_CONFIG[k] as string);
  const typeSource = config.typeSource === "tags" ? "tags" : "frontmatter";
  const fieldMode = config.fieldMode === "nested" ? "nested" : "prefix";
  return {
    outputDir: str("outputDir"),
    pluginName: str("pluginName"),
    typeSource,
    tagPrefix: str("tagPrefix"),
    fieldMode,
    fieldPrefix: str("fieldPrefix"),
    fieldKey: str("fieldKey"),
    assetsRoot: str("assetsRoot"),
    releaseDir: str("releaseDir"),
  };
}

/** The detection + field-namespacing config the exporter reads — the single
 * mapping shared by export, the read-only tools, and the mark write path. */
export function fieldsOf(s: SkillsConfig): DetectConfig {
  return { mode: s.fieldMode, prefix: s.fieldPrefix, key: s.fieldKey, typeSource: s.typeSource, tagPrefix: s.tagPrefix };
}

/** Validate a merged config for the config tab (manifest.config.validate).
 * Loud, never coercing: an empty plugin name or an out-of-range select is
 * REPORTED, so the user sees the consequence. Field-namespace and destination
 * strings are free-form (any path), so they carry no validation. */
export function validateSkillsConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof config.pluginName === "string" && config.pluginName.trim() === "") {
    problems.push("pluginName must not be blank — it is the Claude Code plugin/command/subagent namespace");
  }
  if (config.typeSource !== undefined && config.typeSource !== "frontmatter" && config.typeSource !== "tags") {
    problems.push('typeSource must be "frontmatter" or "tags"');
  }
  if (config.fieldMode !== undefined && config.fieldMode !== "prefix" && config.fieldMode !== "nested") {
    problems.push('fieldMode must be "prefix" or "nested"');
  }
  return problems;
}

/** Expand a leading `~` to the home directory (the export/release write paths). */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
