# `kernel/operations` — the action registry

This package is the first increment of Governor's operation-centric
architecture. It is pure data, types and validation: it imports nothing, not
`obsidian` and not the rest of the kernel, and nothing constructs it at runtime
yet.

## The three nouns

- An **action** is a stable, versioned semantic contract named by its
  postcondition — one bounded statement of what becomes true in the vault.
- An **operation** is one invocation of an action against exact inputs.
- A **surface** is a door onto an action: an MCP tool, an Obsidian command, a
  review-pane button, an automation, an internal call. Several surfaces may
  open onto one action, and a surface never redefines the action's scope,
  authority, retention, verification or recovery contract.

## Files

| File | Role |
|---|---|
| `action.ts` | `ActionDefinition` and its enums; the canonical change-class order |
| `surface-binding.ts` | bindings; `AGENT_REACHABLE_SURFACES`, which the authority fence is defined over |
| `registry.ts` | register / bind / validate; twelve build-failing refusals |
| `compatibility.ts` | conservative contracts derived from existing registrations |
| `inventory-mcp.ts` | the declared MCP surface inventory, 123 rows |

`tests/surface-scan.mjs` and `tests/operations-surface-inventory.test.mjs` are
the inverse half: they read the same facts out of the source and fail the build
when the declaration and the source disagree in either direction.

## Where the governing documents live

The comments in this package cite decisions `D01`–`D18`, a coding-agent
development guide, and normative documents (`architecture`, `action-registry`,
`operation-contract`, `observations-and-replay`, `change-classes`,
`threat-model`, and others).

**Those documents are not yet in this repository.** They are a completed but
still-staged corpus held outside it, and moving the public and developer subset
into `docs/` is its own piece of work, gated on implementation evidence — the
migration is explicit that a claim is promoted to shipped only when the code,
tests and bundle support it, so importing the corpus wholesale now would assert
that a target architecture already exists here.

Until that migration runs, the citations in this package are pointers to the
staged corpus, not to files a reader can open in this checkout. That is a real
traceability gap and it is stated here rather than left for a reviewer to
discover. The short version of what those citations mean:

| Cited as | What it settles |
|---|---|
| D07 | which modules ship public, optional, private or excluded |
| D13 | what exactly is hashed as a proposal or cohort subject |
| D14 | the gate sequence: local authority, then mandates, then portable standing |
| D15 | every invocation is an operation; durability is chosen separately |
| D16 | observations are ephemeral, evidence or replayable; ephemeral supports nothing |
| D17 | playback stops at Governor's own boundary |
| D18 | establish the seam early and migrate incrementally, not a big-bang rewrite |

## What this package deliberately does not do

**It does not grant permission.** A registered action is not an authorized one.
Distribution, module enablement, dependency availability, posture, path scope,
session, mandate and verification all still apply at invocation. The registry
only says the contract exists and which doors open onto it.

**It does not claim more than the code proves.** Every action here is a
`compat.*` contract derived from an existing registration, and `registry.ts`
refuses (`compatibility_overclaim`) any derived contract that claims replayable
capture, proposal support or mandate eligibility. Those claims arrive with
native contracts and their tests, not before.
