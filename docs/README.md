# vault-mcp kernel — documentation

This directory documents the **vault-mcp kernel**: the governed write substrate that
turns the plugin's `obsidian_*` tools from "an agent editing files" into "an agent
proposing changes that a human reviews and accepts." It is the plugin-side half of the
[Assent](#the-assent-review-channel) review channel.

The top-level [`README.md`](../README.md) is the user-facing overview (install, the tool
surface, the socket/bridge architecture, the path allowlist). These docs go deeper on the
**kernel** and the **acceptance model** it exists to protect.

> Everything here is verified against the source at branch `assent/kernel-v0`
> (head `bc1a8a1`), the plugin package `packages/plugin/`. File references are given so
> each claim is checkable.

## Read in this order

| Doc | What it covers |
| --- | --- |
| **[acceptance-model.md](acceptance-model.md)** | **The heart of the design.** Acceptance is human-only — "the accept verb goes in no API." The accept-forbidden guard at the shared write primitive, on every write surface including the CLI proxy, and its one documented residual. |
| [kernel-v0.md](kernel-v0.md) | Kernel v0 primitives: the serialized write queue, the append-only write journal, `if_rev` optimistic concurrency, idempotency keys, advisory scope locks, and server/install identity. |
| [identity-and-links.md](identity-and-links.md) | The identity substrate: the uid index, `uid:` addressing that survives rename/move, link healing, `obsidian_check_links`, `obsidian_repoint_link`, and read-boundary containment. |
| [agent-writes.md](agent-writes.md) | The agent-facing write/review surface: **B1** `obsidian_write_notes` (batch write + opt-in `stamp`), **B2** agent change-`intent`, and **B3** `obsidian_pending_review`. |
| [modules.md](modules.md) | The module system: the `ModuleRegistry` + mount, settings-toggleable capability modules, the read-only mount gate, and the accept/baseline tripwire. |
| [scope-provider.md](scope-provider.md) | The scope provider module: Johnny Decimal `jd:` addressing and read-only allocation (compute, not reserve). |
| [vocabulary.md](vocabulary.md) | The vocabulary provider module: read-only validation of tags, properties, types, and glossary terms. |

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
                                    Stewardship plugin  ◀── reads journal + baseline
                                    (the review pane)        publishes pending-index.json
                                            │
                                            ▼
                                    human accepts / reverts  ◀── the SOLE accept authority
```

- **Governed agent writes** flow through the kernel: one serialized queue, one journal
  record per operation, optimistic concurrency, idempotent retries.
- **Agents can stamp identity** (a created-seeded UUIDv7 `uid`, `created`/`modified`,
  canonical frontmatter order) and **attach an advisory `intent`** ("why I'm making this
  change") that rides the journal record — but they **can never write acceptance**.
- **Agents can see what's pending** via `obsidian_pending_review`, so a well-behaved agent
  avoids stepping on a note a human is about to review.
- **The human keeps the sole accept veto.** Acceptance is a gesture made in the
  **[Stewardship](#the-stewardship-plugin) review pane** — never through any tool, never by
  any agent, never through the CLI. The kernel enforces this structurally (see
  [acceptance-model.md](acceptance-model.md)).

### The Stewardship plugin

Stewardship is a **separate Obsidian plugin** (repo `obsidian-stewardship`). It is the
review *surface*: it reads the write journal and its own baseline store, renders a pending-
review pane, and is where a human accepts or reverts a proposed change. vault-mcp does not
import it and does not depend on it being installed.

The one contract between them is a file: Stewardship writes a read-only index at
`<config-dir>/plugins/stewardship/pending-index.json` on every review-queue refresh, and
vault-mcp's `obsidian_pending_review` reads it (see [agent-writes.md](agent-writes.md#b3--obsidian_pending_review)).
The coupling is one-directional and data-only — Stewardship publishes, vault-mcp reads.
Neither exposes an accept verb to an agent.

## Status & verification

- **Branch / PR.** All of this lives on `assent/kernel-v0` (head `bc1a8a1`), open as
  **draft [PR #65](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/pull/65) → `main`**.
  These docs land on `main` when that PR ships.
- **Plugin version.** `0.6.0` (`packages/plugin/manifest.json`).
- **Tests.** The full workspace suite is **green at head `bc1a8a1`**:

  | Package | Tests | Suites | Fail |
  | --- | --- | --- | --- |
  | `@vault-mcp/core` | 68 | 3 | 0 |
  | `obsidian-vault-mcp-plugin` | 1012 | 160 | 0 |
  | `obsidian-vault-mcp-server` | 48 | 10 | 0 |
  | **Total** | **1128** | **173** | **0** |

  `tsc --noEmit` is clean (it runs as part of the plugin `test` script), and the production
  esbuild bundles clean. *(Reproduce: `npm install && npm test --workspaces` from the repo
  root. The plugin suite requires `@vault-mcp/core` to be built first — the monorepo test
  wiring handles this.)*
- **Deployed & live-verified.** The kernel through the **module-host mount** is deployed and
  live-verified: vault-mcp `0.6.0` @ `56cfce0`, a toggle round-trip confirmed (56 tools →
  scheme module disabled via live settings → 51 tools on next connect → re-enabled → 56
  back), with `jd:` addressing confirmed to resolve at the kernel level even with the scheme
  module off. Stewardship's pending-index publisher is deployed live (v0.0.7) and verified.
  The final slices layered on top — B2 `intent`, the CLI accept-guard, and B3b
  `obsidian_pending_review` — are **headless-verified** (unit-proven, full suite green) with
  live JSON-RPC confirmation queued for the announced integration-deploy window.
</content>
</invoke>
