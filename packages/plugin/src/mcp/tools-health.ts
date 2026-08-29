// tools-health.ts — the health module's tool surface, folded into vault-mcp from
// the standalone `obsidian-vault-health` Bash+eval scanner. Two READ-ONLY tools:
//
//   obsidian_health          — full tiered health scan → structured findings
//   obsidian_lint { scope }   — the same scan, restricted to one folder/note
//
// Both run the pure health core (kernel/health/*, Obsidian-free over an injected
// HealthSource). This module has NO write path: it only emits findings, never
// mutates — the fixing is a separate skill, out of scope. Every tool registers
// `readOnlyHint: true`, and there is no mutating registrar, no write guard, and
// no accept/approve verb anywhere here — that is the design, and it is what keeps
// the module a pure read surface.
//
// ── The key simplification vs. the standalone ────────────────────────────────
//
// The standalone launched Obsidian, waited for `metadataCache` to stabilize, read
// the resolver via one Advanced-URI `eval`, then quit. Inside vault-mcp that whole
// launch / readiness / quit dance DISAPPEARS: the plugin holds a live
// `app.metadataCache` (`resolvedLinks` / `unresolvedLinks` / `getTags`) directly,
// so the adapter reads the cache natively and the on-disk pass reads through the
// vault adapter. The one un-headless-testable seam is `obsidianHealthBackend`
// itself (verify it against a running Obsidian); the core is fully headless.
//
// Obsidian-free by construction: vault state arrives through the injected
// HealthSource (structurally typed, like ProvenanceSource / SkillsBackend), so
// every handler is unit-testable headlessly. The Obsidian adapter is
// `obsidianHealthBackend(app)` — the only vault coupling.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, codedError } from "./helpers.js";
import { resolveScope } from "./tools-links.js";
import type { GuardSettings } from "../guard.js";
import {
  scanHealth,
  filterFindingsToScope,
  summarize,
  healthConfigOf,
  type HealthSource,
  type HealthFile,
  type HealthFileExt,
} from "../kernel/health/index.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export interface HealthToolsCtx {
  /** The merged `modules.health.config` (defaults ∪ user override), as
   * `register()` receives it — resolved per connection like the module's enabled
   * state. Carries the empty-note char threshold. */
  config: Record<string, unknown>;
  /** The guard's settings — retained for parity with the other read modules. The
   * health scan runs over the WHOLE vault (a partial health report is a
   * misleading one — an orphan attachment referenced from outside the allowlist
   * would read as orphaned), so the allowlist is deliberately NOT applied here,
   * exactly as `provenance_reconcile` runs over its whole notes-dir. Absent ⇒
   * unfiltered. */
  getSettings?: () => GuardSettings;
}

/** The Obsidian adapter — the ONLY vault coupling for health in vault-mcp, and
 * (like `obsidianProvenanceBackend`) the one part not headlessly unit-tested;
 * verify it against a running Obsidian. Duck-typed against `app` (no `obsidian`
 * import) so this file stays headless-testable.
 *
 * The live `metadataCache.resolvedLinks` / `unresolvedLinks` are returned
 * directly — the scan only READS them, and they already handle basename / alias /
 * embed resolution, which is exactly why the standalone reached into the live app
 * for this half rather than re-implementing a resolver on disk. */
