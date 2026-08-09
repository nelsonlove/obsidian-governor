# vault-mcp

An Obsidian plugin that embeds a **Model Context Protocol (MCP) server** inside the running app, giving Claude Code direct, canonical access to a live vault through Obsidian's own APIs — backlinks, link resolution, Dataview queries with native types, Templater rendering, Metadata Menu fileClass schemas, workspace/bookmark control, and more.

It is the **local-with-Obsidian** counterpart to [`obsidian-vault-mcp-server`](https://github.com/nelsonlove/obsidian-vault-mcp-server) (a remote, filesystem-only MCP server). Same `obsidian_*` tool names; this one runs inside Obsidian so its returns are canonical (live metadata cache, real plugin APIs) instead of parsed from disk.

> **Desktop only.** Uses Node `net`/`fs` from Obsidian's renderer; `isDesktopOnly: true`.

## How it works

```
┌─ Obsidian (renderer) ─────────┐        ┌─ Claude Code session ──────┐
│  vault-mcp plugin             │        │  MCP client (stdio)        │
│   ├─ MCP server (app.* direct)│        │       │                    │
│   └─ Unix socket  ◄───────────┼────────┼─ bridge.mjs (spawned)      │
│      ~/.claude/vault-mcp/     │  socket│   reads discovery, proxies │
│      <vault>.sock (chmod 600) │        │   stdio ↔ socket           │
└───────────────────────────────┘        └────────────────────────────┘
```

- The plugin runs an MCP server in Obsidian's renderer and listens on a per-vault **Unix socket** (`~/.claude/vault-mcp/<vault-slug>.sock`, `chmod 600` — the only auth boundary).
- A tiny bundled **`bridge.mjs`** (written to `~/.claude/vault-mcp/` on load) is what Claude Code spawns; it proxies stdio ↔ the socket.
- A fresh MCP server is built **per connection**, so multiple Claude Code sessions and background agents share the plugin without evicting each other.

## Install

1. **Build** (or download a release):
   ```bash
   npm install && npm run build      # emits main.js (bridge embedded) + manifest.json
   ```
2. **Copy into your vault** and enable it:
   ```bash
   cp main.js manifest.json <vault>/.obsidian/plugins/vault-mcp/
   ```
   Then Settings → Community plugins → enable **Vault MCP**.
3. **Connect Claude Code** — run the command **`vault-mcp: Connect to Claude Code`** from the command palette. It runs `claude mcp add --scope user vault-mcp -- node ~/.claude/vault-mcp/bridge.mjs --vault <this vault>` for you (one-time, persists across sessions). The `--vault` pin keeps the registration unambiguous once a second vault also serves MCP — without it the bridge aborts with `multiple vaults open; specify --vault`. If the `claude` CLI can't be found, it shows the exact line to paste; the same line is always available in **Settings → Vault MCP → Claude Code connection**. To point Claude Code at a different vault later, run Connect from that vault (or edit the `--vault <name>` value in the config).
4. **Restart any open Claude Code session** — MCP servers load at session start.

On the Mac, **disconnect the remote `obsidian-vault-mcp-server` connector** for that session so you don't have two Obsidian tool sets at once. They share `obsidian_*` names by design; this local one gives canonical returns.

## Tools

**Up to 52 tools.** 45 are always available; 6 are **plugin-gated** (register only when their backing plugin is loaded); 1 (`obsidian_cli`) registers only when the official Obsidian CLI binary is installed:

- **Core (read/write, live `app.*`):** list/read/write/append/move/delete notes, backlinks, outlinks, resolve, frontmatter (atomic multi-key), patch, search, find-by-tag, …
- **Complementary:** trash, parsed read, append-at-heading, run-command, command list, vault/tags/environment info, active note, open-in-editor.
- **Navigation/control:** jump-to, view-mode, workspaces (open/save/list), bookmarks (open/list), periodic note, plugin toggle.
- **Identity:** `obsidian_resolve_uid` — look a note up by its frontmatter `uid`, or a uid up by path. See [Addressing notes by uid](#addressing-notes-by-uid).
- **Link health:** `obsidian_check_links` — read-only report of dangling wikilinks, duplicated uids, and uid coverage. See [Link health](#link-health).
- **Advisory claims:** `obsidian_claim_scope`, `obsidian_renew_scope`, `obsidian_release_scope`, `obsidian_list_scope_claims` — see [Advisory scope claims](#advisory-scope-claims).
- **Plugin-gated:** `dataview_list_query`, `dataview_table_query` (Dataview); `create_note_from_template` (Templater); `omnisearch` (Omnisearch); `fileclass_schema`, `fileclass_insert_fields` (Metadata Menu).
- **Official-CLI proxy:** `obsidian_cli` runs any official Obsidian CLI command against this vault (file history/diff/restore, themes, snippets, publish, …). The vault is pinned; dangerous commands (`eval`, `dev:*`, `devtools`, `restart`, `reload`, `command`, `plugins:restrict`, `plugin:install`, `plugin:uninstall` — the last two because installing loads arbitrary plugin code and uninstalling can remove vault-mcp itself) need the **Allow dangerous CLI commands** setting; the tool is unavailable while a path allowlist is active (CLI args can't be path-scoped) and is blocked entirely in read-only mode.

Run **`obsidian_doctor`** (tool) or **`vault-mcp: Show diagnostics`** (command) to see which integrations the plugin currently detects.

### Code Mode (token-lean surface)

Registering ~40+ tool schemas costs context in every session. A connection whose bridge runs with **`--code-mode`** (append it to the registered command: `… node ~/.claude/vault-mcp/bridge.mjs --vault <name> --code-mode`, or set `VAULT_MCP_CODE_MODE=1`) gets just **3 meta-tools** over the same registry: `obsidian_search_tools` (keyword discovery), `obsidian_describe_tool` (input JSON Schema), `obsidian_call_tool` (invoke by name, args validated against the target's schema). Read-only mode and the path allowlist bind on the target tool exactly as on the full surface. The mode is chosen per connection via a one-line preamble the bridge sends before the MCP stream — old bridges and full-surface sessions are wire-compatible, and both kinds of session can run concurrently against the same vault. If the vault's plugin build predates preamble support, the bridge warns on stderr and falls back to the full surface rather than failing.

## Addressing notes by uid

**A path is not an identity.** Rename a note, move it into a folder, let a template reorganize it — and every path you were holding is silently wrong, usually without an error, because a path that no longer exists reads as "create a new note here". A note's frontmatter `uid` doesn't move.

So **anywhere a tool takes a path, it also takes `uid:<value>`**:

```jsonc
{"path": "uid:019fe34f-1ff0-74ae-8117-ca6d9843873f", "content": "…"}   // obsidian_write_note
{"paths": ["uid:019fe34f-…", "Notes/Literal.md"]}                      // mixed is fine
{"from": "uid:019fe34f-…", "to": "Archive/2026/Moved.md"}              // any path argument
```

This is **the stable way to reference a note across renames** — resolve a uid once and keep using it for the rest of a session, or across sessions, without re-reading the path. It works on **reads and writes alike**, on the full surface, in Code Mode, and on path-taking tools published by other plugins, because it binds at the same single interception point as the guard and the write queue rather than tool by tool. Handlers never see a uid reference; they get the resolved path.

The plugin keeps a **uid index** (`uid → path`, and the inverse) built at load from Obsidian's own metadata cache — no file reads — and kept current from Obsidian's events: a uid added, changed or removed by an edit, a note renamed or moved, a note deleted. Notes with no `uid` are simply not in it.

Two references refuse rather than guess, and **nothing runs** in either case:

- `Error [uid_unresolved]` — no note *you can reach* carries that uid. Better than writing a file literally named `uid:019f…`, which is what a plain path argument would have done.
- `Error [uid_ambiguous]` — **two or more notes *you can reach* carry it**, and the error names them. The index records duplicates rather than picking a winner or rewriting somebody's frontmatter; use `obsidian_resolve_uid` to see them and fix the vault.

Both decisions are made over the notes a **path allowlist** leaves visible to your session, never the whole vault: a uid carried only outside your allowlist reads as unresolved, one carrier inside it resolves normally however many hidden ones exist, and an ambiguity names only the paths you could have named yourself. A duplicated uid is not a way to read a path out of your sandbox.

**`obsidian_resolve_uid`** is the lookup, in both directions: `{uid}` → `{path, duplicates?}`, `{path}` → `{uid}`, and no argument at all → index totals plus every duplicated uid. It's read-only and reports duplicates; it never repairs them. It applies exactly the visibility rule above — including the **totals**, which count only what your session can see, so a sandboxed session doesn't learn how much lives outside its allowlist.

The journal records both halves: `target.path` is where the operation landed, `target.uid` is the identity it landed on (taken from the index, so it's present even when the frontmatter cache is behind).

## Link health

Links are handled in two places, and the split is deliberate.

**In band, a move heals its own links.** Every move this server performs — `obsidian_move_note`, `obsidian_move_notes` (batch), and any rename underneath them — goes through **`app.fileManager.renameFile`**, Obsidian's link-updating rename, never `vault.rename`. The host rewrites every backlink to the moved note canonically, exactly as it would if you had dragged the file in the sidebar. This is a guarantee, not a best effort, and a regression test pins it (a fake app whose `vault.rename` throws). Because Obsidian rewrites internally and reports no count, the move response **omits** `backlinks_updated` rather than claiming `0` — "unknown, not zero". `update_backlinks: false` is advisory here: Obsidian exposes no rename-without-rewrite API, so links are updated regardless.

*Boundary:* the remote, filesystem-only [`obsidian-vault-mcp-server`](https://github.com/nelsonlove/obsidian-vault-mcp-server) has no Obsidian to delegate to. It renames on disk and then rewrites backlinks itself from its own index — real, but index-dependent (a stale or still-building index rewrites less), honoring `update_backlinks`, and reporting exact counts. Same tool name, different guarantee; that's why the live backend returns `null` counts instead of pretending to the same number.

**Out of band, links rot anyway** — a note deleted in Finder, a rename done by another tool, a `[[wikilink]]` typed against a note nobody created, a uid pasted into a second note. Nothing this server did caused it.

**`obsidian_check_links` reports that drift and repairs nothing.** It is read-only: no queue slot, no journal record, no `fix`/`heal` argument, and it works in read-only mode. The rail names what has drifted; deciding what it should have pointed at is yours.

```jsonc
{"scope": "Projects"}   // optional — omit for everything you can see
→ {
    "scope": "Projects",
    "dangling_links":  {"note_count": 3, "link_count": 5, "truncated": false,
                        "items": [{"from": "Projects/A.md", "link": "Old Name", "count": 2}, …]},
    "duplicate_uids":  {"available": true, "count": 1, "truncated": false,
                        "items": [{"uid": "019fe34f-…", "paths": ["Projects/A.md", "Projects/B.md"]}]},
    "uid_coverage":    {"available": true, "notes_total": 120, "notes_with_uid": 118,
                        "notes_without_uid": 2, "truncated": false,
                        "uncovered": ["Projects/C.md", "Projects/D.md"]}
  }
```

Dangling links come from Obsidian's own `unresolvedLinks` map and duplicated uids from the uid index — both already computed, so the report never reads a file. **`uid_coverage`** is the identity half: how many of the notes you can see carry a uid at all, and which don't. It is **report-first like the rest** — no uid is minted, nothing is written, and there is no argument that would make it otherwise; whether uncovered notes should get uids is a decision this names for you, not one it takes. `available: false` (no uid index in this build) means the uid counts are *unknown*, not zero.

Counts are exact for everything visible and in scope; the lists are capped at 100 each with a `truncated` flag (narrow `scope` to see more).

**Visibility.** Every path in the report is filtered through your path allowlist, so no out-of-allowlist note is counted, named, or used as a denominator. Two boundaries are worth stating plainly:

- The filter is over **source notes**. A dangling link's *text* is reported verbatim out of a note you can read — including text shaped like a path outside your allowlist. It names nothing that exists (a dangling link resolves to no file, by definition) and you could read it out of the note yourself.
- **Absence is a one-bit oracle.** A link that *doesn't* appear in the report resolved to something — possibly a note outside your allowlist. That bit is inherent to letting Obsidian resolve links at all: it is the host, not this server, that decides a link resolves, and suppressing the resolution would mean re-implementing link resolution over a filtered vault. Nothing else leaks: no path, no name, no count.

A duplicate whose carriers straddle your scope isn't an ambiguity *for that scope*.

**A bad `scope` is refused, never widened**, with a machine-readable code — the same way an advisory claim answers the same mistake. `Error [invalid_scope]` for a scope that is absolute, whitespace-padded, or normalizes to nothing or above the vault root; `Error [out_of_allowlist]` for one naming an area you can't see. The out-of-allowlist case refuses *typed* rather than returning a zeroed report, because a zeroed report for a hidden folder and a zeroed report for a genuinely clean one are indistinguishable. A scope that merely *contains* your allowlist (`Projects` when you're scoped to `Projects/Alpha`) is out of it too — narrow the scope, or omit it.

To act on a report: **`obsidian_repoint_link`** rewrites every wikilink matching a name to a target you choose (`dry_run` first, `unresolved_only` to leave working links alone) — one deliberate call, one decision. A duplicated uid is fixed by editing one note's frontmatter; nothing here will pick a winner for you.

**The repair is contained by the same allowlist.** `obsidian_repoint_link` scans notes to find the links it rewrites, so its blast radius isn't in its arguments and the ordinary path check can't reach it. With an allowlist configured it reads, rewrites and names **only visible notes** — the response says `scoped_to_allowlist: true`, and that flag matters: the repair is then **partial**, and dangling links to the same name survive outside your allowlist. With no allowlist, the scan is the whole vault as before (`scoped_to_allowlist: false`). The journal records what actually changed, not just what was asked for: an `effects: {filesChanged, paths}` field beside the argument-derived `target` (omitted for a `dry_run`, which changes nothing).

## Write queue & journal

Every **mutating** tool call (write, append, patch, move, delete, trash, frontmatter edit, repoint, CLI, mutating external tools) runs through a **single FIFO queue per plugin instance** — one vault mutation at a time, across every connected session and background agent. Reads never queue, so a slow write never stalls a session's reads.

Each queued operation gets a **30-second budget** (a constant, not a setting). If it hasn't finished by then it is abandoned, that *one* call fails with `Error [write_timeout]: …`, and the queue immediately moves on — a wedged operation can never take the bridge, or anyone else's session, down with it. The vault may or may not have been modified when this happens; re-read before retrying.

### Conditional writes (`if_rev`) and safe retries (`idempotency_key`)

Every mutating tool takes two optional arguments beyond its own. They are declared on every mutating schema automatically, so they work on the full surface, in Code Mode, and on mutating tools published by other plugins alike; no handler ever sees them.

- **`if_rev` (number) — don't clobber what you didn't read.** `obsidian_read_note` / `obsidian_read_notes` return the note's current **`rev`** (its mtime in ms — the same token the journal records). Pass that value back as `if_rev` on the following write and the write applies **only if the note is still at that revision**. Otherwise nothing is written and the call fails with `Error [rev_conflict]: … expected rev X, but found rev Y` — re-read and decide. The check happens when the operation reaches the **front of the queue**, not when it was submitted, so a write that was queued behind someone else's write is compared against the world that write left behind. That is what makes concurrent sessions lose-update-proof rather than merely serialized. A target with no readable revision (deleted, never existed) is a conflict, not a pass. On a multi-target operation it applies to the **first** target.
- **`idempotency_key` (string) — retry without double-writing.** A repeat call carrying a key this plugin has already completed returns the **first call's exact result** without running the handler or taking a queue slot; a repeat sent while the first is **still in flight** waits for it and returns the same envelope rather than starting a second write. So four simultaneous retries of one dropped request run the operation once and all four get one answer. The window is **10 minutes**, capped at 500 keys (least-recently-used evicted first).

  What it does **not** cover, precisely: it collapses retries of calls that **returned**. A call that failed with `Error [write_timeout]` was *abandoned* server-side and **may still have landed** — its key is deliberately **not held**, so retrying it re-executes, and the journal appends a corrective `late-ok`/`late-error` record if the original settled after all. Re-read before retrying those. (A `rev_conflict` likewise stores nothing, but there nothing was written.) Replay covers whatever the first call *returned* — a failure envelope replays as that failure, so use a **fresh key** to genuinely retry a failed operation.

  A key's identity is (**key**, **operation**, **arguments**, **`if_rev`**). Reusing one key for a different tool — for the same tool with different arguments — or for the same call under a *different* `if_rev`, including dropping or adding one — fails with `Error [idempotency_mismatch]: …` and runs nothing, rather than replaying and silently discarding the second call's write. The precondition counts because it is half of what the caller asked for: replaying a keyed call across a changed `if_rev` would report that a condition held when it was never evaluated. (The error names which half diverged: the operation, the arguments, or the precondition.) **Keys live in memory, per plugin instance**: reloading the plugin (or restarting Obsidian) clears them, after which the same key executes again. That is the v0 boundary — the store collapses retries within a session's lifetime, it does not make an operation exactly-once forever.

Every mutating operation also appends **one JSONL line** to `.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl` (rolled monthly, inside the plugin's own folder rather than the note tree):

```json
{"ts":"2026-08-08T19:04:11.427Z","op":"obsidian_write_note","target":{"path":"Inbox/Idea.md","uid":"019f…"},
 "actor":{"transport":"mcp","client":"claude-code/1.0.0","connection":"m1x8g-3",
          "server":{"vault":"Assent","install":"3f7c…","version":"0.9.2"}},
 "argsDigest":{"path":"Inbox/Idea.md","content":"<812 chars>","overwrite":true},
 "outcome":"ok","durationMs":37,"queueWaitMs":0,"revBefore":1754680000000,"revAfter":1754680051427}
```

It records the *operation* — what happened, to what, on whose behalf — not the bytes; git already covers the bytes. `actor.server` is the transport's own assertion of identity: which **vault**, which **install** (a persistent id in `.obsidian/plugins/vault-mcp/install-id.json`, minted once and kept beside the journal), and which plugin **version** — so a journal copied off the machine, or two vaults' journals read together, stays attributable. The `initialize` handshake carries the vault name too, in `serverInfo.title`. `durationMs` is the handler alone and `queueWaitMs` is the time spent waiting behind other writes, so a slow operation and a queued one are distinguishable; `revBefore` is probed when the operation reaches the front of the queue, not when it was enqueued. Operations that name no vault path (running a command, toggling a plugin, an `obsidian_cli` invocation) record `target.ref`, e.g. `"command:editor:toggle-bold"`. `target` says what was *asked for*; where an operation discovers its own blast radius — `obsidian_repoint_link` scans notes to find the links it rewrites — the record also carries **`effects`**: `{"filesChanged": 12, "paths": [...]}`, the exact count plus the changed paths (capped at 20). A dry run records none: nothing changed, so nothing is claimed.

### Advisory scope claims

Two agents working the same folder can at least *tell each other so*. `obsidian_claim_scope` takes a **scope** (a vault path prefix), a **reason**, and an optional `ttl_ms`, and returns a claim id.

**It is advisory and nothing else.** A claim blocks no one, queues nothing, and refuses nobody:

- **Overlapping claims by different holders are allowed** — and the claim response *lists* the ones it overlaps, with holder and reason, so the claimer knows who else is here.
- **A write inside somebody else's live claim still happens.** What it gains is a notice: an extra content block on the result (one claim per line — `advisory lock: claude-code/1.0.0#m1x8g-3 claims Projects/Alpha (restructuring), expires in 214s`), an `advisory_locks` entry in the structured result, and a `lockNotice` field on the journal record naming the most specific claim. Your own writes inside your own claim get nothing — claiming a scope is how you say you're working in it.
- **Every path an operation names is consulted, not just the first.** A move *into* a claimed scope lands in somebody's work exactly as much as a move out of one does, so both halves of a move (and every path of a batch) are checked. Each claim is disclosed once however many of the paths it covers.
- **Claims expire on their own** — default 5 minutes, maximum 30. A holder that crashes or disconnects cannot wedge a scope; expiry is lazy, so an expired claim is simply gone the next time anyone looks. `obsidian_renew_scope` restarts the clock on a claim you hold (by its `lock_id`, leaving scope and reason alone); **claiming a scope you already hold replaces that claim** rather than adding a second — same id, restated reason, restarted clock. `obsidian_release_scope` drops it early, and `obsidian_list_scope_claims` shows every live claim.
- **At the cap, a claim is refused — never traded for someone else's.** A connection may hold 50 live claims and the vault 200; past your own cap `obsidian_claim_scope` fails with `Error [lock_cap]`, past the store's with `Error [lock_store_cap]`, and either way nothing is claimed and no existing claim is dropped. (Evicting the oldest claim to make room, which is what it used to do, let a client claiming in a loop silently delete every other session's claims.) The per-connection cap bounds a *connection*, not a client: connections are free, so a client running four of them can hold all 200 and a bystander's claim is then refused. What bounds that is time, not identity — every claim expires within 30 minutes (5 by default), so the store drains on its own, and because claims are advisory a full store costs a denied caller only the disclosure, never a read or a write.
- **A path allowlist bounds claiming.** A claim is a statement about a region of the vault that every other session sees, so a session sandboxed to `Projects/` can claim inside `Projects/` and nowhere else — a scope outside it, or the whole-vault scope `""`, fails with `Error [out_of_allowlist]`. Sessions with no allowlist configured are unaffected, whole-vault claims included. Listing is never restricted: knowing who else is working is the entire value of the mechanism.

A claim is held per **connection** — a reconnecting session starts with none — and claims live in memory, so a plugin reload clears them. Claiming and releasing are treated as **mutating** operations: not because they touch the vault (they don't) but because a claim is exactly the sort of act the audit stream should record, so each one is journaled like any other operation (`target.ref` = `scope:<prefix>` / `lock:<id>`). One consequence: **read-only mode blocks claiming and releasing** — in a session that cannot write, there is nothing for a claim to disclose. Listing still works.

Outcomes beyond `ok` / `error`: **`"conflict"`** is a failed `if_rev` precondition (nothing was written; `revBefore` is the revision actually found, `ifRev` what the caller expected), and **`"deduped"`** is an idempotency replay, with `dedupeOf` naming the `ts` of the record whose result was returned (and `error` copied across when the outcome being shared was a failure). `idempotencyKey` appears on any record whose call supplied one. `ifRev` appears only on records for calls that actually reached the precondition check — a `"deduped"` record omits it, because a replay never evaluates the precondition at all.

**Note bodies are never written to it**: arguments are reduced to a digest, with bodies and long strings collapsed to `<N chars>`. The journal is **append-only** — nothing in the plugin edits or deletes a record, and pruning is a manual act on whole month files. So when an operation that timed out (journaled `"outcome":"error"`) turns out to have finished afterwards, the original line stands and a **corrective record** is appended — same op and target, `"outcome":"late-ok"` or `"late-error"`, and `"corrects"` naming the `ts` of the record it amends. If a journal write fails it is logged to the console and dropped; it never fails the vault operation.

## Settings (Settings → Vault MCP)

- **Claude Code connection** — status + the `claude mcp add` line + copy button.
- **Read-only mode** — blocks all mutating tools (write/delete/move/trash/frontmatter-set/…). Reads still work. Useful when you don't want Claude touching the vault this session.
- **Allow dangerous CLI commands** — off by default; lets `obsidian_cli` run code-executing/app-controlling commands (`eval`, `dev:*`, `devtools`, `restart`, `reload`, `command`, `plugins:restrict`, `plugin:install`, `plugin:uninstall`).
- **Trusted read-only plugins** — plugin ids (one per line, empty by default) whose published tools may declare themselves read-only and be believed. See [External tool trust](#external-tool-trust).
- **Path allowlist** — one vault-relative prefix per line (empty = whole vault). File operations outside every prefix are refused (`..` traversal is normalized and blocked). Useful to sandbox Claude to one area.
- **Disable socket** — stops the server without uninstalling the plugin (takes effect on plugin reload).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Claude Code says the MCP is unreachable | Obsidian isn't running, or the plugin is disabled. Open Obsidian / enable the plugin. |
| "auto register failed, no such file or directory" | The `claude` launcher needs `node` on PATH; the plugin augments PATH with `/opt/homebrew/bin` + `/usr/local/bin`. If your `node`/`claude` live elsewhere, run the `claude mcp add` line manually in a terminal where `claude` works. |
| Tools don't appear in a session | You registered after the session started — restart the Claude Code session (MCP loads at start). |
| Multiple vaults open | The registration must pin `--vault <name>` (Connect does this for the vault you run it from); `obsidian_doctor` reports the bound vault. A registration made before a second vault existed may be generic — re-run Connect, or add `--vault <name>` to the existing `claude mcp` entry. |
| A plugin-gated tool is missing | Its backing plugin isn't loaded. Enable it; the tool appears on the next session connect. |
| A write failed with `Error [write_timeout]` | The operation ran past the queue's 30s budget and was abandoned so the queue could continue. Usually a very large batch or a stuck Obsidian API call. Re-read the target (it may be partially written), then retry with a smaller batch. |

## Publishing tools from other plugins

Other Obsidian plugins can publish their own MCP tools through vault-mcp's bridge. Add the SDK:

    npm install github:nelsonlove/vault-mcp-api#v1.0.0

then in your plugin's `onload()`:

    import { publishTools } from "vault-mcp-api";
    import { z } from "zod";

    this.register(
      publishTools(this, [{
        name: "my_tool",                      // published as <your-plugin-id>_my_tool
        description: "What it does.",
        inputSchema: { arg: z.string().describe("…") },
        readOnly: false,                      // omit or false ⇒ blocked in read-only mode
        handler: async ({ arg }) => ({ result: "plain JSON out" }),
      }])
    );

The SDK handles load order (registers now or on the `vault-mcp:ready` event), re-registration when vault-mcp reloads, and cleanup. Tools appear to new Claude Code sessions on their next connect. Safety guards that apply: read-only mode always applies (mutating external tools are blocked when read-only is on); the path allowlist scopes arguments under recognized path keys (path, from, to, paths, and a few others) — when an allowlist is active, mutating external tools whose args carry no recognized path key are blocked outright, since vault-mcp cannot scope the call. To pass the allowlist check, use a recognized path argument name or clear the allowlist.

### External tool trust

`readOnly: true` on a published tool is an assertion by a third-party plugin about code vault-mcp cannot inspect — and believing it exempts that tool from the write queue, the journal, the path allowlist, the kernel arguments, and read-only mode, all at once. So **vault-mcp does not believe it by default**.

An external tool that claims read-only is treated as **mutating** — queued, journaled, allowlist-scoped, given `if_rev`/`idempotency_key`, and **blocked entirely while read-only mode is on** — unless its publishing plugin id appears in the **Trusted read-only plugins** setting (`trustedReadOnlyPlugins` in the plugin's `data.json`; an array of plugin ids, empty by default). Matching is exact on the raw plugin id, and the setting is read when a session connects, so changes take effect on the next connect.

Nothing changes on the publisher's side: the `vault-mcp-api` SDK contract is unchanged and `readOnly: true` is still the right declaration to make — this is purely host-side policy about whether to act on it. A tool that genuinely only reads keeps working either way; untrusted, it just pays for a queue slot and lands in the audit stream.

## Repo

`~/repos/obsidian-vault-mcp-plugin`. See `CLAUDE.md` for the locked architecture decisions.
