# vault-mcp Plugin — Authoritative Tool Inventory

Source of record for every tool the plugin's MCP server registers.  Generated
by reading `packages/plugin/src/mcp/server.ts` and all `tools-*.ts` files.
The FULL set is locked by `tests/tool-inventory.test.mjs`: the names documented
here must equal the names registered in source, both directions, or the suite
fails (the fs-expressible and scheme sub-locks from #25/task-6 still apply).

**Count summary:** 17 fs-expressible + 41 always-live + 10 module-mounted
(default enabled, settings-toggleable) = **68 base** tools, plus up to
6 conditional integration tools, 5 CLI-binary-conditional dedicated tools
(`obsidian_note_history`, `obsidian_note_diff`, `obsidian_base_create`,
`obsidian_plugin_install`, `obsidian_plugin_uninstall`), and 1 settings-gated
CLI-conditional tool (`obsidian_cli`, default OFF)
= **up to 80 total**.  The 3 Code Mode meta-tools are an alternative
per-connection surface and are not counted (a session sees one surface or the
other, never both).  Not counted here (outside the locked `obsidian_*` family):
the always-on `governance_submit_revision` (1 tool, see its section below), and
the default-disabled `skills` (`vault_skills_*`), `provenance`
(`provenance_*`), `fileclass` (`fileclass_*`, 8 tools, plugin+binary-gated),
`crosssession` (`crosssession_*`, 4 tools), and `triage` (`triage_*`, 2 tools)
module surfaces — see Section 2c and their own module docs.

Cross-check: the observed live set with Dataview + Templater + Metadata Menu
loaded (but NOT Omnisearch, no CLI binary) reported 44 tools — an observation
that PREDATES the kernel-v0 tools (locks ×4, uid ×1, links ×1), the vocab
module (×4), the scheme module (×6), `obsidian_write_notes`,
`obsidian_pending_review`, `obsidian_plugin_info`, `obsidian_plugin_reload`,
the scheme write surface (`obsidian_assign_address`,
`obsidian_refile_address`, `obsidian_renumber_address`), and subsequent
`main` additions (in-Obsidian dev tool-runner, conformance debt register,
the snippet tools);
the same plugin set today registers 17 + 41 + 10 + 6 = **74**.

---

## Section 1 — fs-expressible (17)

Defined in `@vault-mcp/core`'s `FS_TOOLS` (`packages/core/src/tool-registry.ts`).
Registered in the plugin via `registerFsTools(server, new ObsidianBackend(app))`
in `server.ts`.  The server package registers the same 17 via `registerFsTools`
against its `FilesystemBackend`.

| Tool name | Capability |
|---|---|
| `obsidian_append_note` | fs-expressible |
| `obsidian_delete_note` | fs-expressible |
| `obsidian_find_by_tag` | fs-expressible |
| `obsidian_force_reindex` | fs-expressible |
| `obsidian_get_backlinks` | fs-expressible |
| `obsidian_get_outlinks` | fs-expressible |
| `obsidian_list_folders` | fs-expressible |
| `obsidian_list_notes` | fs-expressible |
| `obsidian_manage_frontmatter` | fs-expressible |
| `obsidian_move_note` | fs-expressible |
| `obsidian_patch_note` | fs-expressible |
| `obsidian_read_note` | fs-expressible |
| `obsidian_read_notes` | fs-expressible |
| `obsidian_resolve` | fs-expressible |
| `obsidian_search_by_frontmatter` | fs-expressible |
| `obsidian_search_notes` | fs-expressible |
| `obsidian_write_note` | fs-expressible |

---

## Section 2 — live-only, always registered (41)

These tools depend on live Obsidian `app.*` state and cannot be expressed on the
filesystem.  They are unconditionally registered on every `buildMcpServer` call,
regardless of which community plugins are installed.

### `tools-core.ts` — `registerCoreTools` (2 tools)

| Tool name | Description |
|---|---|
| `obsidian_doctor` | Vault-mcp health, socket path, integration + CLI-binary detection |
| `obsidian_get_active_note` | Currently focused note + editor selection |

### `tools-vault-write.ts` — `registerVaultWriteTools` (2 tools)

| Tool name | Description |
|---|---|
| `obsidian_move_notes` | Batch move/rename (live-only — not in the shared 17) |
| `obsidian_repoint_link` | Repoint every `[[link_name]]` at `target_path`, vault-wide (live-only; fixes broken links that rename-based rewrite can't touch). Flags: `dry_run`, `unresolved_only` (skip still-resolving links), `drop_echo_alias` (drop [[x\|x]] echo aliases) |

### `tools-scheme-write.ts` — `registerSchemeWriteTools` (3 tools)

Registered directly in `server.ts`, immediately after `registerVaultWriteTools`
— NOT through the module host (`modules-mount.ts`'s `registerAll` gate refuses
any tool whose `readOnlyHint !== true`, and these three mutate by design).
Plans via the pure `kernel/scheme/mutate.ts` core, applies via
`tools-vault-write.ts`'s `moveOne`. Allowlist-filtered like `tools-scheme.ts`'s
read tools; `dry_run` never mutates.

| Tool name | Description |
|---|---|
| `obsidian_assign_address` | Assign a note the next free address in a scope, then move it there |
| `obsidian_refile_address` | Move a note back to the folder its own address says it belongs in |
| `obsidian_renumber_address` | Move a note to a specific target address, optionally displacing (`on_occupied`: `auto`/`manual`/`fail`) whatever already occupies it |

### `tools-write-notes.ts` — `registerWriteNotesTool` (1 tool, kernel B1)

| Tool name | Description |
|---|---|
| `obsidian_write_notes` | Batch whole-note writes, each item an independent kernel-routed write with its own journal record, `if_rev`/`idempotency_key`, and optional server-side frontmatter stamping (`stamp: true`) |

### `tools-pending-review.ts` — `registerPendingReviewTools` (1 tool, kernel B3b)

| Tool name | Description |
|---|---|
| `obsidian_pending_review` | Read-only view of Stewardship's published review queue (`pending-index.json`); data-only coupling, no accept verb |

### `tools-governance-revision.ts` — `registerGovernanceRevisionTool` (1 tool, #101)

Outside the locked `obsidian_*` family (like the module surfaces), but
registered ALWAYS-ON in `server.ts` through the ordinary guarded registrar.

| Tool name | Description |
|---|---|
| `governance_submit_revision` | The one agent-expressible disposition (#221 authority axis): resubmit a note a human marked `acceptance-status: revising` — status back to `proposed`, the `[!revision-request]` callout(s) removed, optional `summary` inserted as a `[!revision-report]` callout below the H1. Mutating (`readOnlyHint: false`); refuses `not_revising` when there is nothing to submit; re-checks the write with the shared accept-forbidden guard — it can never write acceptance |

### `tools-complementary.ts` — `registerComplementaryTools` (9 tools)

| Tool name | Description |
|---|---|
| `obsidian_append_at_heading` | Insert content under a heading, create if missing |
| `obsidian_environment_info` | Obsidian version, platform, enabled plugins |
| `obsidian_get_command_ids` | List all registered Obsidian command IDs |
| `obsidian_open_in_editor` | Open a note in Obsidian's editor |
| `obsidian_read_note_parsed` | Structured metadata from Obsidian's live cache |
| `obsidian_run_command` | Execute an Obsidian command by ID |
| `obsidian_tags_list` | All tags with usage counts (live metadata cache) |
| `obsidian_trash` | Move a note to the system trash (recoverable) |
| `obsidian_vault_info` | Vault name, base path, config dir, attachment folder |

### `tools-nav.ts` — `registerNavTools` (11 tools)

| Tool name | Description |
|---|---|
| `obsidian_jump_to` | Open a note and scroll to heading/block/line |
| `obsidian_list_bookmarks` | All bookmarks (requires core Bookmarks plugin) |
| `obsidian_list_workspaces` | All saved workspace names (requires Workspaces plugin) |
| `obsidian_open_bookmark` | Open a bookmark by title |
| `obsidian_open_workspace` | Load a named workspace layout |
| `obsidian_periodic_note` | Open/create daily-weekly-monthly note |
| `obsidian_plugin_info` | Community plugin state: running vs on-disk vs Obsidian's cached manifest version |
| `obsidian_plugin_reload` | Reload one community plugin (disable + enable) so a rebuild takes effect |
| `obsidian_plugin_toggle` | Enable or disable a community plugin |
| `obsidian_save_workspace` | Save the current layout as a named workspace |
| `obsidian_toggle_view_mode` | Switch active leaf: source / preview / live-preview |

### `tools-locks.ts` — `registerLockTools` (4 tools, kernel v0)

| Tool name | Description |
|---|---|
| `obsidian_claim_scope` | Advisory claim on a path-prefix scope (disclosed, never blocking) |
| `obsidian_renew_scope` | Extend an existing claim's TTL by lock id |
| `obsidian_release_scope` | Release a claim by lock id |
| `obsidian_list_scope_claims` | Every live claim, most specific first |

### `tools-uid.ts` — `registerUidTools` (1 tool, kernel v0)

| Tool name | Description |
|---|---|
| `obsidian_resolve_uid` | uid ↔ path lookup + duplicates report (allowlist-filtered) |

### `tools-links.ts` — `registerLinkTools` (1 tool, kernel v0)

| Tool name | Description |
|---|---|
| `obsidian_check_links` | Dangling links + duplicated uids + uid coverage, report-only |

### `tools-snippets.ts` — `registerSnippetTools` (4 tools)

CSS snippet management over the live `app.customCss` API — the one CONSIDERED
exception to the rule that agent surfaces never touch `.obsidian` territory,
scoped to exactly `.obsidian/snippets/*.css` and nothing else (the snippet name
is sanitized so it cannot escape that folder; enable/disable goes through the
app API, never by editing config files). The two mutating tools refuse while a
path allowlist is active (a snippet is vault-global config and cannot be
path-scoped) and ride the guarded registrar (read-only mode, queue, journal).
CSS is not frontmatter, so there is no accept surface here. A session may
write a snippet AND enable it (no human gate between the two) — a decided
trade under the fallible-not-adversarial threat model: both calls are
journaled, and read-only mode or an allowlist blocks both mutators.

| Tool name | R/W | Description |
|---|---|---|
| `obsidian_snippets_list` | R | Snippets with enabled state, from the live customCss registry |
| `obsidian_snippet_read` | R | One snippet's CSS text |
| `obsidian_snippet_write` | W | Create/overwrite `.obsidian/snippets/<name>.css` (name sanitized; new snippets start disabled) |
| `obsidian_snippet_toggle` | W | Enable/disable one snippet via `customCss.setCssEnabledStatus` |

### `tools-conformance-debt.ts` — `registerConformanceDebtTools` + `registerConformanceDebtRenderTool` (2 tools, issue #211)

| Tool name | Description |
|---|---|
| `obsidian_conformance_debt` | Accepted conformance-debt register: carried items (script/check/target/kind + sidecar metadata + ageDays) with burn-down counts (carried/cleared/new), a stale list, and a budget status; filter by folder/pack/check/kind and group counts. Read-only, whole-vault; never mints acceptance (that is the human-run `--rebaseline`) |
| `obsidian_conformance_debt_render` | Materialize the debt report as a generated register note (`Conformance debt.md`, default beside the baseline): summary header, carried-debt table (each row wikilinked to the offending note, stale + high-priority first), and a cleared/prune section. Mutating (queue/journal via the guarded registrar); frontmatter is a `generated`/`generator` derivation stamp only — the accept-guard is run over the rendered text; refuses under an active path allowlist unless the register path is inside it |

---

## Section 2b — module-mounted, default enabled (10)

Registered through the module host (`modules-mount.ts` → `ModuleRegistry`), not
directly: `server.ts` calls `mountModules`, and each module's tools register
only when the module is enabled (`settings.modules.<id>.enabled`, defaulting to
the module's own `enabled: true`).  Both modules ship default-ON, so these 9
are present on a stock connection; a settings toggle takes effect on the next
session connect.

### `tools-scheme.ts` — `registerSchemeTools` via the `scheme` module (6 tools)

| Tool name | Description |
|---|---|
| `obsidian_schemes` | Enumerate scheme instances: capabilities, config, grammar examples (skipped instances appear as `{id, available: false}`) |
| `obsidian_validate_name` | Validate one filename against the scheme grammar: malformed address token, colon in the name, or trailing whitespace (pure grammar check — no vault read, no allowlist) |
| `obsidian_resolve_address` | Address → path(s), or path → address; duplicates reported, never picked |
| `obsidian_next_address` | Compute the next free address in a scope (computes only — reserves nothing) |
| `obsidian_list_scope` | Members of a scope in address order, plus up to 20 open slots |
| `obsidian_expected_location` | Per-note or per-address placement report |

### `tools-vocab.ts` — `registerVocabTools` via the `vocab` module (4 tools)

| Tool name | Description |
|---|---|
| `obsidian_vocabularies` | Enumerate configured vocab sources: capabilities, counts, examples |
| `obsidian_resolve_term` | Token → canonical entry; path → its terms; parse-only mode |
| `obsidian_validate_terms` | One note's frontmatter → vocabulary findings, report-only |
| `obsidian_list_vocabulary` | Entries of a kind (tag/property/type/term), optionally scoped |

---

## Section 2c — module-mounted, default DISABLED (2)

Registered through the module host like Section 2b, but these modules ship
`enabled: false` — a human turns them on in the config tab, and the tools appear
on the next session connect. (The `skills`, `provenance`, `fileclass`,
`crosssession` and `triage` modules also ship disabled, but their tools are named
`vault_skills_*` / `provenance_*` / `fileclass_*` / `crosssession_*` / `triage_*`,
outside the `obsidian_*` family this inventory locks, so the first two are
documented in their own module docs; `fileclass`, `crosssession` and `triage` are
documented just below — fileclass because it is also plugin-gated, crosssession
because it is the cross-session coordination surface (#232), triage because it is
the inbox-triage disposition surface, #221 phase 2.)

### `tools-health.ts` — `registerHealthTools` via the `health` module (2 tools)

Read-only vault-health scanner, folded from the standalone `obsidian-vault-health`.
Both tools are `readOnlyHint: true`; the module has no write path.

| Tool name | Description |
|---|---|
| `obsidian_health` | Full tiered vault health scan → findings by fix risk (auto-safe repointable links / approval-gated empty notes + orphan attachments / report-only dangling links + duplicate groups + low-signal tags) plus summary counts. Read-only, whole-vault |
| `obsidian_lint` | The same scan restricted to one folder or note (`scope`); link resolution + orphan inbound-set stay vault-wide, low-signal tags omitted |

### `tools-fileclass.ts` — `registerFileclassTools` via the `fileclass` module (8 tools)

Folded from the standalone `fileclass` CLI (github.com/mdelobelle/fileclass-cli —
the terminal for the **Fileclass** typed-frontmatter plugin, successor to Metadata
Menu). A **proxy** module: it shells out to the `fileclass` CLI binary via
`execFile` (the `obsidian_cli` precedent), passing `--json` and pinning the vault
with `--vault <name>`. **Doubly gated** — the tools register only when the module
is enabled AND the Fileclass plugin is LOADED (`app.plugins.plugins.fileclass`)
AND the `fileclass` CLI binary is found (config `binaryPath`, else the standard
install paths); absent any of these, none register. Disabled while a path
allowlist is active (the CLI runs over the whole vault through its engine, so its
output cannot be path-scoped — the `obsidian_cli` / Dataview precedent).

The two write tools (`fileclass_set` / `fileclass_set_where`) register
`readOnlyHint: false`, so they ride the guard-patched registrar (read-only mode,
path allowlist on the note path, serialized queue, journal, if_rev/idempotency)
AND the accept-forbidden guard: a field-write can never introduce or change an
`accepted` / `accepted-by` / `accepted-on` field, nor set `acceptance-status` to
an accepted value (`Error [accept_forbidden]`, refused before the CLI runs).

| Tool name | R/W | Description |
|---|---|---|
| `fileclass_list` | R | Every fileClass (name, extends, field count, has-Base) — CLI `fileclasses` |
| `fileclass_schema` | R | A fileClass's options + resolved fields (with ancestry) — CLI `schema <name>` |
| `fileclass_explain` | R | A note's fileClasses, ancestry, resolved field values — CLI `explain <path>` |
| `fileclass_query` | R | Rows for a fileClass, `where`/`columns`/`limit` — CLI `list <class>` |
| `fileclass_get` | R | One field's value on a note — CLI `get <path> <field>` |
| `fileclass_validate` | R | Schema violations vault-wide or per fileClass; exit 1 (violations) is returned, not errored — CLI `validate` |
| `fileclass_set` | W | Validated single-note field write; accept-guarded — CLI `set <path> <field> <value>` |
| `fileclass_set_where` | W | Validated bulk write; **dry-run by default**, `apply: true` to commit; accept-guarded — CLI `set-where <class> <field> <value>` |

### `tools-crosssession.ts` — `registerCrosssessionTools` via the `crosssession` module (4 tools)

The cross-session channel surface (#232): the fleet's coordination-log
conventions given an agent surface. Channels are discovered by **fileclass +
`audience:` frontmatter** (default `Collection/Log` + any `audience` value —
never by path); a channel's entries are read from BOTH live forms: the single
append-only log file's `## <stamp> · <handle>` sections and per-message notes
(`fileClass: Agent/Log/CrossSession`, filename `<stamp> · <handle>.md`). Stamps
are treated as **opaque ordered strings** (the live file contains imprecise
`…T14:2x` stamps), compared with `:` stripped so the file form and the filename
form of one minute agree.

**Handles are cooperative**, self-declared tool arguments — not authenticated
identities (the fleet's fallible-not-adversarial threat model: the module
catches honest lapses, not adversaries). **Read positions are module state**:
per-handle receipts in `crosssession-receipts.json` beside the journal in the
plugin's own directory — not in any note's frontmatter, not in `data.json`.
Receipts are keyed by the channel note's `uid` (a reorg move keeps read state).
A channel outside the path allowlist is **invisible**: absent from discovery,
`channel_unresolved` to the other tools (no existence oracle); hidden member
files contribute no entries.

The two write tools ride the guard-patched registrar (read-only mode, queue,
journal, kernel args). `crosssession_post` refuses **`stale_read`** — a typed
policy refusal, checked before anything is written — while the channel holds
entries the poster's receipt does not cover (the poster's own entries exempt):
"posting asserts you are current," enforced mechanically. Post appends body
text at end-of-file only and composes no frontmatter; attest writes only the
module's receipt file (registered mutating for the journal record, the
lock-claim precedent).

| Tool name | R/W | Description |
|---|---|---|
| `crosssession_channels` | R | Discover channels by fileclass + audience frontmatter: uid, path, audience, projects, entry count, newest stamp, recorded receipts (which handles are behind); with `handle`, your position + unread count |
| `crosssession_delta` | R | Entries newer than your attested position, `{stamp, handle, body}` from both forms, oldest first; capped (default 20, never bisecting a same-stamp group) with `more` + `next_stamp`; own entries omitted |
| `crosssession_attest` | W | Record a read receipt (`through_stamp` ≤ newest entry; `stamp_ahead` otherwise) — a read-receipt, not authority; mutates module state only |
| `crosssession_post` | W | Append one `## <stamp> · <handle>` section (run clock, minutes precision) to the channel's log file; **refuses `stale_read` before any write** while unread entries exist; auto-attests through its own entry on success |

### `tools-triage.ts` — `registerTriageTools` via the `triage` module (2 tools)

The inbox-triage surface (#221 phase 2): the disposition substrate's second
instance, successor to the vault's retired `dispose-inbox-item` QuickAdd flow.
Ten dispositions declared as data (`kernel/triage/descriptors.ts` — discard,
route, establish-new-home, convert-to-action, develop-as-knowledge, register,
curate-as-link, defer-to-someday, archive-as-record, escalate); **none confers
standing**, so per the #221 authority axis all ten are `authority: "agent"` and
the module has **no pane UI at all** (queue views for humans are native Bases
over frontmatter; bespoke pane UI is reserved for gesture-gated authority
dispositions, of which this instance has none). The single-source table drives
the `triage_dispose` enum, its description, and the manifest directory.

Inbox recognition, fallback destinations, and the frontmatter patches are all
**per-vault config** (`modules.triage.config`) whose defaults mirror the legacy
flow's live-vault behavior (`inboxMarkers: [" Inbox for "]`, action patch
`tags+note/task, status open, priority normal`, someday patch `status:
someday`, escalate patch `tags+attention/user`) — nothing vault-semantic is
hardwired. Moves ride the **shared link-healing move primitive**
(`tools-vault-write.ts`'s `moveOne` — `fileManager.renameFile`, parents
created, never overwrites); discard is Obsidian's recoverable trash, never a
hard delete; frontmatter transitions go through `processFrontMatter` with the
shared accept-forbidden rule re-checked over every patch. `triage_dispose` is
**dry-run by default** (the #214 report-first discipline) and its computed
destination is allowlist-re-checked in the handler (it is not a call
argument). With the scheme module enabled the dispose report carries a
`scheme` advisory (the note's own address + expected folder); with scheme
disabled the field is simply absent.

| Tool name | R/W | Description |
|---|---|---|
| `triage_queue` | R | Inbox notes (any ancestor folder matching a configured marker; the inbox's own folder note excluded), allowlist-visible only, with path/inbox/created/modified/age/frontmatter type+status — oldest first, capped (`limit`, default 50) with `truncated` + the total |
| `triage_dispose` | W | Apply ONE of the ten dispositions to an inbox note (`{path, disposition, target?, dry_run?}`); **dry-run by default**; `target` (a destination folder) required for route/establish-new-home/register/curate-as-link, an override for the config-backed movers, refused for discard/escalate; typed refusals (`not_inbox`, `target_required`, `target_unsupported`, `destination_unresolved`, `destination_occupied`, `out_of_allowlist`, `accept_forbidden`) |

---

## Section 3 — live-only, conditional (up to 6)

Registered only when the gating community plugin's instance is actually loaded
(`app.plugins.plugins[id]` is truthy — NOT just in `enabledPlugins`, which can
list stale/uninstalled entries).  New tools appear on session reconnect.

| Tool name | Gating plugin | Plugin ID |
|---|---|---|
| `obsidian_dataview_list_query` | Dataview | `dataview` |
| `obsidian_dataview_table_query` | Dataview | `dataview` |
| `obsidian_create_note_from_template` | Templater | `templater-obsidian` |
| `obsidian_omnisearch` | Omnisearch | `omnisearch` |
| `obsidian_fileclass_schema` | Metadata Menu | `metadata-menu` |
| `obsidian_fileclass_insert_fields` | Metadata Menu | `metadata-menu` |

### Conditional on the official Obsidian CLI binary (5)

`tools-cli-dedicated.ts` — `registerCliDedicatedTools`. Dedicated tools over
PINNED CLI subcommands (the `obsidian_cli` decomposition): typed args, the
same transport machinery (vault pinned via `buildCliArgs`, shared exec seam,
settings deny list via `cliCommandRefusal`, `.obsidian`/`..` param refusal).
Registered only when the official Obsidian CLI binary is installed
(`/usr/local/bin/obsidian`, `/opt/homebrew/bin/obsidian`, or
`/usr/bin/obsidian`); `obsidian_doctor` reports the detected path as
`cli_binary`. `history:restore` is deliberately NOT promoted to a tool —
restoring a prior version can reinstate an accepted value a human revoked, and
the restored bytes cannot be scanned pre-exec (#110).

| Tool name | R/W | Pinned subcommand | Description |
|---|---|---|---|
| `obsidian_note_history` | R | `history` | One note's File Recovery version list; `path` is allowlist-scoped |
| `obsidian_note_diff` | R | `diff` | List/diff local/sync versions of one note (`from`/`to`/`filter`); `path` is allowlist-scoped |
| `obsidian_base_create` | W | `base:create` | Create an item in a Bases file; content runs the standard accept scan; refuses under an active allowlist (the landing folder is the base's config, not an argument) |
| `obsidian_plugin_install` | W | `plugin:install` | DANGEROUS — gated behind "Allow dangerous CLI commands" exactly like the proxy; `openWorldHint: true` (network fetch); installs without enabling |
| `obsidian_plugin_uninstall` | W | `plugin:uninstall` | DANGEROUS + `destructiveHint: true` — same gate; refuses to uninstall vault-mcp itself |

### Settings-gated raw proxy — conditional on the CLI binary AND the "Raw CLI proxy" setting (1, default OFF)

`tools-cli.ts` — `registerCliTools`. The free-text proxy is DEMOTED behind the
default-OFF Security › "Raw CLI proxy" toggle: the dedicated tools above cover
the observed real usage, and the proxy's free-text command string is the root
of the guard-complexity family (#76/#79/#107/#110/#137/#153). When enabled it
behaves exactly as before — command policy, danger gate, accept guard and deny
sets all intact; a toggle takes effect on the next session connect.

| Tool name | Description |
|---|---|
| `obsidian_cli` | Proxy any official CLI command against this vault (vault pinned; dangerous commands gated behind the "Allow dangerous CLI commands" setting; refuses to run while a path allowlist is active) |

---

## Code Mode (per-connection alternative surface)

A connection whose bridge runs with `--code-mode` (or `VAULT_MCP_CODE_MODE=1`)
gets **3 meta-tools instead of the full surface** (`tools-code-mode.ts`,
`registerCodeModeTools`). Every tool above is still reachable — captured into a
per-connection registry (guard wrapper included) and exposed through:

| Tool name | Description |
|---|---|
| `obsidian_search_tools` | Find tools by keyword (name/title/description); no query lists all |
| `obsidian_describe_tool` | Full description + annotations + input JSON Schema for one tool |
| `obsidian_call_tool` | Invoke any captured tool by name; args validated against its zod shape; read-only mode and path allowlist bind on the target exactly as on the full surface |

Code Mode tools are not counted in the summary above: a session sees either
the full surface or these 3, never both.

---

## Observed live set cross-check (historical)

The 44-tool set observed with Dataview + Templater + Metadata Menu loaded
(Omnisearch absent, CLI binary not counted) mapped exactly to the inventory as
it stood then:

- 17 fs-expressible ✓
- 22 always-live at the time ✓ (now 33 + 9 module-mounted — see Sections 2/2b)
- 5 integration (Dataview×2 + Templater×1 + Metadata Menu×2) ✓
- `obsidian_omnisearch` absent — Omnisearch plugin not loaded ✓
- (the dedicated CLI tools additionally register when the CLI binary is
  installed, and `obsidian_cli` when the binary is installed AND the
  default-off "Raw CLI proxy" setting is on)

**No tool in the observed-44 list was unaccounted for in source.**  Under the
same plugin set the current surface registers 74 (see the count summary); the
source↔doc lock in `tests/tool-inventory.test.mjs` keeps this file current, and
any future live observation should be checked against that lock rather than
this historical snapshot.

---

## Source file map

| File | Registration function | Tools registered |
|---|---|---|
| `packages/core/src/tool-registry.ts` | — (FS_TOOLS definition) | 17 fs-expressible |
| `packages/plugin/src/mcp/server.ts` | `registerFsTools` | 17 fs-expressible |
| `packages/plugin/src/mcp/tools-core.ts` | `registerCoreTools` | 2 always-live |
| `packages/plugin/src/mcp/tools-vault-write.ts` | `registerVaultWriteTools` | 2 always-live |
| `packages/plugin/src/mcp/tools-scheme-write.ts` | `registerSchemeWriteTools` | 3 always-live |
| `packages/plugin/src/mcp/tools-complementary.ts` | `registerComplementaryTools` | 9 always-live |
| `packages/plugin/src/mcp/tools-nav.ts` | `registerNavTools` | 11 always-live |
| `packages/plugin/src/mcp/tools-locks.ts` | `registerLockTools` | 4 always-live |
| `packages/plugin/src/mcp/tools-uid.ts` | `registerUidTools` | 1 always-live |
| `packages/plugin/src/mcp/tools-links.ts` | `registerLinkTools` | 1 always-live |
| `packages/plugin/src/mcp/tools-conformance-debt.ts` | `registerConformanceDebtTools` + `registerConformanceDebtRenderTool` | 2 always-live |
| `packages/plugin/src/mcp/tools-write-notes.ts` | `registerWriteNotesTool` | 1 always-live |
| `packages/plugin/src/mcp/tools-pending-review.ts` | `registerPendingReviewTools` | 1 always-live |
| `packages/plugin/src/mcp/tools-scheme.ts` | `registerSchemeTools` (via `modules-mount.ts`) | 6 module-mounted |
| `packages/plugin/src/mcp/tools-vocab.ts` | `registerVocabTools` (via `modules-mount.ts`) | 4 module-mounted |
| `packages/plugin/src/mcp/tools-health.ts` | `registerHealthTools` (via `modules-mount.ts`) | 2 module-mounted (default-disabled) |
| `packages/plugin/src/mcp/tools-snippets.ts` | `registerSnippetTools` | 4 always-live |
| `packages/plugin/src/mcp/tools-integrations.ts` | `registerIntegrationTools` | up to 6 conditional |
| `packages/plugin/src/mcp/tools-cli-dedicated.ts` | `registerCliDedicatedTools` | 5 conditional (CLI binary) |
| `packages/plugin/src/mcp/tools-cli.ts` | `registerCliTools` | 1 conditional (CLI binary + "Raw CLI proxy" setting, default off) |
| `packages/plugin/src/mcp/tools-code-mode.ts` | `registerCodeModeTools` | 3 (alternative surface, uncounted) |
