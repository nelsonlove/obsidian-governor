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

`docs/vision-walkthrough.md` and its genre-based exclusion were RETIRED by
the 2026-08-23 documentation migration (the page's content is owned by
getting-started.md and user-guide.md). No file is excluded from this check
anymore; the imported target-state corpus is handled span-by-span in the
"Imported documentation corpus" section at the bottom — tracked, not
approved — because allowlisting aspiration-written-as-fact as APPROVED would
train this control to accept exactly the thing it exists to catch.

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

- Governor is an Obsidian plugin that connects AI agents (Claude Code, or anything that speaks MCP) to your vault the *governed* way: agents see your vault the way Obsidian does, every change they make is recorded and attributed, and one rule is enforced at the shared write primitive: **an agent cannot mark its own work as accepted through it.
- **A paper trail for everything.** Every mutating operation through the plugin's guarded path lands in an append-only journal: what happened, to which note, by which agent, in which session — and, when the agent says so, *why*. (The optional headless FS-fallback mode is a documented exception — see [Honest limits](#honest-limits).) "What did it do while I was out" becomes a file you can read.
- Reviewing and accepting is meant to happen only in the plugin's human-only review pane (the **acceptance module**) — never through the API on the surfaces the guard covers today; the surfaces it doesn't cover yet are named, tracked gaps, not silent ones (see [Honest limits](#honest-limits)).
- Open the journal (or the review pane, if the acceptance module is enabled): every change is there, attributed, diffable, waiting for your verdict.
- **Acceptance is a human gesture, and it goes in no API.** There is no accept tool, no accept argument, and no way to smuggle acceptance in as data **through the shared write primitive**: it rejects any write that would introduce `acceptance-status: accepted` (or `accepted-by` / `accepted-on`), on every write surface that routes through it — including the CLI proxy — while leaving your own existing accepted values untouched.
- The guarantee is narrower and real: nothing arriving through a surface the guard covers can forge acceptance, every write on the plugin's guarded path is journaled, and out-of-band changes surface as drift.
- Every claim above about journaling is scoped to the plugin's guarded path, not this fallback.
- **The guard doesn't cover every surface yet — named, not papered over.** Templated note creation ([#137](https://github.com/nelsonlove/obsidian-governor/issues/137), [#105](https://github.com/nelsonlove/obsidian-governor/issues/105)), CLI flag-form arguments ([#107](https://github.com/nelsonlove/obsidian-governor/issues/107)), and a couple of lower-severity paths can currently introduce or resurrect acceptance without going through the guarded primitive.
- Context-conscious sessions can use **Code Mode** (`--code-mode` on the bridge command): three meta-tools — search, describe, call — over the same registry, with every guard binding on the target tool exactly as on the full surface.

## docs/README.md

- | **[acceptance-model.md](acceptance-model.md)** | **The heart of the design.** Acceptance is human-only — "the accept verb goes in no API." The accept-forbidden guard at the shared write primitive, on every write surface that routes through it (including the CLI proxy), and its documented residuals (tracked publicly; not yet all closed). |
- **Agents can stamp identity** (a created-seeded UUIDv7 `uid`, `created`/`modified`, canonical frontmatter order) and **attach an advisory `intent`** ("why I'm making this change") that rides the journal record — but stamping itself **never writes acceptance** (it defaults and preserves `acceptance-status`, never mints or elevates it); the guard against acceptance arriving by other routes is the shared write primitive, and its known gaps are tracked (see the top-level [README's Honest limits](../README.md#honest-limits)).
- **The human keeps the sole accept veto — by design, and by enforcement on the surfaces the guard covers.** Acceptance is a gesture made in the **[acceptance module](#the-acceptance-module)** — never through a tool, agent, or CLI call the guard sees.
- The acceptance model's guarantees below are stated for the **plugin's guarded write surfaces**; these issues are the honest boundary of that claim until closed.
- "Every write is journaled" is true of the **plugin's kernel-guarded path** only, never of this fallback.
- | [provenance.md](provenance.md) | The provenance module: derived-content freshness — what `derived-from` + `generated` detect, the two-tier deleted-source detection (missing plain paths always; glob deletions via the opt-in `derived-source-count` witness), and the honest limits of an mtime-based check. |

## docs/acceptance-model.md

- This is the reason the rule above is "decide over the honored bytes" rather than "never normalize": where normalization is unavoidable, the normalization itself becomes part of the guard's attack surface, so every bracketed normalization is decided over.
- Broader is fine; **narrower is the bypass.** The property is pinned by `tests/accept-fence-parity.test.mjs`, which asserts *write path would honor ⟹ guard refuses* across every tolerated fence variation, plus the normalization cases that motivated the second pass, plus the cost of the conservatism (prose between thematic breaks is refused — a chosen trade, pinned so it reads as a choice).
- **A value** *asserts* acceptance if — across **every value-type it can take** — it resolves to `accepted` / `accepted-*`:
- **Move is not a content write.** `obsidian_move_note` / `obsidian_move_notes` rename through `app.fileManager.renameFile` and never touch note content, so a move cannot introduce acceptance and carries no content guard — the guarantee holds by construction there rather than by an added check.
- So the CLI path grows its **own** accept-forbidden check (`cliAcceptRefusal` in `packages/plugin/src/mcp/tools-cli.ts`), run **before the command executes**, reusing the exact same `acceptForbiddenReason` rule — no fork of "accepted." A CLI write is always an *introduce* (the CLI path has no expression for "carry an existing human value forward"), so the introduce check is exactly right.
- So the template guard **fails closed on expansion tokens** (#137, Option 2): a template whose resolved bytes carry *any* expansion token — a Templater `<%` opener **or** a core-Templates `{{ … }}` field — is **refused outright**, because its expanded output cannot be inspected before it lands (`templateExpansionRefusal` refuses on either opener as a substring, covering every Templater tag form and the whole core-Templates field class).
- The pattern connecting every one of these: **the guard must inspect the bytes that will be honored.** Each residual is a place where something else — an escape expansion, a template processor, another plugin's config — produces the honored bytes after the guard has looked.
- `history:restore` is deliberately not promoted to a dedicated tool: restoring a prior version can reinstate an accepted value a human revoked, and the restored bytes cannot be scanned pre-exec (#110) — it stays in the proxy's default-denied uninspectable-write set.
  substantiated 2026-08-17 (CLI decomposition PR): `DEDICATED_CLI_COMMANDS` in
  tools-cli-dedicated.ts pins history/diff/base:create/plugin:install/plugin:uninstall and
  nothing else — cli-dedicated.test.mjs asserts the registered set exactly and that no
  source pins "history:restore" — and the command stays in cli-policy.ts's
  UNINSPECTABLE_WRITE_CLI_COMMANDS default-deny set, whose rationale (#110) this sentence
  restates.
- **This does not touch the agent-side guarantee.** The stamp is an in-app, human-gesture-gated `processFrontMatter` call (`stampAcceptedFrontmatter`, module-scope and unexported in `governance/wiring.ts`, reachable only through the gesture-gated accept handler) — it **bypasses MCP entirely** and is exactly the human path the accept-forbidden guard reserves.
  substantiated 2026-08-18 (acceptance convergence, #221/#164): packages/core is diff-zero in
  that change; governance-module.test.mjs pins stampAcceptedFrontmatter as module-scope,
  unexported, with exactly one caller (acceptNote's injected stampAccepted dep on the
  gesture path) and asserts the MCP layer references none of the accept path. The residuals
  in "Known-overstated" (#137/#105/#107) qualify the agent-side guard exactly as before —
  this sentence claims the CONVERGENCE changed nothing on that side, which is what the
  zero-diff + regression run substantiate.
- A failure between the stamp and the baseline advance leaves the note stamped with the old baseline; the retry Accept sees `accepted` and takes the advance-only branch, so a double-stamp is impossible.
  substantiated 2026-08-18: governance-accept.test.mjs "setBaseline throws AFTER a landed
  stamp" pins exactly this — the retry stamps zero additional times and lands the baseline
  on the stamped bytes; acceptNote only stamps when acceptanceStatusOf(content) ===
  "proposed", which a landed stamp has made "accepted".
- Every agent transport still refuses the accepted family; `@vault-mcp/core` is unchanged.
  substantiated 2026-08-18: the accept-guard suites (accept-forbidden, accept-fence-parity,
  accept-guard-control-char, mcp-template-accept-guard, append-at-heading-accept, cli
  guards) run unchanged and green in the convergence PR, and packages/core has a zero diff.
  "Every agent transport" carries the same tracked residuals as the opening claims
  (#137/#105/#107) — unchanged BY this change, per the section above.
- The legacy QuickAdd accept-macro gated acceptance on vault-specific checks (uuid7 `uid`, `title`, `description`); that gate maps onto this config — per-vault configuration, never a hardwired vault convention in the plugin.
  substantiated 2026-08-18: requiredFrontmatterKeys defaults EMPTY (no gate) and the plugin
  source names no vault-specific key — the uid/title/description list appears only as a
  settings placeholder/example; governance-proposed.test.mjs pins the coercion and
  governance-accept.test.mjs pins empty ⇒ no gate.
- The accepted family is one hardcoded instance of a general rule, and #224 generalizes it: a **declared list** of frontmatter properties (Security › *Protected frontmatter properties*, human-only-mutable — no agent path writes plugin config) that every guarded transport enforces through the **same two predicates** the accepted family already rides (`acceptTransitionReason` / `acceptForbiddenReason` in `@vault-mcp/core`).
  substantiated 2026-08-18 (#224): the declared list lives in the module registry inside
  accept-guard.ts and is consulted INSIDE the two predicates, so every existing call site
  (fs backend, ObsidianBackend, composeNote, append_at_heading, CLI property/content,
  fileclass, skills, provenance, revision, debt-register) enforces it with zero call-site
  changes; protected-properties.test.ts, protected-properties-fs.test.ts and
  protected-properties-transports.test.mjs are the per-transport sweep. "No agent path
  writes plugin config" carries the standing settings-surface caveat: settings are
  data.json, mutable by any local process outside the plugin's transports — the same
  residual the class allowlist documents (a tampered list can only extend the perimeter;
  the floor is hardcoded).
- The acceptance module's `honoredValueFromBlessed` reads the accepted **baseline** — never the raw frontmatter — so a value sneaked in through a side door (another plugin, a script, Sync) is **inert** until blessed.
  substantiated 2026-08-18 (#224/#135): honoredValueFromBlessed takes the blessed CONTENT
  (wiring reads it off the BaselineStore) and has no raw-note read path; baselines advance
  only via Accept / attributed human edit / adopt / auto-accept, each blessed by
  construction. governance-protected-policy.test.mjs's honor-rule scenario pins side-door
  inertness and the bless-then-honor flip.
- The eligibility engine consults the **honored** policy (from the blessed baseline) before the class allowlist, and every policy-driven auto-accept logs `policy: appends|all` in the acceptance log beside the class-driven records.
  substantiated 2026-08-18 (#135): eligibility.ts's policy branch precedes the allowlist
  gate; wiring.ts passes autoAcceptPolicyOf(baseline.content) and forwards result.policy
  into autoAcceptRecord; governance-protected-policy.test.mjs pins the branch and the
  record's policy field.

## docs/agent-writes.md

- The guard monkeypatch (`server.ts`) already wraps every *mutating* registration in one `runMutation`, and the write queue is non-reentrant (a queued closure that enqueues again would deadlock behind itself).
- **Stamping never writes acceptance.** It defaults `acceptance-status: proposed`, never mints or elevates to `accepted`, and preserves an existing on-disk `acceptance-status` **verbatim** (including a human-granted `accepted` — changing it would destroy the human's decision).
- It is the third [kernel argument](kernel-v0.md#kernel-arguments) (`KERNEL_ARG_KEYS = ["if_rev", "idempotency_key", "intent"]`), declared on **every mutating registration** via `withKernelArgs` and **peeled by the guarded wrapper before any handler runs** (`packages/plugin/src/mcp/guarded.ts`).
- **Journal-only.** It is recorded verbatim on the journal record beside `op`/`actor` (`JournalRecord.intent`, `packages/plugin/src/kernel/journal.ts`) and **never reaches note content** — it is peeled before the handler, so it structurally cannot be written into a note's frontmatter or body.
- **Never an accept or idempotency signal.** It is **excluded from idempotency identity** — a retried call may reword its intent freely and still dedupe — and it is **never read back** as any kind of acceptance or approval signal.
- **Batch-aware.** `obsidian_write_notes` accepts a batch-level `intent` describing the change-*set*; the guarded single-writer peels it per item, so **every** item's journal record carries it and the Acceptance pane's per-note rows each show it.
- **It exposes data the governance module published — nothing more.** The folded governance module (`src/governance/wiring.ts`) rewrites a read-only index at `<plugin-dir>/governance/pending-index.json` — beside the acceptance log — on every review-queue refresh (`refresh()`, via the pure serializer in `kernel/governance/pending-index.ts`); this tool reads it.
  approved 2026-08-19 (#261): substantiated by the publisher wired in `refresh()`
  (wiring.ts writes `serializePendingIndex` bytes to `pendingIndexPath` on every queue
  recompute) and the pending-review round-trip tests; the retired stewardship path is dead
  since #164 and no longer read.
- `readOnlyHint: true`, empty input schema, no write and no accept/baseline verb: it reports pending-ness; it cannot accept ("the accept verb is in no API").
- **Allowlist-filtered.** The index is written from the whole vault, so every returned entry is filtered through the **same `isVisible` guard** the uid/read tools use, *before* it is reported — a sandboxed session that could learn about pending notes in territory it cannot read would have a path oracle otherwise.

## docs/acceptance-model.md (#261 additions)

- **The sweep is event-driven, not timer-only (#261).** Live diagnosis showed Chromium suspends renderer timers while the Obsidian window is occluded — the 2.5s journal poll simply never ticked during unattended sessions, which is exactly when agents write (the observed "zero auto-accept records ever").
  approved 2026-08-19 (#261): the "never ticked" is a live observation (armed interval, grown journal, zero ticks over minutes with the window occluded), recorded in the PR's live-verification log — a diagnosis statement, not a security guarantee.
- The kernel now nudges the governance poll after **every journal append** (`nudgeGovernanceQueue`, wired in `main.ts`), so queue refresh + sweep run within seconds of an agent write even with the window buried; the interval remains as foreground catch-up.
  approved 2026-08-19 (#261): substantiated by the main.ts append wrapper + the
  governance-module source pins ("main.ts nudges the governance queue after every journal
  append") and the live nudge run (write → refresh + sweep in ~4s, window occluded).

## docs/conformance.md

- An explicit `--baseline=` fixture path is always allowed; the guard flips once the port set is complete and the cutover rebaseline is reviewed.
- Frontmatter is a `generated`/`generator` derivation stamp, never an acceptance field (accept-guard-checked before every write).
  substantiated 2026-08-17: `renderDebtRegister` emits a fixed two-key frontmatter block
  (nothing from the sidecar reaches frontmatter), and BOTH write paths —
  `obsidian_conformance_debt_render` (tools-conformance-debt.ts) and the CLI's
  `renderRegisterTo` (conformance/cli.ts) — call `registerAcceptRefusal` (the shared
  `parseGuardFrontmatter` + `acceptForbiddenReason` predicate) over the rendered text
  before writing; pinned by tests/conformance-debt-register.test.mjs.

## docs/identity-and-links.md

- It binds at the **same single interception point** as the accept guard and the write queue (`packages/plugin/src/mcp/guarded.ts`), so handlers never see a uid reference — they get the resolved path.

## docs/kernel-v0.md

- Every mutating operation appends **one JSONL line** to `.obsidian/plugins/governor/journal/YYYY-MM.jsonl` (rolled monthly, inside the plugin's own folder, not the note tree).
- A failed journal write is logged to console and dropped; it never fails the vault operation.
- Claiming and releasing are treated as **mutating** (journaled with `target.ref = scope:<prefix>` / `lock:<id>`), so **read-only mode blocks claiming and releasing** — there is nothing for a claim to disclose in a session that cannot write.
- Every journal record's `actor.server` carries a persistent **install id** — minted once and kept beside the journal in `.obsidian/plugins/governor/install-id.json` (`packages/plugin/src/kernel/install-id.js`) — plus the **vault name** and plugin **version**.
- They are declared generically on **every mutating registration** (`withKernelArgs` in `packages/plugin/src/mcp/guarded.ts`) and consumed generically (stripped from args and passed to `Kernel.runMutation`).

## docs/module-system.md (formerly docs/modules.md — renamed 2026-08-23; spans match by text, headings are organizational)

- Because the registrar it forwards to is the **guard-patched `server.registerTool`**, every module tool lands at the **same interception point** as every hand-registered tool — guarded, queued, journaled, kernel-args-declared, Code Mode captured — with **no module-specific bypass possible**.
- The enforcement lives in the mount's gate (a bare `registerAll` with no gate would allow mutating tools) — but the sole `registerAll` caller is `mountModules`, which always passes it, and the guard-patched `registerTool` is the backstop underneath.
- There is **no `kernel`, no raw server, no `registerTool`, no baseline/accept primitive**. (The `ModuleHostCtx` *type* permits optional `kernel?`/`sources?` for future use, but the mount populates neither.) The only registrar a module holds is the wrapped `scoped` registrar, which runs the forbidden-name + collision + read-only checks before forwarding — a module cannot walk it to a raw `registerTool` or to any write/accept surface.
- Every mounted handler's own context carries only read-only closures; no mounted handler can reach a write, accept, or baseline surface.

## docs/reference.md

- Every mutating operation also appends **one JSONL line** to `.obsidian/plugins/governor/journal/YYYY-MM.jsonl` (rolled monthly, inside the plugin's own folder rather than the note tree):
- If a journal write fails it is logged to the console and dropped; it never fails the vault operation.
- Safety guards that apply: read-only mode always applies (mutating external tools are blocked when read-only is on); the path allowlist scopes arguments under recognized path keys (path, from, to, paths, and a few others) — when an allowlist is active, mutating external tools whose args carry no recognized path key are blocked outright, since Governor cannot scope the call.
- `readOnly: true` on a published tool is an assertion by a third-party plugin about code Governor cannot inspect — and believing it exempts that tool from the write queue, the journal, the path allowlist, the kernel arguments, and read-only mode, all at once.

## docs/reference.md (#264 record immutability)

Reviewed at authoring time (#264). Both claims are substantiated by
`tests/record-immutable.test.mjs`: the per-op refusal sweep (write / patch /
frontmatter / move / trash / delete / append_at_heading), the
destination-is-a-record multi-path pin, the journaled-refusal pin, and the
fail-open pins (undefined flag, throwing probe, probe without `record`).
Scope note: "every mutating operation that names one" is scoped to the
kernel (the plugin's guarded path) and to operations that NAME the path —
the surrounding paragraph carries the fail-open qualifier, and writes that
bypass the MCP server entirely are out of scope by the stated threat model.

- The kernel refuses **every mutating operation that names one** (write, patch, frontmatter edit, move, trash, delete — and a move whose *destination* is a record, which would overwrite it) with `Error [record_immutable]: …` before the handler runs, journaled like any other refused operation.
- The check runs at the front of the write queue (same point as `if_rev`), reads the flag from Obsidian's already-parsed metadata cache, and **fails open**: a missing file, an unparsed cache, or an unreadable frontmatter never refuses anything — this guard is protective, and an unreadable note must not turn into a vault-wide write outage.

## docs/triage.md

Reviewed at authoring time (#221 phase 2), re-reviewed for the phase-3
rewrite (#241). Each claim is substantiated by
`tests/triage-module.test.mjs`: the all-agent built-in table + empty
gesture-gated set, the merged-table collision/enum pins (no accept-shaped
id, a raw command id is not a disposition), the acceptance-patch
refuse-at-validation + sanitize/drop-at-coercion pins (config patches AND
declared-row patches) with the handler's accept-forbidden re-check belt,
the destination_occupied / out_of_allowlist / move_denied refusals (dry-run
included, apply re-check proven), and — for the move-primitive claim — the
shared `moveOne` seam pinned by `tests/link-healing.test.mjs`'s source scan.

- The **authority axis** sorts every verb with one rule: a disposition that **confers standing** (accept, adopt, revert-of-standing) is a human gesture — never an API; a disposition that is an ordinary reversible write is agent-expressible through the guarded path.
- Declared rows are *not* runtime additions to that table: they are **configuration** the planner interprets — human-only-mutable data whose authority answer is uniform (every declared row is exercised by an agent through the one guarded `triage_dispose` tool; none confers standing).
- A patch carrying an acceptance field is refused at validation AND sanitized/dropped at coercion — it can never reach a note.
- Moves ride the shared link-healing move primitive (`moveOne` — `fileManager.renameFile`, parents created, **never an overwrite**: `destination_occupied`); trash is Obsidian's trash; frontmatter transitions go through `processFrontMatter` with the shared accept-forbidden rule re-checked over every effective patch.


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
  currently introduce acceptance without the guard seeing it. (#153, the CLI escape-
  reconstruction gap, is NARROWED but still open — the content path now decides over a
  bracketed reading set, but the binary's true escape vocabulary is unobserved and a residual
  remains, tracked in #153.)
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

## Imported documentation corpus (2026-08-23) — tracked, not approved-as-true, PENDING OPERATOR REVIEW

The 2026-08-23 documentation migration (PR #340, executed on the operator's
go) landed the target-state corpus, importing 48 flagged spans at once. Per
this file's own rule, an entry means a HUMAN reviewed the sentence — so be
explicit about what these entries are instead: they were classified by the
migration session (agent), each with its evidence note below, and they are
tracked here so the check tells the truth rather than being widened or
bypassed. NONE is approved-as-true by a human yet. The operator's
span-by-span review pass is the named follow-up: promote entries whose note
says "substantiated" (after checking the named pins), and leave the
gate-tracked ones here until their gate ships. The corpus-level honesty
anchor for every target-state claim is docs/status-and-compatibility.md
§ Current release state.

- An agent may accept a bounded delegation, but acceptance and admission remain outside every agent surface.
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. The acceptance/admission-outside-agent-surface half is substantiated by the perimeter suites. [docs/README.md:51]
- portable standing begins prospectively; legacy acceptance imports as evidence, never fabricated signed authority;
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. The no-fabrication half is substantiated by WP8's import pins (no authority fields on evidence records). [docs/architecture.md:54]
- It cannot register a capability around the guard.
  tracked by: substantiated as of 0.17.0 — module host + guard interception-point suites (modules-mount refuses non-read-only registrations; the guard wraps every registration). Promotion to an approved section is the operator's call. [docs/architecture.md:91]
- The accepted family is a structural floor enforced at the shared write primitive and at every exceptional transport that can write content.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/architecture.md:231]
- Mutating optional modules cannot receive a raw accept, admit, signer, mandate-activation, baseline, or standing-ref primitive.
  tracked by: substantiated as of 0.17.0 — no signer/mandate/standing-ref primitive exists to hand out, and the module host's registerAll gate refuses mutating registrations (pinned by its own suite). Promotion is the operator's call. [docs/architecture.md:264]
- They cannot weaken human acceptance or Governor-only admission.
  tracked by: substantiated as of 0.17.0 — perimeter suites (accept human-only; admission gesture-gated). Promotion is the operator's call. [docs/architecture.md:274]
- An agent cannot accept a result, activate or widen a mandate, choose an authoritative actor or signer, sign as the human, admit, revoke human authority, or advance a standing ref.
  tracked by: substantiated for what ships (admission gesture-gated, one-shot refs; accept human-only); mandate/signing verbs do not exist yet (Gates 2–3), so those clauses are vacuously true today. Promotion is the operator's call. [docs/coding-agent-development-guide.md:73]
- Sampling may supplement an audit but never establishes standing.
  tracked by: substantiated as of 0.17.0 — WP7 exact-and-total coverage pins (a failed or unevaluated item fails the cohort; sampling has no code path to standing). Promotion is the operator's call. [docs/coding-agent-development-guide.md:77]
- Private signing keys never enter notes, Git, journals, ordinary settings, release artifacts, or Sync.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/coding-agent-development-guide.md:81]
- | `packages/plugin/src/mcp/guarded.ts` and other surface registration | Action registry plus surface bindings | Inventory both directions, bind every surface to a versioned action, and make raw handler reachability a build failure |
  tracked by: work-package directive (WP0/WP10 territory), not a shipped claim — the guide speaks in imperatives to its implementer. [docs/coding-agent-development-guide.md:111]
- | `kernel/governance/auto-accept/*` | Transformation registry, verifiers, and mandate policy | Reassess every class; no legacy entry receives automatic authority merely because it was previously allowlisted |
  tracked by: work-package directive (WP9 territory), not a shipped claim. [docs/coding-agent-development-guide.md:119]
- Never write note bodies to the audit journal.
  tracked by: substantiated as of 0.17.0 — kernel digestArgs pins (bodies collapse to `<N chars>`; journal suites). Promotion is the operator's call. [docs/data-flow.md:195]
- Treat every existing accepted property as standing** — lowest migration effort; vulnerable to stale, malformed, or agent-written properties and false provenance.
  tracked by: REJECTED-ALTERNATIVE text inside D04 — the register describing the option it declines, not a product claim. [docs/design-decision-register.md:225]
- A checkpoint may summarize prior segments but cannot erase revocation or provenance meaning.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/design-decision-register.md:258]
- Configuration can extend protected properties but cannot redefine the accepted-family floor.
  tracked by: substantiated as of 0.17.0 — ACCEPT_FORBIDDEN is a fixed set; protected-properties config extends, never replaces (pinned). Promotion is the operator's call. [docs/developer-guide.md:113]
- Cohorts use canonical manifests and exact digests; mutable queries never become acceptance subjects.
  tracked by: substantiated as of 0.17.0 — WP7a freeze pins (immutable exact manifests; a drifted cohort refuses). Promotion is the operator's call. [docs/developer-guide.md:131]
- The target suite retains these because they support durable principles, not because every existing default or document is accepted unchanged.
  tracked by: meta-statement about the documentation itself, not a runtime security claim. [docs/documentation-basis.md:104]
- The assistant cannot press Accept, admit the result, or forge the records that represent standing.
  tracked by: substantiated as of 0.17.0 for the shipped surface (no agent-reachable accept; admission gesture-gated; claims carry no caller-forgeable verification) — the page's surrounding walkthrough is target-state, see its banner. [docs/getting-started.md:150]
- Git author and committer strings are never treated as authentication or acceptance.
  tracked by: substantiated as of 0.17.0 — nothing reads commit author strings for authority; admission binds gate-minted gestureRefs (D08 suites). Promotion is the operator's call. [docs/git-and-sync.md:25]
- never auto-accepts a merged conflict;
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. No merge path exists in 0.17.0, so the claim is vacuously true today. [docs/git-and-sync.md:125]
- Every path-taking operation accepts vault-relative paths and may accept registered stable or scheme addresses.
  tracked by: substantiated as of 0.17.0 — uid:/jd: addressing binds at the shared interception point (mapPaths suites). Promotion is the operator's call. [docs/operation-contract.md:62]
- A session, collection, folder, or query may select items, but cannot remain the mutable subject of an acceptance.
  tracked by: substantiated as of 0.17.0 — WP7a freeze pins. Promotion is the operator's call. [docs/operation-contract.md:178]
- The accepted family and Governor authority state are always protected.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/operation-contract.md:213]
- The guard does not cover direct disk writes or every discovered side effect.
  tracked by: an honest-limits claim (states what the guard does NOT cover) — consistent with the shipped repoint-containment and record-immutability boundaries. [docs/operation-contract.md:221]
- Journal status never substitutes for live verification.
  tracked by: substantiated as of 0.17.0 — verification runs at admission; degraded receipts say what was not written. Promotion is the operator's call. [docs/receipts-and-errors.md:147]
- It cannot accept or admit its own work, enlarge its mandate, or choose the evidence that makes an out-of-policy result authoritative.
  tracked by: substantiated for what ships (accept human-only; admit gesture-gated; service-run verification); mandate clauses are Gate 2. See also the residual-tracked entries above. [docs/review-and-safety.md:7]
- Acceptance is always a human authority act.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/review-and-safety.md:9]
- Configuration may extend the protected set but cannot weaken the acceptance floor.
  tracked by: substantiated as of 0.17.0 — same floor pin as docs/developer-guide.md:113. Promotion is the operator's call. [docs/review-and-safety.md:172]
- An agent cannot interpret continued conversation, silence, or prior approval as acceptance of a changed mandate.
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/sessions-mandates-and-cohorts.md:72]
- An agent never accepts its own work.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/sessions-mandates-and-cohorts.md:135]
- “Accept all” never means future work and never means every pending item in an evolving query.
  tracked by: substantiated in kernel terms as of 0.17.0 (cohorts freeze to exact manifests; a changed member refuses) — the session-accept UI framing is target-state (Gate 2). [docs/sessions-mandates-and-cohorts.md:153]
- | Takes effect | After a human accepts the mandate; never retroactively |
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/settings.md:205]
- | Acceptance | On in target product | Human sessions, cohorts, mandates, admission, and history | Review, Git, verifier, and attestation services | Return to proposal-only operation; never expose agent admission |
  tracked by: target-product settings table — the row describes the target module layout, labeled by the page's own 'target product' column. [docs/settings.md:281]
- A journal-write failure never turns a completed vault mutation into a failure response.
  tracked by: substantiated as of 0.17.0 — journal failures are swallowed and never fail the vault operation (kernel suites). Promotion is the operator's call. [docs/settings.md:303]
- A later checkpoint may summarize earlier segments but cannot erase revocation or provenance meaning.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/standing-and-attestations.md:216]
- Each authorized device or verifier role has its own private signing key in operating-system protected secret storage; private keys never enter notes, Git, journals, ordinary settings, or Obsidian Sync.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/standing-and-attestations.md:220]
- | Human review, cohorts, mandates, and acceptance | Public default in-app surface | Acceptance never exposed to agents; prospective authority remains exact and bounded |
  tracked by: a row of the page's own TARGET-STATE product matrix, labeled as such by the table it sits in. [docs/status-and-compatibility.md:40]
- Every module surface binds a registered action through the shared operation executor; no module receives raw accept or baseline authority.
  tracked by: a contradiction-register resolution describing target architecture, labeled 'Resolved in target architecture' in place. [docs/status-and-compatibility.md:141]
- **Earlier target claim:** Every proposal required a contemporaneous individual human acceptance gesture.
  tracked by: HISTORICAL quote inside contradiction C-007 — the register quoting the earlier claim it corrects. [docs/status-and-compatibility.md:147]
- **Controls:** opaque command and code execution absent from the public surface; dynamic templates fail closed where output cannot be inspected; private packs require separate enablement and audit.
  tracked by: mixed shipped/target controls list — the shipped subset (no public code execution, allowlists, read-only default) is substantiated; verifier/mandate clauses are Gates 2–3. [docs/threat-model.md:153]
- | Acceptance and protected-property floor | Fail closed: refuse the write when honored bytes cannot be inspected |
  tracked by: the accept-guard's fail-closed posture ships (unreadable bytes refuse); the row's full mitigation table is target-labeled. [docs/threat-model.md:257]
- You accept the final mandate in Obsidian; the agent cannot broaden it later.
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/user-guide.md:103]
- “Accept this session” always freezes and displays the exact current items.
  tracked by: the freeze semantics are substantiated (WP7a/WP7b pins: exact manifests, drift refuses); the session-accept UI is target-state (Gate 2). [docs/user-guide.md:134]
- It never accepts future session work. “Accept this collection” means the exact cohort currently selected from the collection, not every note that may later enter it.
  tracked by: the freeze semantics are substantiated (WP7a/WP7b pins: exact manifests, drift refuses); the session-accept UI is target-state (Gate 2). [docs/user-guide.md:134]
- **Cohort** — Governor verifies every item and you accept the frozen set once.
  tracked by: substantiated as of 0.17.0 — WP7b cohort admission (service verifies every item; one gesture, one claim; pinned). Promotion is the operator's call. [docs/user-guide.md:167]
- It cannot accept its own proposal, expand its mandate, choose its authoritative identity, or manufacture standing.
  tracked by: the accept/admit/standing clauses are substantiated (perimeter + one-shot gestureRef pins); mandate/identity clauses are Gates 2–3. [README.md:48]
- **Acceptance is always a human authority act.** You may exercise it over one result, one frozen cohort, or prospectively through a bounded mandate.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. The cohort half ships (WP7b); the prospective-mandate half is Gate 2. [README.md:50]
- Governor cannot determine whether a judgment-bearing edit is substantively correct; it can make the edit legible and keep acceptance human.
  tracked by: an honest-limits claim — states what Governor cannot do; no implementation could falsify it in the dangerous direction. [README.md:166]
