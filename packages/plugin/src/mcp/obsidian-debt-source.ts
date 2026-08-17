// obsidian-debt-source.ts — the Obsidian adapter for the conformance-debt
// report (the one un-headless seam behind `obsidian_conformance_debt`). It runs
// the REAL conformance engine over the vault's on-disk root and reads the
// baseline note + metadata sidecar from disk. Kept OUT of tools-conformance-
// debt.ts so that file (imported by the headless tests) never pulls in node:fs
// or the engine. Verify this against a running Obsidian; the report core it
// feeds is fully unit-tested.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "obsidian";
import type { DebtSource } from "./tools-conformance-debt.js";
import type { Finding } from "../conformance/finding.js";
import { parseSidecar, sidecarPathFor, type DebtSidecar } from "../conformance/debt-sidecar.js";
import { runConformance, baselineRelFrom, excludedRootsFrom } from "../conformance/cli.js";
import { DEFAULT_VOCABULARIES } from "../kernel/vocab/registry.js";
import { DEFAULT_SCHEMES } from "../kernel/scheme/registry.js";

/** Read a UTF-8 file, or null when it is absent/unreadable (never throws). */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The on-disk root of this vault (FileSystemAdapter). Desktop-only, which the
 * plugin already is (`isDesktopOnly: true`). */
function vaultRoot(app: App): string {
  const adapter = app.vault.adapter as unknown as { basePath?: string; getBasePath?: () => string };
  return adapter.basePath ?? adapter.getBasePath?.() ?? "";
}

/**
 * The Obsidian `DebtSource`: a live conformance run + the baseline/sidecar on
 * disk, using the SAME config resolution the CLI rail uses (default schemes /
 * vocabularies, env-driven excluded roots and baseline location, legacy packs
 * on). `liveFindings` runs the full engine once; `baselineText`/`sidecar` are
 * cheap reads.
 */
export function obsidianDebtSource(app: App): DebtSource {
  const root = vaultRoot(app);
  const baselinePath = join(root, baselineRelFrom(process.env));
  const excludedRoots = excludedRootsFrom([], process.env);

  return {
    async liveFindings(): Promise<Finding[]> {
      const res = await runConformance({
        root,
        // Findings are independent of the baseline (it only feeds the ratchet
        // diff, which this path discards) — pass empty to skip a disk read.
        baselineText: "",
        vocabularies: DEFAULT_VOCABULARIES,
        schemes: DEFAULT_SCHEMES,
        excludedRoots,
        legacyPacks: true,
      });
      return res.findings;
    },
    async baselineText(): Promise<string> {
      return (await readOrNull(baselinePath)) ?? "";
    },
    async sidecar(): Promise<DebtSidecar> {
      return parseSidecar(await readOrNull(sidecarPathFor(baselinePath)));
    },
  };
}
