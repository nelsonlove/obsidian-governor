# Vault Cross-session (plugin id `vault-crosssession`)

The fleet's coordination-log conventions given an agent surface: discover channels by frontmatter, read the entries newer than your attested position, attest a read receipt, and post — with posting mechanically refused while you are behind. Like the triage satellite and unlike the skills one, this plugin has no human surface at all — no pane, no palette command, no ribbon. Its entire surface is four MCP tools published to the Governor host through `vault-mcp-api`, plus a settings tab for the human who configures what counts as a channel.

The user-facing deep reference — the channel model, the entry grammar, the staleness policy, the receipt semantics — is `docs/crosssession.md` at the repo root. This file is about the plugin: what is in the package, how it relates to the host, and the four things the extraction changed.

## Lineage

Built as the host's `crosssession` capability module (#232). Extracted to its own plugin at the suite split's **S6** — the design doc's `docs/suite-split-design.md` §6 row *"Cross-session | private operator | satellite"*. It follows `packages/quickadd-choices-compile` (the pilot), `packages/skills` (`vault-skills`, S4) and `packages/triage` (`vault-triage`, S5). The parser, the ordering, the unread computation and the receipt store are the same code through both homes; only who mounts them differs.

## Package layout

```text
packages/crosssession/
├── manifest.json          plugin id `vault-crosssession`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js (no assets, no defines)
├── src/
│   ├── main.ts            onload: settings + BOTH adoptions, settings tab, publishTools (re-published on every config change)
│   ├── settings.ts        settings shape, the 3 field definitions, one-shot host config adoption (pure)
│   ├── settings-tab.ts    the plugin's own settings tab
│   ├── tools.ts           the four tool specs, the injected CrosssessionSource seam, the ctx
│   ├── obsidian-source.ts the live vault adapter (reads + the atomic EOF append) and the receipt store factory
│   └── kernel/            the pure core — Obsidian-free, no vault, no clock
│       ├── entries.ts      entry parsing/ordering, channel discovery, membership, unread computation
│       ├── receipts.ts     the read-receipt store (this plugin's own state file) + the adoption merge
│       ├── config.ts       the typed config, its loud validation, degrade-to-default coercion
│       └── index.ts        the package's kernel re-exports
└── tests/                 72 tests; everything but the Obsidian adapter is headless
```

