// packages/plugin/src/kernel/quickadd/types.ts
//
// Pure types for the QuickAdd-macros-as-notes transform. Covers Macro
// choices (userscript, choice, wait, obsidian-command and editor-command
// steps), Template choices, Capture choices, and Multi choices (a
// folder-anchored choice whose members are resolved by the glue layer).
// No `obsidian` import anywhere in
// this file or transform.ts — see packages/plugin/CLAUDE.md's kernel
// discipline. Wikilink resolution and folder-anchoring discovery happen in
// the glue layer (mcp/tools-quickadd.ts); everything here works on
// already-resolved data.

/** A UserScript step whose `script:` wikilink resolved to a real vault path. */
export interface UserScriptStepOk {
  kind: "userscript";
  ok: true;
  scriptPath: string;
  settings: Record<string, unknown>;
}

/** A UserScript step whose `script:` wikilink did NOT resolve (missing,
 *  ambiguous, malformed). `error` is a human-readable reason surfaced
 *  verbatim in the resulting ChoiceError message. */
export interface UserScriptStepFailed {
  kind: "userscript";
  ok: false;
  error: string;
}

/** A Choice step whose `choice:` wikilink resolved to another choice note.
 *  `choiceId` is that note's OWN compiler-owned id (deriveChoiceId of the
 *  resolved note path) — computed directly by the glue layer without
 *  waiting for that note to be compiled itself, since ids are a pure
 *  function of note path. Whether the referenced note actually compiles
 *  into a valid choice is NOT checked here — same discipline QuickAdd's
 *  own data.json uses (choiceId is just a stored reference; a dangling one
 *  fails at RUN time, not compile time). Reference CYCLES are the one
 *  exception, and they are caught after the fact rather than here: see
 *  `detectChoiceCycles` in transform.ts, which runs over the whole compiled
 *  set once every note's steps are resolved.
 *
 *  `displayName` is the TARGET note's own display name, derived exactly the
 *  way a choice note's own name is (frontmatter `name:` if it is a non-empty
 *  string, else the basename with `.md` stripped). A native QuickAdd Choice
 *  command stores the referenced choice's name there, not a generic label —
 *  and QuickAdd's own dangling-reference failure path logs
 *  `choice '<command.name>' could not be found.`, so a generic label would
 *  name nothing useful at run time. */
export interface ChoiceStepOk {
  kind: "choice";
  ok: true;
  choiceId: string;
  displayName: string;
}
export interface ChoiceStepFailed {
  kind: "choice";
  ok: false;
  error: string;
}

/** A Wait step — a bare pause, `timeMs` in milliseconds. */
export interface WaitStepOk {
  kind: "wait";
  ok: true;
  timeMs: number;
}
export interface WaitStepFailed {
  kind: "wait";
  ok: false;
  error: string;
}

/** An Obsidian-command step. `displayName` is the CURRENTLY-registered
 *  command's own name (resolved by the glue layer via
 *  `app.commands.commands[commandId]?.name`), matching what QuickAdd's own
 *  UI does when a human adds this step type — never a separately-typed
 *  frontmatter field that could drift from the real command name.
 *
 *  That resolution is a COMPILE-TIME SNAPSHOT: if the plugin providing the
 *  command is later disabled, the next compile fails this step and therefore
 *  drops the whole choice from QuickAdd's live config (deregistering its
 *  Obsidian command) on the strength of another plugin's load state rather
 *  than any edit to the note. That is ACCEPTED, not mitigated — it is the
 *  same "a malformed note fails only that note" discipline as everywhere
 *  else here, and the failure is always surfaced (`errors` plus
 *  `isError: true`, and visible up front under `dry_run`). */
export interface ObsidianCommandStepOk {
  kind: "obsidian-command";
  ok: true;
  commandId: string;
  displayName: string;
}
export interface ObsidianCommandStepFailed {
  kind: "obsidian-command";
  ok: false;
  error: string;
}

