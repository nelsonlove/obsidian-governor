// scope-tags.ts — the scope-tags VocabularyProvider: per-scope tag whitelists
// with chain inheritance, the vocab module's first live-generation provider
// (#251). Two independent gates, one inheritance rule, read straight off the
// vault's own declarations:
//
//   1. EXISTENCE — a tag exists iff a registry note declares it: a note whose
//      `fileClass` is the registry class (live default `Meta/Tag`), carrying
//      the canonical token in its `tag` field. Exact-match, deliberately NOT
//      prefix-permissive like the gen-old blueprint grammar — placement gets
//      the subtree semantics instead, which is safe precisely because
//      existence is gated separately.
//   2. PLACEMENT — each scope folder-note declares what it admits via
//      `allowedTags`; a note's effective set is the UNION of `allowedTags`
//      walking up its folder chain (band ← category ← area ← system root, the
//      root being a configured vault-root note, live default `The system.md`).
//      Subtree semantics: allowing `note` admits `note/task`,
//      `note/clipping/web`, … (Obsidian nested-tag behavior).
//
// Two deliberate live-model gates (2026-08-19, registry seeding deferred per
// Nelson — audit against the live model, never force it):
//   - UNSEEDED REGISTRY: zero registry notes ⇒ existence findings do not fire
//     (vacuously valid, the module's "no provider serving a kind" convention).
//     An unseeded registry is a reportable state — counts of 0 through
//     `obsidian_vocabularies` — not per-tag drift.
//   - UNDECLARED CHAIN: a note whose whole chain declares no `allowedTags` key
//     has the whitelist machinery not yet engaged — no placement findings. A
//     chain that declares the key (even as `[]`) is authoritative.
//
// Every vault-semantic value is CONFIG (ScopeTagsConfig) with today's live
// shapes as defaults — no hardwired vault constants. Kernel-module rules:
// pure, no `obsidian` imports, no I/O; the tool layer feeds the listing
// (visible-filtered before anything is read) and the provider never reads the
// vault itself. Report-first: findings are data; curation stays human.

import {
  VocabAmbiguousError,
  asStrings,
  type VocabCapabilities,
  type VocabEntry,
  type VocabFinding,
  type VocabKind,
  type VocabularyProvider,
} from "./provider.js";
import type { VocabNote } from "./blueprint.js";

export interface ScopeTagsConfig {
  /** The `fileClass` value that marks a tag-registry note. */
  registryClass: string;
  /** The frontmatter key on a registry note carrying the canonical token. */
  tagKey: string;
  /** The frontmatter key on a scope note carrying its whitelist. */
  allowedTagsKey: string;
  /** Vault-relative path of the root scope note (the vault-root "folder
   * note"); "" = no root scope note. */
  rootNote: string;
}

/** Today's live shapes (read from the vault 2026-08-19): `Meta/Tag` registry
 * notes with a `tag` field; `allowedTags` on `Scope/*` folder notes; the root
 * scope note `The system.md` at the vault root. */
export const DEFAULT_SCOPE_TAGS_CONFIG: ScopeTagsConfig = {
  registryClass: "Meta/Tag",
  tagKey: "tag",
  allowedTagsKey: "allowedTags",
  rootNote: "The system.md",
};

/** Settings hygiene, the scheme registry's pattern (`validateJdConfig`): a
 * problems list, empty when the config is usable. Unknown keys are ignored —
 * partial overrides deep-merge over the defaults. */
