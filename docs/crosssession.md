# Cross-session channels — coordination log surface (#232)

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md). Since the S6 satellite extraction (`suite-split-design.md` §6) this reference documents the standalone **`vault-crosssession`** plugin, not a module of the host plugin (`governor`).


The `vault-crosssession` plugin (default off, mutating) gives the fleet's cross-session
coordination-log conventions a real agent surface: **channel discovery, delta reads,
read-receipt attestation, and posting that is refused while the poster is stale**, published
to the Governor host through `vault-mcp-api`. It mechanizes the vault convention "posting
asserts you are current with everything above your entry." There is **no human UI** in this
plugin beyond its settings tab, deliberately: no pane, no palette command, no ribbon.

Files: `packages/crosssession/src/tools.ts` (the four tool specs),
`packages/crosssession/src/obsidian-source.ts` (the live vault adapter and the receipt-store
factory), `packages/crosssession/src/kernel/` (the pure core: `entries.ts` parsing/ordering,
`receipts.ts` the read-receipt store, `config.ts`), and `packages/crosssession/src/main.ts`
/ `settings.ts` / `settings-tab.ts` (its own settings plus the two one-shot adoptions).
Obsidian-import-free above the adapter; the vault arrives as an injected
`CrosssessionSource` (`paths()` / `frontmatter()` / `read()` / `append()`).

## Now a satellite plugin

This capability shipped as the host plugin's `crosssession` module through 2026-08; as of
the S6 extraction it is its own Obsidian plugin, id `vault-crosssession`, publishing its
tools to the host through the `vault-mcp-api` SDK's `publishTools` — following the
`quickadd-choices-compile` pilot, `vault-skills` (S4) and `vault-triage` (S5). It is no
longer a `modules.crosssession` entry in the host's module registry. The parser, the
ordering, the unread computation and the receipt store are the same code through both homes.
Four things changed, and all four are visible to a caller:

**1. The published tool names changed.** `crosssession_channels`, `crosssession_delta`,
`crosssession_attest` and `crosssession_post` are now **`vault_crosssession_channels`**,
**`vault_crosssession_delta`**, **`vault_crosssession_attest`** and
**`vault_crosssession_post`**. The host publishes an external tool as
`<sanitized publisher id>_<bare name>`, so the plugin id and the tool namespace are the same
string, and `vault-crosssession` sanitizes to `vault_crosssession`. (The skills satellite
kept its names only because `vault-skills` sanitizes to exactly the `vault_skills` prefix
its six tools already carried.) Sessions and prompts calling the old names must be updated.

**2. The allowlist boundary moved to the host, and it closes on the WHOLE surface.** The
host distrusts an external tool's `readOnlyHint: true` unless the publisher's raw id is in
its `trustedReadOnlyPlugins` setting, so **all four** tools register as mutating; and a
mutating external tool whose arguments carry no recognized path key is **blocked outright**
while a path allowlist is active — trusted or not. **None of the four carries one**, so
under an allowlist the entire surface is refused wholesale, where the module merely filtered
its channel listing. That is fail-closed and strictly stricter. See *Allowlist behavior*
below for why `channel` was deliberately not renamed into a path key.

**3. Read receipts moved with the plugin, and are adopted once.** See *Read receipts*
below — this is the first extraction in the suite split to carry live operational state
rather than only configuration.

**4. Config moved to this plugin's own settings tab**, adopting the recognized keys out of
the host's former `modules.crosssession.config` once, on first load. See *Config* below.

**What did NOT change:** the entry format, the refusal codes and their messages, the
staleness policy, the cooperative-handle model, and the fact that every mutating call rides
the host's guarded registration path — read-only mode, the serialized write queue, the
journal, the kernel arguments and the record-immutability check all still bind, because an
external mutating tool registers at the same interception point as a built-in.

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
`projects: ["[[…]]"]` marks a per-project channel. The plugin reports audience and project
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
*fallible, not adversarial* — the plugin catches honest lapses (posting without having
read), and a session that misdeclares its handle is out of scope, exactly as a session that
writes a false log entry is. Handle hygiene is enforced only where it protects the file
format (non-empty, single line, no ` · ` separator).

