# Governor — the whole-system map (0.11.0)

One document to orient a newcomer or a fresh agent session. It names each part of the
system in a paragraph or two and links out to the per-domain doc that carries the depth.
Claims here are checkable against `packages/plugin/src/` and the source-locked
[`TOOL-INVENTORY.md`](../packages/plugin/TOOL-INVENTORY.md); these docs track `main`
(current release **0.11.0**).

**Naming** (ruled 2026-08-19, see [docs/README.md](README.md)): the product is **Governor**;
the plugin **id** stays `vault-mcp` permanently (folder, socket namespace,
`mcp__vault-mcp__*` tool prefixes, the plugin-to-plugin API key); ***Assent*** is the broader
framework the plugin realizes; **`governance`** is the id of the acceptance module — the
in-Obsidian review pane where a human accepts.

## What Governor is

An Obsidian plugin embedding an MCP server with direct `app.*` access, so agents (Claude
Code, or anything speaking MCP) see the vault the way Obsidian does — live backlinks, real
link resolution, plugin integrations — instead of a folder of text files. The point is
*governed* agent access: agent writes are serialized, journaled, and attributed; identity
survives renames; a human review surface decides what becomes canonical. The design's one
rule — acceptance is a human gesture, and the accept verb goes in no API — is documented in
full, residuals included, in [acceptance-model.md](acceptance-model.md).

## Transport — socket, bridge, per-connection servers

- **Unix socket + bundled bridge, not HTTP.** The plugin listens on a per-vault socket
  (`~/.claude/vault-mcp/<vault-slug>.sock`, `chmod 600` — the only auth boundary; no token,
  no TCP port). A bundled `bridge.mjs` (embedded in `main.js`, written to
  `~/.claude/vault-mcp/` on load) is what Claude Code spawns; it proxies stdio ↔ socket and
  survives Obsidian restarts by queueing and replaying the `initialize` handshake.
- **A fresh `McpServer` per connection** (`buildMcpServer` in `src/mcp/server.ts`), so
  concurrent sessions and background agents share the plugin without evicting each other.
  Conditional registration at connection-build time is the dynamic-registration mechanism:
  new tools appear on the next session connect.
- **Per-connection options ride a one-line preamble** (`src/preamble.ts`): the bridge may
  send `{"vault_mcp_preamble":1,…}` as the connection's first line, gated on the vault's
  discovery file advertising `capabilities: ["preamble"]`. Today it carries `code_mode`.
