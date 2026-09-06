// blueprint.ts — the registry-blueprint VocabularyProvider: the TS port of the
// vault's registry grammar, over a supplied note listing.
//
// The grammar is ported from the vault's own machinery and must stay in
// agreement with BOTH of its expressions:
//   - `tag-macros.blueprint` `tag_for()` / `parent_for()` (nunjucks): tag
//     notes are `<name>.tag.md`; `.tag`-suffixed parent folders are namespace
//     segments; a folder note (leaf == folder name) collapses to the
//     namespace itself and is its own parent (= a root).
//   - `drift_audit.py` `registered_tags()` / `tag_allowed()` (python): the
//     same walk, plus PREFIX-PERMISSIVE validation — a namespaced use
//     `meta/type` is allowed when any ancestor (`meta`) is registered.
// Properties are flat `<key>.property.md` entries. Types are `<Name>.fileclass`
// files (the `.type.md` layer collapsed 2026-08-07): `extends` is the parent
// edge, `retired: true` marks deprecation, `description` is the gloss.
//
// Kernel-module rules: pure, no `obsidian` imports, no I/O. The tool layer
// supplies the listing; `.fileclass` files are not markdown, so Obsidian's
// metadata cache cannot supply their frontmatter — entries may instead carry a
// raw `body`, and the minimal frontmatter scan below (same spirit as
// drift_audit's `fm`/`fm_list` regexes, not a YAML parser) extracts the few
// keys the vocabulary needs.

// Relative, not `@vault-mcp/core`: since the vocab kernel was published INTO
// core (suite split, S7) this file IS core, and a package importing its own
// name resolves through `dist/` — which would make the build depend on the
// previous build's bytes.
import { leadingFrontmatterBlock } from "../accept-guard.js";
import {
  VocabAmbiguousError,
  type VocabCapabilities,
  type VocabEntry,
  type VocabFinding,
  type VocabKind,
  type VocabularyProvider,
} from "./provider.js";

/** One note of the supplied listing. `frontmatter` comes from the host's
 * metadata cache when the note is markdown; `body` covers the rest
 * (`.fileclass` files, glossary chapters). */
export interface VocabNote {
  path: string;
  frontmatter?: Record<string, unknown> | null;
  body?: string | null;
}

export interface BlueprintConfig {
  /** Vault-relative path prefix the registry lives under; "" = whole listing. */
  root: string;
}

// ── minimal frontmatter scan ─────────────────────────────────────────────────

/** The leading `---` block of `body`, as key → scalar-or-list. Deliberately
 * minimal: `key: value` lines and `key:\n  - item` block lists, quotes
 * stripped — the registry keys this module reads are all that shape. The
 * BLOCK is found by the shared recognizer in @vault-mcp/core (#189), not a
 * local `/^---\n/` copy, so a BOM- or CRLF-authored `.fileclass` definition is
 * read rather than silently skipped; the line split is universal-newline for
 * the same reason. LF-authored input parses byte-identically. */
export function scanFrontmatter(body: string): Record<string, unknown> {
  const block = leadingFrontmatterBlock(body);
  if (block === null) return {};
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w -]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest !== "") {
      out[key] = unquote(rest);
      continue;
    }
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const item = lines[i + 1].match(/^\s+-\s+(.*)$/);
      if (!item) break;
      items.push(String(unquote(item[1].trim())));
      i++;
    }
    out[key] = items;
  }
  return out;
}

function unquote(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  const q = v.match(/^"(.*)"$/) ?? v.match(/^'(.*)'$/);
  return q ? q[1] : v;
}

/** `[[A/B/Name.fileclass|alias]]` → `Name`; a plain value passes through with
 * any `.fileclass` suffix dropped. The registry names its `extends` target by
 * wikilink, and Obsidian resolves those by basename — so does this. */
function wikiBasename(v: string): string {
  const inner = v.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  const base = inner.split("/").pop() ?? inner;
  return base.replace(/\.fileclass$/, "");
}

// ── entry derivation ─────────────────────────────────────────────────────────

