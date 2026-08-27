import type {
  ChoiceNoteInput,
  ChoiceError,
  MacroChoiceNoteInput,
  TemplateChoiceNoteInput,
  CaptureChoiceNoteInput,
  MultiChoiceNoteInput,
  QuickAddMacro,
  QuickAddMacroChoice,
  QuickAddTemplateChoice,
  QuickAddCaptureChoice,
  QuickAddMultiChoice,
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

/** The union every compiled choice shape belongs to — named here once so
 *  `flattenAll`/`pruneCyclic`/`transformChoices` don't each re-spell it. */
type QuickAddChoice = QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice;

/** Recovers the original note path from a compiler-owned choice id — the
 *  exact reverse of `deriveChoiceId`. Always exact (not a search — undoing a
 *  known prefix+suffix concatenation), regardless of what characters appear
 *  in the note path itself. Used for cycle-error messages so they name the
 *  note a human edits, not the compiler-owned id. */
function notePathOfChoiceId(id: string): string {
  return id.slice(ID_PREFIX.length, id.length - "#choice".length);
}

/** Recursively walks a compiled choice tree (a Multi's own `choices` array,
 *  arbitrarily deep) into one flat list. Cycle detection must see this full
 *  set, not just the top level: a Macro choice nested inside a Multi is
 *  exactly as capable of participating in a choice-step reference cycle as
 *  a top-level one — resolveChoiceStep's target validation never
 *  distinguishes nested from top-level, only "does this compiler produce a
 *  choice for that note." */
function flattenAll(choices: QuickAddChoice[]): QuickAddChoice[] {
  const out: QuickAddChoice[] = [];
  for (const c of choices) {
    out.push(c);
    if (c.type === "Multi") out.push(...flattenAll(c.choices));
  }
  return out;
}

/** Recursively rebuilds a compiled choice tree with every id in `cyclic`
 *  removed, wherever it lives — the top-level array, or nested inside any
 *  Multi's own `choices` array at any depth. A Multi that loses a cyclic
 *  MEMBER simply has a smaller `choices` array; the Multi itself is only
 *  removed if the Multi's OWN id is in `cyclic` (which cannot happen today,
 *  since Multi choices carry no `macro.commands` and so can never be a node
 *  in detectChoiceCycles' graph — this function stays correct regardless,
 *  rather than assuming that invariant). */
function pruneCyclic(choices: QuickAddChoice[], cyclic: Set<string>): QuickAddChoice[] {
  const out: QuickAddChoice[] = [];
  for (const c of choices) {
    if (cyclic.has(c.id)) continue;
    out.push(c.type === "Multi" ? { ...c, choices: pruneCyclic(c.choices, cyclic) } : c);
  }
  return out;
}

export function transformChoices(inputs: ChoiceNoteInput[]): TransformResult {
  const compiled: QuickAddChoice[] = [];
  const errors: ChoiceError[] = [];

  for (const input of inputs) {
    const result = transformOne(input);
    if (result.ok) {
      compiled.push(result.choice);
      errors.push(...result.nestedErrors);
    } else {
      errors.push({ notePath: input.notePath, message: result.message });
    }
  }

  // Multi-note reference cycles (A → B → A, and longer). QuickAdd's
  // executeChoice has NO cycle detection — no visited set, no depth cap — so
  // running any choice in a cycle loops forever in Obsidian. The glue layer
  // already rejects the DIRECT case (a choice step pointing at its own note)
  // with a more specific message, but it can only see one step of one note
  // at a time; a cycle spanning two or more notes is only visible over the
  // whole compiled set — and as of Stage D that set includes choices NESTED
  // inside a Multi, not just top-level ones, since nesting has no bearing
  // on whether a Macro's choice: step can form a cycle.
  const allCompiled = flattenAll(compiled);
  const byId = new Map(allCompiled.map((c) => [c.id, c]));
  const macroChoices = allCompiled.filter((c): c is QuickAddMacroChoice => c.type === "Macro");
  const cycles = detectChoiceCycles(macroChoices);
  const cyclic = new Set<string>();
  for (const cycle of cycles) {
    const paths = cycle.map((id) => notePathOfChoiceId(id));
    for (const id of cycle) {
      cyclic.add(id);
      const choice = byId.get(id);
      if (!choice) continue;
      errors.push({
        notePath: notePathOfChoiceId(id),
        message:
          `Macro "${choice.name}" (${notePathOfChoiceId(id)}) is part of a choice-step reference cycle involving: ` +
          `${paths.join(", ")}. QuickAdd has no cycle guard, so running any choice in the cycle would loop ` +
          "forever at run time — every note in the cycle is dropped from this compile. Break the cycle by " +
          "removing one of the choice steps.",
      });
    }
  }

  const choices = cyclic.size === 0 ? compiled : pruneCyclic(compiled, cyclic);

  return { choices, errors };
}

/** Every group of compiled choices that reference each other in a cycle,
 *  as arrays of choice ids (sorted, so a report is a function of the input
 *  rather than of DFS entry order).
 *
 *  Pure data in, pure data out: it walks only the compiled `Choice` commands'
 *  `choiceId` edges, and only among choices that actually compiled — an
 *  already-failed note is absent from the output, so it cannot be part of a
 *  live cycle. An edge pointing outside the compiled set (a dangling
 *  reference, which is allowed — see types.ts's ChoiceStepOk) is simply not
 *  an edge here.
 *
 *  Implemented as Tarjan's strongly-connected-components: every SCC with more
 *  than one member is a cycle, and a single-member SCC is one iff it has a
 *  self-edge. This names EVERY note in a cycle, including overlapping cycles
 *  that share nodes, which a single back-edge report would miss. */
export function detectChoiceCycles(choices: QuickAddMacroChoice[]): string[][] {
  const ids = new Set(choices.map((c) => c.id));
  const edges = new Map<string, string[]>();
  for (const choice of choices) {
    const out: string[] = [];
    for (const command of choice.macro.commands) {
      if (command.type !== "Choice") continue;
      if (!ids.has(command.choiceId)) continue; // dangling reference: not an edge
      if (!out.includes(command.choiceId)) out.push(command.choiceId);
    }
    edges.set(choice.id, out);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  // Iterative Tarjan — the recursion depth would otherwise be the number of
  // choice notes, which is unbounded by anything this compiler controls.
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; edge: number }> = [{ node: root, edge: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const out = edges.get(frame.node) ?? [];
      if (frame.edge < out.length) {
        const next = out[frame.edge];
        frame.edge++;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        const selfEdge = component.length === 1 && (edges.get(component[0]) ?? []).includes(component[0]);
        if (component.length > 1 || selfEdge) cycles.push(component.sort());
      }
    }
  }

  return cycles;
}

type OneResult =
  | { ok: true; choice: QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice; nestedErrors: ChoiceError[] }
  | { ok: false; message: string };

function transformOne(input: ChoiceNoteInput): OneResult {
  switch (input.quickaddType) {
    case "macro":
      return transformMacro(input);
    case "template":
      return transformTemplate(input);
    case "capture":
      return transformCapture(input);
    case "multi":
      return transformMulti(input);
  }
}

function transformMulti(input: MultiChoiceNoteInput): OneResult {
  if (!input.folder.ok) {
    return { ok: false, message: `Multi "${input.name}" (${input.notePath}): ${input.folder.error}` };
  }
  const memberChoices: Array<QuickAddMacroChoice | QuickAddTemplateChoice | QuickAddCaptureChoice | QuickAddMultiChoice> = [];
  const nestedErrors: ChoiceError[] = [];
  for (const member of input.folder.members) {
    const r = transformOne(member);
    if (r.ok) {
      memberChoices.push(r.choice);
      nestedErrors.push(...r.nestedErrors);
    } else {
      nestedErrors.push({ notePath: member.notePath, message: r.message });
    }
  }
  return {
    ok: true,
    nestedErrors,
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Multi",
      command: false,
      choices: memberChoices,
      collapsed: false,
    },
  };
}

