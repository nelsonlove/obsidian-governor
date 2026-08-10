# Conformance engine in TypeScript — design

*2026-08-10 · branch `assent/conformance-findings` (off `main`) · session: assent-module-worker-1 · task C on the assignment board, REFRAMED per Nelson's "no Python" direction (2026-08-10 08:05)*

> **Supersedes** the earlier version of this doc (a TS runner shelling into the Python `conformance_ratchet.py`). Under the no-Python policy the ratchet and all four checks become TypeScript too, so there is no Python subprocess to shell into — the whole rail moves into vault-mcp.

## What this is

Rewrite the vault's conformance rail — the five loose Python scripts (`drift_audit.py`, `conformance_check.py`, `ste_lint.py`, `port_lint.py`, and the `conformance_ratchet.py` orchestrator) — as a **TypeScript conformance engine folded into vault-mcp**, consuming the modules' pure `findings.ts` rule packs (scheme `schemeFindings`, vocab `noteVocabFindings`) as first-class rule packs. Then retire the loose Python (staged, not auto-trashed). Read-only, report-first, headless — never a plugin pane, never an MCP write surface.

## Why the reframe simplifies it

The prior design's whole complication was a **language seam**: TS findings packs → serialize to rail text → Python parses back into the 4-tuple. With "no Python," that seam vanishes:

- The engine is TS, the rule packs are TS, the ratchet is TS — one language, one repo, in-process function calls. `schemeFindings(instance, notes)` and `noteVocabFindings(note, providers)` are called directly; no runner, no stdout format, no parser.
- The four legacy checks become TS rule packs against the same engine, emitting the same typed `Finding` the modules already produce — so the ratchet keys them uniformly.
- The engine still runs **headless** (CI / cron / command line), reading the vault from disk via `@vault-mcp/core`'s existing fs-backend frontmatter reader (no new dependency, same disk semantics the Python scripts assumed).

## Architecture

```
packages/plugin/src/conformance/          (pure TS, Obsidian-free, headless)
  finding.ts       — the canonical Finding type + the 4-tuple key
                     (script, check, target, kind) every rule pack maps to;
                     the ratchet's stable key, line-number/ordinal/count-free.
  rule-pack.ts     — RulePack interface: id + run(ctx) => Finding[]. The two
                     module packs adapt trivially (they already return typed
                     findings over a listing); the four legacy checks implement
                     it directly.
  engine.ts        — runs the configured rule packs over a supplied vault
                     snapshot, collects Finding[], applies visiblePaths/root
                     scoping. No I/O of its own (snapshot injected).
  ratchet.ts       — baseline load + diff: NEW (fails) / CLEARED / CARRIED,
                     over the 4-tuple keyset. Reads/writes the SAME baseline
                     format the Python ratchet used, so accepted debt carries
                     over unchanged (a governed note w/ a ratchet-baseline fence).
  snapshot.ts      — the headless vault reader: walks CONTENT_ROOT, builds the
                     note listing + frontmatter/bodies the packs consume,
                     reusing @vault-mcp/core's fs-backend frontmatter parsing.
  packs/
    scheme.ts      — adapts kernel/scheme/findings.ts schemeFindings
    vocab.ts       — adapts kernel/vocab/findings.ts noteVocabFindings
    drift.ts       — port of drift_audit.py checks A–J   (phase 2)
    blueprint.ts   — port of conformance_check.py         (phase 2)
    ste.ts         — port of ste_lint.py                  (phase 2)
    port.ts        — port of port_lint.py                 (phase 2)
  cli.ts           — headless entry: `conformance [--rebaseline] [--root R]`,
                     exit 1 iff NEW is non-empty (the rail's gate contract).
```

The findings LOGIC for scheme/vocab stays single-sourced in `kernel/*/findings.ts`; the `packs/scheme.ts`/`packs/vocab.ts` adapters only wrap them as `RulePack`s and map their `Finding` shape onto the 4-tuple. No re-implementation.

### The 4-tuple key (unchanged, so the baseline carries over)

`(script, check, target, kind)` — identical across runs regardless of ordering/timestamp; line numbers, positional ordinals, and counts excluded. Both module packs map cleanly (table below); the four legacy packs reproduce their existing Python keying exactly, so a `--rebaseline` isn't forced by the rewrite itself (only by genuine finding changes).

