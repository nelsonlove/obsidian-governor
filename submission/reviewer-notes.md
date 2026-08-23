# Reviewer notes

These notes orient an Obsidian Community Plugin or security reviewer to Governor's highest-consequence boundaries. They are a review map, not a substitute for source inspection or release evidence.

## Why the plugin has broad local authority

Governor connects a local AI client to the running Obsidian application so the client can retrieve live vault information and request governed changes. Community Plugins inherit Obsidian's privileges, so the meaningful security boundary is Governor's own registration, scope, guard, review, and release design—not an OS sandbox claim.

The submitted public profile intentionally removes operation modes whose effects cannot be bounded with comparable confidence.

## Review priorities

### 1. Bundle boundary

Confirm the Community `main.js` contains public core and optional public modules only. Search for:

- arbitrary evaluation;
- generic command proxy;
- plugin install/uninstall;
- hard delete;
- unconstrained filesystem roots;
- remote server code;
- dynamic code download;
- telemetry; and
- private capability-pack registrations.

### 2. Local bridge

Confirm:

- local socket rather than public listener;
- owner-only permissions;
- per-vault identity;
- safe stale-socket handling;
- lifecycle cleanup;
- no secrets in command-line examples;
- connection-specific surface; and
- disabling the bridge stops agent access.

### 3. One action registry and operation path

Review full mode, compact code mode, in-app tool runner, batch operations, internal automation, module registration, and third-party publishing. Every surface must resolve one registered action/version and invoke the same operation executor. No raw handler should be reachable around posture, scope, observation capture, protected properties, queue, effect evidence, journal, or receipt behavior.

### 4. Scope

Review normalization, traversal, segment boundaries, source/destination checks, batch items, stable/scheme references, discovery filtering, hidden counts, pending index, Base rows, backlinks, and discovered-blast-radius operations.

Tools that cannot be path-scoped honestly should refuse under scope or remain absent publicly.

### 5. Human-only acceptance

Confirm:

- no accept, approve, restore-authority, or baseline-advance agent capability;
- no admit, signer-selection, mandate-activation, or standing-ref agent capability;
- authoritative actor/session identity is derived by Governor rather than accepted from caller arguments or Git metadata;
- accepted-family transition checks at shared write primitives;
- recognition parity with Obsidian-honored frontmatter;
- protected-property removal and alternate spelling handling;
- templates and opaque paths fail closed or remain excluded;
- human review and mandate gestures are in-app and not programmatically callable through MCP;
- individual and cohort acceptance freeze exact subject digests;
- mandate admission checks delegate/session, scope, class, transformation, limits, verifier, expiry, revocation, and recovery;
- admission verifies every subject and required attestation before advancing standing; and
- proposed/revising remain agent workflow states without conferring standing.

### 6. Git and attestations

Confirm:

- the Git object database is local and outside the Obsidian Sync file set;
- agents do not call raw Git or choose author/committer identity;
- proposal, session, and standing refs advance only through owned services;
- cohort manifests are canonical and immutable;
- DSSE-style envelopes bind trusted signatures to in-toto-style exact subjects and typed predicates;
- verification, admission, revocation, and effect claims remain separate;
- a subject change makes prior verification stale; and
- keys and attestations contain no note bodies or bundled secrets.

### 7. Concurrency and uncertain state

Confirm one mutation queue, dequeue-time revisions, bounded idempotency identity, simultaneous retry behavior, timeout abandonment, late correction records, partial batch reporting, and required re-read.

### 8. Operation evidence, observations, and privacy

Confirm journal reduction removes bodies and long values, while acknowledging path and intent sensitivity. Separately inspect the replayable observation store, which may contain exact returned note content: scope/redaction before capture, content digests, authorization on playback, retention, deletion, export, corruption behavior, and replica-local placement. Confirm ephemeral observations cannot support proposals, verification, or admission. Compare bundle endpoints with [Privacy](../PRIVACY.md) and [Data flow](../docs/data-flow.md).

### 9. Obsidian Sync and replicas

Confirm:

- file arrivals are treated as external or Sync-attributed without invented human/agent authorship;
- portable-standing mode is optional and disclosed as community-plugin data;
- partial file or attestation arrival remains `receiving`;
- no subset of a cohort is admitted;
- conflicts create new subjects and invalidate old verification;
- Sync settings are treated as device-specific; and
- desktop and official Headless Sync are not run together for one local vault on one device.

