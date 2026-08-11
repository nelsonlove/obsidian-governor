# TODO

## Invert the agent↔skill edge: `parent:` → `skills:`

Filed here because vault-skills is being folded into this repo; the change may land here
rather than there. The same note exists in `obsidian-vault-skills/TODO.md`.

**Today:** in vault-skills, a skill note points up at its agent via `parent:`, and the
transform builds the agent hierarchy by walking that frontmatter tree
(`docs/spec-frontmatter-tree.md`).

**Wanted:** an agent's effective skill set is

    (skills visible up the agent's scope chain) ∪ (the agent's explicit `skills:` list)

Skills are scoped like everything else in the vault, so the common case needs no
declaration at all: a skill in the same bundle or scope as the agent is available to it
automatically. A root-scoped skill is available to every agent — a standard library.
`skills:` is the *additive* mechanism for reaching a skill outside that chain.

**Why.** Containment cannot express sharing. A skill serving three agents must be listed by
all three; under `parent:` it can name only one, and the other two attachments become
invisible. This blocks a genuinely shared skill library.

It also follows from a principle the vault has now adopted: geography is convenience, not
semantics. A skill sitting inside `clipper.agent/` is a filing convenience. `parent:` makes
containment semantic through the back door.

**Consequences:**

- Migration for existing notes carrying `parent:`.
- Orphaned skills largely cease to be a problem: a skill in scope is reachable whether or
  not any agent names it.
- An agent's capability surface is no longer readable from its own note, since most of it
  arrives by scope. "What can this agent actually do?" becomes a computed report.
- `skills:` is purely additive — there is no way for an agent to *narrow* what its scope
  offers. If a restrictive form is wanted later it is a separate field, not an overload.

**Open question for this repo specifically:** the vault is moving to *bundles* — scoped,
self-contained folders of suffix-typed notes (`.agent.md`, `.skill.md`, `.policy.md`,
`.action.md`, `.tag.md`, `.property.md`), with ownership declared by a `bundle:` frontmatter
field rather than by folder location. `bundle:` and `skills:` are different edges and should
coexist: `bundle:` says what a note is packaged with, `skills:` says what an agent composes.
Whatever consumes agent definitions here should read both, and merge neither.

**Context:** `~/obsidian/Bundles design.md` (§9 for this change, §3 for the bundle/scope
model) and `~/obsidian/Conformance module sketch.md` §1.3 for orphan detection.
