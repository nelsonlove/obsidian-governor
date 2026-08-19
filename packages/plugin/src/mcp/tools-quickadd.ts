// packages/plugin/src/mcp/tools-quickadd.ts
//
// obsidian_quickadd_compile — "QuickAdd macros as notes"
// (docs/superpowers/specs/2026-08-18-quickadd-macros-as-notes-design.md).
// Discovers Macro/UserScript, Template and Capture choice notes by
// frontmatter, resolves their wikilinks, feeds the pure transform
// (kernel/quickadd/transform.ts), and
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
//
// saveSettings() alone writes data.json but does NOT make a choice runnable:
// QuickAdd registers each command-bearing choice as an Obsidian command
// itself, via its own public addCommandForChoice/removeCommandForChoice.
// So the apply path mirrors QuickAdd's own updateCommand (remove-then-add)
// over the compiler-owned set — see applyCommands below.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok, okError, codedError } from "./helpers.js";
import type { ServerCtx } from "./tools-core.js";
import { RW } from "./tools-vault-write.js";
import type { GuardSettings } from "../guard.js";
import { transformChoices, isCompilerOwnedId, deriveChoiceId } from "../kernel/quickadd/transform.js";
import { EDITOR_COMMAND_TYPES } from "../kernel/quickadd/types.js";
import type {
  ChoiceNoteInput,
  MacroStepResolved,
  QuickAddMacroChoice,
  QuickAddTemplateChoice,
  QuickAddCaptureChoice,
  EditorCommandType,
  TemplateChoiceNoteInput,
  CaptureChoiceNoteInput,
  TemplateFieldOk,
  TemplateFieldFailed,
  CaptureTargetOk,
  CaptureTargetFailed,
} from "../kernel/quickadd/types.js";

/** 0 fresh choices AND this many about-to-be-deleted ones reads as a cold
 *  metadata cache, not a real change — see the mass-removal guard below. */
const MASS_REMOVAL_THRESHOLD = 3;

/** obsidian_quickadd_compile is disabled while a path allowlist is active: it
 *  enumerates EVERY markdown file in the vault to find choice notes, and the
 *  config it writes can install a UserScript from anywhere in the vault. It
 *  takes no path argument, so the guard can never scope it, and there is no
 *  honest partial answer — like the fileclass module and the Dataview query
 *  tools, the whole surface refuses rather than silently under- or
 *  over-reaching. */
function allowlistRefusal(settings: GuardSettings | null | undefined): { code: string; message: string } | null {
  if (settings?.allowlist && settings.allowlist.length > 0) {
    return {
      code: "out_of_allowlist",
      message:
        "obsidian_quickadd_compile is disabled while a path allowlist is active: compiling enumerates every " +
        "markdown file in the vault to discover choice notes, and it writes QuickAdd config that can install " +
        "UserScripts from anywhere in the vault — neither half can be scoped to an allowlist.",
    };
  }
  return null;
}

/** Extract the link target from a raw `[[target]]` or `[[target|alias]]`
 *  string. Returns null if the string isn't wikilink-shaped at all — a
 *  malformed `script:` value is a per-choice error, not a resolution
 *  failure, so the caller distinguishes the two.
 *
 *  Anything from `#` or `^` onward is stripped: Stage A resolves the NOTE a
 *  UserScript lives in, never a heading or block within it, so
 *  `[[script#Heading]]` must resolve exactly like `[[script]]` instead of
 *  failing with a confusing "could not resolve" on a subpath. Error messages
 *  quote the ORIGINAL raw text, so what the note actually wrote stays
 *  visible. */
