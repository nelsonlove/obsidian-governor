// NAMED TRANSFORMATIONS — the registry automatic admission is defined over
// (WP10; D02, D14).
//
// "Exact named transformations for eligible encoding, presentation,
// representation, and structural work" — a transformation is a NAME with a
// version, a class footprint, a separately versioned deterministic verifier
// set, and a recovery unit. Nothing here executes anything: the registry is
// the vocabulary that mandates, cohorts, and (after promotion) automatic
// admission speak. An unregistered transformation cannot be promoted,
// cannot be verified as itself, and cannot ride a mandate into automatic
// admission — exactly the "renaming a tool does not widen authority" rule,
// applied to work instead of tools.
//
// THE CLASS LINE IS STRUCTURAL: content and authority transformations are
// REFUSED AT REGISTRATION. D02's "no automatic content or authority
// admission" is not a policy check downstream — the registry cannot hold an
// entry that could ever authorize one. (The legacy auto-accept registry's
// migration rule applies here too: no entry receives authority merely
// because it was previously allowlisted; each arrives by its own review.)
//
// Verifiers are PREDICATES (verification/predicate.ts), separately
// versioned from the transformation and registered in the predicate
// registry BEFORE the transformation may name them — "a check that cannot
// run has not passed" (registry.ts), lifted to registration time: a
// transformation whose verifier is not registered is refused, never parked.

import type { ChangeClass } from "../contracts/change-class.js";
import type { PredicateRegistry } from "../verification/registry.js";
import { verifierKeyOf, type PromotionTuple } from "./promotion.js";

/** The classes D02 permits automatic admission for. Content and authority are deliberately absent and can never be added by data. */
export const AUTOMATABLE_CLASSES: ReadonlyArray<ChangeClass> = Object.freeze(["encoding", "presentation", "representation", "structural"]);

export interface TransformationV1 {
  schema: "governor.transformation/v1";
  /** Exact name — the id a mandate's terms and a proposal subject carry. */
  id: string;
  version: string;
  /** Human-facing one-liner for the pane. */
  title: string;
  /** The classes this transformation's results may carry. Subset of AUTOMATABLE_CLASSES, enforced at registration. */
  appliesTo: ChangeClass[];
  /** The separately versioned deterministic verifier set — every entry must already be registered predicates. */
  verifier: { predicates: Array<{ id: string; version: string }> };
  /** The recovery unit any admission under this transformation must record. */
  recovery: { unit: "item" | "cohort" };
}

/**
 * The promotion tuple a registered transformation's evidence accrues to —
 * built ONLY from the registered declaration (never from a subject's own
 * predicate list), so evidence cannot be steered onto a tuple the review
 * never saw.
 */
export function tupleOf(t: TransformationV1): PromotionTuple {
  return {
    transformationId: t.id,
    transformationVersion: t.version,
    verifier: verifierKeyOf(t.verifier.predicates),
    recoveryUnit: t.recovery.unit,
  };
}

export class TransformationRegistryError extends Error {
  constructor(readonly code: "duplicate" | "class_not_automatable" | "shape_invalid" | "verifier_unregistered", detail: string) {
    super(detail);
    this.name = "TransformationRegistryError";
  }
}

export interface TransformationRegistry {
  /** Register one transformation. Refuses duplicates, non-automatable classes, malformed shapes, and unregistered verifiers. */
  register(t: TransformationV1): void;
  /** The exact id@version, or null. A missing entry is null, never a guess at another version. */
  get(id: string, version: string): TransformationV1 | null;
  /** Every registered transformation, registration order. */
  all(): TransformationV1[];
}

/**
 * Create the registry. It closes over the PREDICATE registry so the
 * verifier-exists check is structural: you cannot construct a transformation
 * registry that skips it.
 */
export function createTransformationRegistry(predicates: PredicateRegistry): TransformationRegistry {
  const entries = new Map<string, TransformationV1>();
  const key = (id: string, version: string) => `${id}@${version}`;

  return {
    register(t) {
      if (t.schema !== "governor.transformation/v1") {
        throw new TransformationRegistryError("shape_invalid", `unknown transformation schema '${String(t.schema)}'`);
      }
      if (!t.id.trim() || !t.version.trim()) throw new TransformationRegistryError("shape_invalid", "a transformation needs an exact id and version");
      // Identifier charset: ids and versions feed the canonical tuple key
      // (`id@version` joined by "," and "|"), so the separator characters are
      // excluded here — two different verifier sets must never canonicalize
      // to one identity (review of #357).
      const IDENT = /^[A-Za-z0-9._-]+$/;
      const identOk = (s: string) => IDENT.test(s);
      if (!identOk(t.id) || !identOk(t.version)) {
        throw new TransformationRegistryError("shape_invalid", `transformation id/version must match ${String(IDENT)} — separators would collide tuple identities`);
      }
      for (const p of t.verifier.predicates) {
        if (!identOk(p.id) || !identOk(p.version)) {
          throw new TransformationRegistryError("shape_invalid", `verifier predicate ids/versions must match ${String(IDENT)} — separators would collide tuple identities`);
        }
      }
      if (!t.title.trim()) throw new TransformationRegistryError("shape_invalid", `transformation ${t.id}@${t.version} needs a title`);
      if (entries.has(key(t.id, t.version))) {
        throw new TransformationRegistryError("duplicate", `transformation ${t.id}@${t.version} is already registered; versions are immutable — register a new version`);
      }
      if (t.appliesTo.length === 0) {
        throw new TransformationRegistryError("shape_invalid", `transformation ${t.id}@${t.version} applies to no classes — nothing to authorize is not authorization`);
      }
      for (const c of t.appliesTo) {
        if (!AUTOMATABLE_CLASSES.includes(c)) {
          throw new TransformationRegistryError(
            "class_not_automatable",
            `transformation ${t.id}@${t.version} claims class '${c}' — automatic admission is never available for content or authority work (D02), and this registry holds only what could someday be automatic`
          );
        }
      }
      if (t.verifier.predicates.length === 0) {
        throw new TransformationRegistryError("shape_invalid", `transformation ${t.id}@${t.version} names no verifier predicates — unverifiable work is never automatable`);
      }
      for (const p of t.verifier.predicates) {
        if (!p.id.trim() || !p.version.trim()) {
          throw new TransformationRegistryError("shape_invalid", `transformation ${t.id}@${t.version}: every verifier predicate needs an exact id and version`);
        }
        if (predicates.get(p.id, p.version) === null) {
          throw new TransformationRegistryError(
            "verifier_unregistered",
            `transformation ${t.id}@${t.version} names verifier ${p.id}@${p.version}, which is not a registered predicate — a check that cannot run has not passed, and a verifier that cannot run is not a verifier`
          );
        }
      }
      // Frozen deep enough that no caller-held reference can widen a
      // registered entry's classes or swap its verifiers after review.
      entries.set(
        key(t.id, t.version),
        Object.freeze({
          schema: t.schema,
          id: t.id,
          version: t.version,
          title: t.title,
          appliesTo: Object.freeze([...t.appliesTo]) as ChangeClass[],
          verifier: Object.freeze({ predicates: Object.freeze(t.verifier.predicates.map((p) => Object.freeze({ id: p.id, version: p.version }))) as Array<{ id: string; version: string }> }),
          recovery: Object.freeze({ unit: t.recovery.unit }),
        })
      );
    },
    get(id, version) {
      return entries.get(key(id, version)) ?? null;
    },
    all() {
      return [...entries.values()];
    },
  };
}
