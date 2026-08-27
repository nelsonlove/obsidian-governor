# vault-hooks — events to actions, as notes

> [!warning] PROPOSAL — not adopted, not normative
> Drafted 2026-08-27 at Nelson's direction, after a survey of the Obsidian ecosystem found the general case unserved. Nothing here is built. Open decisions are in §11. [Status and compatibility](status-and-compatibility.md#current-release-state) remains the single owner of shipped truth.

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

## 4. THE SAFETY PROBLEM, and the answer

**A rule note is an agent-writable path to arbitrary command execution.** Any agent that can write a note can write `on: vault:create` + `do: [command: <anything>]` — and commands can delete files, rewrite settings, or invoke another plugin's whole surface. Left naive, this plugin converts "an agent may write notes" into "an agent may run anything, forever, without being asked." That is a bigger escalation than anything else in the suite, and it is inherent to config-as-notes, not incidental.

The suite already owns the exact mechanism for this and it should be reused rather than reinvented: **honor-only-if-blessed**, the `authority-conferring` protected-property grade (`@vault-mcp/core`'s accept guard, and the `auto-accept` precedent).

The rule, stated once: **a rule fires only if its `enabled: true` was written by a human.** Concretely —

1. `hook-type` and `enabled` are declared **protected properties, `authority-conferring` grade**: no agent transport may introduce, change, or remove them, and their values take effect only once the write that set them is human-attributed or accepted in review.
2. A rule whose `enabled` was set by an unattributed or agent write is **inert and visibly so** — it appears in the rule list marked *unblessed*, never silently absent. (Absence must not render as emptiness; an inert rule that looks like no rule is how someone concludes the plugin is broken and disables the safety.)
3. Blessing is a human act with the ordinary Obsidian affordances: edit the note yourself, or use the plugin's own **Enable rule…** command (a real click, listing what the rule will do before it does it).
4. Without the governance provider installed, "human-attributed" degrades to the honest weaker claim: the plugin's own blessing record, written by its own command. It never degrades to "assume blessed."

Two more limits belong here rather than in a settings tab nobody reads:

- **No `js:` action in v1.** Blessed-or-not, shipping arbitrary script execution bound to file events is a different product with a different threat model.
- **A rule can be disabled globally in one gesture** — one master switch, refuse-only (a suspended state runs nothing; rules untouched, resumable). The same brake the governance provider is getting, for the same reason: a human reaching for the stop button under stress wants ONE control.

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

**No agent-facing verb enables a rule, and none creates one in an enabled state.** An agent may draft a rule note like any other note; blessing is §4's human act. This mirrors the governance provider's mandate surface exactly: agents draft, humans grant.

## 10. Fit with the suite

A satellite, private-operator tier (D07): it binds arbitrary commands and is therefore not a public-default promise. It depends on the host only for its MCP tools — **the rule engine itself works with no host installed**, exactly like quickadd-choices' palette commands. If the governance provider is present, its accept-guard is what makes §4's blessing meaningful; if absent, the plugin's own blessing record is the honest weaker claim.

Later, once the [governance seam](suite-split-design.md#5-the-seam--the-hosts-governance-hook-api) exists, the seam's write-observer is a natural additional trigger source (`governance:proposal-opened`, `governance:admitted`) — deferred, and named here so the design is not surprised by it.

## 11. Open decisions (Nelson)

1. **The name.** Recommendation: repo/package/plugin id **`vault-hooks`** — family-consistent with `vault-mcp`, and verified clean at drafting time (no GitHub repo, npm free, no community-registry id; note `rule-engine` and `automation` are taken there).
2. **Build it when?** Recommendation: after S1–S3 of the suite split. It is a satellite, and satellites are cheaper to add once the host/provider boundary exists — but nothing except review bandwidth stops it from being built earlier.
3. **The firing log's home**: jsonl beside the plugin (durable, greppable, grows) vs an in-memory ring with a small persisted tail (bounded, loses history on reload). Recommendation: the ring, with the last N failures persisted — history matters most for what went wrong.
4. **Whether `enabled` lives in the note at all** (§4) — the alternative is a plugin-settings list of blessed rule paths, which is harder to agent-write but also harder for a human to see next to the rule. Recommendation: the note, protected-property-guarded, precisely because it stays visible where the rule is.