export function obsidianHealthBackend(app: {
  vault: {
    adapter: { read(path: string): Promise<string>; stat(path: string): Promise<{ type: "file" | "folder" } | null> };
    getMarkdownFiles(): Array<{ path: string; stat: { size: number } }>;
    getFiles(): Array<{ path: string; extension: string; stat: { size: number } }>;
  };
  metadataCache: {
    resolvedLinks: Record<string, Record<string, number>>;
    unresolvedLinks: Record<string, Record<string, number>>;
    // `getTags()` is real Obsidian API but not in the public `obsidian` types
    // (tools-complementary.ts casts to reach it) — declared OPTIONAL here so the
    // real `App` is structurally assignable, and guarded at the call site.
    getTags?(): Record<string, number>;
    getCache(path: string): { frontmatter?: Record<string, unknown> } | null;
  };
}): HealthSource {
  const adapter = app.vault.adapter;
  return {
    resolvedLinks: () => app.metadataCache.resolvedLinks ?? {},
    unresolvedLinks: () => app.metadataCache.unresolvedLinks ?? {},
    tags: () => (app.metadataCache.getTags ? app.metadataCache.getTags() : {}),
    markdownFiles: (): HealthFile[] => app.vault.getMarkdownFiles().map((f) => ({ path: f.path, size: f.stat.size })),
    allFiles: (): HealthFileExt[] =>
      app.vault.getFiles().map((f) => ({ path: f.path, ext: (f.extension ?? "").toLowerCase(), size: f.stat.size })),
    aliases: () => {
      // Per-note frontmatter aliases, normalized to a string[] — mirrors the
      // standalone's alias extraction so a link naming a note by its alias still
      // resolves to a single candidate. `aliases` or the singular `alias`; a
      // scalar is wrapped; non-string entries are dropped.
      const out: Record<string, string[]> = {};
      for (const f of app.vault.getMarkdownFiles()) {
        const fm = app.metadataCache.getCache(f.path)?.frontmatter;
        if (!fm) continue;
        // `||` (not `??`), matching the standalone's alias extraction: a falsy
        // `aliases:` (e.g. an empty string) falls through to the singular
        // `alias`, rather than seeding a spurious `[""]` alias bucket.
        const a = fm.aliases || fm.alias;
        if (a == null) continue;
        const xs = (Array.isArray(a) ? a : [a]).filter((x): x is string => typeof x === "string");
        if (xs.length) out[f.path] = xs;
      }
      return out;
    },
    async noteBody(path) {
      try {
        const st = await adapter.stat(path);
        if (!st || st.type !== "file") return null;
        return await adapter.read(path);
      } catch {
        return null;
      }
    },
  };
}

export function registerHealthTools(server: McpServer, source: HealthSource, ctx: HealthToolsCtx): void {
  const cfg = healthConfigOf(ctx.config);

  server.registerTool(
    "obsidian_health",
    {
      title: "Scan the vault for maintenance issues (tiered by fix risk)",
      description:
        "Read-only vault health scan. Returns findings TIERED BY FIX RISK: auto-safe (broken links whose target " +
        "uniquely resolves to exactly one existing note), approval-gated (empty / near-empty notes; orphan " +
        "attachments), and report-only (dangling links with no safe target, exact-duplicate note groups, low-signal " +
        "used-once tags), plus summary counts. Reads Obsidian's live resolver (metadataCache) and note bodies on " +
        "disk — nothing is written; the fixing is a separate skill. Runs over the whole vault (not allowlist-scoped).",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const findings = await scanHealth(source, cfg.emptyChars);
        return ok({ emptyChars: cfg.emptyChars, summary: summarize(findings), ...findings });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "obsidian_lint",
    {
      title: "Health scan restricted to one folder or note",
      description:
        "The same read-only health scan as obsidian_health, but with findings restricted to a single vault-relative " +
        "folder (or note). Link resolution and the orphan inbound-set are still computed vault-wide, so an attachment " +
        "referenced from OUTSIDE the scope is correctly not reported as orphaned. Broken links are attributed to the " +
        "note that contains them; empty notes and orphan attachments to their own path; a duplicate group is kept " +
        "whole if any member is in scope. Low-signal TAGS are omitted from a scoped lint (tags are vault-wide and " +
        "cannot be attributed to a folder — use obsidian_health for those). Read-only.",
      inputSchema: {
        scope: z
          .string()
          .min(1)
          .describe("Vault-relative folder or note path to restrict findings to, e.g. \"Projects\" or \"Projects/Note.md\"."),
      },
      annotations: RO,
    },
    async ({ scope }) => {
      try {
        // `scope` is a bare string, so it is NOT in guard.ts's PATH_KEYS and
        // `guardCall` never sees it — a tool taking one must check it by hand.
        // This one did not: until 2026-08-29 a session allowlisted to
        // `Projects/` could lint `Archive/Secrets` and get back dangling-link
        // text, orphan-attachment paths, empty-note paths and duplicate-group
        // paths for a folder it cannot otherwise see. `ctx.getSettings` sat on
        // the context declared and never called. Same resolver as
        // `obsidian_check_links` uses, deliberately, rather than a second copy.
        const { refusal } = resolveScope(scope, ctx.getSettings?.());
        if (refusal) return codedError(refusal.code, refusal.message);
        const findings = await scanHealth(source, cfg.emptyChars);
        const scoped = filterFindingsToScope(findings, scope);
        return ok({ scope, emptyChars: cfg.emptyChars, summary: summarize(scoped), ...scoped });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
