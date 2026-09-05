# Vault Skills — authoring conventions (bundled reference)

A note becomes a Claude Code skill, agent, policy, or slash command when its frontmatter has
`type: skill | agent | policy | command`. Structure lives in **frontmatter, not folders** —
skills and agents declare a single `parent` wikilink and the exporter builds a strict tree;
policies and commands are flat.

## Fields

| Field | Applies | Meaning |
|---|---|---|
| `type` | all | `skill`, `agent`, `policy`, or `command`. Notes without it are ignored. |
| `parent` | skill / agent / policy | A **single** `[[wikilink]]` to the parent **agent**. Omit ⇒ child of the root. A list is an error. Ignored for commands (they're flat). |
| `root` | agent | `true` marks the one root agent. |
| `crosscutting` | agent | `true` ⇒ a horizontal "slot" specialist, fanned into every scope agent's routing (attaches at root). |
| `slot` | agent | Display label for the standard zero a cross-cutting agent serves, e.g. `.00`. |
| `description` | all | Trigger text Claude uses to load / delegate. |
| `name` | all | Base / invocation name (default: filename slug). |
| `tools` | agent | Allowlist, e.g. `[Read, Grep]`. `Agent` is appended when it has children, `Skill` when it owns skills. |
| `model` | agent / command | `sonnet` \| `opus` \| `haiku` \| id \| `inherit`. |
| `argument-hint`, `allowed-tools` | skill / command | Passed through verbatim to the emitted `SKILL.md` / slash command. |
| `id`, `label`, `version` | — | Optional name prefix / breadcrumb label / skill version. |

## The types

**skill** — a repeatable procedure. Its `parent` is the agent that **owns** it (preloaded into
that agent via `skills:`). **No parent ⇒ level 0**, owned by the root and globally invokable —
the only way to share a skill across agents.

**agent** — owns a lane and delegates. Its `parent` is the agent that **delegates to** it (the
parent gets the `Agent` tool + a routing section). Nesting works to 5 levels.
- A **cross-cutting** agent (`crosscutting: true`, `slot: ".0X"`) owns one craft across *all*
  scopes. It's kept out of the vertical lanes and fanned into every scope agent as a
  "Cross-cutting specialist," so any agent can hand it a slot's work for its own scope.

**policy** — not emitted as a file; its **body is injected as shared context** into agents'
prompts. `parent` scopes where it applies: **no parent ⇒ every agent** (global); **`parent:
[[agent]]` ⇒ that agent and its whole subtree**. Use for constants / conventions / operating
rules a scope's agents should always carry.

**command** — a Claude Code **slash command** emitted at `commands/<name>.md`. Flat: no `parent`,
no tree. The note **body is the prompt template** — use `$ARGUMENTS` / `$1`, `!`bash, and `@file`
refs. The slash name is the `name` (or filename); `description`, `argument-hint`, `allowed-tools`,
and `model` pass through. Commands are **user-typed only** (never model-auto-invoked) and share the
`/plugin:<name>` namespace with skills, so a name clash with a skill is renamed with a warning.
Reach for a command when you want a deterministic typed shortcut; reach for a skill when the model
should be able to invoke the capability itself.

## Validation (the exporter enforces)

Single `parent` (a list is an error); parent must be an **agent** (not a skill); acyclic; every
node must reach the root; agents past level 5 warn (unreachable by live delegation).

## Field namespacing

Default is bare top-level fields. If they'd collide with the vault's own frontmatter, plugin
settings offer **prefix** (`vs-type`; a blank prefix = bare) or **nested** (all under one key).
Prefix keeps the `parent` wikilink's backlinks / graph edges.

## Publish

Source of truth is the vault; the generated `skills/` + `agents/` + `commands/` are output —
never hand-edit them. After writing/editing a note: run the **Vault Skills** export in Obsidian
(or the `vault_skills_export` MCP tool), then `/reload-plugins`. Invoke as `/vault-skills:<name>`
(skill **or** command) or `vault-skills:<name>` (subagent); a policy has no invocation — it's
injected.
