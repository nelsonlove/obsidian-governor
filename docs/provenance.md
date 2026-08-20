# The provenance module — derived-content freshness

`modules.provenance` (default **off**, mutating) is the fold of the standalone
`obsidian-provenance` CLI. Three tools:

| Tool | What it does | Mutating? |
| --- | --- | --- |
| `provenance_check` | Is a derived note FRESH or STALE against its own `derived-from:` sources? | read-only |
| `provenance_reconcile` | Installed vs enabled vs noted Obsidian plugins | read-only |
| `provenance_regen` | Regenerate the plugin-audit note (dry-run by default) | mutating |

Source: `src/kernel/provenance/*` (pure, Obsidian-free over an injected
`ProvenanceSource`) and `src/mcp/tools-provenance.ts` (the tool surface + the one
Obsidian adapter). Derivation is **not** acceptance: the module stamps
`derived-from` / `generated` / `generator` / `derivation-mode` /
`derived-source-count`, and `provenance_regen`'s write routes through the shared
accept-forbidden guard — see [acceptance-model.md](acceptance-model.md).

## The contract a derived note declares

```yaml
---
derived-from:                        # vault-relative plain paths and/or globs
  - "08.10 Obsidian plugins/*.md"
  - ".obsidian/community-plugins.json"
generated: 2026-08-19T11:04:00       # when the artifact was produced
derived-source-count: 48             # OPTIONAL witness — see tier 2 below
---
```

A note with **no `derived-from` is an error**, not a "fresh" verdict — the check
is opt-in by construction, and a note that never declared sources is not
something `provenance_check` gets to have an opinion about.

## What the check detects

Three edits can happen to a source set. Two were always caught; the third —
**deletion** — was a silent blind spot, because an entry that resolves to nothing
simply dropped out of the comparison and the note read FRESH.

| Change to the sources | Caught by | Verdict field |
| --- | --- | --- |
| A source was **modified** | mtime > `generated` | `changed` |
| A source was **added** | the new file's own fresh mtime | `changed` |
| A **plain-path** source was deleted / moved | the entry resolves to nothing | `missing` |
| A source was deleted **inside a glob** | the `derived-source-count` witness (opt-in) | `sourcesRemoved` |

The note is STALE when **any** of `changed`, `missing`, or `sourcesRemoved` is
non-empty. `fresh: true` means all three came back clean.

### Tier 1 — missing plain-path entries (always on)

A NON-GLOB `derived-from` entry names exactly one file. If it resolves to
nothing, that file is gone (deleted, moved, or renamed) — unambiguously. The
entry is named in `missing` and the note is STALE. No schema change, nothing to
opt into.

A **glob matching nothing is deliberately not the same claim.** An empty folder
can be a perfectly legitimate source set (a vault with no plugin notes yet), so
globs never populate `missing`. An empty glob is reported only through the count
witness below, and is invisible without one.

### Tier 2 — the `derived-source-count` witness (opt-in, per note)

A generator may stamp how many source files the **whole** `derived-from` set
resolved to at generation time — the length of the same list `provenance_check`
reports as `sources` — **including duplicates**, when two entries name the same
file — so the witness and the check are the same arithmetic. A generator that
counts a de-duplicated set over overlapping entries under-counts, and its note
reads permanently stale. When the current count is **lower**, sources were
removed:

```json
"sourcesRemoved": { "expected": 48, "actual": 47 }
```

A **higher** count is not staleness by itself. Additions are exactly the case the
mtime rule already catches, so treating "more files than before" as stale would
only add false positives — a source set that legitimately grew, every file older
than `generated`, is fresh and reads fresh.

**Why a count and not digests or a stored path list.** Pure deletion drops the
count. Delete-plus-add keeps the count, but the added file carries a fresh mtime
and the mtime rule already trips. So count + mtime cover the space between them —
without hashing every source on every check, and without freezing 48 paths into a
note's frontmatter where they would rot.

**Absent witness ⇒ exactly the pre-witness behavior.** Nothing about a note
without the field changes. But the verdict says so out loud:

```json
"globDeletionsUndetectable": true
```

`true` means this note has at least one glob entry and no usable witness, so
deletions inside the globbed set were **not checked**. `false` means either every
entry is a plain path (deletions fully covered) or a witness was available and
the count check ran. That distinction — "checked and fine" vs "could not check
that class" — is the whole point of the flag; a caller must not read a bare
`fresh: true` as the former. A malformed witness (negative, fractional,
non-numeric) is treated exactly like an absent one.

## Honest limits

