# Vault Triage (plugin id `vault-triage`)

Inbox triage for agents: a read-only queue view and one guarded, dry-run-by-default disposition verb. Unlike the skills satellite this plugin has no human surface at all — no pane, no palette command, no ribbon. Its entire surface is two MCP tools published to the Governor host through `vault-mcp-api`, plus a settings tab for the human who configures what those tools may do.

The user-facing deep reference — the merged disposition table, the three built-in primitives, how to declare your own rows, the migration from the retired ten-verb table — is `docs/triage.md` at the repo root. This file is about the plugin: what is in the package, how it relates to the host, and the four things the extraction changed.

## Lineage

Built as the host's `triage` capability module (#221 phase 2, reshaped to the three-primitives-plus-declared-rows form by #241 phase 3), itself the successor to the vault's retired `dispose-inbox-item` QuickAdd flow. Extracted to its own plugin at the suite split's S5 — the design doc's `docs/suite-split-design.md` §6 row *"Triage | private operator | satellite"*. It follows `packages/quickadd-choices-compile` (the pilot) and `packages/skills` (`vault-skills`, S4). The planner and the disposition table are the same code through both homes; only who mounts it differs.

## Package layout

```text
packages/triage/
├── manifest.json          plugin id `vault-triage`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js (no assets, no defines)
├── src/
│   ├── main.ts            onload: settings + adoption, settings tab, publishTools (re-published on every config change)
│   ├── settings.ts        settings shape, the 8 field definitions, one-shot host adoption (pure)
│   ├── settings-tab.ts    the plugin's own settings tab
│   ├── tools.ts           the two tool specs, the injected TriageSource seam, the ctx
│   ├── obsidian-source.ts the live vault adapter + this package's link-healing move primitive
│   └── kernel/            the pure core — Obsidian-free, no vault, no clock
│       ├── descriptors.ts  the three built-in primitives + the merged (built-in ∪ declared) table
│       ├── config.ts       the typed config, its loud validation, the declared-row parser
│       ├── inbox.ts        the inbox-marker queue predicate + queue ordering
│       ├── plan.ts         planDispose — the whole "what should happen to this note" answer
│       └── index.ts        (re-exports the disposition substrate from @vault-mcp/core)
└── tests/                 91 tests; everything but the Obsidian adapter is headless
```

