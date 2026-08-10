# Identity substrate & link health

A path is not an identity. Rename a note, move it into a folder, let a template reorganize it
— and every path you were holding is silently wrong, usually without an error (a path that no
longer exists reads as "create a new note here"). The identity substrate gives an agent a
**stable** way to name a note, and a **read-only** way to see what has drifted.

The [reference](reference.md#addressing-notes-by-uid) carries the full prose; this is
the reference for the tools and where they live.

## The uid index and `uid:` addressing

The plugin keeps a **uid index** (`uid → path`, and the inverse), built at load from
Obsidian's own metadata cache (no file reads) and kept current from Obsidian's events — a uid
added/changed/removed by an edit, a note renamed/moved/deleted
(`packages/plugin/src/kernel/uid-index.ts`). Notes with no `uid` frontmatter are simply not in
it.

**Anywhere a tool takes a path, it also takes `uid:<value>`** — on reads and writes alike, on
the full surface, in Code Mode, and on path-taking tools published by other plugins. It binds
at the **same single interception point** as the accept guard and the write queue
(`packages/plugin/src/mcp/guarded.ts`), so handlers never see a uid reference — they get the
resolved path.

```jsonc
{"path": "uid:019fe34f-1ff0-74ae-8117-ca6d9843873f", "content": "…"}   // obsidian_write_note
{"paths": ["uid:019fe34f-…", "Notes/Literal.md"]}                      // mixed is fine
{"from": "uid:019fe34f-…", "to": "Archive/2026/Moved.md"}             // any path argument
```

Two references **refuse rather than guess**, and nothing runs in either case:

- `Error [uid_unresolved]` — no note *you can reach* carries that uid.
- `Error [uid_ambiguous]` — two or more notes *you can reach* carry it, and the error names
  them. The index records duplicates rather than picking a winner or rewriting anyone's
  frontmatter.

Both decisions are made over the notes a **path allowlist** leaves visible (see
[read-boundary containment](#read-boundary-containment)) — a duplicated uid is not a way to
read a path out of a sandbox.

### `obsidian_resolve_uid`

The read-only lookup, both directions (`packages/plugin/src/mcp/tools-uid.ts`):

- `{uid}` → `{path, duplicates?}`
- `{path}` → `{uid}`
- no argument → index totals plus every duplicated uid.

It reports duplicates; it never repairs them. The totals count only what your session can see,
so a sandboxed session doesn't learn how much lives outside its allowlist.

## Link healing — in band, a move heals its own links

Every move this server performs — `obsidian_move_note`, `obsidian_move_notes` (batch), and any
rename underneath them — goes through **`app.fileManager.renameFile`**, Obsidian's
link-updating rename, never `vault.rename`. The host rewrites every backlink to the moved note
canonically, exactly as it would if you had dragged the file in the sidebar. This is a
guarantee (pinned by a regression test whose fake app throws on `vault.rename`), not a best
effort.

Because Obsidian rewrites internally and reports no count, the move response **omits**
`backlinks_updated` rather than claiming `0` — "unknown, not zero." `update_backlinks: false`
is advisory here (Obsidian exposes no rename-without-rewrite API, so links update regardless).

## Link health — out of band, `obsidian_check_links` reports drift and repairs nothing

Links rot for reasons the server didn't cause: a note deleted in Finder, a rename by another
tool, a `[[wikilink]]` typed against a note nobody created, a uid pasted into a second note.

**`obsidian_check_links`** (`packages/plugin/src/mcp/tools-links.ts`) is a **read-only** report
— no queue slot, no journal record, no `fix`/`heal` argument, works in read-only mode:

```jsonc
{"scope": "Projects"}   // optional — omit for everything you can see
→ {
    "dangling_links":  {"note_count": …, "link_count": …, "truncated": false, "items": […]},
    "duplicate_uids":  {"available": true, "count": …, "truncated": false, "items": […]},
    "uid_coverage":    {"available": true, "notes_total": …, "notes_with_uid": …,
                        "notes_without_uid": …, "truncated": false, "uncovered": […]}
  }
```

Dangling links come from Obsidian's own `unresolvedLinks` map, duplicate uids from the uid
index — both already computed, so the report never reads a file. **`uid_coverage`** is the
identity half: how many visible notes carry a uid, and which don't. When a build has no uid
index, `available: false` and the uid-derived counts are **`null`, not `0`** (unknown, and
shaped so `notes_with_uid` + `notes_without_uid` always sum to `notes_total` whenever they are
numbers). Counts are exact for everything visible and in scope; lists cap at 100 each with a
`truncated` flag. A bad `scope` is **refused, never widened** — `Error [invalid_scope]` for an
absolute/empty/above-root scope, `Error [out_of_allowlist]` for one naming an area you can't
see.

## `obsidian_repoint_link` — the one deliberate repair

To act on a report, **`obsidian_repoint_link`** (`packages/plugin/src/mcp/tools-vault-write.ts`)
rewrites every wikilink matching a name to a target you choose — `dry_run` first,
`unresolved_only` to leave working links alone. One deliberate call, one decision. It **is a
mutating operation** (queued, journaled) and the journal records what actually changed via an
`effects: {filesChanged, paths}` field (omitted for a `dry_run`).

Its blast radius isn't in its arguments (it scans notes to find the links it rewrites), so it
is contained by the **same allowlist**: with an allowlist configured it reads, rewrites, and
names only visible notes — the response says `scoped_to_allowlist: true`, and the repair is
then **partial** (dangling links to the same name survive outside the allowlist).

## Read-boundary containment

Every tool that reads or enumerates the vault is bounded by the **path allowlist** (one
vault-relative prefix per line; empty = whole vault). Every path a call *names* is checked —
including inside batches and behind `uid:`/`jd:` addressing, which resolve *before* the check
so they can't be a way around it — and every enumerating tool bounds its own iteration by the
same rule, **filtering before it reads rather than after**. The full per-surface table
(search, listings, backlinks, resolve, tags, bookmarks, Dataview/CLI refusal, and the four
documented "known oracles") is in the [reference](reference.md#the-path-allowlist).

For the identity tools specifically: `obsidian_resolve_uid`, `obsidian_check_links`, and
`obsidian_repoint_link` are all filtered as above — a uid carried only outside your allowlist
reads as unresolved, an ambiguity names only paths you could have named yourself, and totals
count only what your session can see.
</content>
