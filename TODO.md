# TODO

## Invert the agent↔skill edge: `parent:` → `skills:`

Filed here because vault-skills is being folded into this repo; the change may land here
rather than there. The same note exists in `obsidian-vault-skills/TODO.md`.

**Today:** in vault-skills, a skill note points up at its agent via `parent:`, and the
transform builds the agent hierarchy by walking that frontmatter tree
(`docs/spec-frontmatter-tree.md`).

**Wanted:** an agent note declares `skills:` — a list of the skills it composes. The edge
points down instead of up.

**Why.** Containment cannot express sharing. A skill serving three agents must be listed by
all three; under `parent:` it can name only one, and the other two attachments become
invisible. This blocks a genuinely shared skill library.

It also follows from a principle the vault has now adopted: geography is convenience, not
semantics. A skill sitting inside `clipper.agent/` is a filing convenience — the agent's
`skills:` list is the truth. `parent:` makes containment semantic through the back door.

**Costs, both accepted:**

- A skill no agent lists becomes possible, where `parent:` prevented it structurally.
  Orphan detection moves to the vault's conformance module (not yet built).
- Migration for existing notes carrying `parent:`.

**Open question for this repo specifically:** the vault is moving to *bundles* — scoped,
self-contained folders of suffix-typed notes (`.agent.md`, `.skill.md`, `.policy.md`,
`.action.md`, `.tag.md`, `.property.md`), with ownership declared by a `bundle:` frontmatter
field rather than by folder location. `bundle:` and `skills:` are different edges and should
coexist: `bundle:` says what a note is packaged with, `skills:` says what an agent composes.
Whatever consumes agent definitions here should read both, and merge neither.

**Context:** `~/obsidian/Bundles design.md` (§9 for this change, §3 for the bundle/scope
model) and `~/obsidian/Conformance module sketch.md` §1.3 for orphan detection.