/** QuickAdd's fixed, closed set of built-in editor actions — verified
 *  exhaustively against QuickAdd's own `executeEditorCommand` switch
 *  statement in main.js. There is no user-extensible variant of this step
 *  kind; a value outside this set is a per-choice error, never passed
 *  through.
 *
 *  This array is the ONE canonical list: the `EditorCommandType` union is
 *  derived from it, and the glue layer's runtime membership check
 *  (mcp/tools-quickadd.ts) is built from it too. Two hand-kept lists — a
 *  union here and a `Set` there — drift silently, because a `Set` only
 *  catches an invalid VALUE at run time, never a union member with no
 *  runtime entry or the reverse. */
export const EDITOR_COMMAND_TYPES = [
  "Cut",
  "Copy",
  "Paste",
  "Paste with format",
  "Select active line",
  "Select link on active line",
  "Move cursor to file start",
  "Move cursor to file end",
  "Move cursor to line start",
  "Move cursor to line end",
] as const;

export type EditorCommandType = (typeof EDITOR_COMMAND_TYPES)[number];

export interface EditorCommandStepOk {
  kind: "editor-command";
  ok: true;
  editorCommandType: EditorCommandType;
}
export interface EditorCommandStepFailed {
  kind: "editor-command";
  ok: false;
  error: string;
}

/** A step whose declared `kind:` isn't implemented yet (nested-choice,
 *  ai-assistant — choice, wait, obsidian-command and editor-command all
 *  landed in Stage B), or isn't a recognized kind at all.
 *  Carried through as a normal per-choice failure rather than a thrown
 *  error, so one note using a not-yet-supported step kind doesn't take
 *  down the whole compile. */
export interface UnsupportedStep {
  kind: "unsupported";
  ok: false;
  declaredKind: string;
}

export type MacroStepResolved =
  | UserScriptStepOk
  | UserScriptStepFailed
  | ChoiceStepOk
  | ChoiceStepFailed
  | WaitStepOk
  | WaitStepFailed
  | ObsidianCommandStepOk
  | ObsidianCommandStepFailed
  | EditorCommandStepOk
  | EditorCommandStepFailed
  | UnsupportedStep;

/** One Macro choice note's data, already resolved by the glue layer. The
 *  `quickaddType` discriminant is what makes `ChoiceNoteInput` a
 *  discriminated union — three members today (macro/template/capture), and
 *  `multi` still to come. */
export interface MacroChoiceNoteInput {
  quickaddType: "macro";
  notePath: string;
  name: string;
  steps: MacroStepResolved[];
}

/** The `template:` wikilink resolved to a real vault path. */
export interface TemplateFieldOk {
  ok: true;
  templatePath: string;
}
/** The `template:` wikilink did NOT resolve, or the frontmatter field is
 *  missing/not wikilink-shaped. `error` is human-readable, surfaced
 *  verbatim in the resulting ChoiceError message. */
export interface TemplateFieldFailed {
  ok: false;
  error: string;
}

/** One `quickadd-type: template` choice note's data, already resolved by
 *  the glue layer. `folder`/`fileNameFormat`/`openFile` are the curated
 *  subset this stage exposes — see the plan's "Deliberate scope narrowing"
 *  section for the full field-default rationale. `folder` and
 *  `fileNameFormat` are `undefined` when the note's frontmatter omits them
 *  (compiles to QuickAdd's own `enabled: false` default), never an empty
 *  string standing in for "not set". */
export interface TemplateChoiceNoteInput {
  quickaddType: "template";
  notePath: string;
  name: string;
  template: TemplateFieldOk | TemplateFieldFailed;
  folder: string | undefined;
  fileNameFormat: string | undefined;
  openFile: boolean;
}

