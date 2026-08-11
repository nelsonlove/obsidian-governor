# Docs invariant-claim allowlist (#152)

Each entry below is a span of prose from README.md or docs/*.md that
`docs-drift.test.mjs` flagged: it contains BOTH an invariant word ("never",
"every", "always", "cannot", "no way", "guarantee(s)", "impossible") AND a
security-relevant term (journal, accept/acceptance/accepted, guard, audit,
"every write", provenance). The check fails CI unless the exact span text
below is present verbatim (or, see "Known-overstated" below, is explicitly
tracked as not-yet-true rather than approved).

**This file does not assert that any claim in the approved sections is
true.** It records that a human reviewed the sentence, checked it against
the current implementation and open issues, and deliberately decided it is
safe to publish as written. Seeded from `main` at the time #152 landed (see
the seeding commit) — every entry here was reviewed at seed time, not
rubber-stamped. Re-audited in full against the open perimeter-milestone
issues (#92, #105, #107, #109, #110, #137, #153) on 2026-08-10 after an
initial seed was found to be laundering two false claims — see the
Known-overstated section for what that audit changed.

`docs/vision-walkthrough.md` is excluded from this check entirely (not
allowlisted, not scanned) — it is explicitly bannered as describing the
destination, not the shipped product, and allowlisting aspiration-written-
as-fact would train this control to accept exactly the thing it exists to
catch. See docs-drift.test.mjs for the exclusion.

If a claim's wording changes at all — including gaining or losing a
qualifier like "through the plugin's guarded path" — it becomes a different
span and is no longer covered by its old entry. That is intentional: a
narrowed claim needs the same conscious re-approval as a new one.

To approve a new or changed claim: confirm the current implementation and
perimeter tests substantiate it, then add the exact span text as a `- `
bullet under the file it lives in (headings below are for review grouping
only; matching is by exact text regardless of which file it's under). If
the claim is the document's stated goal rather than a currently-true fact,
and the surrounding document already carries the honest nuance, use the
Known-overstated section instead — see its header for the format.

## README.md

- vault-mcp is an Obsidian plugin that connects AI agents (Claude Code, or anything that speaks MCP) to your vault the *governed* way: agents see your vault the way Obsidian does, every change they make is recorded and attributed, and one rule is enforced at the shared write primitive: **an agent cannot mark its own work as accepted through it.
- **A paper trail for everything.** Every mutating operation through the plugin's guarded path lands in an append-only journal: what happened, to which note, by which agent, in which session — and, when the agent says so, *why*. (The optional headless FS-fallback mode is a documented exception — see [Honest limits](#honest-limits).) "What did it do while I was out" becomes a file you can read.
- Reviewing and accepting is meant to happen only in a human-only review pane (the companion **Acceptance** plugin) — never through the API on the surfaces the guard covers today; the surfaces it doesn't cover yet are named, tracked gaps, not silent ones (see [Honest limits](#honest-limits)).
- Open the journal (or the Acceptance pane, if installed): every change is there, attributed, diffable, waiting for your verdict.
- **Acceptance is a human gesture, and it goes in no API.** There is no accept tool, no accept argument, and no way to smuggle acceptance in as data **through the shared write primitive**: it rejects any write that would introduce `acceptance-status: accepted` (or `accepted-by` / `accepted-on`), on every write surface that routes through it — including the CLI proxy — while leaving your own existing accepted values untouched.
- The guarantee is narrower and real: nothing arriving through a surface the guard covers can forge acceptance, every write on the plugin's guarded path is journaled, and out-of-band changes surface as drift.
- Every claim above about journaling is scoped to the plugin's guarded path, not this fallback.
- **The guard doesn't cover every surface yet — named, not papered over.** Templated note creation ([#137](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/issues/137), [#105](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/issues/105)), CLI flag-form arguments ([#107](https://github.com/nelsonlove/obsidian-vault-mcp-plugin/issues/107)), and a couple of lower-severity paths can currently introduce or resurrect acceptance without going through the guarded primitive.
- Context-conscious sessions can use **Code Mode** (`--code-mode` on the bridge command): three meta-tools — search, describe, call — over the same registry, with every guard binding on the target tool exactly as on the full surface.

## docs/README.md

- | **[acceptance-model.md](acceptance-model.md)** | **The heart of the design.** Acceptance is human-only — "the accept verb goes in no API." The accept-forbidden guard at the shared write primitive, on every write surface that routes through it (including the CLI proxy), and its documented residuals (tracked publicly; not yet all closed). |
- **Agents can stamp identity** (a created-seeded UUIDv7 `uid`, `created`/`modified`, canonical frontmatter order) and **attach an advisory `intent`** ("why I'm making this change") that rides the journal record — but stamping itself **never writes acceptance** (it defaults and preserves `acceptance-status`, never mints or elevates it); the guard against acceptance arriving by other routes is the shared write primitive, and its known gaps are tracked (see the top-level [README's Honest limits](../README.md#honest-limits)).
- **The human keeps the sole accept veto — by design, and by enforcement on the surfaces the guard covers.** Acceptance is a gesture made in the **[Acceptance review surface](#the-acceptance-review-surface)** — never through a tool, agent, or CLI call the guard sees.
- The acceptance model's guarantees below are stated for the **plugin's guarded write surfaces**; these issues are the honest boundary of that claim until closed.
- "Every write is journaled" is true of the **plugin's kernel-guarded path** only, never of this fallback.

## docs/acceptance-model.md

- That is a real residual (#153), and it is the reason the rule above is "decide over the honored bytes" rather than "never normalize": where normalization is unavoidable, the normalization itself becomes part of the guard's attack surface and has to be reasoned about explicitly.
- Broader is fine; **narrower is the bypass.** The property is pinned by `tests/accept-fence-parity.test.mjs`, which asserts *write path would honor ⟹ guard refuses* across every tolerated fence variation, plus the normalization cases that motivated the second pass, plus the cost of the conservatism (prose between thematic breaks is refused — a chosen trade, pinned so it reads as a choice).
- **A value** *asserts* acceptance if — across **every value-type it can take** — it resolves to `accepted` / `accepted-*`:
- **Move is not a content write.** `obsidian_move_note` / `obsidian_move_notes` rename through `app.fileManager.renameFile` and never touch note content, so a move cannot introduce acceptance and carries no content guard — the guarantee holds by construction there rather than by an added check.
- So the CLI path grows its **own** accept-forbidden check (`cliAcceptRefusal` in `packages/plugin/src/mcp/tools-cli.ts`), run **before the command executes**, reusing the exact same `acceptForbiddenReason` rule — no fork of "accepted." A CLI write is always an *introduce* (the CLI path has no expression for "carry an existing human value forward"), so the introduce check is exactly right.
- So the template guard **fails closed on expansion tokens** (#137, Option 2): a template whose resolved bytes carry *any* Templater expansion token is **refused outright**, because its expanded output cannot be inspected before it lands (`templateExpansionRefusal` refuses on any `<%` opener, covering every Templater tag form).
- The pattern connecting every one of these: **the guard must inspect the bytes that will be honored.** Each residual is a place where something else — an escape expansion, a template processor, another plugin's config — produces the honored bytes after the guard has looked.

## docs/agent-writes.md

- The guard monkeypatch (`server.ts`) already wraps every *mutating* registration in one `runMutation`, and the write queue is non-reentrant (a queued closure that enqueues again would deadlock behind itself).
- **Stamping never writes acceptance.** It defaults `acceptance-status: proposed`, never mints or elevates to `accepted`, and preserves an existing on-disk `acceptance-status` **verbatim** (including a human-granted `accepted` — changing it would destroy the human's decision).
- It is the third [kernel argument](kernel-v0.md#kernel-arguments) (`KERNEL_ARG_KEYS = ["if_rev", "idempotency_key", "intent"]`), declared on **every mutating registration** via `withKernelArgs` and **peeled by the guarded wrapper before any handler runs** (`packages/plugin/src/mcp/guarded.ts`).
- **Journal-only.** It is recorded verbatim on the journal record beside `op`/`actor` (`JournalRecord.intent`, `packages/plugin/src/kernel/journal.ts`) and **never reaches note content** — it is peeled before the handler, so it structurally cannot be written into a note's frontmatter or body.
- **Never an accept or idempotency signal.** It is **excluded from idempotency identity** — a retried call may reword its intent freely and still dedupe — and it is **never read back** as any kind of acceptance or approval signal.
- **Batch-aware.** `obsidian_write_notes` accepts a batch-level `intent` describing the change-*set*; the guarded single-writer peels it per item, so **every** item's journal record carries it and the Acceptance pane's per-note rows each show it.
- **It exposes data another plugin published — nothing more.** The Acceptance review plugin rewrites a read-only index at `<config-dir>/plugins/stewardship/pending-index.json` (the path keeps the legacy plugin id until #115) on every review-queue refresh; this tool reads it.
- `readOnlyHint: true`, empty input schema, no write and no accept/baseline verb: it reports pending-ness; it cannot accept ("the accept verb is in no API").
- **Allowlist-filtered.** The index is written from the whole vault, so every returned entry is filtered through the **same `isVisible` guard** the uid/read tools use, *before* it is reported — a sandboxed session that could learn about pending notes in territory it cannot read would have a path oracle otherwise.

## docs/conformance.md

- An explicit `--baseline=` fixture path is always allowed; the guard flips once the port set is complete and the cutover rebaseline is reviewed.

## docs/identity-and-links.md

- It binds at the **same single interception point** as the accept guard and the write queue (`packages/plugin/src/mcp/guarded.ts`), so handlers never see a uid reference — they get the resolved path.

## docs/kernel-v0.md

- Every mutating operation appends **one JSONL line** to `.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl` (rolled monthly, inside the plugin's own folder, not the note tree).
- A failed journal write is logged to console and dropped; it never fails the vault operation.
- Claiming and releasing are treated as **mutating** (journaled with `target.ref = scope:<prefix>` / `lock:<id>`), so **read-only mode blocks claiming and releasing** — there is nothing for a claim to disclose in a session that cannot write.
- Every journal record's `actor.server` carries a persistent **install id** — minted once and kept beside the journal in `.obsidian/plugins/vault-mcp/install-id.json` (`packages/plugin/src/kernel/install-id.js`) — plus the **vault name** and plugin **version**.
- They are declared generically on **every mutating registration** (`withKernelArgs` in `packages/plugin/src/mcp/guarded.ts`) and consumed generically (stripped from args and passed to `Kernel.runMutation`).

## docs/modules.md

- Because the registrar it forwards to is the **guard-patched `server.registerTool`**, every module tool lands at the **same interception point** as every hand-registered tool — guarded, queued, journaled, kernel-args-declared, Code Mode captured — with **no module-specific bypass possible**.
- The enforcement lives in the mount's gate (a bare `registerAll` with no gate would allow mutating tools) — but the sole `registerAll` caller is `mountModules`, which always passes it, and the guard-patched `registerTool` is the backstop underneath.
- There is **no `kernel`, no raw server, no `registerTool`, no baseline/accept primitive**. (The `ModuleHostCtx` *type* permits optional `kernel?`/`sources?` for future use, but the mount populates neither.) The only registrar a module holds is the wrapped `scoped` registrar, which runs the forbidden-name + collision + read-only checks before forwarding — a module cannot walk it to a raw `registerTool` or to any write/accept surface.
- Every mounted handler's own context carries only read-only closures; no mounted handler can reach a write, accept, or baseline surface.

## docs/reference.md

- Every mutating operation also appends **one JSONL line** to `.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl` (rolled monthly, inside the plugin's own folder rather than the note tree):
- If a journal write fails it is logged to the console and dropped; it never fails the vault operation.
- Safety guards that apply: read-only mode always applies (mutating external tools are blocked when read-only is on); the path allowlist scopes arguments under recognized path keys (path, from, to, paths, and a few others) — when an allowlist is active, mutating external tools whose args carry no recognized path key are blocked outright, since vault-mcp cannot scope the call.
- `readOnly: true` on a published tool is an assertion by a third-party plugin about code vault-mcp cannot inspect — and believing it exempts that tool from the write queue, the journal, the path allowlist, the kernel arguments, and read-only mode, all at once.


## Known-overstated (tracked, not approved-as-true)

Entries here are NOT approved as currently-true claims — they are the design's stated goal/
contract for the accept-forbidden guard, in `docs/acceptance-model.md`'s own voice, at a point
in that document that precedes its (extensive, honest) enumeration of exactly where the guard
doesn't yet reach. Forcing them into the normal "approved" section above would be the same
laundering #152 exists to stop, just moved into the allowlist instead of the doc. Forcing a
rewrite of the document's opening thesis every time a new residual is filed would fight the
document's own structure (state the invariant, then rigorously name every exception below it).

This section exists so the allowlist doesn't have to lie about these either way. An entry here
still makes the check pass (a human reviewed it and judged the doc's surrounding honesty
sufficient) — it is a different epistemic status from the sections above, not a bypass.

Format: the exact span text, then an indented (non-bulleted, so it isn't itself matched as an
entry) `tracked by:` line naming the open issues that currently falsify it as a bare claim.
When all tracking issues close, promote the entry to a normal approved section (or re-verify
and narrow it) — this list is not meant to be permanent.

- What it may **never** do is declare that a change has been **accepted**.
  tracked by: #137, #105, #107 — templated note creation and CLI flag-form arguments can
  currently introduce acceptance without the guard seeing it; #153 is a narrower related gap
  in the CLI's escape-reconstruction path.
- And — the part that makes it a *guarantee* rather than a *convention* — an agent cannot smuggle acceptance in as **data** either, by writing `acceptance-status: accepted` (or `accepted-by`, `accepted-on`) into a note's frontmatter.
  tracked by: #137, #105, #107 (same residuals as above — this is the same claim restated).
- The guarantee is enforced at the **shared write primitive** — the single point every filesystem-expressible write routes through — so it holds on **every write surface at once**, not tool by tool.
  tracked by: #105, #109 — `obsidian_create_note_from_template`, `fileclass_insert_fields`,
  and `append_at_heading` do not route through the shared primitive today (confirmed by
  reading their registration sites, 2026-08-10).
- The guard lives at the shared primitive in `obsidian-backend.ts`, which every filesystem-expressible write tool routes through.
  tracked by: #105, #109 (same routing gap as above — this is the same claim restated).
- The value of the model is that "an agent cannot accept" is not a rule an agent is *asked* to follow — it is a property the kernel *enforces*.
  tracked by: #137, #105, #107 (same residuals as the opening claim).
- An agent that has never heard of the acceptance model, or one actively trying to forge acceptance, hits the same wall: the write is refused before it lands.
  tracked by: #137, #105, #107 — for these specific paths, the write is not currently refused.
