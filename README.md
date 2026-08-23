# Governor

**Let AI assistants work with your Obsidian vault without giving up control of it.**

Governor is a desktop-only Obsidian Community Plugin that gives a compatible local AI client carefully governed access to the vault open in Obsidian. You can ask the assistant to find, explain, capture, organize, validate, or maintain information. Obsidian remains the visible home of the work, and Governor controls what the assistant can see, what it can change, how results are verified, and which exact results have standing.

Governor was formerly called vault-mcp. The product name is now Governor; the old name appears only where migration history requires it.

The name comes from the **governor in an engine**: a mechanism that regulates speed and output as the load changes. Governor does the analogous job for human-agent work. It does not choose the destination or do the work itself; it keeps the machinery within the authority, pace, and operating limits the person set.

> [!important]
> This is a proposed target-state documentation package. It describes the coherent public product that results when the associated review recommendations are implemented. It is not evidence that every behavior described here is present in a particular build. See [Documentation basis](docs/documentation-basis.md) and [Status and compatibility](docs/status-and-compatibility.md).

## The five-minute mental model

You have two surfaces over the same notes:

- **Obsidian** is where the notes live and where you inspect, edit, link, and review them.
- **Your AI assistant** is a conversational way to work with those notes.

Governor is the boundary between them. It starts with reading only. You decide which folders a connection may access and which classes of change it may attempt. For larger work, you can accept a bounded mandate once, let Governor verify the result, and decide an entire session or collection cohort together. Changes outside that authority remain proposals.

Underneath those human choices, every request becomes an **operation** of one registered **action**. Governor can preserve substantive reads as replayable **observations**, then connect them to the effects, verification, proposal, and authority decision that followed. This lets review answer both “What did it do?” and “What vault information did Governor give it?” without pretending to record the assistant's private reasoning.

You do not need to memorize tools, schemas, file paths, or MCP terminology. Ask for the outcome you want:

- “Find everything related to the house renovation and remind me where I left off.”
- “Add this idea to my inbox, but do not reorganize anything.”
- “Show me how you would merge these three notes before changing them.”
- “Open the proposals that need my decision.”
- “Check this project for broken links and inconsistent properties.”

## Four postures you can understand

Governor presents four ordinary-language postures:

| Posture | What happens |
|---|---|
| **Looking only** | The assistant can search, read, explain, navigate, and validate within its scope. Nothing in the vault changes. |
| **Drafting a change** | The assistant can prepare a plan or preview. It shows the proposed effect without applying it. |
| **Proposing governed changes** | The assistant may create bounded proposals. They have no standing until admitted. |
| **Working under a mandate** | The assistant may perform the exact classes, transformation, scope, and budget you delegated. Governor verifies the results and either presents a cohort decision or admits them under the mandate. |

These are user-facing postures, not a promise that every internal operation has only four states. Finer states remain underneath when they are needed for safety and diagnosis.

## Acceptance belongs to the person

An assistant may propose a change, accept a delegation, negotiate a narrower mandate, revise its work after feedback, and show you exactly what changed. It cannot accept its own proposal, expand its mandate, choose its authoritative identity, or manufacture standing.

**Acceptance is always a human authority act.** You may exercise it over one result, one frozen cohort, or prospectively through a bounded mandate. Governor—not the authoring agent—admits an exact verified result under that authority. There is no agent-accessible accept or admit operation.

That separation is the core guarantee: authorship does not create authority. It also avoids turning governance into hundreds of identical clicks.

## Sessions and cohorts make review scale

Governor groups work without making the group vague:

- a **session** is one bounded body of work;
- a **mandate** is the authority you delegated;
- a **cohort** is the exact frozen set being verified and considered together; and
- a **change class** says whether the effect concerns encoding, presentation, representation, filesystem structure, content, or authority.

You can start from “everything in this session” or “this collection,” drill down to individual notes, exclude exceptions, request one revision across the cohort, and accept the exact verified set once. Later additions are never included in an earlier decision.

