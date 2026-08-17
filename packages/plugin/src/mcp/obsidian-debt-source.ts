// obsidian-debt-source.ts — the Obsidian adapter for the conformance-debt
// report (the one un-headless seam behind `obsidian_conformance_debt`). It runs
// the REAL conformance engine over the vault's on-disk root and reads the
// baseline note + metadata sidecar from disk. Kept OUT of tools-conformance-
// debt.ts so that file (imported by the headless tests) never pulls in node:fs
// or the engine. Verify this against a running Obsidian; the report core it
// feeds is fully unit-tested.

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { App } from "obsidian";
import type { DebtSource, DebtRegisterSource } from "./tools-conformance-debt.js";
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

/**
 * The Obsidian `DebtRegisterSource` (issue #211, Part B): the read seams above
 * plus the register render's write half. Writes go through the VAULT API
 * (modify/create, the provenance-regen pattern) rather than node:fs, so
 * Obsidian sees the change immediately and the write behaves like every other
 * in-band note write. The default register dir is the baseline's own folder —
 * the sidecar and trend log already live there, and the baseline itself is
 * never touched.
 */
export function obsidianDebtRenderSource(app: App): DebtRegisterSource {
  const baselineRel = baselineRelFrom(process.env);
  const dir = posix.dirname(baselineRel);
  const vault = app.vault as unknown as {
    getAbstractFileByPath(path: string): unknown;
    modify(file: unknown, data: string): Promise<void>;
    create(path: string, data: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
  };
  return {
    ...obsidianDebtSource(app),
    defaultRegisterDir(): string {
      return dir === "." ? "" : dir;
    },
    async writeNote(path: string, text: string): Promise<void> {
      const existing = vault.getAbstractFileByPath(path);
      if (existing) {
        await vault.modify(existing, text);
        return;
      }
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !vault.getAbstractFileByPath(parent)) {
        try {
          await vault.createFolder(parent);
        } catch {
          /* already exists / race — proceed to create */
        }
      }
      await vault.create(path, text);
    },
  };
}
