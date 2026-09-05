# The vault-skills plugin — compiling vault notes into a Claude Code plugin

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md). Since the S4 satellite extraction (`docs/suite-split-design.md` §6), this reference documents the standalone `vault-skills` plugin, not a module of the host plugin (`governor`).


The `vault-skills` plugin (default off, mutating) compiles the vault's `type: skill` / `agent` /
`policy` / `command` notes into a Claude Code plugin on disk: `skills/<name>/SKILL.md`,
`agents/<name>.md`, `commands/<name>.md`. Three read tools (`vault_skills_validate`,
`vault_skills_tree`, `vault_skills_preview`), three mutating (`vault_skills_export`,
`vault_skills_release`, `vault_skills_mark`).

Files: `packages/skills/src/kernel/` (pure compiler — `transform.ts`, `exporter.ts`, `transclude.ts`,
`assets.ts`, `skills-config.ts`, `skills-source.ts`, `static-skills.ts`), `packages/skills/src/tools.ts`
(the six tool specs, the Obsidian adapter `obsidianSkillsBackend`, and the accept guard `guardSkillsMark`),
`packages/skills/src/wiring.ts` / `pane.ts` / `commands.ts` / `export-trigger.ts` / `version.ts` (the
in-Obsidian human surface), and `packages/skills/src/settings.ts` / `settings-tab.ts` (its own settings
plus the one-shot adoption) — all under `packages/skills/`, alongside `assets/new-skill/` and `tests/`.

## Now a satellite plugin

This capability shipped as the host plugin's `skills` module through 2026-08; as of the S4 extraction it is its own Obsidian plugin, id `vault-skills`, publishing its tools to the host through the `vault-mcp-api` SDK's `publishTools` — exactly like the `quickadd-choices-compile` pilot satellite. It is no longer a `modules.skills` entry in the host's module registry.

The six tool names are unchanged on the wire — `vault_skills_validate`, `vault_skills_tree`, `vault_skills_preview`, `vault_skills_export`, `vault_skills_release`, `vault_skills_mark` — because the plugin id `vault-skills` sanitizes to `vault_skills`, and the host publishes an external tool as `<sanitized owner id>_<bare name>`, so the spellings survive the move exactly.

**Allowlist posture.** The host distrusts an external tool's `readOnlyHint: true` claim unless the publisher's raw plugin id is in the host's `trustedReadOnlyPlugins` setting, so all six tools register as MUTATING regardless of their own read/write nature. The host also BLOCKS OUTRIGHT any mutating external tool whose arguments carry no recognized path key while a path allowlist is active. Five of the six (validate, tree, preview, export, release) carry no path argument, so under an allowlist they are refused wholesale — strictly stricter than the old in-module body filtering. Only `vault_skills_mark` carries `path` and is scoped normally. The in-tool visibility filter (which uses `isVisible`, now published in `@vault-mcp/core`) is retained inside the satellite as defence in depth, and does nothing without host settings, which nothing supplies today.

**Settings adoption.** The satellite reads the host's `modules.skills.config` ONCE on first load and copies the recognized keys into its own `data.json`, then latches (`adoptedFromHost`). It never writes the host's settings. The satellite's own values win where it already has one. If the host is absent, nothing is adopted and the latch is not set, so the one chance survives to a later load.

## The output is flat

Compiled names come from each note's own `name:` (or filename), deduped — not from its position
in the `parent:` tree. So a compiled skill sits at `skills/<name>/SKILL.md` whatever it hangs
off, and a compiled agent may invoke any skill in the plugin through the Skill tool (unless it
is locked out of the Skill tool entirely — see `no-skills:` below). Sharing a skill between
agents needs no special construction: it is the default state of the emitted plugin, and it
holds whatever a note's `parent:` says.

What the tree still decides: the **breadcrumb** prefixed to a listing description, the **level**
(depth past 5 is warned — live delegation stops nesting there), **policy lineage** (which agents
a `type: policy` body is injected into), and **validation** (edges must resolve; cycles and
unreachable chains are errors).

## `parent:` — an organizational edge, multi-valued

`parent:` may name more than one agent.

- The **first** parent is **primary**: the tree edge. It drives breadcrumb, level, ownership
  (`skills:` in the tree report), and every other tree-derived value, exactly as a single parent
  did before #292.