### 10. Supported Obsidian APIs

Review mutation paths for `Vault.process`, `FileManager.processFrontMatter`, `FileManager.renameFile`, and `trashFile`; user paths for `normalizePath`; settings for `loadData`/`saveData`; configuration directory for `Vault.configDir`; and lifecycle cleanup for commands, events, intervals, views, sockets, hidden leaves, and DOM.

Any intentional non-public API hop must be feature-checked, isolated, documented, timed out, cleaned up, and covered by a live test.

### 11. Optional dependencies

For Bases, vocabulary, schemes, conformance, triage, coordination, and external publishers, verify disabled/missing/incompatible/unavailable behavior. A missing source must not become a convincing empty result.

### 12. Startup and large-vault cost

Inspect work performed during `onload`, layout-ready initialization, connection construction, metadata indexing, Base evaluation, review refresh, and journal handling. Verify caps, pagination, cancellation, hidden-view cleanup, and occluded-window timing.

## Data-flow summary

```text
    compatible client → local socket → surface binding → action registry → operation executor → Obsidian
                                                                    ↘ observations/effects/Git/review/attestations
    Obsidian Sync → file-level arrivals and optional portable attestation copies → replica reconciler
```

Governor core does not require a Governor-operated server or client-side telemetry. The connected client's model-provider path is separate and disclosed.

## Public exclusions

Reviewers should be able to confirm these are absent, not merely default-off:

- hard delete;
- arbitrary code and generic command execution;
- plugin lifecycle;
- unconstrained configuration/CSS write;
- unconstrained outside-vault export;
- destructive import; and
- authority-restoring version restoration.

Private-pack documentation exists to make the boundary explicit. It is not evidence that private code belongs in the submitted bundle.

## Known residual risks

- Same-user local processes and other Community Plugins can bypass Governor.
- Same-user compromise can steal signing keys or delete local Git/attestation evidence.
- Obsidian link resolution creates limited existence or basename-collision oracles under scope.
- A write timeout may have a late effect.
- In-memory idempotency does not survive restart.
- Journal failure degrades audit without rolling back the vault.
- Record protection is addressed-path protection, not byte-level immutability.
- Third-party host APIs may change or behave differently while appearing available.
- Human review can still be overloaded or careless.
- Obsidian Sync can expose a temporary mixed working tree while a cohort is still receiving.

These are documented in the [Threat model](../docs/threat-model.md), not hidden as implementation trivia.

## Evidence the actual submission should attach

- release commit and asset digests;
- workspace test and production-build output;
- manifest/release/version reconciliation;
- bundle endpoint, telemetry, dynamic-code, and private-code scan;
- adversarial security matrix;
- supported Obsidian API review;
- clean-vault onboarding recording or steps/results;
- minimum-version and optional-dependency matrix;
- startup, large-vault, Bases, queue, and review performance measurements;
- keyboard/accessibility results;
- migration closure and old-surface audit;
- session/mandate/cohort, Git/attestation, key trust, and two-replica Sync evidence;
- backup restoration evidence; and
- final local-link/disclosure validation.

Blank or narrative-only evidence is not equivalent to a result.

## Suggested source-review entry points

Begin with logical areas rather than line numbers that drift:

- plugin entry and connection UI;
- bridge transport;
- MCP server registration and guarded wrapper;
- core acceptance/protected-property guard;
- action registry, surface bindings, operation executor, compatibility adapter, and lifecycle;
- observation/effect stores, capture policy, playback authorization, retention, and claims;
- write queue, journal, idempotency, and claims;
- Obsidian backend write/move/frontmatter primitives;
- review/governance wiring and human gesture handlers;
- module registry and availability;
- external publisher SDK trust boundary;
- settings persistence;
- Git object/ref, signer/verifier, attestation, admission, and replica-reconciliation services; and
- build/release configuration.

Trace at least one replayable read from scope check through stored playback, one ephemeral plumbing read that is rejected as a proposal dependency, one append, one move, one rejected acceptance write, one uncertain timeout, one individual admission, one cohort admission, one mandate-based admission, one revocation, and one partial/conflicted Sync arrival end to end.
