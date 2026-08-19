// kernel/triage — the disposition substrate (#221) and its second instance,
// INBOX TRIAGE (#241 phase 3 shape: three built-in primitives + human-declared
// rows). `dispositions.ts` is the substrate both instances declare against
// (the acceptance instance lives in kernel/governance); the rest is the
// triage instance itself: built-in descriptors + the merged table, config,
// queue predicate, planner.

export {
  dispositionsForSurface,
  dispositionByIdIn,
  gestureGatedIn,
  type DispositionAuthority,
  type DispositionDescriptorShape,
} from "./dispositions.js";

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
