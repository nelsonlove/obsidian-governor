# obsidian-jd-dashboard fold — design

**Status:** scoping, not yet approved. Written after a full read of the source repo
and a corrected understanding of what already exists in vault-mcp (see "Corrections
made during scoping" below) — this document reflects that corrected picture, not
the first-pass one.

## Problem

`obsidian-jd-dashboard` (github.com/nelsonlove/obsidian-jd-dashboard, ~6,570 lines,
not currently installed in the live vault) is a standalone Johnny Decimal companion
plugin: two sidebar panels (inbox counts, drift issues), a right-click context menu,
twelve commands, and assorted vault-scaffolding logic. Its sibling repo
`obsidian-jd-survey` was folded into vault-mcp today (`tools-survey.ts`, PR #242) —
jd-dashboard is the other half of the "companion to jd-cli" pair, and the same
consolidation question applies: does its remaining functionality belong as a
standalone plugin, or does it fold into vault-mcp the way survey, governance
(`obsidian-stewardship`), and skills (`obsidian-vault-skills`) already did?

## Precedent (two, both already load-bearing)

**UI folds are established, not novel.** vault-mcp already hosts two ported
sidebar panes from prior standalone plugins:
- `governance/pane.ts` (`GovernanceReviewView`) — ported from `obsidian-stewardship`
  (#83). Sidebar `ItemView`, ribbon icon, ordinary `Component`-scoped mount/unmount
  via `governance/wiring.ts`.
- `skills/pane.ts` (`SkillsPreviewView`) — ported from the standalone `vault-skills`
  plugin (#82 residuals). Same pane+wiring shape; explicitly documented as
  "read-only... compiles the vault through the folded skills core... the exact
  same core the read-only MCP tool runs, so the pane and the tool can never
  disagree."

Both pairs share the shape this design reuses: `<module>/pane.ts` (the `ItemView`,
pure rendering + user gesture handling) + `<module>/wiring.ts` (`registerView`,
`addRibbonIcon`, mount/unmount as a child `Component`, called once from `main.ts`),
backed by a kernel core the pane calls **directly, in-process** — no MCP round
trip, since the pane lives inside the same plugin. An MCP tool exposing
(read-only) equivalent data is a separate, optional surface for agents, built from
the same kernel core so the two can't disagree.

**Data-model supersession is an already-made call, not a new one.** Earlier this
session, `obsidian-jd-numbering`'s functionality was confirmed already folded into
vault-mcp's scheme module (PR #199) — via *reimplementation on the better model*,
not a literal code merge. jd-numbering's model was frontmatter-canonical (a
`jd-id` field is the source of truth, checked against the filename) plus,
historically, real drift between the two. Scheme's model is deliberately
path-canonical: the filename token *is* the address, full stop, no frontmatter
mirror to drift out of sync. `packages/plugin/CLAUDE.md`'s scope-provider section
states this explicitly: "this path-canonical model... reads only the filename
token and never frontmatter." jd-dashboard inherits jd-numbering's frontmatter
model and adds a *second* out-of-band source of truth on top of it (an external
`jd-index.yaml`/`jd.yaml` registry, watched and written via `fs.watchFile`,
coordinating with a separate Python CLI). This design does not re-open that
decision: anything that only exists to serve the frontmatter/registry model is
superseded, the same way jd-numbering's frontmatter checks already were.

## Corrections made during scoping

Two claims from earlier in this conversation turned out wrong on closer reading,
both caught before writing this doc:

1. **"vault-mcp has no UI, it's agent-only"** — false. It hosts two ported panes
   already (governance, skills) plus a settings tab (`connection-ui.ts`'s
   `VaultMcpSettingTab`). Folding in UI is the third instance of an established
   pattern, not new territory.
2. **"the drift panel can call `schemeFindings()` directly"** — true that nothing
   *forbids* it (the "not a registered tool" restriction in `findings.ts`'s header
   comment is about the MCP surface, not in-process calls), but wrong as a design:
   `schemeFindings()` returns every finding raw, with no distinction between a
   genuinely new problem and years of already-accepted debt. The whole conformance
   engine (`docs/conformance.md`) exists specifically to avoid that — "checks
   before gates... arms the acceptance gate rather than nagging about pre-existing
   debt," via `ratchet.ts`'s NEW/CLEARED/CARRIED baseline diff. The drift panel
   must consume the **ratcheted** result, not the raw one. See "Drift panel" below
   for exactly what that means in practice.

## Scope

### In scope — folds cleanly, no data-model work

| jd-dashboard piece | Becomes |
|---|---|
| Inbox panel (`.01 Unsorted/Inbox` counts, grouped by area, click-to-reveal) | New pane, backed by a small new kernel query over `obsidian_list_scope`-equivalent data |
| Drift panel — `wrong-folder` issues only (the frontmatter-based issue types are dropped, see below) | New pane, backed by the conformance engine's ratcheted NEW findings, filtered to the `scheme_findings` pack (see "Drift panel" below) |
| `category-index.ts` (rebuild a folder's `## Contents` section from vault truth, 3 tiers, preserving descriptions) | New kernel module + MCP write tool — genuinely new capability, no existing equivalent |
| `standard-zeros.ts` (`createStandardZeros`, `ensureCategoryIndexes`) | New kernel module + MCP write tool — scaffold XX.00–XX.09 in a category, self-heal a missing XX.00 |
| `promote-to-folder.ts` (note → folder + cover note) | New kernel module + MCP write tool |
| `new-from-template.ts` (template-driven note creation) | New MCP write tool, taking explicit args instead of interactive prompts |
| `new-category.ts`'s scaffolding half (folder + standard zeros for a new category) | Folds into the standard-zeros tool above; the "next free category number" half is already `obsidian_next_address` |

### Explicitly out — superseded, not ported

| jd-dashboard piece | Why dropped |
|---|---|
| `renumber.ts` | `obsidian_renumber_address` is already a strict superset (`dry_run`, `on_occupied: auto/manual/fail`, occupant displacement) |
| `validator.ts`'s `broken-wikilink` | `obsidian_check_links` already does this |
| Every `jd-id`/`jd-title` frontmatter check (`scanDrift`'s `id-mismatch`/`missing-frontmatter`/`title-mismatch`, `validator.ts`'s `required-fields`/`duplicate-id`/`title-mismatch`, `normalizer.ts`, `sync-id.ts`) | Frontmatter-canonical model, superseded by scheme's path-canonical design (see Precedent above) |
| Everything reading/writing `jd-index.yaml`/`jd.yaml` (`findMissingStubs`, `checkUnregisteredIds`, `checkJdexTitleMismatch`, `render-jdex.ts`, the debounced rebuild-on-save write-back) | External registry file, no equivalent or need in vault-mcp's design; a note's identity lives in the vault, not a second file coordinating with a separate CLI |
| `validator.ts`'s `date-format`, `orphaned-file`, `empty-note` | General vault QA, unrelated to JD addressing specifically — out of scope for *this* fold regardless of merit on their own |
| `migrate-readme.ts` | One-time historical migration script, zero ongoing value |
| `go-to-id.ts`'s fuzzy-search-and-open command | The resolution logic it depends on (`obsidian_resolve_address`) already exists; the interactive `SuggestModal` UX itself is a nice-to-have, not scoped here — can be a follow-up if wanted |
| Settings tab, ribbon icons, file-menu submenu beyond what the two panes need | Chrome for features not being ported; whatever chrome the inbox/drift panes need is scoped as part of their own wiring, not a separate deliverable |

## Architecture

### Inbox panel

Pure kernel query: given the vault's markdown file listing and a scheme instance,
count files under each `<area>.01`-pattern folder, grouped by area, sorted
busiest-first. This is new — no existing tool does this specific rollup, though it
composes cleanly from primitives `tools-scheme.ts` already exposes
(`obsidian_list_scope`'s `membersOf`). Lives as a small new function, likely
`kernel/scheme/inbox.ts` (sibling to `findings.ts`, same "pure, no obsidian
import" discipline) since it is genuinely a scope-provider-shaped question ("what's
in this address prefix"), not JD-specific scaffolding.

Pane: new `ItemView`, sidebar, live-updating on vault change events (matching the
original's behavior) — click a row to reveal the folder in the file explorer via
`app.workspace.getLeaf().openFile` / the file-explorer reveal API the original
used.

### Drift panel

**Must consume the ratcheted result, not raw `schemeFindings()`** — this is the
corrected understanding from earlier in this conversation and is load-bearing for
this whole section. Concretely: `RunResult.ratchet.newKeys: string[]` is a list of
finding *keys* (the `(script, check, target, kind)` 4-tuple, stringified), not
full `Finding` objects with human-readable `detail`. Rendering the panel needs the
NEW findings' full detail, so the pane's data path is:

1. Run the conformance engine (`runConformance`, filtered to the `scheme_findings`
   pack — this is a live, in-process pane, not a CLI invocation, so this needs a
   headless-safe entry point the pane can call against the live vault; the
   existing `packs/scheme.ts` + `findings.ts` + `ratchet.ts` pieces are exactly
   what's needed, just not yet wired for an in-plugin live call rather than a CLI
   run against a disk snapshot).
2. Cross-reference `ratchet.newKeys` against the run's full `findings: Finding[]`
   (same `findingKey()` function `ratchet.ts` itself uses) to recover `detail` per
   new finding.
3. Group by `check` (mirroring the original panel's grouping by issue type:
   `wrong-folder` ≈ `misfiled`, plus `duplicate_address`, `malformed_name`,
   `unaddressed`, `name_colon`, `name_trailing_space` — everything `findings.ts`
   already computes) and render.

This was more design work than the other pieces — it's the one place this fold
touches the conformance engine's live-vault story, which is CLI/disk-snapshot
oriented (`buildSnapshot` reads from disk via `--root`). **Resolved at Stage C**:
neither in-memory-snapshot-from-`app.vault` nor shell-out-to-CLI — the answer
is a THIRD option, already precedented and already shipped: call
`runConformance` (`conformance/cli.ts`) directly, in-process, no subprocess,
reading the vault's on-disk root via `FileSystemAdapter.basePath` — exactly
what `mcp/obsidian-debt-source.ts` already does for the shipped
`obsidian_conformance_debt` MCP tool. Stage C's `mcp/obsidian-drift-source.ts`
reuses that same pattern (root/baseline/excludedRoots resolution, `legacyPacks:
true` to keep the ratchet comparison honest against the real baseline), keeping
(not discarding) the ratchet result and narrowing it to the scheme pack's NEW
findings via the new pure `conformance/drift-view.ts`.

One-click "fix" buttons (the original's per-row wrench icon) were SCOPED OUT of
Stage C, not silently dropped: the original writes directly via
`app.vault.process`/`app.vault.create`, bypassing this plugin's guard/journal/
queue discipline entirely (which the original has no equivalent of at all).
Routing a human-gesture button click through `Kernel.runMutation` correctly —
matching what `obsidian_refile_address`/`obsidian_renumber_address` already do
for an MCP call — is real design work of its own and deserves its own pass,
not a rushed addition to the read-path PR. Named follow-up, not a silent drop
(see the drift pane's own header comment).

### Scaffolding tools (category-index, standard-zeros, promote-to-folder, template creation)

New kernel module, `kernel/jd-scaffold/` — kept separate from `kernel/scheme/`
deliberately: `scheme/` is provider-agnostic (its `ScopeProvider` interface is
meant to fit GTD/PARA too, per its own design doc), while standard-zeros,
Contents-section format, and folder-promotion are Johnny-Decimal-specific
authoring conventions, not generic scope-provider behavior. Each becomes a pure
function taking an already-resolved note/folder listing (same discipline as every
other kernel module) plus a thin `mcp/tools-jd-scaffold.ts` glue layer registering
them as guarded, journaled MUTATING tools (`dry_run` required-first, matching
`tools-scheme-write.ts`'s convention) — these mutate real vault notes/folders, so
unlike survey/quickadd's config-mutation tools, they likely CAN register through
`modules-mount.ts` rather than needing the direct-`server.ts` hand-registration
those two needed (to confirm at plan time: depends on whether `readOnlyHint: false`
is the only gate, which per `packages/plugin/CLAUDE.md`'s module-host description
it is — a genuinely mutating module can opt in via `mutating: true`, same as five
other modules already do).

## Rollout (sketch — task breakdown is the plan doc's job, same as the quickadd precedent)

Given the size (this is a bigger fold than survey or quickadd Stage A), the same
staging discipline applies: land the narrowest independently-valuable slice first,
prove the pattern, then extend.

**This section was written before reading the actual source in detail.**
On closer read, `category-index.ts` (436 lines — three-tier `## Contents`
consolidation with description preservation) turned out to be comparable in
complexity to an entire quickadd-style Stage A on its own, and
`new-from-template.ts` (297 lines) is a second, separate moderate feature.
Bundling all four "scaffolding" pieces into one plan/stage — as originally
sketched below — would have produced a plan too large to execute or review as
a unit. The actual staging, split further once this was discovered (see the
Stage A plan doc's own "Scope narrowed" note for the full reasoning):

**Stage A — standard-zeros + promote-to-folder only.**
`kernel/jd-scaffold/` + `mcp/tools-jd-scaffold.ts`, registered as a
`mutating: true` module (matching the `skills` module's precedent). No pane
work, no conformance-engine question. Plan:
`docs/superpowers/plans/2026-08-19-jd-dashboard-fold-stage-a.md`.

**Stage A2 — category-index.** Its own plan, once Stage A has shipped and
proven the module's shape against the live vault.

**Stage A3 — template creation.** `new-from-template.ts`'s three
template-driven note-creation commands, taking explicit args instead of
interactive prompts. Its own plan.

**Stage B — inbox panel.** Smaller of the two UI pieces, no conformance-engine
question attached. Proves the pane+wiring pattern for this specific fold (third
instance overall, first for this module) before Stage C's harder problem.

**Stage C — drift panel.** The one piece with a real open design question (live
conformance-engine call path). Land last, once Stage B has already proven the
pane/wiring mechanics work for this module.

## Out of scope for this design

- Migrating away from jd-index.yaml/jd.yaml for users who still rely on the
  separate Python `jd-cli` tool directly — that tool is untouched by this fold;
  only jd-dashboard's Obsidian-side mirror of it is being retired.
- `go-to-id.ts`'s fuzzy-search command palette (noted above as a possible
  follow-up, not this design's job).
- Any change to the conformance engine's CLI/snapshot architecture beyond what
  Stage C's live-call question forces — that's this fold's problem to solve
  minimally, not an invitation to redesign the engine's disk-snapshot model.