const SUPERSEDED = /^\[superseded\]/i;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function underRoot(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

/** The tag a `<…>.tag.md` path registers — `tag_for()` ported. */
function tagOf(path: string): string {
  const segments = path.split("/");
  const leaf = basename(path).slice(0, -".tag.md".length);
  const ns = segments
    .slice(0, -1)
    .filter((s) => s.endsWith(".tag"))
    .map((s) => s.slice(0, -".tag".length));
  if (ns.length > 0 && ns[ns.length - 1] === leaf) return ns.join("/");
  return [...ns, leaf].join("/");
}

function entryCommon(
  note: VocabNote,
  fm: Record<string, unknown>
): Pick<VocabEntry, "aliases" | "definition" | "deprecated"> {
  const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : [];
  const definition = typeof fm.description === "string" ? fm.description : null;
  const deprecated = fm.retired === true || fm.deprecated === true || SUPERSEDED.test(basename(note.path));
  return { aliases, definition, deprecated };
}

function buildEntries(cfg: BlueprintConfig, listing: VocabNote[]): VocabEntry[] {
  const entries: VocabEntry[] = [];
  for (const note of listing) {
    if (!underRoot(note.path, cfg.root)) continue;
    const name = basename(note.path);
    const fm = note.frontmatter ?? (note.body ? scanFrontmatter(note.body) : {});
    if (name.endsWith(".tag.md")) {
      const canonical = tagOf(note.path);
      const parent = canonical.includes("/") ? canonical.split("/").slice(0, -1).join("/") : null;
      entries.push({ canonical, kind: "tag", path: note.path, parent, ...entryCommon(note, fm) });
    } else if (name.endsWith(".property.md")) {
      const canonical = name.slice(0, -".property.md".length);
      entries.push({ canonical, kind: "property", path: note.path, parent: null, ...entryCommon(note, fm) });
    } else if (name.endsWith(".fileclass")) {
      const canonical = name.slice(0, -".fileclass".length);
      const parent = typeof fm.extends === "string" ? wikiBasename(fm.extends) : null;
      entries.push({ canonical, kind: "type", path: note.path, parent, ...entryCommon(note, fm) });
    }
  }
  return entries.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));
}

// ── the provider ─────────────────────────────────────────────────────────────

const KINDS: VocabKind[] = ["tag", "property", "type"];

const UNKNOWN_CODE = {
  tag: "unregistered_tag",
  property: "undefined_property",
  type: "unknown_type",
} as const;

export function blueprintProvider(cfg: BlueprintConfig, listing: VocabNote[]): VocabularyProvider {
  const capabilities: VocabCapabilities = {
    validate: true,
    resolveDefinition: true,
    hierarchical: true,
    deprecations: true,
  };
  const entries = buildEntries(cfg, listing);
  const byKind = new Map<VocabKind, VocabEntry[]>(KINDS.map((k) => [k, entries.filter((e) => e.kind === k)]));
  const registeredTags = new Set((byKind.get("tag") ?? []).map((e) => e.canonical));

  function normalize(raw: string): string {
    const s = raw.trim();
    return s.startsWith("#") ? s.slice(1) : s;
  }

  function candidates(token: string, kind: VocabKind): VocabEntry[] {
    return (byKind.get(kind) ?? []).filter((e) => e.canonical === token);
  }

  /** `tag_allowed()` ported: the tag itself, or any ancestor namespace,
   * is registered. */
  function tagAllowed(tag: string): boolean {
    if (registeredTags.has(tag)) return true;
    const parts = tag.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (registeredTags.has(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  }

  function validateToken(rawToken: string, kind: VocabKind): VocabFinding[] {
    if (!KINDS.includes(kind)) return [];
    const token = normalize(rawToken);
    const found = candidates(token, kind);
    if (found.length > 0) {
      if (found.every((e) => e.deprecated)) {
        return [
          {
            code: "deprecated",
            token,
            path: null,
            detail: `'${token}' (${kind}) is deprecated — declared at ${found.map((e) => e.path).join(", ")}`,
          },
        ];
      }
      return [];
    }
    if (kind === "tag" && tagAllowed(token)) return [];
    return [
      {
        code: UNKNOWN_CODE[kind as keyof typeof UNKNOWN_CODE],
        token,
        path: null,
        detail: `'${token}' is not a registered ${kind}`,
      },
    ];
  }

  function resolve(rawToken: string, kind: VocabKind): VocabEntry | null {
    if (!KINDS.includes(kind)) return null;
    const token = normalize(rawToken);
    const found = candidates(token, kind);
    if (found.length === 0) return null;
    if (found.length > 1) {
      throw new VocabAmbiguousError(token, kind, found.map((e) => e.path ?? "<pathless>"));
    }
    return found[0];
  }

  function list(kind: VocabKind, scope?: string): VocabEntry[] {
    const all = byKind.get(kind) ?? [];
    if (scope === undefined || scope === "") return all;
    return all.filter((e) => e.path !== null && underRoot(e.path, scope));
  }

  return { capabilities, kinds: KINDS, normalize, validateToken, resolve, list };
}
