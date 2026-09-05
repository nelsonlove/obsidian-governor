# Inbox triage — the disposition substrate's second instance (#221, phase 3 shape per #241)

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md). Since the S5 satellite extraction (`suite-split-design.md` §6) this reference documents the standalone **`vault-triage`** plugin, not a module of the host plugin (`governor`).


The successor to the vault's retired `dispose-inbox-item` QuickAdd flow,
shipped as the standalone `vault-triage` plugin with exactly two tools — a
read-only queue view and one guarded mutating disposition verb, published to
the Governor host through `vault-mcp-api`. There is **no human UI** in this
plugin beyond its settings tab, deliberately: no pane, no palette command, no
ribbon.

Phase 2 (0.9.0, #238) shipped ten dispositions ported verbatim from the
legacy flow. **Phase 3 replaces that table** (Nelson's 2026-08-19 ruling on
#241 — a breaking change vs #238, acceptable pre-release): the built-ins are
now the three **mechanical primitives**, and everything richer is a
**human-declared config row**.

## Now a satellite plugin

Triage shipped as the host's default-disabled `triage` capability module until
the suite split's **S5**, when it was extracted to `packages/triage` (plugin
id `vault-triage`) — the design doc's §6 row *"Triage | private operator |
satellite"*. It follows `packages/quickadd-choices-compile` (the pilot) and
`packages/skills` (S4). The planner and the disposition table are the same
code through both homes; only who mounts them differs. Four things changed,
and all four are visible to a caller:

**1. The published tool names changed.** `triage_queue` and `triage_dispose`
are now **`vault_triage_queue`** and **`vault_triage_dispose`**. The host
publishes an external tool as `<sanitized publisher id>_<bare name>`, so the
plugin id and the tool namespace are the same string, and `vault-triage`
sanitizes to `vault_triage`. (The skills satellite kept its names only because
`vault-skills` sanitizes to exactly the `vault_skills` prefix its six tools
already carried.) Sessions and prompts calling the old names must be updated.

**2. The allowlist boundary moved to the host.** The host distrusts an
external tool's `readOnlyHint: true` unless the publisher's raw id is in its
`trustedReadOnlyPlugins` setting, so **both** tools register as mutating; and
a mutating external tool whose arguments carry no recognized path key is
**blocked outright** while a path allowlist is active — trusted or not.
`vault_triage_queue` carries none (`base`, `view` and `queue` are not path
keys, and the marker queue takes no path at all), so under an allowlist it is
refused **wholesale**, where the module merely filtered its listing. That is
fail-closed and strictly stricter. `vault_triage_dispose` carries `path`, so
it is scoped normally — and its destination argument was **renamed `target` →
`target_path`** in the same motion, because `target_path` is one of the host's
recognized path keys and `target` is not, so the guard now checks the
destination folder the caller names. See *Guard posture* below for what that
does and does not cover.

**3. Base-backed queues are unavailable.** See *Queues* below.

**4. Config moved to this plugin's own settings tab**, adopting the recognized
keys out of the host's former `modules.triage.config` once, on first load. See
*Vault semantics are configuration* below.

## The substrate

Issue #221's observation: a triage instance = a queue predicate + a
disposition set. The **authority axis** sorts every verb with one rule: a
disposition that **confers standing** (accept, adopt, revert-of-standing) is
a human gesture — never an API; a disposition that is an ordinary reversible
write is agent-expressible through the guarded path.

Phase 1 (#101/#228) proved the shape on the live acceptance instance; phase 2
extracted the generic descriptor shape into a **disposition substrate**, which
S3 then published to `@vault-mcp/core`. That publication is exactly what let
triage leave: the acceptance instance (`governor/kernel/dispositions.ts`, in
the host) and the triage instance now declare against one shape from two
plugins that share no build, and neither depends on the other. The triage
instance's **frozen code-level table** is the three built-ins
(`packages/triage/src/kernel/descriptors.ts`), all `authority: "agent"`.
Declared rows are *not* runtime additions to that table: they are
**configuration** the planner interprets — human-only-mutable data whose
authority answer is uniform (every declared row is exercised by an agent
through the one guarded `vault_triage_dispose` tool; none confers standing).

The **merged table** (built-ins ∪ declared rows) is the single source: the
`vault_triage_dispose` enum, its tool description, and this doc all render
from `mergedDispositionsOf`. Because a published tool's schema is snapshotted
by the host, the plugin **re-publishes both tools on every settings write** —
otherwise a newly declared row would be unreachable through the enum until an
Obsidian reload.

## The three built-in primitives

| Disposition | Action | Target | Notes |
| --- | --- | --- | --- |
| `trash` | Obsidian trash (recoverable — never a hard delete) | refused | |
| `move` | link-healing move (parents created) | **required** (`target_path`) | destination checked against `moveWhitelist`/`moveBlacklist` |
| `stamp` | frontmatter patch, note stays in place | refused | patch from `stampFrontmatter`; unconfigured ⇒ typed `patch_unresolved` |

**One shared description format:** each built-in carries default descriptive
text, human-overridable via `builtinDescriptions` — the *same* description
field declared rows carry, because descriptions exist to help agents pick the
right verb.

## Declared dispositions (the human's verb menu)

`declaredDispositions`, in the plugin's settings tab, is a JSON array of rows:

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
- **`move`** rows: optional `destination` (an explicit `target_path`
  overrides; without one, `target_path` is required).
- **`stamp`** rows: `patch` required. With `inPlace: true` (or no
  `destination`) the note stays put and `target_path` is refused; with a
  `destination` the row **stamps then moves** (frontmatter first, then the
  move — the legacy order); `inPlace: false` without a destination means
  "stamp then move to a required `target_path`".
- **`choice`** rows bind a QuickAdd choice — see the security model below.

**Defaults and deletion:** while `declaredDispositions` is unset, exactly one
default row exists — **`escalate`** (mechanically stamp-in-place; its patch —
i.e. the escalate tag — is configured via `escalateFrontmatter`, default
`{"tags": ["attention/user"]}`). Setting `declaredDispositions` explicitly
replaces the default set entirely: a list without `escalate` deletes it, and
`[]` leaves only the three built-ins.

**Collisions are refused loudly:** a row whose id matches a built-in or an
earlier row is reported in the settings tab and dropped — never merged, never
shadowing.

**Re-declaring the retired phase-2 verbs:** none of the other nine legacy
verbs ships, but each is one config row away — e.g. `route` ≈
`{"id": "route", "action": "move", "description": "move the note into the
folder it already belongs in"}`; `defer-to-someday` ≈ a stamp row with
`patch: {"status": "someday"}` and a `destination`; `archive-as-record` ≈ a
move row with a `destination`; `discard` ≈ the built-in `trash` under its own
name and description.

## Choice rows — the security model

A `choice` row executes a QuickAdd choice through the **shared #225
`executeChoice`-with-variables seam** — the same code path
`obsidian_run_command`'s `variables` form rides, receiving
`{path, disposition, "_invoked-by": "agent"}`. The seam lives in
`@vault-mcp/core` since S5: its two callers are now in different plugins, and
it exists precisely so they cannot drift on how a choice is resolved and
invoked. It was published rather than copied for that reason.

- **The opaque-execution denies are not weakened.** `quickadd:*` /
  `js-engine:*` command ids remain denied by default on `obsidian_cli` and
  `obsidian_run_command` (cli-policy.ts, untouched). The agent-facing surface
  here is the **disposition id only**; the choice binding lives in this
  plugin's own config, which is **human-only-mutable** (no MCP surface can
  write plugin settings). Declaring the row *is* the human re-enable, scoped
  to one macro under one named verb.
- **No dry-run.** The bound script is opaque — there is nothing to preview.
  A choice row refuses typed (`choice_dry_run_unsupported`) until the caller
  passes an **explicit `dry_run: false`**.
- **Journal + audit net.** The call is an ordinary guarded mutation: the
  journal records the `vault_triage_dispose` op with the disposition id (the
  binding id) in its args digest; the row→choice mapping is auditable config.
  The script's own writes are not itemized by this tool (`effects_unknown:
  true`, no `filesChanged` claim) — but script writes are not
  human-attributed, so they **surface in the acceptance review queue via
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

With no `base`/`queue` argument, `vault_triage_queue` lists notes whose ancestor
folder name contains a configured `inboxMarkers` substring (default
`" Inbox for "`; the inbox's own folder note is never an item), oldest first,
with path/inbox/created/modified/age and frontmatter `type`/`status`.

### Base-backed queues (#241 point 5) — UNAVAILABLE since S5

While triage was a host module, `triage_queue {base: "Views/Stale.base",
view?: "..."}` returned the **evaluated rows** of that `.base` — Obsidian's
own Bases engine computing filters, formulas and sort at full fidelity —
through the bases module's shared capture seam (`queryBaseRows`, then in the
host's `mcp/tools-bases.ts`; since S7 in `packages/bases/src/tools.ts`). One
human-authored Base definition drove the human's native view and the agent's
sweep.

**That seam did not come with triage, and copying it would have been wrong
rather than merely large.** The capture drives a hidden Bases leaf, which is a
*global* resource: its owner guards it with a module-scoped serializer holding
it to one capture at a time, and a second serializer in a second plugin would
race the first over the one leaf. The seam also reaches the bases surface's own
config and typed-refusal vocabulary, neither of which is published.

**S7 reinforced that reasoning rather than overturning it.** When bases itself
left the host it took `queryBaseRows` and the serializer WITH it — a move, with
no copy left behind — so there is still exactly one serializer over the one
leaf, owned now by the `vault-bases` plugin instead of the host. A copy in
`packages/triage` would still be wrong today: two plugins each holding a
serializer over the one leaf is the same race whichever two plugins they are.

So `base`, `view` and `queue` **refuse typed (`bases_unavailable`)** — through
the same feature-gate branch that always covered a pre-Bases Obsidian, with a
message saying why. The marker queue above is unaffected and is the working
surface. For evaluated Base rows, use the `vault-bases` satellite's
`vault_bases_query` tool — the same evaluation path, under the name publication
gave it (the module's `base_query`; `base_list` likewise became
`vault_bases_list`). The arguments and the `queues` config field are kept (its
help text says it is inert) so the feature re-lights the day `vault-mcp-api` can
hand a publisher a Bases service — an apiVersion-2 item, alongside carrying the
caller's scope to a publisher.

**Membership boundary (deliberate, un-relaxed):** `vault_triage_dispose`
requires the note to be a *marker-queue* member (`not_inbox` otherwise). That
was true when base-backed queues worked and is true now: a queue generalizes
what an agent can *sweep*, never what the disposition verb may touch.

## Vault semantics are configuration

All of it lives in the `vault-triage` plugin's own settings tab, validated
loudly and degrading to defaults at use time: `inboxMarkers`,
`stampFrontmatter`, `escalateFrontmatter`, `moveWhitelist`, `moveBlacklist`,
`declaredDispositions`, `builtinDescriptions`, `queues`. A patch carrying an
acceptance field is refused at validation AND sanitized/dropped at coercion —
it can never reach a note. Patch semantics: **array values union** (existing
scalars promoted, duplicates not re-added), **scalars overwrite**.

### Migration from the host's `modules.triage.config`

Configuration used to live in the host's `data.json` at
`modules.triage.config`. On its first load the satellite copies the recognized
keys into its own `data.json` and latches. It **never writes the host's
settings** — not to delete the adopted keys, not to mark them migrated; the
host's copy stays where it is and simply stops being read. It **runs once**, so
a later host edit cannot reach back in. **This plugin's own values win**, so
adoption only fills gaps. And if the host is absent — or present but still
mid-onload, with its `settings` not yet assigned — nothing is adopted and the
latch is *not* set, so the one chance survives to a later load.

For triage this is a safety migration rather than a convenience:
`moveWhitelist` and `moveBlacklist` are the human's bound on where a
disposition may send a note, and an empty config means "any destination".

### Migration from the phase-2 shape

A config written for 0.9.0 behaves sanely: the retired keys
(`actionDestination`, `knowledgeDestination`, `somedayDestination`,
`archiveDestination`, `actionFrontmatter`, `somedayFrontmatter`) are ignored
without noise; `inboxMarkers` keeps its meaning; a customized
`escalateFrontmatter` carries over into the default escalate row. The retired
verbs refuse `unknown_disposition` until re-declared as rows (recipes above).

## Guard posture

Both tools are published external tools and register at the host's guarded
registration point like every built-in: read-only mode, path allowlist,
serialized write queue, journal, kernel args. Publishing exempts a tool from
none of it. Moves ride a link-healing rename
(`fileManager.renameFile`, parents created, **never an overwrite**:
`destination_occupied`); trash is Obsidian's trash; frontmatter transitions
go through `processFrontMatter` with the shared accept-forbidden rule
re-checked over every effective patch.

**What the allowlist covers, precisely.** `path` and `target_path` are call
arguments the host's guard checks. A declared row's *configured* `destination`,
used without a `target_path`, is not — it is not a call argument, so nothing
the host sees names it. The bound on that path is the human's own
`moveWhitelist` / `moveBlacklist`, enforced at plan time and re-checked at
apply, which is the right bound for it: the session allowlist scopes what the
*caller* can name, and a declared row's destination is the human's standing
choice rather than the agent's. The in-handler re-check of the computed
destination against the allowlist is retained in the code but is dormant, since
a satellite cannot reach the host's guard settings.

**There is no second write path.** This plugin has no pane, command or ribbon,
so nothing here can write to the vault outside the host's journal. Every vault
write is inside `vault_triage_dispose`'s handler, which is only ever reached
through the host.

## Report-first: dry-run by default

`vault_triage_dispose` defaults to `dry_run: true`: the call reports the exact
plan (action, computed destination, patch, choice binding) and writes nothing
until `dry_run: false`. Refusals are computed identically in both modes. The
one asymmetry is choice rows (no preview exists — see above). A mid-sequence
failure at apply (patch landed, move failed) names the partial state instead
of hiding it: it refuses `dispose_partially_applied` with the note's path, the
patch that was written, and the underlying error in the message.

The default itself, and the queue's `limit` bounds, are **re-applied in the
handlers**. The SDK converts a zod schema to JSON Schema and the host converts
it back through a deliberately small subset: `type`, `description` and string
`enum` survive the round trip; `default`, `min`, `max` and `pattern` do not. A
bound that lives only in the declared schema never runs for an MCP caller.

## Scheme integration — optional, degrades cleanly

While triage was a host module, a dispose report carried a `scheme` advisory
(the note's own address + the folder the scheme expects it in) as a routing
hint whenever the scheme module was enabled. The scheme module is host-side
and exposes no published read service, so the satellite supplies no such seam
and the field is simply absent — the same clean degradation the advisory
always had when scheme was disabled. It was never load-bearing.

## The un-headless boundary

Everything above the adapter is Obsidian-free and unit-tested
(`packages/triage/tests/triage-module.test.mjs`): the built-in table, the
merged table, config parsing/validation, the queue predicate, the planner
(including white/blacklist), both handlers over a fake source, the base-queue
path over a fake seam, the publication contract (names, flags, which arguments
the host's guard can scope), and the one-shot settings adoption. The handler
tests run through `tests/host-shim.mjs`, which reproduces the host's published
naming, its `ok()`/`fail()` envelopes and the annotations it derives from an
*untrusted* read-only claim, so they assert the envelopes an agent actually
sees.

The one un-headless seam is `packages/triage/src/obsidian-source.ts` (vault
reads, the write primitives, and the live `runChoice`) — and even that is
reached headlessly for the property that matters: `link-healing.test.mjs`
drives the real adapter against a fake app whose `vault.rename` throws, and
scans this package's own source for any call to it. That scan is proven
against a planted violation.