function linkTarget(raw: string): string | null {
  const m = /^\[\[([^\]|]+)(\|[^\]]*)?\]\]$/.exec(raw.trim());
  if (!m) return null;
  const target = m[1].split(/[#^]/, 1)[0].trim();
  return target.length > 0 ? target : null;
}

/** A choice note's own display name: frontmatter `name:` when it is a
 *  non-empty string, else the basename with `.md` stripped. The ONE
 *  definition, shared by `collectChoiceNotes` (the note being compiled) and
 *  `resolveChoiceStep` (the note being referenced) so a Choice command's
 *  `name` can never drift from the name of the choice it points at. */
function displayNameOf(frontmatter: any, path: string): string {
  const name = frontmatter?.name;
  return typeof name === "string" && name.trim()
    ? name
    : path.split("/").pop()!.replace(/\.md$/, "");
}

/** The runtime membership check, built FROM the kernel's canonical array
 *  (types.ts) that the `EditorCommandType` union is itself derived from — so
 *  the type and the check cannot drift. Never re-list the strings here. */
const EDITOR_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(EDITOR_COMMAND_TYPES);

/** The `quickadd-type` values this compiler actually compiles into a choice.
 *  The ONE list, shared by `collectChoiceNotes` (what gets discovered) and
 *  `resolveChoiceStep` (what a `choice:` step may reference), because the two
 *  answer the same question: does this compile produce a choice for that
 *  note? `multi` is deliberately absent — Stage D territory, so a reference
 *  to one is still permanently dangling. */
const COMPILED_QUICKADD_TYPES = ["macro", "template", "capture"] as const;
const COMPILED_QUICKADD_TYPE_SET: ReadonlySet<unknown> = new Set(COMPILED_QUICKADD_TYPES);

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
    return { kind: "userscript", ok: false, error: `could not resolve "${raw}".` };
  }
  return {
    kind: "userscript",
    ok: true,
    scriptPath: dest.path,
    settings: (step.settings && typeof step.settings === "object") ? step.settings : {},
  };
}

function resolveChoiceStep(app: App, notePath: string, step: any): MacroStepResolved {
  const raw = String(step.choice ?? "");
  const target = linkTarget(raw);
  if (target === null) {
    return { kind: "choice", ok: false, error: `"${raw}" is not a [[wikilink]].` };
  }
  const dest = app.metadataCache.getFirstLinkpathDest(target, notePath);
  if (!dest) {
    return { kind: "choice", ok: false, error: `could not resolve "${raw}".` };
  }
  // Direct self-reference. QuickAdd has NO cycle detection in Choice-step
  // execution (executeChoice re-enters the same path with no visited set and
  // no depth cap — its only cycle guard is for template inclusion), so a
  // choice referencing its own note would loop forever in Obsidian at run
  // time. One typo away, so it is caught here rather than compiled. This is
  // the DIRECT case only — it is a cheap early rejection with a specific
  // message, and one step of one note is all this resolver can see. Multi-note
  // cycles (A → B → A, and longer) are caught over the whole compiled set by
  // `detectChoiceCycles` in kernel/quickadd/transform.ts.
  if (dest.path === notePath) {
    return {
      kind: "choice",
      ok: false,
      error:
        `"${raw}" refers to this same note (${notePath}). A choice step must reference a DIFFERENT choice ` +
        `note — QuickAdd has no cycle guard, so a self-reference would loop forever at run time.`,
    };
  }
  // getFirstLinkpathDest returns any TFile, not just markdown. A choice step
  // references another choice NOTE; anything else compiles a permanently
  // dangling reference that only fails at run time.
  if (dest.extension !== "md") {
    return {
      kind: "choice",
      ok: false,
      error:
        `"${raw}" resolves to "${dest.path}", which is not a markdown note. A choice step must reference ` +
        `another choice note (.md).`,
    };
  }
  // ...and a markdown note is still not necessarily a note this step can
  // reference. A Choice step is NOT restricted to Macro targets: QuickAdd's
  // ChoiceExecutor.execute() switches on the referenced choice's own `type`
  // with real cases for Template, Capture, Macro and Multi (verified against
  // QuickAdd's bundled main.js), and its own macro-builder feeds the Choice-
  // step picker every non-Multi choice. So the only thing that makes a target
  // unusable here is that THIS COMPILER never produces a choice for it — a
  // note with no `quickadd-type`, an unrecognized one, or `multi` (not
  // compiled yet) leaves a permanently dangling choiceId that fails only at
  // run time. Symmetric with the non-md check above, which already catches the
  // equivalent problem for a non-markdown target.
  const destFrontmatter = app.metadataCache.getFileCache(dest)?.frontmatter;
  if (!COMPILED_QUICKADD_TYPE_SET.has(destFrontmatter?.["quickadd-type"])) {
    return {
      kind: "choice",
      ok: false,
      error:
        `"${raw}" resolves to "${dest.path}", whose frontmatter does not declare a quickadd-type this compiler ` +
        `compiles (${COMPILED_QUICKADD_TYPES.join(", ")}). A choice step must reference a note this same compile ` +
        `turns into a choice; a note with no quickadd-type, an unrecognized one, or one not compiled yet (multi) ` +
        `leaves a dangling reference that fails only at run time.`,
    };
  }
  // The referenced note's compiled id is a pure function of its path — no
  // need to wait for that note to be compiled in this same run. Whether it
  // compiles SUCCESSFULLY is still unchecked (see types.ts's ChoiceStepOk doc
  // comment); reference cycles are the one exception, caught over the whole
  // compiled set by transform.ts's detectChoiceCycles.
  return {
    kind: "choice",
    ok: true,
    choiceId: deriveChoiceId(dest.path),
    displayName: displayNameOf(destFrontmatter, dest.path),
  };
}

