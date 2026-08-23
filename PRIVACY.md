# Privacy policy

Governor is local-first. Its public target-state configuration does not include client-side telemetry and does not send vault content to a Governor-operated server. A connected AI client may send content to its own provider; that separate data flow is controlled by the client and provider, not by this plugin.

## Data Governor may process

Within the user-selected scope, Governor may process:

- note paths, names, Markdown bodies, and attachments when a capability requires them;
- frontmatter properties, tags, links, aliases, and metadata;
- Obsidian view results and workspace context;
- revision tokens and note history exposed by supported local features;
- user settings and capability availability;
- agent-supplied arguments, intent, and non-authoritative labels;
- Governor-derived session and actor bindings;
- review proposals, cohorts, mandates, verification, standing, decisions, and revision feedback;
- Git content history and refs;
- signer key identifiers, signatures, attestations, and revocations; and
- operation timing, outcome, and reduced audit metadata;
- observation manifests, result digests, capture policy, redaction metadata, and effect records; and
- exact Governor-returned read payloads when replayable capture applies.

Governor should read the minimum needed for the requested outcome. A scope is both a privacy boundary and a mutation boundary for Governor-mediated operations.

The connection scope is not the Git history scope. Setup separately asks which ordinary-vault roots history may retain and discloses that Git can preserve earlier bytes after a file changes or disappears. A client cannot widen that human-chosen retention boundary.

## Local data flow

The normal public path is:

```text
local AI client ↔ local Governor bridge ↔ running Obsidian ↔ vault and plugin-owned local state
                                                   ↘ local Git, operation, observation, effect, and attestation stores
```

Governor does not require a Governor account, payment service, analytics endpoint, or hosted content service in this target design.

## The connected AI provider

Governor cannot control what a connected client sends to its model provider, how that provider retains prompts, or whether an enterprise policy applies. Before connecting a sensitive vault:

1. review the client's and model provider's privacy terms;
2. choose a local or approved enterprise configuration when required;
3. start with a narrow scope;
4. avoid sending unnecessary note bodies; and
5. inspect client logs separately from Governor's journal.

Governor's “local bridge” does not mean the AI model itself is local.

## Network use

Governor's core public operation uses a local desktop connection. If an optional public integration uses the network, the action registry, capability projection, and README must name:

- the remote service;
- the data categories sent;
- why the network is required;
- the trigger and default state;
- authentication and secret storage;
- retention or server-side telemetry; and
- how to disable and delete the integration's state.

An undeclared network endpoint is a release blocker.

Private capability packs may add network or remote transport. Their policies do not become part of the Community default merely because they interoperate with Governor.

## Outside-vault access

Governor keeps its socket, journal, replayable observation payloads, effect records, install identity, local Git object database, signing-key registrations, review indexes, standing refs, and operational state in local application or plugin-owned storage. Those locations are outside the ordinary note tree but exist to operate and audit the plugin.

The public agent surface does not provide unconstrained outside-vault file access or export. A private pack that does so must disclose exact roots, data, purpose, triggers, retention, and recovery.

## What is stored

| Data | Location | Contents | Retention |
|---|---|---|---|
| Settings | Governor plugin data | Posture, scopes, module config, trusted plugin identities | Until changed or plugin data is removed |
| Install identity | Governor plugin data | Random persistent identifier for journal attribution | Life of the installation |
| Write journal | Governor plugin data, monthly files | Operation, target metadata, reduced arguments, actor, timing, outcome; no note bodies | User-defined; prune whole months |
| Operation and effect store | Local Governor state | Registered action/version, invocation inputs after reduction, dependencies, intended/attempted/observed effects, outcomes, and references | Audit and recovery policy |
| Replayable observation store | Protected replica-local Governor data outside ordinary notes | Exact Governor-returned payloads after scope filtering and redaction, content digests, queries, timestamps, and playback metadata | Session review/recovery window, then configured local retention |
| Review baseline and history | Governor plugin data | Accepted snapshots or hashes needed to produce diffs and recover standing | Until retention policy removes them |
| Local Git store | Application-appropriate local data outside the Sync file set | Full historical note and attachment bytes captured by configured scope, content-addressed objects, proposal/session/standing refs, and diffs | User-defined; retain and prune with recovery and records policy |
| Attestation ledger | Local Governor state; optional immutable portable copies in synced community-plugin data | Mandates, verification, admission, revocation, signer ids, digests, and signatures; no note bodies | Authority and records policy |
| Pending review index | Governor plugin data | Scope-filterable path and review metadata | Rebuilt; removed when review publishing is disabled |
| Coordination receipts | Governor plugin data when module enabled | Per-install read positions | Until module state is cleared |
| Notes | Vault | User-authored and agent-proposed Markdown | User-controlled |

