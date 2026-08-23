# The Bases module — evaluated Base result sets for agents

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


The `bases` capability module (#243, shipped in PR #248) gives agents the *evaluated* rows of
an Obsidian **Bases** `.base` file — the same filtered, formula-computed, sorted result set
the human sees in a Bases view — without the module re-implementing any of the Bases
expression language. Two read-only tools, both `readOnlyHint: true`; the module has no write
path and mutates neither the vault nor the base file.

Files: `packages/plugin/src/mcp/tools-bases.ts` (the tool surface + the shared `queryBaseRows`
seam, Obsidian-free and headless-tested), `src/kernel/bases/index.ts` (config, row bounding,
the serializer, the cleanup wrapper), `src/mcp/obsidian-bases-source.ts` (the live adapter —
the only file that touches `obsidian`).

**Defaults**: the module ships **enabled** (the scheme/vocab precedent — a pure read surface
over rows the session could already assemble note-by-note), and it is **feature-gated**: the
registrar registers nothing when the running Obsidian lacks the public Bases API (pre-1.10)
or the Bases core plugin's `base` → `bases` view-type registration is absent, so an enabled
module on an old or Bases-disabled Obsidian is *absent, not broken*.

## The surface

| Tool | What it does |
| --- | --- |
| `base_list` | Enumerate the visible `.base` files, each with its declared views (name, type, column count). Reads each base's YAML; evaluates nothing. Broken files are listed with a marker (`error: "parse_error"` for bad YAML, `"invalid_shape"` for YAML that isn't a Bases mapping) rather than dropped. |
| `base_query` | `{path, view?, limit?}` → the selected view's evaluated rows: `{view, view_type, columns, rows: [{path, properties}], total, truncated}` (+ `some_rows_hidden` under an allowlist). `view` defaults to the file's first declared view; values are stringified via the engine's own `Value.toString()`, with the engine's `NullValue` folded to a real JSON `null` so "absent" and the literal text `"null"` stay distinguishable. |

Typed refusals from `base_query` (and from the shared seam, below): `bases_unavailable`,
`not_a_base`, `out_of_allowlist`, `not_found`, `base_parse_error`, `view_not_found`,
`base_timeout`.

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
- **Time-boxed**: `modules.bases.config.queryTimeoutMs`, default **30000 ms** (valid range
  1000–120000). The deadline is generous on purpose — Electron throttles the engine's
  batched scan while the window is hidden (measured on a 1.9k-note vault: ~5.7 s
  foreground-ish vs ~64 s hidden) — and expiry refuses with the typed, **retryable**
  `base_timeout`; nothing is mutated.
- **Row-capped**: `modules.bases.config.rowCap`, default **500** (valid range 1–10000); the
  tool's `limit` argument clamps to it. Truncation reports `truncated: true` plus the
  pre-cap `total`.

## Allowlist behavior

- `base_list` filters the `.base` paths through the host's visibility filter **before**
  reading any file — a hidden base is absent from the answer, not refused.
- `base_query` **refuses** `out_of_allowlist` for a hidden base (a belt to the guard's own
  path-argument check — the handler is also reachable with no guard in front, and the triage
  queue's `base` argument is not a guard-recognized path key).
- Result **rows for hidden notes drop silently**; under an active allowlist the response
  carries a boolean **`some_rows_hidden`** — a boolean and not a count, per the
  visible-totals precedent against cardinality oracles. With no allowlist the field is
  omitted entirely (it would be a constant `false`).
- **Residual, inherent to "Obsidian computes"** (the same class as `obsidian_check_links`'
  documented resolution oracle): the engine evaluates over the whole vault *before* the row
  filter, so a formula value on a visible row can be computed from hidden notes, and a
  view's own `limit` consumes slots on hidden rows — visible rows past that limit silently
  fail to appear.

## The triage named-queues consumer

The whole `base_query` evaluation path — validation, view selection, the serialized +
belt-deadlined capture, the allowlist row bound — is one exported function,
**`queryBaseRows`** (`tools-bases.ts`), and the triage module's Base-backed queues (#241)
consume it directly: `triage_queue {base, view?}` or a config-named `{queue}` evaluates a
`.base` through the *same* serializer, capture and typed refusals as `base_query`, so one
human-authored Base definition drives the human's native Bases view and the agent's sweep.
Two gates give typed refusals instead of silent degradation: a pre-Bases Obsidian refuses
`bases_unavailable` via the source's own availability probe, and a disabled bases module
refuses `bases_unavailable` from the triage seam (a queue is load-bearing, not advisory).
See [triage.md](triage.md).
