// THE FIRST REAL PREDICATES — deterministic, versioned, registered (WP6b-1).
//
// `content-diff@1` proves ONE thing: the subject describes the actual bytes.
// It recomputes the base and proposed digests from the evidence bytes and
// compares them to what the subject claims — so a subject drifted from
// reality (edited manifest, stale digest, wrong note) fails verification with
// a specific mismatch, and admission's fresh run (the service verifies at
// click time) makes this the "verification covers the exact subject"
// condition with teeth. It does NOT prove the content is good — change-classes
// is explicit that content class requires human or qualified substantive
// review, which is exactly what the Accept gesture is.

import { digestBytes } from "@vault-mcp/core";
import type { PredicateV1 } from "./predicate.js";
import { createPredicateRegistry, type PredicateRegistry } from "./registry.js";

export const CONTENT_DIFF_V1: PredicateV1 = {
  id: "content-diff",
  version: "1",
  appliesTo: ["content"],
  proves: "the subject's base and proposed digests describe the actual evidence bytes",
  async evaluate(subject, evidence) {
    if (evidence.proposedBytes == null) {
      return { passed: false, detail: "no proposed bytes to check the subject against" };
    }
    const proposed = digestBytes(evidence.proposedBytes);
    if (proposed.value !== subject.proposed.value) {
      return {
        passed: false,
        detail: `proposed bytes digest to ${proposed.value.slice(0, 12)}… but the subject claims ${subject.proposed.value.slice(0, 12)}…`,
      };
    }
    if (subject.base === null) {
      if (evidence.baseBytes != null) {
        return { passed: false, detail: "the subject claims a creation (base null) but base bytes exist" };
      }
      return { passed: true, detail: "creation: proposed digest matches the actual bytes; no base to compare" };
    }
    if (evidence.baseBytes == null) {
      return { passed: false, detail: "the subject claims a base but no base bytes were provided" };
    }
    const base = digestBytes(evidence.baseBytes);
    if (base.value !== subject.base.value) {
      return {
        passed: false,
        detail: `base bytes digest to ${base.value.slice(0, 12)}… but the subject claims ${subject.base.value.slice(0, 12)}…`,
      };
    }
    return { passed: true, detail: "base and proposed digests both match the actual bytes" };
  },
};

/** The registry production wiring uses: every shipped predicate, registered once. */
export function createDefaultPredicateRegistry(): PredicateRegistry {
  const registry = createPredicateRegistry();
  registry.register(CONTENT_DIFF_V1);
  return registry;
}