/** A human-readable type name for a wrong-typed frontmatter value, so the
 *  error can say what the note actually wrote. */
function typeNameOf(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
}

/** Reads one OPTIONAL string-typed exposed frontmatter field
 *  (`folder:`, `file_name_format:`, `insert_after_heading:`).
 *
 *  Three outcomes, and the two non-obvious ones are deliberate:
 *  - Absent (or a valueless YAML key, which parses to `null`) ⇒ `undefined`,
 *    i.e. "not set" — the same "no value means absent" reading
 *    `resolveWaitStep` applies to `time:`.
 *  - Present but NOT a string (`folder: 42`) ⇒ a per-note compile ERROR.
 *    Silently treating it as unset would hand the author a choice that
 *    quietly does not do what the note configured, with no signal at all;
 *    this file errs on malformed input everywhere else.
 *  - A string ⇒ the TRIMMED value (empty after trimming ⇒ `undefined`).
 *    Trimming is not cosmetic: QuickAdd matches `insertAfter.after` against
 *    a heading EXACTLY, so a padded value can never match, and a padded
 *    folder is a folder nobody has. */
function optionalStringField(
  frontmatter: Record<string, unknown>,
  field: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const raw = frontmatter?.[field];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: `${field}: expected a string, got ${typeNameOf(raw)} (${JSON.stringify(raw) ?? String(raw)}).`,
    };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed === "" ? undefined : trimmed };
}

/** Resolves a `quickadd-type: template` note's frontmatter into a
 *  TemplateChoiceNoteInput. `template:` is required and must be a
 *  [[wikilink]] resolving to a markdown note — unlike `choice:` steps,
 *  there is no `quickadd-type` check on the target: a template is an
 *  ordinary vault note, not another compiler-managed choice. */
function resolveTemplateChoice(app: App, notePath: string, name: string, frontmatter: Record<string, unknown>): TemplateChoiceNoteInput {
  const raw = String(frontmatter?.["template"] ?? "");
  const target = linkTarget(raw);
  let template: TemplateFieldOk | TemplateFieldFailed;
  if (target === null) {
    template = { ok: false, error: `template: "${raw}" is not a [[wikilink]].` };
  } else {
    const dest = app.metadataCache.getFirstLinkpathDest(target, notePath);
    if (!dest) {
      template = { ok: false, error: `template: could not resolve "${raw}".` };
    } else if (dest.extension !== "md") {
      template = { ok: false, error: `template: "${raw}" resolves to a non-markdown file (${dest.path}).` };
    } else {
      template = { ok: true, templatePath: dest.path };
    }
  }
  const folder = optionalStringField(frontmatter, "folder");
  const fileNameFormat = optionalStringField(frontmatter, "file_name_format");
  // A wrong-typed exposed field fails the note. It rides the `template` slot
  // because that is the one failure channel a TemplateChoiceNoteInput has —
  // the message names the offending FIELD, so nothing reads as a template
  // resolution problem. A genuinely broken `template:` wins: it is the
  // required field, so it is the more useful thing to report first.
  const fieldError = !folder.ok ? folder.error : !fileNameFormat.ok ? fileNameFormat.error : null;
  if (template.ok && fieldError !== null) template = { ok: false, error: fieldError };
  const openFile = frontmatter?.["open_file"] === true;
  return {
    quickaddType: "template",
    notePath,
    name,
    template,
    folder: folder.ok ? folder.value : undefined,
    fileNameFormat: fileNameFormat.ok ? fileNameFormat.value : undefined,
    openFile,
  };
}