- The **rest** are recorded **attachments**: a second organizational/provenance edge saying
  "this belongs to that agent too." An attachment moves nothing in the tree and changes no
  compiled path. It is reported by `vault_skills_validate` / `vault_skills_preview` (an
  `attachments` array of `{name, kind, path, primary, extra, preload}`) and on the tree nodes
  (`extraParents` on the attached note, `attached` on the agent).

Every named parent is validated the same way, primary or extra: it must resolve to a note, and
that note must be an agent. A dangling or non-agent parent is an error and the note is not
emitted. A parent listed twice warns and attaches once. An extra parent that failed its own
validation is dropped with a warning rather than invalidating the note that named it.

`type: policy` notes keep the strict single-parent rule on purpose: a policy's parent decides
which agents its body is compiled into, so a second parent would mean a second injection site
rather than a recorded attachment.

## `preload:` — context provisioning, not a permission boundary

An agent's compiled `skills:` frontmatter is a **preload** list. Claude Code's subagent
reference says it plainly: the field "controls which skills are preloaded, not which skills the
subagent can access," and "Subagents can still invoke unlisted project, user, and plugin skills
through the Skill tool." Listing a skill injects its full text into the subagent's context at
startup; omitting one withholds context, not access.

So the compiler emits `skills:` from an **opt-in** per skill, not from attachment:

```yaml
# a skill note
type: skill
parent: ["[[Vault operations]]", "[[Conformance]]"]
preload: true     # this skill is preloaded into BOTH of those agents
```

- `preload: true` on a skill ⇒ it appears in the `skills:` list of every agent it is attached to
  (primary parent or extra — attachment is the union).
- No opted-in attachments ⇒ the agent gets **no `skills:` key at all** (not an empty list).
- Attached-but-not-opted-in skills are still named in the agent's body, under "attached to you
  but not preloaded — invoke them with the Skill tool," which is what actually happens.
- One platform constraint is enforced at compile time: a skill with `disable-model-invocation:
  true` is dropped from the preload set with a warning, because preloading "draws from the same
  set of skills Claude can invoke" — Claude Code would skip such an entry anyway.

**The anti-pattern guard.** Preloading a whole scope spends the fresh context window that
delegating to a subagent exists to provide. The compile therefore WARNS — it does not refuse;
the vault decides — when one agent's preload set exceeds the module's `preloadCap` config
(default 5), naming the agent and the count. The warning shows up in `vault_skills_validate`,
`vault_skills_preview` and the export summary alike, and the report's `preloads` array carries
`{agent, path, skills, overCap}` per agent.

## `no-skills:` — the one real boundary

The platform offers exactly one way to stop a subagent invoking skills: keep the `Skill` tool
away from it. `no-skills: true` on an **agent** note compiles that:

```yaml
type: agent
no-skills: true      # compiles →  disallowedTools: [Skill]
```

`disallowedTools` is the deny form, and it is the safe one here: per the subagent reference it
is applied before `tools` resolves, so denying `Skill` leaves the agent's other tools alone. The
alternative — an allowlist that omits `Skill` — would also omit everything the list forgot to
mention, since `tools` when present is exhaustive (omitting `tools` inherits every tool
available to subagents). The compiler therefore adds no `tools` list of its own for the lockout,
and it stops appending its usual structural `Skill` entry to an agent that has one.

A locked-out agent emits no `skills:` list and no Skills section in its body. Two authoring
contradictions warn rather than being silently resolved: `no-skills` on an agent that has
opted-in attached skills, and a hand-written `tools:` list containing `Skill` alongside
`no-skills` (the deny wins).

Scope note: this restricts the compiled subagent's Skill *tool*. It is a per-agent switch in the
emitted plugin, not a claim about anything else the agent can reach.

## Config

The `vault-skills` plugin's own settings tab (formerly rendered as `modules.skills.config` in the host's config tab — see "Now a satellite plugin" above for the one-shot adoption path): `outputDir`, `pluginName`, `typeSource`
(`frontmatter` | `tags`), `tagPrefix`, `fieldMode` (`prefix` | `nested`), `fieldPrefix`,
`fieldKey`, `assetsRoot`, `releaseDir`, `exportOnSave` (GUI only), `preloadCap` (default 5).

`preload` and `no-skills` are ordinary vault-skills fields: they are namespaced by the same
`fieldMode` as `type` / `parent` / `description` (`vs-preload` in prefix mode with prefix `vs-`,
or nested under `fieldKey`).
