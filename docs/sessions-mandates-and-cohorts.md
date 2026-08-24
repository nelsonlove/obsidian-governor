# Sessions, mandates, and cohorts

> [!note] Target-state document
> This page describes the target product. Not every behavior below is shipped — what IS shipped is owned by [Current release state](status-and-compatibility.md#current-release-state).

Governor scales review by separating three things that ordinary approval systems often collapse:

- a **session** contains one bounded body of work;
- a **mandate** states what the human has delegated; and
- a **cohort** is the exact set of results being verified and considered together.

This lets a person review one coherent transformation across a collection without granting a blank check or clicking the same decision hundreds of times.

## Session

A Governor session is a durable work envelope, not merely a chat window or process lifetime. It groups the operation invocations, durable observations, declared and observed effects, proposals, verification, and authority state for one bounded workstream. A reconnecting client may resume it on the same replica only by presenting the session capability Governor issued to that client binding.

Sessions are replica-local. Another desktop starts a new globally identified session with its own actor binding, base state, local Git history, queue, expiry, and effect receipts. It may record `continuedFrom` or `relatedSession`, but it does not inherit the original live session capability. Proposals, cohorts, and attestations may be portable; the active execution context is not.

A session records:

- stable session id;
- human principal;
- Governor-derived actor and client binding;
- purpose and scope;
- base revision or state digest;
- governing mandate, if any;
- opened, expiry, and closed times;
- operations, durable observations, effects, proposals, cohorts, verification, and receipts;
- operational state; and
- revocation or incident state.

An agent may suggest a session title or intent. It cannot choose its authoritative actor identity, expand scope, extend expiry, or attach a different mandate.

### Session lifecycle

```text
draft → authorized → active → awaiting verification → awaiting admission → closed
                     ↘ blocked / expired / revoked
```

The lifecycle does not confer standing on the session's output. Standing belongs to exact admitted subjects.

## Mandate

A mandate is the human's bounded delegation. It states what may be attempted and what, if anything, may be admitted after verification.

A mandate authorizes eligible registered actions and operation contracts—not arbitrary tools. A surface may invoke an authorized action only when the resolved action version, requested scope, observation dependencies, effect contract, change class, and limits all fit the mandate. Renaming a tool or exposing another surface does not widen authority.

Every mandate contains:

- **principal** — the human granting authority;
- **delegate binding** — a particular client/session, registered key, or narrowly defined agent role;
- **purpose** — the intended outcome;
- **scope** — notes, collections, paths, or stable identities;
- **allowed change classes** — and prohibited class combinations;
- **transformation** — a named deterministic rule or bounded plan;
- **limits** — item count, bytes, duration, proposals, and failure budget;
- **verification policy** — required verifier, predicate, version, and assurance;
- **admission policy** — human cohort decision or automatic admission under the mandate;
- **recovery** — required baseline and reversal method;
- **expiry and revocation**; and
- **signature or trusted human gesture**.

A mandate does not say “do whatever is necessary.” Unknown targets, open-ended verbs, and unbounded cascades are not valid delegation.

## Negotiation and counter-proposal

An agent may respond to a requested mandate with a narrower counter-proposal. Governor may also identify that the requested authority is broader than the available verifier or recovery path supports.

For example:

> You asked to clean this collection. I can safely normalize the description carrier and list formatting for 612 notes. Rewriting unclear descriptions would be content work, so I propose excluding those 27 notes and returning them for individual review.

The counter-proposal is a draft. It gains authority only when the human accepts it through the mandate surface. An agent cannot interpret continued conversation, silence, or prior approval as acceptance of a changed mandate.

## Cohort

A cohort is an immutable manifest of proposal items selected for one verification and admission decision. It freezes the result subjects and the proposal-producing operation references; it does not freeze every operation or observation from the surrounding session. It may be formed by:

- session;
- collection or folder-note hierarchy;
- vault scope;
- change class;
- transformation;
- verifier result;
- age or proposal state; or
- an intersection of those filters.

The UI may say “all changes in this session” or “this collection,” but the decision always freezes the current exact item list and computes its digest. Work added later is not smuggled into an earlier acceptance.

### Cohort requirements

Every cohort has:

- cohort id and subject digest;
- exact item and file count;
- base and proposed revision for each item;
- change class and transformation;
- session and mandate references;
- scope and collection membership as resolved at freeze time;
- verification policy and results;
- exceptions, failures, and excluded items;
- recovery unit; and
- supersession relationship, if replaced.

Mixed classes are split unless the mandate explicitly allows the combination and the verifier covers every class. Authority changes are never hidden inside a lower class.

## Three admission modes

### 1. Individual decision

The human reviews and accepts one proposal. Use this for unique, ambiguous, sensitive, or content-heavy work.

### 2. Cohort decision

Governor verifies every item and presents one aggregate decision with drill-down. The human accepts or requests revision for the exact cohort in one gesture.

This is the normal answer to hundreds of identical representation repairs.

### 3. Mandated admission

The human prospectively authorizes Governor to admit exact cohorts that satisfy the mandate's verifier and limits. No follow-up click is required for each cohort. Governor, not the authoring agent, performs the admission transition and emits the admission attestation.

Mandated admission is appropriate only for transformations whose invariants can be verified mechanically and whose recovery is established. A sample failure, class escalation, scope escape, stale base, budget breach, or verifier mismatch blocks admission and routes the cohort to the human.

The public automatic-admission allowlist is limited to:

- encoding;
- presentation;
- named representation transformations with complete information-preservation verification; and
- tightly bounded structural transformations whose identity, content, links, scope, and recovery invariants all pass.

Content may be produced under a mandate but returns for a human cohort decision. Authority changes always use a direct human authority path. Mixed-class results split before admission, and any escalation outside the mandate blocks the automatic path.

The first implementation runs even eligible mandates in cohort-decision mode. Automatic admission is enabled only after the same transformation, verifier, and recovery path have passed the required live evidence gate.

Acceptance therefore remains human: it is exercised either at the result or prospectively in the mandate. An agent never accepts its own work.

## Review center behavior

The review center lets the human:

- start from a session, collection, class, or age;
- freeze a cohort and see its exact digest;
- inspect the aggregate transformation and verifier results;
- drill down to any item or diff;
- exclude items and recompute the cohort;
- accept the cohort;
- request one revision instruction for the cohort;
- split the cohort by finding or class;
- revoke the mandate;
- revert an admitted cohort; and
- inspect sampled or fully verified evidence.

“Accept all” never means future work and never means every pending item in an evolving query. It means the immutable subject currently shown.

## Verification before admission

The authoring operation and the verification operation are separate claims. By default, a deterministic verifier or separately bound verifier evaluates the frozen cohort after the author has finished. The verifier identifies the replayable or evidence-grade observations it consumed. It cannot rely on an ephemeral observation, and replaying a prior observation never substitutes for current state when the predicate requires freshness.

The human-facing summary reports:

- what rule was checked;
- whether every item was covered;
- which items failed or were excluded;
- verifier identity and version;
- whether the verifier had access to the necessary source and schema;
- the cohort digest the result covers; and
- whether the result is still current.

A passed verifier result does not automatically authorize admission. It satisfies one condition of the human decision or mandate.

## Revision requests

A revision request can target:

- one proposal;
- a frozen cohort;
- every eligible item in a session; or
- a collection-defined cohort.

The request names the failed invariant or desired correction. The author produces new proposals with new subject digests. Old verification does not carry forward; it becomes stale evidence linked to the superseded cohort.

## Budgets and stop conditions

Mandates and sessions carry budgets for:

- maximum items and changed bytes;
- maximum content- or authority-class items;
- maximum verification failures;
- maximum uncertain or partial outcomes;
- maximum elapsed time;
- maximum open review debt; and
- maximum collection depth or scope expansion.

Reaching a budget is a normal stop. Governor closes or pauses the session and presents what completed, what was admitted, what remains proposed, and what requires a new mandate.

## Example: repairing 600 link notes

1. The user requests consistent descriptions and removal of an accidental prose property.
2. The agent inspects the collection and counter-proposes two transformations: formatting cleanup and moving the property into `## Description`. It excludes notes requiring new prose.
3. The human accepts a mandate for presentation and representation changes in that collection, limited to 650 notes, with schema and information-preservation verification.
4. Governor opens a session and the agent produces proposals.
5. Substantive reads are captured replayably, so review can show what Governor returned as well as what each action did.
6. Governor splits the work into cohorts by transformation and class.
7. The verifier checks every item, quarantining exceptions.
8. The human accepts each verified cohort once—or the mandate admits it automatically if that was explicitly authorized.
9. Governor preserves the exact manifest, producing operations, supporting observation references, verification, admission, and effects; content exceptions remain individual proposals.

The result is bounded delegation with verification, not 600 clicks and not unsupervised authority.
