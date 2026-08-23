# Cross-session channels — coordination log surface (#232)

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


The crosssession module is a [capability module](module-system.md) (id `crosssession`, capabilities
`["coordination"]`, **default disabled**, `mutating: true`) that gives the fleet's
cross-session coordination-log conventions a real agent surface: **channel discovery, delta
reads, read-receipt attestation, and posting that is refused while the poster is stale**.
It mechanizes the vault convention "posting asserts you are current with everything above
your entry."

Files: `packages/plugin/src/mcp/tools-crosssession.ts` (tools + the Obsidian adapters),
`packages/plugin/src/kernel/crosssession/` (the pure core: `entries.ts` parsing/ordering,
`receipts.ts` the read-receipt store, `config.ts`). Obsidian-import-free; the vault arrives
as an injected `CrosssessionSource` (`paths()` / `frontmatter()` / `read()` / `append()`).

## The channel model

A **channel** is a vault note discovered by **fileclass + `audience:` frontmatter — never by
path** (the vault convention's own rule; both names are config, defaulting to the live
conventions: channel fileClass `Collection/Log`, message fileClass `Agent/Log/CrossSession`).
The note's folder holds the channel's entries, in two forms read together:

- the **single append-only log file** — `## <stamp> · <handle>[ · <EVENT>]` sections
  (the fleet's `CROSS-SESSION.md` shape); and
- **per-message notes** — write-once, filename `<stamp> · <handle>.md`, carrying the
  message fileClass.

`audience: fleet` marks the fleet-wide channel; `audience: project` +
`projects: ["[[…]]"]` marks a per-project channel. The module reports audience and project
links verbatim; which channels bind a given session is the reading discipline's business,
not enforced here.

### Stamps are opaque ordered strings

The live file contains imprecise stamps (`…T14:2x`), so stamps are **not parsed as
datetimes** anywhere. Ordering compares the stamp string with `:` stripped (`orderKey`), so
the log-file form (`2026-08-18T13:40`) and the filename form (`2026-08-18T1340`) of the same
minute agree; ties keep log-before-note, then source position (stable sort). Parsing
tolerates the real file's other quirks: YAML frontmatter, a rules document as preamble
(plain `##` headings without the ` · ` separator are content, not entries), fenced code
blocks containing heading-shaped lines (the live file's own Message-format example), and an
EVENT segment after the handle.

## The cooperative-handle model

`handle` is a tool argument — the caller **declares** its own session name. Handles are
cooperative, **not authenticated**: the threat model (the fleet's standing call) is
*fallible, not adversarial* — the module catches honest lapses (posting without having
read), and a session that misdeclares its handle is out of scope, exactly as a session that
writes a false log entry is. Handle hygiene is enforced only where it protects the file
format (non-empty, single line, no ` · ` separator).

## Read receipts (attestation)

`crosssession_attest` records "handle H has read channel C through stamp S" — a
**read-receipt, not authority**. It grants nothing, needs no human gesture (agents attest
their own reads), and feeds exactly one consumer: `crosssession_post`'s staleness check.
Receipts also make "which handles are behind?" queryable via `crosssession_channels`.

**Where the state lives:** per-handle receipts in `crosssession-receipts.json` in the
plugin's own directory, beside the write journal and `install-id.json` — the install-id
precedent. Deliberately **not** in any note's frontmatter (a receipt is a claim about the
reader, not a property of the channel note, and the acceptance perimeter's protected
frontmatter stays untouched by design) and **not** in `data.json` (settings sync and export
as config; read positions are per-install operational state). Receipts are keyed by the
channel note's `uid` when it has one, so a reorg move does not reset read state.

Any stamp at or before the channel's newest entry is accepted (`stamp_ahead` refuses
attesting reads that do not exist yet). That is the documented cooperative simplification:
the store records claims, it does not verify the reading.

## Posting and the `stale_read` refusal

`crosssession_post(handle, channel, body)` appends one `## <stamp> · <handle>` section
(run clock, minutes precision, matching the live convention) to the channel's single log
file. It is an **ordinary guarded mutating tool** (`readOnlyHint: false`): read-only mode,
the path allowlist, the serialized write queue, the journal and the kernel args all bind at
the standard interception point, like any other write.

Before anything is written, the handler checks the poster's receipt against the channel's
current entries. Unread foreign entries ⇒ a **typed policy refusal**, the `cli_denied`
shape:

```
Error [stale_read]: posting asserts you are current, and 2 entries in this channel are
newer than your attested read position ('2026-08-18T14:2x'): 2026-08-18T15:00 · tracker,
2026-08-18T15:10 · alpha. Read them with crosssession_delta, attest with
crosssession_attest, then post.
```

The poster's **own entries are exempt** — you are always current with yourself. On success
the post **auto-attests** through its own entry, so consecutive posts need no interleaved
attest calls. The appended text is body-only, at end-of-file: the posting path composes no
frontmatter, so there is no frontmatter field for it to assert (and the append lands after
the file's existing content, where a YAML block is inert text). Body hygiene refuses
`invalid_body` for the two honest-paste hazards: a line that would itself parse as an entry
heading outside a fence (it would mint phantom entries — quote excerpts with `>` or a
balanced code fence instead), and an unbalanced code fence (it would leave the parser's
fence state open and swallow every later entry). The post's structured result reports
`filesChanged`/`files` (the reportedEffects convention), so the journal's `effects` field
names the discovered append target even though the call's arguments carry only a channel
ref.

`crosssession_attest` is also registered `readOnlyHint: false` even though it writes module
state rather than a note — the advisory-locks precedent: the journal record of who attested
what matters more than the queue slot, and read-only mode consistently blocks both state
writers.

## Allowlist behavior

A channel whose folder note is outside the path allowlist is **invisible** — absent from
`crosssession_channels`, and `channel_unresolved` (not `out_of_allowlist`) to
delta/attest/post, so a refusal does not confirm the hidden channel exists (the
`uid_unresolved` precedent). Member files are filtered the same way before they are read: a
hidden log file or message note contributes no entries to counts, deltas, or the staleness
check.

## The tools

| Tool | R/W | What it does |
|---|---|---|
| `crosssession_channels(handle?)` | R | All channels by fileclass + audience: uid, path, audience, projects, entry count, newest stamp, recorded receipts with behind-counts; with `handle`, your position + unread count. |
| `crosssession_delta(handle, channel?)` | R | Entries newer than your attested position — `{stamp, handle, event?, body, source, form}`, both forms merged, oldest first; per-channel cap (default 20, config `deltaCap`) with `more` + `next_stamp` (attest through it, call again). The cap never bisects a run of equal stamps — the slice extends to complete the final same-minute group, so the attest-through-`next_stamp` continuation loses nothing. Own entries omitted. `channel` = uid, folder-note path, or folder; omit for all visible channels. |
| `crosssession_attest(handle, channel, through_stamp)` | W | Record the read receipt. Typed refusals: `channel_unresolved`, `stamp_ahead`, `invalid_handle`. |
| `crosssession_post(handle, channel, body)` | W | Guarded append of one entry section. Typed refusals: `stale_read` (before any write), `channel_unresolved`, `no_log_file` (a channel with only per-message notes), `log_ambiguous` (more than one entry-bearing log file), `invalid_handle`, `invalid_body`. |

## Config (`modules.crosssession.config`)

| Key | Default | Meaning |
|---|---|---|
| `channelFileclass` | `Collection/Log` | fileClass a channel's folder note carries. |
| `messageFileclass` | `Agent/Log/CrossSession` | fileClass a per-message note carries. |
| `deltaCap` | `20` | Max entries per channel per `crosssession_delta` call. |

## Boundaries and residuals

- **Un-headless:** `obsidianCrosssessionSource` (vault reads + the `vault.process` append)
  and `obsidianReceiptStore` (the DataAdapter-backed state file) are the module's only
  Obsidian coupling — verify live; everything else is unit-tested headless
  (`tests/crosssession-module.test.mjs`).
- **Enforcement scope:** the staleness gate binds `crosssession_post` only. A session that
  appends to the log file via `obsidian_append_note` or a shell heredoc bypasses the check
  exactly as it did before this module existed — the write-path enforcement on generic
  append tools is a possible later slice (see #232's issue thread), not shipped here.
- **Ordering residual:** an entry that arrives with a stamp *older* than a reader's
  attested position (out-of-order arrival in an append-only file) counts as covered and is
  not re-served — accepted under the cooperative model; run-clock stamps make it rare.
- **Per-message notes are read, not written:** posting targets the single log file
  (`no_log_file` when a channel has none). Minting per-message notes is a candidate later
  verb once the fleet cuts over.
- **Folder-membership assumptions (cooperative):** a channel's entries are its folder's
  DIRECT children, and the module assumes the convention's folder-note shape — the channel
  note inside its own folder, one channel per folder. Degenerate layouts misbehave in
  documented ways: entries inside the channel note itself are not read (it is excluded from
  membership); a channel note at the vault root claims every root-level note as a log
  candidate; two channel notes sharing one folder each see the other as a log candidate.
  Follow the convention's shape and none of these arise.
