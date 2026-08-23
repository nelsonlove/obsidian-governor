# Action registry

The action registry is the canonical machine-readable source for what Governor can do. It defines stable postcondition contracts independently of the MCP tools, Obsidian controls, automations, or internal adapters that expose them.

A registered action does not grant permission. An action becomes usable only through an eligible surface, current availability, an effective scope, the required posture, and any applicable session, mandate, verification, and authority conditions.

## Action, operation, and surface

- An **action** is a stable semantic contract named by its postcondition.
- An **operation** is one invocation of an action against exact inputs and subjects.
- A **surface** is a door onto an action, such as an MCP tool, Obsidian review gesture, automation binding, or internal Governor call.

Several surfaces may invoke one action. A surface must not redefine the action's scope, effects, authority, verification, receipt, or recovery contract.

## Why the registry is the owner

Tool-shaped architecture drifts. A tool can acquire a new side effect while its documentation, safety classification, UI control, compact-discovery entry, or test matrix remains unchanged. It can also appear through a second surface that bypasses the first surface's wrapper.

The registry instead declares the action once. It generates or validates every surface and projection. The [Capability projection](capability-manifest.md) remains the user-outcome directory; it is not a second execution contract.

## Required action fields

| Field | Meaning |
|---|---|
| `id` | Stable dotted action identity |
| `version` | Contract version for incompatible semantic changes |
| `title` | Plain-language action name |
| `postcondition` | One bounded statement of what becomes true |
| `owner` | Kernel or module responsible for implementation and migration |
| `distribution` | Public default, public optional, private, or excluded |
| `modes` | Read, plan, proposal mutation, mandated mutation, or authority |
| `inputs` | Versioned input schema, including stable and path-addressed targets |
| `targets` | Named, resolved, and discovered target contract |
| `observations` | Information the action may read or return and its durability policy |
| `effects` | Direct, discovered, and authority effects the action may produce |
| `changeClasses` | Possible encoding, presentation, representation, structural, content, and authority effects |
| `scope` | How resolution, enumeration, and disclosure are bounded before reading or writing |
| `planner` | Pure plan contract and staleness behavior |
| `executor` | Live adapter permitted to attempt the effect |
| `verification` | Postcondition and class predicates, versions, coverage, and stale rules |
| `authority` | Human gesture or mandate conditions and whether admission is possible |
| `concurrency` | Queue, revision, transaction, and idempotency behavior |
| `retention` | Ephemeral, evidence, or replayable operation evidence |
| `receipt` | Required human and machine result projection |
| `errors` | Stable typed refusals and failures |
| `recovery` | Inverse, revert, restore, reconciliation, or explicit no-recovery route |
| `dependencies` | Obsidian, platform, host-plugin, and service requirements |
| `degraded` | Behavior for every missing or unhealthy dependency |
| `surfaces` | Eligible MCP, UI, automation, and internal bindings |
| `docs` | Human, agent, developer, security, and submission projections |
| `tests` | Pure, integration, live, adversarial, degraded, and performance evidence |
| `deprecatedBy` | Replacement action or explicit retirement rationale |

## Operation instance

Every invocation creates an operation instance, even when it remains ephemeral:

```ts
type OperationV1 = {
  schema: "governor.operation/v1";
  id: string;
  action: { id: string; version: string };
  surface: { kind: "mcp" | "ui" | "automation" | "external" | "internal"; id: string };
  actor: { binding: string; clientClaim: string | null };
  sessionId: string | null;
  mandateId: string | null;
  normalizedInputDigest: string;
  effectiveScopeDigest: string;
  phase: string;
  observations: string[];
  plan: string | null;
  attemptedEffects: string[];
  observedEffects: string[];
  verification: string[];
  authority: string | null;
  proposalSubject: string | null;
  standingTransition: string | null;
  outcome: string | null;
  recovery: string | null;
};
```

The exact serialized schema is versioned separately from this logical presentation. Actor binding, effective scope, action version, and surface identity come from Governor. A caller cannot choose them by supplying labels in arguments.

## Lifecycle

An operation activates only the phases its action requires:

```text
received → resolved → observed → planned → authorized → queued
         → attempted → effects observed → verified → proposed
         → admitted → receipt produced → closed
```

A read commonly ends after `observed` and `receipt produced`. A preview ends after `planned`. A proposal mutation may end at `proposed`. A Governor-only authority operation may advance through `admitted`.

