# jd-dashboard fold — Stage A2 (category-index) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port jd-dashboard's `category-index.ts` (the vault-truth `## Contents` builder for `XX.00` JDex files, 3 tiers: ordinary/area-management/system) as a new tool in the `jd-scaffold` module, following the same fold as Stage A.

**Spec:** `docs/superpowers/specs/2026-08-19-jd-dashboard-fold-design.md`. This is the piece that design doc split out as its own stage once the source turned out comparable in complexity to all of Stage A.

## Architecture

**Pure core** (`kernel/jd-scaffold/category-index.ts` + `sections.ts`): everything jd-dashboard's original does with plain data — bullet formatting/parsing, description preservation (`*(…)*` overlay), section upsert (`setSection`, ported generically from jd-dashboard's `lib/sections.ts` — takes a `heading` parameter rather than being hardcoded, unlike `kernel/survey/section.ts`'s refusal-shaped sibling, since category-index has no protection gate at all: it always regenerates, by design). All of it operates on **plain vault-relative path strings**, never `TFile` — the original's `TFile`-shaped functions (`getCategoryFiles`, `buildCategoriesMap`, `formatBullet`, `buildLinks`) are ported with their `TFile`/`TFile.parent` params replaced by plain strings (`path`, `basename` computed via `split("/")`, parent-folder-name via one more split).

**Glue layer** (`mcp/tools-jd-scaffold.ts`'s new `obsidian_jd_reindex_category` tool + a source method): the async, `app.vault.read`/`app.vault.modify`-calling half. The one real design decision beyond Stage A's shape: the **area-management and system tiers read OTHER files' current content** (`bulletsForCategory`'s cross-read of sibling `XX.00` files), not just the one being written. Rather than have the glue layer selectively fetch only what a given tier needs (mirroring the original's tier-aware dispatch), it fetches uniformly: every category `XX.00` file's path AND current content, always, handed to the pure planner as one `Map<path, content>` — the planner picks what it actually needs per-tier. Simpler glue, at the cost of reading a few files a plan won't end up using on the ordinary-tier path; category counts are small (dozens, not thousands) so this is the right tradeoff.

## Global Constraints

- Pure logic in `kernel/jd-scaffold/`, no `obsidian` import (repo-wide rule).
- `JdScaffoldSource` (tools-jd-scaffold.ts) gains what this needs: `read(path): Promise<string | null>`, `modify(path, content): Promise<void>`, and a way to list every `XX.00`-shaped file's path (reuse `categoryFolders()`'s discovery, or add a sibling `indexFiles(): {path, prefix}[]` — decide at Task 1 time, whichever composes more cleanly with the existing `categoryFolders()`).
- `dry_run: z.boolean()` required, no default, matching every other tool in this module.
- Allowlist discipline matches the rest of `jd-scaffold`: the target `path` argument is checked; for area/system tiers, every sibling file the plan actually reads from is a DATA source, not a write target, so it does NOT need an allowlist check (reading a hidden note's content to compute what a VISIBLE note's Contents section should say is the same shape `obsidian_repoint_link`'s vault-wide scan already has — documented as a residual, not fixed there either); the WRITE target (`plan.newContent` going to `targetIndexPath`) is allowlist-checked like every other computed path in this module, unconditionally including under `dry_run: true`.
- `filesChanged`/`files` on the non-dry-run success (this module's own established convention now, per Stage A's review fix): `filesChanged: 1, files: [targetIndexPath]` — a reindex only ever writes the one target file, even at area/system tiers (it doesn't touch the sibling files it reads from).
- Report `preserved: PreservedDescription[]` in the result (matches the original's post-run Notice) — useful confirmation that descriptions survived the regen, not just a bare success.

## Tasks (sketch — full task-by-task detail, including inline test code, follows the Stage A plan's format; abbreviated here given the pattern is now established)

1. **Pure core**: `kernel/jd-scaffold/sections.ts` (generic `setSection`), `kernel/jd-scaffold/category-index.ts` (bullet format/parse, description overlay, the three tier planners unified behind one `planReindexCategory(input): ReindexPlan | null` entry point). Full unit coverage: bullet formatting/parsing round-trips, description preservation across a regen, all three tiers' dispatch (prefix `00` → system, `X0` → area-management, else → ordinary), the orphan-link prepend for sibling `XX.00` files, and the `## IDs`-section description-migration behavior the original's whole-file description harvest produces.
2. **Glue tool**: `obsidian_jd_reindex_category` in `tools-jd-scaffold.ts`, plus the `read`/`modify`/index-discovery additions to `JdScaffoldSource` (and its live adapter, `obsidian-jd-scaffold-source.ts`). Tests with a fake source exercising all three tiers, the allowlist check on the write target, `filesChanged`/`files`, and per-tier `dry_run: true` previews.
3. **Register + inventory**: already-registered module (no new `modules-mount.ts` entry needed, `jd-scaffold` exists) — just add the tool inside the existing registrar, update `TOOL-INVENTORY.md`'s jd-scaffold section (now 4 tools), full suite + `tsc`.

## Deferred

Nothing further deferred within category-index itself — this plan covers the whole original feature, all three tiers, not a narrowed slice (unlike Stage A's own split). If task 1's actual size proves the "3 tiers in one plan" call wrong the same way "4 scaffolding features in one stage" proved wrong for the original Stage A scoping, split then — noted as a live risk, not resolved in advance.
