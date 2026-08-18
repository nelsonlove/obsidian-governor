// packages/plugin/src/mcp/tools-quickadd.ts
//
// obsidian_quickadd_compile — Stage A of "QuickAdd macros as notes"
// (docs/superpowers/specs/2026-08-18-quickadd-macros-as-notes-design.md).
// Discovers Macro/UserScript choice notes by frontmatter, resolves their
// wikilinks, feeds the pure transform (kernel/quickadd/transform.ts), and
// applies the result via QuickAdd's own saveSettings() — vault-mcp is a
// full Obsidian plugin, so no raw data.json parsing is needed.
//
// The write is a SCOPED MERGE, never a full overwrite: only choices whose
// id carries the qan: compiler-owned prefix (see transform.ts) are
// replaced/added/removed. Every other choice in QuickAdd's live config —
// hand-authored, or managed by another mechanism entirely (e.g. the vault's
// own sync-quickadd-choices.js during the migration window) — passes
// through completely untouched. This is what lets Stage A ship before
// every choice in the vault is migrated to a note.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok, codedError } from "./helpers.js";
import type { ServerCtx } from "./tools-core.js";
import { transformChoices } from "../kernel/quickadd/transform.js";
import type { ChoiceNoteInput, MacroStepResolved, QuickAddMacroChoice } from "../kernel/quickadd/types.js";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const ID_PREFIX = "qan:";

/** Extract the link target from a raw `[[target]]` or `[[target|alias]]`
 *  string. Returns null if the string isn't wikilink-shaped at all — a
 *  malformed `script:` value is a per-choice error, not a resolution
 *  failure, so the caller distinguishes the two. */
function linkTarget(raw: string): string | null {
  const m = /^\[\[([^\]|]+)(\|[^\]]*)?\]\]$/.exec(raw.trim());
  return m ? m[1] : null;
}

function resolveUserScriptStep(app: App, notePath: string, step: any): MacroStepResolved {
  if (step?.kind !== "userscript") {
    return { kind: "unsupported", ok: false, declaredKind: String(step?.kind ?? "undefined") };
  }
  const raw = String(step.script ?? "");
  const target = linkTarget(raw);
  if (target === null) {
    return { kind: "userscript", ok: false, error: `"${raw}" is not a [[wikilink]].` };
  }
  // app.metadataCache is fully typed in obsidian's public API.
  const dest = app.metadataCache.getFirstLinkpathDest(target, notePath);
  if (!dest) {
    return { kind: "userscript", ok: false, error: `could not resolve "[[${target}]]".` };
  }
  return {
    kind: "userscript",
    ok: true,
    scriptPath: dest.path,
    settings: (step.settings && typeof step.settings === "object") ? step.settings : {},
  };
}

/** Reads every markdown note whose frontmatter declares `quickadd-type:
 *  macro` and builds its (unresolved-wikilink-aware) ChoiceNoteInput. Notes
 *  with no quickadd-type, or a quickadd-type other than "macro" (Stage B+
 *  territory — template/capture/multi), are silently skipped: they are
 *  simply out of Stage A's scope, not an error. */
function collectChoiceNotes(app: App): ChoiceNoteInput[] {
  const inputs: ChoiceNoteInput[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter || frontmatter["quickadd-type"] !== "macro") continue;

    const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name
      : file.path.split("/").pop()!.replace(/\.md$/, "");

    const rawSteps = Array.isArray(frontmatter.steps) ? frontmatter.steps : [];
    const steps = rawSteps.map((s) => resolveUserScriptStep(app, file.path, s));

    inputs.push({ quickaddType: "macro", notePath: file.path, name, steps });
  }
  return inputs;
}

export function registerQuickAddTools(server: McpServer, app: App, ctx: ServerCtx): void {
  server.registerTool(
    "obsidian_quickadd_compile",
    {
      title: "Compile QuickAdd choice notes",
      description:
        "Compiles every Macro/UserScript choice note (frontmatter quickadd-type: macro) into QuickAdd's live " +
        "config. `dry_run: true` reports the compiled choices and any per-note errors without touching anything; " +
        "`dry_run: false` applies it via QuickAdd's own saveSettings(). The write is a SCOPED MERGE — only " +
        "choices this tool itself generated (a stable id derived from the note's path) are added/updated/removed; " +
        "every other choice in QuickAdd's config is left completely untouched, whatever manages it. One malformed " +
        "note fails only that note (reported in `errors`), never the whole compile. Stage A: Macro choices whose " +
        "steps are all UserScript. A note with a different quickadd-type, or a step of a different kind, is simply " +
        "out of scope here — silently skipped (quickadd-type notes) or a per-choice error (unsupported step kind).",
      inputSchema: {
        dry_run: z.boolean().describe("If true, report the compiled choices and errors without writing anything."),
      },
      annotations: RW,
    },
    async ({ dry_run }) => {
      // app.plugins is not in the public obsidian types — cast required.
      const quickadd = (app as any).plugins?.plugins?.quickadd;
      if (!quickadd?.settings || typeof quickadd.saveSettings !== "function") {
        return codedError("quickadd_unavailable", "QuickAdd is not installed, not enabled, or its API is unavailable.");
      }

      const inputs = collectChoiceNotes(app);
      const result = transformChoices(inputs);

      if (dry_run) {
        return ok({ dry_run: true, choices: result.choices, errors: result.errors });
      }

      // Scoped merge: drop every PREVIOUSLY compiler-owned choice (id starts
      // with qan:) unconditionally — a stale one whose note is gone or no
      // longer compiles is meant to disappear, not linger — then append this
      // compile's fresh set. Anything never compiler-owned (hand-authored,
      // or managed by another mechanism entirely) never enters this
      // filter's false branch, so it always survives untouched.
      const preserved = (quickadd.settings.choices as QuickAddMacroChoice[]).filter(
        (c: any) => typeof c.id !== "string" || !c.id.startsWith(ID_PREFIX)
      );
      quickadd.settings.choices = [...preserved, ...result.choices];
      await quickadd.saveSettings();

      return ok({ dry_run: false, applied: result.choices.length, choices: result.choices, errors: result.errors });
    }
  );
}
