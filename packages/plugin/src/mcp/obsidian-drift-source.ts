// obsidian-drift-source.ts — the Obsidian adapter for the scheme Drift pane
// (Stage C of the jd-dashboard fold, the "live conformance-engine call path"
// the design doc flagged as an open question). NOT a new call path: this
// reuses the exact same in-process `runConformance` call the ALREADY-SHIPPED
// `obsidian_conformance_debt` MCP tool makes (see obsidian-debt-source.ts,
// this file's sibling and closest precedent) — same root resolution, same
// baseline-path/excluded-roots env resolution, same DEFAULT_VOCABULARIES/
// DEFAULT_SCHEMES/legacyPacks:true config. The only difference is what
// happens to the result: obsidian-debt-source.ts discards the ratchet and
// keeps raw findings (debt reporting doesn't care about new-vs-carried);
// this keeps the ratchet and narrows to the scheme pack's NEW findings via
// conformance/drift-view.ts's newSchemeDrift, matching the original
// jd-dashboard drift panel's "show me what's newly wrong" framing.
//
// That difference is exactly why this file, unlike obsidian-debt-source.ts,
// MUST run the two pre-flight refusals `cli.ts`'s `main()` runs before
// calling `runConformance` — `runConformance` itself has no such guard, it
// trusts whatever `baselineText`/`excludedRoots` it's handed:
//
//   - `baselineMissingRefusal`: a MISSING baseline must never silently read
//     as empty. An empty baseline makes EVERY live finding read NEW — a
//     report that looks like catastrophic regression but is really a
//     missing/misconfigured file. obsidian-debt-source.ts gets away with
//     `readOrNull(...) ?? ""` because it discards the ratchet entirely
//     (`liveFindings()` never reads `res.ratchet`); this file keeps the
//     ratchet, so the same pattern here would flood the pane with false
//     "new drift" for the vault's ENTIRE accepted-debt backlog on every
//     first-run/misconfigured/sync-glitch case. Reusing the CLI's own
//     exported refusal rather than duplicating its wording.
//   - `excludedRootRefusal`: the inverse hazard — an `excludedRoots` value
//     that would strand baseline keys under a root this run no longer looks
//     at makes those keys read CLEARED (falsely "resolved!"), for the same
//     reason. Also harmless in debt-source.ts (ratchet discarded), also not
//     harmless here.
//
// Verify this against a running Obsidian; the view core it feeds
// (drift-view.ts) is fully unit-tested.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "obsidian";
import {
  runConformance,
  baselineRelFrom,
  excludedRootsFrom,
  baselineMissingRefusal,
  excludedRootRefusal,
} from "../conformance/cli.js";
import { parseBaseline } from "../conformance/ratchet.js";
import { newSchemeDrift, type DriftGroup } from "../conformance/drift-view.js";
import { DEFAULT_VOCABULARIES } from "@vault-mcp/core";
import { DEFAULT_SCHEMES } from "../kernel/scheme/registry.js";

/** The on-disk root of this vault (FileSystemAdapter). Desktop-only, which
 *  the plugin already is (`isDesktopOnly: true`) — same helper as
 *  obsidian-debt-source.ts's `vaultRoot`, duplicated rather than shared
 *  since that one is private to its own file. */
function vaultRoot(app: App): string {
  const adapter = app.vault.adapter as unknown as { basePath?: string; getBasePath?: () => string };
  return adapter.basePath ?? adapter.getBasePath?.() ?? "";
}

export interface DriftPaneSource {
  /** Run the conformance engine and return the scheme pack's NEW findings
   *  (not already-accepted debt), grouped by check. Throws (surfaced by the
   *  pane as an error state, never silently swallowed into a wrong result)
   *  when the baseline is missing or an excluded root would strand accepted
   *  debt — see this file's header. */
  scan(): Promise<DriftGroup[]>;
}

export function obsidianDriftSource(app: App): DriftPaneSource {
  const root = vaultRoot(app);
  const baselinePath = join(root, baselineRelFrom(process.env));
  const excludedRoots = excludedRootsFrom([], process.env);

  return {
    async scan(): Promise<DriftGroup[]> {
      const missing = baselineMissingRefusal(baselinePath, existsSync(baselinePath), false);
      if (missing) throw new Error(missing);
      const baselineText = await readFile(baselinePath, "utf8");

      const strand = excludedRootRefusal(parseBaseline(baselineText), excludedRoots);
      if (strand) throw new Error(strand);

      const res = await runConformance({
        root,
        baselineText,
        vocabularies: DEFAULT_VOCABULARIES,
        schemes: DEFAULT_SCHEMES,
        excludedRoots,
        legacyPacks: true,
      });
      return newSchemeDrift(res.findings, res.ratchet);
    },
  };
}
