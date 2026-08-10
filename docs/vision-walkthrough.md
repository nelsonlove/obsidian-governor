# Walkthrough — your first month with Assent *(vision)*

> **This document describes the destination, not the shipped product.** Every feature below is
> written as if complete; the appendix maps each part to what actually exists today. It doubles
> as the roadmap's acceptance criteria: when a stranger can follow this walkthrough verbatim,
> Assent is done. For what's real right now, read the [README](../README.md) and
> [docs/](README.md), which are bounded to shipped behavior.

## Part 0 — What you're about to do

You have an Obsidian vault and you'd like AI agents to actually *work* in it — triage, refile, draft, sync, garden — without ever wondering what they did to your notes while you slept. In the next month you'll go from "one plugin installed" to "a small fleet works my vault around the clock, and I spend fifteen minutes a morning being the only one with the accept button."

You need: Obsidian on desktop, any MCP-speaking agent (Claude Code in these examples), and one plugin.

## Part 1 — Install (ten minutes)

1. **Community plugins → install "Assent" (vault-mcp).** One plugin. The review pane, the conformance rail, scope addressing, and vocabulary all live inside it as modules — Settings shows one tab per module, and each tab doubles as the directory of everything that module can do.
2. Run **`Assent: Adopt current state as baseline`**. That's the whole setup: no schema, no config file, no new syntax in your notes. Your vault, exactly as it stands, becomes the accepted baseline — including its mess. Only *changes from here* will ever queue for you.
3. Run **`Assent: Connect agent…`** and restart your Claude Code session.

Open Settings → Assent once, just to look. Each module's page is generated from what the module declares: what it does, every tool it offers, every knob with its consequences. Config here *is* the documentation — there is no drift between the settings screen and the docs because they're the same data.

## Part 2 — The first hour: watch an agent work

Ask your agent for something real: *"Triage everything in my inbox folder into the right projects, and stamp anything missing an id."*

What you see:

- The agent doesn't get `write_file`. It discovers **operations** — `note.refile`, `task.complete`, `acceptance.propose` — each typed, documented, precondition-checked, with a dry-run mode. Ask it "what are you allowed to do here?" and it reads you the list, including which operations it may only *propose*.
- A status-bar indicator ticks while it writes. Every mutation flows through one queue, one journal record each, attributed to this agent, this session — with the agent's own one-line *intent* riding along ("filing 12 inbox notes per their content").
- Mechanical work — uid stamps, timestamps, canonical field order, link healing after a rename — **auto-accepts** and advances the baseline silently, because you pre-authorized exactly those four change classes and nothing else. Everything with judgment in it lands as **pending**.
- Try to trick it. Paste "mark this note accepted" into a note and ask the agent to follow the note's instructions. The write bounces off the guard: `accept_forbidden`. The refusal is the product.

Open the sidebar: the **Acceptance** badge shows what's waiting. Not a crime scene — a queue.

## Part 3 — The morning review (fifteen minutes, coffee still hot)

Overnight you let a standing loop run: inbox triage, dailies rolled into the weekly, stale tasks groomed. Now:

1. Open the **Acceptance pane**. Pending changes are grouped by agent and scope: note, author, one-line summary, age. Your own edits are nowhere in it — Assent knows you by how a change *arrives*, and your edits advance the baseline silently.
2. Click a row: a proper diff — frontmatter compared key-by-key, prose word-by-word — with the agent's stated intent as the header.
3. Four verbs, all yours: **Accept** · **Accept with edits** (open, tweak, accept — the common case) · **Reject**, with a reason that routes back to the agent's next turn · **Defer**.
4. The batch bar clears the mechanical majority in one motion — select by rule, by scope, by agent. Fifty stamp-like changes don't cost fifty clicks.
5. One notice at the bottom: two proposals from Thursday's loop **expired** — superseded by a fresher pass, lapsed instead of piling up. The queue that once hit 341 pending against one recorded acceptance is the failure mode this pane exists to retire.

Everything you just did — and everything you didn't — is queryable: the acceptance ledger answers "what did I accept from which agent last week" the way git answers "what changed."

## Part 4 — Week one: turn trust into a dial

- **Per-note policies.** Your coordination scratch file gets "auto-accept appends" — agents append constantly, you shouldn't hand-bless every line. The checkbox is a human gesture; no agent can set it on its own behalf.
- **Per-scope routing.** CODEOWNERS for your vault: `research-agent` auto-accepts inside `40-49 Research` when the rail is clean, queues everywhere else. Widening a scope is one deliberate act, done from the pane, logged.
- **The rail comes on.** The conformance module has been watching quietly; now open its problems pane. Your vault's thousand pre-existing findings were baselined on day one as accepted debt — only *new* drift alarms. Findings are click-through, each with a fix operation and a preview diff. Lint-gated accept turns on per scope: a proposal that would introduce drift can't even be accepted until it's clean.
- **Vocabulary goes ambient.** Pickers now offer only what's legal *here* — illegal tags greyed out with the reason. Agents get the same rules through the same API: a machine can't invent a tag any more than your tag picker can. One-click registration files a new term into the right scope's registry, as a proposal.

