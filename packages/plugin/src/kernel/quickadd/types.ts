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

export type MacroStepResolved = UserScriptStepOk | UserScriptStepFailed | UnsupportedStep;

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

export interface QuickAddMacro {
  name: string;
  id: string;
  commands: QuickAddUserScriptCommand[];
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