| Limit | Consequence |
| --- | --- |
| Detection is **mtime-based** | `touch`ing a source with no content change ⇒ **false stale**. Edit-and-revert ⇒ still stale (the mtime moved). There is no content digest. |
| **Plain-path** deletions | Always caught. |
| A plain-path entry that is **optional**, names a **folder**, or never existed | Indistinguishable from a deletion — the check sees "this entry names no file" and nothing more. It lands in `missing` and the note stays STALE permanently, through any number of regenerations, until the entry is removed from `derived-from`. Declare only sources you require. |
| **Glob** deletions | Caught **only** with a `derived-source-count` witness; otherwise invisible, and flagged as such. |
| **Additions** | Caught by mtime, for globs and plain paths alike. No witness needed. |
| Delete + move-in with a **preserved mtime** | Undetectable. A `mv` within a filesystem keeps the file's mtime, so both the count and the newest mtime can be unchanged after a real substitution. |
| An **empty glob** with no witness | Not reported. An empty source set may be legitimate; the flag is the only signal. |
| The witness is **stamped, never verified** | It records what a generator claimed at generation time. A hand-edited or wrong witness produces a wrong count comparison — the same trust model as `generated:` itself. |
| Timestamp granularity | `generated` is stamped to **seconds** (local time); mtimes are milliseconds. A source modified inside the same second as generation can round under the comparison. |

## Who stamps the witness

Governor stamps it on **its own** generated note: `provenance_regen` resolves the
audit's own `derived-from` set (`auditDerivedFrom`, the single definition the
rendered frontmatter list also comes from) and stamps
`derived-source-count: <n>`. Delete a plugin note afterwards and
`provenance_check` reports `sourcesRemoved`, with no mtime anywhere having moved.

Three details of that note in particular:

- **The audit is a source of itself.** It lives at `{notesDir}/<basename>.md`,
  which its own `{notesDir}/*.md` glob matches. So the count is stamped for the
  set as it will be *after* the write lands (a first-ever regen adds one for the
  note about to be created) — otherwise the first deletion after a first regen
  would be masked by a witness that was one low.
- **Consequence of the same self-inclusion, pre-existing and not fixed here:** the
  audit note's own mtime moves when the regen writes it, which is later than the
  `generated:` it just stamped, so `provenance_check` on the audit reports itself
  in `changed` and reads STALE immediately after a regen. That is a wart of
  that particular `derived-from` list — a glob cannot say "everything here except
  me" — not of the deletion detection above.

- **The audit declares one source that is really optional.**
  `.obsidian/community-plugins.json` is a plain-path entry, but `reconcile` treats
  it as optional (absent ⇒ nothing enabled). In a vault where it does not exist —
  no community plugin has yet been enabled — the audit reports
  `missing: [".obsidian/community-plugins.json"]` and reads STALE about a file
  that was absent from the start. The same class as the third row of the limits table
  above; narrow in practice, since Obsidian writes that file on the first enable.

Two other Governor generators were considered and deliberately **not** stamped:

- the **conformance debt register** (`src/conformance/debt-register.ts`) stamps
  `generated` + `generator` but declares **no `derived-from`** — its inputs are a
  findings run and a baseline, not a resolvable file set, so `provenance_check`
  cannot check it at all and a source count would witness nothing;
- the **skills export** writes a Claude Code plugin directory outside the vault
  (its manifest already records `count` + `files`), not a derived *note* with
  frontmatter.

Vault-side generators (QuickAdd macros, scripts, anything outside this repo) are
not touched: the field is simply **readable** if they choose to stamp it.

## The verdict shape

`provenance_check` returns, additively over the original shape. `changed`,
`sources` and `generated` keep their names **and** their meaning. `fresh` keeps
its name but is deliberately **stricter** than before — an empty `missing` and no
`sourcesRemoved` are new conditions on it, which is exactly the change this
detection makes: a note whose plain-path source was deleted used to read fresh.

| Key | Always present? | Meaning |
| --- | --- | --- |
| `path` | yes | the note that was checked (echoed back) |
| `fresh` | yes | no `changed`, no `missing`, no `sourcesRemoved` |
| `changed` | yes | resolved source files with mtime > `generated` |
| `sources` | yes | every file the `derived-from` set resolved to |
| `generated` | yes | the note's `generated`, as ISO |
| `missing` | yes | non-glob entries resolving to no file |
| `globDeletionsUndetectable` | yes | glob entries present and no usable witness |
| `expectedSourceCount` | only with a witness | the witness as read |
| `sourcesRemoved` | only when the set shrank | `{expected, actual}` |

## What stays un-headless

Nothing in the freshness engine. `checkFreshness` is pure over the injected
`ProvenanceSource` (`noteFrontmatter` / `stat` / `glob` — this work added **no**
new primitive to the seam), and the detection rules above are unit-tested against
an in-memory backend in `tests/provenance-module.test.mjs`. The one part not covered
headlessly is the same one as before: `obsidianProvenanceBackend`'s glob walk over
the live vault adapter, which must be verified against a running Obsidian.