function transformTemplate(input: TemplateChoiceNoteInput): OneResult {
  if (!input.template.ok) {
    return { ok: false, message: `Template "${input.name}" (${input.notePath}): ${input.template.error}` };
  }
  return {
    ok: true,
    nestedErrors: [],
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Template",
      command: true,
      templatePath: input.template.templatePath,
      fileNameFormat: input.fileNameFormat !== undefined
        ? { enabled: true, format: input.fileNameFormat }
        : { enabled: false, format: "" },
      discoverExistingNotesBeforeCreate: false,
      folder: input.folder !== undefined
        ? { enabled: true, folders: [input.folder], chooseWhenCreatingNote: false, createInSameFolderAsActiveFile: false, chooseFromSubfolders: false }
        : { enabled: false, folders: [], chooseWhenCreatingNote: false, createInSameFolderAsActiveFile: false, chooseFromSubfolders: false },
      appendLink: false,
      copyLinkToClipboard: false,
      openFile: input.openFile,
      fileOpening: { location: "tab", direction: "vertical", mode: "default", focus: true },
      fileExistsBehavior: { kind: "prompt" },
    },
  };
}

function transformCapture(input: CaptureChoiceNoteInput): OneResult {
  if (!input.target.ok) {
    return { ok: false, message: `Capture "${input.name}" (${input.notePath}): ${input.target.error}` };
  }
  return {
    ok: true,
    nestedErrors: [],
    choice: {
      id: deriveChoiceId(input.notePath),
      name: input.name,
      type: "Capture",
      command: true,
      appendLink: false,
      copyLinkToClipboard: false,
      captureTo: input.target.captureTo,
      captureToActiveFile: false,
      captureToCanvasNodeId: "",
      activeFileWritePosition: "cursor",
      createFileIfItDoesntExist: { enabled: input.createIfMissing, createWithTemplate: false, template: "" },
      format: { enabled: false, format: "" },
      insertAfter: input.insertAfterHeading !== undefined
        ? { enabled: true, after: input.insertAfterHeading, insertAtEnd: false, considerSubsections: false, createIfNotFound: false, createIfNotFoundLocation: "top", inline: false, replaceExisting: false, blankLineAfterMatchMode: "auto", promptHeading: false }
        : { enabled: false, after: "", insertAtEnd: false, considerSubsections: false, createIfNotFound: false, createIfNotFoundLocation: "top", inline: false, replaceExisting: false, blankLineAfterMatchMode: "auto", promptHeading: false },
      insertBefore: { enabled: false, before: "", createIfNotFound: false, createIfNotFoundLocation: "top" },
      newLineCapture: { enabled: false, direction: "below" },
      prepend: input.prepend,
      task: input.task,
      openFile: false,
      fileOpening: { location: "tab", direction: "vertical", mode: "default", focus: true },
      templater: { afterCapture: "none" },
    },
  };
}