## Read receipts (attestation)

`vault_crosssession_attest` records "handle H has read channel C through stamp S" — a
**read-receipt, not authority**. It grants nothing, needs no human gesture (agents attest
their own reads), and feeds exactly one consumer: `vault_crosssession_post`'s staleness
check. Receipts also make "which handles are behind?" queryable via
`vault_crosssession_channels`.

**Where the state lives:** per-handle receipts in `crosssession-receipts.json` in the
plugin's own directory. Deliberately **not** in any note's frontmatter (a receipt is a claim
about the reader, not a property of the channel note, and the acceptance perimeter's
protected frontmatter stays untouched by design) and **not** in `data.json` (settings sync
and export as config; read positions are per-install operational state). Receipts are keyed
by the channel note's `uid` when it has one, so a reorg move does not reset read state.

**The S6 migration.** "The plugin's own directory" used to be the HOST's — the file sat
beside the host's write journal and `install-id.json`, on the install-id precedent. It is
now `.obsidian/plugins/vault-crosssession/`. That move matters more than a config move
would, because receipts are live operational state: leaving them behind would make every
affected handle's next delta re-serve entries it had already read, and its next post refuse
`stale_read` on entries it had already attested. So the satellite **adopts the host's file
once, on first load, by merge** — this plugin's own value wins for any (channel, handle)
pair it already has — under a latch separate from the config latch, because the two sources
are independently present. It never writes the host's copy, and that is structural rather
than merely intended: the store's `loadFrom` takes a directory and has no `saveTo`
counterpart.

Any stamp at or before the channel's newest entry is accepted (`stamp_ahead` refuses
attesting reads that do not exist yet). That is the documented cooperative simplification:
the store records claims, it does not verify the reading.

## Posting and the `stale_read` refusal

`vault_crosssession_post(handle, channel, body)` appends one `## <stamp> · <handle>` section
(run clock, minutes precision, matching the live convention) to the channel's single log
file. It is an **ordinary guarded mutating tool**: read-only mode, the path allowlist, the
serialized write queue, the journal and the kernel args all bind at the host's standard
interception point, like any other write. Publishing exempts it from none of that — an
external mutating tool registers exactly where a built-in does.

Before anything is written, the handler checks the poster's receipt against the channel's
current entries. Unread foreign entries ⇒ a **typed policy refusal**, the `cli_denied`
shape:

```
Error [stale_read]: posting asserts you are current, and 2 entries in this channel are
newer than your attested read position ('2026-08-18T14:2x'): 2026-08-18T15:00 · tracker,
2026-08-18T15:10 · alpha. Read them with the delta tool, attest with the attest tool,
then post.
```

