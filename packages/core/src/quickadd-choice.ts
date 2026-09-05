// quickadd-choice.ts — the ONE executeChoice-with-variables seam (#225),
// shared by the two surfaces that drive a QuickAdd choice headlessly:
//
//   - `obsidian_run_command` (the host plugin's tools-complementary.ts): the
//     AGENT-NAMED path — the caller supplies a `quickadd:*` command id, which
//     the cli-policy opaque-execution deny refuses by default (a human
//     re-enables specific ids via `allowOpaque`);
//   - the triage satellite's declared `choice` dispositions
//     (packages/triage/src/obsidian-source.ts): the HUMAN-BOUND path — the
//     agent-facing surface is the disposition id only, and the choice binding
//     lives in human-only-mutable plugin config, so the binding itself IS the
//     human re-enable. Neither path weakens the other: this helper contains NO
//     policy decision — each caller applies (or embodies) its own gate BEFORE
//     reaching here, and nothing below consults or bypasses cli-policy.
//
// It lives in `@vault-mcp/core` since the suite split's S5, when triage became
// its own plugin and those two surfaces stopped sharing a build. Publishing it
// is the whole point: this file was written as an EXTRACTION rather than a
// duplication, and letting the satellite carry a copy would have reinstated
// exactly the drift it exists to prevent. It takes `app` duck-typed and imports
// nothing from `obsidian`, so it sits here with no new dependency.
//
// The properties that must not drift: quickadd presence is
// probed on the LOADED instance, a command id is stripped to its raw choice
// id and resolved via getChoiceById (executeChoice takes the choice's NAME,
// not its id), `_invoked-by` defaults to "agent" (the vault's dual-mode
// scripts fail fast on it instead of opening a modal nobody will answer), and
// QuickAdd's executeChoice returns only success/failure — never the script's
// return value (callers re-read whatever the script changed).

/** The duck-typed QuickAdd surface this seam consumes (app.plugins is not in
 * the public obsidian types). */
interface QuickAddLike {
  api?: { executeChoice?: (name: string, variables: Record<string, string>) => Promise<unknown> };
  getChoiceById?: (id: string) => { name: string };
}

export type ChoiceOutcome =
  | { ok: true; choice: string; variables: Record<string, string> }
  | { ok: false; code: "quickadd_unavailable" | "choice_not_found"; message: string };

function quickAddOf(app: unknown): QuickAddLike | null {
  const qa = (app as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.quickadd as
    | QuickAddLike
    | undefined;
  return qa && typeof qa.api?.executeChoice === "function" ? qa : null;
}

/**
 * Resolve and execute one QuickAdd choice with variables.
 *
 * `ref` forms:
 *   - `{ commandId }` — a `quickadd:*` / `quickadd:choice:<uuid>` command id
 *     (the run_command spelling): the id is stripped and MUST resolve via
 *     getChoiceById, else `choice_not_found` (a non-choice quickadd id —
 *     e.g. "quickadd:reloadQuickAdd" — correctly fails there too:
 *     executeChoice can't run it either).
 *   - `{ binding }` — a triage config binding: a choice ID when getChoiceById
 *     resolves it, else taken verbatim as the choice NAME (executeChoice's
 *     own key; an unknown name surfaces as the script-side throw below).
 *
 * Availability and resolution failures return TYPED refusals; a throw from
 * the choice's own script (or an unknown choice name) propagates to the
 * caller as an ordinary failure.
 */
export async function executeQuickAddChoice(
  app: unknown,
  ref: { commandId: string } | { binding: string },
  variables: Record<string, string> | undefined,
): Promise<ChoiceOutcome> {
  const quickadd = quickAddOf(app);
  if (!quickadd) {
    return {
      ok: false,
      code: "quickadd_unavailable",
      message: "QuickAdd is not installed, not enabled, or its API is unavailable.",
    };
  }
  let choiceName: string;
  if ("commandId" in ref) {
    // Obsidian namespaces every registered command id with the owning
    // plugin's id, so a QuickAdd choice's real command_id is
    // "quickadd:choice:<uuid>" — strip to the raw id and resolve to a name.
    const rawId = ref.commandId.startsWith("quickadd:choice:")
      ? ref.commandId.slice("quickadd:choice:".length)
      : ref.commandId.slice("quickadd:".length);
    try {
      choiceName = quickadd.getChoiceById!(rawId).name;
    } catch {
      return { ok: false, code: "choice_not_found", message: `No QuickAdd choice with id "${rawId}".` };
    }
  } else {
    // A config binding: prefer the stable id lookup; an unresolvable id is
    // taken verbatim as the choice name.
    try {
      choiceName = quickadd.getChoiceById!(ref.binding).name;
    } catch {
      choiceName = ref.binding;
    }
  }
  const withDefaultActor = { "_invoked-by": "agent", ...(variables ?? {}) };
  await quickadd.api!.executeChoice!(choiceName, withDefaultActor);
  return { ok: true, choice: choiceName, variables: withDefaultActor };
}
