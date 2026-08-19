// The vocabulary registry's read surface: four tools, all read-only.
//
//   obsidian_vocabularies    — enumerate configured vocab sources
//   obsidian_resolve_term    — token → entry; path → its terms; parse mode
//   obsidian_validate_terms  — one note's frontmatter → findings
//   obsidian_list_vocabulary — entries of a kind, optionally scoped
//
// The vocab counterpart of tools-uid.ts / the scheme tools: where the scope
// provider answers "where does this note live", this answers "is this tag /
// property / type / term a registered one, and what does it mean". Validation
// and resolution only — nothing here mutates a note, and `findings.ts` (the
// whole-vault rule pack) is deliberately NOT registered: capabilities arrive
// as rule packs, never as new surface.
//
// Allowlist rule (the read-boundary rule, slice 3.0): the LISTING is filtered
// through `visiblePaths` BEFORE any provider is constructed, so a hidden
// registry entry is never read, never counted, never named — no path oracle,
// and the counts/examples a sandboxed session sees are its own visible
// cardinality, like the uid totals. Single-path arguments refuse coded
// (`out_of_allowlist`), the tools-links precedent.
//
// Imports nothing from `obsidian`: vault state arrives through the injected
// VocabSource (structurally typed, like LinkSource), so every handler is
// unit-testable headlessly.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, codedError } from "./helpers.js";
import { visiblePaths, isVisible, type GuardSettings } from "../guard.js";
import {
  asStrings,
  VocabAmbiguousError,
  noteVocabFindings,
  VocabRegistry,
  DEFAULT_VOCABULARIES,
  type VocabEntry,
  type VocabFinding,
  type VocabInstance,
  type VocabInstanceSettings,
  type VocabKind,
  type VocabNote,
} from "../kernel/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const KINDS = ["tag", "property", "type", "term"] as const;
const KindSchema = z.enum(KINDS);

export interface VocabToolsCtx {
  /** The guard's settings — the allowlist filter. Absent ⇒ unfiltered. */
  getSettings?: () => GuardSettings;
  /** The `vocabularies` settings array. Absent ⇒ the defaults. */
  getVocabularies?: () => VocabInstanceSettings[];
}

/** Vault state, injected. Typed structurally (not against `App`) so this file
 * imports nothing from `obsidian` — the live adapter is `obsidianVocabSource`,
 * a test hands over a plain object. */
export interface VocabSource {
  /** Every file path in the vault — ALL files, not only markdown: type
   * entries are `.fileclass` files. Enumeration only. */
  paths(): string[];
  /** Frontmatter of a markdown note, from the host's metadata cache. */
  frontmatter(path: string): Record<string, unknown> | null;
  /** Raw content of any file (for `.fileclass` frontmatter and `## Terms`
   * sections — the two shapes the metadata cache cannot serve). */
  body(path: string): Promise<string | null>;
}

/** The adapter over Obsidian's vault and metadata cache. */
export function obsidianVocabSource(app: {
  vault: {
    getFiles(): Array<{ path: string }>;
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
  };
  metadataCache: { getCache(path: string): { frontmatter?: Record<string, unknown> } | null };
}): VocabSource {
  return {
    paths: () => app.vault.getFiles().map((f) => f.path),
    frontmatter: (path) => app.metadataCache.getCache(path)?.frontmatter ?? null,
    body: async (path) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) return null;
      try {
        return await app.vault.cachedRead(file);
      } catch {
        return null;
      }
    },
  };
}

// ── listing construction ─────────────────────────────────────────────────────

const REGISTRY_SUFFIXES = [".tag.md", ".property.md", ".fileclass"];

