# Git, Sync, and portability

Governor uses Git as an internal history and transaction engine while Obsidian remains the user interface and Obsidian Sync remains a supported way to move vault files between devices.

The design is **Sync-compatible, not Sync-dependent**. Governor works without Obsidian Sync, and Obsidian Sync does not become the source of authority for Governor standing.

## What Git does

Governor uses standard Git concepts for:

- content-addressed blobs and trees;
- exact diffs and prior state;
- proposal and session refs;
- atomic reference advancement;
- selective admission and revision chains;
- merging concurrent histories;
- local recovery and time travel;
- compact storage, bundles, and portable inspection; and
- compatibility with existing Git tools.

Agents do not need to know the vault is Git-backed. They request governed operations. Governor creates commits, refs, and metadata after deriving actor and session identity from its own connection state.

Every Governor-created Git object or ref transition links back to the producing operation. Git remains the content-history engine; the operation record explains which registered action ran, which durable observations supported it, and which effects were observed.

Git author and committer strings are never treated as authentication or acceptance.

## Proposal materialization

Unadmitted proposals live in Obsidian's visible working tree so the human can inspect them in normal note context. Governor's admitted baseline and standing refs remain separate.

The review center compares current proposed bytes with the admitted subject and marks affected notes without pretending that every third-party consumer understands standing. Governor-aware agents and authority projections use the standing resolver. Ordinary Obsidian searches, Bases, backlinks, and third-party plugins read current working content unless they explicitly integrate with that resolver.

## What Git does not do

Git does not decide:

- whether a change is presentation, representation, structural, content, or authority;
- whether a verifier is trusted;
- whether a human mandate covers the result;
- whether a proposal has standing;
- whether a Sync conflict preserves meaning; or
- whether an agent should see or change a note.

Those are Governor policy and attestation decisions layered over Git objects.

## Repository placement

Governor keeps its Git object database outside Obsidian Sync's ordinary file set. The recommended Sync deployment uses a separate Git directory with the vault as its working tree. A conventional `.git` directory may be supported for non-Sync or explicitly configured deployments, but Governor never depends on Obsidian Sync carrying it.

One vault-root worktree has one stable, human-chosen **history scope**. Repository identity belongs to the vault, not to a connection or session. A connection's accessible-folder scope controls what that client may see or change; it never expands or contracts content already retained in history.

Setup offers whole ordinary-vault history or explicit included and excluded roots after disclosing that Git retains historical bytes. The recommended vault-as-repository profile tracks ordinary vault content while excluding volatile caches, local secrets, the Git object database, and explicitly private roots. Changing history scope is a human retention decision. Operations crossing tracked and untracked boundaries disclose incomplete history and are ineligible for automatic admission unless their recovery contract remains complete.

This matters because Obsidian Sync always excludes hidden files and folders beginning with `.`, including `.git` and `.gitignore`, except for the active Obsidian configuration folder. See Obsidian's official [Sync settings and selective syncing](https://obsidian.md/help/sync/settings).

Do not place a second file-based sync service around the Git object database. Maintain an independent backup of both the vault and any Governor state needed for recovery.

## What Obsidian Sync carries

Obsidian Sync carries the visible vault files according to the user's Sync configuration. Obsidian documents Sync as file-level: changed files are transferred individually, offline changes are queued, and concurrent edits may be merged or emitted as conflict files. See [Local and remote vaults](https://obsidian.md/help/Obsidian%2BSync/Local%2Band%2Bremote%2Bvaults) and [Sync settings](https://obsidian.md/help/sync/settings).

Governor never assumes that a multi-file cohort arrives atomically.

## Two Sync modes

### Notes-only Sync

Notes and ordinary configuration sync. Each device maintains its own local Git history and imports arriving file changes as external changes.

In this mode:

- notes remain available everywhere;
- Governor does not assume that standing established on one device exists on another;
- a remote arrival that lacks portable authority evidence is visible but unadmitted locally; and
- the user may review or reconcile it on the receiving device.

This is the safest default when plugin data is not synchronized.

### Portable-standing Sync

The user may enable a portable Governor ledger in the Obsidian community-plugin data that Sync can carry when community plugin data synchronization is enabled on every relevant device.

The ledger contains small, immutable, content-addressed mandate, verification, admission, revocation, and effect attestations. It does not contain the Git object database, note bodies, or replayable observation payloads.

Replayable observations stay in replica-local protected storage by default because they can contain the exact note text or metadata returned to a client. A portable attestation may reference an observation digest, capture policy, and verifier claim without carrying the underlying payload through Obsidian Sync. Exporting replay payloads is a separate explicit recovery or audit action with its own disclosure and access check.

Private signing keys never enter the portable ledger or Obsidian Sync. Each signing device keeps its private key in local protected storage; portable envelopes carry only the public key material or key identifiers, signatures, and revocation evidence needed for validation.

The portable ledger is logically an immutable content-addressed envelope set. Each replica writes only to its own append-only segment or partition. Reconciliation performs set union by envelope digest; duplicate and reordered delivery are normal. Mutable indexes can be deleted and rebuilt. Version 1 does not destructively compact the ledger.

