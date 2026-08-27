// PROMOTION UI WIRING — the human's promote/demote verbs (WP10a).
//
// The pane's Automatic-admission section calls THESE two verbs and nothing
// else does. Both are authority-class: promotion is the act that lets a
// mandate's mayAdmit intent eventually mean something (WP10's admission arm
// consumes the verdict), and demotion is the brake. Gesture-gated with the
// same perimeter as activate/admit — refs minted only inside
// runGuardedDisposition; an empty ref refuses in the kernel store too.
//
// Reads are honest about absence: a transformation with no evidence shows
// the named missing classes, never an empty row.

import { tupleOf, type TransformationRegistry, type TransformationV1 } from "../kernel/transformations/transformation.js";
import { PromotionRefusedError, type PromotionStore, type PromotionVerdict } from "../kernel/transformations/promotion.js";

export type PromotionActOutcome = { ok: true } | { ok: false; code: string; detail: string };

export interface PromotionRow {
  transformation: TransformationV1;
  verdict: PromotionVerdict;
}

export interface PromotionUiDeps {
  /** Every registered transformation with its tuple's promotion verdict. */
  rows(): Promise<PromotionRow[]>;
  /** THE promotion act. Refuses with the named missing evidence when the gate is unmet. */
  promote(id: string, version: string, gestureRef: string): Promise<PromotionActOutcome>;
  demote(id: string, version: string, reason: string, gestureRef: string): Promise<PromotionActOutcome>;
}

export interface BuildPromotionUiDeps {
  registry: TransformationRegistry;
  store: PromotionStore;
  /** The configured human identity the promotion records as principal. */
  principal: () => string;
  now?: () => number;
}

export function buildPromotionUi(deps: BuildPromotionUiDeps): PromotionUiDeps {
  const now = deps.now ?? (() => Date.now());

  const fail = (e: unknown): PromotionActOutcome => {
    const code = e instanceof PromotionRefusedError ? e.code : ((e as { code?: string }).code ?? "promotion_error");
    return { ok: false, code, detail: e instanceof Error ? e.message : String(e) };
  };

  const resolve = (id: string, version: string): TransformationV1 => {
    const t = deps.registry.get(id, version);
    if (t === null) {
      const e = new Error(`no registered transformation ${id}@${version} — promotion is defined only over the registry`);
      (e as Error & { code: string }).code = "transformation_unknown";
      throw e;
    }
    return t;
  };

  return {
    async rows() {
      const out: PromotionRow[] = [];
      for (const t of deps.registry.all()) {
        out.push({ transformation: t, verdict: await deps.store.verdictOf(tupleOf(t)) });
      }
      return out;
    },
    async promote(id, version, gestureRef) {
      try {
        await deps.store.promote(tupleOf(resolve(id, version)), gestureRef, deps.principal(), now());
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },
    async demote(id, version, reason, gestureRef) {
      try {
        await deps.store.demote(tupleOf(resolve(id, version)), gestureRef, deps.principal(), reason, now());
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },
  };
}
