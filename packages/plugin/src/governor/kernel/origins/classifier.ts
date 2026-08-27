// ORIGIN CLASSIFIER — from runtime signals to one of the four origins (WP5, D12).
//
// This EXTENDS the existing human-vs-agent classifier (governor/kernel/
// classify.ts) rather than replacing it. That module's behavior is adopted by
// name in D12 — "editor-buffer change observed while the local user is
// actively editing" is exactly its positive trusted-input signal, and its
// fail-safe (ambiguous never silently advances) is the ruling's own rule. What
// WP5 adds is the RECORD: every classification now lands as an OriginRecord
// carrying the fixed confidence D12 assigns, so a journal reader can tell
// "bound to a governed operation" from "observed" from "nothing attributable"
// without re-deriving it.
//
// Priority order is evidence strength, and it only ever falls DOWNWARD:
// a journal-matched governor write outranks a trusted keystroke in the same
// window (the write is bound; the keystroke may be the human reacting to it),
// and sync attribution is claimed only on actual reconciliation evidence —
// which no producer emits until WP12, so today the classifier can literally
// never output sync-attributed. That is honest: claiming sync attribution
// without portable evidence is exactly what D12 forbids.

import { classifyModify, shouldAdvanceBaselineSilently, type ModifyClass } from "../classify.js";
import { originRecord, type OriginRecord } from "../contracts/origin.js";

export interface OriginSignals {
  /** The journal shows a governor (MCP) write to this path in the window. */
  recentAgentWrite: boolean;
  /** A genuine (isTrusted) human input event landed on this path in the window. */
  recentGenuineHumanInput: boolean;
  /**
   * Replica reconciliation attributes this change to a peer's portable
   * evidence. NO producer emits this until WP12 — it exists so the contract
   * is complete, and it must never be synthesized from "the file changed
   * while Obsidian was closed", which is indistinguishable from any external
   * writer.
   */
  syncEvidence: boolean;
}

/** Classify a change's origin. Total; falls through to the honest floor. */
export function classifyOrigin(signals: OriginSignals): OriginRecord {
  if (signals.recentAgentWrite) return originRecord("governor-originated");
  if (signals.recentGenuineHumanInput) return originRecord("local-human-observed");
  if (signals.syncEvidence) return originRecord("sync-attributed");
  return originRecord("external-unattributed");
}

/**
 * The bridge to the existing modify classifier: same signals, both outputs.
 * `modifyClass` keeps driving the baseline-advance decision exactly as
 * before; `origin` is the new durable record. One evaluation of the
 * evidence, two consumers — they can never disagree about what was seen.
 */
export function classifyChange(signals: OriginSignals): { modifyClass: ModifyClass; origin: OriginRecord } {
  const modifyClass = classifyModify({
    recentAgentWrite: signals.recentAgentWrite,
    recentGenuineHumanInput: signals.recentGenuineHumanInput,
  });
  return { modifyClass, origin: classifyOrigin(signals) };
}

export { shouldAdvanceBaselineSilently };