- **Code Mode** (`--code-mode` on the bridge command, or `VAULT_MCP_CODE_MODE=1`): the
  connection gets 3 meta-tools (`obsidian_search_tools` / `obsidian_describe_tool` /
  `obsidian_call_tool`) over a captured registry instead of the full ~70-tool surface. The
  captured handlers carry the guard wrapper, so enforcement lands on the target call. See
  [reference.md](reference.md#code-mode-token-lean-surface).

## The guard + kernel v0

One interception point: `buildMcpServer` monkey-patches `server.registerTool`
(`src/mcp/guarded.ts`), and a tool is mutating iff `annotations.readOnlyHint === false`.
Read-only mode, the path allowlist, and all kernel-v0 machinery key on that single
discriminant, so "guarded", "serialized", "journaled" and "idempotent" are one set by
construction. The kernel primitives ([kernel-v0.md](kernel-v0.md),
[reference.md](reference.md) for exact semantics):

- **Serialized write queue** — one vault mutation at a time across all connections; reads
  don't queue. Each operation has a 30-second budget; expiry abandons that one call
  (`Error [write_timeout]`) and the queue moves on.
- **Write journal** — one JSONL record per mutating operation in
  `.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl`: op, target (path + uid), actor
  (transport / client / connection / server identity), args digest (bodies collapsed to
  `<N chars>`), outcome, timings, `effects` where an operation discovers its own blast
  radius. Append-only by design — late-settling operations get corrective `late-ok` /
  `late-error` records rather than edits.
- **`if_rev` + `idempotency_key`** — kernel arguments declared on each mutating schema and
  peeled before handlers run. `if_rev` is checked at the front of the queue (lose-update
  protection across concurrent sessions); `idempotency_key` collapses retries into the
  first call's envelope (10-minute window, 500-key LRU, in memory per plugin instance).
- **`intent`** — the third kernel argument: advisory agent-authored "why" text, recorded on
  the journal record and structurally unable to reach note content (peeled like `if_rev`).
- **Advisory scope claims** (`obsidian_claim_scope` / `renew` / `release` /
  `list_scope_claims`) — disclosure, not locking: overlapping claims are allowed and
  disclosed on results and journal records; claims expire (default 5 min, max 30); caps
  refuse rather than evict (50 per connection, 200 store-wide).
- **The uid index + `uid:` addressing** — `uid → path` built from Obsidian's metadata cache,
  kept current from vault events. Anywhere a tool takes a path it also takes `uid:<value>`,
  resolved at the interception point before the allowlist check; unresolved and ambiguous
  references refuse (`uid_unresolved` / `uid_ambiguous`), decided over allowlist-visible
  carriers only. See [identity-and-links.md](identity-and-links.md).
- **`jd:` scheme addressing** — `<scheme>:<address>` (default `jd:06.11`) resolves at the
  same interception point, immediately after `uid:`; kernel-level, so it stays available
  even with the scheme module toggled off.
- **Link healing** — moves route through `app.fileManager.renameFile` (Obsidian's
  link-updating rename), pinned by test; out-of-band drift is reported by the read-only
  `obsidian_check_links` (dangling links, duplicate uids, uid coverage) and repaired only by
  the deliberate `obsidian_repoint_link`.
- **Read-boundary containment** — the path allowlist bounds reads as well as writes:
  enumerate/search tools filter through `visiblePaths` *before* reading, resolution answers
  fail closed to "unresolved" rather than naming hidden paths, and the surfaces that can't
  be scoped honestly (Dataview queries, the raw CLI proxy, fileclass) refuse outright. Known
  residual oracles are documented in [reference.md](reference.md#the-path-allowlist).

## The acceptance perimeter

The floor: the shared write primitive refuses a write that would introduce or change the
accepted family — `acceptance-status: accepted`, `accepted-by`, `accepted-on` — with
`Error [accept_forbidden]`, across value types and body-embedded fences, while an exact
carry-forward of an existing human-granted value passes (a transition rule, not a snapshot
rule). Agents write `acceptance-status: proposed` (and `revising`/`proposed` transitions);
the accepted family is reserved for the human gesture. The enforcement point, its
recognition-parity history, and the named open residuals (#137, #105, #107, #153) are all in
[acceptance-model.md](acceptance-model.md) — read that before repeating any claim about
coverage.

On top of the floor, two generalizations:

- **Declared protected frontmatter properties** (#224): a human-declared list
  (Security › *Protected frontmatter properties*) enforced through the same two core
  predicates the accepted family rides. Two grades: **`agent-forbidden`** (agent transports
  may not introduce, change, or remove the property; byte-identical carry-forward passes)
  and **`authority-conferring`** (agent-forbidden *plus honor-only-if-blessed*: the value
  takes effect only once the write that set it is human-attributed or accepted in review —
  the governance module reads honored values from the blessed baseline, not raw
  frontmatter, so a side-door value stays inert until blessed, and surfaces in the review
  queue as a `(side-door)` row). The floor is not config: accepted-family checks run
  independently of the list, and config entries naming floor keys are dropped loudly.
- **Per-note auto-accept** (#135): `auto-accept` ships in the default declared list as
  authority-conferring. A human writes `auto-accept: appends` (append-only changes
  auto-accept — baseline must be a byte-prefix of current content) or `auto-accept: all` in
  a note's own frontmatter; the eligibility engine consults the honored policy from the
  blessed baseline, and each policy-driven auto-accept is logged with `policy: appends|all`
  in the acceptance log.

## The governance module (the Acceptance capability)

The `governance` module contributes **zero MCP tools** — its `enabled` flag (default off)
gates the in-Obsidian review surface, which mounts/unmounts live on toggle
(`src/governance/{pane,wiring}.ts`). What the pane gives the human:

- **The review queue**: pending write deltas (from the journal + the module's baseline
  store) with gesture-gated Accept / Revert / Request changes… / Adopt controls, plus a
  **Proposed** section (notes at `acceptance-status: proposed` with no pending delta) and a
  **Revising** section (withdraw a revision request). All state-changing controls are
  real-click gestures — no command, no MCP tool, no method reachable from `app`.
- **Context-aware Accept** (#221/#164 convergence): one Accept serves both lifecycles — on a
  `proposed` note it stamps the accepted family (`accepted-by` from the configured identity,
  `accepted-on` at minutes precision) and then advances the baseline from the post-stamp
  bytes; on any other note it advances the baseline byte-untouched.
- **The soft conformance gate** (#258): with `requiredFrontmatterKeys` configured and
  `gateMode: "soft"` (the default), Accept on a non-conforming `proposed` note opens a modal
  — **Accept anyway / Open note / Cancel** — so the override is a second explicit human
  click; `"hard"` refuses with a notice; `"off"` skips the check.
- **A history browser**: a Queue ⇄ History toggle switches the pane to a display-only view
  of past decisions from the acceptance log (newest first, capped, per-note filterable);
  it holds no accept capability.
- **The revision round-trip**: Request changes… inserts a `[!revision-request]` callout and
  sets `acceptance-status: revising`; the agent side reads requests via
  **`governance_revisions`** (read-only, allowlist-filtered) and resubmits via
  **`governance_submit_revision`** (an ordinary guarded mutating tool: status back to
  `proposed`, request callouts removed, optional `[!revision-report]` summary; refuses
  `not_revising`; the shared accept-forbidden rule re-checks its write). Both register
  unconditionally in `server.ts`, independent of the module toggle — as does the read-only
  **`obsidian_pending_review`** queue view.

Details and the disposition table (verbs as data, sorted by the authority axis):
[acceptance-model.md](acceptance-model.md); module posture and mount rules:
[modules.md](modules.md).

## Capability modules

Modules register through the `ModuleRegistry` mount (`src/mcp/modules-mount.ts`), behind the
accept/baseline name tripwire and a read-only gate that only a module declaring
`mutating: true` (an explicit review event) may pass. Module tools land at the same
guard-patched interception point as hand-registered tools. See [modules.md](modules.md).

- **`scheme`** (default on) — the scope provider ([scope-provider.md](scope-provider.md)):
  Johnny Decimal grammar as the first provider, config per instance (expanded areas/
  categories, content-decimal floor, `excludedRoots`). Six read tools (`obsidian_schemes`,
  `obsidian_validate_name`, `obsidian_resolve_address`, `obsidian_next_address`,
  `obsidian_list_scope`, `obsidian_expected_location`), all computed over allowlist-visible
  notes. The **write half** — `obsidian_assign_address`, `obsidian_refile_address`,
  `obsidian_renumber_address` (plan-then-apply over the shared `moveOne` move primitive;
  `dry_run` mandatory with no default; `on_occupied: fail|auto|manual` on renumber) —
  registers directly in `server.ts`, since the module host's gate refuses mutating tools
  from non-`mutating` modules.
- **`vocab`** (default on) — the vocabulary provider ([vocabulary.md](vocabulary.md)):
  read-only validation/resolution of tags, properties, types, and glossary terms over
  configured provider instances (`blueprint`, `glossary`, and — #251 — **`scope-tags`**:
  per-scope tag whitelists with chain inheritance, existence gated by registry notes
  (default fileClass `Meta/Tag`) and placement by `allowedTags` unioned up the folder
  chain; all live-vault shapes are config defaults, not hardwired). Four tools:
  `obsidian_vocabularies`, `obsidian_resolve_term`, `obsidian_validate_terms`,
  `obsidian_list_vocabulary`.
- **`skills`** (default off, mutating) — compiles the vault's skill/agent/policy/command
  notes into a Claude Code plugin: three read tools (`vault_skills_validate` / `_tree` /
  `_preview`) and three mutating (`_export`, `_release`, `_mark`); `vault_skills_mark`
  routes through the accept-forbidden write rule like the other frontmatter writers.
- **`provenance`** (default off, mutating) — the obsidian-provenance CLI fold:
  `provenance_check` (derived-note freshness against its `derived-from:` sources),
  `provenance_reconcile` (installed vs enabled vs noted plugins), and the dry-run-by-default
  `provenance_regen` (regenerates the plugin-audit note, preserving `<!-- human:start -->`
  sections). It stamps derivation metadata (`derived-from` / `generated` / `generator` /
  `derivation-mode`) — orthogonal to acceptance, with regen's write routed through the
  accept-forbidden rule.
- **`health`** (default off, read-only) — the obsidian-vault-health fold: `obsidian_health`
  (whole-vault scan, findings tiered by fix risk) and `obsidian_lint` (the same scan scoped
  to a folder or note). Report-only; deliberately not allowlist-scoped (a partial report
  would misreport orphans and duplicates).
- **`fileclass`** (default off, mutating, doubly gated) — proxies the standalone `fileclass`
  CLI (#188): registers only when the Fileclass plugin is loaded AND the CLI binary is
  found; six read tools plus the two writers `fileclass_set` and `fileclass_set_where`
  (the bulk `set_where` is dry-run by default, `apply: true` to commit), both
  accept-guarded before the CLI runs; the whole surface refuses while a path
  allowlist is active (CLI output can't be path-scoped).
- **`crosssession`** (default off, mutating) — the cross-session channel surface
  ([crosssession.md](crosssession.md), #232): channels discovered by fileclass +
  `audience:` frontmatter (not by path), `crosssession_delta` reads entries past your
  attested position, `crosssession_attest` records a read receipt (module state beside the
  journal, not note frontmatter), and `crosssession_post` refuses `stale_read` before any
  write while unread foreign entries exist. Handles are cooperative, not authenticated —
  the fallible-not-adversarial threat model.
- **`triage`** (default off, mutating) — inbox triage in the **phase-3 shape**
  ([triage.md](triage.md), #221/#241): three built-in primitives (trash / move / stamp) plus
  **human-declared disposition rows** in config (default: one row, `escalate` —
  stamp-in-place), merged into one table; a declared `choice` row binds a QuickAdd choice
  through the shared `executeChoice` seam (the binding is human-only config; choice rows
  can't dry-run and report `effects_unknown`). `triage_queue` serves the inbox-marker queue
  or a **Base-backed queue** (`{base, view?}` or a config-named `{queue}`) through the bases
  module's shared capture seam; `triage_dispose` is dry-run by default, moves ride the
  shared link-healing move primitive bounded by the configured move white/blacklist, and
  frontmatter patches re-check the shared accept-forbidden rule. No pane UI — human queue
  views are native Bases.
- **`bases`** (default on, read-only, feature-gated) — evaluated Base result sets:
  `base_list` + `base_query` via a hidden detached-leaf capture of Obsidian's own Bases
  engine. Full doc: [bases.md](bases.md).
- **The QuickAdd compile tool** — `obsidian_quickadd_compile` (Stage A of "QuickAdd macros
  as notes") registers directly in `server.ts`, not through the module host, because it
  mutates QuickAdd's own config rather than a vault note: it compiles Macro/UserScript
  choice notes (frontmatter `quickadd-type: macro`) into QuickAdd's live config via a scoped
  merge (only compiler-owned `qan:`-prefixed choices are touched), reports the diff in both
  modes, refuses `suspicious_mass_removal` and refuses outright under an active path
  allowlist.

Two further always-registered tools folded from the standalone `obsidian-jd-survey` plugin
(PR #242) live beside the scheme write tools in `server.ts`
(`src/mcp/tools-survey.ts`, `registerSurveyTools`): **`obsidian_survey_status`** (read-only
staleness of a note's `## Contents (Filesystem)` section against its filesystem mirror
directory) and **`obsidian_survey_slot`** (regenerate that section and stamp `survey:`
frontmatter; `dry_run` mandatory with no default). Mirror paths are real filesystem paths
the vault allowlist can't see, so both are checked against a declared content-root boundary
(`ASSENT_CONTENT_ROOT` / `ASSENT_VAULT_ROOT`) before any read; the slot write routes through
the shared append guard, and a section last stamped `by: "claude-code"` or `by: "human"` is
refused without `force: true`.

## The dev tool-runner

One palette command — **"Run tool…"** (shown prefixed with the plugin's display name:
"Governor: Run tool…") — gives a human the agent surface inside
Obsidian: fuzzy picker, schema-rendered args form, an explicit confirm step for mutating
tools, result modal. It invokes through the identical captured-registry path a Code Mode
`obsidian_call_tool` call takes, so the guard wrapper binds the same way, and its journal
records carry `client: "tool-runner"`. Full doc: [tool-runner.md](tool-runner.md).

## Dedicated CLI tools + the raw proxy

When the official Obsidian CLI binary is installed, five **dedicated pinned-subcommand
tools** register (`tools-cli-dedicated.ts`): `obsidian_note_history`, `obsidian_note_diff`
(both read-only, `path` allowlist-scoped), `obsidian_base_create` (content runs the standard
accept scan; refuses under an active allowlist), and the danger-gated
`obsidian_plugin_install` / `obsidian_plugin_uninstall`. `history:restore` is deliberately
not promoted (#110): restored bytes can't be scanned pre-exec. The free-text
**`obsidian_cli` proxy** is demoted behind the default-off Security › "Raw CLI proxy"
setting; when enabled, the command policy, danger gate, accept checks and deny sets apply as
documented in [acceptance-model.md](acceptance-model.md#the-obsidian_cli-proxy-path).

## The conformance rail + debt register

A headless TypeScript engine (`src/conformance/`) runs rule packs (scheme, vocab, and the
ported legacy checks) over a vault snapshot and diffs findings against an accepted baseline
— the **ratchet**: NEW findings gate, CARRIED ones are accepted debt burning down on the
human's schedule; a rebaseline is a human act ([conformance.md](conformance.md)). The debt
register (#211) adds a per-key metadata sidecar and two tools: the read-only
`obsidian_conformance_debt` (carried items, burn-down counts, staleness, budget status) and
the mutating `obsidian_conformance_debt_render` (materializes the register as a generated
note whose frontmatter is a derivation stamp, accept-checked before writing).

## External tools + trust

Other Obsidian plugins publish MCP tools via `app.plugins.plugins['vault-mcp'].api`
(`apiVersion: 1`; SDK: `vault-mcp-api`). The boundary is pure data: plain JSON Schema in,
plain JSON out, registered through the guarded path per connection. A published
`readOnly: true` is **distrusted by default** — believing it would exempt third-party code
from the queue, the journal, the allowlist, the kernel args and read-only mode at once — so
untrusted claims register as mutating unless the publisher's raw plugin id is listed in the
`trustedReadOnlyPlugins` setting. Mutating external tools with no recognized path key are
blocked outright while an allowlist is active. See
[reference.md](reference.md#external-tool-trust).

## Module defaults

`modules.<id>.enabled` overrides each default; toggles take effect on the next session
connect, except governance, whose pane mounts/unmounts live. Source of truth:
`builtinModules` in `src/mcp/modules-mount.ts`.

| Module | Default | Mutating? | Additional gate |
| --- | --- | --- | --- |
| `scheme` | **on** | read-only (write tools register outside the host) | — |
| `vocab` | **on** | read-only | — |
| `bases` | **on** | read-only | public Bases API (Obsidian 1.10+) + Bases core plugin |
| `skills` | off | mutating | — |
| `provenance` | off | mutating | — |
| `health` | off | read-only | — |
| `fileclass` | off | mutating | Fileclass plugin loaded + `fileclass` CLI binary found |
| `governance` | off | zero MCP tools (Obsidian pane only) | — |
| `crosssession` | off | mutating | — |
| `triage` | off | mutating | Base-backed queues additionally need the bases module |

Non-module conditional surfaces: the six plugin-gated integration tools (Dataview ×2,
Templater, Omnisearch, Metadata Menu ×2), the Importer-plugin-gated
`obsidian_import_apple_notes` (version-gated headless Apple Notes import), the five
CLI-binary-conditional dedicated tools,
the settings-gated `obsidian_cli` raw proxy (default off), the dev tool-runner
(`devToolRunner` setting, default on — an in-Obsidian command, not an MCP tool), and Code
Mode (chosen per connection). The full source-locked tool census is
[`TOOL-INVENTORY.md`](../packages/plugin/TOOL-INVENTORY.md): 71 base `obsidian_*` tools
(17 fs-expressible + 44 always-live + 10 module-mounted default-on), up to 84 with the
conditional surfaces, plus the always-on `governance_*` pair and the module surfaces named
outside the `obsidian_*` family.

## Where to go deeper

[docs/README.md](README.md) is the ordered reading list. Architecture decisions and the
per-primitive design notes live in [`packages/plugin/CLAUDE.md`](../packages/plugin/CLAUDE.md);
the roadmap-as-narrative is [vision-walkthrough.md](vision-walkthrough.md).
