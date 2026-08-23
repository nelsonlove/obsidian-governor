# Getting started with Governor

This guide assumes you know little about Obsidian and nothing about MCP. By the end, you will have asked an assistant to read from a limited part of your vault, previewed a harmless change, created and verified one proposal, accepted it in Obsidian, and understood the receipt. Mandates and batch review come later.

## Before you begin

You need:

- Obsidian on a desktop computer;
- a vault you can back up;
- Governor installed and enabled; and
- a compatible local AI client already able to connect to MCP servers.

Use a test vault for your first setup if the notes matter. Governor adds safeguards, but Community Plugins run with Obsidian's local privileges.

## 1. Understand the two surfaces

Your notes stay in Obsidian. The assistant does not receive a second, authoritative copy of the vault. Governor lets the assistant ask the running Obsidian application for information and, when you enable it, request bounded changes.

Obsidian is where you verify the result. The assistant is where you state your intention.

## 2. Install and enable Governor

1. In Obsidian, open **Settings → Community plugins**.
2. Find **Governor**, install it, and enable it.
3. Open **Settings → Governor**.

Governor is desktop-only. If you read the vault on a phone or tablet, the notes still sync normally, but the local bridge does not run there.

## 3. Stay in Looking only

A new installation begins in **Looking only**. Leave it there.

In this posture, the assistant can search, read, explain, open notes, inspect links and properties, and run report-only checks within its assigned scope. It cannot change the vault.

This is not merely a polite instruction to the assistant. Mutating operations are unavailable or refused at Governor's boundary.

## 4. Connect a local assistant

In Governor settings, choose **Connect a local assistant** and select the client you use. Governor provides the local connection details and a client-specific registration step.

The connection uses a local desktop bridge. It is not a public web endpoint. The configured socket is accessible only to the local account under the target design, but any process running as you may still have substantial local authority. Do not treat the socket as an internet-facing service.

After registering the connection, start a new client session so it discovers the current capability surface.

## 5. Choose a small scope

A **scope** is the part of the vault this connection may see. Start with one low-consequence folder, such as a temporary inbox or a copied project.

Good first scope:

```text
Sandbox/
```

Poor first scope:

```text
the whole vault
```

Governor filters discovery as well as direct reads. A note outside scope should appear unresolved, not “found but forbidden,” so the connection does not learn hidden paths through ordinary lookup.

## 6. Ask your first read-only question

Try:

> Find the notes in this scope about kitchen lighting. Summarize the open questions and open the note that best explains the current decision.

Check three things:

1. The answer identifies its sources.
2. Obsidian opens the expected note.
3. Nothing in the vault changes.

Governor also returns a lightweight observation receipt. It names the read operation, scope, capture level, truncation or redaction, and a replay reference when the response was retained replayably. This records what Governor returned; it does not record the assistant's private reasoning.

You can stop here. Search, orientation, explanation, navigation, history, and validation are useful without enabling any writes.

## 7. Preview a small change

Choose an existing note in the test scope and ask:

> Show me a preview of appending this line to the end of the note: “Ask the electrician whether the dimmer needs a neutral wire.” Do not apply it yet.

Governor enters **Drafting a change**. The preview should state:

- the target note;
- that the operation is an end-of-note append;
- the exact text to add;
- the current revision used for the decision;
- whether review will remain; and
- how the change can be recovered.

If the preview names the wrong note or a broader effect than expected, stop and refine the request.

## 8. Enable the first write posture

In Governor settings:

1. Keep the same narrow folder scope.
2. Enable scoped **create and append** authority under **Proposing governed changes**.
3. Leave broader editing and structural operations disabled.

Authority is both *where* and *what*: scope limits the territory; posture limits the operation mode.

## 9. Apply, verify, and read the receipt

Ask the assistant to apply the preview. Governor should:

1. compare the note with the revision the preview used;
2. serialize the write behind any other active mutations;
3. append the text;
4. re-read the note;
5. return a receipt.

Open the note yourself. Confirm that the original text is intact and the new line is at the end.

A healthy receipt resembles:

```yaml
outcome: completed
operation: append to note
targets:
  - Sandbox/Kitchen lighting.md
change: Added one line at the end; existing content was unchanged.
safeguards:
  - folder scope checked
  - prior revision matched
  - serialized write
verification: Re-read confirmed the appended line.
review: Ready for review
recovery: Revert the proposal from the review center or restore the prior revision.
journal: available
```

The exact transport representation may differ. The human information must not.

## 10. Review the proposal

Open Governor's review center in Obsidian. The proposal appears under **Ready for review** with its scope, author, intent, age, and diff.

You may:

- **Accept** — give the proposal human standing;
- **Request changes** — explain what needs another pass;
- **Revert** — restore the prior admitted baseline or content as a new recorded transition; or
- **Defer** — leave the decision pending without pretending it is resolved.

The assistant cannot press Accept, admit the result, or forge the records that represent standing. Your click accepts this exact proposal; Governor records the admission.

## 11. Learn cohorts before mandates

After several individual proposals, try a repeated mechanical transformation in a test collection. Ask Governor to:

1. classify the change;
2. freeze an exact cohort;
3. verify every item with the relevant predicate;
4. separate exceptions; and
5. let you accept the verified cohort once.

Only then create a mandate that can admit a narrowly defined verified class prospectively. A mandate names its scope, transformation, item and time budgets, verifier, expiry, and recovery. The agent may counter-propose it but cannot activate or expand it.

## 12. Set a review budget before expanding

Before enabling broader writes, decide how much pending work you will review. A reasonable starting policy is:

- no more than 10 judgment-bearing proposals at a time;
- group repeated mechanical changes;
- expire a proposal when a newer proposal supersedes it; and
- pause new governed work when the budget is full.

Safety that produces an unreviewable queue is not a stable operating model.

## 13. If you use Obsidian Sync

Your notes sync normally. Governor keeps its Git object database outside Obsidian Sync. For standing to follow the notes, enable portable Governor state on every relevant desktop and enable Obsidian's community-plugin data synchronization on each device.

Sync settings are device-specific. A receiving device may show a cohort as **receiving** until every file and immutable attestation has arrived. It never treats a partial multi-file arrival as admitted.

## Next steps

- Learn the five workflows in the [User guide](user-guide.md).
- Understand decisions and recovery in [Review and safety](review-and-safety.md).
- Learn [Change classes](change-classes.md) and [Sessions, mandates, and cohorts](sessions-mandates-and-cohorts.md).
- Configure multi-device behavior with [Git, Sync, and portability](git-and-sync.md).
- Choose capabilities in the [Capability directory](capabilities.md).
- Review consequences before changing [Settings](settings.md).
- If something differs from this walkthrough, use [Troubleshooting](troubleshooting.md).
