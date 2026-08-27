// THE DISPOSITION SUBSTRATE — re-export shim (#221 phase 2; published to
// @vault-mcp/core at the suite split's S3, condition 9).
//
// The generic descriptor shape (`DispositionDescriptorShape`,
// `DispositionAuthority`) and its three pure helpers moved bodily to
// `packages/core/src/dispositions.ts` — see that file's header for the full
// rationale. This module stays as a re-export so the existing local imports
// (`kernel/triage/index.ts`, `kernel/triage/descriptors.ts`, and the
// governance provider's own `governor/kernel/dispositions.ts` before it was
// repointed) keep working unchanged. Nothing triage-specific lives here —
// that content (the built-in primitive table, the merged-table logic,
// config, queue predicate, planner) is the rest of `kernel/triage/`.
export {
  type DispositionAuthority,
  type DispositionDescriptorShape,
  dispositionsForSurface,
  dispositionByIdIn,
  gestureGatedIn,
} from "@vault-mcp/core";
