# Vault Bases (plugin id `vault-bases`)

Obsidian's Bases engine, given an agent surface: enumerate the vault's `.base` files with their declared views, and evaluate a view — filters, formulas, sort and the view's own limit all computed by Obsidian itself, in a background leaf the human never sees. Like the triage and cross-session satellites and unlike the skills one, this plugin has no human surface at all — no pane, no palette command, no ribbon. Its entire surface is two MCP tools published to the Governor host through `vault-mcp-api`, plus a settings tab for the human who tunes the timeout and the row cap.

The user-facing deep reference — the capture mechanism, the live findings behind it, the refusal vocabulary — is `docs/bases.md` at the repo root. This file is about the plugin: what is in the package, how it relates to the host, and the four things the extraction changed.

## Lineage

Built as the host's `bases` capability module (#243), with the shared `queryBaseRows` seam factored out at #241. Extracted to its own plugin at the suite split's **S7** — the design doc's `docs/suite-split-design.md` §6 row *"Bases | public optional | satellite"*, the first of the optional tier. It follows `packages/quickadd-choices-compile` (the pilot) and the private-tier satellites `packages/skills` (`vault-skills`, S4), `packages/triage` (`vault-triage`, S5) and `packages/crosssession` (`vault-crosssession`, S6). The `.base` interpretation, the propertyId normalization, the capture lifecycle, the serializer and the hidden-leaf adapter are the same code through both homes; only who mounts them differs.

## Package layout

```text
packages/bases/
├── manifest.json          plugin id `vault-bases`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js (no assets, no defines)
├── src/
│   ├── main.ts            onload: settings + adoption, settings tab, publishTools (re-published on every config change)
│   ├── settings.ts        settings shape, the 2 field definitions, one-shot host config adoption (pure)
│   ├── settings-tab.ts    the plugin's own settings tab
│   ├── tools.ts           the two tool specs, the shared queryBaseRows seam, the injected BasesSource, the ctx
│   ├── obsidian-source.ts the live adapter — the hidden capture leaf and the engine's own result set
│   └── kernel/
│       └── index.ts       the pure core — Obsidian-free: `.base` interpretation, propertyId normalization,
│                          row bounding, the capture lifecycle scaffold, the serializer, the config
└── tests/                 67 tests; everything but the Obsidian adapter is headless
```

