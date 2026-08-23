# Troubleshooting

## "Cut over elsewhere; chain absent here" (or "marker unbound")

This machine's vault copy says the authority cutover ran, but the standing chain the marker authorizes is not on this machine — typically a vault restore without its chain backup, or a copy of the vault. Admission answers here are deliberately refused rather than reading as an empty "nothing admitted." Fix: restore the chain backup onto this machine (which restores the authorized identity), or work on the machine that holds the chain. A marker that predates the binding fix shows "unbound" instead — resolve it with the one-time "bind this machine's chain" control, on the right machine only.

## A button in Governor does nothing when clicked

If a Governor control (Accept, Admit, Cut over, adopt-baseline, the auto-accept checkboxes) produces no dialog and no notice, check whether the view lives in a popout window. On 0.15.0–0.17.0 the gesture gate refused clicks from popout windows silently (see [Status and compatibility](status-and-compatibility.md#current-release-state--0170-2026-08-23)); use the main window there. On later builds popout clicks work, and a genuinely blocked click shows a notice instead of doing nothing.

> [!note] Target-state document
> This page describes the target product. Not every behavior below is shipped — what IS shipped is owned by [Current release state](status-and-compatibility.md#current-release-state--0170-2026-08-23).

Start with the symptom. Do not widen scope, enable a private pack, or retry an uncertain mutation merely to see whether the error disappears.

## The assistant cannot connect

Check:

1. Obsidian is open on the desktop and the intended vault is active.
2. Governor is enabled and the local bridge is on.
3. The client registration points to the current Governor bridge.
4. The client session was restarted after registration.
5. The local socket belongs to the current user and is not a stale path from another vault.

If connection still fails, turn the bridge off and on, reconnect once, and collect sanitized client and Governor errors. Do not expose the socket over the network as a workaround.

## A capability is missing

Ask Governor for current capability status. The answer should be one of:

- disabled;
- missing dependency;
- incompatible version;
- outside permitted scope;
- temporarily unavailable; or
- excluded from this distribution.

Reconnect after enabling a module whose surface is built per connection. Do not treat a missing capability as an empty result.

## An action or surface binding is unavailable

A capability may be visible while its registered action version, handler, or surface binding is unavailable or inconsistent. Governor should refuse before execution and name the mismatched action, version, or binding. Reconnect to refresh projections; if the mismatch persists, treat it as registry/runtime drift and stop that path rather than calling a raw handler.

## The target is outside scope

An out-of-scope path or stable identity is refused. Confirm the request used the intended vault-relative path and that normalization did not move it above the allowed folder.

Prefer narrowing the request to the existing scope. Widen scope only after considering the additional private content and mutation blast radius. Reconnect if required.

## Playback is missing, corrupt, or refused

First inspect the operation's declared capture level:

- **ephemeral** intentionally has no durable playback and cannot support a proposal, verification, or admission;
- **evidence** may preserve digests and claims without the full returned payload; and
- **replayable** should resolve to a stored payload unless retention deleted it, integrity failed, or current authorization no longer permits access.

Governor must not re-run the original query against today's vault and call that result playback. If a required replay payload is corrupt or missing, preserve the manifest and digest, stop dependent verification where exact payload evidence is required, and create a new clearly identified observation when current evidence can still serve the task.

## Replay captured too much or crossed scope

Stop new governed reads and preserve the operation metadata without opening the suspect payload further. Narrow the connection scope, disable replay capture for eligible future plumbing reads, and use the audited deletion control after identifying proposal, verification, incident, or recovery dependencies. A capture made before scope filtering is a security defect; follow [Security](../SECURITY.md).

## Observation retention is using unexpected space

Review capture levels, active sessions, review/recovery windows, and payload sizes. Export only the scoped audit evidence you need, then expire eligible replay payloads through the configured retention process. Do not delete the entire operation store blindly: digests, effects, proposals, or verification may still depend on its manifests.

## A write is refused in Looking only

This is expected. Ask for a preview first. If the change is appropriate, enable the smallest write posture that supports it and keep the same narrow scope.

Do not ask the assistant to bypass or reinterpret read-only mode.

## The note changed since the preview

A revision conflict means Governor refused to overwrite a note that no longer matches what the assistant read.

1. Re-read the note.
2. Compare the human or other-agent change with the proposed change.
3. Prepare a new preview against the new revision.
4. Use a new intent if the outcome changed; use a new retry key for a new logical operation.

Nothing should have been written by the conflicted call.

## A write timed out or says uncertain

The operation may still have landed after Governor stopped waiting.

1. Do not retry immediately.
2. Re-read every named target.
3. Inspect the receipt and journal for a corrective late outcome.
4. Compare current content with the preview and prior revision.
5. Decide whether recovery, completion, or no action is appropriate.

An idempotency key is not held for an abandoned timeout. Retrying blindly can repeat the write.

## A batch partially completed

Batch items are independent unless the capability explicitly promises an atomic transaction. Read the per-item results.

- Preserve the successfully written items.
- Diagnose each failed item by its error identifier.
- Re-read before retrying any item.
- Use fresh keys for genuinely new attempts.
- Do not summarize the entire batch as failed or completed.

## A move reports an occupied destination

Governor refuses to overwrite an existing destination.

Inspect both notes, decide which identity and content belong at the destination, and prepare a new plan. Do not delete or displace the occupant automatically unless a reviewed, explicit operation owns that cascade.

## A protected property is refused

An agent tried to introduce, change, or remove a human-owned property. Acceptance fields are permanently protected. Other declared properties may be changed only through the human surface that owns them.

If the operation should preserve an existing value, verify the outgoing content carries it unchanged. If the declaration itself is wrong, change the setting as a human; do not enable an opaque bypass.

## A mandate refuses the work

The current operation does not match the mandate's delegate, session, scope, change class, transformation, verifier, limit, expiry, or recovery condition.

Do not edit the mandate through the agent surface or relabel the work. Inspect the proposed effect. Narrow or split it, let the agent draft a counter-proposal, or accept a new mandate in Obsidian if the broader authority is genuinely intended.

## Verification failed or became stale

A failed verifier found that the claimed invariant did not hold. A stale attestation covered an older subject digest.

1. Open the exact failed items and predicate findings.
2. Confirm the proposal was classified correctly.
3. Exclude content or authority exceptions from a lower-class cohort.
4. Revise the work and freeze a new cohort.
5. Run new verification; do not copy the prior pass forward.

## A record refuses editing or moving

A note declared `record: true` is append-only through Governor. Use a dated end-of-file append for new evidence. If an exceptional rewrite is genuinely required, make a verified backup, review the reason, disable record protection briefly, perform one bounded operation, verify, and re-enable protection.

Remember that link-healing side effects and writes outside Governor may still alter record bytes. Backups remain essential.

## The review queue is growing

Do not solve review debt by indiscriminate bulk acceptance.

1. Pause new judgment-bearing proposals at the budget.
2. Expire proposals already superseded by newer work.
3. Separate drafts and revision work from acceptance decisions.
4. Group genuinely identical classes and transformations into immutable cohorts.
5. Use full-coverage class-specific verification and one cohort decision, or a bounded mandate for future exact cohorts.
6. Narrow agent scope or frequency until review throughput is sustainable.

The queue is an operational workload, not an archive.

## A proposal is stale

Open its source note and compare it with newer work. If superseded, expire it into history. If still relevant, refresh it as a new proposal against current content. Do not silently accept an old diff merely because it has waited a long time.

## Pending review says unpublished

`published: false` means the review index is unavailable or the review module is disabled. It is not a clear queue.

Enable the review center, refresh it, and reconnect if needed. Only `published: true` with a count of zero means a known-empty queue.

## A Base query is slow or unavailable

Base evaluation depends on a supported Obsidian Bases API and the Bases module. Hidden or background Obsidian windows may evaluate large views more slowly.

- Confirm the Base opens normally in Obsidian.
- Confirm the requested view exists.
- Reduce the row limit or narrow the Base filter.
- Bring Obsidian to the foreground for diagnosis.
- Treat a timeout as a retryable read failure; no note was mutated.
- If the API or module is unavailable, use direct note search rather than expecting an empty Base.

## A link-health report and Obsidian disagree

Check the scope. Governor reports visible source notes only. A target outside scope may make absence or link-resolution behavior look different without disclosing the hidden path. Narrow, qualified link text can also reflect basename collisions elsewhere in the vault.

Use the report as evidence of drift, not an automatic repair instruction.

## The journal could not be written

Governor does not roll back a vault mutation merely because audit recording failed. The operation result and the journal-health warning must remain separate.

Stop additional writes if the audit trail is required, verify plugin data storage, preserve console evidence, and back up the affected notes. Resume only when you accept the degraded observability.

## An optional integration disappeared

Confirm whether the host plugin is installed, enabled, compatible, and within scope. Governor should name the missing dependency. Reinstalling or enabling a dependency is a human action; do not authorize plugin lifecycle through the public agent surface.

## A synced cohort is stuck on receiving

Obsidian Sync has not delivered every exact file and attestation, or community-plugin data Sync is disabled on this device.

1. Check Obsidian Sync status and conflict settings on this device.
2. Confirm community-plugin data synchronization is enabled here when portable standing is expected.
3. Wait for Sync to settle; do not force local admission.
4. Inspect the missing subject or attestation list.
5. If a conflict file or merge exists, reconcile it as a new proposal and reverify.

Sync settings are device-specific. A complete source device does not prove a receiving device is configured or current.

## Synced notes are present but standing is local only

This is expected in notes-only Sync mode. The files remain ordinary Markdown, but the receiving Governor has no portable authority evidence. Either review the work locally or enable portable-standing Sync for future immutable attestations. Never infer standing from frontmatter alone when Governor policy requires an admission attestation.

## Git history is missing or unhealthy

Stop new governed writes if recovery or attribution depends on history. Confirm the configured local Git directory exists, belongs to this vault replica, and is outside the Sync file set. Preserve the working vault before rebuilding indexes or importing a bundle.

Do not initialize or copy a second competing repository into the synced note tree as a quick fix. Restore the local store or reconstruct it from a verified vault snapshot and portable attestations.

## Governor seems slow at startup

Disable optional modules one at a time in a test vault, measure startup and first-use separately, and inspect whether a module performs whole-vault work before layout readiness. Report vault size, enabled modules, Obsidian version, and measured timings without attaching note content.

## Uninstall and recovery

Before uninstalling:

1. Stop connected clients.
2. Return to Looking only.
3. Resolve or export important pending proposals.
4. Preserve the local Git store, portable attestations, required observation payloads, operation/effect records, journal, mandates, and standing history according to your retention policy.
5. Make a verified vault backup.
6. Disable and uninstall Governor through Obsidian.

Your notes remain Markdown. Plugin-owned operational files, including replayable observations, may remain under the vault's configured plugin-data or local application-data directories until you remove them deliberately. Review [Privacy](../PRIVACY.md) before removing logs, payloads, or baselines.

## Emergency recovery

If notes appear damaged:

1. Stop Governor and every connected agent.
2. Do not run cleanup tools.
3. Copy or snapshot the current damaged state for evidence.
4. Inspect receipts, durable observations, effect records, journal records, note history, and backups.
5. Restore into a separate test vault first.
6. Compare restored and current content before replacing anything.
7. Record the incident, including which guard or operating assumption failed.

For reporting guidance, see [Support](../SUPPORT.md). For security-sensitive failures, see [Security](../SECURITY.md).