/** Resolves a `quickadd-type: capture` note's frontmatter into a
 *  CaptureChoiceNoteInput. `target:` is required. If it's [[wikilink]]-
 *  shaped, it resolves like `template:` above (must be markdown). If it
 *  contains `[[` but is not well-formed, it is a MALFORMED wikilink and
 *  fails the note (see below). Only a string with no `[[` in it at all is
 *  used (trimmed, but otherwise verbatim) as `captureTo` — QuickAdd's own
 *  dynamic-path format syntax, never interpreted here. */
function resolveCaptureChoice(app: App, notePath: string, name: string, frontmatter: Record<string, unknown>): CaptureChoiceNoteInput {
  const raw = frontmatter?.["target"];
  let target: CaptureTargetOk | CaptureTargetFailed;
  if (typeof raw !== "string" || raw.trim() === "") {
    target = { ok: false, error: `target: is required and must be a [[wikilink]] or a literal path string.` };
  } else {
    const linkedTarget = linkTarget(raw);
    if (linkedTarget === null && raw.includes("[[")) {
      // `linkTarget` is anchored: it matches a string that IS a wikilink end
      // to end, and nothing else. So a NEAR MISS — `[[Journal Log]` (a
      // missing bracket), `[[Journal Log]] extra`, `[[  ]]` — would otherwise
      // fall through to the verbatim branch below and compile a Capture
      // choice that writes to a file literally named `[[Journal Log].md`, with
      // no compile-time warning at all. `template:` (resolveTemplateChoice)
      // hard-errors on exactly this shape; the two fields document the same
      // reference mechanism and must behave the same way on a near miss.
      target = {
        ok: false,
        error:
          `target: "${raw}" looks like a malformed [[wikilink]] (it contains "[[" but is not a well-formed ` +
          `one). Write it as [[Note]] or [[Note|alias]] to reference a note, or remove the brackets to use it ` +
          `as a literal path string.`,
      };
    } else if (linkedTarget === null) {
      // Not wikilink-shaped at all — a literal dynamic-path string, used
      // as-is (QuickAdd's own format syntax, never interpreted here) apart
      // from a trim: same rationale as `optionalStringField`'s, and as the
      // wikilink branch, whose `linkTarget` already trims internally. A padded
      // path is a path nobody has, and QuickAdd would create it verbatim.
      target = { ok: true, captureTo: raw.trim() };
    } else {
      const dest = app.metadataCache.getFirstLinkpathDest(linkedTarget, notePath);
      if (!dest) {
        target = { ok: false, error: `target: could not resolve "${raw}".` };
      } else if (dest.extension !== "md") {
        target = { ok: false, error: `target: "${raw}" resolves to a non-markdown file (${dest.path}).` };
      } else {
        target = { ok: true, captureTo: dest.path };
      }
    }
  }
  const prepend = frontmatter?.["prepend"] === true;
  const task = frontmatter?.["task"] === true;
  const insertAfterHeading = optionalStringField(frontmatter, "insert_after_heading");
  // Same discipline as resolveTemplateChoice: a wrong-typed exposed field
  // fails the note through the one failure channel this input shape has, and
  // a genuinely broken required `target:` is reported first.
  if (target.ok && !insertAfterHeading.ok) target = { ok: false, error: insertAfterHeading.error };
  const createIfMissing = frontmatter?.["create_if_missing"] === true;
  return {
    quickaddType: "capture",
    notePath,
    name,
    target,
    prepend,
    task,
    insertAfterHeading: insertAfterHeading.ok ? insertAfterHeading.value : undefined,
    createIfMissing,
  };
}

function resolveWaitStep(_app: App, _notePath: string, step: any): MacroStepResolved {
  const raw = step.time;
  // `time:` with no value parses to null in YAML (and `time: ""` to an empty
  // string) — Number() maps both to 0, which would silently compile a 0ms
  // wait instead of the documented default. Treat "no value" as absent.
  const absent = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
  const timeMs = absent ? 100 : Number(raw);
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    return { kind: "wait", ok: false, error: `"time" must be a non-negative number, got ${JSON.stringify(raw)}.` };
  }
  return { kind: "wait", ok: true, timeMs };
}