## Obsidian Sync

Governor is compatible with Obsidian Sync but does not operate or control it. Sync transfers vault files through the user's Obsidian account under Obsidian's privacy and encryption model.

The Git object database is not sent through Obsidian Sync. If the user enables portable standing and community-plugin data synchronization, small immutable attestation files may sync. These can reveal paths or stable identifiers, session and mandate purpose, signer key ids, verifier results, timestamps, and authority history even though they omit note bodies. Treat them as sensitive metadata.

Private signing keys are not portable-ledger content and must not be stored in synced plugin data. Only public key material or key identifiers, signatures, and revocation records may travel with attestations.

Git history can retain earlier or deleted note content after it disappears from the working vault. Removing a note, narrowing scope, or uninstalling Governor does not by itself purge old Git objects or backups. The UI and retention documentation must make that consequence visible before Git-backed history is enabled.

Sync configuration is device-specific. Governor reports when portable authority evidence is incomplete rather than inferring that all devices share the same standing state.

## Journal minimization

Governor records what operation happened, where, on whose asserted connection, and with what outcome. Note bodies and long values are replaced by length markers or digests. This reduces sensitivity but does not make the journal anonymous.

Agent intent may summarize private work. Treat it as sensitive and keep it concise.

## Observation capture and playback

Governor distinguishes three capture levels:

- **ephemeral** — returned to the caller but not retained as durable evidence;
- **evidence** — preserves claims, scope, digests, and metadata needed for audit without necessarily storing the complete payload; and
- **replayable** — preserves the exact Governor-returned payload so a human can later inspect what crossed Governor's boundary.

Substantive vault reads in governed sessions are replayable by default. Ordinary durable reads outside such a session default to evidence. Low-information navigation and plumbing may be ephemeral. Scope filtering, truncation, and redaction occur before capture.

Replayable does not mean Governor records the model's reasoning, prompt, private client memory, provider transcript, screen contents, or data the client acquired elsewhere. External client traces may be linked as untrusted supplemental records, but Governor does not adopt them as its own evidence.

Playback access is checked when requested. The stored payload is returned with its digest and capture metadata; Governor never re-runs the read against current vault state and presents it as the historical result.

## Telemetry

Governor includes no client-side usage analytics, behavioral tracking, crash telemetry, or advertising telemetry in the public target-state distribution.

If the project later adds server-side telemetry, it must be optional where feasible, disclosed in the README, documented here before release, and compliant with current Obsidian Developer Policies. Client-side telemetry remains prohibited for Community Plugins.

## Secrets

Secrets must not be written into notes, journals, generated examples, or synced configuration unless the integration's documented design explicitly requires and protects them. Use operating-system or provider-supported secret storage. Redact tokens and private endpoints from support reports.

Governor does not encrypt the vault. Its signing keys authenticate small mandate, verification, admission, and revocation claims over digests. Private signing keys remain in operating-system protected storage. An optional encrypted recovery export protects only a key backup and must remain outside the live vault and Obsidian Sync.

## Retention and deletion

Users can:

- narrow or clear path scopes;
- disconnect clients;
- disable modules and remove their operational indexes;
- prune whole journal months after preserving required incident evidence;
- inspect and delete eligible replayable observation payloads after checking proposal, verification, incident, and recovery dependencies;
- export a scoped observation audit bundle before retention expiry when continued playback is required;
- remove review history according to records policy;
- export or prune Git and attestation state under the documented authority and recovery policy; and
- uninstall Governor through Obsidian.

Uninstalling the plugin leaves the Markdown vault intact. Plugin-owned state may remain in the vault's configured plugin directory or application data until the user removes it. Back up and inspect that state before deletion if pending proposals, replayable observations, journal evidence, or recovery baselines matter.

## Support data

Do not send a complete vault or journal by default. Follow [Support](SUPPORT.md) to preserve useful relationships while redacting note bodies, personal paths, identifiers, intents, and secrets.

## Children, accounts, and payments

Governor itself requires no Governor account and no payment in this target design. Any connected AI provider or optional integration has its own eligibility, account, and payment terms.

## Changes to this policy

A release that changes data categories, network destinations, telemetry, outside-vault access, or retention must update this policy, the action registry, and the generated capability projection before release. The migration note must explain the change and how an existing user can remain on the prior privacy posture or remove newly introduced state.
