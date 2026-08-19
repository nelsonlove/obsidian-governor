# Governor

**Let AI agents do real work in your Obsidian vault — without giving up control of it.**

*Formerly “vault-mcp.” The plugin **id** stays `vault-mcp` (it is plumbing — folder, socket namespace, tool prefixes, the plugin-to-plugin API key); **Governor** is the product. Like a mechanical governor: the device that lets a powerful engine run hard while keeping it inside limits you set.*

Governor is an Obsidian plugin that connects AI agents (Claude Code, or anything that speaks
MCP) to your vault the *governed* way: agents see your vault the way Obsidian does, every change
they make is recorded and attributed, and one rule is enforced at the shared write primitive:
**an agent cannot mark its own work as accepted through it. That's yours.**

> **Desktop only.** Uses Node `net`/`fs` from Obsidian's renderer; `isDesktopOnly: true`.

## Why this exists

Agents write fast. Trust builds slow.

Give an agent raw file access to your vault and you get mystery diffs, YAML mangled at 3 a.m.,
and no way to answer "what changed while I slept, and why." Deny access and you're hand-copying
text between a chat window and your notes. Every existing middle ground is a half-measure:
read-only access (the agent can't help), git archaeology (that's not review), or prompt
discipline ("please don't touch my frontmatter" is not a security model).

vault-mcp is the whole measure: **agents propose, you decide, and the machinery — not a prompt —
keeps it that way.**

## What you get

- **Agents that see your vault like Obsidian does.** Live backlinks, link resolution, Dataview
  queries with real types, Templater, Metadata Menu schemas — not a folder of text files parsed
  from disk. Answers are canonical because they come from the running app.