function resolveObsidianCommandStep(app: App, _notePath: string, step: any): MacroStepResolved {
  const commandId = String(step.command_id ?? "");
  if (!commandId) {
    return { kind: "obsidian-command", ok: false, error: `"command_id" is missing or empty.` };
  }
  // app.commands is not in the public obsidian types — cast required.
  // The registry is a plain object, so a RAW lookup walks the prototype
  // chain: `command_id: "constructor"` (or "toString", "valueOf", …) answers
  // an Object.prototype member whose `.name` IS a truthy string, passing the
  // "no registered command" check below and compiling a dead Obsidian command
  // that only fails at QuickAdd run time. Own-property lookup only — same
  // reason mcp/tools-nav.ts's `own()` exists for the plugin registries.
  const registry = (app as any).commands?.commands;
  const registered =
    registry && typeof registry === "object" && Object.prototype.hasOwnProperty.call(registry, commandId)
      ? registry[commandId]
      : undefined;
  const displayName = registered?.name;
  if (typeof displayName !== "string") {
    return { kind: "obsidian-command", ok: false, error: `no registered command "${commandId}".` };
  }
  return { kind: "obsidian-command", ok: true, commandId, displayName };
}

function resolveEditorCommandStep(_app: App, _notePath: string, step: any): MacroStepResolved {
  const value = String(step.editor_command ?? "");
  if (!EDITOR_COMMAND_TYPE_SET.has(value)) {
    return {
      kind: "editor-command",
      ok: false,
      error: `"${value}" is not a recognized editor_command (expected one of: ${EDITOR_COMMAND_TYPES.join(", ")}).`,
    };
  }
  return { kind: "editor-command", ok: true, editorCommandType: value as EditorCommandType };
}

function resolveStep(app: App, notePath: string, step: any): MacroStepResolved {
  switch (step?.kind) {
    case "userscript": return resolveUserScriptStep(app, notePath, step);
    case "choice": return resolveChoiceStep(app, notePath, step);
    case "wait": return resolveWaitStep(app, notePath, step);
    case "obsidian-command": return resolveObsidianCommandStep(app, notePath, step);
    case "editor-command": return resolveEditorCommandStep(app, notePath, step);
    default: return { kind: "unsupported", ok: false, declaredKind: String(step?.kind ?? "undefined") };
  }
}

/** Reads every markdown note whose frontmatter declares a recognized
 *  `quickadd-type` (`macro`, `template`, `capture`) and builds its
 *  (unresolved-wikilink-aware) ChoiceNoteInput. Notes with no quickadd-type,
 *  or a quickadd-type this compiler doesn't yet recognize (`multi` — Stage D
 *  territory), are silently skipped: they are simply out of scope here, not
 *  an error. */
function collectChoiceNotes(app: App): ChoiceNoteInput[] {
  const inputs: ChoiceNoteInput[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) continue;
    const quickaddType = frontmatter["quickadd-type"];
    if (!COMPILED_QUICKADD_TYPE_SET.has(quickaddType)) continue;

    const name = displayNameOf(frontmatter, file.path);

    if (quickaddType === "macro") {
      const rawSteps = Array.isArray(frontmatter.steps) ? frontmatter.steps : [];
      const steps = rawSteps.map((s) => resolveStep(app, file.path, s));
      inputs.push({ quickaddType: "macro", notePath: file.path, name, steps });
    } else if (quickaddType === "template") {
      inputs.push(resolveTemplateChoice(app, file.path, name, frontmatter));
    } else {
      inputs.push(resolveCaptureChoice(app, file.path, name, frontmatter));
    }
  }
  return inputs;
}

/** The compiler-owned id of a live QuickAdd choice, or null if this entry is
 *  not one of ours. QuickAdd's `settings.choices` is other code's array: a
 *  stray `null`, a string, or an id-less object must read as "not compiler
 *  owned" (⇒ preserved untouched) rather than throw a raw TypeError and take
 *  down the whole compile. */
function ownedId(choice: unknown): string | null {
  if (!choice || typeof choice !== "object") return null;
  const id = (choice as { id?: unknown }).id;
  return typeof id === "string" && isCompilerOwnedId(id) ? id : null;
}

