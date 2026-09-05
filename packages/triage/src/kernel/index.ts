// kernel — the INBOX TRIAGE instance of the disposition substrate (#221,
// #241 phase-3 shape: three built-in primitives + human-declared rows).
//
// The SUBSTRATE both instances declare against (`DispositionDescriptorShape`,
// `DispositionAuthority` and the three pure helpers) lives in
// `@vault-mcp/core`, published there at the suite split's S3 condition 9 for
// exactly this moment: the acceptance instance stays in the host's governance
// provider, this instance left with the satellite, and neither depends on the
// other. While triage was a host module a local `kernel/triage/dispositions.ts`
// re-export shim kept the old import paths working; the shim went away WITH the
// module (S5) — there is nothing left in the host to re-export to, and the
// substrate is imported from core directly below.
//
// Everything else here is the triage instance itself: the built-in descriptors
// and the merged table, config, the queue predicate, and the planner.

export {
  dispositionsForSurface,
  dispositionByIdIn,
  gestureGatedIn,
  type DispositionAuthority,
  type DispositionDescriptorShape,
} from "@vault-mcp/core";

export {
  TRIAGE_DISPOSITIONS,
  TRIAGE_BUILTIN_IDS,
  defaultEscalateRow,
  mergedDispositionsOf,
  mergedById,
  mergedIds,
  mergedLines,
  targetPolicyOf,
  type DeclaredDispositionRow,
  type MergedDisposition,
  type MergeInputs,
  type TriageAction,
  type TriageBuiltinId,
  type TriageDispositionDescriptor,
  type TriageDispositionSurface,
  type TriageTargetPolicy,
} from "./descriptors.js";

export {
  DEFAULT_TRIAGE_CONFIG,
  builtinDescriptionsOf,
  declaredRowsOf,
  destinationProblem,
  parseFrontmatterPatch,
  patchObjectProblem,
  prefixListOf,
  queuesOf,
  triageConfigOf,
  validateTriageConfig,
  type TriageConfig,
  type TriageQueueDecl,
} from "./config.js";

export { inboxFolderOf, sortQueue, type QueueRow } from "./inbox.js";

export {
  applyFrontmatterPatch,
  moveDenied,
  planDispose,
  type DisposeInput,
  type DisposePlan,
  type DisposeRefusal,
} from "./plan.js";