/** The `target:` field resolved. `captureTo` is either the resolved
 *  wikilink's note path (when `target:` was wikilink-shaped) or the trimmed
 *  literal string (QuickAdd's own dynamic-path format syntax — this compiler
 *  does not interpret it, only passes it through). */
export interface CaptureTargetOk {
  ok: true;
  captureTo: string;
}
/** The `target:` field is missing, was wikilink-shaped but did not resolve,
 *  or was a MALFORMED wikilink (it contains `[[` without being a well-formed
 *  one — `[[Note]`, `[[Note]] extra`, `[[  ]]`). A string containing no `[[`
 *  at all is ALWAYS `CaptureTargetOk` — there is no way for a literal path
 *  string to "fail" resolution, since it is never resolved, only passed
 *  through. */
export interface CaptureTargetFailed {
  ok: false;
  error: string;
}

/** One `quickadd-type: capture` choice note's data, already resolved by
 *  the glue layer. `prepend`/`task`/`insertAfterHeading`/`createIfMissing`
 *  are the curated subset this stage exposes. `insertAfterHeading`
 *  `undefined` means the note's frontmatter omitted `insert_after_heading:`
 *  (compiles to `insertAfter.enabled: false`). */
export interface CaptureChoiceNoteInput {
  quickaddType: "capture";
  notePath: string;
  name: string;
  target: CaptureTargetOk | CaptureTargetFailed;
  prepend: boolean;
  task: boolean;
  insertAfterHeading: string | undefined;
  createIfMissing: boolean;
}

/** A `quickadd-type: multi` note's folder, resolved by the glue layer (see
 *  mcp/tools-quickadd.ts's folder-anchoring discovery). `MultiFolderOk`
 *  carries the recursively-resolved membership: every note directly inside
 *  the multi note's OWN parent folder that this compiler claims — sibling
 *  notes with a recognized quickadd-type, and sibling SUBFOLDERS that are
 *  themselves anchored by their own multi-note (nested Multi-in-Multi,
 *  arbitrarily deep — folders cannot cycle, so this recursion always
 *  terminates). `MultiFolderFailed` covers the one way a Multi note itself
 *  can fail: another quickadd-type: multi note claims the SAME folder —
 *  ambiguous, so neither compiles (their sibling notes are unaffected and
 *  stay top-level, since an authoring mistake in one note's frontmatter
 *  must not make unrelated notes vanish). */
export interface MultiFolderOk {
  ok: true;
  members: ChoiceNoteInput[];
}
export interface MultiFolderFailed {
  ok: false;
  error: string;
}

/** One `quickadd-type: multi` choice note's data, already resolved by the
 *  glue layer. Unlike Macro/Template/Capture, a Multi note carries no
 *  required companion frontmatter field of its own — its members come
 *  entirely from folder membership, not from anything written in the note. */
export interface MultiChoiceNoteInput {
  quickaddType: "multi";
  notePath: string;
  name: string;
  folder: MultiFolderOk | MultiFolderFailed;
}

export type ChoiceNoteInput = MacroChoiceNoteInput | TemplateChoiceNoteInput | CaptureChoiceNoteInput | MultiChoiceNoteInput;

/** QuickAdd's own native macro-command shapes — verified against a real
 *  vault's `.obsidian/plugins/quickadd/data.json`. UserScript first; the
 *  Choice/Wait/Obsidian/EditorCommand shapes below are the rest of the set
 *  this compiler emits. */
export interface QuickAddUserScriptCommand {
  id: string;
  name: string;
  type: "UserScript";
  path: string;
  settings: Record<string, unknown>;
}

export interface QuickAddChoiceCommand {
  id: string;
  name: string;
  type: "Choice";
  choiceId: string;
}

export interface QuickAddWaitCommand {
  id: string;
  name: string;
  type: "Wait";
  time: number;
}

export interface QuickAddObsidianCommand {
  id: string;
  name: string;
  type: "Obsidian";
  commandId: string;
}