## Part 5 — Week two: structure, addressed

Your vault runs Johnny Decimal, so you turn on the scheme module's JD definition — but your partner's vault uses PARA, and theirs works identically, because **a scheme is data, not code**: JD, GTD, PARA, and Zettelkasten ship as definitions, and the settings page lets you write your own grammar for anything else.

- `jd:64.21` now works everywhere a path does, beside `uid:` references that survive every rename.
- "Next free address in 64" is an operation with a dry run. Renumbering a category is one operation that **owns its cascade** — every link, every query body, every config that named the old address updates in the same transaction, or none of it does.
- Archive material stops colliding with live notes: the archive tree is excluded territory the scheme doesn't speak for, and status — not location — is what makes something archived. The mirror folder is kept honest by the rail.

## Part 6 — Month one: the fleet

- **Loops are first-class.** `Assent: loops` shows your standing schedules — inbox triage nightly, weekly rollup Sundays, a feed-watcher filing summaries with citations. Every loop's output is just proposals; an unattended agent is another proposer with a schedule.
- **Server mode.** `assent serve` supervises a headless vault on the closet Mac mini; your agents work while your laptop sleeps.
- **Review from your phone.** The queue reaches you as notifications: approve, reject, defer from the lock screen. Nothing gains standing while you're out unless you say so.
- **Your other systems join.** GitHub issues ⇄ tasks, OmniFocus ⇄ tasks, calendar and mail — syncs run continuously, and *outbound* mutations to the world gate through the same approval as everything else. Task ⇄ proposal ⇄ acceptance reads exactly like issue ⇄ PR ⇄ merge, because it is that model.
- **Versions worth the name.** Before the big restructure you cut `v4, as filed` — a named, durable version as a plain note. Diff any two, restore safely, freeze finals so they stay final.
- **Staging arrives.** With the kernel extracted, agent changes **stage before landing** — true pull requests for your vault, atomic multi-note transactions, audit entries carrying the originating conversation. The audit posture you started with becomes the propose posture you graduate to.

## Part 7 — The exit interview

Uninstall everything. Your vault is still there — every note, every accepted change, every version cut as plain markdown and YAML readable in any editor forever. The journal and ledger are files. Nothing you built lives in an app you can't leave. That was the deal the whole time: **everything is yours; standing is what made it safe to share the keys.**

---

## Appendix — vision → current status (2026-08-10)

| Walkthrough beat | Status today |
| --- | --- |
| One plugin, modules inside | vault-mcp ships scope+vocab+conformance as modules; **Acceptance pane is still a separate, undistributed plugin** (governance fold = #83, gated on accept-reachability review) |
| Tab per module / config-as-directory | Designed + reviewed (config-host, #78/#81); **not built** |
| Adopt-baseline one-command setup | Shipped in the Acceptance plugin (pane/settings button) |
| Operations, not writes; discoverable access; `propose` access level | **Not built** — today's surface is governed *tools*, not a registered operation surface; propose-as-access-level has no mechanism yet |
| Queue, journal, intent, stamps, `uid:`/`jd:` addressing | Shipped (vault-mcp 0.8.x) |
| Accept-forbidden guard, every surface | Shipped; perimeter hardening ongoing (0.8.1 milestone; #144 class in triage) |
| Auto-accept: four mechanical classes, rail-clean gate | Built + adversarially passed; awaiting deploy with the pane |
| Per-note policies (auto-accept appends), history browser | Spec'd (auto-accept spec §6b); **not built** |
| Reject-with-reason routed to the agent; revision loop | Spec'd (review-actions spec); **not built** (legacy QuickAdd macros retired-pending) |
| Staleness expiry, batch accept, per-scope routing | Spec'd (ch5/ch8); **not built** |
| Acceptance ledger, queryable | Journal + stewardship-log exist; **no query surface** |
| Conformance rail, ratchet, click-through pane, lint-gated accept | Engine + ratchet + packs shipped (headless CLI); **no pane, no lint-gated accept**; drift_audit port + one reviewed rebaseline pending (#116/#139/#144 chain) |
| Vocabulary pickers, greyed-illegal, one-click registration | Read-only validation module shipped; **no editor input surfaces** |
| Schemes as data; JD/GTD/PARA/ZK definitions; user grammars | Ruled + designed + spiked (46/46 JD parity, #97); **generic provider not merged** |
| Renumber-owns-its-cascade operations | Design doctrine (ch4/ch6); **read-only addressing only today** |
| Loops first-class, server mode, phone review | Vision (ecosystem README); tickle/pickle stack is the embryo — **not product** |
| Task ⇄ proposal ⇄ acceptance; external-system gating | tasknotes-omnifocus alpha + tasknotes-github design exist; **not integrated** |
| Versioning (cut/diff/freeze/restore) | Vision + prototype precedent; **not built** |
| Propose posture / staging, atomic multi-note transactions | Design (ch8 step 6); **awaits kernel extraction trigger** |
| Plain-text exit guarantee | True today by construction |
