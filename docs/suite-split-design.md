# The suite split — core host, governance provider, satellite modules

> [!note] ADOPTED by Nelson 2026-08-25 ("looks good", after reading in full) — S2/S3 gated on an independent fresh-context perimeter review (lane consolidated 2026-08-25; governor-lead retired)
> §10's decisions: (1) repo name `obsidian-mcp-suite` — decided; (2) adoption — given; (3) satellite release posture — per recommendation (private-tier satellites unreleased until independently needed) absent a contrary ruling. The register updates in §8 are Nelson's rulings, recorded by this adoption. The S1 package may begin; S2/S3 (the seam and the split) additionally require an independent fresh-context perimeter review of §3/§5 (the reviewer-separation discipline survives the lane consolidation of 2026-08-25, under which governor-lead retired and the release + perimeter-review lanes consolidated onto the sole remaining agent). [Status and compatibility](status-and-compatibility.md#current-release-state) remains the single owner of shipped truth throughout the split.

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

The seam itself is app-walkable (it must be — registration happens through the host plugin's API object). That is acceptable because registering a hook grants nothing new: a hostile renderer script that registers a veto can deny writes (annoying; fail-closed; already possible by monkey-patching `app.vault`), and one that registers an observer can read note bytes (renderer JS can already read the whole vault through `app.vault`). What the seam must NEVER offer is the third hook class: anything that can **mutate a write in flight or assert acceptance**. Observe or refuse — nothing else. That prohibition is a load-bearing design rule, to be pinned by test in the host the same way the module mount pins read-only-or-nothing today.

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
| Sessions + origins | governed | **governor provider** | the host consults liveness through the seam's session gate |
| Observations capture + history store + migration/cutover/binding | governed | **governor provider** | machine-local dirs (`~/.claude/governor/…`) stay with the provider; backups unchanged |
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
- **Docs corpus restructure.** The corpus stays one suite-level set with per-plugin ownership marked; status-and-compatibility grows a per-plugin table. A separate small package inside S3.
- **The master brake (governor-lead's post-#359 observation, carried here).** Today "stop all automatic admission" means revoking each mandate one at a time — and a human reaching for a brake under stress wants ONE control. The provider should grow a single gesture-gated "suspend automatic admission" switch: doctrine-clean because it only refuses MORE (a suspended state refuses the mandate door outright, mandates untouched, resumable by the same gesture class). Designed and built inside the provider during S2/S3, not bolted on after.

## 10. Open decisions (Nelson)

1. **The repo name.** DECIDED: `obsidian-mcp-suite` (see §4).
2. **Adopt this document** — which records the two register entries in §8 and green-lights S1.
3. **Satellite release posture:** released/versioned per satellite from day one, or private-tier satellites stay unreleased (installed from the monorepo build) until someone needs them independently? Recommendation: the latter — release ceremony only where there is an audience.
