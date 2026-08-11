import * as fs from "node:fs";
import * as path from "node:path";
import { transformAll, SKILL_PASSTHROUGH_FIELDS, type EmittedKind, type Generated, type NoteInput, type PolicyPlacement, type TreeNode } from "./transform.js";
import { resolveTransclusions, stripFrontmatter } from "./transclude.js";
import type { SkillsSource } from "./skills-source.js";
import { STATIC_FILES } from "./static-skills.js";
import { assetDirFor, collectAssets, copyAsset, type CollectAssetsOptions } from "./assets.js";

const MANIFEST_NAME = ".vault-skills-manifest.json";

/** How the vault-skills fields are namespaced in a note's frontmatter. */
export interface FieldConfig {
  mode: "prefix" | "nested";
  prefix: string; // e.g. "vs-" → vs-type, vs-parent (prefix mode)
  key: string;    // e.g. "vault-skills" → nested object (nested mode)
}

/** FieldConfig plus how a note's *kind* (skill/agent/policy) is declared. In "tags" mode the
 *  kind comes from a `#{tagPrefix}{kind}` tag and any `type:` frontmatter is ignored; every other
 *  field (parent, description, …) is still read from frontmatter per the FieldConfig. Both extras
 *  are optional so a bare FieldConfig behaves exactly like frontmatter mode with the default prefix. */
export interface DetectConfig extends FieldConfig {
  typeSource?: "frontmatter" | "tags";
  tagPrefix?: string; // e.g. "agent/" → #agent/skill, #agent/agent, #agent/policy
}

export const DEFAULT_FIELDS: FieldConfig = { mode: "prefix", prefix: "", key: "vault-skills" };
export const DEFAULT_TAG_PREFIX = "agent/";

/** The note `type` values that produce plugin output (skills, agents, the policies folded into
 *  agents, and the flat slash commands). Single source of truth for "does this note participate
 *  in the export" — shared by collection (collectNotes), kind detection, and the export-on-save
 *  relevance check. */
export const EXPORTABLE_TYPES = ["skill", "agent", "policy", "command"] as const;
type ExportableKind = (typeof EXPORTABLE_TYPES)[number];
export function isExportableType(type: unknown): type is ExportableKind {
  return (EXPORTABLE_TYPES as readonly unknown[]).includes(type);
}

/** Normalize a note's frontmatter `tags` (Obsidian stores them without `#`, as a list or a
 *  string) into `#tag` strings. Body/inline tags are intentionally NOT read: a kind declaration
 *  is metadata, so it lives in frontmatter — this avoids classifying a note that merely mentions
 *  `#agent/skill` in prose, and matches the "tags only in frontmatter" vault convention. Pure. */
export function extractTags(fm: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (v == null) return; // skip null/empty list entries rather than emitting `#null`
    const s = String(v).trim();
    if (s) out.push(s.startsWith("#") ? s : `#${s}`);
  };
  // Obsidian accepts both the plural `tags:` and singular `tag:` frontmatter keys.
  for (const raw of [fm?.tags, fm?.tag]) {
    if (Array.isArray(raw)) for (const t of raw) push(t);
    else if (typeof raw === "string") for (const t of raw.split(/[,\s]+/)) push(t);
  }
  return out;
}

/** Which kind a set of tags declares under `prefix` (case-insensitive, exact leaf), or null;
 *  "ambiguous" when more than one distinct kind tag is present. */
export function tagKind(tags: string[], prefix: string): ExportableKind | null | "ambiguous" {
  const have = new Set(tags.map((t) => t.toLowerCase()));
  const hits = EXPORTABLE_TYPES.filter((k) => have.has(`#${prefix}${k}`.toLowerCase()));
  return hits.length === 0 ? null : hits.length > 1 ? "ambiguous" : hits[0];
}

/** Resolve a note's kind per the detection mode. `view` is the field-mode frontmatter view;
 *  `fm` is the raw note frontmatter (for tags mode). */
