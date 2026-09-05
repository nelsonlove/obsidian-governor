# Settings

Governor settings are ordered from least to most consequential. Defaults belong to the settings schema; this document explains their meaning. A release must generate or verify this reference against that schema so prose cannot silently drift.

> [!note]
> This target-state reference uses behavior-level setting names. A release may refine the UI wording, but it must preserve the stated defaults, consequences, and recovery.

## Connection

### Local bridge

| Field | Value |
|---|---|
| Default | On after Governor is enabled |
| Effect | Accepts compatible local MCP connections through the desktop bridge |
| Takes effect | New connections; an existing client may need to reconnect |
| Dependency | Desktop Obsidian |
| Risk | Local processes running as the user may attempt to connect |
| Recovery | Turn off the bridge, disconnect clients, and inspect the journal |

The bridge is local, not an internet listener. Turning it off removes agent access but leaves the review center and existing operational records available in Obsidian.

### Code mode

| Field | Value |
|---|---|
| Default | On for clients that support discovery calls |
| Effect | Exposes a small discovery-and-call surface instead of registering every capability schema in client context |
| Takes effect | Next connection |
| Dependency | Compatible bridge and client |
| Risk | None beyond the capabilities the target call already carries |
| Recovery | Reconnect using the full surface for diagnosis |

Code mode changes discovery cost, not authority. The selected surface still resolves a registered action and passes through the same operation executor.

## Posture

### Current posture

| Field | Value |
|---|---|
| Default | **Looking only** |
| Effect | Selects the highest operation mode the connection may request |
| Takes effect | Immediately for refusals; reconnect when the capability surface changes |
| Dependency | None |
| Risk | Broader postures permit more consequential writes |
| Recovery | Return to Looking only and reconnect clients |

The selectable progression is Looking only → Drafting a change → Proposing governed changes → Working under a mandate. “Ready for review” is a proposal or cohort state, not a connection posture. A posture does not grant access outside the path scope or outside an active mandate.

### Create and append

| Field | Value |
|---|---|
| Default | Off |
| Effect | Permits new notes and pure end-of-note appends inside scope |
| Takes effect | Next connection |
| Dependency | A non-empty path scope |
| Risk | Adds or extends content; may create review work |
| Recovery | Turn off, revert proposals, or restore prior revisions |

### Structural mutation

| Field | Value |
|---|---|
| Default | Off |
| Effect | Permits preview-first edits, property changes, moves, and named repairs |
| Takes effect | Next connection |
| Dependency | Review center enabled and recovery available |
| Risk | Can change representation, meaning, location, links, and many notes; actual effects are classified separately |
| Recovery | Disable, inspect receipts, revert, or restore from verified backup |

## Scope

### Accessible folders

| Field | Value |
|---|---|
| Default | No vault content until the user chooses a scope |
| Effect | Bounds direct paths and discovery results |
| Takes effect | New connections; active handlers consult the live boundary where supported |
| Dependency | Vault-relative normalized paths |
| Risk | A broad scope exposes more private content and increases blast radius |
| Recovery | Narrow the list and reconnect |

Use one folder prefix per row. Segment boundaries matter: `Projects` includes `Projects/A.md`, not `Projects-Old/A.md`. Hidden notes remain unresolved through ordinary lookup.

### Git history scope

| Field | Value |
|---|---|
| Default | Human chooses whole ordinary-vault history or explicit included/excluded roots during Git setup |
| Effect | Defines which files Governor's local Git history may retain independently of any client's access scope |
| Takes effect | Through a reviewed history migration; never silently on reconnect |
| Dependency | Local Git repository service and disclosed outside-Sync storage |
| Risk | Historical bytes can remain after visible files change or disappear |
| Recovery | Stop history ingestion, export required evidence, and follow the documented retention/pruning procedure |

Repository identity belongs to the vault. A connection scope cannot expand history retention, and changing history scope is a human privacy and recovery decision.

## Observation capture and replay

### Governed-session read capture

| Field | Value |
|---|---|
| Default | Replayable for substantive vault reads in governed sessions |
| Effect | Preserves the exact Governor-returned payload and a content digest for review and playback |
| Takes effect | New operations |
| Dependency | Protected local observation store |
| Risk | Historical note content and metadata remain after the visible note changes or is deleted |
| Recovery | Shorten retention, delete eligible payloads through the audited control, or close the session and export only required evidence |

Governor may reduce low-information navigation and plumbing observations to ephemeral. Any read used to support a proposal, verification, or admission must be captured at evidence or replayable durability; Governor re-observes it if necessary.

### Ad hoc durable read capture

| Field | Value |
|---|---|
| Default | Evidence |
| Effect | Preserves the claims and digests needed for audit without necessarily retaining the full returned payload |
| Takes effect | New operations outside a governed session |
| Dependency | Operation evidence store |
| Risk | Paths, queries, result digests, and timing can still be sensitive |
| Recovery | Use ephemeral capture for eligible plumbing reads or prune evidence under policy |

### Replay retention