Skipped phases are explicit and justified by the action definition. A failed, refused, partial, conflicted, or uncertain operation closes with the evidence available; it does not fabricate later phases.

## Observation contract

An action declares:

- which vault data categories it may observe;
- whether it reads named targets, enumerates candidates, or discovers relationships;
- how scope filters before content is read or aggregates are computed;
- what the response may contain;
- whether ordering, truncation, exclusions, and unavailable sources are material;
- its default capture level; and
- whether its observations may support a proposal, verifier, or admission.

Ephemeral observations cannot support governed decisions. The action must re-observe durably before mutation when its plan depends on prior ephemeral data. See [Observations and replay](observations-and-replay.md).

## Effect contract

Effects are observed results, not handler claims alone. An action distinguishes:

- **intended effects** from its plan;
- **attempted effects** dispatched to the live adapter;
- **reported effects** claimed by a handler or dependency;
- **observed effects** established by re-read or supported host evidence; and
- **authority effects** such as admission, revocation, or standing transition.

When Governor cannot observe a possible effect, the action is private, excluded, or returns an explicit uncertain/partial result. A tool result containing `filesChanged` does not become verified evidence merely because it uses the expected field name.

## Surface binding

Each binding states:

- action id and supported version;
- surface identity and distribution;
- argument and result adaptation;
- which human gesture or connection owns invocation;
- availability behavior; and
- lifecycle cleanup.

MCP full-schema mode, compact code mode, Obsidian commands and views, module bindings, external publishers, and internal admission calls all resolve through the same registry and operation executor.

An authority action may be bound only to its trusted human or Governor-internal surface. Registration as an MCP or agent-callable surface fails validation.

## Example

```yaml
id: note.append
version: "1"
title: Append to a note
postcondition: Add one exact tail to a visible Markdown note without altering prior bytes.
owner: notes
distribution: public-optional
modes: [plan, proposal-mutation, mandated-mutation]
changeClasses: [content]
targets:
  named: [path]
  resolvesStableAddresses: true
  discovered: none
observations:
  reads: [target-bytes, target-identity, target-revision, protected-properties, record-status]
  defaultCapture: replayable-in-governed-session
  supportsProposal: true
effects:
  direct: [target-content]
  discovered: none
scope:
  filter: before-read
  hiddenTarget: unresolved
planner: note.append/v1
executor: obsidian.note.append/v1
verification:
  predicate: note.append-preservation/v1
  coverage: every-item
authority:
  proposal: permitted
  automaticAdmission: mandate-required
concurrency:
  queue: vault-singleton
  revision: required-after-read
retention:
  operation: durable-for-mutation
  observation: replayable
receipt: note.append/v1
recovery: review-center-revert
```

The action does not name an authoritative actor or Git author. Governor derives actor binding and creates the operation, proposal, observation, and effect identities.

## Generated projections

The registry generates or validates:

1. surface registrations and adapters;
2. compact discovery metadata;
3. the capability directory and settings directory;
4. module action listings;
5. scope, observation, effect, change-class, verifier, and authority matrices;
6. receipt and error coverage;
7. agent action descriptions;
8. privacy and threat-model inventories;
9. release and Community reviewer inventories; and
10. migration coverage and deprecation warnings.

## Validation rules

A build fails when:

- an action id/version collides or changes incompatibly in place;
- a registered surface has no action definition;
- an action definition has no eligible implementation binding;
- a surface weakens the action's scope, authority, retention, verification, or recovery contract;
- a public action is opaque, unbounded, or missing a recovery posture;
- an action that reads content lacks an observation contract;
- an ephemeral observation can support a proposal, verification, or admission;
- a mutation lacks observable postconditions or explicit uncertainty behavior;
- a caller can provide authoritative actor, signer, verifier, or standing-ref identity;
- an agent surface binds an acceptance, admission, mandate-activation, or other human/Governor-only action;
- runtime registrations and generated projections disagree; or
- deprecation has no migration and closure owner.

## Compatibility migration

Existing tools first enter through a compatibility adapter that derives a conservative operation definition from current registration metadata and preserves the existing handler. Compatibility operations cannot claim replayability, verified effects, or mandate eligibility until those contracts are declared and tested.

New actions use the registry and executor natively. Existing actions migrate in risk order. The compatibility adapter is retired only after bidirectional coverage proves that every live surface resolves to a native action and no legacy handler bypass remains.
