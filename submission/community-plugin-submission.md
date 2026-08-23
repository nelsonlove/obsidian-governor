# Governor Community Plugin submission packet

This document is the proposed submission narrative for Governor. It maps the target-state product to current official Obsidian Community Plugin requirements. It does not claim that the plugin has been submitted, approved, or that release evidence not attached to an actual release exists.

## Submission summary

**Display name:** Governor  
**Plugin id:** `governor`  
**Platform:** Desktop only  
**Category:** AI tools / developer tools / productivity, subject to the directory's available categories  
**License:** MIT in the current source repository  
**Source model:** Public source repository  
**Telemetry:** No client-side telemetry  
**Core network use:** None by Governor; optional Obsidian Sync transport is operated by Obsidian under the user's separate configuration  
**Outside-vault access:** Local socket, local Git object database, keys, reduced operation journal, replayable observation/effect stores, and plugin-owned operational files; no unconstrained public agent file access  
**Account/payment:** Governor requires neither; the chosen AI client or provider may  

Proposed manifest description:

> Govern local AI work in your vault with scoped access, verified changes, reviewable sessions, and human-controlled acceptance.

## Product boundary submitted for review

The Community distribution includes:

- a canonical action registry and one operation executor used by MCP, UI, automation, module, and internal bindings;
- scope-filtered search, reading, metadata, links, navigation, history, and health;
- evidence and replayable observation capture after scope filtering, with replica-local playback and retention controls;
- a local MCP bridge to the running desktop Obsidian application;
- safe-first posture and explicit folder scope;
- scoped create and append after enablement;
- preview-first bounded edits and structural moves;
- serialized writes, revision preconditions, retry safety, declared/observed effects, and reduced audit journal;
- Git-backed local proposals, diffs, and recovery outside the Sync file set;
- durable sessions, semantic change classes, bounded mandates, and immutable cohorts;
- human-controlled acceptance with Governor-only admission;
- signed subject-bound verification and admission attestations;
- Obsidian Sync compatibility with optional portable standing and no partial cohort admission;
- protected properties and record safeguards;
- optional read/report modules with explicit dependency state; and
- standard verification receipts.

It excludes from the normal agent surface:

- permanent deletion;
- arbitrary code and generic command execution;
- plugin installation, update, or removal;
- unconstrained configuration or CSS mutation;
- unconstrained outside-vault export;
- import that deletes or moves source material; and
- restoration that could reinstate revoked authority.

Separately installed private capability packs are not part of the submitted bundle or public feature claim.

## Official source set

This packet uses current primary official sources:

- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [Manifest reference](https://docs.obsidian.md/Reference/Manifest)
- [Obsidian October plugin self-critique checklist](https://docs.obsidian.md/oo/plugin)
- [Official plugin security guidance](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Plugin%20security.md)

These official sources were re-opened on 2026-08-20. The maintainer must re-open them immediately before submission because directory process and policy can change.

## Requirement mapping

### Public repository and source

Official submission guidance requires a GitHub repository accessible to the directory review process. The target submission uses the public `obsidian-governor` repository with source, lock file, build configuration, documentation, and release history.

**Release evidence required:** repository URL resolves without authentication; default branch contains the submitted manifest; source corresponds to release bundle.

### Root files

Official guidance requires root-level:

- `README.md` explaining purpose and use;
- `LICENSE`; and
- `manifest.json`.

The current repository has a README and MIT license. Before submission, the target-state README from this suite must replace or reconcile the existing README, and the release manifest must be present where the directory processes it.

**Release evidence required:** default-branch file listing and link check.

### Manifest

The manifest must include required fields and follow naming rules. Target values:

```json
{
  "id": "governor",
  "name": "Governor",
  "version": "<matching semantic release>",
  "minAppVersion": "<oldest release-tested Obsidian version>",
  "description": "Govern local AI work in your vault with scoped access, verified changes, reviewable sessions, and human-controlled acceptance.",
  "author": "Nelson Love",
  "isDesktopOnly": true
}
```

Angle-bracketed fields are release decisions, not values to copy literally. `id` contains lowercase letters only, does not contain `obsidian`, and does not end with `plugin`. `Governor` avoids prohibited product-name terms. The description is under 250 characters and ends with a period.

**Release evidence required:** manifest schema check, uniqueness confirmation through the submission interface, and version reconciliation.

### Desktop-only status

Governor uses desktop APIs for its local bridge and operational storage, so `isDesktopOnly` is `true`. The listing explains that notes remain readable and syncable on mobile even though the bridge does not run there.

### Semantic version and release assets

The official process requires a semantic `x.y.z` manifest version, a GitHub release with a matching tag, and attached `main.js`, `manifest.json`, plus optional `styles.css`.

**Release evidence required:** tag/manifest equality; asset names; asset digests; install from release in a clean vault.

### Minimum app version

`minAppVersion` must be the oldest Obsidian version the release actually supports. Governor's use of Bases and other newer APIs must be feature-gated when the core product supports an older floor.

**Release evidence required:** tested version matrix and feature-degradation results.

### Short description

The official requirement caps plugin descriptions at 250 characters, requests simple action-oriented language, correct capitalization, and a final period. The proposed description meets those editorial requirements.

### Sample code and naming

Before submission, remove sample-plugin identifiers, sample settings, default hotkeys, redundant plugin-name command prefixes, and unused example code.

**Release evidence required:** source and bundle search results.

## Developer policy mapping

### No obfuscation

The release bundle may be minified but not obfuscated to conceal purpose. Source remains available and maps coherently to the bundle.

### No client-side telemetry

Governor includes no client-side telemetry, usage analytics, advertising tracking, or crash reporting in the target public bundle. Dependency and bundle review verifies this.

### No self-install or self-update

Governor does not install or update itself or its dependencies. Plugin lifecycle capabilities are excluded from the public agent surface. Users install and update through Obsidian's Community Plugin mechanism.

### Network disclosure

Core Governor uses a local socket and makes no Governor-operated remote request. A connected AI client may use its provider; the README and Privacy policy make that boundary explicit. Any future public network integration requires manifest, README, privacy, and data-flow disclosure before release.

### Outside-vault file disclosure

Governor uses outside-note-tree operational storage for its local socket, settings, install identity, local Git database, keys, reduced journal, operation and effect records, replayable observation payloads, attestation ledger, review indexes, and standing refs. The Git database contains historical copies of note and attachment bytes from the configured governed scope, including content later changed or deleted. Replayable observations may contain the exact scope-filtered note content or metadata Governor returned during a prior operation. These are local plugin operations, named in README, Privacy, Data flow, and Git/Sync documentation. The public agent surface cannot browse or write arbitrary outside-vault paths.

Obsidian Sync always excludes `.git`; Governor therefore keeps its local Git database outside the Sync file set and does not depend on Sync carrying Git history. Optional portable-standing mode writes small immutable attestations to community-plugin data. The user must enable that Obsidian Sync data category per device.

Replayable observation payloads are replica-local by default and are not written to portable-standing Sync. Export or deletion is an explicit, scoped, recorded operator action.

### Accounts and payments

Governor requires no account and no payment. The user supplies a compatible AI client, whose account or payment terms are separate.

### Licensing

The repository includes an MIT license. Release review verifies dependency license obligations and required attribution.

## Official API and quality posture

The [official self-critique checklist](https://docs.obsidian.md/oo/plugin) informs code review. Target implementation practices include:

- `Vault.process` for background edits;
- `FileManager.processFrontMatter` for properties;
- `FileManager.trashFile` for recoverable deletion;
- `Vault`/`FileManager` over raw Adapter where possible;
- `normalizePath` for user paths;
- `Plugin.loadData()`/`saveData()` for settings;
- configured `Vault.configDir`, not hard-coded `.obsidian`;
- lifecycle registration and cleanup;
- layout-ready initial UI;
- deferred-view compatibility as required;
- sentence-case, accessible UI; and
- no default hotkeys.

**Release evidence required:** source review map and automated lint/test results. This document does not claim every current call site already conforms.

## Security architecture for reviewers

Review should focus on:

- per-connection capability construction;
- registered action and surface-binding validation plus one operation executor;
- local bridge permissions and absence of network listener;
- scope filtering before read;
- scope filtering and redaction before observation capture, with explicit ephemeral/evidence/replayable policy;
- shared action-registration and operation-executor boundary;
- accepted-family and protected-property transition guard;
- Governor-derived actor and session binding rather than caller/Git author identity;
- mandate validation, change-class firewall, immutable cohorts, and full-coverage predicates;
- signer/verifier trust, signed attestations, Governor-only admission, and standing refs;
- Git-store placement and Sync replica reconciliation;
- opaque-operation exclusion;
- queue, revisions, and idempotency;
- journal minimization and failure behavior;
- replay payload integrity, playback authorization, retention, deletion, and the Governor-only trace boundary;
- in-app human-only review gesture; and
- clean separation of private packs from the bundle.

See [Reviewer notes](../submission/reviewer-notes.md) and the [Threat model](../docs/threat-model.md).

## Performance and lifecycle

The release captures startup, first connection, large-vault search, queue, Bases, review refresh, and connect/disconnect memory evidence. Every hidden view, socket, interval, event, and child component has lifecycle cleanup.

**Release evidence required:** measured environment and results, not an unqualified “fast.”

## Submission process

Under the current official process:

1. Sign in at [community.obsidian.md](https://community.obsidian.md).
2. Connect the maintainer's GitHub account.
3. Publish the matching GitHub release and commit the accurate manifest to the default branch.
4. Add the repository through the Community directory submission form.
5. Address automated review guidance with a new semantic version and matching release.
6. Review the directory safety scorecard for each version.

Obsidian automatically scans plugin versions for vulnerabilities, code-quality issues, and malware. Manual reviews continue for popular, featured, and flagged plugins. Directory publication is not a guarantee that the plugin is harmless in every vault.

## Actual-submission gate

Do not submit until:

- target-state public boundary is implemented and manifest-generated;
- private/excluded code is absent from the bundle;
- README, LICENSE, manifest, SECURITY, and PRIVACY are final;
- every required test and live evidence item is attached to the release record;
- version contradictions are resolved;
- migration and predecessor retirement are closed;
- clean-vault onboarding succeeds;
- local links and disclosures pass review; and
- support and private security-reporting destinations are real and monitored.

This packet makes the submission requirements concrete; it does not waive the evidence gate.
