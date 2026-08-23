# Vocabulary

Governor uses a focused public vocabulary. You can use the product without learning its internal tool names or architecture.

## The terms users may encounter

### Vault

The collection of notes open in Obsidian. Governor serves the running vault, not an abstract folder chosen by an external process.

### Note

A Markdown document in the vault. A note may also have properties, links, attachments, history, and a place in an evaluated view.

### Property

Structured information attached to a note, usually displayed at the top of the note in Obsidian. Examples include status, date, or project. Some properties may be protected so only a human action can change or authorize them.

### Link

A connection written in one note that points to another. Governor uses Obsidian's link-aware move path so a move can heal links the same way an in-app rename does.

### View

A presentation computed from notes, such as a filtered table or cards. A view helps people and agents see information; it does not automatically become the canonical source of the facts it displays.

### Action

A stable contract named by its postcondition, such as “append one exact tail without altering prior bytes” or “move one note through Obsidian's link-aware path.” An action exists independently of the tool, button, or automation that invokes it.

### Operation

One invocation of an action against exact inputs and subjects. An operation may produce observations, a plan, attempted and observed effects, verification, a proposal, an authority transition, and a receipt. Even a read is executed as an operation, although low-information reads may remain ephemeral.

### Observation

What Governor returned from a read operation after applying the effective scope. A replayable observation preserves the exact returned payload and its source state. It proves what Governor supplied, not what a model understood.

### Effect

What Governor observed changing as a result of an operation. Intended, attempted, handler-reported, observed, and authority effects are separate facts.

### Surface

A door onto a registered action, such as an MCP tool, Obsidian control, automation binding, or internal Governor call. A surface cannot weaken the action's scope, authority, verification, retention, receipt, or recovery contract.

### Capability

A user-facing outcome Governor can currently make available, projected from one or more registered actions plus distribution, settings, dependencies, posture, and scope. Capability presence does not itself grant permission.

### Scope

The territory a connection may access. Scope answers **where** the assistant may work. Posture answers **what kind of operation** it may perform there.

### Proposal

An agent-authored change that does not yet have human standing. A proposal can be reviewed, revised, accepted, reverted, superseded, or allowed to expire.

### Acceptance

The human authority act that permits an exact proposal or cohort to gain standing. Acceptance can occur at review time or prospectively through a bounded mandate. It is not an agent capability.

### Admission

Governor's mechanical transition that gives an exact verified subject standing under a direct human acceptance or valid mandate. The authoring agent cannot perform admission.

### Standing

The state in which Governor treats an exact subject as authoritative for a named purpose. Presence, provenance, successful execution, verification, and standing are separate facts.

### Session

A durable, bounded envelope for one body of work. A session binds the actor, purpose, scope, base state, mandate, proposals, cohorts, receipts, expiry, and closure even when the client reconnects.

### Mandate

A human-accepted delegation naming who may act, where, for what outcome, under which change classes, limits, verifier policy, admission rule, expiry, and recovery requirements.

### Cohort

An immutable manifest of exact proposal items frozen for one verification and admission decision. A cohort may be selected by session, collection, scope, or change class, but later work is never added after its digest is calculated.

### Change class

The kind of effect a proposal has on the knowledge system: encoding, presentation, representation, structural, content, or authority. Class determines relevant invariants and verification; scale and risk are recorded separately.

### Verification

A named check applied to an exact subject. Verification proves its predicate—such as information preservation or link health—not universal correctness and not authority.

### Attestation

A signed claim about an immutable subject: who proposed it, what a human mandated, which predicate a verifier checked, why Governor admitted it, or what effect a replica observed.

### Record

Material intentionally preserved as historical evidence. A record normally grows through dated end-of-file appends and is protected from in-place rewriting.

### Review queue

The collection of proposals and frozen cohorts awaiting human attention. The review center presents that queue alongside drafts, revisions, mandates, verification, replica activity, and history without collapsing them into one state.

### Receipt

The human-facing presentation of an operation record: what Governor observed, what changed, which safeguards applied, how the result was verified, what remains uncertain, and how to recover.

### Replica

One local copy of a vault on a device. Obsidian Sync can move files among replicas; each Governor runtime maintains local effect state and admits a synced cohort only when its exact subjects and authority evidence are complete.

## Four postures

These are the only primary posture labels in the public interface:

- **Looking only** — read, search, explain, navigate, and validate.
- **Drafting a change** — plan or preview without applying.
- **Proposing governed changes** — create bounded proposals that remain without standing.
- **Working under a mandate** — act inside an accepted scope, class, transformation, budget, verifier, and admission policy.

A posture is not a user role or a statement about who owns a note. It is the operation mode currently available to the connection.

## Five separate state axes

One of Governor's most important distinctions is that “state” is not one list.

| Axis | Values you might see | It answers |
|---|---|---|
| Development | draft, ready, revision requested | How mature is the work? |
| Verification | unverified, running, passed, failed, stale | Which predicates cover the exact subject? |
| Authority | ungoverned, proposed, admitted, superseded, revoked | What has standing? |
| Record | working, snapshot, frozen, archived | How is it retained? |
| Operational | queued, running, blocked, completed | What is the machinery doing? |

Examples:

- A task can be operationally **completed** while its documentation remains **draft** and its proposal **unverified**.
- A note can be an **archived record** that never gained **admitted standing**.
- A proposal can be **ready for review** in development state and **proposed** in authority state.
- A classified operation can be **completed** and **verified** without gaining standing if no acceptance or mandate covers it.

## Distinctions that prevent mistakes

### Path is not identity

A path says where a note is now. A stable identifier says which note it is across moves and renames.

### Presentation is not authority

A table, summary, generated note, or Base may present facts. It does not become the canonical source merely by being convenient.

### Provenance is not acceptance

Provenance says where material came from. Acceptance says whether a human has given it current standing.

### Success is not correctness

An operation can complete exactly as requested while the request itself was mistaken. Verification checks what landed; review decides whether it is right.

### Registration is not permission

A capability may exist in the product but remain disabled, outside scope, incompatible, private, or excluded.

### Invocation is not evidence

An ephemeral operation proves no durable observation. A proposal, verification result, or admission must cite observations captured at the level its predicate requires.

### Returned is not understood

A replayable observation establishes what Governor returned. It does not establish that the client displayed every byte, that the model attended to it, or that the model interpreted it correctly.

### Unavailable is not empty

A missing dependency, disabled module, or unpublished index must be reported as unavailable. It must not become a convincing zero-result answer.

### Verification is not acceptance

A verifier states that a named predicate passed for an exact subject. The human gesture or mandate supplies authority; Governor admission records standing.

### Session is not identity

A session groups work. Governor derives actor identity from the registered connection and key binding rather than trusting a client-supplied name or Git author string.

### Collection is not cohort

A collection is an evolving organizational scope. A cohort is the frozen exact set selected from it for one decision.

### Sync is not a transaction

Obsidian Sync moves files at file granularity. Governor waits for complete subject and attestation matches before admitting a synced cohort on a receiving device.

## Words you do not need to learn

Developer and operator documents use terms such as revision precondition, idempotency, advisory claim, protected property, conformance debt, disposition substrate, derived artifact, action registry, and capability projection. You do not need them for ordinary use.

They remain controlled terms only when they change a validator, permission, lifecycle, filing decision, retrieval result, receipt, or recovery procedure. A distinction with no operational consumer belongs in explanatory prose, not in the public vocabulary.

## Naming rule

When documentation or UI introduces a new public term, it must answer: **What should the user do differently because this term exists?** If the answer is “nothing,” the term should remain internal.
