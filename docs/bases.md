# Bases — evaluated Base result sets for agents

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md). Since the S7 read-tier extraction (`suite-split-design.md` §6) this reference documents the standalone **`vault-bases`** plugin, not a module of the host plugin (`governor`).

The `vault-bases` plugin (#243, shipped in PR #248 as a module; extracted at S7) gives agents the *evaluated* rows of
an Obsidian **Bases** `.base` file — the same filtered, formula-computed, sorted result set
the human sees in a Bases view — without re-implementing any of the Bases
expression language. Two tools, declared read-only; there is no write
path and nothing here mutates the vault or the base file.

Files: `packages/bases/src/tools.ts` (the tool specs + the shared `queryBaseRows`
seam, Obsidian-free and headless-tested), `packages/bases/src/kernel/index.ts` (config, row bounding,
the serializer, the cleanup wrapper), `packages/bases/src/obsidian-source.ts` (the live adapter —
the only file that touches `obsidian`), and `packages/bases/src/main.ts` / `settings.ts` /
`settings-tab.ts` (its own settings plus the one-shot config adoption).

**Defaults**: the plugin's surface is **on** when it can be (it was the default-enabled module
before the extraction — a pure read surface over rows the session could already assemble
note-by-note), and it is **feature-gated**: it publishes nothing when the running Obsidian
lacks the public Bases API (pre-1.10) or the Bases core plugin's `base` → `bases` view-type
registration is absent, so an installed plugin on an old or Bases-disabled Obsidian is
*absent, not broken*. One difference the extraction introduces: availability is now checked
when the plugin publishes rather than per connection build, so upgrading Obsidian without
reloading the plugin leaves the tools absent until a reload.

## Now a satellite plugin, and the two tools were renamed

This capability shipped as the host plugin's `bases` module through 2026-08; as of the S7
extraction it is its own Obsidian plugin, id `vault-bases`, publishing its tools to the host
through the `vault-mcp-api` SDK's `publishTools`. **`base_list` and `base_query` are now
`vault_bases_list` and `vault_bases_query`.** The host publishes an external tool as
`<sanitized publisher id>_<bare name>`, so the plugin id and the tool namespace are the same
string; the `base_` prefix was stripped rather than carried, because keeping it would have
published `vault_bases_base_query`. Sessions and prompts calling the old names must be updated.

## The surface

| Tool | What it does |
| --- | --- |
| `vault_bases_list` | Enumerate the visible `.base` files, each with its declared views (name, type, column count). Reads each base's YAML; evaluates nothing. Broken files are listed with a marker (`error: "parse_error"` for bad YAML, `"invalid_shape"` for YAML that isn't a Bases mapping) rather than dropped. |
| `vault_bases_query` | `{path, view?, limit?}` → the selected view's evaluated rows: `{view, view_type, columns, rows: [{path, properties}], total, truncated}`. `view` defaults to the file's first declared view; values are stringified via the engine's own `Value.toString()`, with the engine's `NullValue` folded to a real JSON `null` so "absent" and the literal text `"null"` stay distinguishable. |

Typed refusals from the query tool (and from the shared seam, below): `bases_unavailable`,
`not_a_base`, `invalid_path`, `out_of_allowlist`, `not_found`, `base_parse_error`,
`view_not_found`, `base_timeout`. (`invalid_path` is new at S7: a `path` containing a
backslash is refused outright, because every check downstream splits on `/` alone.)

## The detached-leaf capture, and why

Obsidian's public Bases API (1.10+: `BasesEntry`, `BasesQueryResult`, `BasesView`,
`registerBasesView`) evaluates a `.base` query **only into a rendered view** —
`QueryController` is opaque and offers no headless evaluation. Rather than re-implement the
Bases expression language (a fidelity trap: filters, formulas, sort, per-view limits would
all drift from the engine), the adapter makes the engine itself compute, in a leaf the human
can't see. Three live findings (Obsidian 1.13, documented on #243's PR) shape the mechanism:

1. **A detached `WorkspaceLeaf`** (constructed directly, never inserted into the workspace
   layout) loads the real Bases container view — it is exempt from the deferred-view
   machinery, which only wraps leaves the workspace lays out.
2. **The engine's scan pauses unless the view is "shown"**: `QueryController.runQuery`
   awaits `viewContainerEl.isShown()` (⇔ `!!offsetParent`) between batches. So the leaf's
   `containerEl` is parented under a fixed-position, `opacity:0`, `pointer-events:none`,
   `z-index:-1000` host div on `document.body`: layout is real (the isShown gate passes),
   nothing paints, nothing is focusable — no tab, no flash, no focus steal, and the human's
   workspace tree is untouched.
3. **The engine instantiates the view registered for the declared view's type**, so a custom
   capture view type registered via `registerBasesView` would go unselected for real bases
   authored with `type: table` views. The adapter instead polls the public `BasesView.data`
   off the view the engine itself created. `data` is assigned only by a *completed*
   evaluation pass, so first-data means the full, filtered, formula-evaluated result set
   (verified live: 601 rows for a view whose filter matches exactly 601 notes).

