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
| `cli.ts` | Headless runner (dev CLI via `tsx`). |
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
