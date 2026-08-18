// kernel/triage — the disposition substrate (#221) and its second instance,
// INBOX TRIAGE. `dispositions.ts` is the substrate both instances declare
// against (the acceptance instance lives in kernel/governance); the rest is
// the triage instance itself: descriptors, config, queue predicate, planner.

export {
  dispositionsForSurface,
  dispositionByIdIn,
  gestureGatedIn,
  type DispositionAuthority,
  type DispositionDescriptorShape,
} from "./dispositions.js";

export {
  TRIAGE_DISPOSITIONS,
  triageDispositionById,
  triageDispositionIds,
  triageDispositionLines,
  type TriageAction,
  type TriageDestinationKey,
  type TriageDispositionDescriptor,
  type TriageDispositionId,
  type TriageFrontmatterKey,
  type TriageTargetPolicy,
} from "./descriptors.js";

export {
  DEFAULT_TRIAGE_CONFIG,
  DESTINATION_KEYS,
  FRONTMATTER_KEYS,
  destinationProblem,
  parseFrontmatterPatch,
  triageConfigOf,
  validateTriageConfig,
  type TriageConfig,
} from "./config.js";

export { inboxFolderOf, sortQueue, type QueueRow } from "./inbox.js";

export {
  applyFrontmatterPatch,
  planDispose,
  type DisposeInput,
  type DisposePlan,
  type DisposeRefusal,
} from "./plan.js";