Because Obsidian Sync settings are device-specific, Governor checks the local state and reports when portable-standing Sync appears unavailable or incomplete. It never labels a receiving device “fully governed” merely because one device was configured correctly.

## Receiving a synced cohort

On each device Governor:

1. records an arrival-observation operation as files cross the Obsidian boundary;
2. records any resulting local effect and Git history as external or Sync-attributed changes without inventing a human or agent author;
3. reads any newly arrived immutable attestations;
4. validates signatures, mandate, predicate, expiry, and revocation;
5. waits until every cohort subject exists and matches its digest;
6. marks partial arrival as **receiving**, never partially admitted;
7. admits the exact cohort locally only when all conditions hold; and
8. records a local effect receipt.

If the files arrive before the admission attestation, they remain present but not admitted. If the attestation arrives first, it remains pending until the exact files arrive. Order does not create authority.

## Origin classification

Governor records one of four origins without claiming more certainty than the runtime provides:

- **Governor-originated** — bound to the connection and replica-local session that produced the operation;
- **local-human-observed** — an editor-buffer change observed with recent trusted human input; it may establish immediate local human standing under the configured policy, but remains labeled observed rather than cryptographically proven;
- **Sync-attributed** — delivered through replica reconciliation; authority follows matching portable evidence and is never inferred from arrival; or
- **external/unattributed** — another plugin, filesystem process, or indeterminate source; record it in Git, mark changed standing stale, and route it for reconciliation.

The normal public policy trusts local-human-observed editing for usability within the documented same-user threat model. Ambiguous changes can be frozen into an exact cohort and accepted with a lightweight “Treat these as my changes” gesture. Governor never treats every non-Governor write as automatically human.

## Conflicts

A Sync merge or conflict file changes the subject. Previous verification and admission attestations no longer match unless the resulting digest is exactly the admitted one.

Governor therefore:

- never auto-accepts a merged conflict;
- never auto-reverts a Sync-attributed change;
- marks affected standing stale or conflicted;
- preserves both Sync and Git evidence;
- asks for reconciliation against the latest local state; and
- requires new verification and admission for a new subject.

During an active Governor session, a Sync arrival advances the note revision and causes stale writes to fail their revision precondition.

## Rename, deletion, and restoration

A Governor-admitted move is a verified structural transition. An external or Sync move creates a new current subject until that transition is admitted. Deletion preserves historical admission while current standing becomes missing or suspended. Restoring exact earlier bytes still records a new effect and revalidates present policy; restoring changed bytes or path-sensitive meaning requires a new subject, verification, and admission.

## Collection and session atomicity

Git can advance a local proposal or standing ref atomically. Obsidian Sync cannot make a group of files arrive in one transaction. Governor bridges the difference with a cohort manifest and a local admission ref:

```text
files arriving → receiving → complete digest match → local admission ref advances
                     ↘ conflict / incomplete / revoked
```

The visible working tree may temporarily contain a mixed arrival. Governor's standing view does not claim the cohort is admitted until it is complete.

Sessions themselves do not move between replicas. A second device opens a new, linked session with its own actor binding, base state, queue, expiry, and effect receipts. Portable proposals, cohorts, and attestations may reference the relationship without transferring the original live capability.

## Mobile devices

Governor's local bridge is desktop-only. Notes continue to sync and remain ordinary Markdown on mobile. A mobile device may carry visible note changes and, when configured, Governor's portable ledger, but it does not run agent sessions or local admission verification unless a supported Governor runtime exists there.

## Headless Sync

Obsidian's official Headless Sync is currently documented as open beta and is useful for CI and agent workflows. Obsidian explicitly warns not to run desktop Sync and Headless Sync on the same device for the same vault because this can cause conflicts. Governor follows that rule. See [Headless Sync](https://obsidian.md/help/sync/headless).

A headless deployment is a separate replica with its own Governor identity, local Git store, and effect receipts. It must not masquerade as the desktop replica.

## Recovery and backup

Sync is transport, not backup or authority. Keep:

- a backup independent of the live vault and Sync remote;
- the local Git store or exported Git bundles needed for history;
- portable attestation records needed to reconstruct standing;
- key backups and revocation information; and
- tested restoration instructions.

A restoration is performed into a separate vault first. Reintroducing older files does not automatically restore older authority.

## Portability guarantee

Governor does not replace Markdown with a proprietary database. Without Governor, the notes remain readable files. With the portable ledger and standard Git data, a future implementation can reconstruct proposals, authority evidence, and standing without trusting Governor's current UI. Full playback of what a particular replica returned additionally requires that replica's exported observation payloads; portable standing does not imply portable read history.

The portability boundary is deliberately layered:

- Markdown and attachments preserve user content;
- Git preserves content history and diffs;
- signed attestations preserve claims and authority evidence;
- optional exported observation payloads preserve Governor-boundary playback when deliberately retained; and
- Governor policy determines the current admitted view.
