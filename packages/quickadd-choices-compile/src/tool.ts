// packages/quickadd-choices-compile/src/tool.ts
//
// `run` (published by the host as `quickadd_choices_compile_run`) —
// "QuickAdd choices as notes". Discovers Macro/UserScript, Template,
// Capture and Multi choice notes by frontmatter, resolves their wikilinks,
// feeds the pure transform (./transform.ts), and applies the result via
// QuickAdd's own saveSettings() — this satellite is a full Obsidian plugin,
// so no raw data.json parsing is needed.
//
// FIRST SATELLITE OF THE SUITE (suite-split design §6): this plugin
// publishes its one tool to the vault-mcp host through vault-mcp-api, and
// exists partly to prove that path. Consequences of the publishing contract,
// each deliberate:
//   * The ALLOWLIST refusal moved to the HOST: a mutating external tool
//     whose arguments carry no recognized path field is blocked outright
//     while a path allowlist is active — which is this tool exactly, so the
//     old in-tool refusal is redundant and was dropped. Same net behavior,
//     one owner.
//   * Refusals THROW (`[code] detail` messages) — the host renders a thrown
//     error as its error envelope. Partial compiles cannot set the envelope's
//     isError bit through apiVersion 1 (the first real API gap this
//     extraction surfaced — filed for apiVersion 2); the response data
//     carries `partial: true` beside `errors` instead, and callers must
//     check it.
//   * The queue, journal, and kernel args still apply — external mutating
//     tools ride the host's guarded registration like every built-in.
//
// The write is a SCOPED MERGE, never a full overwrite: only choices whose
// id carries the qan: compiler-owned prefix (see transform.ts) are
// replaced/added/removed. Every other choice in QuickAdd's live config —
// hand-authored, or managed by another mechanism entirely — passes through
// completely untouched.
//
// saveSettings() alone writes data.json but does NOT make a choice runnable:
// QuickAdd registers each command-bearing choice as an Obsidian command
// itself, via its own public addCommandForChoice/removeCommandForChoice.
// So the apply path mirrors QuickAdd's own updateCommand (remove-then-add)
// over the compiler-owned set — see applyCommands below.

import { z } from "zod";
import type { App } from "obsidian";
import type { SdkToolSpec } from "vault-mcp-api";
import { transformChoices, isCompilerOwnedId, deriveChoiceId } from "./transform.js";
import { EDITOR_COMMAND_TYPES } from "./types.js";
import type {
  ChoiceNoteInput,
  MacroStepResolved,
  QuickAddMacroChoice,
  QuickAddTemplateChoice,
  QuickAddCaptureChoice,
  QuickAddMultiChoice,
  EditorCommandType,
  TemplateChoiceNoteInput,
  CaptureChoiceNoteInput,
  TemplateFieldOk,
  TemplateFieldFailed,
  CaptureTargetOk,
  CaptureTargetFailed,
} from "./types.js";

/** A refusal the host renders as its error envelope: thrown, `[code] detail`. */
function refuse(code: string, detail: string): never {
  throw new Error(`[${code}] ${detail}`);
}

/** A compiler-owned CONTAINER coming back EMPTY while it previously held this
 *  many choices reads as a cold metadata cache, not a real change — see the
 *  mass-removal guard below. Two containers can empty: the top-level
 *  compiler-owned set itself, and any surviving Multi's nested set. The count
 *  it is compared against is the NESTED-AWARE total (`countAll`), not the
 *  number of top-level entries. */
const MASS_REMOVAL_THRESHOLD = 3;

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

/** Every `quickadd-type` this compiler discovers and compiles into a
 *  choice — used by `collectChoiceNotes`'s discovery gate. Widened in
 *  Stage D to include `multi`. */
const DISCOVERABLE_QUICKADD_TYPES = ["macro", "template", "capture", "multi"] as const;
const DISCOVERABLE_QUICKADD_TYPE_SET: ReadonlySet<unknown> = new Set(DISCOVERABLE_QUICKADD_TYPES);

