# Status and compatibility

This is the authoritative status vocabulary for the documentation suite. It separates the proposed target-state product from evidence about the current repository and prevents historical design, source presence, runtime availability, and public eligibility from collapsing into one word: “supported.”

## Current release state

Installed release: **0.18.2 (2026-08-24)**. The release status must name the highest completed gate. Code presence is not deployment, migration closure, portability evidence, or Community readiness.

- **Highest completed gate: Gate 1** (work packages WP0–WP8), released as 0.17.0 and iterated through 0.18.2; each install verified byte-identical to the published asset. Shipped with implementation evidence: the action registry and shared operation executor, observation/effect capture, canonical subjects, the Git-backed history store, replica-local sessions, proposals with recorded base/result snapshots, deterministic verification run at admission, gesture-gated individual and cohort admission (one gesture, one claim — enforced at runtime), a stock-git-readable standing chain advanced by compare-and-swap, and the legacy evidence import with a human-confirmed cutover.
- **The authority cutover RAN on 2026-08-23** (the operator's confirmed click, per the [cutover runbook](../packages/plugin/docs/wp8-cutover-runbook.md)). The admission chain is now the sole standing authority; the [legacy acceptance system](acceptance-model.md)'s writers (accept, adopt-baseline, auto-accept) refuse with typed errors, and its records stay readable. 4,351 legacy records were imported as `legacy-import` evidence (2,287 baselines; 2,063 acceptance events, of which 238 human accepts, 1,559 silent advances, 265 rekeys, and 1 disposition; plus the pending-review index snapshot — the import preserves those distinctions; a silent advance is not an acceptance). The gesture-gated rollback control remains available. Observation capture remains default-off.
- **The cutover marker is BOUND to the machine that holds the chain** (the operator's gesture-gated bind click, 2026-08-24). The marker travels with the vault while the standing chain is machine-local, so an unbound marker on a restored or synced copy would have read “nothing admitted” — indistinguishable from truth at exactly the disaster-recovery moment. Post-binding, a vault copy without the chain reports “cut over elsewhere; chain absent here” and admission refuses there; restoring the chain backup restores the authorized identity. Binding is never automatic, and the bind control cannot re-bind a marker already bound elsewhere.
- **The standing chain has backup coverage** (issue #337, ruled 2026-08-23 and implemented in the vault backup job before the cutover click): the machine-local history store — including the store identity the marker names — is committed to its own backup repository on the same schedule as the vault, excluding observation replay payloads (an exclusion on size, not privacy grounds).
- **Known defect in 0.15.0–0.17.0 (fixed in 0.18.0): gesture-gated controls were silently inert in popout windows.** The gesture gate's realm-bound `instanceof` check refused genuinely trusted clicks delivered in a second window (settings popouts, popped-out review panes) with no feedback — a false negative; no forged input was admitted. The fix is a realm-safe platform-Event brand check, and blocked clicks now surface a Notice. On affected builds, use the main window.
- **Known defect in 0.18.0 (fixed in 0.18.1): the bind control could not perform its file io.** The store-identity io used a dynamic `node:` import that the Electron renderer blocks, so the bind click refused loudly with the marker untouched — fail-closed held, but the control could not succeed. 0.18.1 routes the io through the statically bundled module.
- **Known defect in 0.17.0–0.18.1 (fixed in 0.18.2): four legacy accept-class controls were still offered after the cutover.** The file-explorer context-menu Accept, the review pane's Proposed Accept, and the queue detail's Accept and Revert all remained rendered once legacy acceptance was retired. Choosing any of them refused correctly (`legacy_writer_disabled`) — no legacy write could land — but each was offered-and-failing, and the pane displayed its own "Accept … disabled" notice directly below the live buttons. 0.18.2 omits all four; request-changes is deliberately unaffected, because it records a request on a proposal and advances no baseline.
- **Gates 2+ are target state only.** Mandates, signing and portable attestations, Sync replica reconciliation, generated projections, and the Community submission remain specification, not shipped claims.

This section is the single owner of “what is shipped as of the named release”; a later release supersedes it by editing it here.

## Status labels

| Label | Meaning |
|---|---|
| Target public default | Promised by the coherent public product without widening write authority |
| Target public optional | Public product capability enabled deliberately by the user |
| Target private | Separate operator capability outside Community defaults |
| Excluded | Intentionally absent from the normal public agent surface |
| Current implementation evidence | Evidenced in the repository or supplied live tool map; not automatically a target guarantee |
| Proposed | Design material without completed release evidence |
| Deprecated | Still present temporarily with a replacement and retirement path |
| Retired | No longer active; retained as history or migration compatibility |

## Target-state product matrix

| Area | Target status | Compatibility rule |
|---|---|---|
| Action registry and universal operation kernel | Public core | Every invocation resolves one versioned action and follows the same lifecycle; surfaces do not own semantics |
| Durable observations and Governor-boundary playback | Public core; replay retention configurable | Substantive governed-session reads replayable by default; ephemeral observations cannot support proposals, verification, or admission |
| Search, read, links, properties, navigation | Public default | Scope-filtered; unavailable sources explicit |
| Health, history, diff, identity reports | Public default when supported | Host feature detected; no authority restoration |
| Create and pure append | Public optional | Explicit folder scope and write enablement |
| Bounded edit and structural move | Public optional | Preview, revision, verification, review, recovery |
| Human review, cohorts, mandates, and acceptance | Public default in-app surface | Acceptance never exposed to agents; prospective authority remains exact and bounded |
| Governor admission and standing | Public core | Governor-only transition requiring exact subject, verification, and human gesture or valid mandate |
| Git-backed history and proposals | Public core, local | Git database stays outside Obsidian Sync; author strings are not identity or authority |
| Signed attestations | Public core for local evidence; portable standing optional | Subject-bound; trusted keys and predicates; no note bodies in portable ledger |
| Obsidian Sync compatibility | Public core | File-level arrivals reconcile per replica; incomplete cohorts remain receiving |
| Bases evaluation | Public optional | Supported Obsidian Bases API and module available |
| Vocabulary, schemes, conformance | Public optional | Human configuration; report-first |
| Health, survey, Fileclass inspection, and provenance inspection/staleness | Public optional | Disabled until configured or supported; regeneration remains private |
| Skills/policy compilation, cross-session coordination, JD scaffolding, triage mutations, QuickAdd execution, provenance regeneration | Target private in the first release | Absent from the Community bundle; promotion requires a separate reviewed manifest change. Skills compilation now ships as the separate `vault-skills` satellite plugin, so its absence from the Community bundle is structural (a different plugin, simply not part of it) rather than a manifest decision on this plugin's part. Triage mutations now likewise ship as the separate `vault-triage` satellite plugin, so their absence from the Community bundle is likewise structural rather than a manifest decision. Cross-session coordination now likewise ships as the separate `vault-crosssession` satellite plugin, so its absence is likewise structural rather than a manifest decision |
| Generic command or arbitrary code | Excluded publicly | Private pack only, if separately governed |
| Plugin installation/removal | Excluded publicly | Human uses Obsidian's own plugin UI |
| Permanent delete | Excluded publicly | Recoverable trash only in public product |
| Outside-vault export and destructive import | Excluded publicly | Private pack with disclosure and recovery |
| Authority-restoring version restore | Excluded publicly | Human recovery surface only |

## Platform compatibility

Governor is desktop-only while it uses a local socket, Node.js, Electron, or other desktop APIs. The release manifest must set `isDesktopOnly: true`.

The minimum Obsidian version is the oldest version actually exercised by the release evidence. Do not copy an old floor forward after adopting a newer public API. [Testing and release](testing-and-release.md) owns the evidence; the manifest owns the released value.

## Dependency compatibility format

Each optional dependency records:

```yaml
dependency: Obsidian Bases
capability: bases.query
requiredVersion: release-tested range
installed: yes | no
enabled: yes | no
compatible: yes | no | unknown
runtimeHealth: available | temporarily-unavailable | degraded
lastSuccessfulUse: timestamp or none
reason: human-readable explanation
```

Installed, enabled, compatible, available, and last successful are separate facts.

## Target-state versus current repository

This suite deliberately describes a future coherent product. The existing repository contains many strong mechanisms but also documentation and release-state contradictions. Until implementation and release evidence are reconciled, use these rules:

- Target-state prose is a specification, not proof of shipping.
- Repository source and tests are implementation evidence, not automatic public guarantees.
- A served live capability is runtime evidence for that session, not proof of public eligibility.
- Historical and proposed synthesis notes retain their recorded status.
- The action registry, runtime handlers, surface bindings, generated capability projection, release manifest, bundle, and captured tests must agree before a target promise becomes a shipped claim.

## Contradictions register

### C-001 — Tool count

**Historical/current claims:** Existing documentation names several totals: roughly 55–60 tools, 71 base tools up to 84, and a supplied live tool map of 107 served tools.

**Resolution:** Public docs make no static tool-count promise. The action registry and capability projection generate a runtime directory by user outcome, distribution, availability, and risk. Release evidence may record a count for that exact build and profile, with its generation source.

**Status:** Resolved in target documentation; implementation must remove hand-maintained totals.

### C-002 — Version identity

**Historical/current claims:** Existing README/docs, plugin manifest, examples, and package metadata contain different version numbers, including 0.8.x, 0.12.0, and 0.13.0.

**Resolution:** One release check compares manifest, package metadata, version mapping, documentation status, tag, and release assets. User docs avoid hard-coded current versions. A mismatch blocks release.

**Status:** Resolved in target process; current repository requires reconciliation before release.

### C-003 — Bases readability

**Historical claim:** An older hazard states that Bases are opaque to MCP and unsuitable when agents must read evaluated rows.

**Implementation evidence:** The current repository documents `base_query`, which asks Obsidian's Bases engine to evaluate a view and returns scope-filtered rows.

**Resolution:** A Base remains a presentation, not automatic authority. Evaluated rows are agent-readable only when the supported Bases API and module are available. The old opacity statement remains historical evidence, not current implementation truth.

**Status:** Resolved.

### C-004 — Acceptance deployment

**Historical claim:** The acceptance pane was a separate, undistributed plugin awaiting a governance fold.

**Implementation evidence:** Current repository documentation describes an acceptance module folded into Governor, a pending index owned by that module, and human gesture-only accept behavior.

**Resolution:** Target architecture has one Governor review center. Release evidence must verify no old acceptance plugin or macro remains an active writer.

**Status:** Target resolved; deployment closure requires audit.

### C-005 — Product and plugin identity

**Historical claim:** The product and plugin were named vault-mcp; some compatibility events and SDK package names retain that term.

**Implementation evidence:** Current manifest identifies `governor`; documentation calls the product Governor.

**Resolution:** Governor is the current public name and plugin id. Legacy names remain only in migration, compatibility events with an expiry, package names that cannot change safely, and historical evidence.

**Status:** Target resolved; source and client-registration search required before release.

### C-006 — Module mutation rule

**Historical/current claims:** One module-host rule says mounted capability modules are explicitly read-only, while newer triage and other module descriptions include mutating modules registered through a guarded path.

**Resolution:** The target module contract distinguishes read-only actions from optional mutating actions. Every module surface binds a registered action through the shared operation executor; no module receives raw accept or baseline authority. Documentation must not claim that all modules are read-only.

**Status:** Resolved in target architecture; implementation registry contracts require review.

### C-007 — Manual acceptance versus scalable delegation

**Earlier target claim:** Every proposal required a contemporaneous individual human acceptance gesture.

**Operational evidence:** Historical queues reached 82 and then 341 pending items, and repeated representation repair would require hundreds of identical decisions.

**Resolution:** Acceptance remains a human act but may cover one immutable cohort or be exercised prospectively through a bounded mandate. Governor—not the authoring agent—admits exact results after required verification. Mutable “accept all” queries are prohibited.

**Status:** Resolved in revised target documentation; implementation requires session, mandate, cohort, verifier, and admission evidence.

### C-008 — “Not Git” versus Git as internal engine

**Earlier target claim:** Semantic history should not be implemented as Git and proposal branches were unnecessary.

**Later design decision:** Standard Git objects, diffs, refs, bundles, and merge machinery provide useful local persistence and portability when authority remains a separate Governor layer.

**Resolution:** Governor uses Git as its internal history and transition engine, not as the user interface or authority model. Signed attestations, mandates, and admission determine standing. The Git store stays outside Obsidian Sync.

**Status:** Resolved in revised target architecture; repository design and migration remain implementation work.

### C-009 — Local-only review state versus cross-device standing

**Earlier target claim:** Review baselines and plugin operational state were simply local or might sync with plugin data.

**External fact:** Obsidian Sync transfers files individually, excludes `.git`, and makes configuration choices per device.

**Resolution:** Notes-only Sync keeps standing local. Optional portable-standing mode syncs immutable content-addressed attestations; each replica waits for complete exact subjects before advancing local standing. Sync conflicts create new subjects.

**Status:** Resolved in target documentation; implementation and multi-device evidence required.

### C-010 — Capability-centric versus operation-centric execution

**Earlier/current claim:** Capability manifests and guarded tool registration were described as the principal execution architecture, while the current repository's mutation journal and kernel already use operation language.

**Later design decision:** Action, operation, and surface are separate. A stable action names a vault-state postcondition; an operation is one invocation; a capability or UI control is a surface-specific projection or binding. Every invocation uses the operation contract, while observation durability is selected separately.

**Resolution:** The action registry owns semantics. The document historically named `capability-manifest.md` defines a generated capability projection. Gate 0 introduces a shared executor and conservative compatibility bindings around current handlers; new work is native, and existing paths migrate incrementally rather than through a big-bang refactor.

**Status:** Resolved in target documentation; registry, compatibility seam, observation store, and bidirectional runtime checks remain implementation work.

## Adding a contradiction

Record:

- identifier;
- competing claims and their statuses/dates;
- current implementation evidence;
- durable principle, if any;
- target resolution;
- migration or compatibility action;
- owner; and
- closure status.

Do not delete the older claim merely because it became false. History explains the safety rule; status tells readers what applies now.

## Promotion to shipped status

A target action or projected capability becomes a shipped public claim only when:

- action registry, runtime handler, surface bindings, capability projection, bundle, and runtime directory agree;
- required tests and live evidence are captured;
- security/privacy disclosures are current;
- clean-vault onboarding works;
- migration and predecessor retirement are closed;
- documentation link and contradiction checks pass;
- the generated module directory accounts for every registered module and cross-cutting surface;
- operation lifecycle, observation capture, playback integrity, effect, and ephemeral-dependency tests pass;
- Git, attestation, mandate, cohort, and Sync-replica evidence passes; and
- a matching semantic release is published.

Until then, it remains a target-state specification.