Installed into a vault this is two files — `main.js` and `manifest.json` — plus, during development, an empty `.hotreload` marker in the installed plugin directory so the hot-reload plugin picks up rebuilds. The `.hotreload` file lives in the vault install, never in this repo.

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # tsc --noEmit && node --test 'tests/*.test.mjs'
```

`pretest` rebuilds `@vault-mcp/core` first, for the same reason the host's and the other satellites' do: the tests reach a published core contract (`isVisible`) through `packages/core/dist`, so without the rebuild you are testing the previous build's bytes.

## It does NOT work without the host

Same as the triage and cross-session satellites. The two published tools ARE the plugin. With Governor absent it loads, keeps and validates its settings, and does nothing; `publishTools` waits on the host's ready event and registers the moment a host appears. The settings tab says so.

**There is a second way this plugin can be legitimately silent**: the running Obsidian may not expose the public Bases API (1.10+), or the Bases core plugin may be off. Then it publishes *nothing* — absent, not broken, the same degradation the fileclass module uses. **The grain of that check changed at the extraction and it is worth knowing.** As a module the gate ran per connection build, so a session that reconnected after an Obsidian upgrade got the tools. As a satellite it runs at publish time — plugin load, and every settings write. So if you upgrade Obsidian (or re-enable the Bases core plugin) *without* reloading this plugin, the tools stay absent until a reload. The settings tab says which state you are in.

## The four things the extraction changed

### 1. The published tool names changed — twice over

| shipped by the module | bare name in this package | published by the satellite |
|---|---|---|
| `base_list`  | `list`  | **`vault_bases_list`**  |
| `base_query` | `query` | **`vault_bases_query`** |

Two compositions produce that. First, the host publishes an external tool as `<sanitized publisher id>_<bare name>`, so **the plugin id and the tool namespace are the same string**, and `vault-bases` sanitizes to `vault_bases` — the same rename class as triage's and cross-session's. Second, the bare names shed their `base_` prefix, because keeping them would have published the stuttering `vault_bases_base_list` / `vault_bases_base_query`.

**This breaks any agent session or saved prompt that calls the old names.** That cost is real and should not be understated: the host's own locked decision says renaming shipped tool names breaks agent sessions for zero semantic gain. What buys it here is that the alternative spelling is actively worse to read and to type, and that the rename is one motion rather than two.

**Reversing it is a one-line change**: `manifest.json`'s `id`, plus the strings in `tests/host-shim.mjs` and the settings tab's status line. Nothing else in the package encodes the prefix — the specs carry BARE names, and the prefix is the host's.

### 2. The allowlist boundary moved to the host, and it lands ASYMMETRICALLY

This is the one place this extraction differs from its three predecessors, where the boundary closed on the whole surface. Here one tool tightens and one loosens, and both halves are stated.

The host's external-tool gate is what enforces scope now, and it refuses on two grounds:

- An external tool's `readOnlyHint: true` is a CLAIM the host distrusts unless the publisher's raw plugin id appears in its **`trustedReadOnlyPlugins`** setting. Untrusted, **both** tools register as mutating — so **read-only mode blocks both**, and each takes a write-queue slot and a journal record even though neither writes anything. Listing `vault-bases` in that setting restores read-only-mode availability; it does **not** change the gate below (the trusted exemption was closed 2026-09-05 by the skills satellite's review — trust answers read-only mode, never scoping).
- A mutating external tool whose arguments carry **no recognized path key** is **blocked outright** while a path allowlist is active. Crucially the host evaluates this **at call time on the ACTUAL ARGUMENTS**, not on the declared schema.

So:

- **`vault_bases_list` takes no arguments at all** ⇒ under an active path allowlist it is **blocked wholesale**, where the module filtered its `.base` listing through the host's own visibility filter. Fail-closed, and strictly stricter.
- **`vault_bases_query` takes `path`**, which IS one of the host's recognized path keys ⇒ it is **not** blocked. The host's guard **scopes** it, refusing `out_of_allowlist` when the named `.base` file is hidden. The in-handler `pathVisible` belt is now dormant (nothing supplies `ctx.visible` in the shipped configuration) and the ENFORCED check is the host's.

**The row filter is dormant too, and that is a genuine reduction in containment.** `boundRows`' allowlist drop and the `some_rows_hidden` marker both depend on `ctx.visible`, which a satellite cannot obtain — and the host's guard checks the `path` ARGUMENT, never the row paths the engine discovers. So **under an allowlist, `vault_bases_query` on a VISIBLE base can now return rows naming notes outside the allowlist, where the module dropped them.** That is the extraction's honest cost. It is not a hole to paper over with a claim that "the host scopes it": the host scopes the base you name, not the notes the answer contains. The seam re-lights the day `vault-mcp-api` can carry the caller's scope to a publisher — an apiVersion-2 item, the same one triage and cross-session named — with no change to the code. Until then it is something the host may want to decide on explicitly.

**This has nothing to do with issue #381.** That issue names `obsidian_health`, `provenance_reconcile` and `obsidian_conformance_debt` as whole-vault readers absent from the host's enumerated exception list. Bases is not one of the three and this extraction does not resolve it.

### 3. The capture serializer MOVED, and there is no second copy

At S5 the triage extraction deliberately left `queryBaseRows` and the hidden-leaf capture in the host, because **a second copy of the serializer in a second plugin would race the host's over the one global hidden Bases leaf**. That reasoning is quoted in five places across the repo, and it is correct — for a second *consumer*.

It does not block this extraction, because **bases is the OWNER of the leaf and of the serializer, not a second consumer.** A move leaves one copy; a copy would have left two. Verified before the move rather than assumed:

- `queryBaseRows`' only production call site anywhere in the repo was `base_query`'s own handler. Every other reference was in its own test file.
- `captureSerializer` had exactly one call site: inside `queryBaseRows`.
- `makeSerializer` and `captureWithCleanup` were used only by the three files that moved.
- The triage satellite's `baseQuery` ctx seam is a **shaped type that nothing ever supplies** — it imports nothing from the host and its handler refuses `bases_unavailable`. It is not a consumer.

So zero host callers remained, and after the move `grep -rn "queryBaseRows\|makeSerializer\|captureSerializer\|captureWithCleanup" packages/plugin/src` returns nothing. The mirror-image risk is exactly why this is a **move and not a copy**: had the host kept a copy, the two serializers would race.

The serializer must stay **module-scoped, not per-registration** — `main.ts` rebuilds the specs on every settings write and the host snapshots them per connection, so a per-build serializer would serialize nothing. Pinned by test.

### 4. Settings adopt once from the host, and never write back

Configuration used to live in the host's `data.json` at `modules.bases.config` — the per-query timeout and the row cap. On first load this plugin copies the recognized keys into its own `data.json` and latches, under the three rules the skills, triage and cross-session satellites established: **it never writes the host's settings**, **it runs once**, and **this plugin's own values win** (adoption fills gaps only). If the host is absent — or present but still mid-onload, with `settings` undefined — nothing is adopted and the latch is not set, so the one chance survives to a later load.

**There is no second adoption, and that is a checked fact rather than an omission.** Cross-session needed one because it had live operational state outside `data.json` (the per-handle read receipts). This surface is read-only end to end: no state file, no cache, no note it ever wrote. The two config keys are the whole migration.

## Two smaller consequences worth knowing

**Refusals throw.** A handler returns plain data or throws; the host wraps the first in `ok()` and the second in `fail()`, and `fail()` renders a lowercase-snake `code` off the error as `Error [code]: message` — the same shape the module's `codedError` produced. Every typed refusal an agent sees (`bases_unavailable`, `not_a_base`, `out_of_allowlist`, `not_found`, `base_parse_error`, `view_not_found`, `base_timeout`) is byte-compatible with the folded era. **One code is new: `invalid_path`** — a `path` argument containing a backslash is refused outright, before every other path check, because every check downstream splits on `/` alone and an Obsidian path never legitimately contains a backslash. Same rule the triage satellite adopted for `target_path`.

**Schema bounds are re-applied in the handler.** The SDK converts a zod shape to JSON Schema and the host converts it back through a deliberately small subset: `type`, `description` and string `enum` survive; `default`, `min`, `max` and `pattern` do not. So `path`'s `.min(1)` and `limit`'s `.int().min(1)` run again in the handler, where they actually execute. This is the `vault_skills_release` semver lesson, applied before it could bite.

## What the host still owns

Everything a published tool rides through: the guarded registration point, read-only mode, the path allowlist, the serialized write queue, the write journal, `if_rev` / `idempotency_key` / `intent`, advisory locks, and record immutability. Publishing does not exempt a tool from any of it — which is also why an untrusted read-only claim costs these two tools a queue slot and a journal record apiece.

**There is no write path in this plugin at all.** No palette command, no ribbon, no pane touches `app.vault`, and the only Obsidian mutation anywhere is the construction and detachment of a hidden, unparented leaf — which never enters the workspace tree and never touches a file.

What this plugin owns is the `.base` interpretation, the propertyId normalization, the capture lifecycle and its serializer, the row bounding, and its own settings.
