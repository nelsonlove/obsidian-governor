// Human-vs-agent edit classifier for the vault `modify` listener.
//
// WHY: agent (MCP) writes AND human editor edits both fire vault.on('modify'). We must
// tell them apart, because the design rule is asymmetric:
//   - human-attributed changes advance the baseline SILENTLY (Assent ch.5: "your own edits
//     must never queue for your own review, or the queue drowns and dies"), whereas
//   - agent changes must be LEFT for the journal-driven queue to surface.
//
// HEURISTIC (two signals, in priority order):
//   1. `recentAgentWrite` — the journal shows an MCP content-write to this path within a
//      short window around now. Strong positive evidence of an agent → classify "agent".
//   2. `recentGenuineHumanInput` — a REAL human input event (DOM beforeinput/paste, i.e.
//      `isTrusted` keystroke/paste into the editor) landed on THIS path within a short window
//      before the modify. This is POSITIVE evidence a human typed the change. Only genuine
//      browser input events count — programmatic `vault.process`/`vault.modify` writes (how
//      agents mutate notes) fire NO DOM input event, so an MCP write never produces this
//      signal. → classify "human".
//   3. Otherwise → "ambiguous": we cannot confidently attribute it. FAIL SAFE — no silent
//      advance; the change stays queued for review.
//
// WHY NOT "active editor = human" (the residual this replaces): the modified file merely
// BEING the focused editor is not evidence a human authored the change. A non-journaled or
// externally-scripted write to the open file — or an agent write whose journal flush is
// delayed past the window — would be misread as "human" and SILENTLY baseline-advanced,
// escaping review entirely. The absence of an agent journal record is NOT evidence of a
// human. So we now require POSITIVE human-input evidence before ever advancing silently.
//
// ACTION MAPPING: only "human" advances the baseline silently. "agent" and "ambiguous" both
// LEAVE the baseline untouched — erring toward review (safe) rather than silent acceptance.
// An "agent"/"ambiguous" note that has a journal entry then surfaces in the queue; one
// without a journal entry simply lingers as an un-surfaced diff (never auto-accepted).
//
// Ported verbatim from obsidian-stewardship/src/classify.ts (#83, cycle 1). Pure logic —
// no vault, no accept surface; the silent-advance ACTION lives in cycle 2's accept path.

export type ModifyClass = "human" | "agent" | "ambiguous";

export interface ClassifyInput {
  recentAgentWrite: boolean;
  // Positive evidence of a genuine (isTrusted) human input event on THIS path within the
  // recent window. Replaces the old `isActiveMarkdownEditor` heuristic — mere focus is not
  // evidence of authorship; a real keystroke/paste is.
  recentGenuineHumanInput: boolean;
}

export function classifyModify(input: ClassifyInput): ModifyClass {
  if (input.recentAgentWrite) return "agent";
  if (input.recentGenuineHumanInput) return "human";
  return "ambiguous";
}

// Only a confident human classification advances the baseline silently.
export function shouldAdvanceBaselineSilently(cls: ModifyClass): boolean {
  return cls === "human";
}
