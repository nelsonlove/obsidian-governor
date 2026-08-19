// Ported from obsidian-jd-dashboard's src/lib/standard-zeros.ts, split into
// PLAN (pure, here) and APPLY (mcp/tools-jd-scaffold.ts), matching
// kernel/scheme/mutate.ts's established shape. ONE deliberate change from the
// original: buildZeroFrontmatter no longer writes a jd-id: field — see this
// plan's Global Constraints for why (vault-mcp's scheme module is
// path-canonical; the filename already carries the address).

import type {
  ZeroSpec,
  PlannedCreate,
  PlanStandardZerosInput,
  PlanStandardZerosResult,
  CategoryFolderInput,
  PlanEnsureResult,
} from "./types.js";

export function suffixFor(prefix: string): string {
  return prefix === "00" ? "for the system" : `for category ${prefix}`;
}

export function standardZeros(prefix: string, suffix: string): ZeroSpec[] {
  return [
    { id: "00", name: `JDex ${suffix}`, tag: "jd/index", hasDir: false },
    { id: "01", name: `Inbox ${suffix}`, tag: "jd/inbox", hasDir: true },
    { id: "02", name: `Task & project management ${suffix}`, tag: "jd/tasks", hasDir: false },
    { id: "03", name: `Templates ${suffix}`, tag: "jd/templates", hasDir: true },
    { id: "04", name: `Links ${suffix}`, tag: "jd/links", hasDir: false },
    { id: "05", name: `Conventions & policies ${suffix}`, tag: "jd/policies", hasDir: false },
    { id: "06", name: `Knowledge base ${suffix}`, tag: "jd/knowledge-base", hasDir: true },
    { id: "07", name: `Dashboard ${suffix}`, tag: "jd/dashboard", hasDir: false },
    { id: "08", name: `Someday ${suffix}`, tag: "jd/someday", hasDir: false },
    { id: "09", name: `Archive ${suffix}`, tag: "jd/archive", hasDir: true },
  ];
}

/** jd-id: intentionally absent — see this file's header comment. */
export function buildZeroFrontmatter(zero: ZeroSpec, prefix: string, folderName: string, now: string): string {
  const aliases = zero.id === "00" ? `  - ${zero.name}\n  - ${folderName}` : `  - ${zero.name}`;

  return `---
title: ${zero.name}
created: ${now}
modified: ${now}
tags:
  - ${zero.tag}
aliases:
${aliases}
linter-yaml-title-alias: ${zero.name}
---

# ${zero.name}

`;
}

export function planStandardZeros(input: PlanStandardZerosInput): PlanStandardZerosResult {
  const { folderPath, folderName, prefix, now, existingPaths } = input;
  const suffix = suffixFor(prefix);
  const zeros = standardZeros(prefix, suffix);

  const creates: PlannedCreate[] = [];
  const skipped: string[] = [];

  for (const zero of zeros) {
    const basename = `${prefix}.${zero.id} ${zero.name}`;
    const path = zero.hasDir ? `${folderPath}/${basename}/${basename}.md` : `${folderPath}/${basename}.md`;

    if (existingPaths.has(path)) {
      skipped.push(path);
      continue;
    }
    creates.push({ path, content: buildZeroFrontmatter(zero, prefix, folderName, now) });
  }

  return { creates, skipped };
}

/** Matches the "XX.00", "XX.00.md", "XX.00+SUF ..." acceptance the original
 *  ensureCategoryIndexes uses — a deliberately renamed JDex isn't clobbered. */
function hasIndexAlready(childBasenames: string[], prefix: string): boolean {
  const indexBase = `${prefix}.00`;
  return childBasenames.some((name) => {
    if (!name.endsWith(".md")) return false;
    if (!name.startsWith(indexBase)) return false;
    const next = name.charAt(indexBase.length);
    return next === " " || next === "." || next === "+";
  });
}

export function planEnsureCategoryIndexes(folders: CategoryFolderInput[], now: string): PlanEnsureResult {
  const creates: PlannedCreate[] = [];

  for (const folder of folders) {
    if (hasIndexAlready(folder.childBasenames, folder.prefix)) continue;

    const zero = standardZeros(folder.prefix, suffixFor(folder.prefix)).find((z) => z.id === "00")!;
    const basename = `${folder.prefix}.${zero.id} ${zero.name}`;
    creates.push({
      path: `${folder.path}/${basename}.md`,
      content: buildZeroFrontmatter(zero, folder.prefix, folder.name, now),
    });
  }

  return { creates };
}