export function validateScopeTagsConfig(config: unknown): string[] {
  if (config === undefined) return [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be an object"];
  }
  const problems: string[] = [];
  const c = config as Record<string, unknown>;
  for (const key of ["registryClass", "tagKey", "allowedTagsKey"] as const) {
    if (key in c && c[key] !== undefined && (typeof c[key] !== "string" || (c[key] as string).trim() === "")) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  if ("rootNote" in c && c.rootNote !== undefined && typeof c.rootNote !== "string") {
    problems.push(`rootNote must be a string ("" for no root scope note)`);
  }
  return problems;
}

/** The provider plus the registry-level findings the whole-vault rule pack
 * needs (per-note findings ride the optional `noteFindings` seam every
 * provider may implement). */
export interface ScopeTagsProvider extends VocabularyProvider {
  /** `registry_entry_untagged` + `registry_duplicate` — findings about the
   * registry itself, independent of any note's use. */
  registryFindings(): VocabFinding[];
}

/** The type-bearing frontmatter key (an Obsidian/Fileclass convention, the
 * same constant findings.ts pins as TYPE_KEY — not a vault-semantic value). */
const CLASS_KEY = "fileClass";

const SUPERSEDED = /^\[superseded\]/i;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function underRoot(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

/** `[[A/B/Meta/Tag.md|alias]]` → `A/B/Meta/Tag`; plain values pass through
 * with any `.md` / `.fileclass` suffix dropped. */
function classInner(v: string): string {
  const inner = v.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  return inner.replace(/\.fileclass$/, "").replace(/\.md$/, "");
}

/** Does this note's `fileClass` name the registry class? Live notes write the
 * plain class path (`Meta/Tag`); a wikilinked full path matches by suffix. */
function isRegistryNote(fm: Record<string, unknown>, registryClass: string): boolean {
  return asStrings(fm[CLASS_KEY]).some((v) => {
    const inner = classInner(v);
    return inner === registryClass || inner.endsWith("/" + registryClass);
  });
}

/** Every folder above `path`, nearest first, ending with "" (the vault root):
 * `a/b/c.md` → ["a/b", "a", ""]. */
function chainFolders(path: string): string[] {
  const segs = path.split("/");
  segs.pop();
  const out: string[] = [];
  for (let n = segs.length; n >= 1; n--) out.push(segs.slice(0, n).join("/"));
  out.push("");
  return out;
}

/** The folder a note is the scope note OF: the configured root note speaks
 * for "" (the vault root), a folder note (`A/B/B.md`) for its folder. Null
 * for every other note — a stray `allowedTags` on a non-folder-note is not a
 * scope declaration. */
function scopeFolderOf(path: string, rootNote: string): string | null {
  if (rootNote !== "" && path === rootNote) return "";
  const i = path.lastIndexOf("/");
  if (i === -1) return null;
  const folder = path.slice(0, i);
  return path.slice(i + 1) === basename(folder) + ".md" ? folder : null;
}

/** Subtree semantics: `allowed` admits `tag` when it lists the tag itself or
 * any ancestor namespace. */
function admits(allowed: readonly string[], tag: string): boolean {
  return allowed.some((a) => tag === a || tag.startsWith(a + "/"));
}

export function scopeTagsProvider(cfg: ScopeTagsConfig, listing: VocabNote[]): ScopeTagsProvider {
  const capabilities: VocabCapabilities = {
    validate: true,
    resolveDefinition: true,
    hierarchical: true,
    deprecations: true,
  };

  const normalize = (raw: string): string => {
    const s = raw.trim();
    return s.startsWith("#") ? s.slice(1) : s;
  };

  // ── build: registry entries + scope whitelist map, one pass ────────────────
  const entries: VocabEntry[] = [];
  const untagged: string[] = [];
  /** scope folder → its declared (normalized) whitelist. Only folders whose
   * scope note DECLARES the key appear — presence is what engages the gate. */
  const allowedByFolder = new Map<string, string[]>();

  for (const note of listing) {
    const fm = note.frontmatter;
    if (!fm) continue;
    if (isRegistryNote(fm, cfg.registryClass)) {
      // Deduped per note: a list value repeating one token is a single
      // declaration, not a self-duplicate for `registry_duplicate` to report.
      const tokens = [...new Set(asStrings(fm[cfg.tagKey]).map(normalize).filter((t) => t !== ""))];
      if (tokens.length === 0) {
        untagged.push(note.path);
      } else {
        for (const canonical of tokens) {
          entries.push({
            canonical,
            kind: "tag",
            path: note.path,
            aliases: asStrings(fm.aliases),
            definition: typeof fm.description === "string" ? fm.description : null,
            parent: canonical.includes("/") ? canonical.split("/").slice(0, -1).join("/") : null,
            deprecated: fm.retired === true || fm.deprecated === true || SUPERSEDED.test(basename(note.path)),
          });
        }
      }
    }
    if (cfg.allowedTagsKey in fm) {
      const folder = scopeFolderOf(note.path, cfg.rootNote);
      if (folder !== null) {
        allowedByFolder.set(
          folder,
          asStrings(fm[cfg.allowedTagsKey]).map(normalize).filter((t) => t !== "")
        );
      }
    }
  }
  entries.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));

  const byToken = new Map<string, VocabEntry[]>();
  for (const e of entries) {
    const list = byToken.get(e.canonical) ?? [];
    list.push(e);
    byToken.set(e.canonical, list);
  }
  /** Registry notes exist at all — the seeded/unseeded switch. An untagged
   * registry note still counts as "the registry exists": its own finding
   * (`registry_entry_untagged`) is the actionable report there. */
  const seeded = entries.length > 0 || untagged.length > 0;

  /** The chain union for a note path: `declared` is whether ANY chain scope
   * note declares the whitelist key — undeclared means the placement gate is
   * not engaged for that note. */
  function chainUnion(notePath: string): { declared: boolean; allowed: string[] } {
    const allowed = new Set<string>();
    let declared = false;
    for (const folder of chainFolders(notePath)) {
      const declaredHere = allowedByFolder.get(folder);
      if (declaredHere === undefined) continue;
      declared = true;
      for (const t of declaredHere) allowed.add(t);
    }
    return { declared, allowed: [...allowed] };
  }

  // ── the VocabularyProvider surface ─────────────────────────────────────────

  function validateToken(rawToken: string, kind: VocabKind): VocabFinding[] {
    if (kind !== "tag") return [];
    if (!seeded) return []; // registry seeding deferred — reportable state, not per-tag drift
    const token = normalize(rawToken);
    const found = byToken.get(token) ?? [];
    if (found.length > 0) {
      if (found.every((e) => e.deprecated)) {
        return [
          {
            code: "deprecated",
            token,
            path: null,
            detail: `'${token}' (tag) is deprecated — declared at ${found.map((e) => e.path).join(", ")}`,
          },
        ];
      }
      return [];
    }
    return [
      {
        code: "tag_unregistered",
        token,
        path: null,
        detail: `'${token}' is not a registered tag — no ${cfg.registryClass} note declares it`,
      },
    ];
  }

  function resolve(rawToken: string, kind: VocabKind): VocabEntry | null {
    if (kind !== "tag") return null;
    const token = normalize(rawToken);
    const found = byToken.get(token) ?? [];
    if (found.length === 0) return null;
    if (found.length > 1) {
      throw new VocabAmbiguousError(token, "tag", found.map((e) => e.path ?? "<pathless>"));
    }
    return found[0];
  }

  function list(kind: VocabKind, scope?: string): VocabEntry[] {
    if (kind !== "tag") return [];
    if (scope === undefined || scope === "") return entries;
    return entries.filter((e) => e.path !== null && underRoot(e.path, scope));
  }

  /** Per-note findings beyond token validation (the `noteFindings` seam):
   * `tag_out_of_scope` for registered tags outside the note's chain union,
   * `allowedTags_unregistered` for a scope note whitelisting tokens the
   * registry does not declare. `tag_unregistered` arrives through the
   * ordinary token path (validateToken via findings.ts's check). */
  function noteFindings(note: { path: string; frontmatter: Record<string, unknown> | null }): VocabFinding[] {
    if (!seeded) return [];
    const fm = note.frontmatter;
    if (!fm) return [];
    const findings: VocabFinding[] = [];

    const { declared, allowed } = chainUnion(note.path);
    if (declared) {
      for (const raw of asStrings(fm.tags)) {
        const tag = normalize(raw);
        if (tag === "" || !byToken.has(tag)) continue; // unregistered is the other finding
        if (!admits(allowed, tag)) {
          findings.push({
            code: "tag_out_of_scope",
            token: tag,
            path: note.path,
            detail:
              `'${tag}' is registered but outside this note's scope chain — ` +
              (allowed.length > 0 ? `the chain admits: ${allowed.join(", ")}` : "the chain admits no tags"),
          });
        }
      }
    }

    if (cfg.allowedTagsKey in fm && scopeFolderOf(note.path, cfg.rootNote) !== null) {
      for (const raw of asStrings(fm[cfg.allowedTagsKey])) {
        const token = normalize(raw);
        if (token === "" || byToken.has(token)) continue;
        findings.push({
          code: "allowedTags_unregistered",
          token,
          path: note.path,
          detail: `this scope whitelists '${token}' but no ${cfg.registryClass} note declares it`,
        });
      }
    }
    return findings;
  }

  function registryFindings(): VocabFinding[] {
    const findings: VocabFinding[] = [];
    for (const path of untagged) {
      findings.push({
        code: "registry_entry_untagged",
        token: basename(path).replace(/\.md$/, ""),
        path,
        detail: `registry note declares no '${cfg.tagKey}' value — invisible to its own whitelist`,
      });
    }
    for (const [token, list] of byToken) {
      if (list.length < 2) continue;
      findings.push({
        code: "registry_duplicate",
        token,
        path: list[0].path,
        detail: `'${token}' is claimed by ${list.length} registry notes: ${list.map((e) => e.path).join(", ")}`,
      });
    }
    return findings;
  }

  return {
    capabilities,
    kinds: ["tag"],
    normalize,
    validateToken,
    resolve,
    list,
    noteFindings,
    registryFindings,
  };
}

/**
 * The whole-vault five-finding rule pack — deliberately NOT a tool (the
 * conformance convention: capabilities arrive as rule packs, never as new
 * surface; per-note lookups go through `obsidian_validate_terms`). Exactly the
 * five specced codes:
 *
 *   tag_unregistered · tag_out_of_scope · allowedTags_unregistered ·
 *   registry_entry_untagged · registry_duplicate
 */
export function scopeTagsFindings(
  notes: Array<{ path: string; frontmatter: Record<string, unknown> | null }>,
  provider: ScopeTagsProvider
): VocabFinding[] {
  const out: VocabFinding[] = [...provider.registryFindings()];
  for (const note of notes) {
    for (const raw of asStrings(note.frontmatter?.tags)) {
      const token = provider.normalize(raw);
      if (token === "") continue;
      out.push(
        ...provider
          .validateToken(token, "tag")
          .filter((f) => f.code === "tag_unregistered")
          .map((f) => ({ ...f, path: note.path }))
      );
    }
    out.push(...(provider.noteFindings?.(note) ?? []));
  }
  return out;
}