| Rule pack | script | check | target | kind |
|---|---|---|---|---|
| vocab | `vocab_findings` | finding `code` | note relpath | `token` (lower-cased) |
| scheme | `scheme_findings` | finding `code` | note relpath | address or `""` |
| drift (A–J) | `drift_audit` | check letter | per-check target | per-check kind (matches current parser) |
| blueprint | `conformance_check` | `NO-BLUEPRINT`/`DROPPED` | note relpath | blueprint name |
| ste | `ste_lint` | `editable` | note relpath | `name 'token'` |
| port | `port_lint` | rule name | note relpath | token |

### Ratchet + baseline

`ratchet.ts` reproduces `conformance_ratchet.py`'s contract: `NEW = live − baseline` (exit 1), `CLEARED = baseline − live` (never fails; `--rebaseline` shrinks), `CARRIED = live ∩ baseline` (accepted debt, counted not listed). It reads and writes the **existing baseline note format** (`Assent/Build/conformance/Conformance baseline.md`, the ` ```ratchet-baseline ` fence) so the current 124-finding accepted debt transfers with zero re-blessing — the rewrite is behavior-preserving on the keyset. (Fixing the Python ratchet's stale `gen3` default root is moot here — the TS engine uses the `.obsidian`-ancestor / `ASSENT_CONTENT_ROOT` discovery from the start.)

## Phasing (keeps a large rewrite tractable + delivers the original C intent first)

- **Phase 1 (this PR, design + skeleton):** `finding.ts`, `rule-pack.ts`, `engine.ts`, `ratchet.ts`, `snapshot.ts`, `cli.ts`, and the **two module packs** (scheme + vocab) wired + headless-tested against synthetic snapshots and the baseline diff. This delivers "mount the modules' findings into the rail" — the original C goal — as native TS. Legacy checks stubbed.
- **Phase 2:** port the four legacy checks (`drift` A–J, `blueprint`, `ste`, `port`) to `RulePack`s, each with tests reproducing the Python script's findings on a fixture. Verify parity against a live run of the Python scripts (diff the two keysets) before trusting.
- **Phase 3:** retire the loose Python — **staged, not auto-trashed** (per Nelson's file-ops policy): move the five `.py` files to an archive/superseded location with a tombstone pointing at the TS engine, only after Phase 2 parity is proven and Nelson signs off. Update `Assent/Build/conformance/` + the `01.03`/`02.03` artifact references.

## Coordination

- **worker-3's task B (`schemes[].excludedRoots`)** — the scheme pack's snapshot must honor the same exclusion (so the archaeology↔spine `02.10` duplicate stays silenced). The engine applies `excludedRoots` to the snapshot before the packs see it; I'll align the exact field with worker-3.
- **worker-3's config-host (Nelson's item 2)** — the engine's rule-pack set + each pack's options are exactly the kind of "capability directory" that host wants to surface. Phase 1 keeps the pack registry a plain TS list; if the config-host lands, the pack registry subscribes to it rather than inventing its own. Flagging so the two designs converge, not collide.
- **Repo-consolidation audit** — this fold (Python rail → TS in vault-mcp) is an input to that log; flagging the recommendation: the four `.py` scripts + the ratchet retire into vault-mcp's conformance engine.

## Open questions (for assent before Phase 1 build)

1. **Engine location** — `packages/plugin/src/conformance/` (ships with the modules whose findings it consumes, tsx-runnable headless) vs a new `packages/conformance/` workspace package (cleaner separation, but the packs import from `packages/plugin/src/kernel/*`). I lean the former: the rule packs live in the plugin's kernel, so the engine belongs beside them; a separate package would invert the dependency. Objections?
2. **CLI runtime** — tsx-run TS (matches the test story, zero build step, but needs node+tsx present in the rail's environment) vs an esbuild-bundled `conformance.mjs` (self-contained, one more build artifact). I lean tsx for phase 1 (dev/CI already has it), bundling as a phase-3 polish if the rail runs somewhere without tsx.
3. **Baseline home** — keep it at `Assent/Build/conformance/Conformance baseline.md` (governed note, current location) vs move into the repo. It's vault content the rail reads; I lean keep-in-vault so it stays a governed, human-blessable record. Confirm.
