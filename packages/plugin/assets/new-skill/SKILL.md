---
name: new-skill
description: Scaffold a new vault skill, agent, policy, or slash command note in the Vault Skills convention. Use when the user wants to add a new skill, agent (including a cross-cutting one), policy, or slash command to their Obsidian vault (which the vault-skills exporter turns into a Claude Code skill / agent / injected context / slash command).
---

# Author a new vault skill, agent, policy, or command

Writes a new note into the **source Obsidian vault** in the Vault Skills frontmatter
convention. Create the note here, then re-export + reload to make it live.

Full field & rule reference is bundled next to this skill —
`${CLAUDE_PLUGIN_ROOT}/skills/new-skill/conventions.md`. Read it if anything below is unclear.

## 1. Locate the vault

Read `${CLAUDE_PLUGIN_ROOT}/.vault-skills-manifest.json` and use its `vault` field (the absolute
path of the source vault this plugin was generated from). If missing / null, ask the user.

## 2. Gather the inputs

- **type** — `skill`, `agent`, `policy`, or `command`?
- **name** — short, kebab-case (the invocation name; a policy doesn't need one).
- **description** — trigger text Claude uses to load / delegate (skills & agents); a short label
  for a command; not needed for a policy.
- **parent** — a single wikilink to the parent **agent** (skills / agents / policies; commands are
  flat and take no parent):
  - a **skill's** parent is the agent that *owns* it (omit ⇒ shared / global at level 0);
  - an **agent's** parent is the agent that *delegates to* it (omit ⇒ child of the root);
  - a **policy's** parent *scopes where it applies* — omit ⇒ injected into **every** agent;
    `[[agent]]` ⇒ that agent and its whole subtree;
  - to create the *root* agent, set `root: true` and no parent (only one root).
- **cross-cutting?** (agents only) — if it's one craft across *all* scopes (a surveyor, a
  triager), set `crosscutting: true` and `slot: ".0X"`; it becomes reachable from every scope agent.
- **command extras** (commands only) — the **body is the prompt template** (`$ARGUMENTS`, `$1`,
  `!`bash, `@file`); optional `argument-hint`, `allowed-tools`, `model` pass through.
- **body** — the SKILL.md body (skill), the system prompt (agent), the prompt template (command),
  or the shared context to
  inject (policy).

To pick a parent, list existing agents (`type: agent` notes in the vault, or
`${CLAUDE_PLUGIN_ROOT}/agents/`). Constraints: a single wikilink to an **agent**; acyclic;
reaches the root; ≤ 5 levels. (Details in the bundled `conventions.md`.)

## 3. Write the note

Folders don't affect structure — pick the parent's folder or ask. Write `<vault>/<folder>/<name>.md`:

```md
---
type: <skill|agent|policy|command>
parent: "[[<parent-agent>]]"          # omit to attach to the root; commands ignore it
description: <trigger text>            # skills & agents (label for a command)
# agent-only: name, tools: [Read, Grep], model, crosscutting: true, slot: ".01"
# command-only: name, argument-hint, allowed-tools, model  (body = prompt template)
---

<body — SKILL.md body / agent system prompt / policy context to inject>
```

Use `Write`. Do **not** write into `${CLAUDE_PLUGIN_ROOT}` — that is generated output; the
source of truth is the vault.

## 4. Publish

1. In Obsidian: run the **Vault Skills** export (ribbon icon or *Export skills & agents to
   Claude Code*), or call the `vault_skills_export` MCP tool.
2. In Claude Code: `/reload-plugins`.

Then confirm invocation: `/vault-skills:<name>` (skill), `vault-skills:<name>` (subagent). A
policy has no invocation — it's injected into its scope's agents' prompts.