- **A paper trail for everything.** Every mutating operation through the plugin's guarded path
  lands in an append-only journal: what happened, to which note, by which agent, in which
  session — and, when the agent says so, *why*. (The optional headless FS-fallback mode is a
  documented exception — see [Honest limits](#honest-limits).) "What did it do while I was out"
  becomes a file you can read.
- **Nothing gets accepted without you.** An agent may mark its work `proposed`; a guard at the
  shared write path rejects any attempt — through any tool, any value type, any smuggling route
  we've found (and we keep looking) — to write `accepted`. Reviewing and accepting is meant to
  happen only in a human-only review pane (the companion **Acceptance** plugin) — never through
  the API on the surfaces the guard covers today; the surfaces it doesn't cover yet are named,
  tracked gaps, not silent ones (see [Honest limits](#honest-limits)).
- **Notes that don't get lost.** Address a note by its frontmatter `uid:` and the reference
  survives every rename and move. Johnny Decimal user? `jd:06.11` works everywhere a path does.
  Moves heal their own backlinks; a link-health report names what's drifted (and repairs nothing
  without you).
- **Agents that don't trample you — or each other.** One write at a time through a queue,
  compare-and-set so nobody clobbers what they didn't read, safe retries, and advisory claims so
  two agents working the same folder can see each other coming.
- **A trust dial, not a trust leap.** Read-only mode. A path allowlist that sandboxes a session
  to one part of the vault — reads included. Dangerous commands off by default. Third-party
  tools distrusted until you say otherwise.
- **CI for your vault.** A conformance engine checks structure and vocabulary against what your
  vault declares, with a ratchet so pre-existing mess is baselined and only *new* drift alarms.

## Five minutes in

1. Install and enable the plugin, run **`vault-mcp: Connect to Claude Code`**, restart your
   Claude Code session.
2. Ask the agent to do something real — "triage my inbox notes into the right projects."
3. Watch it work with real tools instead of raw file writes — and check
   `obsidian_pending_review`: the agent can see which notes await your review and stays off them.
4. Open the journal (or the Acceptance pane, if installed): every change is there, attributed,
   diffable, waiting for your verdict. Accept, revert, or shrug — your call, made once, in one
   place.

## Install

1. **Build** (or grab a [release](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/releases) — BRAT-installable):
   ```bash
   npm install && npm run build      # emits main.js (bridge embedded) + manifest.json
   ```
2. **Copy into your vault** and enable it:
   ```bash
   cp main.js manifest.json <vault>/.obsidian/plugins/vault-mcp/
   ```
   Then Settings → Community plugins → enable **Vault MCP**.
3. **Connect Claude Code** — run **`vault-mcp: Connect to Claude Code`** from the command
   palette (one-time; it registers the bridge with `--vault <this vault>` pinned; the exact line
   is always in **Settings → Vault MCP** if you'd rather paste it yourself).
4. **Restart any open Claude Code session** — MCP servers load at session start.

Running the remote [`obsidian-vault-mcp-server`](https://github.com/nelsonlove/obsidian-vault-mcp-server)
too? Disconnect it for sessions using this plugin — they share `obsidian_*` tool names by
design, and this one's answers are canonical.

## The one rule

**Acceptance is a human gesture, and it goes in no API.** There is no accept tool, no accept
argument, and no way to smuggle acceptance in as data **through the shared write primitive**: it
rejects any write that would introduce `acceptance-status: accepted` (or `accepted-by` /
`accepted-on`), on every write surface that routes through it — including the CLI proxy — while
leaving your own existing accepted values untouched. A handful of surfaces don't route through
it yet; those are named, tracked gaps, not silent ones — see [Honest limits](#honest-limits).
Accepting stays a person's gesture in the
[Acceptance](docs/README.md#the-acceptance-review-surface) review pane.

This is the heart of the design — documented in full, including its honest limits and the
currently-open hardening work, in **[docs/acceptance-model.md](docs/acceptance-model.md)**.

## Honest limits

- **Detection and recovery, not prevention.** Obsidian can't intercept disk writes; anything
  promising otherwise is theater. The guarantee is narrower and real: nothing arriving through
  a surface the guard covers can forge acceptance, every write on the plugin's guarded path is
  journaled, and out-of-band changes surface as drift.
- **The FS-fallback path is the one documented exception to "journaled."** The headless
  filesystem-failover mode in `packages/server` — refused by default, explicit opt-in only —
  writes with no journal and no serialized queue until Obsidian reconnects
  ([#92](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/issues/92)). Every claim above
  about journaling is scoped to the plugin's guarded path, not this fallback.
- **Actively hardened, in the open.** The write perimeter is under continuous adversarial
  review; known gaps are tracked as public issues on this repo (milestone `0.8.1 — perimeter`)
  rather than papered over. The docs bound every claim to what's actually shipped.
- **The guard doesn't cover every surface yet — named, not papered over.** Templated note
  creation ([#137](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/issues/137),
  [#105](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/issues/105)), CLI flag-form
  arguments ([#107](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/issues/107)), and a
  couple of lower-severity paths can currently introduce or resurrect acceptance without going
  through the guarded primitive. Each is a public, tracked issue; the full residual list lives
  in [docs/acceptance-model.md](docs/acceptance-model.md).
- **The review pane ships separately today** (the Acceptance plugin, folding into vault-mcp as
  a governance module). vault-mcp is fully useful without it — you just read the journal
  instead of clicking a queue.

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

- The plugin runs an MCP server in Obsidian's renderer and listens on a per-vault **Unix
  socket** (`~/.claude/vault-mcp/<vault-slug>.sock`, `chmod 600` — the only auth boundary).
- A tiny bundled **`bridge.mjs`** (written to `~/.claude/vault-mcp/` on load) is what Claude
  Code spawns; it proxies stdio ↔ the socket.
- A fresh MCP server is built **per connection**, so multiple sessions and background agents
  share the plugin without evicting each other.

## Tools

**On the order of 55–60 tools**: core read/write, batch writes with server-side identity
stamping, search, navigation, `uid:`/`jd:` addressing, link health, advisory claims,
controlled-vocabulary validation, a pending-review view, and integrations that light up when
their backing plugin is present (Dataview, Templater, Omnisearch, Metadata Menu, the official
Obsidian CLI). Scope and vocabulary tools come from settings-toggleable
[capability modules](docs/modules.md). Run **`obsidian_doctor`** to see what your setup exposes.

Context-conscious sessions can use **Code Mode** (`--code-mode` on the bridge command): three
meta-tools — search, describe, call — over the same registry, with every guard binding on the
target tool exactly as on the full surface.

The full tool-by-tool breakdown, and the precise semantics of addressing, the write queue and
journal, the path allowlist, and third-party tool trust, live in
**[docs/reference.md](docs/reference.md)**.

## Settings (Settings → Vault MCP)

- **Claude Code connection** — status + the `claude mcp add` line + copy button.
- **Read-only mode** — blocks all mutating tools; reads still work.
- **Allow dangerous CLI commands** — off by default; gates code-executing/app-controlling CLI
  commands. Command-level allow/deny policy is also settings-driven and fails closed on the
  opaque command classes.
- **Trusted read-only plugins** — third-party tools claiming read-only are treated as mutating
  unless their plugin id is listed here. See [reference](docs/reference.md#external-tool-trust).
- **Path allowlist** — one vault-relative prefix per line (empty = whole vault); sandboxes a
  session for reads and writes alike. See [reference](docs/reference.md#the-path-allowlist).
- **Scheme & vocabulary modules** — per-module toggles and configuration (Johnny Decimal
  instance, excluded roots, vocabulary sources).
- **Enforce record immutability** — on by default; refuses non-append writes to notes carrying
  `record: true` (historical archives are extended by a dated end-of-file append, never edited,
  moved, or deleted). See [reference](docs/reference.md#records).
- **Disable socket** — stops the server without uninstalling the plugin.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Claude Code says the MCP is unreachable | Obsidian isn't running, or the plugin is disabled. Open Obsidian / enable the plugin. |
| "auto register failed, no such file or directory" | The `claude` launcher needs `node` on PATH; the plugin augments PATH with `/opt/homebrew/bin` + `/usr/local/bin`. If your `node`/`claude` live elsewhere, run the `claude mcp add` line manually in a terminal where `claude` works. |
| Tools don't appear in a session | You registered after the session started — restart the Claude Code session (MCP loads at start). |
| Multiple vaults open | The registration must pin `--vault <name>` (Connect does this); `obsidian_doctor` reports the bound vault. Re-run Connect or add `--vault <name>` to the existing entry. |
| A plugin-gated tool is missing | Its backing plugin isn't loaded. Enable it; the tool appears on the next session connect. |
| A write failed with `Error [write_timeout]` | The operation ran past the queue's 30s budget and was abandoned so the queue could continue. Re-read the target (it may be partially written), then retry with a smaller batch. |

## Documentation

- **[docs/reference.md](docs/reference.md)** — the precise contracts: addressing (`uid:`, schemes), write queue & journal, `if_rev`/idempotency, advisory claims, the path allowlist and its known oracles, publishing tools from other plugins, external-tool trust, Code Mode.
- [The acceptance model](docs/acceptance-model.md) — the accept-forbidden guard, in full.
- [Kernel v0 primitives](docs/kernel-v0.md) — queue, journal, `if_rev`, idempotency, locks, identity.
- [Identity & links](docs/identity-and-links.md) — uid index, `uid:` addressing, link healing.
- [Agent write & review surface](docs/agent-writes.md) — batch writes, change-`intent`, `obsidian_pending_review`.
- [The module system](docs/modules.md) — the registry, the mount, toggling, the accept tripwire.
- [Scope provider](docs/scope-provider.md) · [Vocabulary provider](docs/vocabulary.md) — `jd:` addressing, placement, and mutation (assign/refile/renumber) and controlled-vocabulary validation (vocabulary provider is read-only).
- [Conformance engine](docs/conformance.md) — rule packs, the ratchet, the headless CLI.

Deep-dive index with the architecture story: [docs/README.md](docs/README.md).

**Where this is going:** [the vision walkthrough](docs/vision-walkthrough.md) — the whole product written as if shipped, with an appendix mapping every claim to today's status. The roadmap, in narrative order.

## Repo

`~/repos/obsidian-vault-mcp-plugin`. See `CLAUDE.md` for the locked architecture decisions.
