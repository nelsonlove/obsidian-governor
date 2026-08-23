# Migration and deprecation

A Governor change is not complete when new code works. It is complete when the new authority is live, every consumer uses it, old authority is inactive, state is accounted for, recovery is verified, and the documentation no longer leaves two plausible truths.

## Why closure is a safety property

Incomplete cutovers create:

- two review lifecycles;
- stale sockets or client registrations;
- generated files from an old compiler;
- green jobs that operate on empty sources;
- old properties that still look authoritative;
- duplicated capability names;
- settings whose owners are unclear; and
- users following documentation for the wrong generation.

This is not ordinary cleanup debt. It is competing authority.

## Operation-centric compatibility migration

Governor adopts the universal operation contract through a seam, not a big-bang rewrite:

```text
current MCP/UI/internal surface
        ↓
conservative compatibility binding
        ↓
registered action → shared operation executor → current or native handler
        ↓
observations / effects / receipt
```

**Gate 0** establishes the action registry, operation and observation schemas, shared executor, compatibility binding, and a bidirectional inventory of every surface and handler before feature-layer migration proceeds. New work is native to the operation contract. Existing guarded handlers may remain behind the adapter while they are converted in consequence order.

The adapter preserves current safety behavior but receives conservative claims. Until an action has a native declaration and contract tests, its binding cannot claim replayable observations, verified effects, mandate eligibility, automatic admission, or a stronger read-only classification than the existing implementation proves. The adapter must not invent missing inputs, effects, or evidence.

Migrate actions incrementally:

1. inventory every surface-to-handler and handler-to-surface relationship;
2. define the stable action by its vault-state postcondition;
3. bind current surfaces to that action and version;
4. route the invocation through the operation executor;
5. add observation and effect contracts plus tests;
6. compare the native result with the compatibility result on fixtures;
7. remove the compatibility path only after no consumer reaches it; and
8. regenerate capability, settings, documentation, and submission projections.

The operation migration is closed only when every invocation resolves through the executor, registry/runtime/projections agree in both directions, no compatibility binding confers stronger claims than its evidence, and the old execution path can no longer be reached.

## Required migration record

Each migration records:

- identifier and title;
- old and new versions;
- old authority and new authority;
- affected user, agent, developer, and operational surfaces;
- state to transform, retain, archive, or delete;
- backup and restore evidence;
- consumer inventory;
- cutover steps and order;
- rollback window and trigger;
- verification queries;
- documentation changes;
- known residuals;
- owner; and
- dated closure decision.

## The closure checklist

### 1. Identify authority

- Name each assertion the old surface owns.
- Name the single new owner.
- Decide which historical material remains evidence but loses current authority.
- Separate presentation, implementation, and provenance from authority.

### 2. Inventory consumers

Include:

- Obsidian UI and commands;
- agent tool registrations and skills;
- local bridge/client configurations;
- settings and operational state;
- automations and background jobs;
- generated artifacts;
- tests and fixtures;
- documentation and support playbooks;
- private packs; and
- external integrations.

An unlisted consumer is a likely unfinished migration.

### 3. Back up and prove restoration

- Capture the pre-cutover state independently of sync.
- Verify recent files, size, and source roots.
- Restore into a separate test vault.
- Preserve journals and acceptance history needed for diagnosis.
- Record evidence before mutating the live state.

### 4. Transform state

- Use a dry run that reports exact items and conflicts.
- Pilot a small batch.
- Preserve annotations, URLs, provenance, and unknown fields.
- Refuse ambiguous identities or destinations.
- Record per-item partial failures.
- Do not silently upgrade proposed material into accepted authority.

### 5. Repoint consumers

Update every consumer to the new owner. Verify by observing real reads and writes, not only configuration files.

### 6. Disable the predecessor

Stop services, unregister tools, disable modules, remove old client entries, stop scheduled jobs, and make old outputs read-only or historical. Do not leave a “temporary” writer active without an expiry and owner.

### 7. Audit the cutover

Check:

- only one authority responds;
- old paths and identifiers fail in the documented way;
- new state is complete;
- no hidden queue, baseline, journal, Git ref, session, mandate, signer, verifier, attestation, replica ledger, or job remains active;
- backups still restore;
- degraded states report accurately; and
- users and agents follow the new documentation.

### 8. Update documentation and contradictions

