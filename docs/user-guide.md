# User guide

> [!note] Target-state document
> This page describes the target product. Not every behavior below is shipped — what IS shipped is owned by [Current release state](status-and-compatibility.md#current-release-state).

Governor is most useful when you describe an outcome and let it choose the bounded operation. This guide is organized around five things people actually do with a knowledge base: find and orient, capture and add, improve and organize, review and decide, and check and maintain.

## A reliable request has four parts

You do not need special syntax. Include these ideas when they matter:

1. **Outcome** — what should be true when the work is done?
2. **Scope** — which notes or folder may be involved?
3. **Posture** — should Governor only look, preview, or apply?
4. **Evidence** — how should it verify and report the result?

For delegated work, add a fifth question: **What boundary would make you comfortable deciding the result as one cohort?**

For example:

> In the Renovation project only, find the current kitchen-lighting decision and the unresolved questions. Looking only: do not change anything. Open the source note you relied on.

## 1. Find and orient

Use this when you remember the subject but not the filename, need to resume a project, or want a source-backed explanation.

### Good requests

> Find my latest thinking about replacing the boiler. Distinguish decisions from open questions and show the notes behind each claim.

> I have not touched Project Atlas in two months. Orient me: current goal, last meaningful change, open tasks, blockers, and the three notes I should read first.

> Which notes mention both the vendor and the revised budget? Open the most recent one.

### What Governor does

In **Looking only**, Governor may search note text, titles, aliases, properties, tags, links, history, and evaluated views that are available within scope. It should explain missing or disabled sources rather than silently treating them as empty.

### How to judge the answer

- Can you open the supporting notes?
- Does it distinguish present facts from interpretation?
- Does it say when evidence is stale, ambiguous, or unavailable?
- Did it stay inside scope?

A durable read has a lightweight observation receipt naming its scope, sources, capture level, truncation or redaction, freshness, and replay reference when available. The assistant should still name the sources and uncertainty in ordinary language.

## 2. Capture and add

Use this when preserving information matters more than perfect filing.

### New capture

> Create a note in my allowed inbox called “Questions for the electrician.” Include these six bullets. Do not classify or move anything else. Verify the final note and give me the receipt.

Governor should show the destination, refuse an occupied path unless replacement was explicitly requested, create the note, re-read it, and report whether review remains.

### Append to a record or running note

> Append this dated observation to the end of the maintenance log. Do not edit previous entries.

For a note declared as a record, end-of-note append is the normal growth path. Editing an old paragraph, inserting under a heading, moving the note, or replacing the whole file should be refused under record immutability.

### The capture principle

Capture can be easy while classification remains deliberate. If the final home is uncertain, use an inbox or provisional location. Governor should not invent a permanent taxonomy merely to make the first write look tidy.

### Verify the receipt

For every capture, check:

- the note exists at the named location;
- existing content, if any, was preserved;
- the requested material landed once;
- links and properties render correctly in Obsidian; and
- the receipt names review and recovery.

## 3. Improve and organize

This category has greater blast radius. Preview first.

### Edit one note

> Preview a rewrite of the “Options” section for clarity. Preserve every factual claim, link, quotation, and personal annotation. Show a section diff; do not apply it.

After approving the preview:

> Apply that exact section change only if the note is still at the revision you read. Re-open it, confirm the rest of the note is unchanged, and give me the receipt.

### Move or rename a note

> Preview moving “Lighting notes” into the Renovation project. Show the destination, any collision, and what happens to links.

A Governor move uses Obsidian's link-aware rename behavior. The receipt should not claim a backlink count the host does not provide. It should say that the move used the link-healing path, then verify the new location and report any link-health finding separately.

### Organize a group

> In this folder only, identify notes that are clearly meeting records and propose destinations. Do not move anything. Group confident mechanical cases separately from judgment calls.

Then apply only a pilot batch. Verify it before expanding. Bulk organization should stop on destination collisions, ambiguous identities, scope gaps, or a full review budget.

For repeated work, ask the assistant to classify it before you delegate:

> In this collection, identify the notes where `description` prose belongs in the `## Description` body section. Propose a representation-change mandate, exclude any case requiring new prose, and tell me how every item would be verified.

The agent may counter-propose a narrower scope or split content exceptions from mechanical representation repairs. You accept the final mandate in Obsidian; the agent cannot broaden it later.

### Preserve annotations

When merging, consolidating, or cleaning up, personal notes, comments, source URLs, dates, and uncertainty markers are content—not clutter. State explicitly when they must be preserved.

## 4. Review and decide

The review center is where the human establishes mandates and where exact verified results gain or fail to gain standing.

### What belongs in each section

- **Drafts** — work still being composed; not an authority question.
- **Ready for review** — proposals or frozen cohorts that require a human decision.
- **Revision requested** — work returned with feedback.
- **Mandates** — active, exhausted, expired, or revoked delegations.
- **Verification** — passed, failed, incomplete, and stale predicate results.
- **Admitted history** — prior decisions, mandate-based admissions, revocations, and their audit record.

These are not interchangeable. A draft is not automatically a proposal, and operational completion does not mean admission or standing.

### Choose the right review unit

You may review:

- one proposal;
- the exact current work from one session;
- a frozen cohort selected from a collection or folder;
- one change class and transformation across a scope; or
- exceptions separated from a larger verified cohort.

“Accept this session” always freezes and displays the exact current items. It never accepts future session work. “Accept this collection” means the exact cohort currently selected from the collection, not every note that may later enter it.

### Review what the assistant saw and did

For substantive work in a governed session, Governor normally preserves the exact information it returned from your vault as replayable observations. The review chain lets you inspect:

- the registered action and individual operation;
- the observation the operation relied on;
- the proposed postcondition;
- intended, attempted, and observed effects;
- the resulting diff and verification; and
- any later admission and standing decision.

This is useful when the question is not only “What changed?” but “What vault information was the assistant given when it decided to propose that change?”

The boundary is precise: playback reconstructs what Governor returned or observed. It does not reconstruct the assistant's private reasoning, its complete conversation, provider-side context, screen contents, or information obtained outside Governor. An ephemeral navigation read is not available for playback and cannot support a proposal, verification, or admission; Governor must observe the needed state durably first.

### A sustainable review session

1. Start with high-consequence or old proposals.
2. Read the agent's intent as a claim, not proof.
3. Inspect the diff and source note.
4. Check whether the proposal is already superseded.
5. Drill down or exclude any exception and let Governor recompute the cohort digest.
6. Accept, request changes, revert, or defer the exact proposal or cohort.
7. Review mandate utilization, full-coverage checks, and any configured samples.
8. Stop when the time or attention budget is exhausted.

If the queue reaches its configured budget, Governor pauses new judgment-bearing proposals. The remedy is review, stronger mechanical verification, a narrower bounded mandate, or scope reduction—not indiscriminate bulk acceptance.

### Three ways to admit work

1. **Individual** — you accept one proposal.
2. **Cohort** — Governor verifies every item and you accept the frozen set once.
3. **Mandated** — you previously authorized Governor to admit exact cohorts that pass the named verifier and limits.

In all three, acceptance is human. In the third, you exercised it prospectively through the mandate. The authoring agent never admits its own work.

## 5. Check and maintain

Maintenance begins with reports, not automatic repair.

### Link health

> Check this project for dangling links, duplicate stable identifiers, and notes missing identifiers. Report only; do not repair anything.

The report names findings it can support. Choosing a new link target or deciding which duplicate identity is canonical remains a human judgment.

### Vocabulary and properties

> Validate the tags and properties in this folder against its declared vocabulary. Group unregistered values, values legal elsewhere but not here, and malformed values. Do not change notes.

This outcome comes from a companion plugin rather than Governor itself: since the S7 satellite extraction the vocabulary tools ship as `vault-vocab`, installed and enabled alongside Governor, which publishes them into the same session. If that plugin is not installed, the tools are simply absent from the session and the request has nothing to answer it.

### Derived material

> Check whether the project summary is stale relative to its declared sources. If stale, name the changed sources and propose a regeneration plan.

### Compatibility and dependencies

> Tell me which Governor capabilities are available now, which are disabled, and which are missing a required plugin or Obsidian version.

“Unavailable” is not the same as “nothing found.”

## Posture selection

| If you want… | Ask for… |
|---|---|
| An answer or health report | **Looking only** |
| A plan, diff, or blast-radius estimate | **Drafting a change** |
| Bounded changes you will decide later | **Proposing governed changes** |
| A repetitive transformation inside explicit scope, class, verification, and budgets | **Working under a mandate** |

When a request is ambiguous, Governor should choose the less authoritative posture and show a preview.

## Reading a receipt

A receipt answers three questions:

1. **What actually happened?** Completed, failed before change, partial, conflicted, or uncertain.
2. **Why should I trust that account?** Named action and operation, session, actor binding, scope, supporting observations, revision, change class, observed effects, verification, attestation, and journal evidence.
3. **What do I do next?** Review, recover, re-read, or no action.

Never treat a successful tool response by itself as proof that the intended change is correct. Read [Receipts and errors](receipts-and-errors.md) for the normative form.

## When to stop

Stop and inspect rather than expanding when:

- a preview includes unexpected notes;
- a dependency disappears;
- the target changed since it was read;
- a timeout makes the result uncertain;
- a batch partially completes;
- the review budget is full;
- a protected property or record guard refuses the change; or
- the assistant cannot explain a safe recovery route.

## Working across synced devices

Obsidian Sync can continue moving your notes normally. Governor's Git history stays outside Sync. If portable standing is enabled, Sync also carries small immutable attestations through community-plugin data.

Because Sync transfers files individually, a receiving Governor may temporarily show a cohort as **receiving**. It admits nothing until every exact file and required attestation matches. A Sync conflict invalidates the old verification for the changed subject and returns it for reconciliation.

You can still read the Markdown on mobile; the desktop-only agent bridge simply does not run there. See [Git, Sync, and portability](git-and-sync.md).

Governor is designed to make stopping a normal success condition—not a failure of autonomy.