export function detectKind(
  view: Record<string, unknown>,
  fm: Record<string, unknown> | null | undefined,
  cfg: DetectConfig,
): ExportableKind | null | "ambiguous" {
  if ((cfg.typeSource ?? "frontmatter") === "tags") return tagKind(extractTags(fm), cfg.tagPrefix ?? DEFAULT_TAG_PREFIX);
  return isExportableType(view.type) ? view.type : null;
}

export interface ExportOptions {
  outputDir: string;
  pluginName: string;
  pluginDescription?: string;
  fields?: DetectConfig;
  /** Root of a parallel filesystem tree holding skills' supporting files (see assets.ts).
   *  Empty/unset ⇒ no supporting files are bundled. */
  assetsRoot?: string;
  /** When set, write this version into the output's .claude-plugin/plugin.json
   *  (creating or updating it) — used by the release export. */
  version?: string;
  /** Test hook: overrides for iCloud materialization (downloader, poll, timeout). */
  assetOptions?: CollectAssetsOptions;
}

export interface ExportSummary {
  skills: number;
  agents: number;
  commands: number;
  assets: number;
  removed: number;
  warnings: string[];
  errors: string[];
  outputDir: string;
  /** Vault paths of every note transcluded into the exported output — the extra notes
   *  (beyond typed skill/agent/policy/command notes) whose edits should re-trigger an
   *  export-on-save (see main.ts). */
  sources: string[];
}

/** Extract link targets from a frontmatter `parent` value (string or list). */
function parentLinkpaths(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr.map(String)
    .map((s) => s.replace(/\[\[|\]\]/g, "").split("|")[0].split("#")[0].trim())
    .filter(Boolean);
}

/** Resolve each parent wikilink to a target note path; unresolved links get a marker
 *  that won't match any node (so the transform reports them as broken edges). */
function resolveParents(src: SkillsSource, sourcePath: string, v: unknown): string[] {
  return parentLinkpaths(v).map((lp) => src.resolveLink(lp, sourcePath) ?? `⟂unresolved:${lp}`);
}

// The vault-skills fields the transform reads (parent is handled separately, resolved to
// paths), plus the SKILL.md passthrough fields — all namespaced the same way.
const VS_FIELDS = [...new Set(["type", "root", "name", "id", "label", "description", "version", "tools", "model",
  "crosscutting", "slot", "severity", ...SKILL_PASSTHROUGH_FIELDS])];

/** Extract a bare view of the vault-skills fields (+ the raw parent value) per the field mode,
 *  so the pure transform stays namespace-agnostic. */
export function fieldView(fm: Record<string, unknown>, cfg: FieldConfig): { view: Record<string, unknown>; parent: unknown } {
  if (cfg.mode === "nested") {
    const nested = (fm[cfg.key] && typeof fm[cfg.key] === "object" ? fm[cfg.key] : {}) as Record<string, unknown>;
    return { view: nested, parent: nested.parent };
  }
  // prefix mode — a blank prefix yields bare top-level fields (type, parent, …)
  const view: Record<string, unknown> = {};
  for (const f of VS_FIELDS) view[f] = fm[cfg.prefix + f];
  return { view, parent: fm[cfg.prefix + "parent"] };
}

/** Collect every note marked a skill/agent/policy — by its `type:` field (frontmatter mode) or a
 *  `#{tagPrefix}{kind}` tag (tags mode). Ambiguous tag notes are skipped, reported via `warnings`.
 *  When `warnings` is given, `![[X]]` transclusions in note bodies are also resolved (inlined),
 *  resolution problems reported through the same sink; without it, bodies keep raw embed syntax
 *  (cheap mode for callers that only need the note list). Reads the vault only through `src`. */
