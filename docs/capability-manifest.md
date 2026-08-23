# Capability projection

The capability projection describes the user outcomes Governor can make available for a particular distribution and runtime. It is generated from the [Action registry](action-registry.md), module manifests, settings, dependency probes, posture, and effective scope.

The action registry owns execution semantics. This projection owns how one or more actions are presented as an understandable capability. It must not redefine an action's observations, effects, authority, verification, retention, receipt, or recovery contract.

## Why one projection

A large integration surface drifts when runtime registration, settings, documentation, risk labels, dependency checks, and tests are maintained separately. A capability can exist in source, disappear at runtime, remain in a README, and still look “supported.”

The action registry makes execution facts one declaration. This projection prevents user, agent, settings, and Community descriptions from drifting from those facts.

## Projection unit

One entry represents one bounded user outcome, not necessarily one action or low-level tool. Several actions and surfaces may contribute to one capability. The entry lists those action references rather than restating their contracts.

## Required fields

| Field | Type | Meaning |
|---|---|---|
| `id` | stable dotted string | Product-level capability identity |
| `title` | string | Plain-language name |
| `outcome` | string | Postcondition promised to the user |
| `actions` | action id/version references | Registered semantic contracts that realize the outcome |
| `owner` | module id | Code and settings owner |
| `distribution` | enum | `public-default`, `public-optional`, `private`, or `excluded` |
| `access` | enum | `read`, `plan`, `mutation`, `destructive`, or `opaque` |
| `changeClasses` | array | Allowed computed effects: encoding, presentation, representation, structural, content, authority |
| `posture` | enum | Minimum public posture or `private-only`/`unavailable` |
| `dependencies` | array | Obsidian version, core feature, host plugin, platform, and feature probes |
| `availability` | reference | Function returning available or one typed unavailability reason |
| `scope` | object | Named-path keys, enumeration behavior, global refusal, and documented oracles |
| `preview` | object | Required, supported, or impossible; output contract |
| `concurrency` | object | Revision and queue behavior |
| `session` | object | Session requirement, resumability, expiry, and actor binding |
| `mandate` | object | Delegation eligibility, required fields, budgets, and escalation |
| `cohort` | object | Grouping keys, subject manifest, split rules, and admission unit |
| `verification` | object | Required predicate, verifier trust, coverage, and stale behavior |
| `attestations` | array | Proposal, effect, verification, admission, and revocation claims produced or consumed |
| `sync` | object | Replica import, partial-arrival, conflict, and portable-state behavior |
| `idempotency` | object | Supported identity and lifetime |
| `protectedData` | array | Protected-property, record, secret, or other rules |
| `capture` | object | User-facing operation and observation retention consequences projected from the actions |
| `receipt` | reference | Required verification and recovery fields |
| `errors` | array | Stable identifiers this capability can return |
| `recovery` | object | Undo, revert, restore, or explicit no-undo route |
| `degraded` | array | Dependency-failure behavior |
| `docs` | array | Human, agent, developer, and submission targets |
| `tests` | array | Required unit, integration, live, adversarial, and performance evidence |
| `deprecatedBy` | capability id or null | Replacement when deprecated |

## Enums

### Distribution

- `public-default` — safe without widening mutation authority;
- `public-optional` — part of the Community product after a human enables it;
- `private` — separately governed deployment capability;
- `excluded` — known capability class intentionally not exposed.

### Access

- `read` — no plugin or vault state mutation;
- `plan` — validates and computes a possible change without applying;
- `mutation` — proposes or applies a classified change; `changeClasses` carries its semantic effect;
- `destructive` — removal or difficult-to-recover mutation;
- `opaque` — effect cannot be inspected or bounded before execution.

### Posture

- `looking-only`;
- `drafting`;
- `proposing`;
- `mandated`;
- `private-only`;
- `unavailable`.

The UI renders the approved public labels rather than these implementation tokens.

## Availability contract

The availability function returns exactly one state:

```ts
type Availability =
  | { state: "available" }
  | { state: "disabled"; setting: string }
  | { state: "missing-dependency"; dependency: string }
  | { state: "incompatible-version"; dependency: string; required: string; found: string }
  | { state: "outside-scope"; reason: string }
  | { state: "temporarily-unavailable"; retryable: boolean; reason: string }
  | { state: "excluded"; reason: string };
```

Unknown, missing, and empty are not synonyms.

## Scope contract

```ts
type ScopeContract = {
  argumentKeys: string[];
  resolvesAddresses: boolean;
  enumeration: "filter-before-read" | "not-applicable";
  whenScoped: "available" | "refuse";
  discoveredEffects: "bounded" | "refuse" | "not-applicable";
  documentedOracles: string[];
};
```

An operation that discovers targets at runtime must state how those targets are bounded. Free-text command strings do not satisfy this contract.

## Preview contract

Preview declares:

