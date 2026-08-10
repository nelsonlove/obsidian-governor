# Docs invariant-claim allowlist (#152)

Each entry below is a span of prose from README.md or docs/*.md that
`docs-drift.test.mjs` flagged: it contains BOTH an invariant word ("never",
"every", "always", "cannot", "no way", "guarantee(s)", "impossible") AND a
security-relevant term (journal, accept/acceptance/accepted, guard, audit,
"every write", provenance). The check fails CI unless the exact span text
below is present verbatim.

**This file does not assert that any claim below is true.** It records that
a human reviewed the sentence, checked it against the current implementation
and open issues, and deliberately decided it is safe to publish as written.
Seeded from `main` at the time #152 landed (see the seeding commit) — every
entry here was reviewed at seed time, not rubber-stamped.

If a claim's wording changes at all — including gaining or losing a
qualifier like "through the plugin's guarded path" — it becomes a different
span and is no longer covered by its old entry. That is intentional: a
narrowed claim needs the same conscious re-approval as a new one.

To approve a new or changed claim: confirm the current implementation and
perimeter tests substantiate it, then add the exact span text as a `- `
bullet under the file it lives in (headings below are for review grouping
only; matching is by exact text regardless of which file it's under).

## README.md

- vault-mcp is an Obsidian plugin that connects AI agents (Claude Code, or anything that speaks MCP) to your vault the *governed* way: agents see your vault the way Obsidian does, every change they make is recorded and attributed, and one rule is enforced in the code itself — **an agent can never mark its own work as accepted.
- **A paper trail for everything.** Every mutating operation through the plugin's guarded path lands in an append-only journal: what happened, to which note, by which agent, in which session — and, when the agent says so, *why*. (The optional headless FS-fallback mode is a documented exception — see [Honest limits](#honest-limits).) "What did it do while I was out" becomes a file you can read.
- Reviewing and accepting happens in a human-only review pane (the companion **Acceptance** plugin), never through the API.
- Open the journal (or the Acceptance pane, if installed): every change is there, attributed, diffable, waiting for your verdict.
- **Acceptance is a human gesture, and it goes in no API.** There is no accept tool, no accept argument, and no way to smuggle acceptance in as data: the accept-forbidden guard at the shared write primitive rejects any write that would introduce `acceptance-status: accepted` (or `accepted-by` / `accepted-on`), on every write surface including the CLI proxy, while leaving your own existing accepted values untouched.
- The guarantee is narrower and real: nothing arriving through a supported surface can forge acceptance, everything is journaled, and out-of-band changes surface as drift.
- Every claim above about journaling is scoped to the plugin's guarded path, not this fallback.
- Context-conscious sessions can use **Code Mode** (`--code-mode` on the bridge command): three meta-tools — search, describe, call — over the same registry, with every guard binding on the target tool exactly as on the full surface.

## docs/README.md

- | **[acceptance-model.md](acceptance-model.md)** | **The heart of the design.** Acceptance is human-only — "the accept verb goes in no API." The accept-forbidden guard at the shared write primitive, on every write surface including the CLI proxy, and its one documented residual. |
- **Agents can stamp identity** (a created-seeded UUIDv7 `uid`, `created`/`modified`, canonical frontmatter order) and **attach an advisory `intent`** ("why I'm making this change") that rides the journal record — but they **can never write acceptance**.
- **The human keeps the sole accept veto.** Acceptance is a gesture made in the **[Acceptance review surface](#the-acceptance-review-surface)** — never through any tool, never by any agent, never through the CLI.
- The acceptance model's guarantees below are stated for the **plugin's guarded write surfaces**; these issues are the honest boundary of that claim until closed.
- "Every write is journaled" is true of the **plugin's kernel-guarded path** only, never of this fallback.

## docs/acceptance-model.md

- What it may **never** do is declare that a change has been **accepted**.
- And — the part that makes it a *guarantee* rather than a *convention* — an agent cannot smuggle acceptance in as **data** either, by writing `acceptance-status: accepted` (or `accepted-by`, `accepted-on`) into a note's frontmatter.
- The guarantee is enforced at the **shared write primitive** — the single point every filesystem-expressible write routes through — so it holds on **every write surface at once**, not tool by tool.
- Broader is fine; **narrower is the bypass.** The property is pinned by `tests/accept-fence-parity.test.mjs`, which asserts *write path would honor ⟹ guard refuses* across every tolerated fence variation, plus the normalization cases that motivated the second pass, plus the cost of the conservatism (prose between thematic breaks is refused — a chosen trade, pinned so it reads as a choice).
- **A value** *asserts* acceptance if — across **every value-type it can take** — it resolves to `accepted` / `accepted-*`:
- The guard lives at the shared primitive in `obsidian-backend.ts`, which every filesystem-expressible write tool routes through.
- **Move is not a content write.** `obsidian_move_note` / `obsidian_move_notes` rename through `app.fileManager.renameFile` and never touch note content, so a move cannot introduce acceptance and carries no content guard — the guarantee holds by construction there rather than by an added check.
- So the CLI path grows its **own** accept-forbidden check (`cliAcceptRefusal` in `packages/plugin/src/mcp/tools-cli.ts`), run **before the command executes**, reusing the exact same `acceptForbiddenReason` rule — no fork of "accepted." A CLI write is always an *introduce* (the CLI path has no expression for "carry an existing human value forward"), so the introduce check is exactly right.
- **post-scan expansion** on the template path, above — the honest statement is "closed against static accepted fences", never "closed";
- The pattern connecting every one of these: **the guard must inspect the bytes that will be honored.** Each residual is a place where something else — an escape expansion, a template processor, another plugin's config — produces the honored bytes after the guard has looked.
- The value of the model is that "an agent cannot accept" is not a rule an agent is *asked* to follow — it is a property the kernel *enforces*.
- An agent that has never heard of the acceptance model, or one actively trying to forge acceptance, hits the same wall: the write is refused before it lands.

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
