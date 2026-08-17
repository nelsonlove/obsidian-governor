# The conformance engine

CI for the vault: a headless TypeScript engine (`packages/plugin/src/conformance/`) that
runs **rule packs** over a snapshot of the vault and diffs the findings against an accepted
**baseline**, so only *new* drift alarms. It implements the project's "checks before gates"
principle — the conformance rail arms the acceptance gate rather than nagging about
pre-existing debt. Landed in two steps: the Phase-1 engine (#89) and the ported legacy
checks (#103); everything is TS per the no-Python ruling — the engine replaces a set of
loose Python rail scripts, whose staged retirement completes when the last port lands.
(#103 landed on `main` after the 0.8.0 release — these docs track `main`, not a release.)

## Shape

| Piece | What it does |
| --- | --- |
| `finding.ts` | The finding record and its **4-tuple key** `(script, check, target, kind)` — byte-compatible with the pre-existing baseline format, so accepted debt carried over without re-blessing. |
| `rule-pack.ts` | The pack contract: *the engine feeds a listing, the pack returns typed findings.* Packs are pure functions — no vault reads inside a pack. |
| `snapshot.ts` | Headless disk source: parses frontmatter/bodies into the listings packs accept (reuses `@vault-mcp/core` parsing; accepts an `excludedRoots` exclusion list — the same seam as `schemes[].excludedRoots`, not yet wired from settings in the CLI, see #116). |
| `engine.ts` | Runs the registered packs over a snapshot. |
| `ratchet.ts` | Baseline diff: **NEW / CLEARED / CARRIED** per finding key. New findings gate; carried ones are accepted debt burning down on the human's schedule. |
| `cli.ts` | The testable rail core (`runConformance`) + `runCli` (argv/env/read/write). The debt sidecar reconcile + trend append + budget teeth live here (#211). |
| `main.ts` | The process entry (`node --import tsx src/conformance/main.ts …`). Split from `cli.ts` so the importable core carries no `import.meta` (the plugin bundles `runConformance` for the read-only debt tool). |
| `debt-sidecar.ts` / `debt.ts` / `debt-trend.ts` | The debt register data layer (#211): the per-key metadata sidecar, the read-only report core (carried items + burn-down + staleness/budget teeth), and the append-only trend log. |
| `debt-register.ts` | The human-facing register render (#211 Part B): a pure builder that materializes the debt report as ONE generated vault note (`Conformance debt.md`, default beside the baseline) — summary header, carried-debt table (each row linked to the offending note, stale + high-priority first, capped with a "+N more" line), and a "cleared — prune these" section. Frontmatter is a `generated`/`generator` derivation stamp, never an acceptance field (accept-guard-checked before every write). CLI: `--render-register` (plus `--register-dir=`/`ASSENT_REGISTER_DIR`, `--stale-after=`/`ASSENT_STALE_AFTER_DAYS`); a `--rebaseline` refreshes an *existing* register automatically but never creates one unasked. MCP: the mutating `obsidian_conformance_debt_render` (allowlist-refusing). No `.base` file is generated: Obsidian Bases query notes/frontmatter, so a multi-row Base would need one stub note per debt item — exactly the note-per-item spam the design rejects; the table + the JSON sidecar are the register. |
| `packs/` | The rule packs (below). |

## Rule packs

- **Native** — `scheme.ts` (the scope module's `schemeFindings`: addressing/structure drift)
  and `vocab.ts` (unregistered tags, undefined properties, unknown types, deprecated terms).
- **Ported legacy checks** (#103) — `structure.ts`, `port.ts`, `ste.ts`: line-for-line ports
  of the Python originals, **parity-verified against the live Python before trust** (finding
  keys diffed both directions, zero divergence at port time). `legacy-scope.ts` preserves
  each script's deliberate per-script scope variance rather than flattening it. The fourth
  legacy check (`drift_audit`) ports next, completing the Python retirement.

## Honest status

- The engine and packs are merged and green; the **legacy packs currently register
  unconditionally**, so an unscoped live run reports NONCONFORMING against a baseline that
  predates a large vault restructuring — tracked in #116, with a follow-up in flight (an
  opt-in gate for the legacy packs, then one deliberate, reviewed rebaseline at cutover).
  Until then the engine is a reporting tool, not a gate.
- Live rebaseline is currently refused outright (`PHASE1_PACKS_INCOMPLETE` in `cli.ts`):
  until the last legacy check (drift_audit) is ported, a rebaseline would drop its accepted
  findings from the baseline. An explicit `--baseline=` fixture path is always allowed; the
  guard flips once the port set is complete and the cutover rebaseline is reviewed.

The pack registry is a plain list today; it subscribes to the module config-host when that
lands, and pack capabilities join each module's capability directory.
