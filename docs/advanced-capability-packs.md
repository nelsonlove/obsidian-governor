# Advanced capability packs

Advanced packs add authority intentionally excluded from Governor's normal Community Plugin surface. They are for controlled private deployments, not hidden settings in the public product.

A pack does not inherit trust merely because it uses Governor's bridge. It needs its own manifest, threat additions, installation, enablement, scope, audit, recovery, support owner, and offboarding.

## Pack contract

Every pack declares:

- identity and version;
- operator and support owner;
- capabilities and semantic postconditions;
- why the public surface is insufficient;
- access and consequence class;
- network and outside-vault data flow;
- secret storage;
- human enablement and approval;
- session, mandate, change-class, cohort, verifier, and signer policy;
- path and object scope;
- preview or reason preview is impossible;
- journal and actual-effect limitations;
- backup and recovery prerequisites;
- tests and live evidence;
- incident shutdown;
- uninstall and state deletion; and
- compatibility with the Governor acceptance floor.

No pack may add an agent accept, admit, approve, signer-selection, mandate-activation, or standing-ref operation.

## Installation boundary

Private packs are installed separately from the Community release. The public `main.js` must not contain dormant private code or undeclared network endpoints. The operator verifies pack source, dependencies, release integrity, and compatibility.

Pack settings are human-owned. Agent calls may observe availability and may draft a mandate, but cannot install, enable, widen, trust, or activate a pack or mandate.

## 1. Opaque command execution

### Why excluded publicly

A generic command, macro, or arbitrary script can hide effects Governor cannot preflight, scope, or itemize. Its apparent arguments may not describe the files or authority it changes.

### Private prerequisites

- exact allowlist of command identities;
- source review of each command and dependency;
- no dynamic code download;
- test-vault execution;
- separate human acknowledgement per newly allowed command;
- exact session and short-lived mandate binding;
- acceptance and protected-property audit net;
- backup and incident owner; and
- effects reported as unknown unless independently observed.

### Audit and recovery

Journal the binding identity, arguments digest, Governor-derived actor, session/mandate, and unknown-effects flag. Re-scan changed vault state and review side-door writes. Disable the binding before recovery.

### Offboarding

Remove the allowlist row, reconnect clients, verify the command is absent from discovery, preserve relevant logs, and uninstall the macro dependency if no longer needed.

## 2. Plugin lifecycle

### Why excluded publicly

Installing, enabling, disabling, or removing plugins changes the executable trust base of Obsidian. Official Community policies also prohibit a plugin from installing or updating itself or its dependencies.

### Private prerequisites

- human-selected plugin identity and source;
- release and checksum verification;
- dependency/security review;
- no self-update path;
- explicit distinction between install, enable, healthy, and last successful;
- restart and rollback plan; and
- use of Obsidian's human plugin UI whenever practical.

### Audit and recovery

Record the exact plugin id, from/to version, source, user approval, and post-restart health. Roll back through a retained known-good package and settings backup.

### Offboarding

Disable first, verify no Governor capability depends on it, export state, uninstall through the human UI, reconnect, and confirm dependent capabilities report missing rather than empty.

## 3. Outside-vault export

### Why excluded publicly

Outside-vault paths escape the ordinary note and scope model and may expose secrets or overwrite application configuration.

### Private prerequisites

- fixed real-path allowlist;
- explicit denied roots;
- symlink resolution before policy;
- file-type and overwrite policy;
- dry-run manifest of every output;
- secret scan;
- destination backup and rollback; and
- disclosure of whether outputs sync or leave the machine.

### Audit and recovery

Record real destination paths, digests, overwrite/create status, and source derivation without logging bodies. Restore overwritten files from the captured pre-write copy.

### Offboarding

Disable the pack, revoke destination permission, remove generated outputs only through a separately confirmed inventory, and repoint consumers before closing.

## 4. Import and source disposition

### Why excluded publicly

Imports may read outside the vault, create many notes, transform metadata, duplicate attachments, and delete or move source material. Source disposition is especially difficult to reverse.

### Private prerequisites

- read-only discovery and count first;
- full dry-run import manifest;
- deterministic identity and duplicate policy;
- preservation of source annotations, dates, URLs, and attachments;
- pilot batch;
- no source deletion or move in the same default operation;
- verified source backup; and
- separate human approval for source disposition after vault verification.

### Audit and recovery

Use per-item receipts and a source-to-destination map. On partial failure, preserve both sides and resume idempotently. Remove imported items only from the map after review.

### Offboarding

Disable schedules, preserve mapping and receipts, revoke source access, and decide retention of temporary conversion files.

## 5. CSS and configuration mutation

### Why excluded publicly

CSS can disrupt Obsidian's UI and configuration can change plugin authority, paths, or executable behavior. Free-form writes can also escape the note model.

### Private prerequisites

- dedicated allowed files;
- syntax validation;
- preview diff;
- no secrets;
- backup of prior file;
- human enable/disable control;
- reload verification; and
- emergency safe-mode path.

### Audit and recovery

Record file identity, before/after digest, validation, and reload outcome. Recovery restores the prior file or disables the snippet/config extension from the human UI.

### Offboarding

Disable the feature, restore known-good configuration, remove only inventoried generated files, and verify Obsidian starts cleanly.

## 6. Destructive actions

### Why excluded publicly

Hard deletion has no ordinary undo and can affect attachments or operational records. The public product uses recoverable trash.

### Private prerequisites

- exact item inventory;
- proof each item is recoverable from an independent backup;
- human per-batch confirmation;
- no unresolved links, identity, or ownership ambiguity;
- small pilot;
- no globs or unresolved variables at execution; and
- destruction log retained outside the target set.

### Audit and recovery

Record exact paths and backup references before action. Restore from backup; do not recreate from memory or derived summaries.

### Offboarding

Remove the destructive capability and its credentials. Retain the destruction log under records policy.

## 7. Version restoration and authority

### Why excluded publicly

Restoring old content can reinstate an accepted value or human declaration that was later revoked. The bytes may be opaque until after restoration.

### Private prerequisites

- human-only operation;
- previewable diff from candidate revision;
- accepted/protected-property comparison;
- restoration into a temporary copy first;
- explicit authority decision after content restore; and
- no automatic baseline advancement.

### Audit and recovery

Record source revision, target, diff, authority differences, human decision, and resulting baseline. Recovery restores the immediately previous state from preserved history.

### Offboarding

Disable the restoration pack and keep ordinary read-only history/diff. Human recovery can remain through a reviewed administrative process.

## Private pack review cadence

Review each pack at least quarterly and after every dependency, Obsidian, or Governor upgrade. Ask:

- Is the need still real?
- Can a newer bounded public capability replace it?
- Is scope narrower now?
- Did observed effects match declared effects?
- Are backups and rollback still tested?
- Are secrets and maintainers current?
- Does the pack still remain outside acceptance authority?
- Are its signer, verifier, mandate, Git, and replica assumptions still valid?

The safest high-authority capability is the one no longer installed.