function under(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

/**
 * The notes the configured vocabularies need, visible-filtered BEFORE any
 * content is touched. Body reads are confined to what actually needs one:
 * `.fileclass` files under a blueprint root, and markdown under a glossary's
 * `termsRoot` (the `## Terms` chapters) — never the whole vault.
 */
async function buildListing(
  source: VocabSource,
  rows: VocabInstanceSettings[],
  visible: (paths: string[]) => string[]
): Promise<VocabNote[]> {
  const all = visible(source.paths());
  const wanted = new Map<string, { fm: boolean; body: boolean }>();
  const want = (path: string, part: "fm" | "body") => {
    const w = wanted.get(path) ?? { fm: false, body: false };
    w[part === "fm" ? "fm" : "body"] = true;
    wanted.set(path, w);
  };

  for (const row of rows) {
    if (row.provider === "blueprint") {
      for (const p of all) {
        if (!under(p, row.root)) continue;
        if (p.endsWith(".fileclass")) want(p, "body");
        else if (REGISTRY_SUFFIXES.some((s) => p.endsWith(s))) want(p, "fm");
      }
    } else if (row.provider === "glossary") {
      const termsRoot = typeof row.config?.termsRoot === "string" ? row.config.termsRoot : null;
      for (const p of all) {
        if (!p.endsWith(".md")) continue;
        if (under(p, row.root)) want(p, "fm");
        if (termsRoot !== null && under(p, termsRoot) && under(p, row.root)) want(p, "body");
      }
    } else if (row.provider === "scope-tags") {
      // Registry notes (`fileClass: Meta/Tag`) and scope folder-notes are
      // recognized by FRONTMATTER, which only the provider can inspect — so
      // every markdown note under the root arrives with its cached
      // frontmatter. No body is ever read: this provider needs none.
      for (const p of all) {
        if (p.endsWith(".md") && under(p, row.root)) want(p, "fm");
      }
    }
  }

  const listing: VocabNote[] = [];
  for (const [path, w] of wanted) {
    listing.push({
      path,
      frontmatter: w.fm ? source.frontmatter(path) : null,
      body: w.body ? await source.body(path) : null,
    });
  }
  return listing;
}

// ── the tools ────────────────────────────────────────────────────────────────

type Resolved = { entry: VocabEntry; vocabulary: string };

export function registerVocabTools(server: McpServer, source: VocabSource, ctx: VocabToolsCtx): void {
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());
  const rows = (): VocabInstanceSettings[] => ctx.getVocabularies?.() ?? DEFAULT_VOCABULARIES;

  async function instances(): Promise<{ registry: VocabRegistry; instances: VocabInstance[] }> {
    const registry = new VocabRegistry(rows());
    const listing = await buildListing(source, rows(), visible);
    return { registry, instances: registry.build(listing) };
  }

  /** Every sense of `token` across instances and kinds. Throws the FIRST
   * VocabAmbiguousError — an instance that already refuses to pick is an
   * answer, not an input. */
  function sensesOf(all: VocabInstance[], token: string, kinds: readonly VocabKind[]): Resolved[] {
    const out: Resolved[] = [];
    for (const inst of all) {
      for (const kind of kinds) {
        if (!inst.provider.kinds.includes(kind)) continue;
        const entry = inst.provider.resolve(token, kind);
        if (entry) out.push({ entry, vocabulary: inst.id });
      }
    }
    return out;
  }

  server.registerTool(
    "obsidian_vocabularies",
    {
      title: "List configured vocabularies",
      description:
        "Enumerate the configured controlled-vocabulary sources: id, provider, root, capabilities, per-kind entry " +
        "counts and a few example tokens. The discoverability entry point for the vocabulary tools — call this first " +
        "to learn what kinds (tag / property / type / term) this vault's vocabulary actually serves.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const { registry, instances: all } = await instances();
        return ok({
          vocabularies: all.map((inst) => ({
            id: inst.id,
            provider: inst.providerName,
            root: inst.root,
            capabilities: inst.provider.capabilities,
            kinds: inst.provider.kinds,
            counts: Object.fromEntries(inst.provider.kinds.map((k) => [k, inst.provider.list(k).length])),
            examples: Object.fromEntries(
              inst.provider.kinds.map((k) => [k, inst.provider.list(k).slice(0, 3).map((e) => e.canonical)])
            ),
          })),
          problems: registry.problems,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_resolve_term",
    {
      title: "Resolve a vocabulary token",
      description:
        "Look up the controlled vocabulary. Give `token` (with optional `kind`) to resolve it to its canonical entry — " +
        "definition, aliases, hierarchy, deprecation. Give `path` to report a note's own vocabulary (its tags, " +
        "properties and types), each resolved. Give `token` with `parse: true` to validate only. A token with more " +
        "than one sense refuses to pick, naming every candidate — like uid resolution.",
      inputSchema: {
        token: z.string().min(1).optional().describe("A vocabulary token: a tag, property key, type name, or term."),
        kind: KindSchema.optional().describe("Narrow the lookup to one kind; omitted, every kind is searched."),
        path: z.string().min(1).optional().describe("A vault-relative note path to report the vocabulary OF."),
        parse: z.boolean().optional().describe("With `token`: validate only, resolve nothing."),
        vocabulary: z.string().min(1).optional().describe("Narrow to one configured vocabulary id."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        if (args.token && args.path) {
          return fail(new Error("give `token` or `path`, not both — they are two directions of one lookup"));
        }
        if (!args.token && !args.path) {
          return fail(new Error("give `token` (with optional `kind`) or `path`"));
        }
        const { instances: allInstances } = await instances();
        const all = args.vocabulary ? allInstances.filter((i) => i.id === args.vocabulary) : allInstances;
        const kinds: readonly VocabKind[] = args.kind ? [args.kind] : KINDS;

        if (args.path) {
          if (!isVisible(args.path, ctx.getSettings?.())) {
            return codedError("out_of_allowlist", `'${args.path}' is outside this session's allowlist`);
          }
          const fm = source.frontmatter(args.path);
          const terms: Array<Record<string, unknown>> = [];
          const report = (token: string, kind: VocabKind) => {
            try {
              const senses = sensesOf(all, token, [kind]);
              terms.push({
                token,
                kind,
                found: senses.length > 0,
                ...(senses.length === 1
                  ? {
                      canonical: senses[0].entry.canonical,
                      vocabulary: senses[0].vocabulary,
                      definition: senses[0].entry.definition,
                      deprecated: senses[0].entry.deprecated,
                    }
                  : {}),
                ...(senses.length > 1 ? { ambiguous: true } : {}),
              });
            } catch (e) {
              if (!(e instanceof VocabAmbiguousError)) throw e;
              terms.push({ token, kind, found: true, ambiguous: true });
            }
          };
          for (const t of asStrings(fm?.tags)) report(t.trim(), "tag");
          for (const key of Object.keys(fm ?? {})) if (key !== "fileClass") report(key, "property");
          const classes = asStrings(fm?.fileClass);
          for (const c of classes) {
            const inner = c.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
            report((inner.split("/").pop() ?? inner).replace(/\.fileclass$/, ""), "type");
          }
          return ok({ path: args.path, terms });
        }

        if (args.parse) {
          // No configured vocabulary serving the kind ⇒ vacuously valid, the
          // same convention findings.ts pins ("no providers serving a kind
          // means no findings") — never `valid: false` with zero findings.
          let findings: VocabFinding[] | null = null;
          for (const kind of kinds) {
            for (const inst of all) {
              if (!inst.provider.kinds.includes(kind)) continue;
              const f = inst.provider.validateToken(args.token as string, kind);
              if (f.length === 0) return ok({ token: args.token, valid: true, findings: [] });
              findings = findings ?? f;
            }
          }
          return ok({ token: args.token, valid: findings === null, findings: findings ?? [] });
        }

        let senses: Resolved[];
        try {
          senses = sensesOf(all, args.token as string, kinds);
        } catch (e) {
          if (!(e instanceof VocabAmbiguousError)) throw e;
          return codedError("vocab_ambiguous", e.message);
        }
        if (senses.length === 0) return ok({ token: args.token, found: false });
        if (senses.length > 1) {
          const named = senses.map((s) => `${s.entry.canonical} (${s.entry.kind}, ${s.vocabulary}: ${s.entry.path ?? "<pathless>"})`);
          return codedError(
            "vocab_ambiguous",
            `'${args.token}' has ${senses.length} senses — refusing to pick: ${named.join(", ")}`
          );
        }
        return ok({ token: args.token, found: true, vocabulary: senses[0].vocabulary, entry: senses[0].entry });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_validate_terms",
    {
      title: "Validate a note's vocabulary",
      description:
        "Check one note's frontmatter against the controlled vocabulary, per the configured providers: unregistered " +
        "tags (exact-match under the default scope-tags model; namespace-permissive under the legacy blueprint " +
        "grammar), tags outside the note's scope-chain whitelist, unregistered whitelist entries on a scope note, " +
        "undefined properties, unknown or retired types, ambiguous senses. Report-only — findings are returned, " +
        "never fixed, and nothing is written.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path to validate."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        if (!isVisible(args.path, ctx.getSettings?.())) {
          return codedError("out_of_allowlist", `'${args.path}' is outside this session's allowlist`);
        }
        const { instances: all } = await instances();
        const findings = noteVocabFindings(
          { path: args.path, frontmatter: source.frontmatter(args.path) },
          all.map((i) => i.provider)
        );
        return ok({ path: args.path, findings, clean: findings.length === 0 });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_list_vocabulary",
    {
      title: "List a vocabulary kind",
      description:
        "Enumerate the registered vocabulary of one kind (tag / property / type / term), sorted, each entry naming " +
        "the vocabulary that declares it. `scope` confines the listing to entries declared under a path prefix; " +
        "`vocabulary` narrows to one configured source.",
      inputSchema: {
        kind: KindSchema.describe("Which vocabulary kind to list."),
        scope: z.string().optional().describe("Only entries declared under this vault-relative path prefix."),
        vocabulary: z.string().min(1).optional().describe("Narrow to one configured vocabulary id."),
      },
      annotations: RO,
    },
    async (args) => {
      try {
        const { instances: allInstances } = await instances();
        const all = args.vocabulary ? allInstances.filter((i) => i.id === args.vocabulary) : allInstances;
        const entries = all
          .flatMap((inst) => inst.provider.list(args.kind, args.scope).map((e) => ({ ...e, vocabulary: inst.id })))
          .sort((a, b) => a.canonical.toLowerCase().localeCompare(b.canonical.toLowerCase()));
        return ok({ kind: args.kind, count: entries.length, entries });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
