# Inbox triage — the disposition substrate's second instance (#221, phase 2)

The successor to the vault's retired `dispose-inbox-item` QuickAdd flow: **ten
dispositions over notes sitting in inbox positions**, shipped as a
default-disabled capability module (`triage`) with exactly two tools — a
read-only queue view and one guarded mutating disposition verb. There is **no
pane UI** in this module, deliberately.

## The substrate

Issue #221's observation: a triage instance = a queue predicate + a disposition
set, where a disposition is `{id, authority, surface, label, effect, …}`. The
**authority axis** sorts every verb with one rule: a disposition that **confers
standing** (accept, adopt, revert-of-standing) is a human gesture — never an
API; a disposition that is an ordinary reversible write is agent-expressible
through the guarded path.

Phase 1 (#101/#228) proved the shape on the live acceptance instance. Phase 2
extracts the generic descriptor shape and its pure helpers into
`kernel/triage/dispositions.ts` — the **disposition substrate** — and declares
inbox triage against it as the second instance:

- **Acceptance instance** (`kernel/governance/dispositions.ts`): seven verbs,
  mixed human/agent authority, rendered by the governance pane. The extraction
  is deliberately **invisible** to it: the file keeps its exact exports and
  behavior, stays a pure-data leaf with **no import statement and no runtime
  module edge** (the governance tripwire pins both), and binds to the shared
  shape through type-position `import(…)` references only.
- **Inbox-triage instance** (`kernel/triage/descriptors.ts`): ten verbs, **all
  `authority: "agent"`** — none confers standing, every effect is a reversible
  guarded write — so per Nelson's native-tooling rule there is nothing to
  gesture-gate and no bespoke UI to build. Queue *views* for humans are native
  (a Base over frontmatter/folders); the module ships descriptors as data, one
  read-only queue tool for agents, and one guarded disposition tool.

The ten-descriptor table is the **single source**: the `triage_dispose`
disposition enum, its tool description, the module manifest's capability
directory, and this doc's list all derive from it.

## The ten dispositions

| Disposition | Action | Target | Frontmatter patch (config default) |
| --- | --- | --- | --- |
| `discard` | Obsidian trash (recoverable — never a hard delete) | refused | — |
| `route` | move | **required** | — |
| `establish-new-home` | move (parents created) | **required** | — |
| `convert-to-action` | patch + move | target or `actionDestination` | `actionFrontmatter` — default `{"tags": ["note/task"], "status": "open", "priority": "normal"}` |
| `develop-as-knowledge` | move | target or `knowledgeDestination` | — |
| `register` | move | **required** | — |
| `curate-as-link` | move | **required** | — |
| `defer-to-someday` | patch + move | target or `somedayDestination` | `somedayFrontmatter` — default `{"status": "someday"}` |
| `archive-as-record` | move | target or `archiveDestination` | — |
| `escalate` | patch, note stays in place | refused | `escalateFrontmatter` — default `{"tags": ["attention/user"]}` |

**Every moving disposition creates missing parent folders** — that is the
shared move primitive's behavior, uniformly. `establish-new-home` differs from
`route` in *intent* (a home that does not exist yet vs a home the note already
belongs in), not mechanics: a `route` to a typo'd folder will create it, so
check the destination (or dry-run first — you always are, by default).

`target` always names a destination **folder**; the note keeps its filename.
Dispositions with a **required** target refuse typed (`target_required`)
without one; the config-backed four refuse `destination_unresolved` when
neither a target nor their configured destination exists; `discard`/`escalate`
refuse a target outright (`target_unsupported`).

Patch semantics: **array values union** with the existing value (an existing
scalar is promoted; duplicates are not re-added — the legacy tags-append
behavior), **scalars overwrite** (the legacy defer-to-someday behavior; the
legacy convert-to-action's set-if-absent for status/priority is deliberately
simplified to the same overwrite rule).

## Vault semantics are configuration

Nothing scheme-semantic is hardwired (the project's standing rule — a
hardwired semantic constant is a defect). All of it lives at
`modules.triage.config`, validated loudly (settings tab + `registry.problems`)
and degrading to defaults at use time:

- **`inboxMarkers`** (default `[" Inbox for "]`, the live vault convention):
  a note is an inbox item when any ancestor folder's name contains one of
  these substrings. An inbox folder's own folder note (basename equal to its
  marker-matching parent's name) is never an item — it *is* the inbox; an
  ordinary subfolder's folder note inside an inbox is still an item.
- **`actionDestination` / `knowledgeDestination` / `somedayDestination` /
  `archiveDestination`** (default blank = unconfigured): fallback destination
  folders for the config-backed dispositions.
- **`actionFrontmatter` / `somedayFrontmatter` / `escalateFrontmatter`**
  (JSON object strings; defaults above mirror the legacy flow's stamps): the
  patches the retyping dispositions apply. A patch carrying an acceptance
  field is refused at validation AND sanitized to the clean default at
  coercion — it can never reach a note.

## Guard posture

`triage` is a **mutating capability module** (`mutating: true`, default
DISABLED — a human enables it in the config tab). Both tools register through
the guard-patched registrar, so read-only mode, the path allowlist, the
serialized write queue, the journal, and the kernel args (`if_rev`,
`idempotency_key`, `intent`) all bind at the standard interception point.

- **Moves ride the shared move primitive** — `tools-vault-write.ts`'s
  `moveOne`, the link-healing `fileManager.renameFile` path every other move
  tool uses, with parent folders created and **never an overwrite**
  (`destination_occupied` is refused up front; a race that slips past the
  check fails the move rather than clobbering).
- **Discard is Obsidian's trash** (`fileManager.trashFile`) — recoverable,
  never a delete.
- **Frontmatter transitions go through `processFrontMatter`**, and the shared
  accept-forbidden rule (`@vault-mcp/core`) is re-checked over every
  effective patch before it is written. **No acceptance semantics exist
  anywhere in this module** — it reads no acceptance state and contributes no
  accept-shaped verb (the module-registry tripwire would refuse one anyway).
- The **computed destination is not a call argument**, so the guard's
  argument check never sees it — the handler re-checks it against the
  allowlist itself (the scheme-write discipline), in dry-run and apply alike.
  `triage_queue` visible-filters the listing **before** reading any
  stat/frontmatter (the read-boundary rule).

## Report-first: dry-run by default

`triage_dispose` defaults to **`dry_run: true`** (the #214 scheme-mutations
discipline): the call reports exactly what would change — the plan (action,
computed destination, frontmatter patch), the enclosing inbox, and any typed
refusal — and writes nothing until the caller passes `dry_run: false`.
Refusals are computed identically in both modes. A mid-sequence failure at
apply time (patch landed, move failed) names the partial state instead of
hiding it.

## Scheme integration — optional, degrades cleanly

When the scheme module is enabled, a dispose report carries a **`scheme`
advisory** — the note's own address and the folder the scheme expects it in
(`obsidian_expected_location`'s path-direction answer, computed over the same
allowlist-visible listing) — as a routing hint. With the scheme module
disabled, unavailable, or erroring, the field is simply **absent**: the
advisory is never load-bearing and triage never depends on scheme.

## Deliberate phase-2 scope reductions (vs the legacy flow)

- **No on-demand destination materialization.** The legacy flow resolved
  scope-relative operation folders (`.02`/`.06`/`.08`/`.09`) and *created*
  a missing operation via the vault's `operations.js` machinery. Phase 2
  replaces that with configured destination folders + explicit `target` —
  a move + frontmatter retype is enough; the creation wizards are not
  rebuilt.
- **No dynamic `projects: [[<scope note>]]` stamp** on convert-to-action:
  a static config patch cannot express the enclosing-scope wikilink. Callers
  wanting it set it in a follow-up frontmatter write.
- **Set-if-absent → overwrite** for scalar patch keys, documented above.

## The un-headless boundary

Everything above the adapter is Obsidian-free and unit-tested
(`tests/triage-module.test.mjs`): descriptors, config, queue predicate,
planner, both handlers over a fake source, and the module mount. The one
un-headless seam is `src/mcp/obsidian-triage-source.ts` — the live adapter
binding `paths`/`frontmatter`/`stat`/`exists` to the vault + metadata cache
and the three write primitives to `moveOne` / `fileManager.trashFile` /
`processFrontMatter` — verified live like every other adapter.