export async function collectNotes(src: SkillsSource, fields: DetectConfig = DEFAULT_FIELDS, warnings?: string[]): Promise<NoteInput[]> {
  const notes: NoteInput[] = [];
  const resolve = warnings
    ? (body: string, from: string, sources: Set<string>) => resolveTransclusions(body, from, src.embed, warnings, sources)
    : null;
  for (const note of await src.notes()) {
    const fm = note.frontmatter;
    if (!fm) continue; // both modes key off frontmatter (type: field, or the note's tags: list)
    const { view, parent } = fieldView(fm, fields);
    const kind = detectKind(view, fm, fields);
    if (kind === "ambiguous") {
      warnings?.push(`${note.path}: multiple vault-skills kind tags — skipped (tag it as exactly one of skill/agent/policy)`);
      continue;
    }
    if (!kind) continue;
    let body = stripFrontmatter(note.body);
    const sources = new Set<string>();
    if (resolve) body = await resolve(body, note.path, sources);
    notes.push({
      // Copy the view (never mutate: in nested mode `view` is Obsidian's live cache object) and
      // normalize the kind into `type` so the transform + policy count read one source of truth.
      frontmatter: { ...view, type: kind },
      path: note.path,
      body,
      parentPaths: resolveParents(src, note.path, parent),
      sources: [...sources],
    });
  }
  return notes;
}