- whether it is mandatory;
- whether the same planner is used at apply;
- targets and effects returned;
- collision and refusal checks;
- staleness or reservation semantics; and
- how apply revalidates.

`impossible` is valid only for a private or excluded capability and must explain why.

## Recovery contract

Recovery is not a Boolean. It names:

- inverse operation when safe;
- review-center revert;
- note-history restoration;
- backup restoration;
- partial-state procedure;
- data or authority that cannot be restored; and
- evidence to preserve before recovery.

## Complete example

This verbose expanded view is generated for runtime and reviewer convenience. Action-owned fields appear here as projections and are not maintained independently.

```yaml
id: note.append
title: Append to a note
outcome: Add one tail to a visible Markdown note without altering prior content.
actions: [note.append@1]
owner: notes
distribution: public-optional
access: mutation
posture: proposing
changeClasses: [content]
dependencies:
  - platform: desktop
  - obsidian: ">= minimum version declared by the release manifest"
availability: notes.appendAvailability
scope:
  argumentKeys: [path]
  resolvesAddresses: true
  enumeration: not-applicable
  whenScoped: available
  discoveredEffects: not-applicable
  documentedOracles: []
preview:
  required: true
  planner: notes.planAppend
  returns: [resolvedTarget, currentRevision, appendedTail, reviewEffect]
  reservation: none
  applyRevalidates: [scope, revision, protectedProperties, recordRule]
concurrency:
  queue: vault-singleton
  revision: required-after-read
idempotency:
  supported: true
  identity: [key, action, actionVersion, arguments, if_rev]
  persistence: plugin-session
session:
  required: true
  actor: governor-derived
mandate:
  eligible: true
  requiredForAutomaticAdmission: true
cohort:
  grouping: [changeClass, transformation, scope, verifierPolicy]
  subject: canonical-manifest-sha256
verification:
  predicate: note.append-preservation/v1
  coverage: every-item
attestations: [proposal, verification, effect, admission]
sync:
  partialArrival: receiving
  conflict: new-subject-requires-reverification
protectedData: [accepted-family, declared-protected-properties, record-end-append-only]
operationEvidence:
  required: true
  effects: [filesChanged, paths]
capture:
  governedObservation: replayable
  operation: durable-for-mutation
receipt: receipts.noteAppend
errors:
  - read_only
  - out_of_allowlist
  - uid_unresolved
  - uid_ambiguous
  - rev_conflict
  - idempotency_mismatch
  - accept_forbidden
  - protected_property
  - write_timeout
recovery:
  primary: review-center-revert
  fallback: restore-prior-note-revision
  uncertain: reread-before-retry
degraded:
  - dependency: journal
    behavior: complete-with-degraded-audit-warning
  - dependency: acceptance-guard
    behavior: refuse
docs:
  - docs/getting-started.md
  - docs/user-guide.md
  - docs/operation-contract.md
tests:
  - unit: append-composition
  - integration: shared-guard-path
  - adversarial: acceptance-fence-parity
  - live: append-and-reread
deprecatedBy: null
```

The version comparator in the example is descriptive. A real entry uses the release's machine-readable version constraint rather than prose.

## Projection consumers

The projection generates or validates:

1. MCP registration metadata and read-only annotations;
2. compact discovery results;
3. settings capability directory;
4. [Capability directory](capabilities.md);
5. README risk and outside-vault disclosures;
6. agent operation descriptions;
7. error-registry coverage;
8. receipt requirements;
9. threat-model control matrix;
10. release test checklist;
11. Community reviewer inventory; and
12. module directory and user-facing change-class, verifier, observation-capture, and Sync behavior.

Human prose can explain consequences but cannot override action-registry or projection facts.

## Validation rules

A build fails when:

- capability ids collide or change without migration;
- an action reference is missing, incompatible, or ineligible for the capability's distribution;
- a projection contradicts an action's scope, observations, effects, authority, retention, verification, receipt, or recovery;
- a public capability is destructive or opaque;
- a mutation lacks queue/operation-evidence/receipt declarations;
- a scoped capability cannot bound named or discovered targets;
- a capability can affect accepted state;
- a capability accepts agent-supplied actor identity or advances standing outside Governor admission;
- a mandated capability lacks an exact change class, verifier predicate, cohort subject, or budget;
- a synced cohort can be partially admitted;
- a mandatory preview has no shared planner;
- an availability dependency has no degraded behavior;
- an error is undocumented or unregistered;
- a public capability lacks user documentation;
- a private capability appears in public-default output; or
- deprecation lacks a replacement or explicit retirement rationale.

## Change discipline

Changing action membership, distribution, access, posture, scope, observation capture, protected data, network behavior, recovery, or dependencies is a security- and migration-relevant change. It requires:

- threat-model review;
- tests;
- documentation update;
- status and compatibility update;
- release note;
- migration or deprecation record when users must act; and
- Community disclosure review.

This is how capability growth remains proportional and inspectable.