| Field | Value |
|---|---|
| Default | Retain through the session's review and recovery window, then apply the configured local retention policy |
| Effect | Controls how long replay payloads remain available; immutable digests and authority evidence may outlive the payload |
| Takes effect | New retention evaluations; never rewrites signed claims |
| Dependency | Observation store and retention worker |
| Risk | Long retention increases privacy exposure; short retention can remove historical playback needed for review or incidents |
| Recovery | Export a scoped audit bundle before expiry or delete payloads earlier through a recorded human action |

Playback access is checked against the current human/operator authorization as well as the original capture scope. Possession of an operation id is not read authority.

### Scheme exclusions

| Field | Value |
|---|---|
| Default | Empty |
| Effect | Removes configured roots from one addressing scheme's claims without hiding those notes from ordinary scoped access |
| Takes effect | Live for resolution |
| Dependency | Scheme module |
| Risk | A scheme may report a slot free because an excluded note occupies it |
| Recovery | Remove the exclusion or use a literal/stable identity reference |

## Review

### Review center

| Field | Value |
|---|---|
| Default | On |
| Effect | Shows proposals, revisions, history, and mechanical activity; owns human acceptance |
| Takes effect | Immediately |
| Dependency | None for the in-app surface |
| Risk | Turning it off removes the normal human decision surface, not the underlying prohibition on agent acceptance |
| Recovery | Re-enable; unpublished queue state must be reported explicitly |

### Review budget

| Field | Value |
|---|---|
| Default | 10 judgment-bearing proposals |
| Effect | Pauses creation of additional governed proposals when the pending budget is full |
| Takes effect | Immediately |
| Dependency | Review center |
| Risk | Too high creates review debt; too low may pause useful work |
| Recovery | Review, expire superseded proposals, narrow scope, or deliberately raise the budget |

### Stale-proposal age

| Field | Value |
|---|---|
| Default | 14 days |
| Effect | Marks untouched proposals stale and allows superseded ones to expire into history |
| Takes effect | Next review refresh |
| Dependency | Review center |
| Risk | Expiry can hide unfinished intent if the history view is ignored |
| Recovery | Restore a proposal from history as a new proposal, never as admitted standing |

### Cohort grouping and verification

| Field | Value |
|---|---|
| Default | Group only exact matching change classes and transformations; verify every item for admission |
| Effect | Reduces repetitive review while preserving an immutable decision subject and per-item evidence |
| Takes effect | Next eligible change |
| Dependency | Frozen cohort manifest, named verifier, and direct human decision or active mandate |
| Risk | A bad transformation or verifier can repeat a bad result at scale |
| Recovery | Block admission, inspect failed items, revoke the mandate if needed, and revert the exact admitted cohort |

Sampling may supplement audit, but it is not a substitute for full-coverage verification when mandated admission changes standing.

### Mandates

| Field | Value |
|---|---|
| Default | None active |
| Effect | Allows one delegate/session to perform a named transformation in a bounded scope and may authorize Governor to admit exact verified cohorts |
| Takes effect | After a human accepts the mandate; never retroactively |
| Dependency | Session binding, change-class verifier, recovery baseline, and review center |
| Risk | A wrong rule or overly broad scope can repeat at scale |
| Recovery | Revoke the mandate, stop its sessions, inspect attestations, and revert admitted cohorts by exact subject |

Every mandate shows delegate, purpose, scope, class, transformation, limits, verifier, admission mode, expiry, and recovery. Agents may draft or counter-propose but cannot change an active mandate.

### Portable standing across Sync

| Field | Value |
|---|---|
| Default | Off |
| Effect | Writes immutable mandate, verification, admission, and revocation attestations to Governor community-plugin data so Obsidian Sync can carry them when that data category is enabled |
| Takes effect | New attestation writes; receiving replicas import existing immutable envelopes after validation |
| Dependency | Obsidian Sync community-plugin data enabled separately on every relevant device |
| Risk | Authority metadata, paths, identifiers, and purpose may sync; partial arrival and conflicts remain possible |
| Recovery | Turn off portable writes, preserve evidence, reconcile each replica, and revoke compromised keys or mandates |

The local Git object database is never placed in Obsidian Sync by this setting.

### Signing identity and recovery

| Field | Value |
|---|---|
| Default | One local signing identity per authorized device or verifier role; portable pairing off until the human initiates it |
| Effect | Signs small authority and verification claims so another replica can validate their issuer |
| Takes effect | After local registration or explicit device pairing |
| Dependency | Operating-system protected secret storage |
| Risk | A stolen private key can issue claims in its registered role until revoked |
| Recovery | Revoke the old key, register a new one, or restore an optional encrypted key backup kept outside the vault and Sync |

This feature does not encrypt notes, attachments, Git history, or the vault.

## Protected properties and records

### Protected frontmatter properties

| Field | Value |
|---|---|
| Default | Acceptance/standing family plus mandate, signer, verifier-trust, and admission pointers as authority-conferring |
| Effect | Prevents agents from introducing, changing, or removing declared human-owned properties |
| Takes effect | Immediately on guarded writes |
| Dependency | Shared write guard |
| Risk | Overbroad declarations may block legitimate carry-forward edits |
| Recovery | Change the declaration in Governor settings through a human action; do not bypass the guard |

