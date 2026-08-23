# Change classes

Governor classifies a change by what it changes in the knowledge system, not by which function performs it or how many bytes differ. The class determines which verification is meaningful, how work may be grouped, and what kind of human authority is required.

Change class and risk are separate. A thousand encoding changes may have low judgment but high blast radius. A one-word content edit may have tiny blast radius but high consequence.

## The six classes

| Class | What changes | What must remain invariant | Typical examples |
|---|---|---|---|
| **Encoding** | Byte-level serialization | Parsed values, rendered meaning, paths, links, and standing | Line endings, UTF-8 BOM removal, Unicode normalization, equivalent YAML quoting, one terminal newline |
| **Presentation** | How existing information looks to a reader | Claims, relationships, machine-readable values, file identity, and standing | Whitespace cleanup, equivalent list markers, table alignment, wrapping, non-semantic typography |
| **Representation** | Where or how the same information is carried in the note model | The information asserted and its authority | Move a prose value out of frontmatter into its prescribed body section; convert a scalar to the schema's equivalent one-item list; migrate a legacy field to its canonical carrier |
| **Structural** | Filesystem location or containment | Note identity, content meaning, relationships, and standing | Rename or move a note, reorganize a folder, change a collection boundary while preserving identity and healing links |
| **Content** | Facts, claims, interpretation, relationships, or instructions | Only invariants named by the proposal | Add a conclusion, alter a description, remove an assertion, change a link because the relationship itself changed |
| **Authority** | What has standing or what another actor may do | The exact scope and conditions authorized by the human | Accept a mandate, admit a verified cohort, change a protected policy, revoke delegation, advance an accepted baseline |

The names describe semantic effect. They are not ordered formatting levels. Authority is always handled separately even when the same operation also changes content.

## Presentation versus representation

**Presentation** changes appearance while every machine and human interpretation relevant to the vault stays the same.

**Representation** preserves the asserted information but changes its carrier or structured form. It can affect which parser, view, or policy consumes the information, so it needs stronger verification than cosmetic formatting.

Example:

```markdown
---
description: A prose paragraph that belongs in the note body.
---
```

Moving that paragraph into a required `## Description` section is a **representation** change. The same information remains, but it has moved from a property to prose. Aligning a Markdown table without changing any cell is **presentation**.

## Structural means filesystem structure

Structural is reserved for path- and container-level change without semantic change. A rename or move is structural only when stable identity, meaning, link relationships, and authority remain intact.

If a path itself carries meaning or authority, the change is not structural-only. For example:

- moving a note into an archive when archive placement changes its operational status is **structural + content**;
- moving a policy into a scope where it begins to govern agents is **structural + authority**;
- renaming a note while preserving its stable identity and healing links is **structural**.

## Encoding examples

Encoding is the narrowest class. Examples include:

- CRLF to LF line endings;
- removing or adding a UTF-8 byte-order mark under a declared canonical rule;
- Unicode NFC normalization where rendered and parsed text remain equivalent;
- replacing an equivalent YAML quoted scalar with the canonical quoting form;
- removing duplicate terminal newlines while retaining one;
- escaping a character differently where Obsidian and the schema parse the same value.

Key order, section order, and list order are not automatically encoding. They may affect presentation, representation, priority, or meaning.

## Classification rules

1. Classify the actual effect, not the requested verb.
2. A change may carry more than one class.
3. The highest-authority applicable class governs admission.
4. Uncertainty escalates; it never silently downgrades.
5. Classification is evaluated from the proposed diff and relevant schema, not solely from the agent's declaration.
6. If a supposedly mechanical change alters assertions or standing, the cohort is blocked and reclassified.
7. Scale, sensitivity, reversibility, and confidence are recorded separately from class.

## Verification by class

| Class | Minimum useful verification |
|---|---|
| Encoding | Byte rule passes; parsed values, rendered text digest, paths, links, and standing are unchanged |
| Presentation | Semantic and structured representations compare equal; approved render or syntax rules pass |
| Representation | Source and destination carriers satisfy the schema; information-preservation mapping is complete; no duplicate or orphan carrier remains |
| Structural | Stable identities preserved; source/destination and collection membership are correct; collisions absent; links and references remain healthy |
| Content | Diff is complete; required sources and invariants are named; human or qualified substantive review occurs |
| Authority | Valid human mandate or gesture; signer and scope verified; subject digest exact; no forbidden transition; admission recorded |

Verification proves the stated predicate, not universal correctness. An encoding verifier cannot certify that a factual assertion is true.

## Grouping eligibility

Items may enter one cohort only when they share:

- the same change class or exact class combination;
- the same transformation and verifier policy;
- the same mandate and bounded scope;
- the same recovery method;
- compatible base state; and
- no unresolved error or escalation.

Folder or session membership alone is not sufficient. A session containing 590 representation repairs and 10 content rewrites becomes at least two cohorts.

## Examples

| Change | Classification | Why |
|---|---|---|
| Rewrap paragraphs at 100 columns | Presentation, if soft wrapping is not part of meaning | Appearance changes; assertions do not |
| Move `description` prose from frontmatter to `## Description` | Representation | Same information, different carrier |
| Normalize `aliases: Name` to `aliases: [Name]` | Representation or encoding according to the governing schema | The verifier must establish semantic equivalence |
| Rename 600 link notes and heal links | Structural | Paths change; identities and relationships do not |
| Rewrite 600 descriptions for style | Content | Wording may change meaning, emphasis, or omission |
| Add missing stable identifiers | Representation when identifiers merely encode existing identity; authority if they establish a new canonical identity | Consequence depends on the registry contract |
| Mark all proposals in a cohort accepted | Authority | Standing changes, even if note bytes barely do |

## Change-class firewall

Governor does not rely on an agent to keep formatting work away from facts. The proposal builder calculates touched regions, structured fields, paths, and protected state. Class-specific verifiers then test the claimed invariants. Any mismatch blocks cohort admission and produces a reclassification finding.

This is the practical firewall: not a promise that formatting can never affect meaning, but a mechanism that requires evidence before formatting-class authority can be used.