/** The reportable identity of a choice on either side of the diff. */
function describeChoice(choice: unknown, id: string): { id: string; name: string | null } {
  const name = (choice as { name?: unknown })?.name;
  return { id, name: typeof name === "string" ? name : null };
}

export function registerQuickAddTools(server: McpServer, app: App, ctx: ServerCtx): void {
  server.registerTool(
    "obsidian_quickadd_compile",
    {
      title: "Compile QuickAdd choice notes",
      description:
        "Compiles every Macro/UserScript, Template, and Capture choice note (frontmatter quickadd-type: macro, " +
        "template, or capture) into QuickAdd's live config. `dry_run: true` reports the would-be diff " +
        "(`added`/`changed`/`removed` compiler-owned choices) and any per-note errors without touching anything; " +
        "`dry_run: false` applies it via QuickAdd's own saveSettings() and (re)registers each choice's Obsidian " +
        "command via QuickAdd's own addCommandForChoice/removeCommandForChoice — `commandsRegistered: false` in " +
        "the response means the config was written but that API was unavailable, so the commands are stale " +
        "until QuickAdd reloads. " +
        "The write is a SCOPED MERGE — only choices this tool itself generated (a stable id derived from the " +
        "note's path) are added/updated/removed; every other choice in QuickAdd's config is left completely " +
        "untouched, whatever manages it. One malformed note fails only that note (reported in `errors`, and the " +
        "whole response carries isError: true so a partial compile is distinguishable from a clean one), never " +
        "the whole compile. A non-dry-run that would find zero choices while deleting three or more refuses " +
        "(`suspicious_mass_removal`) — that shape is a cold metadata cache far more often than a real change. " +
        "Supports Macro choices with userscript, choice, wait, obsidian-command, and editor-command steps. A " +
        "choice step must point at another note this compiler compiles (quickadd-type: macro, template, or " +
        "capture — anything else is a dangling reference), and choice steps that form a reference " +
        "cycle (A → B → A, or a self-reference) fail every note in the cycle — QuickAdd has no cycle guard, so " +
        "such a chain would loop forever at run time. " +
        "nested-choice and ai-assistant steps are not yet supported (per-choice error). " +
        "Template choices require `template:` as a [[wikilink]] to a markdown note; `folder:`, " +
        "`file_name_format:`, and `open_file:` are optionally threaded through. Capture choices require " +
        "`target:` — either a [[wikilink]] to a markdown note or a literal path string with no `[[` in it " +
        "(QuickAdd's own dynamic-path format syntax, passed through verbatim, never interpreted; a string that " +
        "contains `[[` but is not a well-formed wikilink is a per-note error, not a literal path); `prepend:`, " +
        "`task:`, `insert_after_heading:`, and `create_if_missing:` are optionally threaded through. The " +
        "string-valued fields (`folder:`, `file_name_format:`, `insert_after_heading:`) are trimmed, and a " +
        "non-string value in one of them is a per-note error rather than a silently ignored field. Every other native " +
        "Template/Capture field not listed here compiles to QuickAdd's own default, matching a freshly-created " +
        "choice. A note with an unrecognized quickadd-type (e.g. multi) is simply out of scope here — silently " +
        "skipped. Refuses outright while a path allowlist is active.",
      inputSchema: {
        dry_run: z.boolean().describe("If true, report the would-be diff and errors without writing anything."),
      },
      annotations: RW,
    },
    async ({ dry_run }) => {
      // FIRST, before anything else runs or is even enumerated: this tool
      // cannot be honestly scoped to a subset of the vault.
      const refusal = allowlistRefusal(ctx.getSettings());
      if (refusal) return codedError(refusal.code, refusal.message);

      // app.plugins is not in the public obsidian types — cast required.
      const quickadd = (app as any).plugins?.plugins?.quickadd;
      if (
        !quickadd?.settings ||
        typeof quickadd.saveSettings !== "function" ||
        !Array.isArray(quickadd.settings.choices)
      ) {
        return codedError("quickadd_unavailable", "QuickAdd is not installed, not enabled, or its API is unavailable.");
      }

      const inputs = collectChoiceNotes(app);
      const result = transformChoices(inputs);

      // The diff, computed once and reported identically by both modes. Only
      // the COMPILER-OWNED half of QuickAdd's config is ever in scope; a
      // hand-authored choice is neither added, changed nor removed by
      // definition, so it never appears here.
      const liveChoices = quickadd.settings.choices as unknown[];
      const previouslyOwned: Array<{ choice: unknown; id: string }> = [];
      const preserved: unknown[] = [];
      for (const choice of liveChoices) {
        const id = ownedId(choice);
        if (id === null) preserved.push(choice);
        else previouslyOwned.push({ choice, id });
      }
      const previousIds = new Set(previouslyOwned.map((p) => p.id));
      const freshIds = new Set(result.choices.map((c) => c.id));

      const added = result.choices.filter((c) => !previousIds.has(c.id)).map((c) => describeChoice(c, c.id));
      const changed = result.choices.filter((c) => previousIds.has(c.id)).map((c) => describeChoice(c, c.id));
      const removed = previouslyOwned
        .filter((p) => !freshIds.has(p.id))
        .map((p) => describeChoice(p.choice, p.id));

      const respond = (data: Record<string, unknown>) =>
        result.errors.length > 0 ? okError(data) : ok(data);

      if (dry_run) {
        return respond({
          dry_run: true,
          choices: result.choices,
          added,
          changed,
          removed,
          errors: result.errors,
        });
      }

      // Mass-removal guard. "Found nothing at all, about to delete several"
      // is the signature of a metadata cache that hasn't finished warming
      // (getFileCache returns no frontmatter for every note, so
      // collectChoiceNotes returns zero inputs) far more often than it is a
      // real change. A dry run still SHOWS it — this only refuses to DO it.
      if (result.choices.length === 0 && removed.length >= MASS_REMOVAL_THRESHOLD) {
        return codedError(
          "suspicious_mass_removal",
          `Refusing to apply: this compile found 0 choice notes while ${removed.length} compiler-owned choices ` +
            `(${removed.map((r) => r.name ?? r.id).join(", ")}) would be removed. That usually means Obsidian's ` +
            "metadata cache is still warming rather than that the notes are really gone. Retry in a moment, or " +
            "run with dry_run: true to inspect the would-be diff first.",
        );
      }

      // Scoped merge: drop every PREVIOUSLY compiler-owned choice (id starts
      // with qan:) unconditionally — a stale one whose note is gone or no
      // longer compiles is meant to disappear, not linger — then append this
      // compile's fresh set. Anything never compiler-owned (hand-authored,
      // or managed by another mechanism entirely) never entered
      // `previouslyOwned`, so it always survives untouched.
      quickadd.settings.choices = [...preserved, ...result.choices];
      await quickadd.saveSettings();

      // data.json is written; now make the choices actually RUNNABLE.
      // QuickAdd's own updateCommand is remove-then-add, so we do the same:
      // every previously-owned choice loses its command (whether it is being
      // replaced or has genuinely gone away), then every fresh choice gets
      // one. A version-skew or bare-fake QuickAdd without these methods must
      // degrade to "config written, commands not registered" — never throw
      // away an otherwise successful compile.
      const commandsRegistered = applyCommands(quickadd, previouslyOwned.map((p) => p.choice), result.choices);

      return respond({
        dry_run: false,
        applied: result.choices.length,
        commandsRegistered,
        choices: result.choices,
        added,
        changed,
        removed,
        errors: result.errors,
      });
    }
  );
}

/** Deregister then re-register the compiler-owned Obsidian commands. Returns
 *  false (rather than throwing) if QuickAdd doesn't expose the command API or
 *  it fails: the config is already saved at that point, and reporting
 *  "commands not registered" is strictly more useful than losing the result. */
function applyCommands(
  quickadd: any,
  previouslyOwned: unknown[],
  fresh: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice>,
): boolean {
  if (typeof quickadd.addCommandForChoice !== "function" || typeof quickadd.removeCommandForChoice !== "function") {
    return false;
  }
  try {
    for (const choice of previouslyOwned) quickadd.removeCommandForChoice(choice);
    for (const choice of fresh) quickadd.addCommandForChoice(choice);
    return true;
  } catch (e) {
    console.error("vault-mcp: QuickAdd command (de)registration failed after a compile", e);
    return false;
  }
}
