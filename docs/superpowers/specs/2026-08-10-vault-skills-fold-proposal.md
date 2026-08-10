# vault-skills fold into vault-mcp — proposal

*2026-08-10 · session: assent-module-worker-1 · decision #2's first capability fold (per Nelson via assent, 2026-08-10 07:55) · DESIGN-ONLY, read-only until reviewed*

## What vault-skills is (so "fold" means something concrete)

`~/repos/obsidian-vault-skills` (GitHub `nelsonlove/obsidian-vault-skills`, v0.8.0) is **an Obsidian plugin that compiles vault notes into a Claude Code plugin**. Two parts in one repo:

1. **The producer** — an Obsidian plugin (`obsidian/`, id `vault-skills`) that reads `type:`-marked notes (skill / agent / policy / command — "frontmatter over geography") from the metadata cache, builds + validates a hierarchy (parent wikilinks, policy injection by lineage, transclusion inlining, a 5-level cap), and **materializes a Claude Code plugin to disk** at `~/.claude/skills/vault-skills` (skills/agents/commands + a bundled `new-skill` helper).
2. **An embedded MCP server** — 6 `vault_skills_*` tools (`validate`/`tree`/`preview` read-only, `export`/`release`/`mark` read-write), reached over a **unix-socket + stdio bridge that explicitly mirrors vault-mcp's** (its 0.7.0 bridge is a copy of vault-mcp 0.3.0/#51 — same restart-survival, same handshake replay, same reconnect).

So vault-skills is **already vault-mcp-shaped**: same transport, same bridge, same claude-cli registration, same `obsidian_*`/`vault_skills_*` MCP-tool model, same `isDesktopOnly` Obsidian plugin. It is running a *second copy of vault-mcp's own architecture* beside it.

## What "fold into vault-mcp" concretely means

The duplication is the opportunity. Two layers fold differently:

### Layer 1 — the MCP tool surface → a vault-mcp capability module (clean fit)

The 6 `vault_skills_*` tools become a **vault-mcp VaultModule** (`id: "skills"`, `posture: "capability"`, `capabilities: ["skills-export"]`), registered through the ModuleRegistry exactly like scope + vocab. This drops **all** of vault-skills' duplicated transport plumbing:
- its `mcp/server.ts`, `socket-transport.ts`, `bridge-asset.ts`, `claude-cli.ts`, `discovery.ts`, `paths.ts` → deleted; vault-mcp's single bridge/socket/registration serves these tools too.
- the 6 tools re-home onto vault-mcp's guarded registrar → they get the guard, the allowlist, read-only mode, and (for the RW ones) the queue/journal for free. `validate`/`tree`/`preview` are `readOnlyHint: true`; `export`/`release`/`mark` are mutating — and here the fold *adds* governance the standalone lacked: an export/release is now journaled, and `mark` (which writes note frontmatter) flows through the same accept-guard + write path as every other mutation.
- **one plugin, one bridge, one BRAT release** — the decision-#2 payoff.

The exporter/transform/transclude **core** (`obsidian/src/exporter.ts`, `transform.ts`, `transclude.ts`) re-homes into `packages/plugin/src/kernel/skills/` as the module's engine — but note it is NOT Obsidian-free today (it reads the metadata cache directly), so the fold should split it like the other modules: a pure transform/validate/tree core over an injected note listing (headless-testable), with the Obsidian metadata-cache read in the tool/adapter layer. That refactor is the real work of the fold; the tool surface re-homing is mechanical.

### Layer 2 — the export PRODUCT → stays a materialize-to-disk step (not replaceable by MCP)

The *product* is a Claude Code plugin written to `~/.claude/skills/vault-skills` that Claude Code loads **from disk**. No live MCP call replaces that materialization — Claude Code reads skills off the filesystem, not over the bridge. So even inside vault-mcp:
- `export`/`release` remain a **materialize-to-disk operation** that the MCP tool merely *triggers* (and `validate`/`tree`/`preview` inspect). This matches how `tools.ts` already splits RO inspection from RW export.
- the auto-export-on-note-change behavior (debounced) becomes a vault-mcp plugin behavior gated on the skills module being enabled.
- the bundled `new-skill` helper + the `define`-injected assets fold into vault-mcp's esbuild the same way its bridge already embeds.

**So the fold is: MCP surface → capability module (drops duplicate transport); compiler core → module engine (needs the pure/adapter split); export product → a disk-materialization step the module triggers, unchanged in nature.** Nothing about the fold requires the bridge to "consolidate" beyond what the module host already does — vault-mcp's one bridge simply carries the skills tools too.

## Scope

- Re-home 6 tools as a `skills` VaultModule; delete vault-skills' duplicate transport/bridge/cli/discovery.
- Refactor exporter/transform/transclude into a pure core + Obsidian adapter (the module pattern).
- Fold the `new-skill` assets + auto-export behavior + settings (output dir, supporting-files tree, release dir, detection mode, plugin name) into vault-mcp settings — and, once worker-3's config-host lands, subscribe the skills module's settings + capability directory to it.
- Retire the standalone vault-skills repo (staged) once the module reaches parity + is live-verified; one BRAT release from vault-mcp.

## Risks / open questions (for assent + Nelson)

1. **Biggest: the compiler core is Obsidian-coupled.** Unlike scope/vocab (built Obsidian-free from day one), vault-skills' exporter reads the metadata cache throughout. The fold's cost is dominated by the pure-core/adapter refactor, not the tool re-homing. Estimate accordingly — this is a multi-cycle fold, not a mechanical move.
2. **Transition / dual-vault.** vault-skills currently serves the *old* vault and is installed-but-not-enabled here (per the adoption plan). Folding into vault-mcp (which serves `~/obsidian`) needs a story for the old vault's still-live compiled plugin during the transition — likely: keep standalone vault-skills running for the old vault until it's retired, ship the folded module for `~/obsidian` only. Nelson's call.
3. **Registry conformance (the doctrinal wrinkle).** vault-skills confers agent-hood by frontmatter presence anywhere; the vault's metadata model wants registered/permitted standing. The adoption plan's reconciliation — "exporter discovery is mechanism; standing lives in the registry; a conformance check requires a bijection between `type: agent` notes and registry entries; a stray `type: agent` note is a finding, not an agent" — is **exactly a conformance rule pack** (ties into task C's engine). Recommend the fold ship with that bijection check as a skills rule pack. Flagging the C↔skills tie-in.
4. **posture.** `skills` is a capability module (no accept surface), so it fits the v1 registry's `capability` posture — but `mark`/`export` write, so its handler-reachability must be reviewed at mount (like any mutating module), and `mark` must honor the accept-guard (it writes frontmatter). Not governance posture; no accept veto.
5. **Version/asset embedding.** vault-skills embeds its bridge + new-skill assets via esbuild `define`, same mechanism as vault-mcp — they merge cleanly, but the two esbuild configs need reconciling (one `main.js`).

## Recommendation for the repo-consolidation audit log

**Fold vault-skills into vault-mcp** as the `skills` capability module (decision #2's first capability fold). It is the cleanest consolidation candidate in the fleet because it already duplicates vault-mcp's exact transport/bridge — the fold *removes* a whole copy of that machinery. Sequence it AFTER the compiler-core pure/adapter refactor is scoped; retire the standalone repo staged, one BRAT release from vault-mcp. Net: one plugin, one bridge, one release; export/mark gain journaling + accept-guard they lack standalone.
