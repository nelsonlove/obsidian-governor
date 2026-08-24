# Capability directory

> [!note] Target-state document
> This page describes the target product. Not every behavior below is shipped — what IS shipped is owned by [Current release state](status-and-compatibility.md#current-release-state).

This directory describes what Governor can make available in terms of user outcomes. It is intentionally not a catalogue of every low-level tool. Execution semantics derive from the [Action registry](action-registry.md); runtime availability and this directory are generated through the [Capability projection](capability-manifest.md). The complete family inventory is in the [Module directory](modules.md).

A capability is what a particular audience can ask for. An action is the stable semantic contract underneath it, an operation is one invocation, and an MCP call or UI control is a surface binding. Those distinctions let Governor add surfaces without duplicating authority rules.

## Reading the directory

| Label | Meaning |
|---|---|
| Public default | Available without widening mutation authority; usually read-only |
| Optional public | Part of the Community product but deliberately enabled by the user |
| Private operator | Installed and governed separately; not a Community default promise |
| Excluded | Not exposed through Governor's normal agent surface |

Availability is a runtime fact. An outcome may be disabled, missing a dependency, incompatible with the current Obsidian version, outside scope, or temporarily unavailable. Governor reports the reason.

## Find and orient

| Outcome | Status | Operation | Posture | Scope | Preview and recovery |
|---|---|---|---|---|---|
| Search note text and titles | Public default | Read | Looking only | Visible notes only | No mutation; refine or narrow the search |
| Read one or several notes | Public default | Read | Looking only | Named notes must be visible | No mutation |
| Inspect properties, tags, links, and backlinks | Public default | Read | Looking only | Results filtered before disclosure | No mutation |
| Open a note, heading, link, or search in Obsidian | Public default | Navigation | Looking only | Hidden targets remain unresolved | Close or navigate elsewhere |
| Inspect note history and compare revisions | Public default where host support exists | Read | Looking only | Named note must be visible | No restoration capability in public surface |
| Query an evaluated Obsidian Base | Optional public | Read | Looking only | Base and returned rows are scope-filtered | Missing Bases support is reported, not returned as empty |
| Inspect active note, bookmarks, and workspace context | Optional public | Read/navigation | Looking only | Hidden active notes appear absent | No mutation |

## Capture and add

| Outcome | Status | Operation | Posture | Scope | Preview and recovery |
|---|---|---|---|---|---|
| Create a new Markdown note | Optional public | Scoped mutation | Drafting, then Proposing governed changes | Destination folder must be allowed | Refuses collisions by default; preview; trash or revert proposal |
| Append to the end of a note | Optional public | Scoped mutation | Drafting, then Proposing governed changes | Note must be visible | Preview exact tail; revert or restore prior revision |
| Append to a record | Optional public | Scoped mutation | Drafting, then Proposing governed changes | Record must be visible | Pure end append only; prior entries remain immutable |
| Create several independent notes | Optional public | Batch mutation | Drafting, then Proposing governed changes | Each item checked separately | Per-item result and receipt; partial failure remains explicit |

## Improve and organize

| Outcome | Status | Operation | Posture | Scope | Preview and recovery |
|---|---|---|---|---|---|
| Replace or patch a bounded section | Optional public | Scoped mutation | Drafting, then Proposing governed changes | Note visible and current revision matched | Section diff; revert proposal or restore prior revision |
| Change ordinary properties | Optional public | Scoped mutation | Drafting, then Proposing governed changes | Note visible | Protected properties remain human-only; frontmatter diff |
| Move or rename a note | Optional public | Structural mutation | Drafting, then Proposing governed changes | Source and destination allowed | Dry run; collision refusal; link-aware move; move back if safe |
| Apply a named verified transformation | Optional public | Classified mutation | Working under a mandate | Transformation, class, verifier, limits, and scope pre-authorized | Frozen cohort, full-coverage verification, attestation, and cohort recovery |
| Repoint a known broken link | Optional public | Structural mutation | Drafting, then Proposing governed changes | Scan and target bounded by scope | Dry run shows affected notes; partial scope stated |
| Address or refile notes under a configured scheme | Optional public | Structural mutation | Drafting, then Proposing governed changes | Provider-visible notes only | Plan first; slot answers are computed, not reservations |

## Review and decide

| Outcome | Status | Operation | Authority | Notes |
|---|---|---|---|---|
| List pending proposals | Public default | Read | Agent-readable, scope-filtered | An unpublished review index is reported as unavailable, not empty |
| Inspect a proposal and diff | Public default | Read | Human and agent-readable | Intent is an untrusted author claim |
| Inspect sessions, mandates, cohorts, verification, and standing | Public default | Read | Agent-readable within its scope; human-readable in review center | Actor and authority come from Governor records, not agent labels |
| Request changes | Public review center | Human gesture | Human only | Feedback returns work to revision state |
| Withdraw a revision request | Public review center | Human gesture | Human only | Restores proposal workflow without accepting it |
| Accept or revert standing | Public review center | Human gesture | Human only | No MCP or other agent API exposes these verbs |
| Accept a frozen cohort | Public review center | Human gesture | Human only | One decision covers only the exact digest shown |
| Accept, revoke, or replace a mandate | Optional public | Human-authored policy | Human only | Narrow scope, class, transformation, verifier, budgets, recovery, and expiry apply |
| Admit a verified cohort under a mandate | Optional public | Governor authority transition | Governor only | Authoring agent has no admit verb; every mandate condition must pass |

## Check and maintain

| Outcome | Status | Operation | Posture | Scope | Response |
|---|---|---|---|---|---|
| Report broken links and duplicate identities | Public default | Read/report | Looking only | Visible notes only | Findings, not automatic repair |
| Validate vocabulary and properties | Optional public | Read/report | Looking only | Configured visible sources | Unknown or out-of-scope values remain findings |
| Check derived material for staleness | Optional public | Read/report | Looking only | Artifact and sources visible | Names changed sources; regeneration is separate |
| Run conformance checks against accepted debt | Optional public | Read/report | Looking only | Declared territory only | New, carried, and cleared findings remain distinct |
| Inspect availability and health | Public default | Read/report | Looking only | Does not widen scope | Names disabled, missing, incompatible, or unhealthy state |

## Private operator capability packs

Private packs may add opaque commands, plugin lifecycle, outside-vault export, imports, CSS or configuration mutation, destructive actions, or version restoration. They require their own installation, human enablement, recovery controls, audit posture, and offboarding. See [Advanced capability packs](advanced-capability-packs.md).

## Excluded from the normal public surface

The normal Community Plugin surface does not expose:

- hard deletion;
- arbitrary code or generic command execution;
- plugin installation or removal;
- unconstrained configuration or CSS writes;
- outside-vault export without a separately governed pack;
- import that deletes or moves source material;
- restoration that can reinstate revoked acceptance or authority; or
- an accept, approve, or baseline-advancing agent operation.

## Capability discovery rules

For every outcome, Governor must be able to answer:

- Is it available now?
- If not, is it disabled, missing, incompatible, outside scope, or temporarily unavailable?
- What posture and human setting does it require?
- What may it read or change?
- Can it preview?
- How are concurrency and retries handled?
- What receipt and journal evidence will it produce?
- How can the user recover?
- Is it eligible for the public distribution?

If those answers cannot be generated from the action registry plus its capability/module projections, the capability is not ready to publish.