Rows are materialized **eagerly** (paths + per-column values via the public
`BasesEntry.getValue`) because the engine recreates entry objects and they die with the leaf
— no live engine object escapes the cleanup boundary. The one non-public surface consumed is
the container view's `.controller.view` hop to the current `BasesView`; each hop is
feature-checked, and a missing shape degrades to a typed timeout refusal rather than a crash
or a hang. Cleanup runs in a `finally` — success, failure, and timeout alike — detaching the
leaf and removing the host div, and a `cancelled` flag stops the poll loop after a timeout.

## Timeouts, serialization, caps

- **Serialized: one capture at a time**, across the whole plugin process. The serializer is
  module-scoped (not per-connection) because the hidden leaf is a global resource. A
  **belt deadline** (timeout + 5s grace) settles the serializer task even if a
  non-conforming source's capture promise hangs, so the module-wide chain always moves on.
- **Time-boxed**: the plugin's `queryTimeoutMs` setting, default **30000 ms** (valid range
  1000–120000). The deadline is generous on purpose — Electron throttles the engine's
  batched scan while the window is hidden (measured on a 1.9k-note vault: ~5.7 s
  foreground-ish vs ~64 s hidden) — and expiry refuses with the typed, **retryable**
  `base_timeout`; nothing is mutated.
- **Row-capped**: the plugin's `rowCap` setting, default **500** (valid range 1–10000); the
  tool's `limit` argument clamps to it. Truncation reports `truncated: true` plus the
  pre-cap `total`.

## Allowlist behavior — and what S7 changed, in both directions

**Since S7 the enforced boundary is the HOST's, because a satellite cannot reach the host's guard settings.** The host's gate tests the arguments a call actually carries, so the two tools land differently and the difference matters:

- **`vault_bases_list` takes no arguments**, so under an active path allowlist the host blocks it **outright**. That is STRICTER than the module, which filtered its listing and answered.
- **`vault_bases_query` takes `path`, a recognized host path key**, so it is not blocked — the host's guard scopes it and refuses `out_of_allowlist` for a hidden base, which is the same answer the in-module belt used to give.
- **The ROW filter is now dormant, and that is a real loosening.** Dropping rows for hidden notes, and the boolean `some_rows_hidden` that disclosed it, both needed the module's own view of the allowlist. The host scopes the `path` ARGUMENT, never the row paths the engine discovers. So under an allowlist a query on a *visible* base can now return rows naming notes outside it, where the module filtered them. This is named rather than papered over; the seam that would re-light it (`ctx.visible`) is kept, unsupplied, and its tests still drive it, so a `vault-mcp-api` able to carry the caller's scope to a publisher — an apiVersion-2 item, the same one triage and cross-session named — restores it with no code change.
- **Residual, inherent to "Obsidian computes"** and unchanged by the extraction (the same class as `obsidian_check_links`' documented resolution oracle): the engine evaluates over the whole vault *before* any row filter, so a formula value on a visible row can be computed from hidden notes, and a view's own `limit` consumes slots on hidden rows — visible rows past that limit silently fail to appear.
- **Both tools declare `readOnly: true`, which the host distrusts** unless `vault-bases` is listed in its `trustedReadOnlyPlugins` setting. Untrusted, both register as mutating: read-only mode blocks them, and each call takes a write-queue slot and a journal record. Trust answers read-only mode only — it never changes the scoping gate above.

## `queryBaseRows` — the factored seam, and why it MOVED

The whole query evaluation path — validation, view selection, the serialized +
belt-deadlined capture, the allowlist row bound — is one exported function,
**`queryBaseRows`** (`packages/bases/src/tools.ts`); the query tool's own handler is a thin shell over it.

It was factored out for a second consumer, the triage module's Base-backed queues (#241):
`triage_queue {base, view?}` or a config-named `{queue}` evaluated a `.base` through the
*same* serializer, capture and typed refusals as the query tool, so one human-authored Base
definition drove the human's native Bases view and the agent's sweep.

**That consumer left the host at the suite split's S5 and did not take the seam with it,
and that decision still stands.** The capture drives a hidden Bases leaf, which is a *global*
resource — the module-scoped `captureSerializer` exists to hold it to one capture at a time,
and a copy of that serializer in a second plugin would race the first over the one leaf. So
`vault_triage_queue`'s base-backed forms refuse `bases_unavailable`, and callers wanting
evaluated Base rows use this plugin's query tool directly. See [triage.md](triage.md).

**At S7 the seam moved here, as one piece, with nothing left behind.** The race argument
that blocked triage never applied to bases itself: this is the code that OWNS the leaf and
the serializer, and once triage was gone the query tool's own handler was the seam's only
production caller anywhere in the repo. So `queryBaseRows`, `makeSerializer`, the
module-scoped `captureSerializer`, the belt deadline and `captureWithCleanup` all travelled
together. It had to be a MOVE and not a copy for the mirror-image reason — a serializer left
in the host would race this one over the same leaf — which is the S5 argument reinforced
rather than overturned: two plugins holding a serializer over one leaf is the same race
whichever two plugins they are. The factored shape stays, both because the query tool reads
better as a shell over it and because it is what a published Bases service would expose if
`vault-mcp-api` ever grows one.
