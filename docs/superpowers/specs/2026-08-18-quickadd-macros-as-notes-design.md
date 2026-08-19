# QuickAdd macros as notes — design

**Status:** approved by Nelson in chat, 2026-08-18. Ready for planning.

## Problem

QuickAdd's `data.json` is the sole source of truth for every choice (macro/template/capture/multi) installed in the vault, and it has zero rename-tracking: a `UserScript` step's `path` is a raw string, checked against nothing. Moving or renaming the script it names silently breaks the macro. This is not a hypothetical — over the course of one session (2026-08-18) roughly 30 scripts broke exactly this way during a folder reorganization, discovered and fixed by hand, one macro at a time, by disabling QuickAdd, editing `data.json` with a Python script, and re-enabling it.

That editing method is itself a second problem: there is no supported way for an agent (or, really, anyone) to create or modify a QuickAdd choice without hand-editing plugin-internal JSON. It's fragile (a stray edit while the plugin is enabled risks a race with QuickAdd's own writes), unvalidated (nothing checks the result is well-formed before it's live), and it's not how anything else in this vault gets authored — every other piece of agent/vault tooling here is a note.

Two narrower fixes already shipped this session and remain in place: `obsidian_run_command` can now drive a QuickAdd choice through its own `executeChoice` API with variables (letting agents invoke the vault's existing dual-mode scripts headlessly), and a reactive reconciler script (`reconcile-macro-paths.md`) finds and repairs broken macro paths by unique-basename match. Both are real improvements, but both still treat `data.json` as the source of truth and only patch around it. This design closes the gap at the root: QuickAdd choices become vault notes, and `data.json` becomes generated output.

## Precedent

Nelson previously built exactly this pattern for a different target: `obsidian-vault-skills` (archived 2026-08-11, but its code remains readable) compiles vault notes — `type: skill`/`agent`/`policy`, structured via a single `parent:` wikilink per note — into a native Claude Code plugin. Its compiler is split into a pure transform (`transform.ts`, no `obsidian` import, unit-testable: `NoteInput[] → TransformResult`) and an Obsidian-side glue layer (`exporter.ts`) that resolves wikilinks and writes the result. The domain model doesn't transfer directly — QuickAdd choices have no single-parent ownership tree, and skills/agents/policies have no equivalent of QuickAdd's ordered macro steps — but the *shape* (pure transform, thin glue, one-way compile, "generated files must never be hand-edited") is exactly right here and this design reuses it deliberately.

## Scope

Full parity with QuickAdd's data model: all four choice types (Macro, Template, Capture, Multi) and, for Macro, all seven step types (UserScript, Choice, Wait, Obsidian command, NestedChoice, EditorCommand, AIAssistant). This document specifies the complete shape; implementation is expected to land in stages (see Rollout) rather than as one task.

## Note schema

One note per choice. `fileClass: [["QuickAddChoice.fileclass"]]` (or the vault's nearest equivalent typed-frontmatter convention — exact fileClass authoring is an implementation detail, not a design constraint). A `quickadd-type:` field carries which of the four kinds it is.

### Macro

An ordered `steps:` list. Each entry's shape is keyed by its own `kind:`:

| step kind | fields |
|---|---|
| `userscript` | `script: [[note]]` (wikilink to the script note) + `settings: {...}` (the script's own configurable options, e.g. `snippet` for a shared insert-at-cursor script) |
| `choice` | `choice: [[note]]` (wikilink to another top-level choice note — reuses the same reference mechanism) |
| `wait` | no fields — a bare marker |
| `obsidian-command` | `command_id: "<string>"` — literal, since not every registered Obsidian command has (or should have) a note |
| `nested-choice` | `choices: [[[note]], [[note]], ...]` — an ordered list of wikilinks, presented as a runtime picker |
| `editor-command` | `command_id: "<string>"` — literal, same reasoning as obsidian-command |
| `ai-assistant` | literal config (prompt, model, and whatever else QuickAdd's AI-assistant step exposes) — no note reference |

### Template

`template: [[note]]` (wikilink to the Templater/core template file) plus literal options: destination folder, file-name format, whether to open the created note.

### Capture

`target: [[note]]` for a fixed target file, OR a literal template-string path for a dynamic target (QuickAdd natively supports both — the field is a wikilink when the target is a specific known note, a plain string when it's computed at runtime). Plus literal options: prepend/append, insert-after-heading, create-if-missing.

### Multi

Becomes a **vault folder**, not a note with a children list. A lightweight folder-note (`quickadd-type: multi`) carries a description; the choices nested under it are simply the notes (and sub-folders) inside that folder. Membership is read from the folder's actual contents at compile time — the folder itself is the source of truth, mirroring QuickAdd's own folder-organized UI directly.

This is a deliberate, scoped divergence from vault-mcp's own stated principle elsewhere in the codebase ("frontmatter over geography — vault paths may appear in generated output but never as assumed conventions"). That principle governs the JD scope-provider module specifically, whose job is general-purpose path resolution across arbitrary vault layouts. This module's job is narrower and more literal: mirror one specific plugin's folder-organized config. Folder-as-truth is the right call here precisely because it isn't being asked to generalize.

### Reference resolution

Every cross-note reference in this schema is a wikilink, resolved via Obsidian's own `metadataCache` (the same mechanism `obsidian_resolve` already uses) — not a `uid:`. This was a deliberate choice over uid-based references: a wikilink gets Obsidian's own broken-link detection for free (an unresolved `[[script]]` shows up in the link panel immediately), and moving the target note keeps a wikilink pointing at it automatically. That "moving the file doesn't break the reference" property is the actual fix for the drift bug this design exists to close — not merely a nicer editing surface.

## Compiler architecture

A new vault-mcp tool. Split the same way as vault-skills' own compiler:

**Pure core** — `kernel/quickadd/transform.ts`, no `obsidian` import, unit-testable like every other kernel module. Takes `ChoiceNoteInput[]` (path, frontmatter, and each wikilink field already resolved to a target path — resolution is the glue layer's job, matching how `parentPaths` arrives pre-resolved into vault-skills' own transform) and produces a `TransformResult`: the `choices` array in QuickAdd's exact native `data.json` shape, plus `warnings`/`errors` per problem found (unresolved wikilink, ambiguous target, malformed step shape, an orphaned Multi folder, etc.).

**Glue layer** — `mcp/tools-quickadd.ts`. Walks the note tree under the QuickAdd-choices root (mirroring folder structure per the Multi rule above), resolves every wikilink field through `app.metadataCache`, feeds the pure transform, and — since vault-mcp is itself a full Obsidian plugin with `app.*` access, not an external process — applies the result in-process: `quickadd.settings.choices = result.choices; await quickadd.saveSettings()`. No raw `data.json` parsing or QuickAdd disable/enable cycling required; QuickAdd's own settings persistence does the actual write.

**Safety** — `dry_run` is required-first, matching the scheme-write tools (`obsidian_assign_address` et al.): a dry run returns the diff (choices added/changed/removed, by name) with nothing touched. A non-dry-run compile runs through vault-mcp's write queue and gets a journal record — this mutates plugin config rather than a vault note, so its journal shape is closer to the fileclass module's write tools than to `obsidian_write_note`'s note-centric one. **One bad note fails only that one choice** (reported as an error entry, choice omitted from the compiled result) rather than failing the whole compile — the same "static validation up front, no half-applied batch" discipline `obsidian_move_notes` already uses, so a single malformed macro can't take down every other one.

## Bootstrap (one-time, reverse direction)

A **separate** tool, `obsidian_quickadd_bootstrap` — not a mode flag on the compiler. Reads the current live `quickadd.settings.choices` and writes one note per choice (recursing into Multi choices as real vault folders), the only place data ever flows *from* `data.json` *to* notes. Kept as its own tool because bootstrap and compile are opposite directions with opposite risk profiles: bootstrap creates dozens of new notes from trusted existing config, compile overwrites live plugin config from notes someone is actively editing. Collapsing them into one tool behind a flag invites a wrong-direction accident later; two tools make the direction a property of which one you called, not an argument you could get backwards.

**Handling the already-broken legacy bucket:** roughly 22 existing choices (the `/old` bucket, left broken by Nelson's explicit call earlier this session) have `path`s that resolve to nothing. Bootstrap cannot wikilink to a note that doesn't exist. For those, the generated note's reference field carries the raw dead string plus a `broken: true` flag, rather than inventing a fake link — preserving the fact that they're broken until someone actually fixes or retires them, instead of silently papering over it.

## Edit discipline

Once a choice is note-backed, QuickAdd's own settings UI is **read/run-only** for it — editing a choice there gets silently overwritten on the next compile. This matches vault-skills' own rule exactly ("the generated files must never be hand-edited — edit the note, re-export") and is a deliberate choice over a two-way reconciler: running or testing a macro from the command palette is completely unaffected; only *editing a choice's definition* moves to the note. A two-way sync was considered and rejected — it reintroduces the exact class of drift problem this design exists to eliminate, just with an extra reconciliation step in front of it instead of behind it.

## Rollout (sketch — task breakdown is writing-plans' job)

Bootstrap once, against the real live vault, so the note corpus starts populated and accurate. From that point on, the compiler is the only path for anything touching QuickAdd config, agent or human. The actual implementation is expected to land in stages — transform module and its tests, the compile tool, the bootstrap tool, a real bootstrap-and-verify pass against the live vault, then documenting the new edit-discipline rule somewhere Nelson and future sessions will actually see it before touching a QuickAdd choice by hand again.

## Out of scope for this design

- Migrating the ~22 already-broken legacy `/old` scripts to a working state — bootstrap preserves their broken-ness faithfully; fixing them is the same "leave for now" call Nelson already made, unaffected by this design.
- Any change to QuickAdd itself (forking it, patching `executeChoice` to return a value, etc.) — this design works entirely from the outside, against QuickAdd's existing public surface.
- A UI for editing choice notes beyond ordinary Obsidian note editing — no custom view, no wizard.