Installed into a vault this is two files — `main.js` and `manifest.json` — plus, during development, an empty `.hotreload` marker in the installed plugin directory so the hot-reload plugin picks up rebuilds. The `.hotreload` file lives in the vault install, never in this repo.

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # tsc --noEmit && node --test 'tests/*.test.mjs'
```

`pretest` rebuilds `@vault-mcp/core` first, for the same reason the host's and the other satellites' do: the tests reach a published core contract (`isVisible`) through `packages/core/dist`, so without the rebuild you are testing the previous build's bytes.

## It does NOT work without the host

Same as the triage satellite. The four published tools ARE the plugin. With Governor absent it loads, keeps and validates its settings, and does nothing; `publishTools` waits on the host's ready event and registers the moment a host appears. The settings tab says so.

## The four things the extraction changed

### 1. The published tool names changed

`crosssession_channels`, `crosssession_delta`, `crosssession_attest` and `crosssession_post` are now **`vault_crosssession_channels`**, **`vault_crosssession_delta`**, **`vault_crosssession_attest`** and **`vault_crosssession_post`**.

This is the extraction's one breaking change and it is a consequence of the plugin id, not a separate decision. The host publishes an external tool as `<sanitized publisher id>_<bare name>`, so **the plugin id and the tool namespace are the same string**, and `vault-crosssession` sanitizes to `vault_crosssession`. Same class as the triage rename. Any agent session or saved prompt calling the old names must be updated — see `CLAUDE.md` in this package for the alternative that was available and why it was not taken.

### 2. The allowlist boundary moved to the host, and it closes on the WHOLE surface

The host's external-tool gate is now what enforces scope, and it refuses on two grounds:

- An external tool's `readOnlyHint: true` is a CLAIM the host distrusts unless the publisher's raw plugin id appears in its `trustedReadOnlyPlugins` setting. Untrusted, **all four** register as mutating.
- A mutating external tool whose arguments carry **no recognized path key** is **blocked outright** while a path allowlist is active — trusted or not (the trusted exemption was closed 2026-09-05 by the skills satellite's review; trust answers read-only mode, never scoping).

**None of the four tools carries a recognized path key**, so under an active allowlist the entire surface is refused wholesale, where the module filtered its channel listing. That is fail-closed and strictly stricter. With no allowlist configured the in-tool `visible` filter was a no-op anyway, so nothing else changes — and the operator's live vault has an empty allowlist.

**`channel` was deliberately NOT renamed into a path key**, which is the decision that distinguishes this extraction from triage's `target` → `target_path`. Three reasons, in order of weight:

1. **It would not scope the write.** `post` appends to the channel folder's single entry-bearing log file, which it DISCOVERS inside the handler; no call argument names it. Path-keying `channel` would hand the guard the folder NOTE and leave the file actually written unscoped — the illusion of a check rather than a check.
2. **A `channel` value may be a uid.** The argument accepts a channel uid, its folder-note path, or its folder. Under an allowlist the guard would prefix-match a bare uid string as if it were a path and refuse every uid-addressed call. That is exactly the bug the host fixed by renaming its scheme-write `to` → `to_address` **away** from a path key — an address string is not a path.
3. **It would expose the tool to the record-immutability guard on the wrong path** (the folder note, not the appended file). See below.

Read tools blocked wholesale under an allowlist is the documented posture, not a bug — the same one `vault_triage_queue` and five of the six `vault_skills_*` tools carry.

### 3. Record immutability: nothing changed, and that was checked rather than assumed

The host refuses any mutating operation that NAMES a note whose frontmatter carries `record: true`, exempting only `obsidian_append_note` by tool identity (`RECORD_EXEMPT_OPS` in the host's `src/kernel/record-guard.ts`). That set's comment names `crosssession_post` as the one other pure-EOF-append tool, deliberately unexempted because it was "unreachable by this check today". The extraction re-verified both halves of that:

- **It was never outside the kernel.** As a module tool it registered on the same guard-patched `server.registerTool` every built-in rides, and as a published external tool it registers through the identical `external-tools.ts` → `makeGuarded` path. Publishing exempts a tool from nothing.
- **It is unreachable on ARGUMENTS.** The host collects paths from a fixed `PATH_KEYS` list; `channel` is not on it, so `collectPaths({handle, channel, body})` is empty and the guard has nothing to test. Because the argument names did not change, that is still true of `vault_crosssession_post`.

So `RECORD_EXEMPT_OPS` was **not** widened — listing the tool would still change no behavior while widening a protective set on a guess. The host's comment and its pin were updated to name the new tool identity and to record the re-verification; this package pins the other half, that none of its four tools carries a host path key, so the day `channel` becomes path-keyed a test fails on both sides instead of a live coordination log silently starting to refuse.

### 4. Two adoptions, not one — and the second is live operator state

Configuration used to live in the host's `data.json` at `modules.crosssession.config`. On first load this plugin copies the recognized keys into its own `data.json` and latches, under the three rules the skills and triage satellites established: **it never writes the host's settings**, **it runs once**, and **this plugin's own values win**. If the host is absent — or present but still mid-onload, with `settings` undefined — nothing is adopted and the latch is not set, so the one chance survives to a later load.

**The second adoption is what neither predecessor needed.** `crosssession-receipts.json` — which handles have read which channels through which stamp — lived in the HOST's plugin directory, beside the journal and `install-id.json`. It is live operational state, not configuration: left behind, every affected handle's next `delta` re-serves entries it already read, and its next `post` refuses `stale_read` on entries it already attested. So the plugin adopts that file too, once, by **merge** (own values win per channel + handle), under its own separate latch — the two sources are independently present, and the operator's live host has receipts with no config override at all. The host's copy is **read only**: `ReceiptStore.loadFrom` takes a directory and has no `saveTo` counterpart, so "never write the host's copy" is structural here rather than merely intended.

## Two smaller consequences worth knowing

**Refusals throw.** A handler returns plain data or throws; the host wraps the first in `ok()` and the second in `fail()`, and `fail()` renders a lowercase-snake `code` off the error as `Error [code]: message` — the same shape the module's `codedError` produced. Every typed refusal an agent sees (`stale_read`, `channel_unresolved`, `invalid_handle`, `invalid_body`, `stamp_ahead`, `no_log_file`, `log_ambiguous`) is byte-compatible with the folded era. Unlike the triage extraction, **no envelope changed**: this surface never used `okError`.

**Schema bounds are re-applied in the handler.** The SDK converts a zod shape to JSON Schema and the host converts it back through a deliberately small subset: `type`, `description` and string `enum` survive; `default`, `min`, `max` and `pattern` do not. So every `.min(1)` runs again in the handler (`requireText`), where it actually executes. This is the `vault_skills_release` semver lesson, applied before it could bite.

## The entry format may not drift

The fleet's `CROSS-SESSION.md` is a live, active coordination log written by this plugin, by hand in Obsidian, and by shell `>>` heredoc appends. All three have to produce the same file. The append is byte-compatible with what the module wrote and with the hand convention: a blank line, `## <stamp> · <handle>`, a blank line, the trimmed body, a trailing newline — with the source's `append` inserting the file's own missing trailing newline first, so a hand-edited log never gets a heading glued onto its last line. The write itself goes through `vault.process`, Obsidian's atomic read-modify-write, so a concurrent editor save and an append cannot interleave mid-file. If you touch `post`'s `entryText` or `obsidianCrosssessionSource.append`, you are changing a file format three writers share.

## What the host still owns

Everything a published tool rides through: the guarded registration point, read-only mode, the path allowlist, the serialized write queue (which is also what keeps two concurrent attests from racing over the receipt file), the write journal, `if_rev` / `idempotency_key` / `intent`, advisory locks, and record immutability. Publishing does not exempt a tool from any of it.

**There is no other write path in this plugin.** No palette command, no ribbon, no pane touches `app.vault`, so there is no surface here that could write outside the host's journal. The only vault write is inside `post`'s handler, which is only ever reached through the host. The receipt file is this plugin's own state and is not a vault note.

What this plugin owns is the entry grammar, channel discovery, the unread computation, the staleness policy, the receipt store, and its own settings.
