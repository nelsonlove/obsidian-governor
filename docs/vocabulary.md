# Vocabulary provider — controlled vocabulary (read-only)

The vocabulary provider is a [capability module](modules.md) (id `vocab`, capabilities
`["vocabulary"]`) that lets an agent **check a note's tags, properties, types, and glossary
terms against the vault's controlled vocabulary** — and validate them **without writing
anything**. Validation and resolution only; nothing here mutates a note.

Files: `packages/plugin/src/mcp/tools-vocab.ts` (tools),
`packages/plugin/src/kernel/vocab/` (the pure engine: `provider.ts`, `registry.ts`,
`blueprint.ts`, `glossary.ts`, `findings.ts`). Obsidian-import-free; the vault reader arrives as
an injected `VocabSource` exposing only `paths()` / `frontmatter()` / `body()` — enumeration and
reads, structurally no write reach.

## What it validates

Four kinds — `VocabKind = "tag" | "property" | "type" | "term"` — served by two providers:

- **blueprint** (`blueprint.ts`) serves **`tag`**, **`property`**, **`type`**: tags from
  `<name>.tag.md` notes (namespace-prefix permissive), properties from flat `<key>.property.md`,
  types from `<Name>.fileclass` files (`extends` = parent, `retired: true` = deprecated).
- **glossary** (`glossary.ts`) serves **`term`**: definition notes tagged `note/definition`
  (term = `title`, gloss = `description`) and `## Terms` sections of `- **term** — definition`
  bullets.

The registry (`VocabRegistry`) skip-and-reports duplicate ids and unknown providers into a
`problems` array (it never throws), reserving an id before the provider check.

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
```

blueprint maps an unknown-per-kind token to `unregistered_tag` / `undefined_property` /
`unknown_type`; glossary emits `unknown_term` / `deprecated`; the whole-note rule pack
(`findings.ts`) adds `malformed_token` (e.g. a whitespace tag) and `ambiguous`.

## Read-only, and the findings rule pack

Every tool is `readOnlyHint: true` and the module has no write path. `findings.ts`
(`noteVocabFindings` — the pure whole-note rule pack) is exposed for a single named note through
`obsidian_validate_terms` but is **not registered as its own tool**: capabilities arrive as rule
packs, never as new mutating surface. Deciding whether an unregistered tag *should* be added to
the vocabulary, or a note re-tagged, is a decision the tool **names for you** — it never takes
it.
</content>