/** The `quickadd-type` values a Macro `choice:` step may reference —
 *  DELIBERATELY NARROWER than `DISCOVERABLE_QUICKADD_TYPES` as of Stage D.
 *  `multi` is discoverable/compilable but is NOT a valid choice-step target,
 *  and the reason is a UI-level restriction, NOT a runtime one: verified
 *  against QuickAdd's installed source, the macro-builder's Choice-step
 *  picker is fed by a helper that FLATTENS Multi containers away (it
 *  recurses into a Multi's members and pushes only the non-Multi leaves),
 *  so a human wiring a Choice step in QuickAdd's own UI can never point one
 *  at a Multi. QuickAdd's runtime, by contrast, has no such rule —
 *  `ChoiceExecutor.execute` has a real `case "Multi"` and would open that
 *  Multi's picker if some other means supplied its id. This compiler
 *  matches the UI restriction on purpose (you open a Multi, you don't
 *  invoke it from a Macro step). Do not widen this to match
 *  DISCOVERABLE_QUICKADD_TYPES without re-verifying that picker — the two
 *  constants answering DIFFERENT questions is the point, not a gap. */
const CHOICE_STEP_TARGET_TYPES = ["macro", "template", "capture"] as const;
const CHOICE_STEP_TARGET_TYPE_SET: ReadonlySet<unknown> = new Set(CHOICE_STEP_TARGET_TYPES);

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
  // QuickAdd's bundled main.js). Two DIFFERENT things narrow the target set
  // here:
  //   - a note this compiler never turns into a choice at all (no
  //     `quickadd-type`, or an unrecognized one) would leave a permanently
  //     dangling choiceId that fails only at run time; and
  //   - `multi`, which this compiler DOES compile, but which QuickAdd's own
  //     macro-builder excludes from its Choice-step picker (that picker's
  //     list flattens Multi containers away), so a human could never wire
  //     this step by hand either — see CHOICE_STEP_TARGET_TYPES above.
  // Symmetric with the non-md check above, which already catches the
  // equivalent problem for a non-markdown target.
  const destFrontmatter = app.metadataCache.getFileCache(dest)?.frontmatter;
  if (!CHOICE_STEP_TARGET_TYPE_SET.has(destFrontmatter?.["quickadd-type"])) {
    return {
      kind: "choice",
      ok: false,
      error:
        `"${raw}" resolves to "${dest.path}", whose frontmatter does not declare a quickadd-type a choice step may ` +
        `target (${CHOICE_STEP_TARGET_TYPES.join(", ")}). A note with no quickadd-type, or an unrecognized one, is ` +
        `never turned into a choice by this compile at all, so referencing it leaves a dangling reference that ` +
        `fails only at run time. quickadd-type: multi IS compiled by this tool, but is deliberately excluded as a ` +
        `choice-step target: QuickAdd's own macro-builder leaves Multi choices out of its Choice-step picker, so a ` +
        `Multi is opened, never invoked from a Macro step.`,
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

/** The folder a note lives directly inside — vault-root notes (no `/` in
 *  their path) return `""`. Pure path math; no `obsidian` folder API is
 *  needed anywhere in this file, because "does folder F have an anchored
 *  subfolder" reduces to "is some anchored folder's OWN parent === F",
 *  computable entirely from the flat markdown-file listing this function
 *  already has. */
function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Reads every markdown note whose frontmatter declares a recognized
 *  `quickadd-type` (`macro`, `template`, `capture`, `multi`) and builds its
 *  (unresolved-wikilink-aware) ChoiceNoteInput. Notes with no quickadd-type,
 *  or one this compiler doesn't recognize, are silently skipped: simply out
 *  of scope, not an error.
 *
 *  As of Stage D this is no longer a flat, independent per-note walk. A
 *  `quickadd-type: multi` note ANCHORS its own parent folder — every OTHER
 *  recognized note directly inside that same folder, and every direct
 *  SUBFOLDER that is itself anchored by its own multi-note, becomes a
 *  MEMBER of that Multi (compiled nested inside it) rather than a top-level
 *  entry. This function returns only the TOP-LEVEL inputs; membership is
 *  resolved recursively via `buildInput` below and lives inside each
 *  Multi's own `folder.members`. */
function collectChoiceNotes(app: App): ChoiceNoteInput[] {
  type Typed = { path: string; frontmatter: Record<string, unknown>; quickaddType: string };
  const typed: Typed[] = [];
  const multiNotesByFolder = new Map<string, string[]>();

  for (const file of app.vault.getMarkdownFiles()) {
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) continue;
    const quickaddType = frontmatter["quickadd-type"];
    if (!DISCOVERABLE_QUICKADD_TYPE_SET.has(quickaddType)) continue;
    typed.push({ path: file.path, frontmatter, quickaddType: quickaddType as string });
    if (quickaddType === "multi") {
      const folder = parentFolder(file.path);
      const list = multiNotesByFolder.get(folder) ?? [];
      list.push(file.path);
      multiNotesByFolder.set(folder, list);
    }
  }

  // A folder with exactly one multi-note is cleanly anchored. A folder with
  // 2+ is ambiguous — neither compiles, but this does NOT remove the folder
  // from consideration for its OTHER (non-multi) siblings, which stay
  // top-level (an authoring mistake in one note must not disappear unrelated
  // notes).
  const anchoredFolders = new Map<string, string>();
  const ambiguousFolders = new Map<string, string[]>();
  for (const [folder, notes] of multiNotesByFolder) {
    if (notes.length === 1) anchoredFolders.set(folder, notes[0]);
    else ambiguousFolders.set(folder, notes);
  }

  // `claimedBy` maps a CLAIMED note's path to the folder that claims it —
  // not just a Set, because the "claiming folder" is NOT always the note's
  // own parent (see below), and `buildInput` needs to filter "which notes
  // does THIS SPECIFIC anchored folder own" without re-deriving that
  // relationship from scratch.
  //
  // A plain note (macro/template/capture) is claimed by its own parent
  // folder, when that folder is anchored — straightforward.
  //
  // A MULTI-note is different: it anchors its OWN parent folder (call it
  // F), so `anchoredFolders.get(F)` is trivially itself — checking F for
  // anchoring would never determine whether the multi-note is ALSO nested
  // under some ANCESTOR Multi. The right question is one level further out:
  // is F's own parent (F's grandparent relative to the note) anchored by a
  // DIFFERENT multi-note? If so, F itself is a subfolder-member of that
  // outer anchor, and the note that anchors F (this multi-note) is what
  // ends up nested inside the outer Multi's `choices` — compiled recursively
  // via its own `folder.members`, which is unaffected by any of this.
  const claimedBy = new Map<string, string>();
  for (const t of typed) {
    if (t.quickaddType === "multi") {
      const ownFolder = parentFolder(t.path);
      // A multi-note AT vault root (no folder above it) can never be claimed —
      // parentFolder("") === "" would otherwise make it collide with its own
      // anchor and incorrectly self-claim, silently dropping both itself and
      // every other root-level choice note from the compile.
      if (ownFolder !== "") {
        const grandparent = parentFolder(ownFolder);
        if (anchoredFolders.has(grandparent)) claimedBy.set(t.path, grandparent);
      }
    } else {
      const folder = parentFolder(t.path);
      if (anchoredFolders.has(folder)) claimedBy.set(t.path, folder);
    }
  }

  const byPath = new Map(typed.map((t) => [t.path, t]));

  function buildInput(path: string): ChoiceNoteInput {
    const t = byPath.get(path)!;
    const name = displayNameOf(t.frontmatter, path);
    if (t.quickaddType === "macro") {
      const rawSteps = Array.isArray(t.frontmatter.steps) ? t.frontmatter.steps : [];
      const steps = rawSteps.map((s) => resolveStep(app, path, s));
      return { quickaddType: "macro", notePath: path, name, steps };
    }
    if (t.quickaddType === "template") return resolveTemplateChoice(app, path, name, t.frontmatter);
    if (t.quickaddType === "capture") return resolveCaptureChoice(app, path, name, t.frontmatter);

    // multi
    const folder = parentFolder(path); // == the folder this note anchors
    const ambiguous = ambiguousFolders.get(folder);
    if (ambiguous) {
      return {
        quickaddType: "multi",
        notePath: path,
        name,
        folder: {
          ok: false,
          error:
            `${ambiguous.length} quickadd-type: multi notes claim the same folder "${folder}" (${ambiguous.join(", ")}) ` +
            "— ambiguous, so none of them compiled. Move one to a different folder or remove the duplicate marking.",
        },
      };
    }
    // A member of THIS folder is exactly a note claimedBy THIS folder — not
    // `parentFolder(p) === folder`, which is only true for plain-note
    // members. A nested multi-note's own path lives one level DEEPER than
    // `folder` (inside the subfolder it itself anchors), so its claim was
    // recorded against `folder` (its grandparent-relative anchor) above,
    // not against its own immediate parent — `claimedBy` is exactly the
    // lookup that already encodes which is which.
    const memberPaths = [...byPath.keys()]
      .filter((p) => p !== path && claimedBy.get(p) === folder)
      .sort();
    return {
      quickaddType: "multi",
      notePath: path,
      name,
      folder: { ok: true, members: memberPaths.map((p) => buildInput(p)) },
    };
  }

  return typed.filter((t) => !claimedBy.has(t.path)).map((t) => buildInput(t.path));
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

/** How many choices a list of choices REALLY represents: 1 per entry, plus
 *  everything nested inside any Multi, recursively.
 *
 *  Stage D made this necessary. Before Multi existed, "n top-level entries"
 *  and "n choices" were the same number, so the mass-removal guard could
 *  count top-level entries. Now one top-level Multi can hold dozens of nested
 *  choices, and deleting it deletes all of them — a vault whose 40 Capture
 *  notes moved into one Multi folder would otherwise trip the guard at 41
 *  before the move and at 1 after it, for the exact same loss. The guard
 *  weighs an about-to-be-removed Multi by what it is actually removing.
 *
 *  Defensive like `ownedId`: `quickadd.settings.choices` (and the nested
 *  `choices` inside it) is other code's data — a stray null, string, or
 *  missing/blank `choices` array must count sanely rather than throw. A
 *  non-array `choices` on a Multi contributes 0 nested; every array ELEMENT
 *  counts 1 whatever it is, since a junk entry is still an entry that would
 *  disappear. */
function countAll(choices: unknown): number {
  if (!Array.isArray(choices)) return 0;
  let total = 0;
  for (const choice of choices) {
    total += 1;
    if (choice && typeof choice === "object" && (choice as { type?: unknown }).type === "Multi") {
      total += countAll((choice as { choices?: unknown }).choices);
    }
  }
  return total;
}

/** How many choices ONE entry holds nested inside it: `countAll` of a Multi's
 *  own `choices`, and 0 for anything that is not a Multi (a Capture holds
 *  nothing, and neither does a stray null/string in other code's array). A
 *  compiled Multi whose members all vanished therefore reads as 0, exactly
 *  like a note whose `quickadd-type` changed away from `multi` altogether. */
function nestedCount(choice: unknown): number {
  if (!choice || typeof choice !== "object") return 0;
  if ((choice as { type?: unknown }).type !== "Multi") return 0;
  return countAll((choice as { choices?: unknown }).choices);
}

/** Every compiler-owned Multi that SURVIVES this compile (same id on both
 *  sides) yet comes back holding NOTHING, while it previously held members —
 *  and how many choices each of them is about to drop.
 *
 *  This is the second shape of the mass-removal guard's one risk. A partially
 *  warm metadata cache can hand `collectChoiceNotes` a Multi's anchor note
 *  while hiding all 40 of its siblings: the Multi's id is then in BOTH the
 *  previous and the fresh set — neither `added` nor `removed`, merely
 *  `changed` — so a guard that only weighs top-level DISAPPEARANCES never
 *  looks at it, and 40 nested choices are silently discarded. Same cause and
 *  same cost as an outright top-level removal, different visible shape.
 *
 *  Deliberately EMPTY-only, not "shrank a lot": the guard has no override
 *  argument, so anything it refuses is unappliable until the vault changes.
 *  Requiring the container to come back empty keeps the refusal exactly as
 *  narrow as the top-level rule it mirrors (which fires only on 0 fresh
 *  choices), so genuinely deleting some members of a Multi still applies —
 *  keep one note in the folder and the compile goes through. The flip side is
 *  accepted: a partial cache that surfaces even one member slips past, just as
 *  one discovered note has always let a top-level mass removal through. */
function emptiedContainers(
  previouslyOwned: Array<{ choice: unknown; id: string }>,
  fresh: Array<{ id: string }>,
): Array<{ id: string; name: string | null; lost: number }> {
  const freshById = new Map(fresh.map((c) => [c.id, c as unknown]));
  const emptied: Array<{ id: string; name: string | null; lost: number }> = [];
  for (const p of previouslyOwned) {
    const now = freshById.get(p.id);
    // Absent from the fresh set = an outright top-level removal, already
    // weighed (with its whole subtree) by `removedTotal`. Not this case.
    if (now === undefined) continue;
    if (nestedCount(now) > 0) continue;
    const lost = nestedCount(p.choice);
    if (lost > 0) emptied.push({ ...describeChoice(p.choice, p.id), lost });
  }
  return emptied;
}

export function buildCompileTool(app: App): SdkToolSpec {
  return {
    name: "run",
    description:
        "Compiles every Macro/UserScript, Template, Capture, and Multi choice note (frontmatter quickadd-type: " +
        "macro, template, capture, or multi) into QuickAdd's live config. `dry_run: true` reports the would-be diff " +
        "(`added`/`changed`/`removed` compiler-owned choices) and any per-note errors without touching anything; " +
        "`dry_run: false` applies it via QuickAdd's own saveSettings() and (re)registers each choice's Obsidian " +
        "command via QuickAdd's own addCommandForChoice/removeCommandForChoice — `commandsRegistered: false` in " +
        "the response means the config was written but that API was unavailable, so the commands are stale " +
        "until QuickAdd reloads. " +
        "The write is a SCOPED MERGE — only choices this tool itself generated (a stable id derived from the " +
        "note's path) are added/updated/removed; every other choice in QuickAdd's config is left completely " +
        "untouched, whatever manages it. One malformed note fails only that note (reported in `errors`, and the " +
        "whole response carries isError: true so a partial compile is distinguishable from a clean one), never " +
        "the whole compile. A non-dry-run that would EMPTY a compiler-owned container of three or more choices " +
        "refuses (`suspicious_mass_removal`) — either the whole compiler-owned set (zero choice notes found while " +
        "three or more would be deleted) or a Multi that survives this compile with none of its members " +
        "rediscovered; both shapes are a cold or partly-warm metadata cache far more often than a real change. " +
        "Supports Macro choices with userscript, choice, wait, obsidian-command, and editor-command steps. A " +
        "choice step must point at another note whose quickadd-type may be targeted (macro, template, or " +
        "capture — an unrecognized type is a dangling reference, and multi is excluded on purpose, see below), " +
        "and choice steps that form a reference " +
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
        "choice. Multi choice notes (quickadd-type: multi) are also compiled — a Multi note anchors its own " +
        "parent folder, and every other recognized choice note (or anchored subfolder, itself a nested Multi) " +
        "directly inside that same folder becomes a member, compiled NESTED inside the Multi rather than as a " +
        "separate top-level entry; two or more multi-notes claiming the same folder is a per-note error for each " +
        "of them (their unrelated siblings are unaffected); a Multi choice is discoverable and compilable but is " +
        "NOT a valid choice: step target (matching QuickAdd's own macro-builder UI, whose Choice-step picker " +
        "leaves Multi choices out — a Multi is opened, not invoked from a Macro step). A multi note placed at the " +
        "VAULT ROOT anchors the entire vault root, so it " +
        "claims EVERY other root-level choice note as a member — the largest blast radius any single note's " +
        "placement has in this compiler, and worth checking before putting one there. " +
        "A note with an unrecognized quickadd-type is simply out of scope here — " +
        "silently skipped. Under an active path allowlist the HOST blocks this tool (it has no path argument " +
        "to scope). A partial compile is flagged in the DATA — `partial: true` beside `errors` — check it; the " +
        "response envelope alone does not distinguish partial from clean.",
    inputSchema: {
      dry_run: z.boolean().describe("If true, report the would-be diff and errors without writing anything."),
    },
    handler: async (args: Record<string, unknown>) => {
      // Schema validation enforces a boolean dry_run at the host — this is
      // the belt (review of #363): if validation is ever bypassed, a missing
      // or non-boolean dry_run REFUSES rather than silently taking the
      // mutating path. The dangerous direction is opt-in only.
      if (typeof args.dry_run !== "boolean") {
        refuse("invalid_arguments", "dry_run is required and must be a boolean — pass dry_run: true first to inspect the would-be diff.");
      }
      const dry_run = args.dry_run === true;
      // app.plugins is not in the public obsidian types — cast required.
      const quickadd = (app as any).plugins?.plugins?.quickadd;
      if (
        !quickadd?.settings ||
        typeof quickadd.saveSettings !== "function" ||
        !Array.isArray(quickadd.settings.choices)
      ) {
        refuse("quickadd_unavailable", "QuickAdd is not installed, not enabled, or its API is unavailable.");
      }

      const inputs = collectChoiceNotes(app);
      const result = transformChoices(inputs);

      // The diff, computed once and reported identically by both modes. Only
      // the COMPILER-OWNED half of QuickAdd's config is ever in scope; a
      // hand-authored choice is neither added, changed nor removed by
      // definition, so it never appears here.
      //
      // GRANULARITY (ruled, accepted): the diff is per TOP-LEVEL compiler-owned
      // choice. A change nested INSIDE an otherwise-identical Multi reports that
      // Multi as `changed` and never names which member changed — the same
      // granularity QuickAdd's own data.json has, where a nested choice carries
      // no identity outside its container. A caller who needs finer detail
      // should inspect the full `choices` field, which the response includes in
      // full under both `dry_run: true` and `dry_run: false`.
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
      const removedEntries = previouslyOwned.filter((p) => !freshIds.has(p.id));
      const removed = removedEntries.map((p) => describeChoice(p.choice, p.id));
      // What the removal would ACTUALLY cost, counting everything nested
      // inside an about-to-be-removed Multi — the number the mass-removal
      // guard weighs. `removed.length` is only the top-level entry count.
      const removedTotal = countAll(removedEntries.map((p) => p.choice));

      // apiVersion 1 cannot set the envelope's isError bit on a returned
      // result, so the partial-compile signal lives in the DATA (see header).
      const respond = (data: Record<string, unknown>) => ({ ...data, partial: result.errors.length > 0 });

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

      // Mass-removal guard. "A container came back EMPTY while it held several
      // choices a moment ago" is the signature of a metadata cache that hasn't
      // finished warming (getFileCache returns no frontmatter, so
      // collectChoiceNotes never sees those notes) far more often than it is a
      // real change. A dry run still SHOWS it — this only refuses to DO it.
      //
      // TWO containers can empty, and they are the same risk wearing different
      // shapes at the top level, so ONE quantity — `lostTotal`, the choices
      // this compile is about to lose out of an emptied container — feeds ONE
      // refusal:
      //   - the ROOT container (the whole compiler-owned top level) comes back
      //     empty ⇒ it loses `removedTotal`, the FULL subtree of every removed
      //     entry, not `removed.length`: one top-level Multi holding 40 nested
      //     choices is a 40-choice deletion, and counting top-level entries
      //     would let exactly that shape slip through at a nominal count of 1;
      //   - a surviving Multi's own container comes back empty ⇒ it loses
      //     everything it used to hold, even though its top-level id is
      //     present on both sides and so appears merely `changed`
      //     (`emptiedContainers`, above, and the reason it exists).
      // The two never double-count: with 0 fresh choices nothing survives, so
      // an empty root makes the survivor term 0, and a non-empty root
      // contributes nothing itself.
      const emptied = emptiedContainers(previouslyOwned, result.choices);
      const rootLost = result.choices.length === 0 ? removedTotal : 0;
      const lostTotal = rootLost + emptied.reduce((n, e) => n + e.lost, 0);
      if (lostTotal >= MASS_REMOVAL_THRESHOLD) {
        const tail =
          " That usually means Obsidian's metadata cache is still warming rather than that the notes are really " +
          "gone. Retry in a moment, or run with dry_run: true to inspect the would-be diff first.";
        if (rootLost > 0) {
          // The MESSAGE still lists the top-level names — they are the entries
          // a reader can go look for — and says how many choices that really
          // adds up to when the two differ.
          const nested =
            removedTotal > removed.length
              ? `, ${removedTotal} choices in total once everything nested inside them is counted`
              : "";
          refuse(
            "suspicious_mass_removal",
            `Refusing to apply: this compile found 0 choice notes while ${removed.length} top-level compiler-owned ` +
              `choices (${removed.map((r) => r.name ?? r.id).join(", ")}) would be removed${nested}.` + tail,
          );
        }
        const which = emptied.map((e) => `"${e.name ?? e.id}" (${e.lost})`).join(", ");
        refuse(
          "suspicious_mass_removal",
          `Refusing to apply: this compile kept ${emptied.length} compiler-owned Multi ` +
            `${emptied.length === 1 ? "choice" : "choices"} but discovered no members for ` +
            `${emptied.length === 1 ? "it" : "them"} — ${which} — dropping ${lostTotal} nested ` +
            `${lostTotal === 1 ? "choice" : "choices"} in total.` + tail,
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
    },
  };
}

/** Deregister then re-register the compiler-owned Obsidian commands. Returns
 *  false (rather than throwing) if QuickAdd doesn't expose the command API or
 *  it fails: the config is already saved at that point, and reporting
 *  "commands not registered" is strictly more useful than losing the result.
 *
 *  The two halves are ASYMMETRIC in QuickAdd's own source, and the asymmetry
 *  is why the remove call carries an options argument and the add call does
 *  not: `addCommandForChoice` recurses into a Multi's nested choices
 *  UNCONDITIONALLY, while `removeCommandForChoice(choice, opts)` recurses only
 *  when `opts?.recursive === true`. Without it, a nested choice that
 *  disappears (its note deleted or moved, or its containing Multi removed or
 *  replaced) keeps a palette command nobody can service — running it throws
 *  "Choice … not found" until Obsidian reloads. Passing the option is safe
 *  against every QuickAdd version: a version that doesn't read a second
 *  argument simply ignores it. */
function applyCommands(
  quickadd: any,
  previouslyOwned: unknown[],
  fresh: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice>,
): boolean {
  if (typeof quickadd.addCommandForChoice !== "function" || typeof quickadd.removeCommandForChoice !== "function") {
    return false;
  }
  try {
    for (const choice of previouslyOwned) quickadd.removeCommandForChoice(choice, { recursive: true });
    for (const choice of fresh) quickadd.addCommandForChoice(choice);
    return true;
  } catch (e) {
    console.error("quickadd-choices-compile: QuickAdd command (de)registration failed after a compile", e);
    return false;
  }
}
