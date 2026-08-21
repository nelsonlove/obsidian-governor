// THE FIRST NATIVE MUTATION — WP6b-1's half of the vertical slice.
//
// `note.read` proved the observation substrate; this proves the PROPOSAL
// substrate: a write whose result is recorded as a canonical subject a human
// can later admit. The postcondition is deliberately narrow — replace the
// entire content of one note at a fixed path — because a narrow contract is
// what makes the class assertion checkable: an action that can only change
// bytes at a fixed path cannot silently acquire a structural class (a move is
// a DIFFERENT action), and the class firewall proves the content claim
// against the actual diff rather than carrying it.

import type { ActionDefinition } from "../action.js";

export const NOTE_WRITE_V1: ActionDefinition = {
  id: "note.write",
  version: 1,
  title: "Write a note",
  postcondition:
    "Replace the entire content of one visible Markdown note at a fixed path (creating it if absent), leaving every other note untouched.",
  owner: "core",
  distribution: "public-default",
  modes: ["proposal-mutation"],
  // Asserted content; PROVEN content by the class firewall at proposal build
  // time (classification rule 5: evaluated from the diff, never solely from
  // the declaration). Path changes are outside this contract by construction.
  changeClasses: ["content"],
  observations: {
    // The write's RESULT envelope is plumbing — path and created flag — and
    // an ephemeral observation supports nothing (the registry refuses the
    // combination, and refused exactly this contract's first draft). The
    // action PRODUCES proposals through its `proposal-mutation` mode; the
    // proposal's evidence is its own base/proposed digests, not an
    // observation of the result envelope. D16 keeps those records separate.
    defaultCapture: "ephemeral",
    supportsProposal: false,
  },
  effects: { direct: ["note-content"], discovered: "none" },
  authority: { governorOnly: false, automaticAdmission: "never" },
  scope: {
    argumentKeys: ["path"],
    resolvesAddresses: true,
    enumeration: "not-applicable",
    whenScoped: "available",
  },
  // Every mutation is journaled by the kernel; the operation record is
  // durable for exactly that reason.
  retention: { operation: "durable-for-mutation" },
  inputs: ["path", "content", "overwrite"],
  native: true,
};
