// The FIRST NATIVE ACTION — Gate 0, WP2's vertical slice.
//
// Every other action in this repository is a compatibility contract: derived
// from an existing registration, claiming only what the adapter could observe
// from the outside, and forbidden from asserting replayability. That is the
// right posture for 123 surfaces nobody has re-examined — and it means none of
// them can be captured, because a derived contract that claimed its reads were
// worth keeping would be exactly the overclaim the adapter exists to prevent.
//
// So the substrate cannot be exercised at all until one action is AUTHORED.
// This is that action, and `obsidian_read_note` is the right one to start with:
// it is the most-used read in the product, it returns substantive vault content
// rather than plumbing, and its postcondition is small enough to state exactly.
//
// The migration metric moves here too. Everything else is `compat.*`; this is
// `note.read`. The count of dotted ids going up is the work getting done.

import type { ActionDefinition } from "../action.js";

export const NOTE_READ_V1: ActionDefinition = {
  id: "note.read",
  version: 1,
  title: "Read a note",
  postcondition: "Return the exact current bytes of one visible Markdown note, with the revision token a following write may use as its precondition.",
  owner: "core",
  distribution: "public-default",
  modes: ["read"],
  changeClasses: [],
  observations: {
    // The reason this action exists. A note body is substantive vault content —
    // the material an agent actually reasons over — so a reviewer asking "what
    // was it shown?" needs the bytes, not a digest and a shape.
    defaultCapture: "replayable",
    supportsProposal: true,
  },
  effects: { direct: [], discovered: "none" },
  authority: { governorOnly: false, automaticAdmission: "never" },
  scope: {
    argumentKeys: ["path"],
    resolvesAddresses: true,
    enumeration: "not-applicable",
    whenScoped: "available",
  },
  // The OPERATION record stays ephemeral even though the observation is
  // replayable. They are separate decisions: journaling every read would turn
  // ordinary browsing into a permanent transcript, while capturing the payload
  // is what a governed session needs. D16 keeps them independent precisely so
  // one does not drag the other along.
  retention: { operation: "ephemeral" },
  inputs: ["path"],
  native: true,
};
