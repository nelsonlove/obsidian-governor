import type {
  ChoiceNoteInput,
  ChoiceError,
  QuickAddMacroChoice,
  QuickAddUserScriptCommand,
  TransformResult,
} from "./types.js";

/** The compiler-owned id marker — see the plan's "Compiler-owned choice
 *  identity" section. "quickadd as notes", short enough to keep ids
 *  readable in QuickAdd's own settings UI (which the compile tool's Task 2
 *  otherwise treats as read-only, but the id is still visible there). */
const ID_PREFIX = "qan:";

/** True iff `id` carries the compiler-owned `qan:` prefix — the single
 *  source of truth for "did this compiler write this choice?", shared by
 *  the derive* functions above and the glue layer's scoped-merge filter
 *  (mcp/tools-quickadd.ts), so the two can never drift on the prefix. */
export function isCompilerOwnedId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

export function deriveChoiceId(notePath: string): string {
  return `${ID_PREFIX}${notePath}#choice`;
}

export function deriveMacroId(notePath: string): string {
  return `${ID_PREFIX}${notePath}#macro`;
}

export function deriveStepId(notePath: string, index: number): string {
  return `${ID_PREFIX}${notePath}#step${index}`;
}

export function transformChoices(inputs: ChoiceNoteInput[]): TransformResult {
  const choices: QuickAddMacroChoice[] = [];
  const errors: ChoiceError[] = [];

  for (const input of inputs) {
    const result = transformOne(input);
    if (result.ok) {
      choices.push(result.choice);
    } else {
      errors.push({ notePath: input.notePath, message: result.message });
    }
  }

  return { choices, errors };
}

type OneResult = { ok: true; choice: QuickAddMacroChoice } | { ok: false; message: string };

function transformOne(input: ChoiceNoteInput): OneResult {
  if (input.steps.length === 0) {
    return { ok: false, message: `Macro "${input.name}" (${input.notePath}) has no steps.` };
  }

  const commands: QuickAddUserScriptCommand[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];

    if (step.kind === "unsupported") {
      return {
        ok: false,
        message:
          `Macro "${input.name}" (${input.notePath}) step ${i + 1} has unsupported step kind ` +
          `"${step.declaredKind}" (only "userscript" is implemented).`,
      };
    }

    if (!step.ok) {
      return {
        ok: false,
        message: `Macro "${input.name}" (${input.notePath}) step ${i + 1}: ${step.error}`,
      };
    }

    commands.push({
      id: deriveStepId(input.notePath, i),
      name: step.scriptPath,
      type: "UserScript",
      path: step.scriptPath,
      settings: step.settings,
    });
  }

  return {
    ok: true,
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Macro",
      command: true,
      runOnStartup: false,
      macro: {
        name: input.name,
        id: deriveMacroId(input.notePath),
        commands,
      },
    },
  };
}
