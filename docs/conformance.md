# The conformance engine

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


CI for the vault: a headless TypeScript engine (`packages/plugin/src/conformance/`) that
runs **rule packs** over a snapshot of the vault and diffs the findings against an accepted
**baseline**, so only *new* drift alarms. It implements the project's "checks before gates"
principle — the conformance rail arms the acceptance gate rather than nagging about
pre-existing debt. Landed in stages: the Phase-1 engine (#89), the ported legacy checks
(#103), and the final `drift_audit` port (#127/#130); everything is TS per the no-Python
ruling — the engine replaced the loose Python rail scripts, whose retirement is complete.
(These docs track `main`, not a release.)

## Shape

| Piece | What it does |
| --- | --- |
| `finding.ts` | The finding record and its **4-tuple key** `(script, check, target, kind)` — byte-compatible with the pre-existing baseline format, so accepted debt carried over without re-blessing. |
| `rule-pack.ts` | The pack contract: *the engine feeds a listing, the pack returns typed findings.* Packs are pure functions — no vault reads inside a pack. |
| `snapshot.ts` | Headless disk source: parses frontmatter/bodies into the listings packs accept (reuses `@vault-mcp/core` parsing; accepts an `excludedRoots` exclusion list — wired from the invocation via `--exclude=`/`GOVERNOR_EXCLUDED_ROOTS` (legacy `ASSENT_EXCLUDED_ROOTS`), with `excludedRootRefusal` refusing a run whose exclusions would strand accepted baseline keys). Also the territory chokepoint (#157): `buildSnapshot` refuses a root with no declared boundary, a root resolving outside it, and the permanently denied territories (`~/obsidian-old`, `80-89*`, holds) — decided over resolved real paths (`path-identity.ts`), before any read. |
| `engine.ts` | Runs the registered packs over a snapshot. |
| `ratchet.ts` | Baseline diff: **NEW / CLEARED / CARRIED** per finding key. New findings gate; carried ones are accepted debt burning down on the human's schedule. |
| `cli.ts` | The testable rail core (`runConformance`) + `runCli` (argv/env/read/write). The debt sidecar reconcile + trend append + budget teeth live here (#211). |
| `main.ts` | The process entry (`node --import tsx src/conformance/main.ts …`). Split from `cli.ts` so the importable core carries no `import.meta` (the plugin bundles `runConformance` for the read-only debt tool). |
| `debt-sidecar.ts` / `debt.ts` / `debt-trend.ts` | The debt register data layer (#211): the per-key metadata sidecar, the read-only report core (carried items + burn-down + staleness/budget teeth), and the append-only trend log. |
| `debt-register.ts` | The human-facing register render (#211 Part B): a pure builder that materializes the debt report as ONE generated vault note (`Conformance debt.md`, default beside the baseline) — summary header, carried-debt table (each row linked to the offending note, stale + high-priority first, capped with a "+N more" line), and a "cleared — prune these" section. Frontmatter is a `generated`/`generator` derivation stamp, never an acceptance field (accept-guard-checked before every write). CLI: `--render-register` (plus `--register-dir=`/`GOVERNOR_REGISTER_DIR`, `--stale-after=`/`GOVERNOR_STALE_AFTER_DAYS` (legacy `ASSENT_*` spellings also recognized)); a `--rebaseline` refreshes an *existing* register automatically but never creates one unasked. MCP: the mutating `obsidian_conformance_debt_render` (allowlist-refusing). No `.base` file is generated: Obsidian Bases query notes/frontmatter, so a multi-row Base would need one stub note per debt item — exactly the note-per-item spam the design rejects; the table + the JSON sidecar are the register. |
| `packs/` | The rule packs (below). |

## Rule packs

- **Native** — `scheme.ts` (the scope module's `schemeFindings`: addressing/structure drift)
  and `vocab.ts` (unregistered tags, undefined properties, unknown types, deprecated terms).
- **Ported legacy checks** (#103, completed by `drift.ts` in #127/#130) — `structure.ts`,
  `port.ts`, `ste.ts`, `drift.ts`: line-for-line ports of the Python originals,
  **parity-verified against the live Python before trust** (finding keys diffed both
  directions, zero divergence at port time). `legacy-scope.ts` preserves each script's
  deliberate per-script scope variance rather than flattening it. The Python rail is
  retired, so parity is now historical: where the port's byte-parity preserved a defect,
  the TS packs fix it against their own semantics — frontmatter recognition binds to
  core's shared fence recognizer rather than the Python's literal `---` scan (#189, #223,
  and #227 for `ste`), and `structure.ts` reports an `UNRESOLVED-INCLUDE` finding where
  the Python silently shrank a blueprint's emitted-H2 set on an unresolvable
  `{% include %}` (#112). Deliberately-kept legacy behaviors (ASCII word boundaries,
  last-in-sorted-order blueprint basename arbitration) are pinned by comment + test
  rather than silently relied on (#112).

## Honest status

- The legacy packs **register by default** (`--no-legacy-packs` opts out): the accepted-debt
  baseline's keys are exclusively legacy-pack keys, so a run without them would report the
  entire baseline as CLEARED — a false "all debt fixed" (#116; the rationale is on
  `RunOpts.legacyPacks` in `cli.ts`).
- Rebaseline safety is **computed, not hardcoded** (`rebaselineRefusal` in `cli.ts`,
  replacing the retired `PHASE1_PACKS_INCOMPLETE` constant whose stated reason expired
  silently): a rebaseline refuses when the baseline names a pack the run didn't register
  (it would silently drop that pack's accepted keys), and a rebaseline targeting the LIVE
  baseline refuses — it is an acceptance record, and acceptance is a human gesture. An explicit
  `--baseline=<fixture>` path is how a rebaseline is reviewed before a human applies it.
- Pack fixes that recognize more than the retired Python did (e.g. #227's BOM-aware `ste`
  frontmatter exemption, #112's `UNRESOLVED-INCLUDE`) can shift or add finding keys; those
  surface as NEW and are blessed — or fixed — at the next human-reviewed rebaseline rather
  than auto-accepted.

The pack registry is a plain list today; it subscribes to the module config-host when that
lands, and pack capabilities join each module's capability directory.
