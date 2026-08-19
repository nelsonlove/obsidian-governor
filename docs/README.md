# vault-mcp kernel — documentation

This directory documents the **vault-mcp kernel**: the governed write substrate that
turns the plugin's `obsidian_*` tools from "an agent editing files" into "an agent
proposing changes that a human reviews and accepts." It is the plugin-side half of the
[Assent](#how-the-pieces-fit--the-assent-review-channel) review channel.

The top-level [`README.md`](../README.md) is the user-facing overview (install, the tool
surface, the socket/bridge architecture, the path allowlist). These docs go deeper on the
**kernel** and the **acceptance model** it exists to protect.

> These docs track **`main`** (the kernel shipped in v0.7.0; current release **0.8.0**),
> plugin package `packages/plugin/`. The last full line-by-line verification pass ran at
> pre-ship head `bc1a8a1`; file references are given so each claim is checkable against
> current source.

## Read in this order

| Doc | What it covers |
| --- | --- |
| **[acceptance-model.md](acceptance-model.md)** | **The heart of the design.** Acceptance is human-only — "the accept verb goes in no API." The accept-forbidden guard at the shared write primitive, on every write surface that routes through it (including the CLI proxy), and its documented residuals (tracked publicly; not yet all closed). |
| [kernel-v0.md](kernel-v0.md) | Kernel v0 primitives: the serialized write queue, the append-only write journal, `if_rev` optimistic concurrency, idempotency keys, advisory scope locks, and server/install identity. |
| [identity-and-links.md](identity-and-links.md) | The identity substrate: the uid index, `uid:` addressing that survives rename/move, link healing, `obsidian_check_links`, `obsidian_repoint_link`, and read-boundary containment. |
| [agent-writes.md](agent-writes.md) | The agent-facing write/review surface: **B1** `obsidian_write_notes` (batch write + opt-in `stamp`), **B2** agent change-`intent`, and **B3** `obsidian_pending_review`. |
| [modules.md](modules.md) | The module system: the `ModuleRegistry` + mount, settings-toggleable capability modules, the read-only mount gate, and the accept/baseline tripwire. |
| [scope-provider.md](scope-provider.md) | The scope provider module: Johnny Decimal `jd:` addressing and read-only allocation (compute, not reserve). |
| [vocabulary.md](vocabulary.md) | The vocabulary provider module: read-only validation of tags, properties, types, and glossary terms. |
| [crosssession.md](crosssession.md) | The cross-session channel module: coordination-log discovery by frontmatter, delta reads, read-receipt attestation, and posting refused while stale (`stale_read`). |
| [triage.md](triage.md) | The inbox-triage module: the disposition substrate (#221) and its second instance (#241 phase-3 shape) — three built-in primitives plus human-declared disposition rows over inbox notes, Base-backed queues, one dry-run-by-default guarded tool, no pane. |
| [conformance.md](conformance.md) | The TS conformance engine: rule packs, the ratchet (baseline-diffed findings), the ported legacy checks, and the headless CLI. |
| [reference.md](reference.md) | The precise operational contracts: addressing (`uid:`/schemes), write queue & journal semantics, `if_rev`/idempotency, advisory claims, the path allowlist and its oracles, external-tool trust, Code Mode. |

## How the pieces fit — the Assent review channel

The kernel exists to make agent writes **reviewable** without making them **unsupervised**.
The end-to-end shape:

```
   agent (Claude Code)                    vault-mcp kernel                     human
   ───────────────────                    ────────────────                     ─────
   obsidian_write_note(s) ─┐
   append / patch / move ──┼─▶ serialized write queue ─▶ note written ─┐
   manage_frontmatter ─────┤        (one at a time)                    │
   obsidian_cli ───────────┘                │                          │
                                            ▼                          ▼
                     accept-forbidden guard ⟶ REJECTS any write     write journal
                     ("proposed" is fine;      that introduces        (op/actor/rev/
                      "accepted" is refused)    acceptance             session/intent)
                                            │                          │
   obsidian_pending_review ◀────────────────┼──────────────────────────┘
   (read: what's under review)              │                          │
                                            ▼                          ▼
                                    Acceptance review pane ◀── reads journal + baseline
                                    (obsidian-stewardship)     publishes pending-index.json
                                            │
                                            ▼
                                    human accepts / reverts  ◀── the SOLE accept authority
```

- **Governed agent writes** flow through the kernel: one serialized queue, one journal
  record per operation, optimistic concurrency, idempotent retries.
- **Agents can stamp identity** (a created-seeded UUIDv7 `uid`, `created`/`modified`,
  canonical frontmatter order) and **attach an advisory `intent`** ("why I'm making this
  change") that rides the journal record — but stamping itself **never writes acceptance**
  (it defaults and preserves `acceptance-status`, never mints or elevates it); the guard against
  acceptance arriving by other routes is the shared write primitive, and its known gaps are
  tracked (see the top-level [README's Honest limits](../README.md#honest-limits)).
- **Agents can see what's pending** via `obsidian_pending_review`, so a well-behaved agent
  avoids stepping on a note a human is about to review.
- **The human keeps the sole accept veto — by design, and by enforcement on the surfaces the
  guard covers.** Acceptance is a gesture made in the
  **[Acceptance review surface](#the-acceptance-review-surface)** — never through a tool, agent,
  or CLI call the guard sees. The kernel enforces this structurally where it's wired in (see
  [acceptance-model.md](acceptance-model.md) for the mechanism and its named, tracked
  residuals).

### The governance module (the Acceptance capability)

**Naming, ruled (#115, 2026-08-19):** `governance` is the canonical identifier — it is the
shipped module id, settings key, and source directory, and renaming a shipped id is a
compatibility event with no offsetting benefit. *Acceptance* remains the capability's
descriptive name in prose (the module's `capabilities: ["acceptance"]` entry). One id, one
capability name, no third synonym; *Stewardship* is legacy vocabulary for the pre-fold
standalone plugin (decommissioned 2026-08-18, #164).

The fold this section once anticipated has long since landed (#83, 0.8.3) and been built
out through the acceptance convergence (#230): the governance module IS the review surface
— it reads the write journal and its own baseline store, renders the review pane (pending /
Proposed / Revising sections, Queue ⇄ History toggle), and is where a human accepts,
reverts, adopts, or requests changes. The accept veto is protected by *in-realm
unreachability* (no commands, gesture-gated handlers, module-scope closures) — see
[acceptance-model.md](acceptance-model.md). The read-only `obsidian_pending_review`,
`governance_revisions`, and the agent-facing `governance_submit_revision` are the module's
only transport-visible surfaces; none exposes an accept verb.

## README lives in the vault too

`README.md` is symlinked into the Obsidian vault (`00.89 Assent/Build/vault-mcp README.md`),
where vault machinery (the Linter, fileclass stamps) may add YAML frontmatter to it. A git
**clean filter** (`scripts/strip-frontmatter.sh`, bound via `.gitattributes`) strips any
leading frontmatter block when git reads the file, so the committed blob never carries it and
`git status`/`diff` treat the working file as unmodified however much frontmatter the vault
side adds. One-time setup per clone:

```bash
git config filter.stripfm.clean "sh scripts/strip-frontmatter.sh"
```

A clone without that config still works — committed content is already clean. Body edits
made from the vault side DO show as ordinary git diffs (by design: inbound suggestions to
review, commit, or discard).

## Release history note

Tags begin at `0.4.x` and jump to `0.7.0`: **0.5.0 and 0.6.0 were built and deployed
locally during development but never tagged or released**, so the tag history and
`versions.json` deliberately omit them (documented here per #102 rather than backfilling
tags for builds whose exact bytes are unrecoverable).

## Status & verification

- **Shipped.** The kernel is on **`main`** — PR #65 merged and released as **v0.7.0**
  (GitHub release, BRAT-installable); current release **0.8.0** adds the command-policy
  guards, root-exclusion, the kernel-test flake fix (#96), and the Phase-1 conformance
  engine. `main` is trunk; all work branches off it.
- **Tests.** The workspace suite is green on `main` at each merge (the merge policy requires
  an independent review and a green suite — `tsc --noEmit` and the production esbuild run as
  part of it). *(Reproduce: `npm install && npm test --workspaces` from the repo root; the
  plugin suite needs `@vault-mcp/core` built first — the monorepo wiring handles this.)*
- **Deployed.** The kernel through the module-host mount, B1/B2, the CLI accept-guard,
  `jd:` addressing, and B3 `obsidian_pending_review` are deployed (0.8.0 released and
  installed); the review plugin's pending-index publisher is live. Live-verification passes
  are recorded per-PR in the project's build records rather than restated here.
- **Known-open perimeter issues** (tracked publicly, milestone `0.8.1 — perimeter`): the
  standalone `packages/server` fs-failover surface now **does** enforce the accept-forbidden
  guard — it is applied in `VaultImpl`, the shared primitive both that surface and the
  `FilesystemBackend` delegate to — but **#104 remains open**: the guard decides frontmatter
  values over a hand-rolled YAML subset, so constructs the vault's real YAML honors but the
  subset does not model are still a gap; `moveNote`'s backlink rewrite is an unguarded
  content write; and a live-vault read-back confirming the guard recognizes everything
  Obsidian honors is still owed. Of the tools tracked by **#105**, only `obsidian_run_command`
  is gated. `obsidian_create_note_from_template` is **not**: #79 gated the `obsidian_cli`
  twin (`create template=`) in `tools-cli.ts`, while the MCP tool lives in
  `tools-integrations.ts` and calls Templater directly, reaching neither that guard nor
  `obsidian-backend`'s. `fileclass_insert_fields` is not gated either. The acceptance model's guarantees below are stated for the **plugin's guarded write
  surfaces**; these issues are the honest boundary of that claim until closed. **Separately** (#92): that same `packages/server`
  fs-failover surface has no write journal and no serialized write queue either — those
  live in the plugin's kernel, which `packages/server` does not and must not depend on. FS-mode
  writes are refused by default (`Error [fs_writes_disabled]`) and require an explicit,
  documented opt-in (`VAULT_MCP_FS_ALLOW_WRITES=true`); when enabled, writes made in FS mode
  are **not** journaled or serialized against concurrent connections until Obsidian
  reconnects. "Every write is journaled" is true of the **plugin's kernel-guarded path**
  only, never of this fallback.
