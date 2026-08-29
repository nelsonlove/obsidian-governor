# The suite split — core host, governance provider, satellite modules

> [!note] ADOPTED by Nelson 2026-08-25 ("looks good", after reading in full) — S2/S3 gated on an independent fresh-context perimeter review (lane consolidated 2026-08-25; governor-lead retired)
> §10's decisions: (1) repo name `obsidian-mcp-suite` — decided; (2) adoption — given; (3) satellite release posture — per recommendation (private-tier satellites unreleased until independently needed) absent a contrary ruling. The register updates in §8 are Nelson's rulings, recorded by this adoption. The S1 package may begin; S2/S3 (the seam and the split) additionally require an independent fresh-context perimeter review of §3/§5 (the reviewer-separation discipline survives the lane consolidation of 2026-08-25, under which governor-lead retired and the release + perimeter-review lanes consolidated onto the sole remaining agent). [Status and compatibility](status-and-compatibility.md#current-release-state) remains the single owner of shipped truth throughout the split.

## 0. Threat model — who this protects against, and who it does not

**Ruled by Nelson, 2026-08-27, after asking the right question of every perimeter finding: what has to be true in the real world for this to happen?**

**What the suite protects against: MISTAKES.** Agents write the wrong thing, write too much, or write confidently while wrong. A human wants to see changes before they count, and an honest record of what happened. That is the product need, and it is met by proposals, the Admit gesture, the journal, and the review pane — none of which is anti-adversary machinery.

**What it does NOT protect against, deliberately: hostile code already running inside Obsidian.** Every forged-proposal / laundered-session class of attack shares one precondition — arbitrary JavaScript executing in the renderer (a compromised community plugin, a bad update, a hostile js-engine/DataviewJS/execute-code block). At that point the attacker can already read the whole vault and write anything through `app.vault`. The marginal thing forging buys is making a bad change look APPROVED, which matters only where the audit trail is evidence against an adversary. In a single-operator vault running its own agents, that is insurance against something that is not happening.

**What would change the answer:** shipping to users who install untrusted plugins beside this one, or any deployment where the standing chain is evidence in a dispute. **The full adversarial design — the nine perimeter conditions in their strong form — is preserved verbatim on the branch `reference/hostile-threat-model` (at `921f72e`)**, so that decision can be reversed by reading rather than re-deriving.

**The filter this licenses:** a perimeter condition survives into the build if it is (a) cheap, (b) a correctness fix independent of malice, or (c) protection against an agent MISTAKE. It defers to the reference branch if a hostile local actor is its only justification.

## 1. Why

The consolidation era served its purpose: scattered work across many repos became one codebase with one test suite, one review discipline, and one perimeter. It also produced a plugin that is arcane and amorphous — an MCP host, a write kernel, a governance system, and roughly a dozen capability modules in one bundle, where the boundaries the decision register already ruled (D07's public-core / public-optional / private-operator tiers) exist only as settings flags.

The direction (Nelson, 2026-08-25): separate the codebase into a suite — the MCP host as the core, other modules as plugins that publish their tools to it, and **governance itself as an optional provider that plugs in**. The publishing mechanism for this already ships (`vault-mcp-api`); this document designs the rest.

## 2. The target shape

```text
one monorepo (renamed; see §4)
├── packages/core            @vault-mcp/core — shared guard/recognizer lib (exists)
├── packages/vault-mcp-api   the publishing SDK, npm: vault-mcp-api (exists)
├── packages/host            THE CORE plugin, id `vault-mcp`
│     transport (socket+bridge), guard (read-only, allowlist), kernel v0
│     (queue, journal, idempotency, locks, uid index, record guard),
│     operation executor + action registry, core obsidian tools,
│     module host, external-tool registry, THE GOVERNANCE SEAM (§5)
├── packages/governor        THE GOVERNANCE PROVIDER plugin, id `governor`
│     everything under kernel/governance + src/governance today:
│     proposals, verification, admission, cohorts, mandates,
│     transformations/promotion, history store, sessions, observations,
│     migration/cutover/binding, the review pane, the gesture perimeter
└── packages/<satellite>…    one plugin per extracted module (§6)
```

Three roles, three trust postures:

- **The host** is the honest standalone product: audited, journaled, allowlist-scoped vault access over MCP. Safe by default with nothing else installed.
- **The governance provider** is the flagship consumer of the seam. All authority — the pane, the gesture gate, the standing chain, mandates, promotion — is born and dies inside it, closure-held, exactly as today. Installing it turns "audited access" into "governed access".
- **Satellites** are capability packs (JD scheme, vocabulary, skills compiler, …) publishing tools through `vault-mcp-api` like any third-party plugin, with no special standing.

## 3. Why the optional governance provider is doctrine-clean

The §9 reachability invariant says accept-class capabilities must never be reachable from `app`. The split survives it because **authority never crosses the seam** — only two classes of thing do, and each is safe in its direction:

- **Candidates flow outward.** The host tells the provider "a write completed; here are the exact base and proposed bytes." The provider turns that into a proposal. A proposal confers nothing (the #221 axis: agents and machinery supply candidates; humans decide).
- **Vetoes flow inward.** The provider registers refuse-this-write checks (the accept-forbidden transition guard, the legacy-writer guard). A veto can only make the host refuse MORE. Fail closed by construction.

The seam's **registration function** is necessarily reachable from `app` — registration happens through the host plugin's API object, and that is harmless. **The registered CLOSURES must not be** (independent perimeter review, 2026-08-27, finding 1): the §3 argument above proves the safety of the two hook CLASSES and does not, by itself, prove the safety of the hook REGISTRY. A reachable observer is the thing that manufactures proposals — call it directly with forged facts and you get an internally-consistent proposal in the automatic-admission path, which is strictly more than the `app.vault` equivalence covers (writing bytes through `app.vault` produces a loud queue entry; a forged admission SILENCES the queue). The accept perimeter already owns the correct pattern — `governor/wiring/wiring.ts` holds its guards and stores in module-private WeakMaps keyed by the plugin instance — and the seam's hook lists MUST use it. (Same review: `main.ts`'s `private externalRegistry` is compile-time-private only, so third-party handlers are reachable from `app` today; fixing that rides with S2.)

What the seam must NEVER offer is the third hook class: anything that can **mutate a write in flight or assert acceptance**. Observe or refuse — nothing else. Rule 6 (§5) generalizes it: the seam accepts registrations that can only ADD A REFUSAL, never a predicate the host consults for permission.

## 4. Names and identities

- **The monorepo** renames away from `obsidian-governor` — "governor" now means the governance provider, not the whole. **Chosen: `obsidian-mcp-suite`** (Nelson, 2026-08-25). Verified clean at choosing time: no GitHub repo of that name anywhere, npm free, no community-registry collision — and `-suite` is an established plugin-family naming pattern there. (`obsidian-vault-mcp` was considered and rejected: three same-name neighbors including a community-directory plugin repo, plus an existing "Vault MCP" org brand in the exact niche.)
- **The host plugin id** returns to **`vault-mcp`**. The 0.12.0 id-migration machinery (`id-migration.ts`, `migrateLegacyModuleIds`) exists and runs the reverse direction with the same care: folder migration, settings adoption, discovery grace period, bridge dual-id lookup (the SDK already resolves both ids).
- **The governance provider plugin id** is **`governor`** — the name finally names the thing.
- **npm names do not change** (`vault-mcp-api`, `@vault-mcp/core`): published contracts keep their identities, per the standing naming rulings.
- **Live-vault cost, stated:** one id migration on the operator's install (folder + settings + re-register), using shipped machinery. The governance state (`governance/` dir, cutover marker, store binding, history dir slug) must migrate with its OWNING plugin — the migration plan in the S3 package names every file and where it lands, and the chain backup covers the transition.

## 5. The seam — the host's governance hook API

An `apiVersion: 2` extension of the existing external-tool API. Exact shape (names bikesheddable; classes are not):

```ts
interface WriteFacts {
  path: string;
  baseBytes: Uint8Array | null;      // null = creation
  proposedBytes: Uint8Array;
  operation: { id: string; action: string; actionVersion: number; sessionId: string | null };
  actor: JournalActor;                // the journal's own attribution, verbatim
}

interface GovernanceSeam {
  /** Pre-write, refuse-only. A typed refusal aborts the write; null lets it pass. Throwing = refusal (fail closed). */
  registerWriteVeto(id: string, veto: (facts: WriteFacts) => { code: string; detail: string } | null): void;
  /** Post-write, observe-only. Return value ignored; throwing is logged and swallowed — an observer must never cost the caller their result. */
  registerWriteObserver(id: string, observe: (facts: WriteFacts) => void | Promise<void>): void;
  /** Session liveness consultation (the provider owns sessions/mandates; the host asks). Absent provider = no constraint. */
  registerSessionGate?(id: string, gate: (sessionId: string) => Promise<{ live: boolean; detail?: string }>): void;
}
```

Rules, each to be pinned:

1. **No mutation hooks.** The seam's TypeScript surface has no method whose return value the host writes; a source scan pins that the host never reads a hook's return except the veto's refusal.
2. **Vetoes fail closed; observers fail open.** A throwing veto refuses; a throwing observer logs once and the write stands (facts about a write must not cost the write — the promotion-recorder discipline).
3. **Observers run AFTER the journal record** — nothing the provider does can precede or suppress the host's own audit.
4. **The host works with zero hooks registered.** Every seam consultation is `for (const hook of hooks)` over a possibly-empty list — the standalone host is the vacuous case, not a special one.
5. **What moves across is bytes and identifiers, never capabilities.** `WriteFacts` carries no callback, no store handle, no app reference beyond what any plugin already has.

What the governance provider registers through it: the accept-forbidden transition veto, the legacy-writer veto (pre-cutover), the record of write facts that today rides the in-tree `propose` hook (WP6b) — becoming an observer that produces proposals inside the provider. The producer's mandate stamping, budget charging, and everything downstream are provider-internal and unchanged.

### Amendments from the independent perimeter review (2026-08-27) — S2's acceptance criteria

The review returned **APPROVED WITH CONDITIONS**: the direction and the two-class framing are sound, but §5 as first written is not buildable as perimeter without these. Each is testable, and S2 ships only with its pins.

**Shape changes to the API above:**

- **`registerSessionGate` is refusal-shaped, not boolean.** As specced it returned `{live: boolean}` — an ANSWER, and `live: true` is an ALLOW, so a hostile registrant could un-refuse a revoked session and launder a write through the host's own guarded, journaled path. It now returns `{code, detail} | null` exactly like the veto, so the type cannot express an allow. (This is why rule 6 exists: `setLegacyWriteGuard` is a permission-shaped predicate today and is safe ONLY because it is unreachable from `app`; moving that shape onto an app-walkable API would destroy the protection that makes it safe.)
- **Every `register*` returns a disposer, and the disposer is the ONLY revocation.** §5 had no unregistration story at all, which cannot ship (plugins unload constantly; a stale veto holding a dead provider's stores is worse than none). No id-addressed `unregisterHook(id)` — the existing `unregisterTools(ownerPluginId)` is forgeable by any caller today and must be fixed the same way. The `id` argument stays as diagnostic labelling, not an address.
- **`WriteFacts` is a per-hook defensive copy** — bytes copied, `operation`/`actor` deep-frozen. Rule 1 pinned only that the host ignores return VALUES; argument aliasing was the unclosed half (a veto handed the live buffer can mutate the bytes about to be written, or forge `actor.session` into the host's own journal).

**The nine conditions, retriaged against §0 (Nelson, 2026-08-27).** Six survive as cheap, correctness, or mistake-protection; three defer to `reference/hostile-threat-model`, where all nine keep their strong form.

**BUILD in S2:**

1. **[cheap]** Registered hooks unreachable from `app` (module-private WeakMaps), pinned by a runtime transitive walk plus a source tripwire; `main.ts`'s `externalRegistry` fixed in the same motion.
2. **[better design, not armor — a hook that can only say no is simpler to reason about]** No permission-shaped hook (rule 6), pinned as a source scan over the seam's declared return types; if any boolean survives, deny-wins unanimity with two-disagreeing-registrants tests.
3. **[CORRECTNESS — a missing disposer leaves stale callbacks on every plugin reload, and the forgeable `unregisterTools` lets any script unhook another plugin's tools, QuickAdd's included]** Disposer-only revocation, pinned: a caller holding the api object cannot revoke a hook it did not register.
4. Defensive-copy `WriteFacts`, pinned three ways (byte mutation, actor mutation, per-hook independence).
5. **[correctness]** Placement and hang budgets: vetoes and the gate run INSIDE the kernel's queued closure where `sessionLive` runs today, so `WRITE_TIMEOUT_MS` bounds them (a hanging veto is abandoned and the write refused — no new timeout machinery needed); observers are NOT awaited on the caller's result path (a hanging observer must not cost a write that already landed).
6. **[MISTAKE-protection — the condition that most earns its keep under §0]** Post-split, `governor` is just another plugin id, so `obsidian_plugin_toggle('governor', false)` becomes a one-call way for AN AGENT DOING CLEANUP to switch off the thing that reviews it. **Simplified build form:** the plugin-toggle and uninstall tools refuse a registered provider's id — the rule `tools-nav.ts:471` already applies to the host's own id. (The full latch, with persisted first-registration state and mutating tools refusing while a latched provider is absent, defends against DELIBERATE removal and lives on the reference branch.) Pin: the refusal, and that it names the provider.
7. **[RULED — Nelson, 2026-08-27: the HOST keeps minting]** Session ownership is settled: the host mints a session per connection exactly as it does today (`server.ts:131` — `openSession`, with the `scopeDigest` over that connection's read-only + allowlist state, closed on `Protocol.onclose`), because a session is transport state and the host is the only thing that knows a connection began. **`SessionV1` therefore becomes a published contract** (`@vault-mcp/core`), not provider-internal — §6's row moves accordingly. The provider's role is REFUSAL ONLY: it keeps its own revocation state and answers the seam's refusal-shaped session hook, so a human revoking a session in the review pane reaches the write path as a refusal at dequeue. The host never asks the provider for permission and never learns WHY a session was refused beyond the refusal's own detail string. Consequence to build: session-revocation UI and its durable record live in the provider; the host's session record stays what it is today (identifiers, scope digest, lifecycle), and the seam carries no connection-lifecycle notification — the provider does not need one, because it never mints.
8. Ship `registerWriteVeto` only with a real registrant and a round-trip test — §5/§6's two named registrants were both wrong on the code (the fuller transition guard is `acceptTransitionReason`, host-side in `@vault-mcp/core`; the legacy-writer guard is a provider-internal `BaselineStore` predicate that never touches the seam). At a perimeter, YAGNI is a safety property.
9. **[layering]** Layering: move `wiring/mount-state.ts` host-side (the host uses it for the scheme panes too); split the generic disposition-descriptor shape into `@vault-mcp/core` (the provider currently type-imports a future SATELLITE); publish `canonical-json` and `digest` as contracts; and rule on observations (host-side capture with territories as host config, or a capture hook).

   **[RULED at S3, 2026-08-27 — host-side capture, and territories is a CONTRACT, not host config.]** Neither option as drafted survived contact with the code, so the ruling is three-part:

   - **The observation blob store goes to the HOST.** `governor/wiring/observations/local-store.ts` has exactly one consumer — `mcp/server.ts` — and it already imports host machinery to do its job (`kernel/observations/store.js`, `paths.js`). It was misfiled under `governor/`, not governance. Capture records what the host's own transport read, which is the same class of fact as the session scope digest the host already asserts about a connection. **No capture hook is built:** the seam gains no surface for a registrant that does not exist, per condition 8's YAGNI-at-a-perimeter principle.
   - **The provider keeps the observation REFERENCE, and never sees the store.** `governor/kernel/contracts/subject-v1.ts` and the admission/mandate policies reason over `{id, digest, capture}` triples — durability, ephemerality, what may support a proposal (D16). That is contract-level reasoning and stays provider-side. Confirmed by scan: no provider module imports the blob store.
   - **Guarded territories is published into `@vault-mcp/core`.** The drafted option "territories as host config" is **wrong on the evidence**: territories has three importers, and they land on *both* sides of the split — `main.ts` and `mcp/server.ts` (host) and `governor/wiring/wiring.ts` (provider, the review pane). Host-held config cannot serve a provider consumer, so the only alternative to publishing is two copies — which is precisely the failure `territories.ts`'s own header names: *"a prefix present in the pane's list but missing from capture's means the pane politely skips a folder while capture quietly writes its note bodies to disk."* On this operator's vault the guarded prefixes include `80-89` (legal/PII, standing rule that its contents do not leave it), so a drift here is a PII leak into capture blobs, not a tidiness problem. One list, two consumers, one published contract.

   Net: four boundary edges retire on this ruling alone (`server.ts`→observations, `server.ts`→territories, `main.ts`→territories, and `observations/local-store.ts`'s two back-edges leaving the governor tree entirely). Unchanged by this ruling: the hardcoded prefix list itself is still this vault's folder names, which issue #321 tracks promoting to real configuration — publishing the module does not fix that, and must not be mistaken for having fixed it.

**DEFERRED to `reference/hostile-threat-model`** — hostile local code is their only justification:

- **Condition 4's per-hook byte copies.** The cheap half survives (deep-freeze `operation` and `actor`, which also catches a BUGGY hook mutating shared state); copying every write's bytes per hook is a per-write cost paid against an actor §0 excludes.
- **Condition 8 as a perimeter rule.** `registerWriteVeto` still ships only when something needs it — for the ordinary reason that unused API surface is dead code, not as a safety property.
- **Condition 1's runtime transitive-walk test.** The WeakMap placement stays (free); walking `app` to prove no hook is reachable is adversary-shaped. The source tripwire suffices.

**S2's exit criterion is NOT the crossing count.** Of S1's 45 host→governor edges, 38 disappear only at S3 — when the code physically moves, not because a hook exists. S2 succeeds when the seam is proven sufficient for the hook-shaped crossings and the six rules have their pins; the concrete target is **`ServerCtx` naming zero provider types** (edges 34–38 of the review's disposition table) plus the `server.ts` propose block retired into the observer.

## 6. Module inventory — disposition of everything in the bundle today

| Module / area | D07 tier | Disposition | Notes |
|---|---|---|---|
| Socket transport + bridge | public core | **host** | unchanged |
| Guard (read-only, allowlist), kernel v0 (queue, journal, idempotency, locks, uid, record guard) | public core | **host** | unchanged; record-guard stays host-side (it guards `record: true` notes, not acceptance) |
| Operation executor + action registry + surface inventory | public core | **host** | the propose hook generalizes into the seam observer |
| Accepted-family frontmatter floor (`@vault-mcp/core` accept guard) | public core | **host keeps the floor**; provider registers the fuller transition veto | defense in depth: even a governance-less host refuses agents stamping `accepted` |
| Core obsidian tools (read/write/search/links/uid/scheme-addressing/locks/…) | public core / optional | **host** | unchanged |
| External-tool registry + `vault-mcp-api` | public core | **host** | gains apiVersion 2 (seam + capability discovery) |
| Proposals, verification, admission, cohorts, standing chain, resolver | public core (governed) | **governor provider** | perimeter internals unchanged |
| Mandates, transformations, promotion (WP9/WP10) | public core (governed) | **governor provider** | unchanged |
| Sessions + origins | governed | **split, per condition 7** — the host mints and owns the record; the provider owns revocation state and answers the seam's refusal hook | `SessionV1` is a published contract in `@vault-mcp/core`, not provider-internal |
| Observation capture (blob store) | governed → **reclassified public core** | **host**, per condition 9's S3 ruling | one consumer (`mcp/server.ts`), already built on host store + host paths; no capture hook is added |
| Observation *references* (`{id, digest, capture}`, durability rules, D16 ephemerality) | governed | **governor provider** | contract-level reasoning in `subject-v1.ts` + admission/mandate policy; the provider never sees the store |
| Guarded territories (`EXCLUDED_PREFIXES` / `isExcludedTerritory`) | **published contract** | **`@vault-mcp/core`** | three importers on BOTH sides; two copies would be a PII leak, not a style nit (see condition 9's ruling). Issue #321 still owns making the list configurable |
| History store + migration/cutover/binding | governed | **governor provider** | machine-local dirs (`~/.claude/governor/…`) stay with the provider; backups unchanged |
| Review pane, gesture perimeter, dispositions | governed | **governor provider** | the tripwire tests move with it |
| Legacy acceptance (baselines, queue, retired writers) | governed, retired-era | **governor provider** | rollback fidelity lives where the cutover lives |
| `obsidian_pending_review`, `governance_revisions`, `governance_submit_revision`, mandate draft/list | governed | **governor provider**, published via `vault-mcp-api` | dogfoods the publishing path; read-only claims trusted via the existing per-plugin trust list |
| Scheme / scope provider (JD) | public optional | **satellite** | read tools + the three write tools; write tools need the path-key convention (already satisfied) |
| Vocabulary provider | public optional | **satellite** | read-only |
| Conformance | public optional | **satellite** | read-only |
| Bases | public optional | **satellite** | read-only |
| Fileclass CLI proxy | public optional | **satellite** | already doubly-gated |
| Provenance (inspect + slot audit) | optional / private regen | **satellite** | formerly governor-lead's #257 lane; lane consolidated 2026-08-25 |
| Skills compiler | private operator | **satellite** | the biggest single extraction; least entangled |
| Cross-session | private operator | **satellite** | |
| Triage | private operator | **satellite** | |
| QuickAdd compile | private operator | **satellite** | |
| Apple-notes importer glue | private operator | **satellite** (or fold into an existing operator satellite) | |

Retirements: none proposed here — WP10c already did the era's retirement; the split moves code, it does not re-decide authority.

## 7. Extraction order — the work packages

Each package: one PR, tests move with their code, the full suite green at every step, the perimeter tripwires never leave the governance package, and status-and-compatibility gains a per-plugin release-state row as plugins gain independent releases.

- **S1 — rename and restructure, zero behavior change.** Repo rename; `packages/plugin` → `packages/host` + `packages/governor` as *directories* while still building ONE plugin artifact (imports moved, boundaries made visible, no runtime change). The point: make every later diff small and reviewable.
- **S2 — the seam, consumed in-tree.** Build the hook API in the host layer; the governance layer registers its vetoes/observers through it *while still compiled into one plugin*. Proves the seam's sufficiency with zero distribution risk. The seam's five rules get their pins here.
- **S3 — the actual split.** Two plugin artifacts; id migrations (`governor` → `vault-mcp` for the host; the provider takes `governor`); the governance-state migration map executes; the runbook gains the two-plugin install/upgrade story. This is the package with live-vault stakes — it lands with a rollback path and an independent release-readiness review.
- **S4…Sn — satellites, private tier first** (skills, cross-session, triage — the biggest "arcane" contributors, least entangled), then the optional tier (bases, vocab, conformance, scheme, fileclass, provenance). **Exception, executed (Nelson, 2026-08-26): QuickAdd choices extracted FIRST, ahead of S1 — the publishing API already ships, so the pilot satellite proves the path and surfaces apiVersion-2 gaps before the seam is designed.** First gap found: the external-tool contract cannot express a partial-result error envelope (structured data + isError) — an apiVersion-2 item. Each satellite dogfoods `vault-mcp-api` and shrinks the host.
- **Then: the Gate 2 evidence checkpoint** (§657–664), run on the split build — the architecture we intend to keep, per Nelson's sequencing ruling.

## 8. What does not change

The admission perimeter's internals and doctrine. The standing chain's format and location. The cutover state, the store binding, both backup repos. WP9/WP10 semantics. The register's D01–D18 substance — except the two entries the adoption ruling records:

- **D14 (reinterpreted):** Gate 3's "final public/private bundle split" is realized as the plugin suite split, resequenced ahead of the Gate 2 evidence checkpoint. (Nelson, 2026-08-25.)
- **D07 (realized):** the tier boundaries become plugin boundaries.

## 9. Risks and costs, named

- **The seam is new perimeter surface.** It is refuse-or-observe only, but it is the one place a design error could leak capability — hence S2's in-tree proving step and the independent perimeter review before S3.
- **Release multiplication.** One release lane becomes several manifests. The lockfile-regen gap already flagged in the release pipeline gets worse before it gets better; the S3 package must include per-plugin release tooling, not inherit the gap.
- **Id migration on the live vault** (§4). Shipped machinery, real click.
- **Test-suite split.** 4,000+ tests partition along package lines; the cross-package integration tests (seam round-trips, publish round-trips) are NEW tests S2/S3 must add, not inherited coverage.
- **Governance becomes removable (perimeter review finding 3).** Today `obsidian_plugin_toggle` refuses the host's own id for self-preservation, and disabling governance is impossible because it IS the host. Post-split, `governor` is just another plugin id — one agent-reachable call, or one `app.plugins.disablePlugin` from a renderer script, and the perimeter is gone, with the host unable to tell removal from never-installed (all governance state migrates to the provider per §4). Condition 6 answers it with a host-side latch. Named here because it is the split's biggest doctrinal cost and it was absent from the first draft of this list.
- **Docs corpus restructure.** The corpus stays one suite-level set with per-plugin ownership marked; status-and-compatibility grows a per-plugin table. A separate small package inside S3.
- **The master brake (governor-lead's post-#359 observation, carried here).** Today "stop all automatic admission" means revoking each mandate one at a time — and a human reaching for a brake under stress wants ONE control. The provider should grow a single gesture-gated "suspend automatic admission" switch: doctrine-clean because it only refuses MORE (a suspended state refuses the mandate door outright, mandates untouched, resumable by the same gesture class). Designed and built inside the provider during S2/S3, not bolted on after.

## 10. Open decisions (Nelson)

1. **The repo name.** DECIDED: `obsidian-mcp-suite` (see §4).
2. **Adopt this document** — which records the two register entries in §8 and green-lights S1.
3. **Satellite release posture:** released/versioned per satellite from day one, or private-tier satellites stay unreleased (installed from the monorepo build) until someone needs them independently? Recommendation: the latter — release ceremony only where there is an audience.