export interface QuickAddEditorCommand {
  id: string;
  name: string;
  type: "EditorCommand";
  editorCommandType: EditorCommandType;
}

export interface QuickAddMacro {
  name: string;
  id: string;
  commands: Array<
    QuickAddUserScriptCommand | QuickAddChoiceCommand | QuickAddWaitCommand | QuickAddObsidianCommand | QuickAddEditorCommand
  >;
}

export interface QuickAddMacroChoice {
  id: string;
  name: string;
  type: "Macro";
  command: true;
  runOnStartup: false;
  macro: QuickAddMacro;
}

/** QuickAdd's native Template-choice shape — verified against QuickAdd's
 *  decompiled source (class `rd`), not assumed from the design spec (see
 *  the plan's "Ground truth vs. the spec" section). Every field this stage
 *  doesn't expose via frontmatter carries QuickAdd's own literal default,
 *  so a compiled choice is byte-identical to a freshly-created one for
 *  anything Stage C doesn't author. */
export interface QuickAddTemplateChoice {
  id: string;
  name: string;
  type: "Template";
  command: true;
  templatePath: string;
  fileNameFormat: { enabled: boolean; format: string };
  discoverExistingNotesBeforeCreate: false;
  folder: {
    enabled: boolean;
    folders: string[];
    chooseWhenCreatingNote: false;
    createInSameFolderAsActiveFile: false;
    chooseFromSubfolders: false;
  };
  appendLink: false;
  copyLinkToClipboard: false;
  openFile: boolean;
  fileOpening: { location: "tab"; direction: "vertical"; mode: "default"; focus: true };
  fileExistsBehavior: { kind: "prompt" };
}

/** QuickAdd's native Capture-choice shape — verified against QuickAdd's
 *  decompiled source (class `qh`). Same "unexposed fields carry QuickAdd's
 *  own default" discipline as QuickAddTemplateChoice above. */
export interface QuickAddCaptureChoice {
  id: string;
  name: string;
  type: "Capture";
  command: true;
  appendLink: false;
  copyLinkToClipboard: false;
  captureTo: string;
  captureToActiveFile: false;
  captureToCanvasNodeId: "";
  activeFileWritePosition: "cursor";
  createFileIfItDoesntExist: { enabled: boolean; createWithTemplate: false; template: "" };
  format: { enabled: false; format: "" };
  insertAfter: {
    enabled: boolean;
    after: string;
    insertAtEnd: false;
    considerSubsections: false;
    createIfNotFound: false;
    createIfNotFoundLocation: "top";
    inline: false;
    replaceExisting: false;
    blankLineAfterMatchMode: "auto";
    promptHeading: false;
  };
  insertBefore: { enabled: false; before: ""; createIfNotFound: false; createIfNotFoundLocation: "top" };
  newLineCapture: { enabled: false; direction: "below" };
  prepend: boolean;
  task: boolean;
  openFile: false;
  fileOpening: { location: "tab"; direction: "vertical"; mode: "default"; focus: true };
  templater: { afterCapture: "none" };
}

/** QuickAdd's native Multi-choice shape — verified against QuickAdd's
 *  decompiled source (class `ng`). The whole shape: base fields plus
 *  `choices` (RECURSIVE — any choice type, including another Multi) and
 *  `collapsed` (UI-only; not exposed via frontmatter this stage, always
 *  false). `command` is always `false`, matching real QuickAdd's own
 *  restriction that a Multi choice cannot run non-interactively — never a
 *  configurable field on this type. */
export interface QuickAddMultiChoice {
  id: string;
  name: string;
  type: "Multi";
  command: false;
  choices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice>;
  collapsed: false;
}

/** One choice note that failed to compile. The choice is OMITTED from
 *  `TransformResult.choices` entirely — never partially included. */
export interface ChoiceError {
  notePath: string;
  message: string;
}

export interface TransformResult {
  choices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice>;
  errors: ChoiceError[];
}