The acceptance family is a non-configurable floor. Configuration may extend it, never remove or weaken it.

### Record immutability

| Field | Value |
|---|---|
| Default | On |
| Effect | Protects notes declared `record: true` from addressed in-place mutation; pure end append remains available |
| Takes effect | Immediately |
| Dependency | Metadata cache can read the flag |
| Risk | The protective check may fail open if metadata is unavailable; side-effect rewrites remain outside its addressed-path boundary |
| Recovery | Keep backups; disable only for a reviewed exceptional operation |

## Modules

Optional modules use one common availability vocabulary: available, disabled, missing dependency, incompatible version, outside scope, or temporarily unavailable.

| Module | Default | Consequence | Dependency | Recovery |
|---|---|---|---|---|
| Stable identity and link health | On | Read-only reports and stable references | Metadata cache | Repair duplicates deliberately |
| Bases | On when public API is available | Evaluated read-only rows | Supported Obsidian Bases API | Disable or update Obsidian |
| Vocabulary | Off until configured | Read-only validation | Vocabulary sources | Fix config or disable |
| Scheme addressing | Off until configured | Resolution and preview-first placement | Scheme provider | Use literal paths or stable identities |
| Conformance | Off until baselined | New-drift reporting | Accepted baseline and declared territory | Run report-only, repair or review debt |
| Triage | Off | Governed queue and dispositions | Configured queue and actions | Disable; use ordinary operations |
| Cross-session coordination | Off | Read receipts and guarded posting | Channel convention | Disable and use manual coordination |
| Provenance | Off | Freshness, reconciliation, and governed regeneration | Declared sources and generator | Report only or restore prior generated artifact |
| Health | Off | Scoped or whole-vault reports | Scanner rules and resource budget | Disable or narrow scan |
| Fileclass | Off | Schema inspection and governed representation changes | Compatible Fileclass plugin and CLI surface | Disable or edit through ordinary note operations |
| Acceptance | On in target product | Human sessions, cohorts, mandates, admission, and history | Review, Git, verifier, and attestation services | Return to proposal-only operation; never expose agent admission |
| JD scaffolding | Off | Configured structure and identifier scaffolding | Templates and scheme configuration | Dry-run, restore exact cohort, disable |
| Survey | Report-only when available | Deterministic observations for planning | Survey adapters | Disable or use direct reads |
| QuickAdd bindings | Off until explicitly bound | Named choice capabilities | Installed QuickAdd and declared binding manifests | Disable binding; opaque choices remain private |

The complete module list and each module's target default are in the [Module directory](modules.md); this summary is not a second inventory owner. Skills is no longer a module of this plugin's settings tab — its config moved to the separate `vault-skills` plugin's own settings tab, with a one-shot adoption of the recognized keys out of this plugin's former `modules.skills.config` on that plugin's first load (see [skills.md](skills.md)).

For the first Community release, skills/policy compilation (now the separate `vault-skills` satellite plugin), cross-session coordination, JD scaffolding, triage mutations, QuickAdd execution bindings, and provenance regeneration are private/operator features and are absent from the public bundle. Bases, scheme, vocabulary, conformance, health, survey, Fileclass inspection, and provenance inspection may ship as bounded public optionals when their dependencies and manifests are satisfied.

## Operation evidence and retention

### Write journal retention

| Field | Value |
|---|---|
| Default | Monthly append-only files retained until the user prunes whole months |
| Effect | Records operation metadata and reduced argument digests, not note bodies |
| Takes effect | New journal records |
| Dependency | Writable plugin data directory |
| Risk | Paths, operation names, intent, and timing can still be sensitive |
| Recovery | Export for incident evidence, then prune whole files under a documented retention policy |

A journal-write failure never turns a completed vault mutation into a failure response. It must produce a visible health warning because audit evidence is degraded.

### Replayable observation retention

| Field | Value |
|---|---|
| Default | Session review and recovery window, followed by configured local expiry |
| Effect | Retains content-addressed Governor-returned payloads separately from the reduced operation journal |
| Takes effect | New captures and scheduled retention runs |
| Dependency | Protected local observation store |
| Risk | Payloads may contain complete note bodies, metadata, queries, and historical content |
| Recovery | Inspect dependencies, export required evidence, then delete eligible payloads through the audited retention control |

The reduced journal and replay store serve different purposes. Journal minimization does not imply that a replayable observation contains no note content.

## Advanced and private settings

Private capability packs have their own enablement, scope, audit, and offboarding. They are absent from the normal public agent surface. Turning on a private pack is a deployment decision, not a casual feature toggle. See [Advanced capability packs](advanced-capability-packs.md).

## After changing settings

Governor distinguishes live settings, next-connection settings, and restart-required settings. The UI must say which applies beside every control. When in doubt, reconnect the client and ask Governor for the current capability directory; do not infer availability from the presence of a setting alone.
