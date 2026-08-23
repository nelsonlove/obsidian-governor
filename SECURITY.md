# Security policy

Governor provides application-level controls for AI access to an Obsidian vault. It does not turn Community Plugins into sandboxed programs and does not reduce the privileges of Obsidian, another plugin, or software already running as the local user.

## Reporting a vulnerability

Before publication, the maintainer must configure a private security-reporting destination in the repository and replace this paragraph with the exact route. Use that private route for:

- path-scope bypass;
- acceptance or protected-property forgery;
- mandate, verifier, attestation, admission, or signer forgery;
- arbitrary code reachable from the public surface;
- unauthorized outside-vault access;
- local socket exposure beyond the documented boundary;
- secret or note-content leakage;
- journal or review evidence tampering; or
- dependency compromise.

Do not include sensitive vault content in a public issue. For an ordinary bug, follow [Support](SUPPORT.md).

## Supported releases

Security fixes are provided for the current public release. If the project adopts a longer support window, it must be declared here with exact version ranges and maintained in [Status and compatibility](docs/status-and-compatibility.md). This target-state pack does not invent a support duration that has not been operationally committed.

## Security goals

Governor is designed to:

- start with no vault-write authority;
- restrict Governor-mediated discovery and mutation to user-selected vault scopes;
- apply scope and capture policy before retaining or returning observations;
- distinguish read, preview, proposal, and authorized mechanical postures;
- route every invocation through one registered action and operation boundary;
- serialize mutations and detect stale writes;
- make ordinary retries safe within a bounded window;
- prevent agents from conferring acceptance, self-admitting results, forging identity, widening mandates, or changing declared human-owned properties;
- bind proposals, verification, and standing to exact immutable subjects;
- journal reduced operation metadata separately from explicitly replayable observations;
- keep dangerous and opaque operations outside the normal public surface;
- make missing dependencies and degraded safeguards explicit; and
- preserve a clear recovery route.

## Trust boundaries

### Trusted for product operation

- the human operating Obsidian;
- the running Obsidian application and supported public APIs;
- Governor's installed release assets after integrity review;
- local filesystem and plugin-data storage to the extent the operating system provides them;
- human-authored settings, mandate decisions, and review gestures;
- registered signer and verifier keys under the configured trust policy; and
- Git and attestation validation to the extent the local runtime and key store remain intact.

### Constrained but not fully trusted

- connected AI clients and their generated tool arguments;
- note content, including instructions embedded in notes;
- optional plugins that publish capabilities;
- third-party dependencies; and
- agent-authored intent descriptions, identity labels, Git metadata, mandate drafts, and change-class claims.

### Outside Governor's security boundary

- malicious software running as the user;
- a malicious or compromised Community Plugin with Obsidian's privileges;
- operating-system or hardware compromise;
- physical access to an unlocked machine;
- the privacy and retention behavior of the chosen AI provider; and
- writes performed directly on disk or through surfaces Governor does not mediate.

## Safe defaults

- **Looking only** on first installation.
- No vault content visible until the user chooses a scope.
- Create and append off until explicitly enabled.
- Structural mutations off until explicitly enabled.
- Review center on.
- Human-only acceptance floor always on.
- Governor-only admission floor always on; exact mandate and verification required.
- Record immutability on.
- Raw command execution, plugin lifecycle, hard deletion, destructive import, outside-vault export, and authority restoration absent from the public surface.
- No client-side telemetry.

## Local bridge

Governor's bridge is local to the desktop. The target design uses a per-vault local socket stored with owner-only permissions and does not listen on a public network interface.

This protects against casual network exposure, not against another process already running as the same user. Treat client registration as granting the client the Governor capabilities and scope you enable.

## Prompt injection and untrusted notes

Content read from a note is data. It cannot change Governor settings, widen scope, enable a capability pack, activate or widen a mandate, accept or admit a proposal, select a trusted signer, or override a protected-property refusal.

The assistant should summarize suspicious embedded instructions and continue under the user's stated objective. Governor enforces the operations and properties it can enforce structurally; it does not claim to make a language model immune to manipulation.

## Operation controls

Every invocation resolves a registered action and passes through one governed operation path. It applies, as relevant:

