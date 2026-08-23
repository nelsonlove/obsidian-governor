# Support

Governor touches personal notes and coordinates with external AI software, so a useful support report needs more care than “it did not work.” This guide explains what to collect without exposing the contents of your vault.

## Before reporting a problem

1. Stop further writes if the result is uncertain.
2. Re-open the affected note in Obsidian and check what actually landed.
3. Keep the operation receipt, reduced journal entry, and relevant observation/effect references; do not edit them to make the result look cleaner.
4. If data may be at risk, make a verified backup before experimenting.
5. Check [Troubleshooting](docs/troubleshooting.md) for the exact symptom.

## Where to report

- Use the project's issue tracker for reproducible bugs, compatibility problems, and documentation gaps once a publication repository is configured.
- Use the security channel described in [SECURITY.md](SECURITY.md) for vulnerabilities, path-boundary bypasses, acceptance forgery, secret exposure, or other sensitive reports.
- Do not paste private note contents, complete journal files, socket paths containing personal names, API keys, or private vault paths into a public issue.

This target-state pack does not invent a repository URL or support address. The release maintainer must insert the real support destinations before publication and verify that every link works.

## What to include

Include the smallest useful set:

- Governor version;
- Obsidian version and installer version;
- operating system;
- connected client name and version;
- current Governor posture;
- whether a path scope is active;
- capability or user action requested;
- registered action/version, operation id, surface, and observation capture level;
- sanitized session, mandate, cohort, proposal, verifier, and replica identifiers;
- computed change class and standing state;
- exact error identifier and sanitized message;
- whether the receipt says completed, failed, conflict, partial, or uncertain;
- whether the result was reproduced in a clean test vault;
- dependency names and versions for optional modules; and
- concise steps that reproduce the issue.

For a mutation problem, also state:

- which kind of note was targeted, without exposing its full path if sensitive;
- whether a preview was run;
- whether a revision precondition was used;
- whether the note changed when re-read;
- whether retrying was attempted; and
- whether the change arrived through Obsidian Sync and whether portable standing is enabled on this device.

## Redaction guidance

Replace sensitive values consistently so relationships remain visible:

```text
Vault/Clients/Acme/Contract.md  →  Vault/[scope-a]/[note-1].md
uid:019f…                      →  uid:[redacted-1]
agent intent                   →  [intent omitted — contains private summary]
```

Keep error identifiers, timestamps, outcome labels, queue wait, duration, revision and subject-digest relationships, change class, verification coverage, and standing state. Remove note bodies, long property values, account identifiers, private keys, signatures when unnecessary, tokens, and unrelated paths.

Do not attach replayable observation payloads to a public issue by default: they may contain the exact historical note content Governor returned. Start with the payload digest, capture metadata, redaction/truncation state, and integrity or authorization error. Share content only through the private support or security route after reviewing it.

## Uncertain writes are different

A timeout is not necessarily a clean failure. If Governor reports an uncertain outcome:

1. Do not immediately retry.
2. Re-read every named target.
3. Compare the result with the preview or prior revision.
4. Inspect the journal for a later corrective outcome.
5. Use a new recovery operation only after deciding what state the vault is actually in.

A useful report says what the re-read found. “The call timed out” alone is insufficient.

## Compatibility reports

An optional module can be disabled, missing a dependency, incompatible with the current Obsidian version, denied by scope, or temporarily unavailable. Include the availability reason Governor displayed. A clear queue and an unpublished queue are different states; do not report both as “zero items.”

See [Status and compatibility](docs/status-and-compatibility.md) for the compatibility-record format.

## Multi-device and standing reports

When notes and Governor standing differ across devices, report each replica separately:

- device/replica label;
- Obsidian Sync status;
- whether community-plugin data Sync and portable standing are enabled locally;
- cohort state: receiving, ready, admitted, or conflicted;
- missing subject or attestation count;
- current subject digest; and
- whether a Sync merge or conflict file exists.

Do not attach the local Git store or complete attestation ledger to a public issue. Start with sanitized health output and exact digest relationships.

## Security response expectations

Maintainers should acknowledge a private security report, preserve evidence, classify whether a public release is affected, and provide a safe mitigation before public disclosure when practical. The actual response-time commitment must be set by the release maintainer and must not be promised here without operational capacity.

## What support does not promise

- recovery from the absence of backups;
- protection from malicious local software or another fully privileged plugin;
- correctness of third-party agent answers;
- compatibility with unlisted Obsidian or dependency versions;
- support for private capability packs by the public Community Plugin channel; or
- diagnosis from unredacted personal vault exports.

Governor aims to make failures attributable and recoverable. It cannot make every environment or external client supportable.
