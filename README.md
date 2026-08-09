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

**Up to 49 tools.** 42 are always available; 6 are **plugin-gated** (register only when their backing plugin is loaded); 1 (`obsidian_cli`) registers only when the official Obsidian CLI binary is installed:

- **Core (read/write, live `app.*`):** list/read/write/append/move/delete notes, backlinks, outlinks, resolve, frontmatter (atomic multi-key), patch, search, find-by-tag, …
- **Complementary:** trash, parsed read, append-at-heading, run-command, command list, vault/tags/environment info, active note, open-in-editor.
- **Navigation/control:** jump-to, view-mode, workspaces (open/save/list), bookmarks (open/list), periodic note, plugin toggle.
- **Advisory claims:** `obsidian_claim_scope`, `obsidian_release_scope`, `obsidian_list_scope_claims` — see [Advisory scope claims](#advisory-scope-claims).
- **Plugin-gated:** `dataview_list_query`, `dataview_table_query` (Dataview); `create_note_from_template` (Templater); `omnisearch` (Omnisearch); `fileclass_schema`, `fileclass_insert_fields` (Metadata Menu).
- **Official-CLI proxy:** `obsidian_cli` runs any official Obsidian CLI command against this vault (file history/diff/restore, themes, snippets, publish, …). The vault is pinned; dangerous commands (`eval`, `dev:*`, `devtools`, `restart`, `reload`, `command`, `plugins:restrict`, `plugin:install`, `plugin:uninstall` — the last two because installing loads arbitrary plugin code and uninstalling can remove vault-mcp itself) need the **Allow dangerous CLI commands** setting; the tool is unavailable while a path allowlist is active (CLI args can't be path-scoped) and is blocked entirely in read-only mode.

Run **`obsidian_doctor`** (tool) or **`vault-mcp: Show diagnostics`** (command) to see which integrations the plugin currently detects.

### Code Mode (token-lean surface)

Registering ~40+ tool schemas costs context in every session. A connection whose bridge runs with **`--code-mode`** (append it to the registered command: `… node ~/.claude/vault-mcp/bridge.mjs --vault <name> --code-mode`, or set `VAULT_MCP_CODE_MODE=1`) gets just **3 meta-tools** over the same registry: `obsidian_search_tools` (keyword discovery), `obsidian_describe_tool` (input JSON Schema), `obsidian_call_tool` (invoke by name, args validated against the target's schema). Read-only mode and the path allowlist bind on the target tool exactly as on the full surface. The mode is chosen per connection via a one-line preamble the bridge sends before the MCP stream — old bridges and full-surface sessions are wire-compatible, and both kinds of session can run concurrently against the same vault. If the vault's plugin build predates preamble support, the bridge warns on stderr and falls back to the full surface rather than failing.

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

It records the *operation* — what happened, to what, on whose behalf — not the bytes; git already covers the bytes. `actor.server` is the transport's own assertion of identity: which **vault**, which **install** (a persistent id in `.obsidian/plugins/vault-mcp/install-id.json`, minted once and kept beside the journal), and which plugin **version** — so a journal copied off the machine, or two vaults' journals read together, stays attributable. The `initialize` handshake carries the vault name too, in `serverInfo.title`. `durationMs` is the handler alone and `queueWaitMs` is the time spent waiting behind other writes, so a slow operation and a queued one are distinguishable; `revBefore` is probed when the operation reaches the front of the queue, not when it was enqueued. Operations that name no vault path (running a command, toggling a plugin, an `obsidian_cli` invocation) record `target.ref`, e.g. `"command:editor:toggle-bold"`.

### Advisory scope claims

Two agents working the same folder can at least *tell each other so*. `obsidian_claim_scope` takes a **scope** (a vault path prefix), a **reason**, and an optional `ttl_ms`, and returns a claim id.

**It is advisory and nothing else.** A claim blocks no one, queues nothing, and refuses nobody:

- **Overlapping claims by different holders are allowed** — and the claim response *lists* the ones it overlaps, with holder and reason, so the claimer knows who else is here.
- **A write inside somebody else's live claim still happens.** What it gains is a notice: an extra line on the result (`advisory lock: claude-code/1.0.0#m1x8g-3 claims Projects/Alpha (restructuring), expires in 214s`), an `advisory_locks` entry in the structured result, and a `lockNotice` field on the journal record. Your own writes inside your own claim get nothing — claiming a scope is how you say you're working in it.
- **Claims expire on their own** — default 5 minutes, maximum 30. A holder that crashes or disconnects cannot wedge a scope; expiry is lazy, so an expired claim is simply gone the next time anyone looks. Re-claim to extend, `obsidian_release_scope` to drop it early. `obsidian_list_scope_claims` shows every live claim.

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