export async function runExport(src: SkillsSource, opts: ExportOptions): Promise<ExportSummary> {
  const { generated, warnings, errors, vaultPath } = await collectAndTransform(src, opts.fields ?? DEFAULT_FIELDS, opts.pluginName);

  ensurePluginManifest(opts.outputDir, opts.pluginName, opts.pluginDescription, opts.version);

  // Overwrite: remove previously-generated files (tracked in the manifest), then write.
  const manifestPath = path.join(opts.outputDir, MANIFEST_NAME);
  const prev = readManifestFiles(opts.outputDir);

  const files = outputFileSet(generated);

  // Supporting files: each skill note may have a parallel folder of assets (scripts,
  // references) that gets bundled into its generated skills/<name>/ dir. Asset trouble
  // (unreadable dir, iCloud timeout) degrades to a warning for that skill — it must
  // never abort the export. A file that fails to materialize keeps its previously
  // exported copy rather than having stale-cleanup delete it.
  const assetCopies: { src: string; relOut: string }[] = [];
  const retained: string[] = [];
  if (opts.assetsRoot) {
    for (const g of files) {
      if (g.kind !== "skill" || !g.from.endsWith(".md")) continue; // skip static/synthesized
      const dir = assetDirFor(opts.assetsRoot, g.from);
      const skillDir = path.dirname(g.relOut);
      try {
        const { files: assets, failed, warnings: assetWarnings } = await collectAssets(dir, opts.assetOptions);
        warnings.push(...assetWarnings);
        for (const a of assets) {
          if (a.rel === "SKILL.md") { warnings.push(`${dir}/SKILL.md: supporting file would overwrite the generated SKILL.md — skipped`); continue; }
          assetCopies.push({ src: a.abs, relOut: `${skillDir}/${a.rel}` });
        }
        for (const rel of failed) {
          const relOut = `${skillDir}/${rel}`;
          if (prev.includes(relOut)) {
            retained.push(relOut);
            warnings.push(`${relOut}: kept the previously exported copy`);
          }
        }
      } catch (e) {
        warnings.push(`${dir}: could not read supporting files — ${e instanceof Error ? e.message : String(e)}; skipped`);
      }
    }
  }

  const nextFiles = [...files.map((g) => g.relOut), ...assetCopies.map((a) => a.relOut), ...retained];
  const toRemove = prev.filter((p) => !nextFiles.includes(p));
  for (const rel of toRemove) {
    const abs = path.join(opts.outputDir, rel);
    try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
    const parent = path.dirname(abs);
    try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* ignore */ }
  }

  for (const g of files) {
    const abs = path.join(opts.outputDir, g.relOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, g.content);
  }
  for (const a of assetCopies) {
    try {
      copyAsset(a.src, path.join(opts.outputDir, a.relOut));
    } catch (e) {
      warnings.push(`${a.relOut}: copy failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedFrom: "obsidian-vault-skills",
    vault: vaultPath ?? null,
    count: nextFiles.length,
    files: nextFiles.sort(),
  }, null, 2) + "\n");

  return {
    skills: files.filter((g) => g.kind === "skill").length,
    agents: files.filter((g) => g.kind === "agent").length,
    commands: files.filter((g) => g.kind === "command").length,
    assets: assetCopies.length,
    removed: toRemove.length,
    warnings,
    errors,
    outputDir: opts.outputDir,
    sources: [...new Set(generated.flatMap((g) => g.sources ?? []))],
  };
}

export interface Analysis {
  tree: TreeNode[];
  errors: string[];
  warnings: string[];
  counts: { skills: number; agents: number; policies: number; commands: number };
}

/** Collected notes + transform result: the shared prologue for export, analyze, and preview,
 *  so the three surfaces can never disagree about the same vault. */
interface Compiled {
  notes: NoteInput[];
  vaultPath: string | undefined;
  generated: Generated[];
  tree: TreeNode[];
  policies: PolicyPlacement[];
  warnings: string[];
  errors: string[];
}

/** One emitted output file: a transform Generated or a shipped static. */
type OutputFile = Omit<Generated, "kind"> & { kind: EmittedKind | "hook" };

/** The complete file set an export writes — generated content plus shipped static skills
 *  (static wins on relOut collision). Shared by {@link runExport} and {@link previewVault}
 *  so the preview always describes exactly what the export would do. */
function outputFileSet(generated: Generated[]): OutputFile[] {
  const staticRelOuts = new Set(STATIC_FILES.map((s) => s.relOut));
  return [
    ...generated.filter((g) => !staticRelOuts.has(g.relOut)),
    ...STATIC_FILES.map((s): OutputFile => ({ kind: s.kind, relOut: s.relOut, content: s.content, from: "(static)" })),
  ];
}

async function collectAndTransform(src: SkillsSource, fields: DetectConfig, pluginName: string): Promise<Compiled> {
  const collectWarnings: string[] = [];
  const notes = await collectNotes(src, fields, collectWarnings);
  const vaultPath = src.basePath() ?? undefined;
  const result = transformAll(notes, { pluginName, synthesizeRoot: true, vaultPath });
  result.warnings.unshift(...collectWarnings);
  return { notes, vaultPath, ...result };
}

function countsOf(tree: TreeNode[], notes: NoteInput[]): Analysis["counts"] {
  return {
    agents: tree.filter((n) => n.kind === "agent").length,
    skills: tree.filter((n) => n.kind === "skill").length,
    policies: notes.filter((n) => n.frontmatter.type === "policy").length,
    commands: notes.filter((n) => n.frontmatter.type === "command").length,
  };
}

function readManifestFiles(outputDir: string): string[] {
  try { return JSON.parse(fs.readFileSync(path.join(outputDir, MANIFEST_NAME), "utf8")).files ?? []; } catch { return []; }
}

/** Shared read-only core for `validate` and `tree`: collect + transform, no write. */
export async function analyzeVault(src: SkillsSource, fields: DetectConfig = DEFAULT_FIELDS, pluginName = "vault-skills"): Promise<Analysis> {
  const c = await collectAndTransform(src, fields, pluginName);
  return { tree: c.tree, errors: c.errors, warnings: c.warnings, counts: countsOf(c.tree, c.notes) };
}

export type PreviewStatus = "added" | "modified" | "unchanged";

export interface PreviewEntry {
  kind: EmittedKind | "hook";
  relOut: string;
  from: string;
  /** Vault paths of notes transcluded into the source note's body — the other notes an
   *  edit to this compiled file's content might actually belong to. */
  sources?: string[];
  name?: string;
  description?: string;
  content: string;
  bytes: number;
  status: PreviewStatus;
  /** The currently exported content — present only when `status` is "modified". */
  cachedContent?: string;
}

export interface PreviewResult {
  tree: TreeNode[];
  entries: PreviewEntry[];
  /** Previously exported generated files no export would rewrite (would be deleted). */
  removed: string[];
  diff: { added: number; modified: number; unchanged: number; removed: number };
  policies: PolicyPlacement[];
  errors: string[];
  warnings: string[];
  counts: Analysis["counts"];
  outputDir: string;
  /** Bundled skill assets are excluded from the preview and from removal detection —
   *  collecting them can trigger iCloud materialization, a side effect preview must not have. */
  assetsNote: string;
}

/** Bundled skill assets live inside a skill's dir alongside its generated SKILL.md — the one
 *  manifest-tracked family the preview can't predict without collecting assets. */
const isAssetPath = (p: string): boolean => p.startsWith("skills/") && !/^skills\/[^/]+\/SKILL\.md$/.test(p);

/** Read-only preview: the exact file set an export would write (same collect + transform +
 *  static merge as {@link runExport}), each entry diffed against the current output dir.
 *  Never writes; never collects assets. */
export async function previewVault(
  src: SkillsSource,
  opts: { outputDir: string; pluginName: string; fields?: DetectConfig },
): Promise<PreviewResult> {
  const { notes, generated, tree, warnings, errors, policies } = await collectAndTransform(src, opts.fields ?? DEFAULT_FIELDS, opts.pluginName);

  const files = outputFileSet(generated);

  const entries: PreviewEntry[] = await Promise.all(files.map(async (g) => {
    let cached: string | null = null;
    try { cached = await fs.promises.readFile(path.join(opts.outputDir, g.relOut), "utf8"); } catch { /* not exported yet */ }
    const status: PreviewStatus = cached == null ? "added" : cached === g.content ? "unchanged" : "modified";
    return {
      kind: g.kind, relOut: g.relOut, from: g.from, name: g.name, description: g.description,
      ...(g.sources?.length ? { sources: g.sources } : {}),
      content: g.content, bytes: Buffer.byteLength(g.content), status,
      ...(status === "modified" ? { cachedContent: cached as string } : {}),
    };
  }));

  // Removal mirror of runExport's stale-cleanup: every manifest entry the export would no
  // longer write — including retired static files — except bundled assets, which the preview
  // can't predict (see assetsNote) and therefore never reports.
  const prev = readManifestFiles(opts.outputDir);
  const next = new Set(entries.map((e) => e.relOut));
  const removed = prev.filter((p) => !next.has(p) && !isAssetPath(p));

  return {
    tree, entries, removed,
    diff: {
      added: entries.filter((e) => e.status === "added").length,
      modified: entries.filter((e) => e.status === "modified").length,
      unchanged: entries.filter((e) => e.status === "unchanged").length,
      removed: removed.length,
    },
    policies, errors, warnings,
    counts: countsOf(tree, notes),
    outputDir: opts.outputDir,
    assetsNote: "bundled skill assets are not previewed",
  };
}

export interface MarkInput {
  type: "skill" | "agent" | "policy" | "command";
  parent?: string;      // agent basename or [[wikilink]]; empty ⇒ root
  description?: string;
  root?: boolean;
}

export interface MarkResult {
  /** Frontmatter keys to Object.assign onto the note (already namespaced per field mode). */
  set: Record<string, unknown>;
  /** Frontmatter keys to delete (already namespaced) — e.g. the tree-only fields when demoting a
   *  note to a flat command, so a stale `parent`/`root`/… doesn't linger as misleading metadata. */
  unset: string[];
  /** Kind tags (with a leading `#`) to append to the note's `tags` — non-empty only in tags mode. */
  addTags: string[];
  /** Kind tags (with a leading `#`) to strip from `tags` before appending — the whole
   *  `#{prefix}{kind}` family, so re-marking replaces the kind rather than adding a second one. */
  removeTags: string[];
}

/** Pure: how to mark a note as a given kind, honoring the field mode and detection mode. In tags
 *  mode the kind becomes a tag (`addTags`) instead of a `type:` field; parent/description/root
 *  stay frontmatter fields in both modes. Apply with {@link applyMark}. */
export function markFrontmatter(input: MarkInput, fields: DetectConfig = DEFAULT_FIELDS): MarkResult {
  const tagsMode = (fields.typeSource ?? "frontmatter") === "tags";
  const addTags: string[] = [];
  const removeTags: string[] = [];
  const flat: Record<string, unknown> = {};
  if (tagsMode) {
    const prefix = fields.tagPrefix ?? DEFAULT_TAG_PREFIX;
    addTags.push(`#${prefix}${input.type}`);
    // strip every sibling kind tag first, so re-marking swaps the kind (not two → "ambiguous")
    for (const k of EXPORTABLE_TYPES) removeTags.push(`#${prefix}${k}`);
  } else flat.type = input.type;
  const isCommand = input.type === "command";
  if (input.root) flat.root = true;
  // Commands are flat — a parent is meaningless, so never write one (and clear a stale one below).
  if (input.parent && !isCommand) flat.parent = input.parent.startsWith("[[") ? input.parent : `[[${input.parent}]]`;
  if (input.description) flat.description = input.description;

  let set: Record<string, unknown>;
  const unset: string[] = [];
  if (fields.mode === "nested") {
    // Nested mode replaces the whole object, so stale sub-fields drop on their own.
    set = Object.keys(flat).length ? { [fields.key]: flat } : {};
  } else {
    // prefix mode — a blank prefix yields bare top-level fields. Individual keys are set in place,
    // so demoting to a command must explicitly clear the tree-only fields it leaves behind.
    set = {};
    for (const [k, v] of Object.entries(flat)) set[fields.prefix + k] = v;
    if (isCommand) for (const k of ["parent", "root", "crosscutting", "slot"]) unset.push(fields.prefix + k);
  }
  return { set, unset, addTags, removeTags };
}

/** Apply a {@link markFrontmatter} result to a note's frontmatter object in place: assign the
 *  fields, then reconcile `tags` — strip the kind-tag family, then dedup-append the new kind tag
 *  (stored bare, without `#`, as Obsidian does). A scalar/string `tags` value is split the same
 *  way {@link extractTags} reads it, so pre-existing tags survive as distinct entries. */
export function applyMark(fm: Record<string, unknown>, result: MarkResult): void {
  Object.assign(fm, result.set);
  for (const k of result.unset ?? []) delete fm[k];
  const addTags = result.addTags ?? [];
  const removeTags = result.removeTags ?? [];
  if (!addTags.length && !removeTags.length) return;

  const raw = fm.tags;
  let existing: string[] =
    Array.isArray(raw) ? raw.map(String)
    : typeof raw === "string" ? raw.split(/[,\s]+/).filter(Boolean)
    : raw == null ? [] : [String(raw)];
  const bare = (t: string): string => t.replace(/^#/, "").toLowerCase();

  const remove = new Set(removeTags.map(bare));
  existing = existing.filter((t) => !remove.has(bare(t)));
  const have = new Set(existing.map(bare));
  for (const tag of addTags) {
    const b = tag.replace(/^#/, "");
    if (!have.has(b.toLowerCase())) {
      existing.push(b);
      have.add(b.toLowerCase());
    }
  }
  fm.tags = existing;
}

/** Make sure the output dir is a valid Claude Code plugin (create manifest if absent).
 *  When `version` is given (release export), set it on the manifest — creating the file
 *  or updating an existing one in place, preserving its other fields. */
function ensurePluginManifest(outputDir: string, name: string, description?: string, version?: string): void {
  const file = path.join(outputDir, ".claude-plugin", "plugin.json");
  if (fs.existsSync(file)) {
    if (!version) return;
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      // Never clobber a manifest we can't parse — its fields (description, author, …)
      // would be silently lost.
      throw new Error(`${file} is not valid JSON — fix or remove it, then re-run the release export`);
    }
    fs.writeFileSync(file, JSON.stringify({ name, ...manifest, version }, null, 2) + "\n");
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    name,
    description: description || `Skills and agents exported from an Obsidian vault by ${name}.`,
    version: version ?? "0.1.0",
  }, null, 2) + "\n");
}

/** Read the version from an existing plugin manifest (for suggesting the next release). */
export function readPluginVersion(outputDir: string): string | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(outputDir, ".claude-plugin", "plugin.json"), "utf8")).version;
    return typeof v === "string" ? v : undefined;
  } catch { return undefined; }
}