Change status, compatibility, action registry and capability projection, settings, agent guide, architecture, troubleshooting, and submission disclosures. Add a dated contradiction resolution; do not erase the historical claim that explains why the migration existed.

### 9. Close or roll back

Close only after verification. If a cutover invariant fails inside the rollback window, stop new writes, preserve evidence, restore the old authority as the sole owner, and record why rollback occurred.

## Deprecation states

| State | Meaning | User experience |
|---|---|---|
| Announced | Replacement and timeline published | Warning and migration preview available |
| Migrating | New surface available; controlled cutover underway | One writer at a time; old surface may be read-only |
| Deprecated | Old surface remains temporarily readable | Calls warn or refuse mutation; replacement named |
| Retired | Old surface no longer runs | Typed retired error and historical docs only |
| Removed | Compatibility code deleted after support window | Migration record remains |

Do not use “deprecated” for a surface that is still the only working authority.

## Identity and name changes

For product or capability renames:

- preserve stable ids when publication rules allow;
- keep legacy events only for compatibility with a bounded end date;
- update client registrations and socket paths;
- migrate plugin data deliberately;
- ensure one display name in current docs;
- search generated code, settings, errors, support text, and release assets; and
- record which old names remain historical.

The current product name is Governor. Historical name references belong only in migration evidence.

## Version and schema changes

Never infer a migration solely from package version. Store an explicit schema or state version where necessary. A migration should be:

- idempotent;
- interruptible or safely restartable;
- bounded to known state;
- observable;
- tested from every supported predecessor; and
- unable to confer acceptance.

## Authority migrations

Moving acceptance, standing, protected properties, sessions, mandates, signer trust, verifier policy, attestations, Git refs, or a baseline is higher risk than moving ordinary settings.

- Freeze new authority changes during cutover.
- Reconcile old and new baseline states without choosing silently.
- Preserve human attribution.
- Refuse ambiguous or conflicting accepted records.
- Keep the old log as historical evidence.
- Prove no agent path gained an accept, admit, signer, mandate-activation, or standing-ref verb.

When migrating from a property/baseline model to Git-backed standing:

- import existing bytes without treating Git author strings as identity;
- freeze and reconcile the last accepted subject as local historical evidence;
- label imported properties, baselines, and review records `legacy-import`, preserving source and known timestamp;
- never fabricate human signatures, verification predicates, mandate authority, or admission attestations for pre-Governor state;
- preserve unresolved proposals as proposed;
- place the Git object database outside Obsidian Sync;
- begin portable standing prospectively at a dated cutover, with selective human re-acceptance available for current subjects or frozen legacy cohorts; and
- test a second replica with partial and conflicted Sync arrival.

## Job and automation migrations

A job is not migrated because its configuration exists. Verify:

- scheduler sees it;
- source glob resolves to non-zero intended input;
- last run succeeded;
- output is current and non-empty;
- alerting detects empty or stale work; and
- predecessor job is stopped.

Installed, enabled, running, and last-successful are different facts.

## Documentation migration

Search for:

- old product and module names;
- old versions and tool counts;
- superseded socket or plugin-data paths;
- separate review systems now folded together;
- statements that a capability is impossible after it ships;
- future vision described as current; and
- current behavior described as merely proposed.

Resolve each hit through [Status and compatibility](status-and-compatibility.md).

## Closure record example

```yaml
migration: review-center-convergence
oldAuthority: separate acceptance property workflow and separate baseline pane
newAuthority: Governor review center
state:
  baselines: reconciled
  proposals: migrated without accepting
  humanAttribution: preserved
consumers:
  agentPendingIndex: repointed
  inAppCommands: repointed
  oldMacros: disabled
  oldPlugin: disabled
verification:
  oneReviewPane: confirmed
  noAgentAcceptCapability: confirmed
  oldWriterInactive: confirmed
rollback: pre-cutover backup and old plugin package retained outside active vault
closedOn: date recorded by the actual migration
owner: release maintainer
```

The example defines evidence fields; it does not claim a live migration date.

## Definition of closed

A migration is closed when the answer to each question is supported:

- What is the one current authority?
- Do all consumers use it?
- Can the predecessor still write or confer standing?
- Is all state accounted for?
- Do backups restore?
- Do runtime health and docs agree?
- Is rollback still needed or explicitly expired?
- Is the closure dated and owned?

If one answer is unknown, the migration remains open.
