# vault-hooks — events to actions, as notes

> [!note] DESIGN ACCEPTED 2026-08-27 (Nelson) — not yet built
> The name is `vault-hooks`; build follows the suite split's S1–S3; the firing log's home is a setting; `enabled:` lives in the note **with no human-only wiring** (§4, rewritten to that ruling — the residual risk is stated there, accepted, not forgotten). Nothing here is built yet. [Status and compatibility](status-and-compatibility.md#current-release-state) remains the single owner of shipped truth.

## 1. The gap, evidenced

A survey of the plugin ecosystem (2026-08-27, web) found no maintained, general-purpose way to bind an Obsidian **event** to an arbitrary **action**:

| Plugin | Events | Actions | State |
|---|---|---|---|
| Shell Commands | broad (file CRUD, startup, quit, intervals, pane switch) | **shell only** | maintained, slow |
| Templater | file-creation, startup only | Templater scripts | very active |
| Auto Note Mover | create / modify / rename | **move only** | stale; forks fragmented |
| Sentinel | note open / close only | one property update or one command | active, narrow |
| Commander | **none** (UI surfaces) | any command | active |
| Automation (Benature) | some, undocumented | any command | abandoned 2024 |
| Obsidian Actions | close to the general case | JS / shell | 3 stars, solo hobby |

The Obsidian API exposes everything needed — `vault` create/modify/delete/rename, `metadataCache` changed/resolve/resolved, `workspace` file-open/active-leaf-change/layout-change/quit, plugin lifecycle, and `registerInterval`. **The gap is entirely in the configuration layer, not in capability.** Concretely unserved: run a registered command (or a QuickAdd choice, or a sequence) on rename/delete/file-open; condition a rule on frontmatter or tags; anything driven by metadata-cache events.

## 2. The shape: rules are notes

One rule per markdown note, discovered by frontmatter — the same shape [quickadd-choices](../packages/quickadd-choices/) already ships and the same instinct as skills-as-notes and policies-as-notes. The vault is the config surface; nothing lives in a `data.json` a human cannot read, diff, or link.

```yaml
---
hook-type: rule
name: Stamp modified on save
on: vault:modify                 # one event, or a list
if:                              # every clause must hold (AND); omit for "always"
  path: "10-19 Projects/"        # folder prefix, segment-boundary matched
  extension: md
  frontmatter:                   # exact key/value, or `true` for "key present"
    track-modified: true
do:                              # ordered; a failing step stops the sequence
  - command: quickadd:choice:Stamp modified
  - command: obsidian-linter:lint-file
debounce: 2s                     # per rule, per subject
enabled: false                   # see §4 — a rule does nothing until BLESSED
---

Prose here is documentation, not config. What this rule is for, why it exists,
when to retire it — the things a `data.json` row can never hold.
```

Three parts, kept separate on purpose (the Zapier shape): **trigger** (`on`), **condition** (`if`), **action** (`do`). Conditions never live inside actions; actions never re-test the trigger. That separation is what makes a rule readable at a glance and a rule list legible at fifty.

## 3. Triggers and actions, v1

**Events (v1).** `vault:create`, `vault:modify`, `vault:delete`, `vault:rename`, `metadata:changed`, `workspace:file-open`, `app:layout-ready`, `timer:every` (with an interval). Each event names its **subject** — the file it is about, or none for `layout-ready`. Deferred: `metadata:resolved` (link-graph churn; fires in bursts), `workspace:quit` (nothing may be async there), editor/menu events (they want a UI surface, not a rule).

**Conditions (v1).** `path` (folder prefix), `path-glob`, `extension`, `name-matches` (regex on basename), `frontmatter` (exact value or key-presence), `tag`. All ANDed. Deferred: OR/NOT trees, cross-note queries, Dataview expressions — a condition that can run a query is a condition that can hang the event loop.

**Actions (v1).** `command: <id>` — any registered Obsidian command, which is also how a QuickAdd choice is invoked (QuickAdd registers `quickadd:choice:<name>`), and how anything Commander exposes is invoked. That single action type covers most of the surveyed demand. Deferred, deliberately: `js:` (arbitrary script — see §4; if it ever ships it is blessed-only and operator-tier), `tool:` (call a published MCP tool through the host — attractive, but it makes the host a dependency rather than an optional peer; revisit after the seam).

## 4. The safety question, and what we are actually doing about it

**A rule note is a path to arbitrary command execution by whoever can write notes.** Any writer — an agent, a synced device, a script — can author `on: vault:create` + `do: [command: <anything>]`, and it then runs on every matching event, unattended, until someone notices. That is worth stating plainly before the design settles.

**Ruled (Nelson, 2026-08-27): `enabled:` lives in the note and is read at face value. No blessing machinery, no honor-only-if-blessed, no human-attribution check.** The reasoning, recorded so it is a decision rather than an omission:

- **The marginal escalation is narrower than it first looks.** An agent that can write vault notes in this system generally already has the host's command surface (`obsidian_run_command`, gated by the CLI policy). A rule note does not hand such an agent a capability it lacked; it changes *when* the capability fires.
- **What genuinely IS new is persistence and unattendedness** — a tool call happens once, in a session, in the journal, with someone nearby; a rule fires forever, on events, when nobody is watching. That is the real delta, and it is the thing the visibility machinery below exists to answer.
- **Blessing machinery has a cost the threat does not justify here**: a second authority concept to learn, an inert-until-blessed state to explain, and a failure mode (silently-inert rules) that is itself a bug factory. This is a single-operator vault, not a multi-tenant surface.

So the safety story is **visibility and reversibility, not gating**:

1. **Every rule is listed with its state and its terms** — a human can see the full set at a glance, including rules added since they last looked. A rule that exists is never invisible.
2. **Every firing is recorded** (§7), so "what ran while I was away" is answerable.
3. **One master brake** — a single refuse-only switch that suspends all rules, rules untouched and resumable. A human reaching for a stop button under stress wants ONE control.
4. **No `js:` action in v1.** Command ids are inspectable and enumerable; arbitrary script bound to file events is a different product with a different threat model.
5. **The loop, rate, and startup guards (§5, §6) are structural**, because the realistic damage here is a runaway rule, not a malicious one.

**Available without new code, for anyone who wants the stronger posture:** the suite's existing protected-properties setting can declare `hook-type` and `enabled` as `agent-forbidden` or `authority-conferring` — the same mechanism `auto-accept` uses. That is an operator's configuration choice against the existing accept guard, not machinery vault-hooks builds or depends on.

## 5. The loop problem

A rule triggered by `vault:modify` whose action modifies a file re-triggers itself. This is the failure mode that eats vaults, and it must be structural, not advisory.

1. **Self-suppression.** Every rule execution runs inside a context that marks the changes it causes. Events attributable to a rule's own effects do not re-enter that rule. (Emacs' `inhibit-modification-hooks`, made per-rule instead of global.)
2. **Depth cap.** Rule A's effect may legitimately trigger rule B; a chain deeper than a small constant (3) stops and reports. Cross-rule cycles are real and undetectable by static inspection alone.
3. **Rate budget.** Per rule, per window: N firings/minute (default modest). Reaching it **stops the rule and says so** — the WP10-style "reaching a budget is a normal stop", not a silent throttle.
4. **Debounce.** Per rule, per subject, default 2s on `vault:modify`. Obsidian's modify event is chatty.