The poster's **own entries are exempt** — you are always current with yourself. On success
the post **auto-attests** through its own entry, so consecutive posts need no interleaved
attest calls. The appended text is body-only, at end-of-file: the posting path composes no
frontmatter, so there is no frontmatter field for it to assert (and the append lands after
the file's existing content, where a YAML block is inert text). Body hygiene refuses
`invalid_body` for the two honest-paste hazards: a line that would itself parse as an entry
heading outside a fence (it would mint phantom entries — quote excerpts with a blockquote
marker or a balanced code fence instead), and an unbalanced code fence (it would leave the
parser's fence state open and swallow every later entry). The post's structured result
reports `filesChanged`/`files` (the reportedEffects convention), so the journal's `effects`
field names the discovered append target even though the call's arguments carry only a
channel ref — that survives the publishing boundary because the host wraps a returned object
as `ok(data)`, making it the `structuredContent` the kernel reads.

`vault_crosssession_attest` is also declared mutating even though it writes plugin state
rather than a note — the advisory-locks precedent: the journal record of who attested what
matters more than the queue slot, and read-only mode consistently blocks both state writers.
(The host's write queue is also what keeps two concurrent attests from racing over the
receipt file.)

**The entry format may not drift.** The fleet's `CROSS-SESSION.md` is written by this
plugin, by a human in Obsidian, and by shell append redirections. The result is
byte-compatible across all three: a blank line, the heading, a blank line, the trimmed body,
a trailing newline — with the adapter inserting the file's own missing trailing newline
first, through `vault.process` (Obsidian's atomic read-modify-write), so a concurrent editor
save and an append cannot interleave mid-file.

## Allowlist behavior

**Since S6 the enforced boundary is the host's, and it is stricter.** None of the four tools
carries an argument in the host's `PATH_KEYS` (`path`, `from`, `to`, `target_path`,
`template_path`, `subdir`, `file_path`, `output_folder`), and the host blocks a mutating
external tool that it cannot scope. So while a path allowlist is active, **all four tools
are refused wholesale**. Fail-closed, and strictly stricter than what it replaces.

`channel` was deliberately **not** renamed into a path key, which is where this extraction
diverges from triage's `target` → `target_path`. Three reasons, in order of weight:

1. **It would not scope the write.** The post tool appends to a log file it *discovers*
   inside the channel folder, which no call argument names. Path-keying `channel` would hand
   the guard the folder *note* and leave the file actually written unscoped — the illusion
   of a check rather than a check.
2. **A `channel` value may be a uid.** The argument accepts a channel uid, its folder-note
   path, or its folder. The guard would prefix-match a bare uid as if it were a path and
   refuse every uid-addressed call under an allowlist — exactly the bug the host fixed by
   renaming its scheme-write `to` → `to_address` *away* from a path key, an address string
   not being a path.
3. **It would expose the tool to the record-immutability guard on the wrong path** (the
   folder note, not the appended file). On that point the host's `RECORD_EXEMPT_OPS` was
   re-examined at S6 and deliberately **not** widened: the post tool always ran inside the
   kernel — as a module tool it registered through the same guard-patched registrar a
   published tool now uses — and it is unreachable by the record check on *arguments*, which
   the extraction did not change. Listing it would still change no behavior while widening a
   protective set on a guess.

**The in-plugin filter is retained as a dormant seam** and describes what still happens
whenever something supplies it: a channel whose folder note is outside the allowlist is
**invisible** — absent from the channels tool, and `channel_unresolved` (not
`out_of_allowlist`) to delta/attest/post, so a refusal does not confirm the hidden channel
exists (the `uid_unresolved` precedent). Member files are filtered the same way before they
are read: a hidden log file or message note contributes no entries to counts, deltas, or the
staleness check. Nothing supplies it today — a satellite cannot reach the host's guard
settings — and a `vault-mcp-api` that can carry the caller's scope to a publisher would
light it up with no code change.

## The tools

| Tool | R/W | What it does |
|---|---|---|
| `vault_crosssession_channels(handle?)` | R | All channels by fileclass + audience: uid, path, audience, projects, entry count, newest stamp, recorded receipts with behind-counts; with `handle`, your position + unread count. |
| `vault_crosssession_delta(handle, channel?)` | R | Entries newer than your attested position — `{stamp, handle, event?, body, source, form}`, both forms merged, oldest first; per-channel cap (default 20, config `deltaCap`) with `more` + `next_stamp` (attest through it, call again). The cap never bisects a run of equal stamps — the slice extends to complete the final same-minute group, so the attest-through-`next_stamp` continuation loses nothing. Own entries omitted. `channel` = uid, folder-note path, or folder; omit for all visible channels. |
| `vault_crosssession_attest(handle, channel, through_stamp)` | W | Record the read receipt. Typed refusals: `channel_unresolved`, `stamp_ahead`, `invalid_handle`, `invalid_argument`. |
| `vault_crosssession_post(handle, channel, body)` | W | Guarded append of one entry section. Typed refusals: `stale_read` (before any write), `channel_unresolved`, `no_log_file` (a channel with only per-message notes), `log_ambiguous` (more than one entry-bearing log file), `invalid_handle`, `invalid_body`, `invalid_argument`. |

The first two declare themselves read-only; the host treats that as an untrusted claim and
registers them as mutating unless `vault-crosssession` is listed in its
`trustedReadOnlyPlugins` — which does not change the allowlist posture above either way.

## Config

The `vault-crosssession` plugin's own settings tab (formerly rendered as
`modules.crosssession.config` in the host's config tab):

| Key | Default | Meaning |
|---|---|---|
| `channelFileclass` | `Collection/Log` | fileClass a channel's folder note carries. |
| `messageFileclass` | `Agent/Log/CrossSession` | fileClass a per-message note carries. |
| `deltaCap` | `20` | Max entries per channel per delta call. |

Config is read **per call**, so an edit lands without a reload. The tool *descriptions* are
necessarily build-time snapshots (the host snapshots a published spec when it registers it),
so the plugin disposes and re-publishes all four specs on every settings write — the triage
satellite's pattern, restoring the per-connection freshness the module had. Every schema
bound is likewise re-applied in the handler: the SDK converts zod to JSON Schema and the
host converts it back through a small subset, so `type`, `description` and string `enum`
survive the round trip while `default`, `min`, `max` and `pattern` do not.

### Migration from the host's `modules.crosssession.config`

On its first load the satellite copies the recognized keys into its own `data.json` and
latches. It **never writes the host's settings** — not to delete the adopted keys, not to
mark them migrated; the host's copy stays where it is and simply stops being read. It **runs
once**, so a later host edit cannot reach back in. **This plugin's own values win**, so
adoption only fills gaps. And if the host is absent — or present but still mid-onload, with
its `settings` not yet assigned — nothing is adopted and the latch is *not* set, so the one
chance survives to a later load. A host present with no crosssession config still latches:
the question was asked and answered, and the shipped defaults already mirror the live
vault's conventions.

## Boundaries and residuals

- **Un-headless:** `obsidianCrosssessionSource` (vault reads + the `vault.process` append)
  and `obsidianReceiptStore` (the DataAdapter-backed state file) are this plugin's only
  Obsidian coupling — verify live; everything else is unit-tested headless
  (`packages/crosssession/tests/crosssession-module.test.mjs`), including the publication
  contract (the wire names, the untrusted read-only claim, and the assertion that no
  argument is a host path key) and both one-shot adoptions. The handler tests run through
  `tests/host-shim.mjs`, which reproduces the host's published naming, its `ok()`/`fail()`
  envelopes and the annotations it derives from an *untrusted* read-only claim, so they
  assert the envelopes an agent actually sees. The host's own machinery — queue, journal,
  read-only mode, allowlist, record guard — is not reproduced there; it is host code with
  host tests.
- **Enforcement scope:** the staleness gate binds the post tool only. A session that
  appends to the log file via `obsidian_append_note` or a shell heredoc bypasses the check
  exactly as it did before this plugin existed — the write-path enforcement on generic
  append tools is a possible later slice (see #232's issue thread), not shipped here.
- **Ordering residual:** an entry that arrives with a stamp *older* than a reader's
  attested position (out-of-order arrival in an append-only file) counts as covered and is
  not re-served — accepted under the cooperative model; run-clock stamps make it rare.
- **Per-message notes are read, not written:** posting targets the single log file
  (`no_log_file` when a channel has none). Minting per-message notes is a candidate later
  verb once the fleet cuts over.
- **Folder-membership assumptions (cooperative):** a channel's entries are its folder's
  DIRECT children, and the plugin assumes the convention's folder-note shape — the channel
  note inside its own folder, one channel per folder. Degenerate layouts misbehave in
  documented ways: entries inside the channel note itself are not read (it is excluded from
  membership); a channel note at the vault root claims every root-level note as a log
  candidate; two channel notes sharing one folder each see the other as a log candidate.
  Follow the convention's shape and none of these arise.
