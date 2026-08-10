# The acceptance model

> **This is the heart of the design.** Everything else in the kernel — the queue, the
> journal, the modules — is machinery. This is the invariant the machinery exists to
> protect.

## Acceptance is a human gesture, and it goes in no API

An agent may *propose* a change to the vault. It may write notes, edit frontmatter, attach
its reasoning, and mark its own work `acceptance-status: proposed`. What it may **never** do
is declare that a change has been **accepted**. Acceptance — the moment a human blesses a
proposed change as canonical — is made by a person, in the
[Stewardship](README.md#the-stewardship-plugin) review pane, and **nowhere else**.

The design scar, stated exactly as it appears throughout the source:

> **"the accept verb goes in no API."**

There is no `obsidian_accept` tool. There is no `accept` argument on any write. There is no
CLI command the proxy will run to set acceptance. And — the part that makes it a
*guarantee* rather than a *convention* — an agent cannot smuggle acceptance in as **data**
either, by writing `acceptance-status: accepted` (or `accepted-by`, `accepted-on`) into a
note's frontmatter. The kernel refuses that write.

Concretely, the three fields that constitute an acceptance assertion:

- `acceptance-status: accepted` (the status field set to an accepted value)
- `accepted-by: <name>` (who accepted)
- `accepted-on: <date>` (when)

A write that **introduces** any of these is rejected with `Error [accept_forbidden]`. Agents
write only `acceptance-status: proposed`; the accepted-family is reserved for the human's
gesture.

## The accept-forbidden guard

The guarantee is enforced at the **shared write primitive** — the single point every
filesystem-expressible write routes through — so it holds on **every write surface at once**,
not tool by tool. The rule itself is defined once
(`packages/plugin/src/mcp/write-notes-compose.ts`) and reused everywhere; there is no second
definition of "accepted" to drift.

### What counts as "accepted" (every value-type, every key spelling)

The detector (`isAcceptedValue` / `isAcceptedKey` in `write-notes-compose.ts`) is deliberately
broad, because an agent trying to slip acceptance through would reach for the shapes a naive
string check misses:

- **A key** is acceptance-provenance if it matches `/^accepted([-_ ].*)?$/` (case-insensitive,
  trimmed): `accepted`, `accepted-by`, `accepted-on`, `accepted_by`, `accepted on`, …
- **A value** *asserts* acceptance if — across **every value-type it can take** — it resolves
  to `accepted` / `accepted-*`:
  - a **scalar string** (`accepted`, `accepted-by-nelson`);
  - an **array** containing one (`[accepted]`) — this was the "S3 hole" a string-only check
    left open;
  - a **map** wrapping one (`{value: accepted}`).
- The **`acceptance-status`** key (and `acceptance_status`) is checked for an *asserting*
  value specifically — `acceptance-status: proposed` is fine, `acceptance-status: accepted`
  is not.

### It checks the note that would land on disk — body-embedded frontmatter included

The guard runs over the **resulting frontmatter of the note that would actually be written**,
parsed from the final markdown with Obsidian's own YAML parser — not over a structured
argument. This closes the "S2" evasion: a caller who embeds a raw
`---\nacceptance-status: accepted\n---` fence in a note **body** (rather than in a structured
frontmatter argument) still has that fence become the note's real frontmatter, so it is
parsed and caught. `frontmatterOf()` matches a leading `---` fence exactly the way Obsidian
recognizes one (`packages/plugin/src/mcp/obsidian-backend.ts`, `guardWrittenContent`).

### It is a transition, not a snapshot — a human's `accepted` survives

The rule is about **introducing or changing** acceptance, not about the mere presence of an
accepted value. `acceptTransitionReason(before, after)` compares the resulting frontmatter
against the note's current on-disk frontmatter:

- **Introducing** an accepted-family field that was not there before → rejected.
- **Changing** an existing accepted value to a different one → rejected.
- **Preserving** an existing (human-granted) accepted value **verbatim** → **allowed**.

This is essential: a legitimate agent edit to a note a human *already accepted* must be able
to carry that `accepted` value forward unchanged. Destroying the human's decision would
violate the invariant just as much as forging it would. So the on-disk value is read (only
when the resulting frontmatter asserts acceptance at all — the common clean write pays no
extra read) and equality-checked; an exact carry-forward passes, anything else does not.

## Every write surface is covered

The guard lives at the shared primitive in `obsidian-backend.ts`, which every
filesystem-expressible write tool routes through. The methods that carry it:

| Write surface | Tool(s) | Guard call |
| --- | --- | --- |
| Whole-note write | `obsidian_write_note` | `guardWrittenContent` over the final content |
| Batch write | `obsidian_write_notes` | per-item `composeNote` guard **and** the same `guardWrittenContent` via the guarded single-writer |
| Append | `obsidian_append_note` | `guardWrittenContent` over `existing + appended` (both the "note exists" and "creating the note" branches — closing the "S5" empty-note case where an appended leading fence becomes real frontmatter) |
| Frontmatter edit | `obsidian_manage_frontmatter` | `guardResultingFrontmatter(before, after)` |
| Structured patch | `obsidian_patch_note` | `guardResultingFrontmatter` over the parsed before/after |

**Move is not a content write.** `obsidian_move_note` / `obsidian_move_notes` rename through
`app.fileManager.renameFile` and never touch note content, so a move cannot introduce
acceptance and carries no content guard — the guarantee holds by construction there rather
than by an added check.

Because the guard is at the *shared primitive*, `obsidian_write_notes`' per-item dispatch
also reaches it (its single-writer calls the same `writeNote`), so the invariant holds on the
batch surface for free rather than being reimplemented (this is the "S1/S4" property: one
primitive, so no write tool — present or future — can register a path around it).

## The `obsidian_cli` proxy path

`obsidian_cli` proxies ~104 official Obsidian CLI commands, which run *inside* Obsidian and
therefore **bypass the MCP note-write primitive** where the guard above lives. That is a real
hole — an agent could otherwise persist acceptance through the CLI. So the CLI path grows its
**own** accept-forbidden check (`cliAcceptRefusal` in `packages/plugin/src/mcp/tools-cli.ts`),
run **before the command executes**, reusing the exact same `acceptForbiddenReason` rule — no
fork of "accepted." A CLI write is always an *introduce* (the CLI path has no expression for
"carry an existing human value forward"), so the introduce check is exactly right.

The complete set of CLI commands that write note content or frontmatter — all guarded:

- **`property:set`** family (`property:set name=<prop> value=<val>`, and the direct
  `key=value` shorthand; a defensive `frontmatter:set`/`add`/`update`/`patch` alias). A
  property literally named `status` set to `accepted` (`property:set name=status
  value=accepted`) is **allowed** — only the acceptance fields are keyed on, matching the MCP
  path.
- **Content writers** `create`, `append`, `prepend`, **`base:create`**, and the periodic-note
  variants `daily|weekly|monthly|quarterly|yearly:(create|append|prepend)`. Their
  caller-controlled `content=` is scanned for an acceptance-asserting frontmatter fence,
  including one hidden behind the CLI's `\n`/`\t` escape expansion, and including embedded
  (not just leading) fences. With no YAML parser injected the scan **fails closed** on any
  fence at all.

The refusal is a typed `Error [accept_forbidden]`, and nothing runs.

### The one documented residual

Some CLI commands execute **opaque code** whose effect cannot be inspected before it runs:

```
CLI_OPAQUE_ACCEPT_RESIDUAL = ["command", "eval", "quickadd", "quickadd:run", "quickadd:run-template"]
```

- `eval` and `command` already sit behind the **"Allow dangerous CLI commands"** setting gate
  (off by default).
- `quickadd` / `quickadd:run` / `quickadd:run-template` run arbitrary QuickAdd macros. A macro
  *could* set acceptance opaquely, and it cannot be inspected pre-execution. vault-mcp
  deliberately does **not** block QuickAdd (that would break legitimate macro use), so this is
  named honestly as a **residual** — in the tool description and here — rather than silently
  closed. A `create template=<t>` draws frontmatter from a template note that also can't be
  read pre-exec: a lesser residual of the same class.

The right closure for the residual is a **settings-level allowlist/denylist** for
`obsidian_cli` / `run_command` (a board item), not a broader guard — the guard is complete for
every path whose effect is inspectable before it runs. This is stated plainly so the boundary
is not mistaken for a leak: the guard is airtight for inspectable writes, and the opaque-macro
gap is a policy decision the settings surface owns, not an oversight.

## Why this is structural, not procedural

The value of the model is that "an agent cannot accept" is not a rule an agent is *asked* to
follow — it is a property the kernel *enforces*. An agent that has never heard of the
acceptance model, or one actively trying to forge acceptance, hits the same wall: the write is
refused before it lands. Combined with the [module system's](modules.md) accept/baseline
name tripwire (no module may even *register* a tool whose name mentions `accept`/`approve`/
`baseline`) and the fact that no module is handed a write or accept surface at all, the
invariant is defended at the write path, at the CLI path, and at the extension boundary
simultaneously.

The human's accept gesture stays exactly where it belongs: in a person's hands, in the review
pane.
</content>
