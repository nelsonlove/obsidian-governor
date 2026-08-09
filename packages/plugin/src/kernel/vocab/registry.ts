// registry.ts — VocabRegistry: vocabulary-provider instances from settings.
//
// Mirrors the scope-provider's `schemes` settings shape: a `vocabularies`
// array of `{ id, provider, root, config }`. The registry owns the root
// confinement (it pre-filters the supplied listing before construction, so
// every provider sees only its own territory) and the settings hygiene:
// unknown provider names and duplicate ids are SKIPPED AND REPORTED via
// `problems`, never thrown — settings are user-edited, and one bad row must
// not take the whole vocabulary surface down.
//
// Kernel-module rules: pure, no `obsidian` imports. `build` is called by the
// tool layer with a fresh listing per call — providers are snapshots, not
// live indexes (the vocabulary is small and changes rarely; an index with
// event wiring is the uid store's problem, not this module's).

import { blueprintProvider, type VocabNote } from "./blueprint.js";
import { glossaryProvider, DEFAULT_GLOSSARY_CONFIG } from "./glossary.js";
import type { VocabularyProvider } from "./provider.js";

export interface VocabInstanceSettings {
  id: string;
  /** Provider name: "blueprint" (registry grammar) or "glossary" (terms). */
  provider: string;
  /** Vault-relative path prefix this vocabulary is read from; "" = whole vault. */
  root: string;
  config?: Record<string, unknown>;
}

export const DEFAULT_VOCABULARIES: VocabInstanceSettings[] = [
  {
    id: "registry",
    provider: "blueprint",
    // The post-consolidation registries slot (2026-08-09). Settings-overridable;
    // never gen3 — that tree was emptied by the move.
    root: "00-09 System/00 System management/00.05 Registries for the system",
  },
  // termsRoot is read by the TOOL layer (it decides which bodies to read for
  // `## Terms` sections); the provider itself parses whatever bodies arrive.
  { id: "glossary", provider: "glossary", root: "", config: { termsRoot: "Assent" } },
];

export interface VocabInstance {
  id: string;
  providerName: string;
  root: string;
  provider: VocabularyProvider;
}

function underRoot(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

export class VocabRegistry {
  readonly problems: string[] = [];
  private readonly rows: VocabInstanceSettings[] = [];

  constructor(settings: VocabInstanceSettings[]) {
    const seen = new Set<string>();
    for (const row of settings) {
      if (seen.has(row.id)) {
        this.problems.push(`duplicate vocabulary id '${row.id}' — first declaration wins`);
        continue;
      }
      if (row.provider !== "blueprint" && row.provider !== "glossary") {
        this.problems.push(`unknown vocabulary provider '${row.provider}' (id '${row.id}') — skipped`);
        continue;
      }
      seen.add(row.id);
      this.rows.push(row);
    }
  }

  /** Provider instances over `listing`, one per configured vocabulary, each
   * confined to its own root. */
  build(listing: VocabNote[]): VocabInstance[] {
    return this.rows.map((row) => {
      const scoped = listing.filter((n) => underRoot(n.path, row.root));
      const provider =
        row.provider === "blueprint"
          ? blueprintProvider({ root: "" }, scoped)
          : glossaryProvider({ ...DEFAULT_GLOSSARY_CONFIG, ...(row.config ?? {}) } as { definitionTag: string }, scoped);
      return { id: row.id, providerName: row.provider, root: row.root, provider };
    });
  }
}
