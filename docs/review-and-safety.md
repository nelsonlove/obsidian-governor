# Review and safety

> [!note] Target-state document
> This page describes the target product. Not every behavior below is shipped — what IS shipped is owned by [Current release state](status-and-compatibility.md#current-release-state).

Governor treats AI-assisted vault work as a governance problem, not merely a file-access problem. The important question is not only “Can the assistant make this change?” but “Who decided it should have standing, how can the result be checked, and what happens when the operation is wrong or incomplete?”

## The central invariant

An agent may create or revise a proposal and may agree to a delegation from the user (agreeing to work confers no standing). It cannot accept or admit its own work, enlarge its mandate, or choose the evidence that makes an out-of-policy result authoritative.

Acceptance is always a human authority act. The human may accept one exact result, one frozen cohort, or a bounded mandate that authorizes later admission when named verification predicates pass. No agent-facing capability can accept, admit, approve, advance a standing ref, sign a human mandate, or write protected authority state.

This remains true even if a note tells the assistant to mark itself accepted. Note content is untrusted input, not authority.

## Proposal is not draft

Governor separates five axes that are often collapsed:

| Axis | Typical states | Owner |
|---|---|---|
| Development | draft, ready, revision requested | Author and reviewer workflow |
| Verification | unverified, running, passed, failed, stale | Verifier and predicate policy |
| Authority | ungoverned, proposed, admitted, superseded, revoked | Human acceptance and Governor admission |
| Record | working, snapshot, frozen, archived | Records policy |
| Operational | queued, running, blocked, completed | Runtime machinery |

A draft can exist without becoming a governed proposal. A completed operation can produce a proposal that remains unadmitted. An archived record can be authoritative, non-authoritative, or outside the acceptance workflow entirely.

## The review center

The review center is one human surface with distinct sections:

- **Drafts** — work still being developed.
- **Ready for review** — individual proposals and frozen cohorts awaiting a decision.
- **Revision requested** — proposals returned with human feedback.
- **Mandates** — draft, active, exhausted, expired, and revoked delegation.
- **Verification** — full-coverage results, failures, exclusions, stale evidence, and samples.
- **Activity** — grouped operations and replica effects under a mandate.
- **History** — admitted, reverted, expired, revoked, and superseded decisions.

The assistant may read a scope-filtered pending index so it can avoid editing a note under review. An unpublished index must say it is unavailable; it must not appear as a known-empty queue.

## The operation chain in review

Review is organized around the operation chain, not around whichever tool button happened to start it:

1. the registered action and exact operation invocation;
2. the durable observations that supported the plan;
3. the stated intent and proposed postcondition;
4. intended, attempted, and observed effects;
5. verification over the exact resulting subject;
6. the proposal or frozen cohort; and
7. the human authority and Governor admission, if standing is granted.

An ephemeral observation may help with navigation or low-information plumbing, but it cannot support a proposal, verification claim, or admission. Governor must re-observe the required state at evidence or replayable durability before it can enter that chain.

Playback shows what crossed Governor's boundary: registered inputs, the vault state Governor returned or observed, declared and observed effects, and resulting receipts. It does not claim to reconstruct model reasoning, hidden client context, or facts the client obtained elsewhere.

## What a proposal row shows

A review row includes:

- note or affected scope;
- Governor-derived author/session binding plus descriptive client label;
- action id and version, operation id, originating surface, and operation mode;
- session, mandate, cohort, and change class;
- observation capture level, supporting observation ids, and any sufficiency failure;
- agent-stated intent, labeled as an untrusted claim;
- age and staleness;
- change class and consequence overlay;
- current and proposed revisions and subject digests;
- intended, attempted, and observed effects, including the exact diff;
- verifier identity, predicate, coverage, failures, and freshness;
- relevant health or conformance findings;
- recovery route; and
- whether a newer proposal supersedes it.

## Review actions

### Accept

Accepts the exact proposal or frozen cohort currently shown. Governor revalidates its subject digest and verification, records the human gesture, emits an admission attestation, and advances the local standing ref. A changed item aborts admission rather than shrinking or expanding the decision silently.

### Accept mandate

Activates bounded prospective authority. The review center displays delegate binding, purpose, scope, change classes, transformation, limits, verifier policy, admission mode, expiry, and recovery. A later counter-proposal is a new draft mandate; conversation does not modify the accepted one.

### Request changes

Adds human feedback to the revision workflow without conferring standing. The agent may address the request and submit a new proposal. The request and response remain visible until the human disposes of them.

### Revert

Restores the prior admitted content or applies a verified inverse through the human surface. It creates new history and does not erase the original admission. Restoration that could reinstate revoked authority is not an agent capability.

### Defer

Leaves the proposal pending. Deferral is explicit; it does not pretend that silence means approval.

### Expire or supersede

Moves obsolete work into history without accepting it. A replacement proposal links to the one it supersedes.

## Change class and consequence

Change class describes what changes. Consequence describes blast radius, sensitivity, reversibility, confidence, and authority. Both participate in the decision. Read/report work appears in the table for orientation but is not one of the six change classes because it makes no mutation.

| Effect | Examples | Default review behavior |
|---|---|---|
| No mutation (read/report) | Search, validation, health | No proposal |
| Encoding | Line endings, Unicode normalization, equivalent serialization | Full-coverage deterministic verification; cohort or mandate eligible |
| Presentation | Whitespace, wrapping, equivalent visual formatting | Full-coverage semantic/structured equality; cohort or mandate eligible |
| Representation | Move information to its canonical carrier, normalize equivalent schema form | Schema and information-preservation verification; cohort eligible; mandate only for named transformations |
| Structural | Move, rename, or reorganize without semantic change | Identity, collision, link, scope, and recovery verification; cohort eligible for one exact plan |
| Content | Add, alter, or remove meaning | Human substantive review, usually individual or small coherent cohort |
| Authority | Mandate, admission, revocation, protected policy, baseline | Human-only authority path; never hidden in another class |

See [Change classes](change-classes.md). A large or sensitive lower-class cohort may still require a pilot, stronger verification, or a human cohort decision.

## Sessions, mandates, and cohorts

A session groups one bounded workstream. A mandate states delegated authority. A cohort freezes exact proposal items for one verifier and decision.

The review center may start from a session or collection, but it computes an immutable cohort manifest before any decision. Later work is excluded. Mixed classes, failed verification, scope escapes, uncertain effects, and content exceptions are split or blocked.

Three admission modes are available:

1. individual human acceptance;
2. one human acceptance over a fully verified cohort; and
3. Governor admission under a prior human mandate after every named predicate and budget passes.

The third mode removes repetitive clicks without letting an authoring agent accept its own work. See [Sessions, mandates, and cohorts](sessions-mandates-and-cohorts.md) and [Standing and attestations](standing-and-attestations.md).

Automatic mandated admission is limited to fully verified encoding, presentation, named representation, and tightly bounded structural transformations. Content produced under a mandate returns for a human cohort decision; authority always uses a direct human path. The first implementation keeps every mandate in cohort-decision mode until live evidence promotes a named transformation and recovery path.

## Current content and standing

Unadmitted proposals remain visible in Obsidian's working tree. This makes review possible in ordinary note context, but it means current bytes and Governor standing can differ. The review center marks that state and compares current content with the admitted subject. Governor-aware authority projections use the standing resolver; ordinary Obsidian and third-party views continue to show current content unless they integrate explicitly.

Governor distinguishes Governor-originated, local-human-observed, Sync-attributed, and external/unattributed changes. Trusted editor input may advance local human standing under policy. An ambiguous external change does not silently inherit human authority; the user may freeze it into an exact cohort and choose “Treat these as my changes.”

## Review budgets

The default target-state budget is 10 judgment-bearing proposals. When the budget is full, Governor pauses creation of additional governed proposals and explains why.

A budget is not a target to fill. It is a ceiling chosen to keep review debt visible and finite. Operators should tune it to actual review time, not desired agent throughput.

## Grouping and sampling

Changes may be grouped only when they share:

- the same exact change class or allowed class combination;
- the same transformation and human mandate;
- the same bounded scope;
- the same verifier policy;
- the same recovery mechanism; and
- no unresolved errors or consequence escalation.

The review center shows the frozen subject digest, exact item count and affected scope, and per-item receipts. Verification covers every item unless the mandate explicitly permits a sampling predicate for a non-authority claim. A failed sample or full-coverage check blocks admission and invalidates the rule until reviewed.

## Staleness and expiry

A proposal becomes stale after the configured age, 14 days by default. Staleness is a prompt to reassess, not a reason to accept.

Governor may expire a proposal automatically only when a newer proposal explicitly supersedes it under the same target and intent. Other stale proposals remain visible until a human expires, refreshes, or decides them.

## Protected properties

Some properties are declarations a human owns. The accepted family is permanently protected. Administrators may declare additional properties:

- **agent-forbidden** — agents may preserve the exact value but cannot introduce, change, or remove it;
- **authority-conferring** — agent-forbidden, and its value takes effect only through a trusted human authority path and Governor admission.

Configuration may extend the protected set but cannot weaken the acceptance floor.

## Records

A note carrying `record: true` is treated as historical evidence. Governor refuses addressed in-place writes, moves, and replacement. Pure end-of-file append remains the allowed growth operation.

This guard protects against fallible addressed mutations. It does not make record bytes immutable against the operating system, another plugin, link-healing side effects, or a malicious process. Verified history and backups remain the durable protection.

## Successful execution is not proof of correctness

Governor distinguishes:

1. **Transport success** — the request reached the plugin.
2. **Operation success** — the handler completed.
3. **State verification** — a re-read confirmed what landed.
4. **Semantic correctness** — the change matches the intended outcome.
5. **Acceptance** — a human directly or prospectively authorized the exact class of result.
6. **Admission** — Governor recorded that this exact result satisfied the authority and has standing.

A receipt may support the first three. Verification attestations support named aspects of the fourth. Human judgment and mandate policy decide the fifth; Governor enforces the sixth.

## Uncertain and partial outcomes

If a write exceeds its time budget, Governor may abandon waiting while the underlying action continues. The outcome is **uncertain**, not failed. The assistant must re-read before any retry.

If a batch is item-independent, some items may complete while others fail. The receipt names each outcome. Governor does not flatten partial state into one success flag.

## Recovery hierarchy

Use the narrowest trustworthy recovery:

1. do nothing if verification shows the intended state already exists;
2. revert an unadmitted proposal in the review center;
3. apply a bounded inverse operation after preview;
4. restore one note from trusted history;
5. restore a larger scope from a verified backup into a separate test vault first.

Never use broad cleanup as the first response to an uncertain operation.

## Review is an operating practice

A safe review model requires time. A suggested routine is:

- brief daily review of high-consequence and old proposals;
- weekly audit of admitted cohorts, verification failures, and expired work;
- monthly review of mandates, verifier policy, budgets, journal/Git retention, and backup restoration; and
- immediate review after an incident, dependency change, or capability-pack upgrade.

Governor should generate no more governed work than this routine can absorb.
