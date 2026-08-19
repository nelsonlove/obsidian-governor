// packages/plugin/src/kernel/quickadd/types.ts
//
// Pure types for the QuickAdd-macros-as-notes transform (Stage A: Macro
// choices whose steps are all UserScript). No `obsidian` import anywhere in
// this file or transform.ts — see packages/plugin/CLAUDE.md's kernel
// discipline. Wikilink resolution happens in the glue layer
// (mcp/tools-quickadd.ts); everything here works on already-resolved data.

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
 *  fails at RUN time, not compile time). */
export interface ChoiceStepOk {
  kind: "choice";
  ok: true;
  choiceId: string;
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
 *  frontmatter field that could drift from the real command name. */
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
 *  through. */
export type EditorCommandType =
  | "Cut"
  | "Copy"
  | "Paste"
  | "Paste with format"
  | "Select active line"
  | "Select link on active line"
  | "Move cursor to file start"
  | "Move cursor to file end"
  | "Move cursor to line start"
  | "Move cursor to line end";

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

/** A step whose declared `kind:` isn't implemented yet (Stage B+: choice,
 *  wait, obsidian-command, nested-choice, editor-command, ai-assistant).
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

/** One choice note's data, already resolved by the glue layer. Stage A only
 *  ever constructs `quickaddType: "macro"` — the union grows in later
 *  stages (template/capture/multi), which is why this is a union of one
 *  today rather than a bare object type. */
export interface MacroChoiceNoteInput {
  quickaddType: "macro";
  notePath: string;
  name: string;
  steps: MacroStepResolved[];
}

export type ChoiceNoteInput = MacroChoiceNoteInput;

/** QuickAdd's own native shapes (the Stage A subset — UserScript commands
 *  only) — verified against a real vault's
 *  `.obsidian/plugins/quickadd/data.json`. */
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

/** One choice note that failed to compile. The choice is OMITTED from
 *  `TransformResult.choices` entirely — never partially included. */
export interface ChoiceError {
  notePath: string;
  message: string;
}

export interface TransformResult {
  choices: QuickAddMacroChoice[];
  errors: ChoiceError[];
}