- posture and scope checks;
- stable-address resolution;
- observation capture and dependency policy;
- protected-property and record guards;
- serialized execution;
- revision preconditions;
- idempotency checks;
- bounded timeouts and uncertain-outcome handling;
- reduced-argument journaling;
- post-operation verification and receipt production;
- intended, attempted, and observed effect recording;
- session and Governor-derived actor binding;
- change-class validation and mandate budgets;
- Git proposal recording; and
- signed verification and admission attestations.

Broad operations require preview. Destructive or opaque operations are excluded from the public surface because their effects cannot be bounded or reviewed with the same confidence.

## Third-party actions and capabilities

A third-party plugin may publish an action and claim that its projected capability is read-only. Governor treats that claim as untrusted unless the user explicitly trusts the exact publisher and binding. An untrusted claimed-read operation receives conservative mutation handling and may be unavailable in Looking only.

Trust is exact by plugin identity and takes effect on a new connection. Trusting a plugin does not make its code safe; it acknowledges that the user reviewed its assertion.

## Journals are sensitive

Governor's journal omits note bodies and collapses long arguments, but it may contain paths, stable identifiers, client names, timing, operation names, intent, and outcome. Protect, retain, export, and delete it as sensitive metadata.

A journal-write failure does not roll back an otherwise completed vault write. Governor must surface degraded audit health so the user can stop or continue knowingly.

## Replayable observations are more sensitive

Replayable observations may preserve the exact note body, metadata, result set, or workspace information Governor returned at a particular time. They live in a protected replica-local observation store, are content-addressed, have explicit retention, and are not included in portable-standing Sync by default.

Scope filtering and redaction happen before capture. Playback rechecks current authorization and returns the stored payload; it does not silently re-read the vault and call the result historical. An ephemeral observation cannot support a proposal, verification, or admission. If durable evidence is unavailable or corrupt, the dependent claim fails closed or Governor performs a new clearly identified observation.

## Git history is sensitive

The local Git store contains historical note and attachment bytes from the governed scope, including material later edited or deleted. Keep it outside the Obsidian Sync file set, restrict local access, include it deliberately in backup/retention policy, and never attach it wholesale to a support report. Narrowing the live scope does not erase old objects.

## Backups and recovery

Before enabling mutation:

- maintain a backup independent of the live vault and its sync provider;
- verify the backup has recent files and non-zero size;
- test restoring into a separate vault; and
- preserve note history or version control when appropriate.

Governor's Git history, attestations, review state, and journal help diagnose and reverse work. They are not substitutes for backups. Obsidian Sync is transport, not backup or transactional admission.

## Git, signatures, and Sync

Governor stores its Git object database outside Obsidian Sync's ordinary file set. Git commit author and committer strings are untrusted labels. Governor actor binding comes from the registered connection and session; cryptographic keys identify attestation signers.

Portable-standing mode may sync immutable attestation envelopes through community-plugin data. A receiving replica validates signature, subject digest, mandate, predicate, expiry, and revocation, and waits for all cohort files before advancing local standing. Partial Sync arrival or a conflict never becomes partial admission.

Private signing keys remain in local protected storage and are never written to the portable ledger, Git objects, notes, journals, or synced plugin data.

## Dependency and release security

Every public release should:

- use a committed package-manager lock file;
- minimize dependencies and audit changes;
- inspect the generated `main.js` for secrets, unexpected network endpoints, telemetry, and bundled test code;
- publish source and matching release assets;
- run adversarial path, acceptance, protected-property, retry, timeout, and degraded-dependency tests;
- verify supported Obsidian API usage and lifecycle cleanup; and
- retain a rollback path.

See [Testing and release](docs/testing-and-release.md) and the [release checklist](submission/release-checklist.md).

## Security non-claims

Governor does not claim:

- operating-system sandboxing;
- isolation from another Community Plugin;
- correctness of agent reasoning;
- confidentiality from the connected AI provider;
- protection of signing keys from same-user compromise in the normal posture;
- exactly-once mutation across an Obsidian restart;
- byte-level immutability of records;
- complete audit evidence after storage failure;
- playback of model reasoning, hidden client context, or information obtained outside Governor;
- full historical playback after an eligible observation payload has been deleted under retention policy;
- that Community directory publication is a security certification; or
- atomic multi-file delivery by Obsidian Sync.

The detailed analysis is in the [Threat model](docs/threat-model.md).