Installed into a vault this is two files — `main.js` and `manifest.json` — plus, during development, an empty `.hotreload` marker in the installed plugin directory so the hot-reload plugin picks up rebuilds. The `.hotreload` file lives in the vault install, never in this repo.

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # tsc --noEmit && node --test 'tests/*.test.mjs'
```

`pretest` rebuilds `@vault-mcp/core` first, for the same reason the host's and the skills satellite's do: several tests reach published core contracts through `packages/core/dist`, so without the rebuild you are testing the previous build's bytes.

## It does NOT work without the host

This is the opposite of the skills satellite, and worth stating plainly. Skills has a pane, commands and export-on-save, so with Governor absent it still does its job and only the MCP tools go unpublished. Triage has none of that: the two published tools ARE the plugin. With Governor absent it loads, keeps and validates its settings, and does nothing; `publishTools` waits on the host's ready event and registers the moment a host appears. The settings tab says so.

## The four things the extraction changed

### 1. The published tool names changed

`triage_queue` and `triage_dispose` are now **`vault_triage_queue`** and **`vault_triage_dispose`**.

This is the extraction's one breaking change and it is a consequence of the plugin id, not a separate decision. The host publishes an external tool as `<sanitized publisher id>_<bare name>`, so **the plugin id and the tool namespace are the same string**. The skills satellite kept its names only because `vault-skills` sanitizes to exactly the `vault_skills` prefix its six tools already carried; no id that fits the suite's `vault-*` naming reproduces a bare `triage_` prefix. Any agent session or saved prompt calling the old names must be updated — see `CLAUDE.md` in this package for the alternative that was available and why it was not taken.

### 2. The allowlist boundary moved to the host — stricter for the queue, differently reached for dispose

The host's external-tool gate is now what enforces scope, and it refuses on two grounds:

- An external tool's `readOnlyHint: true` is a CLAIM the host distrusts unless the publisher's raw plugin id appears in its `trustedReadOnlyPlugins` setting. Untrusted, **both** of these register as mutating.
- A mutating external tool whose arguments carry **no recognized path key** is **blocked outright** while a path allowlist is active — trusted or not (the trusted exemption was closed 2026-09-05 by the skills satellite's review; trust answers read-only mode, never scoping).

`vault_triage_queue` carries no path argument — `base`, `view` and `queue` are not path keys, and the marker queue takes none at all. So under an active allowlist it is refused **wholesale**, where the module merely filtered its listing. That is fail-closed and strictly stricter. With no allowlist configured the in-tool `visible` filter was a no-op anyway, so nothing else changes.

`vault_triage_dispose` carries `path`, so it is scoped normally. Its destination argument was **renamed `target` → `target_path`** in the same motion: `target_path` is in the host's `PATH_KEYS` and `target` is not, so the host's guard now checks the destination folder the caller names. In the module that check was the handler's own, over the computed destination, using the host's guard settings — which a satellite cannot reach. Renaming the argument moves the check to something the host CAN see. It is the same precedent as the scheme-write tools' `to_address` / `displace_to_address`, applied in the direction that adds a check rather than removing a false one.

**What that does not cover**, stated rather than glossed: a declared row with a CONFIGURED `destination` and no `target_path` sends the note somewhere no call argument names, so the host's allowlist never sees it. The bound on that path is the human's own `moveWhitelist` / `moveBlacklist`, enforced at plan time and re-checked at apply — which is the right bound for it. The session allowlist scopes what the CALLER can name; a declared row's destination is the human's standing choice, not the agent's.

### 3. Base-backed queues are unavailable

`triage_queue {base}` used to evaluate a `.base` file through the bases module's shared capture seam — Obsidian's own Bases engine, so one human-authored Base definition drove the human view and the agent sweep. That seam did **not** come along, and copying it would have been wrong rather than merely large: the capture drives a hidden Bases leaf, a GLOBAL resource the host guards with a module-scoped serializer holding it to one capture at a time. A second serializer in a second plugin would race the first over the one leaf. The seam also reaches the bases module's own config and typed-refusal vocabulary, none of which is published.

So `base`, `view` and `queue` refuse typed (`bases_unavailable`) through the same feature-gate branch that always covered a pre-Bases Obsidian, with a message saying why. **The inbox-marker queue is unaffected and is the working surface.** For evaluated Base rows, the host's own `base_query` tool is unchanged. The `baseQuery` seam stays in this package's ctx (and its tests keep exercising it) so the feature re-lights the day the host can hand a publisher a Bases service — an apiVersion-2 item, alongside carrying the caller's scope.

The `queues` config field is kept for the same reason, with its help text saying it is currently inert.

### 4. Settings adopt once from the host, and never write back

Configuration used to live in the host's `data.json` at `modules.triage.config`. On first load this plugin copies the recognized keys into its own `data.json` and latches:

- **It never writes the host's settings** — not to delete the adopted keys, not to mark them migrated. The host's copy stays where it is and simply stops being read.
- **It runs once.** A later host edit cannot reach back in.
- **This plugin's own values win.** Adoption only fills gaps.
- **If the host is absent — or present but still mid-onload, with `settings` undefined — nothing is adopted and the latch is not set**, so the one chance survives to a later load.

For triage this is a safety migration, not just a convenience: `moveWhitelist` and `moveBlacklist` are the human's bound on where a disposition may send a note, and an empty config means "any destination". See `src/settings.ts`; the rules are pinned by `tests/triage-module.test.mjs`.

## Two smaller consequences worth knowing

**Refusals throw, and one envelope changed.** A handler returns plain data or throws; the host wraps the first in `ok()` and the second in `fail()`, and `fail()` renders a lowercase-snake `code` off the error as `Error [code]: message` — the same shape the module's `codedError` produced. The exception is the mid-sequence partial failure ("the frontmatter patch landed, then the move failed"). The module returned `okError(...)` — `ok()`'s structure PLUS the error flag — which a published handler cannot produce. It now throws `dispose_partially_applied` with the facts in the message. The load-bearing property is kept: a partial disposition is always NAMED, never reported as success. What is lost is the journal's `effects` field on that one path; the journal record still exists, with `outcome: "error"` and the note as its target.

**Schema bounds are re-applied in the handler.** The SDK converts a zod shape to JSON Schema and the host converts it back through a deliberately small subset: `type`, `description` and string `enum` survive; `default`, `min`, `max` and `pattern` do not. So the `limit` clamp and the `dry_run: true` default both run in the handler, where they actually execute. This is the `vault_skills_release` semver lesson, applied before it could bite.

## What the host still owns

Everything a published tool rides through: the guarded registration point, read-only mode, the path allowlist, the serialized write queue, the write journal, `if_rev` / `idempotency_key` / `intent`, advisory locks, and record immutability. Publishing does not exempt a tool from any of it — an MCP-invoked disposal keeps the full treatment automatically, because external tools register at the same interception point as every built-in.

**There is no other write path in this plugin.** No palette command, no ribbon, no pane touches `app.vault`, so there is no surface here that could write outside the host's journal. The only vault writes are inside `triage_dispose`'s handler, which is only ever reached through the host.

What this plugin owns is the disposition table, the planner, the move whitelist/blacklist, its own settings, and the accept-forbidden re-check on every frontmatter patch — which runs `acceptForbiddenReason` from `@vault-mcp/core`, a published contract, so leaving the host did not leave the guard behind.