## 6. The startup storm

`vault.on("create")` **fires once per existing file when the vault loads**. A naive `on: vault:create` rule fires thousands of times at startup, on files that were not created. Structural answers, both defaults:

- No rule fires before `app:layout-ready`, and the plugin drops the create-event storm that precedes it.
- `during-startup: false` by default; a rule that genuinely wants startup work uses `on: app:layout-ready` and says so.

## 7. Failure and visibility

A rule that silently fails is worse than no rule — the human believes the automation ran.

- **Every firing is recorded**: rule, event, subject, actions attempted, outcome, duration. A bounded append-only log (jsonl beside the plugin, or a rolling in-memory ring with a persisted tail — §11).
- **Failures surface once, loudly**: a Notice on first failure per (rule, reason), never per firing (the per-poll-noise lesson).
- **`Explain: what would fire for this note`** — a command and a read-only tool answering "given this file and this event, which rules match and what would they do", without doing it. The dry-run discipline, applied to rules.
- **The rule list shows state**: blessed / unblessed / suspended / rate-stopped, with counts. An inert rule is never invisible.

## 8. Ordering and determinism

Multiple rules matching one event run in **note-path lexical order**, always, and the order is shown in the rule list. Not declaration order (there is no single declaration), not discovery order (that is metadata-cache warming, i.e. luck). A rule that must run after another says so with `after: [[Other rule]]`, which is a partial order the plugin topologically sorts and refuses on cycle — the same refusal shape the QuickAdd compiler already uses for choice cycles.

## 9. The MCP surface

The plugin publishes read-mostly tools through `vault-mcp-api`, like any satellite:

- `vault_hooks_list` — every rule with its state (blessed/unblessed/suspended/rate-stopped) and its terms.
- `vault_hooks_explain` — the dry-run: which rules match a given file/event, and what they would do.
- `vault_hooks_history` — recent firings and failures.

**No agent-facing verb enables a rule, and none creates one in an enabled state.** An agent may draft a rule note like any other note — the same way it writes any note — but the plugin ships no tool whose purpose is "make this run". Not because the frontmatter is guarded (§4: it is not), but because a verb named for switching on unattended execution is an attractive nuisance, and writing the note already covers the legitimate case.

## 10. Fit with the suite

A satellite, private-operator tier (D07): it binds arbitrary commands and is therefore not a public-default promise. It depends on the host only for its MCP tools — **the rule engine itself works with no host installed**, exactly like quickadd-choices' palette commands, and it depends on the governance provider for nothing at all (§4).

Later, once the [governance seam](suite-split-design.md#5-the-seam--the-hosts-governance-hook-api) exists, the seam's write-observer is a natural additional trigger source (`governance:proposal-opened`, `governance:admitted`) — deferred, and named here so the design is not surprised by it.

## 11. Decisions (Nelson, 2026-08-27 — all four resolved)

1. **Name: `vault-hooks`.** Verified clean at drafting (no GitHub repo, npm free, no community-registry id; `rule-engine` and `automation` are taken there).
2. **Build after the suite split's S1–S3.** It is a satellite, and satellites are cheaper once the host/provider boundary exists.
3. **The firing log's home is a SETTING**, not a design constant — jsonl beside the plugin (durable, greppable) or a bounded in-memory ring with a persisted failure tail, chosen per install. Default to be picked at build time; the ring is the safer default and the setting is the answer to anyone who wants history.
4. **`enabled:` lives in the note, read at face value — no human-only wiring.** §4 carries the reasoning and the accepted residual.

Nothing further blocks this design; what remains is build sequencing.
