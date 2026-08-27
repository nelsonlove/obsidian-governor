// PREDICATE REGISTRY — which predicates exist, and which a subject REQUIRES (WP6).
//
// Two questions, deliberately separated: "what predicates are registered"
// (exact {id, version} lookup, duplicates refused) and "what does THIS
// subject require" — which is decided by the SUBJECT's own predicate list
// plus the class-minimum floor, never by the caller's mood. A subject that
// names p@1 requires exactly p@1; admission with p@2's verdict is a
// different claim about a different check.

import type { PredicateV1 } from "./predicate.js";
import type { ChangeClass } from "../contracts/change-class.js";
import type { ProposalItemSubjectV1 } from "../contracts/subject-v1.js";

export class PredicateRegistryError extends Error {
  readonly code = "predicate_registry_invalid";
  constructor(detail: string) {
    super(detail);
    this.name = "PredicateRegistryError";
  }
}

export interface PredicateRegistry {
  register(predicate: PredicateV1): void;
  get(id: string, version: string): PredicateV1 | null;
  /**
   * The exact predicate set a subject requires: every {id, version} the
   * subject names. Throws when a required predicate is not registered —
   * "we cannot run the check" must never quietly become "the check passed".
   */
  requiredFor(subject: ProposalItemSubjectV1): PredicateV1[];
  /** Registered predicates applicable to a class, for building subjects. */
  applicableTo(cls: ChangeClass): PredicateV1[];
}

export function createPredicateRegistry(): PredicateRegistry {
  const byKey = new Map<string, PredicateV1>();
  const key = (id: string, version: string) => `${id}@${version}`;

  return {
    register(predicate) {
      const k = key(predicate.id, predicate.version);
      if (byKey.has(k)) throw new PredicateRegistryError(`predicate ${k} is already registered; versions are immutable`);
      if (predicate.appliesTo.length === 0) throw new PredicateRegistryError(`predicate ${k} applies to no class; register it when it proves something`);
      byKey.set(k, predicate);
    },
    get(id, version) {
      return byKey.get(key(id, version)) ?? null;
    },
    requiredFor(subject) {
      return subject.predicates.map((p) => {
        const found = byKey.get(key(p.id, p.version));
        if (!found) {
          throw new PredicateRegistryError(
            `subject requires predicate ${key(p.id, p.version)}, which is not registered — a check that cannot run has not passed`
          );
        }
        return found;
      });
    },
    applicableTo(cls) {
      return [...byKey.values()].filter((p) => p.appliesTo.includes(cls));
    },
  };
}
