# Vocabulary provider — controlled vocabulary (read-only)

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


The vocabulary provider is a [capability module](module-system.md) (id `vocab`, capabilities
`["vocabulary"]`) that lets an agent **check a note's tags, properties, types, and glossary
terms against the vault's controlled vocabulary** — and validate them **without writing
anything**. Validation and resolution only; nothing here mutates a note.

Files: `packages/plugin/src/mcp/tools-vocab.ts` (tools),
`packages/plugin/src/kernel/vocab/` (the pure engine: `provider.ts`, `registry.ts`,
`blueprint.ts`, `glossary.ts`, `scope-tags.ts`, `findings.ts`). Obsidian-import-free; the vault
reader arrives as an injected `VocabSource` exposing only `paths()` / `frontmatter()` /
`body()` — enumeration and reads, structurally no write reach.

## What it validates

Four kinds — `VocabKind = "tag" | "property" | "type" | "term"` — served by three providers:

- **scope-tags** (`scope-tags.ts`, #251) serves **`tag`** — the live per-scope whitelist model,
  two independent gates over the vault's own declarations:
  1. *existence* — a tag exists iff a registry note (`fileClass: Meta/Tag`, canonical token in
     its `tag` field) declares it; exact-match, deliberately not prefix-permissive;
  2. *placement* — each scope folder-note declares what it admits via `allowedTags`, and a
     note's effective set is the **union walking up its folder chain** (band ← category ← area
     ← the root scope note, live default `The system.md`), with subtree semantics: allowing
     `note` admits `note/task`, `note/clipping/web`, ….

  Every vault-semantic value is config (`ScopeTagsConfig`: `registryClass`, `tagKey`,
  `allowedTagsKey`, `rootNote`) with today's live shapes as defaults, validated per-provider by
  the registry (invalid config skips that one instance and reports). Two deliberate gates match
  the live rollout state: an **unseeded registry** (zero registry notes) forces no per-tag
  findings — a reportable state (counts of 0), not drift — and a note whose chain declares no
  `allowedTags` key has placement un-engaged, while a declared-empty whitelist is authoritative.
- **blueprint** (`blueprint.ts`) serves **`tag`**, **`property`**, **`type`** in the *gen-old
  registry grammar*: tags from `<name>.tag.md` notes (namespace-prefix permissive), properties
  from flat `<key>.property.md`, types from `<Name>.fileclass` files (`extends` = parent,
  `retired: true` = deprecated). No longer in the shipped defaults (that grammar has no live
  surface); available via settings.
- **glossary** (`glossary.ts`) serves **`term`**: definition notes tagged `note/definition`
  (term = `title`, gloss = `description`) and `## Terms` sections of `- **term** — definition`
  bullets.

The registry (`VocabRegistry`) skip-and-reports duplicate ids, unknown providers, and invalid
per-provider configs into a `problems` array (it never throws), reserving an id before the
provider check. Shipped defaults (corrected 2026-08-19): one `scope-tags` instance over the
whole vault, one `glossary` with `termsRoot` at the framework document's live slot
(the vault's `00.89 obsidian-governor` folder — renamed from its former `Assent`
name on 2026-08-19, which the default was corrected to follow).

## The four tools

All read-only (`readOnlyHint: true`), registered through the module registry.

| Tool | Input | Returns |
| --- | --- | --- |
| **`obsidian_vocabularies`** | *(none)* | `{ vocabularies: [{ id, provider, root, capabilities, kinds, counts, examples }], problems }` — every configured vocabulary, its served kinds, per-kind counts and examples. |
| **`obsidian_resolve_term`** | `token?` **xor** `path?`; plus `kind?` (`tag`\|`property`\|`type`\|`term`), `parse?`, `vocabulary?` | `token` → `{ token, found, vocabulary, entry }` (one sense) or `{ found:false }`; `token` + `parse:true` → `{ token, valid, findings }` (validate-only); `path` → `{ path, terms:[{ token, kind, found, canonical?, vocabulary?, definition?, deprecated?, ambiguous? }] }` (the note's own tags/properties/types). |
| **`obsidian_validate_terms`** | `path` | `{ path, findings, clean }` — the note's vocabulary findings. Report-only; findings are returned, never fixed, nothing is written. |
| **`obsidian_list_vocabulary`** | `kind`, `scope?`, `vocabulary?` | `{ kind, count, entries }` — every registered term of that kind, case-insensitively sorted, each carrying its `vocabulary` id. |

### Error codes and finding shapes

Coded tool errors (`Error [code]: …`):

- **`out_of_allowlist`** — a `path` argument outside the session's allowlist
  (`obsidian_resolve_term` path branch, `obsidian_validate_terms`).
- **`vocab_ambiguous`** — a token with more than one sense across kinds; the resolver refuses to
  pick and names the candidates (`obsidian_resolve_term` token branch).

Finding codes (`VocabFinding.code`, shape `{ code, token, path, detail }`):

```
unregistered_tag | undefined_property | unknown_type | unknown_term
deprecated | ambiguous | malformed_token
tag_unregistered | tag_out_of_scope | allowedTags_unregistered
registry_entry_untagged | registry_duplicate
```

blueprint maps an unknown-per-kind token to `unregistered_tag` / `undefined_property` /
`unknown_type`; glossary emits `unknown_term` / `deprecated`; the whole-note rule pack
(`findings.ts`) adds `malformed_token` (e.g. a whitespace tag) and `ambiguous`; the last five
are the scope-tags provider's pack (below).

## Read-only, and the findings rule packs

Every tool is `readOnlyHint: true` and the module has no write path. `findings.ts`
(`noteVocabFindings` — the pure whole-note rule pack) is exposed for a single named note through
`obsidian_validate_terms` but is **not registered as its own tool**: capabilities arrive as rule
packs, never as new mutating surface. Deciding whether an unregistered tag *should* be added to
the vocabulary, or a note re-tagged, is a decision the tool **names for you** — it never takes
it.

The scope-tags provider adds its **five-finding whole-vault rule pack** (`scopeTagsFindings` in
`scope-tags.ts` — also not a tool; rail material):

- `tag_unregistered` — a note carries a tag no registry note declares
- `tag_out_of_scope` — registered, but outside the note's chain union
- `allowedTags_unregistered` — a scope whitelists a tag that isn't in the registry
- `registry_entry_untagged` — a registry note with an empty/missing `tag` field
- `registry_duplicate` — two registry notes claiming one token

Per-note, `tag_out_of_scope` and `allowedTags_unregistered` also surface through
`obsidian_validate_terms` via the optional `noteFindings` seam on `VocabularyProvider` (provider-
specific whole-note checks, called by `noteVocabFindings`); `tag_unregistered` rides the
ordinary token path. Report-first throughout — no write-time refusal; curation is human.
</content>
