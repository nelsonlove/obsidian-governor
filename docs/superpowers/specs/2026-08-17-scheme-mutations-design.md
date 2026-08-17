# Scheme mutations — assign / refile / renumber — design

*2026-08-17 · branch `worktree-jd-mutations-fold` · session: jd-mutations-fold*

## What this is

The write half the scope-provider v1 spec explicitly deferred: "refile/renumber as
kernel operations (report-first, uid-stable renames)". First of three staged folds
retiring `obsidian-johnny-decimal` into vault-mcp (mutations → dashboard → survey,
in that order, per Nelson's ruling 2026-08-17). Three new mutating tools over the
existing `ScopeProvider`/`SchemeRegistry` kernel service:

- **`obsidian_assign_address`** — claim the next free address in a scope and move the
  given note there. Composes the existing `nextFree()` (read) with a move.
- **`obsidian_refile_address`** — move a note to the folder its *own* address says it
  should be in. Composes the existing `expectedFolder()` (read, already the engine
  behind `obsidian_expected_location`) with a move.
- **`obsidian_renumber_address`** — change a note's address to a new one. If the new
  address is occupied, displaces the occupant to its own next-free slot first, in the
  order that avoids a collision, then moves the source.

Rulings from Nelson (2026-08-17, in chat — chat answer is the ruling):

- Sequencing: mutations first, dashboard second, survey third (separate specs).
- Exposure: MCP tools, not Obsidian-command-only — agent-callable, matching v1's own
  posture rather than obsidian-johnny-decimal's human-only commands today.
- Report-first: every tool requires an explicit `dry_run` choice (mirrors
  `obsidian_repoint_link`'s existing `dry_run` param) — no silent default-to-write.
- Retirement: `obsidian-johnny-decimal` is fully retired once all three folds land, not
  kept alongside vault-mcp indefinitely.

## Why this is thinner than a straight port

`obsidian-johnny-decimal`'s `renumber.ts`/`actions.ts` reimplement file-move mechanics
(`app.fileManager.renameFile`, folder-vs-cover-note branching, manual occupant lookup by
scanning every markdown file) because they predate the kernel. vault-mcp already has
all of that, generically, at two layers:

- **Read/compute** — `nextFree(scope, used)` and `expectedFolder(addr)` already exist on
  every `ScopeProvider` (`kernel/scheme/provider.ts`), already exercised read-only by
  `obsidian_next_address` and `obsidian_expected_location`.
- **Write** — `moveNote()` (`mcp/obsidian-backend.ts`, backend-agnostic: live Obsidian
  and filesystem backends both implement it) already does the rename + backlink rewrite
  + folder creation + overwrite-refusal that `renumberCommand`'s manual
  `app.fileManager.renameFile` calls hand-roll today.

So this fold is composition, not a port: new pure decision logic (occupant lookup,
displacement-order computation) plus three new tool handlers that call primitives
that already exist. The one genuinely new piece is **occupant lookup at a specific
target address** — `membersOf`/`nextFree` answer "what's free", not "what's *there*";
renumber needs the latter to know whether a displacement step runs at all.

## Architecture

```
packages/plugin/src/kernel/scheme/
  mutate.ts        — NEW. Pure decision logic, no obsidian import, unit-testable
                      headlessly (kernel-module discipline, same as provider.ts):
                        planAssign(provider, scope, used) -> { address, expectedPath }
                        planRefile(provider, addr) -> { expectedPath }
                        planRenumber(provider, scope, from, to, occupant) ->
                          { steps: MoveStep[] }   // 1 or 2 steps, source-then-occupant
                                                   // or occupant-then-source, whichever
                                                   // order never collides
  provider.ts      — extend with `occupantOf(scope, addr, files): Member | null`
                      (the missing "what's there" read primitive both assign's
                      collision check and renumber's displacement need). Read-only,
                      same discipline as the rest of the file.
packages/plugin/src/mcp/
  tools-scheme-write.ts — NEW. The three tools below, mirroring tools-vault-write.ts's
                      split from its read-only sibling. Imports `moveNote` from
                      obsidian-backend.ts and the plan* functions from mutate.ts; the
                      tool handler is the only place obsidian-shaped state (the backend)
                      and pure plan objects meet.
```

`occupantOf` living on `provider.ts` rather than `mutate.ts` matters: it is
scheme-specific (JD's "occupant" is "exact address match"; a future ordered-but-not-
addressed scheme might not have the concept at all), where `mutate.ts`'s planning
functions are scheme-agnostic given whatever the provider reports.

## MCP surface

All three follow the existing scheme-tool discipline: allowlist-filtered via
`visiblePaths`, registered through the shared `guarded.ts` interception point (so
`if_rev`/`idempotency_key` peel off automatically, writes serialize through the kernel's
write queue, and every apply gets a journal entry for free — nothing bespoke to build
for any of that).

1. **`obsidian_assign_address`** — `{ path, scope, dry_run }`. `scope` takes the same
   shape `obsidian_next_address` already accepts (a scope identifier in the registry's
   existing terms — no new type). Computes the next free address in `scope` (racing
   sessions: point them at `obsidian_claim_scope` first, same as `obsidian_next_address`
   already tells callers — this tool doesn't claim on their behalf, consistent with
   "computes, doesn't reserve" staying read-tool doctrine even for the write path's
   *planning* step). `dry_run: true` returns the computed address and the move that
   *would* happen; `dry_run: false` performs it.
2. **`obsidian_refile_address`** — `{ path, dry_run }`. Reads the note's own configured
   address (frontmatter or filename, whatever the provider's `parse` already accepts),
   computes `expectedFolder`, moves if it differs. Two distinct non-move outcomes, both
   reported rather than errored: already correctly filed (no-op), and no address found
   to refile against (nothing to compute from — same "no address" refusal shape
   `obsidian_resolve_address`'s `parse` mode already uses, not a new error type).
3. **`obsidian_renumber_address`** — `{ path, to, dry_run, on_occupied, displace_to }`.
   `on_occupied` enum `"auto" | "manual" | "fail"`, default `"fail"` — refuses if the
   target is occupied rather than guessing at intent, forcing a deliberate choice per
   call (matches "report-first" harder than defaulting to auto-displace would).
   `"auto"` computes the occupant's displacement via `nextFree` on the occupant's own
   scope, same as the interactive command's auto-displace path. `"manual"` requires
   `displace_to` (a second address, validated the same way `to` is) and errors if
   omitted — two params rather than one string-encoding a mode and a value, so the
   schema itself rules out a malformed combination instead of the handler having to
   parse one. This replaces `renumberCommand`'s interactive
   auto-displace/manual-displace/cancel prompt sequence with an explicit up-front
   choice, per dual-mode invocation doctrine (an agent can't answer a `confirmPrompt`).

Dry-run response shape for all three: `{ dry_run: true, moves: [{from, to}, ...] }` —
same shape whether one step or two, so a renumber's occupant-displacement step isn't a
special case the caller has to branch on.

## Uid stability

The prior spec flagged "uid-stable renames" as the constraint for this work. `moveNote`
already goes through Obsidian's `renameFile` (live backend) which never touches
frontmatter — a note's `uid:` is untouched by any of these three tools by construction,
not by an added check. Worth a test asserting it anyway (uid before === uid after
survives a real move), since it's the property the deferred-scope note called out by
name.

## Testing

- `mutate.ts`: headless unit tests (vitest) — collision detection, displacement-order
  selection (source-first when target is free, occupant-first when it isn't), the
  no-op-when-already-correct case for refile.
- `provider.ts`'s new `occupantOf`: unit tests alongside the existing `jd.ts` provider
  suite — exact-address match, no match, and the "occupant" concept for a hypothetical
  non-addressed provider (returns null, never throws).
- `tools-scheme-write.ts`: synthetic file-listing tests matching `tools-scheme.test.mjs`'s
  existing pattern, plus dry-run vs apply for all three tools, plus the uid-stability
  assertion above.
- Live smoke via the bridge JSON-RPC procedure (same as v1's delivery): assign against a
  real scratch category, renumber with a real displacement, refile a deliberately
  misfiled scratch note.

## Delivery

- This spec commits to this worktree's branch; PR opened against `main` once the
  self-review + your review pass, per the standing PR workflow (auto-review via
  `/code-review high` after `gh pr create`, self-merge only after that review is clean
  or fixes are pushed).
- Out of scope for this delivery, explicitly: dashboard (views/panels/audit-report —
  next fold), survey (including the claude.js-vs-anthropic.ts question you flagged —
  next fold after that), full `lintVault`/`lintNote` parity beyond the name-hygiene
  checks already folded, `promote-id`/`demote-id` (named in the ledger's addressing-verbs
  list but never implemented anywhere, including in obsidian-johnny-decimal today — no
  existing behavior to port, would be new design work if wanted later).
- `obsidian-johnny-decimal`'s `numbering` module (`assignNextNumber`, `refileToMatchId`,
  `renumberCommand`) is NOT touched or removed by this delivery — full plugin retirement
  waits on dashboard and survey landing too, per your ruling above.