## What every durable operation returns

Governor never treats “the command ran” as a sufficient answer. A durable operation ends with a receipt. Reads name the action, operation, scope, sources, capture level, and replay reference when available. A mutation additionally states:

- whether it completed, failed, conflicted, or has an uncertain outcome;
- which notes or scopes were affected;
- what changed in human terms;
- which safeguards applied;
- how the result was verified;
- whether anything still needs review;
- which session, mandate, cohort, and verification apply;
- how to recover or undo the change; and
- where to find the journal record, when available.

If an operation times out after it may have reached the vault, the receipt says **uncertain**. The assistant must re-read before retrying.

## Safe by default

A fresh installation begins in **Looking only**. Before enabling writes, you choose the accessible folders. The first write level is limited to scoped creation and end-of-note appends. Broader edits and structural work require preview and an explicit posture change.

Governor's normal Community Plugin surface does not expose permanent deletion, arbitrary code or generic command execution, plugin installation or removal, unconstrained configuration or CSS writing, destructive imports, unconstrained outside-vault exports, or restoration that could reinstate revoked authority.

Private operators may add separately installed capability packs. Those packs are not part of the public default and are not covered merely because Governor itself appears in the Community directory.

## Installing today (pre-Community-directory)

Governor is not yet in Obsidian's Community Plugins directory (the submission is target state — see [Status and compatibility](docs/status-and-compatibility.md)). To install now:

1. **Build** (or grab a [release](https://github.com/nelsonlove/obsidian-governor/releases) — BRAT-installable):
   ```bash
   npm install && npm run build      # emits main.js (bridge embedded) + manifest.json
   ```
2. **Copy into your vault** and enable it:
   ```bash
   cp main.js manifest.json <vault>/.obsidian/plugins/governor/
   ```
   Then Settings → Community plugins → enable **Governor**.
3. **Connect Claude Code** — run **`Governor: Connect to Claude Code`** from the command palette (one-time; the exact registration line is always in **Settings → Governor** if you'd rather paste it yourself).
4. **Restart any open Claude Code session** — MCP servers load at session start.

Upgrading from ≤0.11 (plugin id `vault-mcp`): disable the old "Vault MCP" plugin FIRST — Governor refuses to migrate while it is enabled and says so; its first load then adopts the old folder's data and leaves a `MIGRATED.md` marker.

## Start in ten minutes

1. Install and enable Governor (see **Installing today**, above — the Community Plugins directory listing is target state).
2. Open **Settings → Governor**.
3. Keep the initial posture at **Looking only**.
4. Use **Connect a local assistant** and follow the client-specific instructions.
5. Choose the folders this connection may access. Start with one low-consequence folder.
6. Ask the assistant to find or explain something and have it open the source note in Obsidian.
7. When you are comfortable, preview a small append or new note.
8. Enable proposing governed changes, apply it, re-open the note, and read the receipt.
9. Accept the proposal in Obsidian. Introduce mandates only after you understand individual proposals and recovery.

You can stop after step 6 and keep a useful read-only system indefinitely.

The detailed walkthrough is in [Getting started](docs/getting-started.md).

## Five ways to use Governor

### Find and orient

Search notes, properties, links, views, and history; recover context after time away; open the exact note or heading used in an answer. This is read-only by default.

### Capture and add

Create a note in an allowed folder or append information to an existing note. Governor shows the destination, verifies the landed content, and returns a receipt.

### Improve and organize

Preview edits, moves, metadata cleanup, and link-aware maintenance. Structural changes show their scope and recovery route before they run.

### Review and decide

Use one review center for individual proposals, sessions, collection cohorts, mandates, verification, and history. Drafts, requested revisions, admitted material, and operational activity remain distinct.

### Check and maintain

Inspect broken links, inconsistent properties, stale derived material, unavailable dependencies, and other actionable health findings without silently “fixing” ambiguous cases.

See the [User guide](docs/user-guide.md) and [Capability directory](docs/capabilities.md).

## What Governor can and cannot protect

Governor adds application-level safeguards: a read boundary, write postures, previews, serialized mutations, revision checks, retry protection, protected properties, a journal, a review center, and recoverable operations.

It is **not an operating-system sandbox**. Community Plugins inherit Obsidian's local privileges, and a malicious local program or another fully privileged plugin may bypass Governor. Use a test vault for development, keep verified backups, review dependencies, and enable only the authority you need.

Governor is desktop-only because its local bridge and some operational storage use desktop APIs. The public configuration is local-first and contains no client-side telemetry. Read [Security](SECURITY.md), [Privacy](PRIVACY.md), [Threat model](docs/threat-model.md), and [Data flow](docs/data-flow.md) before connecting a sensitive vault.

Governor's local Git store is outside Obsidian Sync and retains historical note and attachment bytes from the governed scope, including content later changed or deleted. Configure its scope and retention as you would a sensitive backup.

Replayable observations are also sensitive: they may retain the exact note content or metadata Governor returned during an earlier session. They stay in protected replica-local storage by default, have a separate retention policy, and are not portable-standing Sync data.

## Documentation

- [Documentation map](docs/README.md)
- [Getting started](docs/getting-started.md)
- [User guide](docs/user-guide.md)
- [Vocabulary](docs/vocabulary.md)
- [Action registry](docs/action-registry.md)
- [Observations and replay](docs/observations-and-replay.md)
- [Review and safety](docs/review-and-safety.md)
- [Change classes](docs/change-classes.md)
- [Sessions, mandates, and cohorts](docs/sessions-mandates-and-cohorts.md)
- [Standing and attestations](docs/standing-and-attestations.md)
- [Git, Sync, and portability](docs/git-and-sync.md)
- [Module directory](docs/modules.md)
- [Capability directory](docs/capabilities.md)
- [Settings](docs/settings.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](SECURITY.md) and [Privacy](PRIVACY.md)
- [Agent guide](docs/agent-guide.md)
- [Architecture](docs/architecture.md) and [Developer guide](docs/developer-guide.md)
- [Operator guide](docs/operator-guide.md)
- [Community Plugin submission packet](submission/community-plugin-submission.md)

## Honest limits

- Governor cannot determine whether a judgment-bearing edit is substantively correct; it can make the edit legible and keep acceptance human.
- A scope limits what Governor exposes through its own surface. It does not reduce Obsidian's or another plugin's operating-system permissions.
- An uncertain timeout may have changed the vault. Re-read before retrying.
- Playback covers what crossed Governor's own boundary, not the model's reasoning, complete client context, or information obtained elsewhere.
- Optional integrations can disappear or become incompatible. Governor reports that state explicitly rather than returning a false empty result.
- Review capacity is finite. Governor supports cohorts, full-coverage verification, bounded mandates, budgets, and supersession, but the user still owns the governing judgment.
- Obsidian Sync moves files individually, not as a Governor transaction. A receiving device does not admit a synced cohort until every exact subject and required attestation is present.
- A Community directory listing is distribution and review infrastructure, not a security certification.

## Support, security, and contribution

- For ordinary issues, follow [Support](SUPPORT.md).
- For vulnerabilities, follow [Security](SECURITY.md) and do not disclose sensitive details in a public issue.
- For development and documentation contributions, follow [Contributing](CONTRIBUTING.md).
- An actual submission repository must include its license in a root-level `LICENSE` file, as required by Obsidian's Community Plugin policies.

Your notes remain Markdown files in your vault. Governor uses standard Git objects for local history and portable signed attestations for evidence and standing. Obsidian Sync can continue moving the visible vault normally; Governor's Git database stays outside Sync. Uninstalling the plugin does not convert your notes into a proprietary format. That is the exit guarantee.