function transformMacro(input: MacroChoiceNoteInput): OneResult {
  if (input.steps.length === 0) {
    return { ok: false, message: `Macro "${input.name}" (${input.notePath}) has no steps.` };
  }

  // Derived from the macro shape itself rather than re-spelled: a new command
  // type added to QuickAddMacro["commands"] must not need a second edit here.
  type Command = QuickAddMacro["commands"][number];
  const commands: Command[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    const id = deriveStepId(input.notePath, i);

    if (step.kind === "unsupported") {
      return {
        ok: false,
        message:
          `Macro "${input.name}" (${input.notePath}) step ${i + 1} has unsupported step kind ` +
          `"${step.declaredKind}" (only "userscript", "choice", "wait", "obsidian-command", "editor-command" are implemented).`,
      };
    }

    if (!step.ok) {
      return {
        ok: false,
        message: `Macro "${input.name}" (${input.notePath}) step ${i + 1}: ${step.error}`,
      };
    }

    switch (step.kind) {
      case "userscript":
        commands.push({ id, name: step.scriptPath, type: "UserScript", path: step.scriptPath, settings: step.settings });
        break;
      case "choice":
        // `name` is the TARGET choice's own display name, matching native
        // QuickAdd — a generic "Choice" label would make QuickAdd's own
        // dangling-reference message ("choice '…' could not be found.")
        // name nothing at run time.
        commands.push({ id, name: step.displayName, type: "Choice", choiceId: step.choiceId });
        break;
      case "wait":
        commands.push({ id, name: "Wait", type: "Wait", time: step.timeMs });
        break;
      case "obsidian-command":
        commands.push({ id, name: step.displayName, type: "Obsidian", commandId: step.commandId });
        break;
      case "editor-command":
        commands.push({ id, name: step.editorCommandType, type: "EditorCommand", editorCommandType: step.editorCommandType });
        break;
      default: {
        // Exhaustiveness. nested-choice and ai-assistant are deferred, not
        // forgotten: adding either to MacroStepResolved without a case here
        // would otherwise DROP the step silently from the compiled macro.
        // Same idiom as kernel/scheme/jd.ts.
        const _exhaustive: never = step;
        throw new Error(`unreachable MacroStepResolved kind: ${String((_exhaustive as { kind?: unknown }).kind)}`);
      }
    }
  }

  return {
    ok: true,
    nestedErrors: [],
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
