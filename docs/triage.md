# Inbox triage — the disposition substrate's second instance (#221, phase 3 shape per #241)

The successor to the vault's retired `dispose-inbox-item` QuickAdd flow,
shipped as a default-disabled capability module (`triage`) with exactly two
tools — a read-only queue view and one guarded mutating disposition verb.
There is **no pane UI** in this module, deliberately.

Phase 2 (0.9.0, #238) shipped ten dispositions ported verbatim from the
legacy flow. **Phase 3 replaces that table** (Nelson's 2026-08-19 ruling on
#241 — a breaking change vs #238, acceptable pre-release): the built-ins are
now the three **mechanical primitives**, everything richer is a
**human-declared config row**, and the queue generalizes to **Base-backed
queues** evaluated by Obsidian's own Bases engine.

## The substrate

Issue #221's observation: a triage instance = a queue predicate + a
disposition set. The **authority axis** sorts every verb with one rule: a
disposition that **confers standing** (accept, adopt, revert-of-standing) is
a human gesture — never an API; a disposition that is an ordinary reversible
write is agent-expressible through the guarded path.

Phase 1 (#101/#228) proved the shape on the live acceptance instance; phase 2
extracted the generic descriptor shape into `kernel/triage/dispositions.ts` —
the **disposition substrate**, still shared verbatim with the governance
instance (`kernel/governance/dispositions.ts`, untouched by phase 3). The
triage instance's **frozen code-level table** is now the three built-ins
(`kernel/triage/descriptors.ts`), all `authority: "agent"`. Declared rows are
*not* runtime additions to that table: they are **configuration** the planner
interprets — human-only-mutable data whose authority answer is uniform (every
declared row is exercised by an agent through the one guarded `triage_dispose`
tool; none confers standing).

The **merged table** (built-ins ∪ declared rows) is the single source: the
`triage_dispose` enum, its tool description, the module manifest's directory,
and this doc all render from `mergedDispositionsOf`.

## The three built-in primitives

| Disposition | Action | Target | Notes |
| --- | --- | --- | --- |
| `trash` | Obsidian trash (recoverable — never a hard delete) | refused | |
| `move` | link-healing move (parents created) | **required** | destination checked against `moveWhitelist`/`moveBlacklist` |
| `stamp` | frontmatter patch, note stays in place | refused | patch from `stampFrontmatter`; unconfigured ⇒ typed `patch_unresolved` |

**One shared description format:** each built-in carries default descriptive
text, human-overridable via `builtinDescriptions` — the *same* description
field declared rows carry, because descriptions exist to help agents pick the
right verb.

## Declared dispositions (the human's verb menu)

`modules.triage.config.declaredDispositions` is a JSON array of rows:

```json
[
  {"id": "escalate", "action": "stamp", "inPlace": true,
   "patch": {"tags": ["attention/user"]},
   "description": "flag the note for human attention and leave it in place"},
  {"id": "convert-to-action", "action": "stamp", "destination": "Tasks",
   "patch": {"tags": ["note/task"], "status": "open", "priority": "normal"},
   "description": "retype the note as a task and file it under Tasks"},
  {"id": "file-bookmark", "action": "choice", "choice": "File bookmark",
   "description": "run the human-authored bookmark-filing QuickAdd macro"}
]
```

Row shape: `{id, label?, description?, action: trash|move|stamp|choice,
patch?, destination?, inPlace?, choice?}`.

- **`trash`** rows take nothing else.
- **`move`** rows: optional `destination` (an explicit `target` overrides;
  without one, `target` is required).
- **`stamp`** rows: `patch` required. With `inPlace: true` (or no
  `destination`) the note stays put and `target` is refused; with a
  `destination` the row **stamps then moves** (frontmatter first, then the
  move — the legacy order); `inPlace: false` without a destination means
  "stamp then move to a required `target`".
- **`choice`** rows bind a QuickAdd choice — see the security model below.

**Defaults and deletion:** while `declaredDispositions` is unset, exactly one
default row exists — **`escalate`** (mechanically stamp-in-place; its patch —
i.e. the escalate tag — is configured via `escalateFrontmatter`, default
`{"tags": ["attention/user"]}`). Setting `declaredDispositions` explicitly
replaces the default set entirely: a list without `escalate` deletes it, and
`[]` leaves only the three built-ins.

**Collisions are refused loudly:** a row whose id matches a built-in or an
earlier row is reported (settings tab + `registry.problems`) and dropped —
never merged, never shadowing.

**Re-declaring the retired phase-2 verbs:** none of the other nine legacy
verbs ships, but each is one config row away — e.g. `route` ≈
`{"id": "route", "action": "move", "description": "move the note into the
folder it already belongs in"}`; `defer-to-someday` ≈ a stamp row with
`patch: {"status": "someday"}` and a `destination`; `archive-as-record` ≈ a
move row with a `destination`; `discard` ≈ the built-in `trash` under its own
name and description.

## Choice rows — the security model

A `choice` row executes a QuickAdd choice through the **shared #225
`executeChoice`-with-variables seam** (`mcp/quickadd-choice.ts` — the same
code path `obsidian_run_command`'s `variables` form rides), receiving
`{path, disposition, "_invoked-by": "agent"}`.

- **The opaque-execution denies are not weakened.** `quickadd:*` /
  `js-engine:*` command ids remain denied by default on `obsidian_cli` and
  `obsidian_run_command` (cli-policy.ts, untouched). The agent-facing surface
  here is the **disposition id only**; the choice binding lives in module
  config, which is **human-only-mutable** (no MCP surface can write plugin
  settings — the config-territory guard pins that). Declaring the row *is*
  the human re-enable, scoped to one macro under one named verb.
- **No dry-run.** The bound script is opaque — there is nothing to preview.
  A choice row refuses typed (`choice_dry_run_unsupported`) until the caller
  passes an **explicit `dry_run: false`**.
- **Journal + audit net.** The call is an ordinary guarded mutation: the
  journal records the `triage_dispose` op with the disposition id (the
  binding id) in its args digest; the row→choice mapping is auditable config.
  The script's own writes are not itemized by this tool (`effects_unknown:
  true`, no `filesChanged` claim) — but script writes are not
  human-attributed, so they **surface in the governance review queue via
  non-human attribution**: the existing reconciler audit net, defense in
  depth consistent with the fallible-not-adversarial model.
- QuickAdd absent/binding unresolved ⇒ typed refusals
  (`quickadd_unavailable`, `choice_not_found`); a script throw surfaces as an
  ordinary tool failure.

## Move whitelist / blacklist

`moveWhitelist` / `moveBlacklist` (optional, default = any destination) are
vault-relative folder **prefixes** (segment-boundary, case-sensitive)
bounding every planned move destination — the built-in `move`, declared move
rows, and stamp-then-move rows alike. Blacklist beats whitelist. The check
runs **at plan time and is re-checked at apply** (typed `move_denied`),
beside the existing computed-destination allowlist re-check.

## Queues

### The marker queue (default — unchanged from phase 2)

With no `base`/`queue` argument, `triage_queue` lists notes whose ancestor
folder name contains a configured `inboxMarkers` substring (default
`" Inbox for "`; the inbox's own folder note is never an item), oldest first,
with path/inbox/created/modified/age and frontmatter `type`/`status`.

### Base-backed queues (#241 point 5)

`triage_queue {base: "Views/Stale.base", view?: "..."}` returns the
**evaluated rows** of that `.base` — Obsidian's own Bases engine computes
(filters, formulas, sort; full fidelity) through the **bases module's shared
capture seam** (`tools-bases.ts`'s `queryBaseRows`: the same hidden-leaf
capture, the same one-at-a-time serializer, the same typed refusals as
`base_query`). The human authors the queue predicate in the native Bases UI,
and the same definition drives the human view AND the agent sweep — one
source of truth for "what is in this queue". Rows come back in the Base's own
order (the human declared it) as `{path, properties}`.

Config may declare **named queues** — `queues: [{"id": "acceptance",
"base": "Views/Acceptance.base", "view": "queue"}]` — so
`triage_queue {queue: "acceptance"}` works without the caller knowing the
path.

**Allowlist discipline identical to `base_query`:** a hidden `.base` refuses
`out_of_allowlist`; result rows for hidden notes drop silently with a
boolean-only `some_rows_hidden` (disclosed only while an allowlist is
active). **Feature gate:** when the Bases API is unavailable (pre-1.10
Obsidian) or the bases module is disabled, base-backed queues refuse typed
(`bases_unavailable`) — the marker queue still works.

**Membership boundary (deliberate, un-relaxed):** `triage_dispose` still
requires the note to be a *marker-queue* member (`not_inbox` otherwise). A
base-backed queue generalizes what an agent can *sweep*, not what
`triage_dispose` may touch — disposing a base-queued note outside an inbox
folder means ordinary tools (or adding its folder to `inboxMarkers`).

## Vault semantics are configuration

All of it lives at `modules.triage.config`, validated loudly (settings tab +
`registry.problems`) and degrading to defaults at use time: `inboxMarkers`,
`stampFrontmatter`, `escalateFrontmatter`, `moveWhitelist`, `moveBlacklist`,
`declaredDispositions`, `builtinDescriptions`, `queues`. A patch carrying an
acceptance field is refused at validation AND sanitized/dropped at coercion —
it can never reach a note. Patch semantics: **array values union** (existing
scalars promoted, duplicates not re-added), **scalars overwrite**.

### Migration from the phase-2 shape

A config written for 0.9.0 behaves sanely: the retired keys
(`actionDestination`, `knowledgeDestination`, `somedayDestination`,
`archiveDestination`, `actionFrontmatter`, `somedayFrontmatter`) are ignored
without noise; `inboxMarkers` keeps its meaning; a customized
`escalateFrontmatter` carries over into the default escalate row. The retired
verbs refuse `unknown_disposition` until re-declared as rows (recipes above).

## Guard posture

`triage` is a **mutating capability module** (`mutating: true`, default
DISABLED). Both tools register through the guard-patched registrar: read-only
mode, path allowlist, serialized write queue, journal, kernel args. Moves
ride the shared link-healing move primitive (`moveOne` —
`fileManager.renameFile`, parents created, **never an overwrite**:
`destination_occupied`); trash is Obsidian's trash; frontmatter transitions
go through `processFrontMatter` with the shared accept-forbidden rule
re-checked over every effective patch. The computed destination is not a call
argument, so the handler re-checks it against the allowlist itself (dry-run
and apply alike), plus the move white/blacklist re-check at apply.

## Report-first: dry-run by default

`triage_dispose` defaults to `dry_run: true`: the call reports the exact plan
(action, computed destination, patch, choice binding) and writes nothing
until `dry_run: false`. Refusals are computed identically in both modes.
The one asymmetry is choice rows (no preview exists — see above). A
mid-sequence failure at apply (patch landed, move failed) names the partial
state instead of hiding it.

## Scheme integration — optional, degrades cleanly

With the scheme module enabled, a dispose report carries a `scheme` advisory
(the note's own address + the folder the scheme expects it in) as a routing
hint; disabled/unavailable/erroring ⇒ the field is simply absent.

## The un-headless boundary

Everything above the adapters is Obsidian-free and unit-tested
(`tests/triage-module.test.mjs`): the built-in table, the merged table,
config parsing/validation, the queue predicate, the planner (including
white/blacklist), both handlers over a fake source, the base-queue path over
a fake seam, and the module mount. The un-headless seams are
`src/mcp/obsidian-triage-source.ts` (vault reads + the shared write
primitives + the live `runChoice` via `quickadd-choice.ts`) and — reached
through `modules-mount.ts` — `obsidian-bases-source.ts`'s hidden-leaf
capture, both verified live like every other adapter.
